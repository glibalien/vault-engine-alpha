import { callWithTopicBudget, type TopicRequestBudget } from './topic-request-budget.js';
import { isBudgetRefusal } from './budget.js';
import {
  buildAdjudicationMatrix,
  parseAdjudicationMatrix,
} from './adjudicate-matrix.js';
import { ambiguousPlanKeys, pairTouchesPlanKeys } from './adjudicate-rules.js';
import {
  applySameScopeTransformations,
  buildSkippedCreateResults,
  collectPinTransfers,
  dropCreateCandidates,
  rewriteExactCreateMatches,
} from './adjudicate-transform.js';
import { StructuredCallFailure, type LlmClient } from './llm/types.js';
import {
  ADJUDICATION_SYSTEM_PROMPT,
  ADJUDICATION_TOOL,
  buildAdjudicationPromptPayload,
} from './prompts/adjudicate.js';
import type {
  AdjudicationMatrixVerdict,
  AdjudicationPair,
} from './adjudicate-matrix.js';
import type { ExactMatchRewriteResult } from './adjudicate-transform.js';
import type {
  AdjudicationVerdict,
  ExistingWiki,
  NodeRef,
  TokenUsage,
  TopologyPlan,
  TopologyResult,
} from './types.js';

export { buildAdjudicationMatrix, rewriteExactCreateMatches };
export type {
  AdjudicationMatrixParseResult,
  AdjudicationMatrixVerdict,
  AdjudicationPair,
} from './adjudicate-matrix.js';
export type { ExactMatchRewriteResult } from './adjudicate-transform.js';

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export type AdjudicationInput = {
  readonly requestBudget?: TopicRequestBudget;
  readonly model: string;
  readonly plan: TopologyPlan;
  readonly existingWiki: ExistingWiki;
  readonly evidence: string;
  readonly repairAttempt?: 0 | 1;
  readonly affectedPlanKeys?: readonly string[];
  readonly maxTokens?: number;
  readonly system?: string;
};

export type AdjudicationOutcome = {
  readonly status: 'approved' | 'repair-required' | 'degraded';
  readonly plan: TopologyPlan;
  readonly verdicts: readonly AdjudicationVerdict[];
  readonly results: readonly TopologyResult[];
  readonly usage: TokenUsage;
  readonly affected_plan_keys: readonly string[];
  readonly affected_comparisons: readonly AdjudicationPair[];
  readonly warnings: readonly string[];
  readonly pin_transfers: readonly PinTransfer[];
  readonly duplicate_safe: boolean;
  /** A completed response failed local validation, distinct from a call failure. */
  readonly invalid_result?: boolean;
  /** On repair-required only: the outcome to use if the repair pass fails —
   *  the reviewed plan without its ambiguous creates. Its usage is this call's
   *  usage, already counted on the repair-required outcome. */
  readonly fallback?: AdjudicationOutcome;
};

export type PinTransfer = {
  readonly source_node_id: string;
  readonly target: NodeRef;
};

/** A completed adjudicator call whose returned output could not be consumed. */
export class AdjudicationResultError extends Error {
  override readonly name = 'AdjudicationResultError';

  constructor(cause: unknown, readonly usage: TokenUsage) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export async function adjudicateCreates(
  llm: LlmClient,
  input: AdjudicationInput,
): Promise<AdjudicationOutcome> {
  const exact = rewriteExactCreateMatches(input.plan, input.existingWiki);
  const createKeys = collectCreateKeys(exact.plan);
  const pinTransfers = collectPinTransfers(exact.plan, input.existingWiki);
  if (createKeys.length === 0) return approvedOutcome(exact, pinTransfers);

  const comparisons = buildAdjudicationMatrix(exact.plan, input.existingWiki, input.affectedPlanKeys);
  let callResult: Awaited<ReturnType<LlmClient['structuredCall']>>;
  try {
    callResult = await callWithTopicBudget(llm, input.requestBudget, evidence => ({
      model: input.model,
      maxTokens: input.maxTokens ?? 4_000,
      system: input.system ?? ADJUDICATION_SYSTEM_PROMPT,
      user: buildAdjudicationPromptPayload(evidence === undefined ? input.evidence : input.evidence + "\n\n" + evidence, comparisons),
      toolName: ADJUDICATION_TOOL.name,
      toolDescription: ADJUDICATION_TOOL.description,
      schema: ADJUDICATION_TOOL.schema,
    }));
  } catch (error) {
    // A spent budget is not a degraded verdict: dropping every create would let the run stamp its evidence.
    if (isBudgetRefusal(error)) throw error;
    const detail = error instanceof Error ? error.message : 'unknown structured-call failure';
    // A failed call can still have been billed; keep its usage in the run's accounting.
    const usage = error instanceof StructuredCallFailure ? error.usage ?? ZERO_USAGE : ZERO_USAGE;
    return degradedOutcome({ exact, existingWiki: input.existingWiki, usage, reason: `Adjudication call failed: ${detail}` });
  }

  let parsed;
  try {
    parsed = parseAdjudicationMatrix(callResult.output, comparisons);
  } catch (error) {
    throw new AdjudicationResultError(error, callResult.usage);
  }
  if (!parsed.ok) {
    return { ...degradedOutcome({ exact, existingWiki: input.existingWiki, usage: callResult.usage, reason: `Adjudication matrix rejected: ${parsed.code}` }), invalid_result: true };
  }

  const implicated = ambiguousPlanKeys(comparisons, parsed.verdicts);
  const semanticVerdicts = parsed.verdicts.map(toAdjudicationVerdict);
  const allVerdicts = [...exact.verdicts, ...semanticVerdicts];
  const skipAmbiguous = (reason: string, warning: string): AdjudicationOutcome => {
    const dropped = dropCreateCandidates(exact.plan, implicated);
    const transformed = applySameScopeTransformations(dropped, input.existingWiki, { pairs: comparisons, verdicts: parsed.verdicts });
    return {
      status: 'approved',
      plan: transformed,
      verdicts: allVerdicts,
      results: buildSkippedCreateResults(exact.plan, { planKeys: implicated, reason, verdicts: parsed.verdicts }),
      usage: callResult.usage,
      affected_plan_keys: [],
      affected_comparisons: [],
      warnings: [`${warning}: ${implicated.join(', ')}.`],
      pin_transfers: collectPinTransfers(transformed, input.existingWiki),
      duplicate_safe: true,
    };
  };

  if (implicated.length > 0 && input.repairAttempt !== 1) {
    return {
      status: 'repair-required',
      plan: exact.plan,
      verdicts: allVerdicts,
      results: [],
      usage: callResult.usage,
      affected_plan_keys: implicated,
      affected_comparisons: comparisons.filter(pair => pairTouchesPlanKeys(pair, implicated)),
      warnings: [],
      pin_transfers: pinTransfers,
      duplicate_safe: false,
      fallback: skipAmbiguous(
        'Create was ambiguous and the topology repair pass failed.',
        'Skipped ambiguous create candidates after a failed repair',
      ),
    };
  }

  if (implicated.length > 0) {
    return skipAmbiguous(
      'Create remained ambiguous after the single topology repair pass.',
      'Skipped ambiguous create candidates after repair',
    );
  }

  const transformed = applySameScopeTransformations(exact.plan, input.existingWiki, { pairs: comparisons, verdicts: parsed.verdicts });
  return {
    status: 'approved',
    plan: transformed,
    verdicts: allVerdicts,
    results: [],
    usage: callResult.usage,
    affected_plan_keys: [],
    affected_comparisons: [],
    warnings: [],
    pin_transfers: collectPinTransfers(transformed, input.existingWiki),
    duplicate_safe: true,
  };
}

function approvedOutcome(
  exact: ExactMatchRewriteResult,
  pinTransfers: readonly PinTransfer[],
): AdjudicationOutcome {
  return {
    status: 'approved',
    plan: exact.plan,
    verdicts: exact.verdicts,
    results: [],
    usage: ZERO_USAGE,
    affected_plan_keys: [],
    affected_comparisons: [],
    warnings: [],
    pin_transfers: pinTransfers,
    duplicate_safe: true,
  };
}

function degradedOutcome(input: {
  readonly exact: ExactMatchRewriteResult;
  readonly existingWiki: ExistingWiki;
  readonly usage: TokenUsage;
  readonly reason: string;
}): AdjudicationOutcome {
  const createKeys = collectCreateKeys(input.exact.plan);
  const plan = dropCreateCandidates(input.exact.plan, createKeys);
  return {
    status: 'degraded',
    plan,
    verdicts: input.exact.verdicts,
    results: buildSkippedCreateResults(input.exact.plan, { planKeys: createKeys, reason: input.reason }),
    usage: input.usage,
    affected_plan_keys: createKeys,
    affected_comparisons: [],
    warnings: [input.reason],
    pin_transfers: collectPinTransfers(plan, input.existingWiki),
    duplicate_safe: false,
  };
}

function collectCreateKeys(plan: TopologyPlan): string[] {
  return plan.actions.flatMap(action => action.op === 'create' ? [action.plan_key] : []);
}

function toAdjudicationVerdict(verdict: AdjudicationMatrixVerdict): AdjudicationVerdict {
  return {
    candidate_plan_key: verdict.candidate_plan_key,
    compared_to: verdict.compared_to,
    relation: verdict.relation,
    confidence: verdict.confidence,
    evidence_ids: verdict.evidence_ids,
    reason: verdict.reason,
  };
}
