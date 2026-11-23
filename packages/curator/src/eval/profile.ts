import { resolveWikiMaxTokens, resolveWikiReasoningBudget, type WikiReasoningChoice } from '../wiki-output-policy.js';
import type { Config } from '../config.js';
import { SPEC_A_SYSTEM_PROMPT } from '../synthesize.js';

/** A prompt-shape variant. The model axis is orthogonal — see EvalModel in runner.ts. */
export interface SynthesisProfile {
  id: string;
  systemPrompt: string;
  maxTokens: number;
  homeReasoningEffort: WikiReasoningChoice;
  /** Home reasoning budget in tokens; 0 sets none. */
  homeReasoningBudget: number;
  bodyCharCap: number | null;
  gapFill: boolean;
}

/** What production runs: the project home prompt, or its override in settings. */
export function baselineProfile(config: Config): SynthesisProfile {
  return {
    id: 'baseline',
    systemPrompt: config.curatorProjectHomePrompt?.trim() ? config.curatorProjectHomePrompt : SPEC_A_SYSTEM_PROMPT,
    maxTokens: resolveWikiMaxTokens(config, 'home'),
    homeReasoningEffort: config.wikiHomeReasoningEffort,
    homeReasoningBudget: resolveWikiReasoningBudget(config, 'home'),
    bodyCharCap: config.bodyCharCap,
    gapFill: config.semanticGapFill,
  };
}

// Registry of variant factories. Add a profile here to compare a prompt variant against baseline.
export const VARIANT_FACTORIES: Record<string, (config: Config) => SynthesisProfile> = {
  baseline: baselineProfile,
};

export function resolveProfiles(ids: string[], config: Config): SynthesisProfile[] {
  return ids.map((id) => {
    const factory = VARIANT_FACTORIES[id];
    if (!factory) throw new Error(`unknown profile: ${id}`);
    return factory(config);
  });
}
