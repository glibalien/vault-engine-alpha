import { resolveWikiStagePolicy, bindWikiStageClient } from '../wiki-output-policy.js';
import { buildEvidence } from '../evidence.js';
import { synthesize } from '../synthesize.js';
import { estimateCostUsd } from '../pricing.js';
import type { SynthesisProfile } from './profile.js';
import type { EvalFixture } from './corpus.js';
import type { LlmClient } from '../llm/types.js';
import type { WikiSections, ThemedPageProposal, TokenUsage } from '../types.js';

/** One point on the model axis of the benchmark matrix. */
export interface EvalModel {
  /** Resolved provider model id, e.g. 'accounts/fireworks/models/qwen3p7-plus'. */
  model: string;
  /** Report label: Settings/Models catalog title, or the id's trailing path segment. */
  label: string;
}

export interface RunOutput {
  profileId: string;
  /** Report/scoreboard key: profileId alone in single-model runs, `${profileId} @ ${label}` otherwise. */
  variantId: string;
  model: string;
  label: string;
  project: string;
  sections: WikiSections & { at_a_glance?: string };
  themedPages: ThemedPageProposal[];
  usage: TokenUsage;
  costUsd: number | null;
  evidenceChars: number;
}

/** Run one synthesis variant (one profile × one model × one fixture). */
export async function runVariant(
  llm: LlmClient,
  fixture: EvalFixture,
  profile: SynthesisProfile,
  m: EvalModel,
  variantId: string,
): Promise<RunOutput> {
  const evidence = buildEvidence(
    fixture.project,
    fixture.evidence,
    fixture.readNodes,
    profile.bodyCharCap,
    profile.gapFill ? fixture.candidates : [],
  );

  const { sections, themedPages, usage } = await synthesize(
    bindWikiStageClient(llm, resolveWikiStagePolicy(llm, m.model, profile.maxTokens, profile.homeReasoningEffort, profile.homeReasoningBudget)),
    m.model,
    evidence,
    profile.maxTokens,
    profile.systemPrompt,
  );

  return {
    profileId: profile.id,
    variantId,
    model: m.model,
    label: m.label,
    project: fixture.project.title,
    sections,
    themedPages,
    usage,
    costUsd: estimateCostUsd(m.model, usage),
    evidenceChars: evidence.length,
  };
}

/** Run all fixtures × profiles × models sequentially. One RunOutput per combination. */
export async function runMatrix(
  llm: LlmClient,
  fixtures: EvalFixture[],
  profiles: SynthesisProfile[],
  models: EvalModel[],
): Promise<RunOutput[]> {
  const multiModel = models.length > 1;
  const results: RunOutput[] = [];
  for (const fixture of fixtures) {
    for (const profile of profiles) {
      for (const m of models) {
        const variantId = multiModel ? `${profile.id} @ ${m.label}` : profile.id;
        results.push(await runVariant(llm, fixture, profile, m, variantId));
      }
    }
  }
  return results;
}
