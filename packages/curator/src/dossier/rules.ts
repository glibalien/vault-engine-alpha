import { z } from 'zod';
import type { JsonSchema, LlmClient, StructuredCallRequest } from '../llm/types.js';
import type { RuleBreak } from '../page-rules.js';
import type { DossierLineOutput } from '../prompts/dossier.js';
import type { Memory, TokenUsage } from '../types.js';
import { lastContactLine, renderDossierLines, type DossierLineInput } from './page.js';

/**
 * The rule check on a dossier (#721; owner, 2026-11-21: "drop the breaking lines"). One call on the
 * page model after the page call, when the subject has rules on what may be said: it names the
 * lines that break one, code leaves them out and the Log counts them, and the page is still
 * written. A project page's check (`checkPageRules`) names rules and quotes words, then retries the
 * page; a dossier is a list of lines, so the check names lines and nothing is drafted again.
 * Keep the meaning of a break in step with `RULE_CHECK_SYSTEM_PROMPT` (`src/page-rules.ts`).
 */

export const DOSSIER_RULE_CHECK_SYSTEM_PROMPT = `You check the lines of one dossier page against rules on what it may say. The rules come from the owner's notes: naming, messaging, dates not to give, material to keep internal, claims not to make.

A line breaks a rule when it says what the rule forbids: it uses a name or wording the rule says not to use, gives a date or detail the rule says not to give, or makes a claim the rule says not to make. Rules about what to tell clients or other outsiders are broken only by text meant for them, such as talking points, messaging or anything written to be shared; an internal record of a fact doesn't break them. A line that only states a rule, or doesn't touch it, doesn't break it.

Return only the lines that break a rule, by number, each with the number of a rule it breaks and the line's words that break it, quoted exactly. Return an empty list when no line breaks one.`;

const SCHEMA = z.object({
  broken: z.array(z.object({ line: z.number().int(), rule: z.number().int(), words: z.string().optional() })),
});

const TOOL = {
  name: 'emit_dossier_rule_check',
  description: 'Return the dossier lines that break a rule, by number, with the rule and the words that break it.',
  schema: z.toJSONSchema(SCHEMA) satisfies JsonSchema,
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The check's request: the rules and the lines as the page writes them, each numbered from 1. The
 *  lines' memory markers are HTML comments no reader sees, so they are left out. */
export function buildDossierRuleCheckRequest(input: {
  readonly model: string; readonly maxTokens: number; readonly lines: readonly { readonly section: string; readonly text: string }[];
  readonly rules: readonly Memory[];
}): StructuredCallRequest {
  return {
    model: input.model,
    maxTokens: input.maxTokens,
    system: DOSSIER_RULE_CHECK_SYSTEM_PROMPT,
    user: JSON.stringify({
      rules: input.rules.map((rule, index) => `${index + 1}. ${oneLine(rule.content)}`),
      lines: input.lines.map((line, index) => `${index + 1}. [${oneLine(line.section)}] ${oneLine(line.text.replace(/<!--[\s\S]*?-->/g, '').replace(/^- /, ''))}`),
    }),
    toolName: TOOL.name,
    toolDescription: TOOL.description,
    schema: TOOL.schema,
  };
}

export interface DossierRuleCheck {
  /** The lines that break a rule, by their index in the lines checked, with what each breaks. */
  readonly broken: ReadonlyMap<number, readonly RuleBreak[]>;
  /** False when the check's output didn't parse: no ruling, so every line stands (logged). */
  readonly ruled: boolean;
  readonly usage: TokenUsage;
}

/**
 * One call: which lines break which of the subject's rules. Output that doesn't parse is no ruling,
 * and the page stands, as for a project page. A failed call throws like the page call, so the build
 * writes nothing rather than an unchecked page.
 */
export async function checkDossierRules(llm: LlmClient, request: StructuredCallRequest,
  input: { readonly lines: readonly unknown[]; readonly rules: readonly Memory[] }): Promise<DossierRuleCheck> {
  const { output, usage } = await llm.structuredCall(request);
  const parsed = SCHEMA.safeParse(output);
  if (!parsed.success) {
    console.warn('[curator] dossier rule check gave no ruling; every line stands');
    return { broken: new Map(), ruled: false, usage };
  }
  const broken = new Map<number, RuleBreak[]>();
  for (const entry of parsed.data.broken) {
    const rule = input.rules[entry.rule - 1];
    const index = entry.line - 1;
    if (!rule || index < 0 || index >= input.lines.length) continue;
    const breaks = broken.get(index) ?? [];
    if (!breaks.some(known => known.rule.id === rule.id)) breaks.push({ rule, words: entry.words?.trim() ?? '' });
    broken.set(index, breaks);
  }
  return { broken, ruled: true, usage };
}

export interface RuleCheckedLines {
  /** The model's lines the page keeps. */
  readonly lines: readonly DossierLineOutput[];
  /** Model lines left out for breaking a rule. */
  readonly ruleDropped: number;
  /** The "Last contact" line broke a rule: the page leaves the section out. */
  readonly contactWithheld: boolean;
  /** Whether the check gave a ruling; null when no check was made (no rules, nothing to check). */
  readonly ruled: boolean | null;
  readonly usage: TokenUsage | null;
  /** What each broken line was and the rules it breaks, for the log. */
  readonly breaks: ReadonlyArray<{ readonly what: string; readonly breaks: readonly RuleBreak[] }>;
}

/**
 * The rule check as a build applies it, shared by `build-dossier` and `eval:dossier` so the two
 * can't drift. It reads each line as the page writes it, day and sources included (Codex, #729), and
 * code's own "Last contact" line last (it names a meeting and its day); the model lines behind
 * breaking lines are left out and a breaking contact line is withheld. `call` wraps the check
 * call (a usage context).
 */
export async function applyDossierRuleCheck(llm: LlmClient, input: {
  readonly model: string; readonly maxTokens: number; readonly lines: readonly DossierLineOutput[];
  readonly lineInput: DossierLineInput; readonly rules: readonly Memory[];
  readonly lastContact: { readonly title: string; readonly date: string } | null;
  readonly call?: (check: () => Promise<DossierRuleCheck>) => Promise<DossierRuleCheck>;
}): Promise<RuleCheckedLines> {
  const none: RuleCheckedLines = { lines: input.lines, ruleDropped: 0, contactWithheld: false, ruled: null, usage: null, breaks: [] };
  if (input.rules.length === 0) return none;
  const written = renderDossierLines({ ...input.lineInput, lines: input.lines });
  const contact = input.lastContact ? lastContactLine(input.lastContact) : null;
  const checked = [...written.map(entry => ({ section: entry.section, text: entry.line })),
    ...(contact !== null ? [{ section: 'Last contact', text: contact }] : [])];
  if (checked.length === 0) return none;
  const request = buildDossierRuleCheckRequest({ model: input.model, maxTokens: input.maxTokens, lines: checked, rules: input.rules });
  const check = () => checkDossierRules(llm, request, { lines: checked, rules: input.rules });
  const ruling = input.call ? await input.call(check) : await check();
  const breaking = new Set([...ruling.broken.keys()].flatMap(at => at < written.length ? [written[at]!.index] : []));
  return {
    lines: input.lines.filter((_, index) => !breaking.has(index)),
    ruleDropped: breaking.size,
    contactWithheld: contact !== null && ruling.broken.has(written.length),
    ruled: ruling.ruled,
    usage: ruling.usage,
    breaks: [...ruling.broken].map(([at, breaks]) => ({ what: at < written.length ? `line ${written[at]!.index + 1}` : 'the last contact', breaks })),
  };
}
