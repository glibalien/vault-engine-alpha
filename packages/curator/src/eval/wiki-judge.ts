import { resolvePricing } from '@vault/pricing';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import type { Config } from '../config.js';
import { StructuredCallFailure, type JsonSchema, type LlmClient } from '../llm/types.js';
import type { TokenUsage } from '../types.js';
import { resolveCliModelRef } from './model-ref.js';

/**
 * The rule judge for golden wiki cases (#604). A word pattern flags an answer that uses a forbidden
 * word ("confirmed", "quiet", "delivered"); the judge then reads the whole page and decides whether
 * it says the forbidden thing, so a sentence that denies or qualifies the word no longer fails the
 * case. It runs only on what a pattern flagged, never on a clean answer.
 */

export interface RuleRuling {
  /** True when the page states, as the current state, what the rule forbids. */
  readonly breaks: boolean;
  /** The sentence from the page that decides it, verbatim. */
  readonly quote: string;
  readonly reason: string;
}

export interface RuleJudge {
  readonly llm: LlmClient;
  readonly model: string;
}

export const RULE_JUDGE_SYSTEM_PROMPT = `You check whether a wiki page written by an AI breaks one rule.

The input gives the RULE, the MISTAKE it guards against, the EVIDENCE the page was written from, the PAGE, and the FLAGGED text: words a simple word check matched, which may or may not break the rule.

A page breaks the rule only when one of its sentences states, as the current state, what the rule forbids. A sentence that denies it, asks about it, makes it a condition or a goal, or reports what an older source said does not break it. Judge the whole page, not only the flagged text.

Return breaks (true or false), quote (the sentence from the page that decides it, copied exactly) and reason (one short sentence).`;

export const RULE_JUDGE_TOOL: { name: string; description: string; schema: JsonSchema } = {
  name: 'judge_rule',
  description: 'Say whether the page breaks the rule, with the deciding sentence.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['breaks', 'quote', 'reason'],
    properties: {
      breaks: { type: 'boolean' },
      quote: { type: 'string' },
      reason: { type: 'string' },
    },
  },
};

export function parseRuleRuling(output: unknown): RuleRuling | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (typeof o.breaks !== 'boolean') return null;
  return {
    breaks: o.breaks,
    quote: typeof o.quote === 'string' ? o.quote.trim() : '',
    reason: typeof o.reason === 'string' ? o.reason.trim() : '',
  };
}

export function buildRuleJudgeUser(input: {
  rule: string; mistake: string; evidence: string; page: string; flagged: string;
}): string {
  return `RULE: ${input.rule}\nMISTAKE: ${input.mistake}\nFLAGGED: ${input.flagged}\n\nEVIDENCE:\n${input.evidence}\n\nPAGE:\n${input.page}`;
}

/** The model `--judge-model` names, with its provider route and its catalog price registered, so
 *  the daily budget can price the judge's calls; settings register only the models they name. */
export function resolveJudgeModel(catalog: ModelCatalogEntry[], ref: string,
  config: Pick<Config, 'modelProviders' | 'modelPricing'>): string {
  return resolveCliModelRef(catalog, ref, {
    flagName: '--judge-model',
    registerProvider: (model, provider) => {
      config.modelProviders[model] = provider;
      const entry = catalog.find(candidate => candidate.enabled && candidate.model === model);
      config.modelPricing = { ...config.modelPricing, [model]: resolvePricing(model, entry?.pricing) };
    },
  }).model;
}

/** One judge call. A failed or unusable answer is null, so the pattern's flag stands; a failed
 *  call's billed usage is still returned. */
export async function judgeRule(
  judge: RuleJudge,
  input: { rule: string; mistake: string; evidence: string; page: string; flagged: string },
): Promise<{ ruling: RuleRuling | null; usage: TokenUsage | null; error?: string }> {
  try {
    const { output, usage } = await judge.llm.structuredCall({
      model: judge.model,
      // Room for a reasoning model to think before its answer; only tokens used are billed.
      maxTokens: 4000,
      system: RULE_JUDGE_SYSTEM_PROMPT,
      user: buildRuleJudgeUser(input),
      toolName: RULE_JUDGE_TOOL.name,
      toolDescription: RULE_JUDGE_TOOL.description,
      schema: RULE_JUDGE_TOOL.schema,
    });
    return { ruling: parseRuleRuling(output), usage };
  } catch (error) {
    // A truncated or rejected answer can still be billed; keep its usage in the totals.
    const usage = error instanceof StructuredCallFailure ? error.usage ?? null : null;
    return { ruling: null, usage, error: error instanceof Error ? error.message : String(error) };
  }
}
