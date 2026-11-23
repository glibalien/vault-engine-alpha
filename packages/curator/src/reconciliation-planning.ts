import { enforcePageLimits, type DroppedCreate, type PageLimits } from './page-templates.js';
import { withWikiCallContext } from './wiki-output-policy.js';
import type { WikiCallContext } from './llm/types.js';
import type { TopicRequestBudgetContext } from './topic-request-budget.js';
import { activeExecution, type RequestedExecutionContext } from './requested-page-recovery.js';
import { adjudicateCreates, AdjudicationResultError } from './adjudicate.js';
import type { AdjudicationOutcome } from './adjudicate.js';
import { StructuredCallFailure, type LlmClient } from './llm/types.js';
import { addUsage, ZERO_USAGE } from './pricing.js';
import { synthesizeTopologyPlan, TopologyPlanError } from './synthesize.js';
import { buildTopologyRepairPrompt, SYNTHESIS_BRIEF_HARD_LIMIT_CHARS, validateTopologyPlan } from './topology-validate.js';
import type { TopologyPlanIssue } from './topology-validate.js';
import type { ExistingWiki, NodeRef, TokenUsage, TopologyAction, TopologyPlan } from './types.js';
import { SYNTHESIS_BRIEF_TARGET_CHARS, type PlannerMemory, type PlannerSource } from './prompts/topology.js';

type PlanningInput = {
  readonly wikiContext?: Omit<WikiCallContext, 'stage' | 'target' | 'attempt'>;
  readonly topicEvidence?: TopicRequestBudgetContext;
  readonly execution?: RequestedExecutionContext;
  readonly llm: LlmClient;
  readonly model: string;
  readonly maxTokens: number;
  readonly evidence: string;
  readonly existingWiki: ExistingWiki;
  readonly rootTitle: string;
  /** The zone the planner's date line is written in (`Config.curatorTz`); the host's when absent (#459). */
  readonly timeZone?: string;
  readonly topologySystem?: string;
  readonly adjudicationSystem?: string;
  /** Caps on automatic page creation; creates beyond them are dropped before adjudication. */
  readonly pageLimits?: PageLimits;
  /** A project build's sources: the planner names each page's by id (#474 idea 3). */
  readonly sources?: readonly PlannerSource[];
  /** A project build's memories: the planner marks each page's rules by id (#474 idea 4). */
  readonly memories?: readonly PlannerMemory[];
};

type PlannerCallResult = Awaited<ReturnType<typeof synthesizeTopologyPlan>>;
type ValidationPhase = 'validation' | 'adjudication repair validation';

export type PlanningAttemptAudit = {
  readonly phase: ValidationPhase;
  readonly attempt: number;
  readonly plan: TopologyPlan;
  readonly issues: readonly TopologyPlanIssue[];
};

export type PlanningResult = {
  readonly proposedPlan: TopologyPlan;
  readonly plan: TopologyPlan;
  readonly adjudication: AdjudicationOutcome;
  readonly plannerUsage: TokenUsage;
  readonly adjudicatorUsage: TokenUsage;
  readonly validationIssueCodes: readonly string[];
  readonly attempts: readonly PlanningAttemptAudit[];
  /** Planner creates dropped by pageLimits, in plan order. */
  readonly droppedCreates: readonly DroppedCreate[];
  /** Pages the planner gave no action, kept unchanged by the run instead of failing it (#323). */
  readonly keptByDefault: readonly string[];
  /** Briefs still over the target after the planner was asked to shorten them, kept instead of failing the run (#633). */
  readonly longBriefs: readonly LongBrief[];
};

/** A page whose synthesis brief the run kept over SYNTHESIS_BRIEF_TARGET_CHARS (#633). */
export type LongBrief = {
  /** The page the brief writes: an existing page's node_id, or a new page's plan_key. */
  readonly target: NodeRef;
  readonly chars: number;
};

export class PlanningPhaseError extends Error {
  override readonly name = 'PlanningPhaseError';
  readonly issueCodes: readonly string[];
  readonly invalidResult: boolean;

  constructor(
    readonly phase: string,
    cause: unknown,
    readonly attempts: readonly PlanningAttemptAudit[] = [],
    readonly plannerUsage: TokenUsage = ZERO_USAGE,
    readonly adjudicatorUsage: TokenUsage = ZERO_USAGE,
  ) {
    super(`${phase}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.issueCodes = cause instanceof ValidationIssuesError ? cause.codes : [];
    this.invalidResult = cause instanceof ValidationIssuesError || cause instanceof TopologyPlanError || cause instanceof AdjudicationResultError;
  }
}

export async function planReconciliation(input: PlanningInput): Promise<PlanningResult> {
  const initial = await callPlanner(input, input.evidence, 'planner', [], 'planner:0');
  const proposedPlan = initial.plan;
  const validation = await validateWithRepairs(input, initial, 'validation');
  const defaulted = new Set(validation.keptByDefault);
  const keptLong = new Set(validation.keptLongBriefs);
  let plannerUsage = validation.usage;
  let attempts = [...validation.attempts];
  const validationIssueCodes = validation.attempts[0]?.issues.map(issue => issue.code) ?? [];
  const droppedCreates: DroppedCreate[] = [];
  const limited = (plan: TopologyPlan): TopologyPlan => {
    if (!input.pageLimits) return plan;
    const enforced = enforcePageLimits(plan, input.existingWiki, input.pageLimits);
    droppedCreates.push(...enforced.dropped);
    return enforced.plan;
  };

  let adjudicatorUsage = ZERO_USAGE;
  let adjudication;
  try {
    adjudication = await callAdjudicator(input, limited(validation.plan), 0, attempts);
  } catch (error) {
    if (error instanceof PlanningPhaseError) throw withPriorUsage(error, plannerUsage, adjudicatorUsage);
    throw error;
  }
  adjudicatorUsage = addUsage(adjudicatorUsage, adjudication.usage);
  const repairAdjudicatedPlan = async (required: AdjudicationOutcome): Promise<AdjudicationOutcome> => {
    let repaired;
    try {
      repaired = await callPlanner(input, JSON.stringify({
        repair_attempt: 1,
        reason: 'semantic create adjudication requires repair',
        affected_plan_keys: required.affected_plan_keys,
        comparisons: required.affected_comparisons,
        verdicts: required.verdicts,
        rejected_plan: required.plan,
        evidence: input.evidence,
      }), 'adjudication repair', attempts, 'planner:adjudication:1');
    } catch (error) {
      if (error instanceof PlanningPhaseError) throw withPriorUsage(error, plannerUsage, adjudicatorUsage);
      throw error;
    }
    let repairedValidation;
    try {
      repairedValidation = await validateWithRepairs(input, repaired, 'adjudication repair validation');
    } catch (error) {
      if (error instanceof PlanningPhaseError) {
        throw withPriorUsage(error, plannerUsage, adjudicatorUsage, [...attempts, ...error.attempts]);
      }
      throw error;
    }
    plannerUsage = addUsage(plannerUsage, repairedValidation.usage);
    attempts.push(...repairedValidation.attempts);
    for (const id of repairedValidation.keptByDefault) defaulted.add(id);
    for (const brief of repairedValidation.keptLongBriefs) keptLong.add(brief);
    let repairedAdjudication;
    try {
      repairedAdjudication = await callAdjudicator(input, limited(repairedValidation.plan), 1, attempts);
    } catch (error) {
      if (error instanceof PlanningPhaseError) throw withPriorUsage(error, plannerUsage, adjudicatorUsage);
      throw error;
    }
    adjudicatorUsage = addUsage(adjudicatorUsage, repairedAdjudication.usage);
    return repairedAdjudication;
  };
  if (adjudication.status === 'repair-required') {
    const fallback = adjudication.fallback;
    const droppedBeforeRepair = droppedCreates.length;
    try {
      const repaired = await repairAdjudicatedPlan(adjudication);
      // A degraded re-adjudication (failed call or unusable matrix) would drop
      // every create, including ones the first pass approved; the reviewed
      // plan's fallback keeps those and drops only the ambiguous ones.
      if (repaired.status === 'degraded' && fallback !== undefined) {
        droppedCreates.length = droppedBeforeRepair;
        adjudication = fallback;
      } else {
        adjudication = repaired;
      }
    } catch (error) {
      // Unusable repair output falls back to the reviewed plan without its
      // ambiguous creates, as a create still ambiguous after the repair does.
      // Budget refusals and failed repair-planner calls still fail the run.
      if (fallback === undefined || !(error instanceof PlanningPhaseError) || !error.invalidResult) throw error;
      // The error already carries every attempt and all usage up to the failure.
      plannerUsage = error.plannerUsage;
      adjudicatorUsage = error.adjudicatorUsage;
      attempts = [...error.attempts];
      droppedCreates.length = droppedBeforeRepair;
      adjudication = fallback;
    }
  }
  return {
    proposedPlan,
    plan: adjudication.plan,
    adjudication,
    plannerUsage,
    adjudicatorUsage,
    validationIssueCodes,
    attempts,
    droppedCreates,
    // Only defaults that survived into the plan the run applies.
    keptByDefault: [...defaulted].filter(id => adjudication.plan.actions.some(a => a.op === 'keep' && a.node_id === id)),
    // Likewise only kept briefs the plan still carries as they were: adjudication may drop a create, or join briefs into a new one.
    longBriefs: adjudication.plan.actions.flatMap(action => 'synthesis_brief' in action && keptLong.has(action.synthesis_brief)
      ? [{ target: briefTarget(action), chars: action.synthesis_brief.length }] : []),
  };
}

function briefTarget(action: Extract<TopologyAction, { synthesis_brief: string }>): NodeRef {
  return action.op === 'create' ? { plan_key: action.plan_key } : action.op === 'merge' ? action.target : { node_id: action.node_id };
}

async function validateWithRepairs(
  input: PlanningInput,
  initial: PlannerCallResult,
  phase: ValidationPhase,
  maxRepairs = 2,
): Promise<{ plan: TopologyPlan; usage: TokenUsage; attempts: PlanningAttemptAudit[]; keptByDefault: readonly string[];
  keptLongBriefs: readonly string[] }> {
  let current = initial;
  let usage = ZERO_USAGE;
  const attempts: PlanningAttemptAudit[] = [];
  const evidenceIds = input.topicEvidence ? new Set(input.topicEvidence.sources.map(s => s.id))
    : input.sources ? new Set(input.sources.map(s => s.id)) : undefined;

  for (let attempt = 0; ; attempt += 1) {
    usage = addUsage(usage, current.usage);
    const validation = validateTopologyPlan(current.plan, input.existingWiki, input.rootTitle, evidenceIds);
    const issues = validation.ok ? [] : validation.issues;
    attempts.push({ phase, attempt, plan: current.plan, issues });
    if (validation.ok) return { plan: validation.plan, usage, attempts, keptByDefault: [], keptLongBriefs: [] };
    // Once the planner has been asked to shorten a brief, or no repair is left, a brief still over the
    // target is kept with a warning rather than failing the run; one past the hard limit stays an error (#633).
    const keepLong = (attempt >= maxRepairs || attempts.slice(0, -1).some(prior => prior.issues.some(i => i.code === BRIEF_TOO_LONG)))
      && current.plan.actions.every(action => !('synthesis_brief' in action) || action.synthesis_brief.length <= SYNTHESIS_BRIEF_HARD_LIMIT_CHARS);
    const outstanding = (found: readonly TopologyPlanIssue[]) => keepLong ? found.filter(i => i.code !== BRIEF_TOO_LONG) : found;
    const keptLongBriefs = keepLong ? current.plan.actions.flatMap(action =>
      'synthesis_brief' in action && action.synthesis_brief.length > SYNTHESIS_BRIEF_TARGET_CHARS ? [action.synthesis_brief] : []) : [];
    if (outstanding(validation.issues).length === 0) return { plan: current.plan, usage, attempts, keptByDefault: [], keptLongBriefs };
    // A plan whose only fault is pages it gave no action keeps those pages unchanged rather
    // than failing the run or paying for a repair: the 11-03 planner returned the same
    // incomplete plan to both repairs (#323).
    const filled = keepPagesWithoutAction(current.plan, outstanding(validation.issues), input.existingWiki);
    if (filled !== null) {
      const refilled = validateTopologyPlan(filled.plan, input.existingWiki, input.rootTitle, evidenceIds);
      if (refilled.ok || outstanding(refilled.issues).length === 0) {
        return { plan: filled.plan, usage, attempts, keptByDefault: filled.keptByDefault, keptLongBriefs };
      }
    }
    if (attempt >= maxRepairs) {
      throw new PlanningPhaseError(
        phase,
        new ValidationIssuesError(validation.issues.map(issue => issue.code)),
        attempts,
        usage,
      );
    }

    try {
      current = await callPlanner(
        input,
        buildTopologyRepairPrompt(validation.issues, current.plan, input.existingWiki, input.evidence, input.rootTitle, attempt + 1),
        phase === 'validation' ? 'validation repair' : phase,
        attempts,
        phase === 'validation' ? `planner:validation:${attempt + 1}` : `planner:adjudication:validation:${attempt + 1}`,
      );
    } catch (error) {
      if (error instanceof PlanningPhaseError) throw withPriorUsage(error, usage, ZERO_USAGE);
      throw error;
    }
  }
}

const MISSING_ACTION_CODES: ReadonlySet<string> = new Set(['MISSING_NODE_ROLE', 'MISSING_REVIEWED_PAGE_ID']);
const BRIEF_TOO_LONG = 'SYNTHESIS_BRIEF_TOO_LONG';

/** The plan with a `keep` at its current scope for every page that has no action, when that is the
 *  plan's only fault and every such page has a valid scope to keep. A keep at the page's own scope
 *  writes nothing. Null when anything else is wrong, so the planner repairs it as before. */
export function keepPagesWithoutAction(
  plan: TopologyPlan,
  issues: readonly TopologyPlanIssue[],
  existingWiki: ExistingWiki,
): { plan: TopologyPlan; keptByDefault: readonly string[] } | null {
  if (issues.length === 0 || issues.some(issue => !MISSING_ACTION_CODES.has(issue.code) || issue.node_id === undefined)) return null;
  const pages = new Map(existingWiki.subpages.map(page => [page.id, page]));
  const keeps: TopologyAction[] = [];
  const unreviewed: string[] = [];
  for (const issue of issues) {
    const page = pages.get(issue.node_id!);
    if (page === undefined) return null;
    if (issue.code === 'MISSING_REVIEWED_PAGE_ID') { unreviewed.push(page.id); continue; }
    if (page.wiki_scope === undefined || page.wiki_scope_error !== undefined) return null;
    keeps.push({ op: 'keep', node_id: page.id, scope: page.wiki_scope });
  }
  return {
    plan: { reviewed_page_ids: [...plan.reviewed_page_ids, ...unreviewed], actions: [...plan.actions, ...keeps] },
    keptByDefault: keeps.map(action => (action as { node_id: string }).node_id),
  };
}

async function callPlanner(
  input: PlanningInput,
  evidence: string,
  phase: string,
  attempts: readonly PlanningAttemptAudit[] = [],
  key = 'planner:0',
) {
  try {
    const stageLlm = input.wikiContext ? withWikiCallContext(input.llm, { ...input.wikiContext, stage: 'planner', target: key, attempt: attempts.length }) : input.llm;
    return await synthesizeTopologyPlan(input.execution?.llmFor(stageLlm, key) ?? stageLlm, {
      ...(input.execution ? { generatedAt: input.execution.generatedAt } : {}),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      ...(input.topicEvidence ? { requestBudget: { context: input.topicEvidence, query: input.topicEvidence.query,
        maxBytes: input.topicEvidence.topicRequestMaxBytes, stage: 'planner' as const, target: key } } : {}),
      model: input.model,
      evidence,
      existingWiki: input.existingWiki,
      rootTitle: input.rootTitle,
      maxTokens: input.maxTokens,
      ...(input.pageLimits === undefined ? {} : { pageLimits: input.pageLimits }),
      ...(input.sources === undefined ? {} : { sources: input.sources }),
      ...(input.memories === undefined ? {} : { memories: input.memories }),
      ...(input.topologySystem === undefined ? {} : { system: input.topologySystem }),
    });
  } catch (error) {
    // Rejected output and provider failures can both be billed; keep their usage for the failure hold.
    const usage = error instanceof TopologyPlanError ? error.usage
      : error instanceof StructuredCallFailure ? error.usage ?? ZERO_USAGE : ZERO_USAGE;
    throw new PlanningPhaseError(phase, error, attempts, usage);
  }
}

async function callAdjudicator(
  input: PlanningInput,
  plan: TopologyPlan,
  repairAttempt: 0 | 1,
  attempts: readonly PlanningAttemptAudit[],
) {
  try {
    const stageLlm = input.wikiContext ? withWikiCallContext(input.llm, { ...input.wikiContext, stage: 'adjudicator', attempt: repairAttempt }) : input.llm;
    const result = await adjudicateCreates(input.execution?.llmFor(stageLlm, `adjudicator:${repairAttempt}`) ?? stageLlm, {
      ...(input.topicEvidence ? { requestBudget: { context: input.topicEvidence, query: input.topicEvidence.query,
        maxBytes: input.topicEvidence.topicRequestMaxBytes, stage: 'adjudicator' as const } } : {}),
      model: input.model,
      plan,
      existingWiki: input.existingWiki,
      evidence: input.evidence,
      repairAttempt,
      maxTokens: input.maxTokens,
      ...(input.adjudicationSystem === undefined ? {} : { system: input.adjudicationSystem }),
    });
    if (input.execution && activeExecution(input.execution.store).calls.some(c => c.key === `adjudicator:${repairAttempt}` && c.state === 'sent'))
      throw new Error('REQUEST_CALL_UNCERTAIN');
    return result;
  } catch (error) {
    throw new PlanningPhaseError(
      repairAttempt === 0 ? 'adjudication' : 'adjudication repair',
      error,
      attempts,
      ZERO_USAGE,
      error instanceof AdjudicationResultError ? error.usage : ZERO_USAGE,
    );
  }
}

function withPriorUsage(
  error: PlanningPhaseError,
  plannerUsage: TokenUsage,
  adjudicatorUsage: TokenUsage,
  attempts: readonly PlanningAttemptAudit[] = error.attempts,
): PlanningPhaseError {
  return new PlanningPhaseError(
    error.phase,
    error.cause,
    attempts,
    addUsage(plannerUsage, error.plannerUsage),
    addUsage(adjudicatorUsage, error.adjudicatorUsage),
  );
}

class ValidationIssuesError extends Error {
  override readonly name = 'ValidationIssuesError';

  constructor(readonly codes: readonly string[]) {
    super(codes.join(', '));
  }
}
