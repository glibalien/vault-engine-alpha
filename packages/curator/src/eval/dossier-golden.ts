import { vaultSettingsFrom } from '@vault/settings-registry';
import { localDate } from '../date-line.js';
import { lastContactOf, renderDossierEvidence } from '../dossier/evidence.js';
import { renderDossierPage } from '../dossier/page.js';
import { dossierSectionsFor } from '../dossier/sections.js';
import { applyDossierRuleCheck } from '../dossier/rules.js';
import { StructuredCallFailure, type LlmClient } from '../llm/types.js';
import { withoutRulesSection } from '../page-rules.js';
import { addUsage, ZERO_USAGE, estimateCostByModel, pricingFor, type PricingLookup } from '../pricing.js';
import { buildDossierRequest, parseDossierLines } from '../prompts/dossier.js';
import type { TokenUsage } from '../types.js';
import { memoryDay } from '../wiki-memories.js';
import { bindWikiStageClient, type ResolvedWikiStagePolicy } from '../wiki-output-policy.js';
import { DOSSIER_GOLDEN_NOW, DOSSIER_GOLDEN_OWNER, goldenDossierInputs, type DossierGoldenCase } from './dossier-golden-cases.js';
import { runChecks, type CheckResult } from './wiki-golden.js';

export interface DossierGoldenResult {
  readonly id: string;
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  /** The page as code wrote it, rules section included. */
  readonly output: string;
  readonly kept: number;
  readonly dropped: number;
  readonly ruleDropped: number;
  readonly undated: number;
  readonly calls: number;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly error?: string;
}

/** One case through what a build does after its reads: the page call on the home model, the rule
 *  check when the subject has rules, and the page code. No capture and no write. */
export async function runDossierCase(llm: LlmClient, policy: ResolvedWikiStagePolicy, c: DossierGoldenCase,
  pricing: PricingLookup = pricingFor): Promise<DossierGoldenResult> {
  const timeZone = 'UTC';
  const bound = bindWikiStageClient(llm, policy);
  let usage: TokenUsage = ZERO_USAGE;
  let calls = 0;
  const cost = (): number | null => usage === ZERO_USAGE ? null : estimateCostByModel([[policy.model, usage]], pricing);
  try {
    const inputs = goldenDossierInputs(c);
    const rendered = renderDossierEvidence({ ...inputs, owner: DOSSIER_GOLDEN_OWNER, meetingReads: 5, timeZone });
    // The real chooser over the default vault map, so a case runs the built-in list a build would.
    const shape = dossierSectionsFor(undefined, vaultSettingsFrom(undefined), inputs.subject.types);
    const request = buildDossierRequest({ shape, owner: DOSSIER_GOLDEN_OWNER, evidence: rendered.text, model: policy.model,
      maxTokens: policy.maxTokens, generatedAt: DOSSIER_GOLDEN_NOW, timeZone });
    calls += 1;
    const result = await bound.structuredCall(request);
    usage = addUsage(usage, result.usage);
    const lines = parseDossierLines(result.output);
    if (lines === null) throw new Error('the model returned no lines');
    const memoryById = new Map([...rendered.memories.owner, ...rendered.memories.rules, ...rendered.memories.facts, ...rendered.memories.past].map(m => [m.id, m]));
    const lineInput = { kind: c.kind, sections: shape.sections.map(section => section.name), memories: memoryById, refs: rendered.refs, sourceTitles: inputs.sourceTitles,
      day: memoryDay(timeZone), today: localDate(DOSSIER_GOLDEN_NOW, timeZone) };
    const rules = rendered.memories.rules;
    const today = lineInput.today;
    const lastContact = lastContactOf(inputs.evidence, today, inputs.subject);
    const checked = await applyDossierRuleCheck(bound, { model: policy.model, maxTokens: policy.maxTokens, lines, lineInput, rules, lastContact,
      call: check => { calls += 1; return check(); } });
    if (checked.usage) usage = addUsage(usage, checked.usage);
    const page = renderDossierPage({ ...lineInput, lines: checked.lines, rules, lastContact, contactWithheld: checked.contactWithheld,
      header: '_Golden case._' });
    const checks: CheckResult[] = [
      { why: 'every line cites something it was shown', passed: page.dropped === 0 },
      ...runChecks(withoutRulesSection(page.content), c.checks),
    ];
    return { id: c.id, passed: checks.every(check => check.passed), checks, output: page.content, kept: page.kept, dropped: page.dropped,
      ruleDropped: checked.ruleDropped, undated: page.undated, calls, usage, costUsd: cost() };
  } catch (error) {
    if (error instanceof StructuredCallFailure && error.usage !== undefined) usage = addUsage(usage, error.usage);
    return { id: c.id, passed: false, checks: [], output: '', kept: 0, dropped: 0, ruleDropped: 0, undated: 0, calls, usage, costUsd: cost(),
      error: error instanceof Error ? error.message : String(error) };
  }
}
