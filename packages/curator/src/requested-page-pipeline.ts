import { bindWikiStageClient, resolveWikiOutputPolicy, wikiStageContext } from './wiki-output-policy.js';
import { assertRequestCommitCapacity, snapshotMemory, type SnapshotMemory, type SnapshotRuleLookup } from './db/request-execution.js';
import { randomUUID } from 'node:crypto';
import { PageCapture, assertProjectSubpageCapture } from './provenance-page.js';
import { HomeCapture } from './provenance-home.js';
import type { EvidenceCollector } from './provenance-evidence.js';
import { activeExecution, abandonDefinitiveStaleRejection, abandonInvalidRequestedResult, updateExecution, requestedCaptureCheckpoints, savedRequestedCalls, validateRequestedCommit, type RequestExecutionStore, type RequestedExecutionContext } from './requested-page-recovery.js';
import { PageRuleError } from './page-rules.js';
import type { MemoryConflict } from './wiki-memories.js';
import type { PeopleBlockContacts } from './evidence.js';
import type { CaptureTarget } from './provenance-types.js';
import type { EngineNode, Memory } from './types.js';
import type { Config } from './config.js';
import type { Engine } from './engine.js';
import { StructuredCallFailure, type LlmClient } from './llm/types.js';
import { PageSynthesisError, synthesizeAcceptedPages, synthesizeHomeOverview } from './page-synthesis.js';
import { addUsage, catalogPricing, estimateCostByModel, ZERO_USAGE } from './pricing.js';
import { executeReconciliation } from './reconcile-write.js';
import { PlanningPhaseError, planReconciliation } from './reconciliation-planning.js';
import { WIKI_PAGE_TITLE_RULE } from './prompts/topology.js';
import type {
  ExistingWiki, NodeRef, TokenUsage, TopologyAction, TopologyPlan, WikiCatalogPage,
} from './types.js';
import { acceptedPageIndex } from './write-pages.js';

export const REQUESTED_TOPOLOGY_SYSTEM = `You plan where a page someone asked for goes in a wiki. The evidence starts with THE REQUEST: the page title they asked for and, optionally, a brief on what it should cover.

The input is a JSON object: wiki_root_title (the project or topic the wiki is about; the wiki's root, not one of its pages), evidence, existing_wiki (the wiki's pages, each with its id, title, kind, state and scope) and page_kinds.

Return a plan:
- reviewed_page_ids: the id of every page in existing_wiki.
- actions: the request as one create action, unless it clearly needs a merge into an existing page; keep for every other page. Never retire a page.
- Don't treat an existing page as the requested one because its title matches. A later step compares the new page with every existing page and catches duplicates.
- Never create a page titled the same as wiki_root_title, including a title that differs only in case or in how its characters are encoded. ${WIKI_PAGE_TITLE_RULE}`;

export type RequestedPipelineInput = {
  readonly execution?: RequestedExecutionContext;
  readonly provenance?: EvidenceCollector;
  readonly engine: Engine;
  readonly llm: LlmClient;
  readonly config: Config;
  readonly project: string;
  readonly rootTitle: string;
  readonly wikiRootId: string;
  readonly requestId: string;
  readonly evidenceHash: string;
  readonly evidenceText: string;
  readonly evidenceNodes: readonly EngineNode[];
  /** The memories the evidence shows, appended to the page's own evidence as a full build does (#313). */
  readonly memories?: readonly Memory[];
  /** The memory pairs nothing has settled, shown to the page as a full build shows them (#631). The
   *  planner and home see them in `evidenceText`. */
  readonly conflicts?: readonly MemoryConflict[];
  /** The project's people, with and without notes, shown to the page as a full build shows them
   *  (#631). The planner and home see them in `evidenceText`. */
  readonly contacts?: PeopleBlockContacts;
  /** A project's page (#631): a rule already on it whose memory isn't among `memories` is looked up
   *  by id, and the page is checked against its rules, with one retry. A durable request checks
   *  always and looks rules up only when its snapshot records lookups (older ones don't). */
  readonly checkRules?: boolean;
  readonly memorySubject?: 'project' | 'topic';
  readonly existingWiki: ExistingWiki;
  readonly dryRun: boolean;
  readonly pageSystem?: string;
  /** The home writer's prompt: the wiki's own home prompt, as a full build of that wiki uses. A frozen
   *  request uses the one it saved. Unset, the project home prompt. */
  readonly homeSystem?: string;
  /** Render home Focus items as next-action checkboxes (default); topic wikis have no tasks. */
  readonly homeFocusTasks?: boolean;
};

export type RequestedPipelineResult = {
  readonly target: NodeRef;
  readonly title: string;
  readonly action: 'created' | 'refreshed' | 'reactivated' | 'merged' | 'preview';
  readonly nodeId?: string;
  readonly sourceNodeIds: readonly string[];
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly detail: string;
  readonly invocationUsage: TokenUsage;
  readonly invocationCostUsd: number | null;
};

export class RequestedPageAmbiguityError extends Error {
  override readonly name = 'RequestedPageAmbiguityError';

  constructor(message: string, readonly invalidResult = true) { super(message); }
}

/** Both drafts of the page broke a rule on what to say (#631). Nothing is published, and the
 *  request ends failed with this message as its reason, as a single-page rebuild's does. */
export class RequestedPageRuleError extends Error {
  override readonly name = 'RequestedPageRuleError';
  readonly invalidResult = true;

  constructor(title: string, cause: PageRuleError) {
    super(`The page "${title}" wasn't published and the wiki is unchanged: both drafts broke a rule on what to say (${cause.message.replace(/^breaks a rule on what to say: /, '')}).`, { cause });
  }
}

export class RequestedPagePipelineError extends Error {
  override readonly name = 'RequestedPagePipelineError';

  constructor(cause: unknown, readonly usage: TokenUsage, readonly costUsd: number | null,
    readonly invocationUsage: TokenUsage, readonly invocationCostUsd: number | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export async function runRequestedPagePipeline(input: RequestedPipelineInput): Promise<RequestedPipelineResult> {
  // Every call is priced with the model it used; stages may run on different models.
  const saved = input.execution ? savedRequestedCalls(activeExecution(input.execution.store)) : [];
  const savedUsage = saved.reduce((sum, [, usage]) => addUsage(sum, usage), ZERO_USAGE);
  let knownUsage: TokenUsage | undefined;
  const calls: Array<readonly [string, TokenUsage]> = [];
  const pricing = catalogPricing(input.config);
  const invocationCost = () => estimateCostByModel(calls.length > 0 ? calls : [[input.config.model, ZERO_USAGE]], pricing);
  const totalCost = () => estimateCostByModel(saved.length + calls.length > 0 ? [...saved, ...calls] : [[input.config.model, ZERO_USAGE]], pricing);
  // Account inside checkpoint reuse, before result persistence or stage validation
  // can discard a newly dispatched result. Saved calls belong only to the logical total.
  // This is local run accounting; provider observers retain sole ownership of
  // usage reporting. Wrapped stage errors must not be added a second time.
  const account = (client: LlmClient): LlmClient => ({
    supportsPreparedCapture: client.supportsPreparedCapture,
    ...(client.configurationFor ? { configurationFor: client.configurationFor.bind(client) } : {}),
    ...(client.withConfiguration ? { withConfiguration: configuration => account(client.withConfiguration!(configuration)) } : {}),
    ...(client.previewStructuredCall ? { previewStructuredCall: client.previewStructuredCall.bind(client) } : {}),
    structuredCall: async request => {
      try {
        const result = await client.structuredCall(request);
        knownUsage = addUsage(knownUsage ?? ZERO_USAGE, result.usage);
        calls.push([request.model, result.usage]);
        return result;
      } catch (error) {
        if (error instanceof StructuredCallFailure && error.usage !== undefined) {
          knownUsage = addUsage(knownUsage ?? ZERO_USAGE, error.usage);
          calls.push([request.model, error.usage]);
        }
        throw error;
      }
    },
  });
  const llm = account(input.llm);
  const execution = input.execution;
  try {
    const result = await executeRequestedPagePipeline({ ...input, llm, execution });
    const invocationUsage = knownUsage ?? ZERO_USAGE;
    const usage = addUsage(savedUsage, invocationUsage);
    return { ...result, usage, costUsd: totalCost(), invocationUsage, invocationCostUsd: invocationCost() };
  } catch (error) {
    let failure = error;
    if (execution && (error instanceof PlanningPhaseError || error instanceof PageSynthesisError
      || error instanceof RequestedPageAmbiguityError || error instanceof RequestedPageRuleError) && error.invalidResult) {
      try { await abandonInvalidRequestedResult(input.engine, execution.store); }
      catch (cleanupError) { failure = cleanupError; }
    }
    const invocationUsage = knownUsage ?? ZERO_USAGE;
    const usage = addUsage(savedUsage, invocationUsage);
    throw new RequestedPagePipelineError(failure, usage,
      knownUsage === undefined && !input.execution ? null : totalCost(),
      invocationUsage, knownUsage === undefined ? null : invocationCost());
  }
}

async function executeRequestedPagePipeline(input: RequestedPipelineInput): Promise<Omit<RequestedPipelineResult, 'usage' | 'costUsd' | 'invocationUsage' | 'invocationCostUsd'>> {
  if (input.provenance && !input.dryRun && !input.execution) throw new Error('REQUEST_EXECUTION_REQUIRED');
  if (input.provenance) await assertProjectSubpageCapture(input.engine, input.llm);
  const execution = input.execution;
  const initial = execution ? activeExecution(execution.store) : undefined;
  const knownCommitted = !!initial?.result || !!initial?.captures.some(c => c.receipt?.state === 'committed');
  const runRef = execution?.runRef ?? randomUUID();
  const frozen = execution ? activeExecution(execution.store).snapshot.config : undefined;
  // An old checkpoint deliberately bypasses live overrides; never retrofit a policy.
  const policy = frozen ? frozen.wikiOutputPolicy : resolveWikiOutputPolicy(input.config, input.llm);
  const planningLlm = policy ? bindWikiStageClient(input.llm, policy.planning) : input.llm;
  const pageLlm = policy ? bindWikiStageClient(input.llm, policy.page) : input.llm;
  const homeLlm = policy ? bindWikiStageClient(input.llm, policy.home) : input.llm;
  const planning = await planReconciliation({
    ...(execution ? { execution } : {}),
    llm: planningLlm,
    model: policy?.planning.model ?? input.config.model,
    maxTokens: policy?.planning.maxTokens ?? input.config.homeMaxTokens,
    ...(policy ? { wikiContext: wikiStageContext(policy.planning) } : {}),
    evidence: input.evidenceText,
    existingWiki: input.existingWiki,
    rootTitle: input.rootTitle,
    timeZone: input.config.curatorTz,
    topologySystem: frozen?.curatorTopologyPrompt ?? REQUESTED_TOPOLOGY_SYSTEM,
    ...(frozen ? { adjudicationSystem: frozen.curatorCreateAdjudicationPrompt } : {}),
  });
  if (!planning.adjudication.duplicate_safe
    || planning.adjudication.results.some(result => result.action === 'ambiguous-create-skipped')) {
    throw new RequestedPageAmbiguityError('Requested page scope is ambiguous with existing wiki coverage.',
      planning.adjudication.invalid_result === true || planning.adjudication.duplicate_safe);
  }

  const selected = selectRequestedAction(planning.plan);
  const canonical = canonicalizeReplacementTarget(planning.plan, selected, input.existingWiki);
  const target = actionTarget(canonical.action);
  const captured = !!input.provenance;
  const generatedAt = execution?.generatedAt ?? new Date();
  const reader = execution ? { getNode: async (id: string) => {
    const saved = activeExecution(execution.store).snapshot.contextNodes[id];
    if (saved) return saved;
    const node = await input.engine.getNode(id, { includeProvenance: true, includeEmbeds: false });
    updateExecution(execution.store, state => ({ ...state, snapshot: { ...state.snapshot,
      contextNodes: { ...state.snapshot.contextNodes, [id]: node } } }));
    return node;
  } } : input.engine;
  const key = 'node_id' in target ? target.node_id : target.plan_key;
  // Rules on what to say (#631). A durable request follows its snapshot: it checks always, and looks
  // rules up only when the snapshot records lookups, so an older one's saved draft still matches.
  const checkRules = execution ? true : input.checkRules === true;
  const loadRuleMemories = execution
    ? activeExecution(execution.store).snapshot.ruleLookups === undefined ? undefined : frozenRuleLookup(execution.store, input.engine)
    : input.checkRules ? async (ids: readonly number[]) => (await input.engine.listMemoriesWithTotal({ ids, limit: ids.length,
      ...(captured ? { includeProvenance: true } : {}) })).memories : undefined;
  // How many drafts of each page this run has prepared: the second is the rule check's retry.
  const drafts = new Map<string, number>();
  let pages;
  try {
    pages = await synthesizeAcceptedPages(pageLlm, reader, {
      ...(captured ? { generatedAt, captureFactory: async (captureTarget, _request, selection) => {
        const draft = drafts.get(JSON.stringify(captureTarget)) ?? 0;
        drafts.set(JSON.stringify(captureTarget), draft + 1);
        // A requested page gets one retry, after its rule check sends the first draft back.
        if (draft > 1) throw new Error('REQUEST_PAGE_DRAFTS');
        if (execution && draft === 0 && retried(execution.store, captureTarget)) {
          // The check sent this draft back before a restart. Its draft and check results are saved, so
          // nothing is sent again, and it is never staged: the second draft is the one that can publish.
          const spent = async (): Promise<never> => { throw new Error('REQUEST_DRAFT_SUPERSEDED'); };
          return { onPrepared: spent, stage: spent, fail: async () => {} };
        }
        // The second draft's record and attempt key are saved before it is prepared, and only then is
        // the first draft's attempt failed. A crash in between resumes the second draft from its saved
        // calls; it never sends a call whose result is saved, and never stages the first draft.
        const checkpoints = execution ? requestedCaptureCheckpoints(execution.store, 'project-subpage-v1', captureTarget,
          draft === 1 ? 2 : undefined) : undefined;
        if (execution && draft === 1) await failFirstDraft(input.engine, execution.store, captureTarget);
        const capture = new PageCapture(input.engine, { projectId: input.wikiRootId,
          runRef, target: captureTarget, generatedAt: selection.generatedAt, dryRun: input.dryRun,
          items: selection.items, omissions: selection.omissions, timeZone: input.config.curatorTz }, checkpoints);
        const saved = execution ? activeExecution(execution.store).captures.find(c => c.attemptKey === capture.attemptKey) : undefined;
        if (saved?.receipt) await capture.restore(saved.receipt);
        return { onPrepared: capture.onPrepared, stage: async result => {
          const binding = await capture.stage(result);
          if (checkpoints) await checkpoints.afterStage();
          return binding;
        }, fail: async () => { if (!execution) await capture.fail(); } };
      } } : {}),
      // Each call is saved under its own key: the draft, its check, and the retry's draft and check.
      ...(execution ? { callClient: (_target: NodeRef, attempt: number, call: 'page' | 'rules') =>
        execution.llmFor(pageLlm, requestedPageCallKey(key, attempt, call)) } : {}),
      model: policy?.page.model ?? input.config.model,
      plan: canonical.plan,
      existingWiki: input.existingWiki,
      evidenceNodes: input.evidenceNodes,
      ...(input.memories?.length ? { memories: input.memories } : {}),
      ...(input.conflicts?.length ? { conflicts: input.conflicts } : {}),
      ...(input.contacts ? { contacts: input.contacts } : {}),
      ...(input.memorySubject ? { memorySubject: input.memorySubject } : {}),
      checkRules,
      ...(loadRuleMemories ? { loadRuleMemories } : {}),
      bodyCharCap: input.config.bodyCharCap,
      maxTokens: policy?.page.maxTokens ?? input.config.homeMaxTokens,
      timeZone: input.config.curatorTz,
      ...(policy ? { wikiContext: wikiStageContext(policy.page) } : {}),
      ...(input.pageSystem === undefined ? {} : { system: input.pageSystem }),
    });
  } catch (error) {
    if (error instanceof PageSynthesisError && error.cause instanceof PageRuleError) {
      throw new RequestedPageRuleError(pageTitle(canonical.plan, canonical.action, input.existingWiki), error.cause);
    }
    throw error;
  }
  const homeCheckpoints = execution ? requestedCaptureCheckpoints(execution.store, 'project-home-v1') : undefined;
  const homeCapture = captured ? new HomeCapture(input.engine, input.wikiRootId, runRef,
    input.dryRun, input.provenance!, generatedAt, undefined, homeCheckpoints, input.config.curatorTz) : undefined;
  const savedHome = execution && homeCapture ? activeExecution(execution.store).captures.find(c => c.attemptKey === homeCapture.attemptKey) : undefined;
  if (savedHome?.receipt && homeCapture) await homeCapture.restore(savedHome.receipt);
  const home = await synthesizeHomeOverview(execution?.llmFor(homeLlm, 'home:0') ?? homeLlm, {
    ...(homeCapture ? { onPrepared: homeCapture.onPrepared, generatedAt } : {}),
    ...(frozen ? { system: frozen.curatorProjectHomePrompt } : input.homeSystem === undefined ? {} : { system: input.homeSystem }),
    model: policy?.home.model ?? input.config.model,
    timeZone: input.config.curatorTz,
    evidence: input.evidenceText,
    pageIndex: acceptedPageIndex(canonical.plan, input.existingWiki),
    maxTokens: policy?.home.maxTokens ?? input.config.homeMaxTokens,
    ...(policy ? { wikiContext: wikiStageContext(policy.home) } : {}),
    ...(input.homeFocusTasks === undefined ? {} : { focusTasks: input.homeFocusTasks }),
  });
  const provenance = await homeCapture?.stage(home.sections, home.validatedSections);
  if (homeCapture && homeCheckpoints) await homeCheckpoints.afterStage();
  const reconcileEngine = execution ? { wikiReconcile: async (request: Parameters<Engine['wikiReconcile']>[0]) => {
    if (!request.dry_run) updateExecution(execution.store, state => {
      if (state.reconcile && JSON.stringify(state.reconcile) !== JSON.stringify(request)) throw new Error('REQUEST_COMMIT_MISMATCH');
      const next = { ...state, phase: 'staged' as const, reconcile: request };
      if (!knownCommitted) assertRequestCommitCapacity(next);
      return next;
    });
    let response;
    try { response = await input.engine.wikiReconcile(request); }
    catch (error) {
      await abandonDefinitiveStaleRejection(input.engine, execution.store, activeExecution(execution.store), error, knownCommitted);
      throw error;
    }
    if (!request.dry_run) {
      validateRequestedCommit(activeExecution(execution.store), response.data);
      updateExecution(execution.store, state => ({ ...state, result: response.data }));
    }
    return response;
  } } : input.engine;
  const reconciled = await executeReconciliation({
    ...(provenance ? { provenance, provenanceMode: 'project-subpage-v1' as const, curatedAt: generatedAt.toISOString() } : {}),
    engine: reconcileEngine,
    project: input.project,
    wikiRootId: input.wikiRootId,
    evidenceHash: input.evidenceHash,
    existingWiki: input.existingWiki,
    plan: canonical.plan,
    synthesizedPages: pages.pages,
    homeSections: home.sections,
    dryRun: input.dryRun,
    requestedPage: { requestId: input.requestId, target },
  });
  const identity = resolvedIdentity(canonical.action, target, input.existingWiki, reconciled.data.created, reconciled.mappings);
  const warningText = reconciled.warnings.map(warning => warning.message).join('; ');
  return {
    target,
    title: identity.title,
    ...(identity.nodeId === undefined ? {} : { nodeId: identity.nodeId }),
    action: input.dryRun ? 'preview' : actionName(canonical.action),
    sourceNodeIds: canonical.action.op === 'merge' ? canonical.action.sources : [],
    detail: warningText === '' ? (input.dryRun ? 'preview' : actionName(canonical.action)) : `${actionName(canonical.action)}; warnings: ${warningText}`,
  };
}

/** The durable key of one page call (#631): the first draft keeps the key a page call always had,
 *  so a request saved before the rule check resumes; its check, and the retry's draft and check,
 *  each get their own. */
export function requestedPageCallKey(key: string, attempt: number, call: 'page' | 'rules'): string {
  return `page:${key}${attempt > 0 ? `:draft-${attempt + 1}` : ''}${call === 'rules' ? ':rules' : ''}`;
}

function sameTarget(a: CaptureTarget | undefined, b: CaptureTarget): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

/** Whether the page's second draft has a record: its first draft was sent back by the rule check. */
function retried(store: RequestExecutionStore, target: CaptureTarget): boolean {
  return activeExecution(store).captures.some(c => c.flow === 'project-subpage-v1' && c.draft === 2 && sameTarget(c.target, target));
}

/** Fails the first draft's attempt once the second draft's record is saved. Best effort, as
 *  PageCapture.fail is, and repeated when a second draft resumes; Engine's lease bounds one it misses. */
async function failFirstDraft(engine: Engine, store: RequestExecutionStore, target: CaptureTarget): Promise<void> {
  const first = activeExecution(store).captures.find(c => c.flow === 'project-subpage-v1' && c.draft === undefined && sameTarget(c.target, target));
  if (!first) return;
  try {
    const inspected = await engine.inspectProvenance({ select: 'attempt', flow: 'project-subpage-v1', attempt_key: first.attemptKey });
    const attempt = inspected.select === 'attempt' ? inspected.attempt : null;
    if (!attempt || attempt.availability !== 'retained' || (attempt.state !== 'prepared' && attempt.state !== 'result_staged')
      || (first.receipt && attempt.derivation_id !== first.receipt.derivation_id)) return;
    await engine.transitionProvenance({ derivation_id: attempt.derivation_id, action: 'fail', expected_state: attempt.state });
  } catch { /* The second draft goes ahead; the lease bounds the first. */ }
}

/**
 * Rule memories looked up by id for a durable request (#631). Each lookup is saved in the snapshot
 * with what it found, or that it failed, so a resumed request writes and checks the same rules and
 * its saved calls still match. A failed lookup throws, so the page's rules section is carried over.
 */
function frozenRuleLookup(store: RequestExecutionStore, engine: Engine): (ids: readonly number[]) => Promise<readonly Memory[]> {
  return async ids => {
    const wanted = [...new Set(ids)].sort((a, b) => a - b);
    const same = (lookup: SnapshotRuleLookup) => JSON.stringify(lookup.ids) === JSON.stringify(wanted);
    let lookup = activeExecution(store).snapshot.ruleLookups?.find(same);
    if (!lookup) {
      let memories: SnapshotMemory[] | null;
      try {
        memories = (await engine.listMemoriesWithTotal({ ids: wanted, limit: wanted.length, includeProvenance: true }))
          .memories.filter(memory => wanted.includes(memory.id)).map(snapshotMemory);
      } catch (error) {
        console.warn(`[curator] rule memories unavailable; the page's rules section is carried over: ${error instanceof Error ? error.message : String(error)}`);
        memories = null;
      }
      lookup = { ids: wanted, memories };
      const saved = lookup;
      updateExecution(store, state => ({ ...state, snapshot: { ...state.snapshot,
        ruleLookups: [...(state.snapshot.ruleLookups ?? []).filter(other => !same(other)), saved] } }));
    }
    if (lookup.memories === null) throw new Error('RULE_LOOKUP_UNAVAILABLE');
    return lookup.memories as Memory[];
  };
}

/** The title of the page the request writes, for a reason that names it. */
function pageTitle(plan: TopologyPlan, action: TopologyAction, wiki: ExistingWiki): string {
  const target = actionTarget(action);
  if ('node_id' in target) return wiki.subpages.find(page => page.id === target.node_id)?.title ?? target.node_id;
  const create = plan.actions.find((candidate): candidate is Extract<TopologyAction, { op: 'create' }> =>
    candidate.op === 'create' && candidate.plan_key === target.plan_key);
  return create?.title ?? target.plan_key;
}

function selectRequestedAction(plan: TopologyPlan): TopologyAction {
  const merges = plan.actions.filter((action): action is Extract<TopologyAction, { op: 'merge' }> => action.op === 'merge');
  const merge = merges[0];
  if (merges.length === 1 && merge !== undefined) return merge;
  const terminals = plan.actions.filter((action): action is Extract<TopologyAction, { op: 'create' | 'refresh' | 'reactivate' }> =>
    action.op === 'create' || action.op === 'refresh' || action.op === 'reactivate');
  const terminal = terminals[0];
  if (terminals.length === 1 && terminal !== undefined) return terminal;
  throw new RequestedPageAmbiguityError('Requested page plan did not resolve to exactly one target.');
}

function canonicalizeReplacementTarget(
  plan: TopologyPlan,
  selected: TopologyAction,
  wiki: ExistingWiki,
): { readonly plan: TopologyPlan; readonly action: TopologyAction } {
  if (selected.op !== 'refresh' && selected.op !== 'reactivate') return { plan, action: selected };
  const byId = new Map(wiki.subpages.map(page => [page.id, page]));
  const original = requiredPage(byId, selected.node_id);
  const canonical = followReplacement(original, byId);
  if (canonical.id === original.id) return { plan, action: selected };
  const replacement: TopologyAction = canonical.wiki_state === 'active'
    ? { op: 'refresh', node_id: canonical.id, scope: canonical.wiki_scope ?? selected.scope, synthesis_brief: selected.synthesis_brief }
    : { op: 'reactivate', node_id: canonical.id, scope: canonical.wiki_scope ?? selected.scope, synthesis_brief: selected.synthesis_brief };
  return {
    action: replacement,
    plan: {
      ...plan,
      actions: [
        ...plan.actions.filter(action => !referencesNode(action, original.id) && !referencesNode(action, canonical.id)),
        { op: 'keep', node_id: original.id, scope: original.wiki_scope ?? selected.scope },
        replacement,
      ],
    },
  };
}

function referencesNode(action: TopologyAction, nodeId: string): boolean {
  if ('node_id' in action) return action.node_id === nodeId;
  return action.op === 'merge' && ('node_id' in action.target ? action.target.node_id === nodeId : false);
}

function followReplacement(start: WikiCatalogPage, pages: ReadonlyMap<string, WikiCatalogPage>): WikiCatalogPage {
  const seen = new Set([start.id]);
  let current = start;
  while (current.wiki_replaced_by?.id !== undefined && !seen.has(current.wiki_replaced_by.id)) {
    const next = pages.get(current.wiki_replaced_by.id);
    if (next === undefined) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

function actionTarget(action: TopologyAction): NodeRef {
  switch (action.op) {
    case 'create': return { plan_key: action.plan_key };
    case 'refresh':
    case 'reactivate': return { node_id: action.node_id };
    case 'merge': return action.target;
    case 'keep':
    case 'retire': throw new RequestedPageAmbiguityError('Requested page plan selected a non-writing action.');
    default: return assertNever(action);
  }
}

function actionName(action: TopologyAction): 'created' | 'refreshed' | 'reactivated' | 'merged' {
  switch (action.op) {
    case 'create': return 'created';
    case 'refresh': return 'refreshed';
    case 'reactivate': return 'reactivated';
    case 'merge': return 'merged';
    case 'keep':
    case 'retire': throw new RequestedPageAmbiguityError('Requested page plan selected a non-writing action.');
    default: return assertNever(action);
  }
}

function resolvedIdentity(
  action: TopologyAction,
  target: NodeRef,
  wiki: ExistingWiki,
  created: readonly { readonly node_id: string; readonly title: string }[],
  mappings: readonly { readonly source_node_id: string; readonly target_node_id: string; readonly target_title: string }[],
): { readonly nodeId?: string; readonly title: string } {
  if ('node_id' in target) {
    const page = wiki.subpages.find(candidate => candidate.id === target.node_id);
    if (page === undefined) throw new RequestedPageAmbiguityError(`Requested target ${target.node_id} is absent from the catalog.`);
    return { nodeId: page.id, title: page.title };
  }
  const sourceIds = action.op === 'merge' ? action.sources : [];
  const mapping = mappings.find(candidate => sourceIds.includes(candidate.source_node_id));
  if (mapping !== undefined) return { nodeId: mapping.target_node_id, title: mapping.target_title };
  const createAction = action.op === 'create' ? action : undefined;
  const title = createAction?.title ?? target.plan_key;
  const createdNode = created.find(candidate => candidate.title === title);
  return { ...(createdNode === undefined ? {} : { nodeId: createdNode.node_id }), title };
}

function requiredPage(pages: ReadonlyMap<string, WikiCatalogPage>, nodeId: string): WikiCatalogPage {
  const page = pages.get(nodeId);
  if (page === undefined) throw new RequestedPageAmbiguityError(`Requested target ${nodeId} is absent from the catalog.`);
  return page;
}

function assertNever(value: never): never {
  throw new RequestedPageAmbiguityError(`Unsupported requested-page action: ${JSON.stringify(value)}`);
}
