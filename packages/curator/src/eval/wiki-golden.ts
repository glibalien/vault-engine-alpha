import type { Engine } from '../engine.js';
import { PageSynthesisError, synthesizeAcceptedPages, synthesizeHomeOverview } from '../page-synthesis.js';
import { StructuredCallFailure, type LlmClient } from '../llm/types.js';
import { addUsage, ZERO_USAGE, estimateCostByModel, pricingFor, type PricingLookup } from '../pricing.js';
import type { EngineNode, ExistingWiki, TokenUsage, WikiSections } from '../types.js';
import { bindWikiStageClient, type ResolvedWikiOutputPolicy } from '../wiki-output-policy.js';
import { GOLDEN_NOW, type GoldenCase, type GoldenCheck, type PageCase } from './wiki-golden-cases.js';
import { judgeRule, type RuleJudge, type RuleRuling } from './wiki-judge.js';

export interface CheckResult {
  readonly why: string;
  readonly passed: boolean;
  /** Set when the pattern flagged the answer and a judge ruled on it (#604): the judge's ruling,
   *  or why there is none (the pattern's flag then stands). */
  readonly judge?: { readonly ruling: RuleRuling | null; readonly error?: string };
}

export interface GoldenResult {
  readonly id: string;
  readonly stage: GoldenCase['stage'];
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly output: string;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly error?: string;
}

/** The text under one `##` heading (case-insensitive), or null when the heading is absent. */
export function sectionText(markdown: string, heading: string): string | null {
  const wanted = heading.trim().toLowerCase();
  const parts = markdown.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const title = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase();
    if (title === wanted) return newline === -1 ? '' : part.slice(newline + 1);
  }
  return null;
}

/** A missing section fails an `includes` check and satisfies an `excludes` check. */
export function runChecks(output: string, checks: readonly GoldenCheck[]): CheckResult[] {
  return checks.map(check => {
    const text = check.section === undefined ? output : sectionText(output, check.section);
    const matched = text !== null && check.pattern.test(text);
    return { why: check.why, passed: check.kind === 'includes' ? matched : !matched };
  });
}

/** Home sections as one Markdown document, so section checks address them by heading. The Log
 *  entry is published too, so unscoped checks cover it. */
export function renderHomeSections(sections: WikiSections): string {
  return [['At a glance', sections.at_a_glance], ['Now', sections.now], ['Focus', sections.focus],
    ['Open threads', sections.open_threads], ['Log', sections.log_entry]]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([heading, content]) => `## ${heading}\n${content}`).join('\n\n');
}

export interface GoldenPrompts {
  readonly page?: string;
  readonly home: string;
}

const PAGE_ID = 'golden-page';
const scope = (c: PageCase) => ({ v: 1 as const, subject: 'Northwind Pilot', facet: c.page.title });

function pageWiki(c: PageCase): ExistingWiki {
  return {
    home_id: 'golden-home', home: { id: 'golden-home', version: 1 }, topology_hash: 'golden', catalog_valid: true,
    subpages: c.page.currentBody === undefined ? [] : [{
      id: PAGE_ID, title: c.page.title, file_path: `${c.page.title}.md`, version: 1, content_hash: 'golden',
      wiki_state: 'active', wiki_kind: c.page.kind, wiki_origin: 'automatic', wiki_pinned: false, wiki_scope: scope(c),
    }],
  };
}

/** Engine reads a refresh needs: the current page, as a wiki node with its managed Summary. */
function pageEngine(c: PageCase): Engine {
  return {
    getNode: async (id: string) => {
      if (id !== PAGE_ID || c.page.currentBody === undefined) throw new Error(`golden case has no node ${id}`);
      return { id, title: c.page.title, types: ['wiki'], fields: {},
        body: `<!-- ve:managed:Summary -->\n${c.page.currentBody}\n<!-- /ve:managed:Summary -->` };
    },
  } as unknown as Engine;
}

async function synthesize(llm: LlmClient, policy: ResolvedWikiOutputPolicy, prompts: GoldenPrompts, c: GoldenCase):
  Promise<{ output: string; usage: TokenUsage; model: string }> {
  if (c.stage === 'home') {
    const result = await synthesizeHomeOverview(bindWikiStageClient(llm, policy.home), {
      model: policy.home.model, maxTokens: policy.home.maxTokens, system: prompts.home,
      evidence: c.evidence, pageIndex: [], generatedAt: GOLDEN_NOW,
    });
    return { output: renderHomeSections(result.validatedSections), usage: result.usage, model: policy.home.model };
  }
  const nodes: EngineNode[] = c.sources.map((source, index) =>
    ({ id: `source-${index + 1}`, title: source.title, types: [...source.types], fields: { ...source.fields }, body: source.body,
      ...(c.rewrite ? { metadata: { content_hash: `hash-${index + 1}` } } : {}) }));
  // A rewrite case: the page was last built from the sources not marked new, as they are now (#352).
  const pageNoteStates = c.rewrite && c.page.currentBody !== undefined
    ? new Map([[PAGE_ID, { builtAt: c.rewrite.builtAt,
      notes: Object.fromEntries(c.sources.flatMap((source, index) => source.new ? [] : [[`source-${index + 1}`, `hash-${index + 1}`]])) }]])
    : undefined;
  const action = c.page.currentBody === undefined
    ? { op: 'create' as const, plan_key: 'golden', title: c.page.title, kind: c.page.kind, scope: scope(c), synthesis_brief: c.page.brief }
    : { op: 'refresh' as const, node_id: PAGE_ID, scope: scope(c), synthesis_brief: c.page.brief };
  const existingWiki = pageWiki(c);
  const result = await synthesizeAcceptedPages(bindWikiStageClient(llm, policy.page), pageEngine(c), {
    model: policy.page.model, maxTokens: policy.page.maxTokens, ...(prompts.page === undefined ? {} : { system: prompts.page }),
    plan: { reviewed_page_ids: existingWiki.subpages.map(page => page.id), actions: [action] },
    existingWiki, evidenceNodes: nodes, bodyCharCap: null, generatedAt: GOLDEN_NOW,
    ...(pageNoteStates ? { pageNoteStates } : {}),
  });
  return { output: result.pages[0]?.body ?? '', usage: result.usage, model: policy.page.model };
}

/** The flagged words with a little of the sentence around them, for the judge. */
export function flaggedExcerpt(output: string, check: GoldenCheck): string {
  const text = check.section === undefined ? output : sectionText(output, check.section) ?? '';
  const match = new RegExp(check.pattern.source, check.pattern.flags).exec(text);
  if (match === null) return '';
  return text.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120).replace(/\s+/g, ' ').trim();
}

/** Ask the judge about each `excludes` check the pattern flagged that has a rule (#604). A ruling
 *  that the page keeps the rule clears the flag; no ruling leaves it standing. */
export async function judgeFlaggedChecks(judge: RuleJudge, c: GoldenCase, output: string, results: readonly CheckResult[]):
  Promise<{ checks: CheckResult[]; usage: TokenUsage }> {
  let usage = ZERO_USAGE;
  const checks: CheckResult[] = [];
  for (const [index, result] of results.entries()) {
    const check = c.checks[index];
    if (result.passed || check === undefined || check.kind !== 'excludes' || check.judge === undefined) {
      checks.push(result);
      continue;
    }
    const evidence = c.stage === 'home' ? c.evidence
      : c.sources.map(source => `### ${source.title}\n${source.body}`).join('\n\n');
    const judged = await judgeRule(judge, { rule: check.judge, mistake: c.failure, evidence, page: output,
      flagged: flaggedExcerpt(output, check) });
    if (judged.usage) usage = addUsage(usage, judged.usage);
    checks.push({ why: result.why, passed: judged.ruling !== null && !judged.ruling.breaks,
      judge: { ruling: judged.ruling, ...(judged.error === undefined ? {} : { error: judged.error }) } });
  }
  return { checks, usage };
}

const billed = (usage: TokenUsage): boolean =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;

/** One paid synthesis call, checked by patterns, and with a judge, a ruling on each answer a
 *  pattern flags (#604). Costs are priced with `pricing` (the CLI passes the catalog's), and the
 *  judge's model is priced only when it billed something. Failures are reported, never thrown. */
export async function runGoldenCase(llm: LlmClient, policy: ResolvedWikiOutputPolicy, prompts: GoldenPrompts,
  c: GoldenCase, judge?: RuleJudge, pricing: PricingLookup = pricingFor): Promise<GoldenResult> {
  try {
    const { output, usage, model } = await synthesize(llm, policy, prompts, c);
    const patternChecks = runChecks(output, c.checks);
    const judged = judge === undefined ? { checks: patternChecks, usage: ZERO_USAGE }
      : await judgeFlaggedChecks(judge, c, output, patternChecks);
    const checks = judged.checks;
    return { id: c.id, stage: c.stage, passed: checks.every(check => check.passed), checks, output,
      usage: addUsage(usage, judged.usage),
      costUsd: estimateCostByModel(judge !== undefined && billed(judged.usage)
        ? [[model, usage], [judge.model, judged.usage]] : [[model, usage]], pricing) };
  } catch (error) {
    // Rejected output and provider failures can still be billed; keep their usage in the totals.
    const usage = error instanceof PageSynthesisError ? error.usage
      : error instanceof StructuredCallFailure ? error.usage ?? ZERO_USAGE : ZERO_USAGE;
    const model = c.stage === 'home' ? policy.home.model : policy.page.model;
    return { id: c.id, stage: c.stage, passed: false, checks: [], output: '', usage,
      costUsd: usage === ZERO_USAGE ? null : estimateCostByModel([[model, usage]], pricing),
      error: error instanceof Error ? error.message : String(error) };
  }
}

export function totalUsage(results: readonly GoldenResult[]): TokenUsage {
  return results.reduce((sum, result) => addUsage(sum, result.usage), ZERO_USAGE);
}
