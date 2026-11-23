import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MODEL_PROVIDERS } from '@vault/settings-registry';
import type { Config } from './config.js';
import { supportsReasoningBudget, type LlmClient, type WikiCallContext } from './llm/types.js';

export type WikiPolicyStage = 'planning' | 'page' | 'home';
export type WikiReasoningChoice = 'inherit' | 'provider-default' | 'none' | 'low' | 'medium' | 'high';
const effortSchema = z.enum(['inherit', 'provider-default', 'none', 'low', 'medium', 'high']);
const configurationSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  reasoningEffort: z.string().min(1).max(128).nullable(),
  // Optional so records frozen before #429 still parse; absent whenever no budget is set.
  reasoningBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(c => c.provider !== 'anthropic' || c.reasoningEffort === null)
  .refine(c => c.reasoningBudget === undefined || (supportsReasoningBudget(c.provider) && c.reasoningEffort === null));
const modelSchema = z.string().min(1).max(512);
const stageObject = z.object({ model: modelSchema, maxTokens: z.number().int().positive(), configuration: configurationSchema }).strict();
/** A budget always leaves the answer room inside the stage's cap. */
const budgetFits = (s: { maxTokens: number; configuration: { reasoningBudget?: number } }) =>
  s.configuration.reasoningBudget === undefined || s.configuration.reasoningBudget < s.maxTokens;
const stageSchema = stageObject.refine(budgetFits);
// Checkpoints frozen before per-stage models omit the stage model; it was the top-level model.
const storedStageSchema = stageObject.extend({ model: modelSchema.optional() }).refine(budgetFits);
export const resolvedWikiOutputPolicySchema = z.object({
  version: z.literal(1), model: modelSchema,
  planning: storedStageSchema, page: storedStageSchema, home: storedStageSchema,
}).strict().transform(policy => ({
  ...policy,
  planning: { ...policy.planning, model: policy.planning.model ?? policy.model },
  page: { ...policy.page, model: policy.page.model ?? policy.model },
  home: { ...policy.home, model: policy.home.model ?? policy.model },
}));
export type ResolvedWikiStagePolicy = Readonly<{
  model: string; maxTokens: number; configuration: Readonly<z.infer<typeof configurationSchema>>;
}>;
export type ResolvedWikiOutputPolicy = Readonly<{
  version: 1; model: string; planning: ResolvedWikiStagePolicy;
  page: ResolvedWikiStagePolicy; home: ResolvedWikiStagePolicy;
}>;
const prefix = { planning: 'wikiPlanning', page: 'wikiPage', home: 'wikiHome' } as const;

/** The stage's own model when configured, else the shared synthesis model. */
export function resolveWikiModel(config: Config, stage: WikiPolicyStage): string {
  return config[`${prefix[stage]}Model`] ?? config.model;
}

export function resolveWikiMaxTokens(config: Config, stage: WikiPolicyStage): number {
  const override = config[`${prefix[stage]}MaxTokens`];
  if (!Number.isInteger(override) || override < 0) throw new Error('WIKI_OUTPUT_POLICY_INVALID');
  const cap = override === 0 ? config.homeMaxTokens : override;
  if (!Number.isInteger(cap) || cap <= 0) throw new Error('WIKI_OUTPUT_POLICY_INVALID');
  return cap;
}
/** The stage's reasoning budget in tokens; 0 (or unset) means none. */
export function resolveWikiReasoningBudget(config: Config, stage: WikiPolicyStage): number {
  const budget = config[`${prefix[stage]}ReasoningBudget`] ?? 0;
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('WIKI_OUTPUT_POLICY_INVALID');
  return budget;
}
/** `reasoningBudget` > 0 replaces the effort: OpenRouter takes one or the other, so the request
 *  carries only `reasoning.max_tokens`. A budget is refused, before any call, on a provider that
 *  can't honor it, beside an explicit effort, or when it leaves the answer no room. */
export function resolveWikiStagePolicy(llm: LlmClient, model: string, maxTokens: number,
  reasoning: WikiReasoningChoice, reasoningBudget = 0): ResolvedWikiStagePolicy {
  if (!llm.configurationFor || !llm.withConfiguration) throw new Error('WIKI_OUTPUT_CONFIGURATION_UNSUPPORTED');
  if (!effortSchema.safeParse(reasoning).success) throw new Error('WIKI_OUTPUT_POLICY_INVALID');
  if (!Number.isSafeInteger(reasoningBudget) || reasoningBudget < 0) throw new Error('WIKI_OUTPUT_POLICY_INVALID');
  const configuration = { ...llm.configurationFor(model) };
  delete configuration.reasoningBudget;
  if (configuration.provider === 'anthropic' && reasoning !== 'inherit' && reasoning !== 'provider-default')
    throw new Error('WIKI_OUTPUT_REASONING_UNSUPPORTED');
  if (reasoning !== 'inherit') configuration.reasoningEffort = reasoning === 'provider-default' ? null : reasoning;
  if (reasoningBudget > 0) {
    if (!supportsReasoningBudget(configuration.provider))
      throw new Error(`WIKI_OUTPUT_REASONING_UNSUPPORTED: ${configuration.provider} models can't take a reasoning budget; only OpenRouter models can`);
    if (reasoning !== 'inherit' && reasoning !== 'provider-default')
      throw new Error(`WIKI_OUTPUT_POLICY_INVALID: a reasoning budget replaces the reasoning effort; set the stage's effort to inherit or provider-default, not ${reasoning}`);
    if (reasoningBudget >= maxTokens)
      throw new Error(`WIKI_OUTPUT_POLICY_INVALID: a reasoning budget of ${reasoningBudget} must be below the stage's output cap of ${maxTokens}`);
    configuration.reasoningEffort = null;
    configuration.reasoningBudget = reasoningBudget;
  }
  const parsed = stageSchema.safeParse({ model, maxTokens, configuration });
  if (!parsed.success) throw new Error('WIKI_OUTPUT_POLICY_INVALID');
  return Object.freeze({ model, maxTokens, configuration: Object.freeze(parsed.data.configuration) });
}
/** One stage as configured: its model (or `model` when the caller passes none), output cap,
 *  reasoning effort and reasoning budget. */
export function resolveConfiguredWikiStage(config: Config, llm: LlmClient, stage: WikiPolicyStage,
  model: string = resolveWikiModel(config, stage)): ResolvedWikiStagePolicy {
  return resolveWikiStagePolicy(llm, model, resolveWikiMaxTokens(config, stage),
    config[`${prefix[stage]}ReasoningEffort`], resolveWikiReasoningBudget(config, stage));
}
export function resolveWikiOutputPolicy(config: Config, llm: LlmClient): ResolvedWikiOutputPolicy {
  return Object.freeze({ version: 1, model: config.model,
    planning: resolveConfiguredWikiStage(config, llm, 'planning'),
    page: resolveConfiguredWikiStage(config, llm, 'page'),
    home: resolveConfiguredWikiStage(config, llm, 'home'),
  });
}
/** Fingerprint of each stage's model, token cap, reasoning effort and (only when set) reasoning
 *  budget, so settings without a budget hash as they did before #429. */
export function wikiOutputPolicyHash(policy: ResolvedWikiOutputPolicy): string {
  const { planning, page, home } = policy;
  return createHash('sha256').update(JSON.stringify({ planning, page, home })).digest('hex');
}
export function bindWikiStageClient(llm: LlmClient, policy: ResolvedWikiStagePolicy): LlmClient {
  if (!llm.withConfiguration) throw new Error('WIKI_OUTPUT_CONFIGURATION_UNSUPPORTED');
  return llm.withConfiguration(policy.configuration);
}
/** Usage-observer context for one stage; the model travels on the request itself. */
export function wikiStageContext(stage: ResolvedWikiStagePolicy): Omit<WikiCallContext, 'stage' | 'target' | 'attempt'> {
  return { policyVersion: 1, maxTokens: stage.maxTokens, configuration: stage.configuration };
}
/** Observer-only context: never included in the provider's prepared payload. */
export function withWikiCallContext(llm: LlmClient, context: WikiCallContext): LlmClient {
  return {
    supportsPreparedCapture: llm.supportsPreparedCapture,
    ...(llm.configurationFor ? { configurationFor: llm.configurationFor.bind(llm) } : {}),
    ...(llm.withConfiguration ? { withConfiguration: configuration =>
      withWikiCallContext(llm.withConfiguration!(configuration), { ...context, configuration }) } : {}),
    ...(llm.previewStructuredCall ? { previewStructuredCall: llm.previewStructuredCall.bind(llm) } : {}),
    structuredCall: req => llm.structuredCall({ ...req, wikiContext: { ...context, ...req.wikiContext } }),
  };
}
