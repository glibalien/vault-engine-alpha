import { resolveWikiOutputPolicy, bindWikiStageClient, wikiOutputPolicyHash, wikiStageContext, type ResolvedWikiOutputPolicy, type ResolvedWikiStagePolicy } from './wiki-output-policy.js';
import type { TopicRequestBudgetContext } from './topic-request-budget.js';
import { buildHomeRequest } from './home-request.js';
import { EvidenceBudgetError, measureBundle, type CaptureLimits } from './provenance-budget.js';
import { capturedBundle, HOME_BUDGET_ASSEMBLY } from './provenance-evidence.js';
import { HomeCapture, closedCaptureReason } from './provenance-home.js';
import { PageCapture, assertProjectSubpageCapture } from './provenance-page.js';
import type { EvidenceCollector } from './provenance-evidence.js';
import type { ProvenanceBinding } from './provenance-types.js';
import type { DeferredCreates } from './db/deferred-creates.js';
import type { Config } from './config.js';
import type { Engine } from './engine.js';
import { StructuredCallFailure, type LlmClient } from './llm/types.js';
import { PageSynthesisError, accountTopologySynthesis, synthesizeAcceptedPages, synthesizeHomeOverview, type PageNoteBaseline } from './page-synthesis.js';
import { executeReconciliation, ReconciliationExecutionError } from './reconcile-write.js';
import { planReconciliation, PlanningPhaseError, type LongBrief, type PlanningAttemptAudit, type PlanningResult } from './reconciliation-planning.js';
import { checkpointStoreFor, reusablePages, reusedPlanning, stageFingerprint, targetKey, type StageCheckpointStore } from './stage-checkpoints.js';
import { acceptedPageIndex, canRefreshLiveOnly, shouldSkipReconciliation, topologyToThemed } from './write-pages.js';
import type { MemoryConflict } from './wiki-memories.js';
import { pageEvidenceIds, pageRuleIds, plannerMemories, plannerSources, withHeldPages, writtenPageReads } from './page-sources.js';
import { catalogPricing, ZERO_USAGE } from './pricing.js';
import { budgetRefusalDetail, isBudgetRefusal } from './budget.js';
import type { PageLimits } from './page-templates.js';
import { SYNTHESIS_BRIEF_TARGET_CHARS } from './prompts/topology.js';
import type {
  CurateResult,
  EngineNode,
  Memory,
  ExistingWiki,
  MemoryProposal,
  PageSynthesisResult,
  PlanningActionAudit,
  PlanningAttemptTopologyAudit,
  ProjectEvidence,
  TopologyAction,
  TopologyPlan,
  WikiScopeV1,
} from './types.js';

export type HomeBudgetContext = {
  readonly homePolicy?: ResolvedWikiStagePolicy;
  readonly generatedAt: Date;
  /** The zone the home's date line and Log stamp are written in (`Config.curatorTz`, #459). */
  readonly timeZone?: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly system: string;
  readonly limits: CaptureLimits;
  readonly omissionCounts: Readonly<Record<string, number>>;
};

export type ReconciliationEvidence = {
  readonly topicEvidence?: TopicRequestBudgetContext;
  readonly homeBudget?: HomeBudgetContext;
  readonly provenance?: EvidenceCollector;
  readonly text: string;
  readonly nodes: readonly EngineNode[];
  /** The memories shown to the home, shown to project sub-pages too (#297). */
  readonly memories?: readonly Memory[];
  /** A project's people and companies with notes, shown to the home and every page (#474 idea 4). */
  readonly contacts?: ProjectEvidence['contacts'];
  /** Memory pairs nothing has settled, shown to the home and every page (#474 idea 4). */
  readonly conflicts?: readonly MemoryConflict[];
};

export type ReconciliationPipelineInput = {
  /** What each existing sub-page was last built from (#352); a project build only. */
  readonly pageNoteStates?: ReadonlyMap<string, PageNoteBaseline>;
  readonly provenanceRunRef?: string;
  readonly engine: Engine;
  readonly llm: LlmClient;
  readonly config: Config;
  readonly project: string;
  readonly rootTitle: string;
  readonly wikiRootId: string;
  readonly evidenceHash: string;
  readonly existingWiki: ExistingWiki;
  readonly dryRun: boolean;
  /** With dryRun, run the paid stages and preview without writing. Plain dry runs make no model calls. */
  readonly preview?: boolean;
  readonly force: boolean;
  /** Evidence hash of a recent paid failure; unforced runs on the same evidence are held. */
  readonly failureHoldHash?: string | null;
  /** Why no paid stage may start (daily budget spent); the skip and live-refresh paths still run. */
  readonly budgetSpent?: string;
  /** Only task evidence changed since the narrative was written. */
  readonly taskOnlyChange?: boolean;
  /** Evidence components changed since the narrative was written, when known. */
  readonly changedComponents?: readonly string[];
  /** Re-renders Engine live sections without synthesis (project wikis). */
  readonly refreshLive?: (dryRun: boolean) => Promise<void>;
  readonly refreshDue?: boolean;
  /** Creates the last written run deferred under the per-run cap; while the home still carries that
   *  run's evidence hash, plan again even if nothing changed. */
  readonly deferred?: DeferredCreates | null;
  /** Paid stage results a failed project run left for these inputs; reused, and cleared once a run writes. */
  readonly checkpoints?: StageCheckpointStore;
  /** `fresh`: read the project's evidence again instead of reusing what the run's gate read. The
   *  home's one retry asks for it after an edit changed its evidence during the build. */
  readonly prepareEvidence: (policy: ResolvedWikiOutputPolicy, options?: { readonly fresh?: boolean }) => Promise<ReconciliationEvidence>;
  /** Waits before the home's retry, for the edits that changed its evidence to settle
   *  (default {@link HOME_RETRY_WAIT_MS}). Tests pass one that returns at once. */
  readonly waitBeforeHomeRetry?: () => Promise<void>;
  readonly topologySystem?: string;
  readonly adjudicationSystem?: string;
  readonly pageSystem?: string;
  readonly homeSystem?: string;
  /** Render home Focus items as next-action checkboxes (default); topic wikis have no tasks. */
  readonly homeFocusTasks?: boolean;
  /** The home's status around a written build (#547). Absent, a build stamps no status of its own. */
  readonly buildStatus?: BuildStatusHooks;
};

/** The wiki status stamps around a build (#547), supplied by core. */
export type BuildStatusHooks = {
  /** Called once, when a written build has passed every gate and is about to read its evidence
   *  and synthesize: stamps `building` on the home. Never throws. */
  readonly onBuildStart: (homeId: string) => Promise<void>;
  /** The status the build's home write stamps: `paused` for a paused wiki's build. */
  readonly homeStatus: 'current' | 'paused';
};

/**
 * How long the home's retry waits after an edit changed its evidence mid-build. Edits come in
 * bursts (a note linked in a dozen places at once), and the retry's own capture is checked only
 * seconds after it reads, so waiting out the burst is what lets the retry succeed.
 */
export const HOME_RETRY_WAIT_MS = 60_000;

const waitForEditsToSettle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, HOME_RETRY_WAIT_MS));

export type ReconciliationPipelineResult = {
  readonly result: CurateResult;
  readonly memories: readonly MemoryProposal[];
};

/**
 * The existing wiki as the stage fingerprint sees it: without the home's version, which no
 * stage reads and every status stamp moves (#547). Otherwise a failed run's `failed` stamp, or
 * the next run's `building` one, would keep its paid stages from ever being reused.
 */
function fingerprintedWiki(wiki: ExistingWiki): unknown {
  if (!wiki.home) return wiki;
  const { version: _version, ...home } = wiki.home;
  return { ...wiki, home };
}

/**
 * The evidence reads as the stage fingerprint sees them. The home's read leaves out its version,
 * index metadata and provenance observation, which every status stamp moves (#547). Its fields
 * and body, which is what the stages read, stay in.
 */
function fingerprintedNodes(nodes: readonly EngineNode[], homeId: string | null): unknown {
  if (homeId === null) return nodes;
  return nodes.map(node => {
    if (node.id !== homeId) return node;
    const { version: _version, metadata: _metadata, provenance_observation: _observation, ...rest } = node;
    return rest;
  });
}

/**
 * Stamp `building` on the home of a build that will write (#547). The build's home write keeps
 * the version it read: the Engine accepts the status-only versions after it and refuses one an
 * edit made in between.
 */
async function stampBuildStart(input: ReconciliationPipelineInput): Promise<void> {
  const home = input.existingWiki.home;
  if (input.dryRun || !input.buildStatus || !home) return;
  await input.buildStatus.onBuildStart(home.id);
}

export async function runReconciliationPipeline(input: ReconciliationPipelineInput): Promise<ReconciliationPipelineResult> {
  const priorCuratedAt = input.existingWiki.home?.wiki_curated_at ?? null;
  const refreshDue = (input.refreshDue ?? false) || pendingCreates(input);
  if (shouldSkipReconciliation({
    existingWiki: input.existingWiki,
    evidenceHash: input.evidenceHash,
    force: input.force,
    refreshDue,
  })) {
    await refreshUnchangedLive(input);
    return skipped(input, priorCuratedAt);
  }
  if (!input.existingWiki.catalog_valid) return failed(input, 'catalog', new InvalidCatalogError());
  if (input.refreshLive && canRefreshLiveOnly({ existingWiki: input.existingWiki, evidenceHash: input.evidenceHash,
    force: input.force, refreshDue, taskOnlyChange: input.taskOnlyChange ?? false })) {
    return refreshedLive(input, input.refreshLive, priorCuratedAt);
  }
  if (!input.force && input.failureHoldHash && input.failureHoldHash === input.evidenceHash) return held(input, priorCuratedAt);
  if (input.dryRun && !input.preview) return wouldCurate(input, priorCuratedAt);
  if (input.budgetSpent !== undefined) return budgetSkipped(input, input.budgetSpent, priorCuratedAt);

  await stampBuildStart(input);
  let prepared: ReconciliationEvidence;
  let policy: ResolvedWikiOutputPolicy;
  try {
    if (input.provenanceRunRef) await assertProjectSubpageCapture(input.engine, input.llm);
    policy = resolveWikiOutputPolicy(input.config, input.llm);
    prepared = await input.prepareEvidence(policy);
  } catch (error) {
    return failed(input, 'evidence', error);
  }

  const budgetDetail = prepared.homeBudget ? Object.entries(prepared.homeBudget.omissionCounts)
    .sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code}=${count}`).join(',') : '';
  const budgetWarning = budgetDetail ? `provenance omissions: ${budgetDetail}` : '';
  let reuseNote = '';
  let homeRetryNote = '';
  const finish = (result: ReconciliationPipelineResult): ReconciliationPipelineResult => {
    result.result.outputPolicyHash = wikiOutputPolicyHash(policy);
    const notes = [reuseNote, homeRetryNote, budgetWarning].filter(note => note !== '');
    if (notes.length === 0) return result;
    result.result.detail = `${result.result.detail ?? ''}; ${notes.join('; ')}`;
    const auditNotes = [homeRetryNote, budgetWarning].filter(note => note !== '');
    if (auditNotes.length > 0 && result.result.topologyAudit) result.result.topologyAudit = { ...result.result.topologyAudit,
      warnings: [...(result.result.topologyAudit.warnings ?? []), ...auditNotes] };
    return result;
  };

  const stageModels = { planning: policy.planning.model, page: policy.page.model, home: policy.home.model };
  const accountStages = (stages: Parameters<typeof accountTopologySynthesis>[1]) =>
    accountTopologySynthesis(stageModels, stages, catalogPricing(input.config));
  const planningLlm = bindWikiStageClient(input.llm, policy.planning);
  const pageLlm = bindWikiStageClient(input.llm, policy.page);
  const homeLlm = bindWikiStageClient(input.llm, policy.home);
  const pageLimits = pageLimitsFrom(input.config);
  const captured = Boolean(prepared.provenance && input.provenanceRunRef);
  // Stages a failed run completed on exactly these inputs are reused instead of paid for again.
  const store = checkpointStoreFor(input.checkpoints, { dryRun: input.dryRun, topic: prepared.topicEvidence !== undefined });
  const fingerprint = store ? stageFingerprint({
    wikiRootId: input.wikiRootId, rootTitle: input.rootTitle, evidenceHash: input.evidenceHash,
    evidenceText: prepared.text, evidenceNodes: fingerprintedNodes(prepared.nodes, input.existingWiki.home_id),
    existingWiki: fingerprintedWiki(input.existingWiki), planningPolicy: policy.planning, pagePolicy: policy.page,
    prompts: { topology: input.topologySystem, adjudication: input.adjudicationSystem, page: input.pageSystem },
    pageLimits, bodyCharCap: input.config.bodyCharCap, provenance: captured,
    ...(prepared.memories && prepared.memories.length > 0 ? { memories: prepared.memories.map(memory =>
      ({ id: memory.id, source: memory.source, category: memory.category, content: memory.content })) } : {}),
  }) : '';
  const checkpoint = store?.load(fingerprint) ?? null;
  // A project planner names each page's sources (#474 idea 3); a topic planner already did.
  const sources = prepared.topicEvidence ? undefined
    : plannerSources(prepared.nodes, input.wikiRootId, input.existingWiki, input.config.curatorTz);
  // ...and marks which memories are each page's rules on what to say (#474 idea 4).
  const memories = prepared.topicEvidence ? undefined : plannerMemories(prepared.memories ?? []);
  let planning: PlanningResult;
  if (checkpoint) {
    planning = reusedPlanning(checkpoint.planning);
    reuseNote = 'reused checkpointed planning';
  } else try {
    planning = await planReconciliation({
      topicEvidence: prepared.topicEvidence,
      llm: planningLlm,
      wikiContext: wikiStageContext(policy.planning),
      model: policy.planning.model,
      maxTokens: policy.planning.maxTokens,
      evidence: prepared.text,
      existingWiki: input.existingWiki,
      rootTitle: input.rootTitle,
      timeZone: input.config.curatorTz,
      pageLimits,
      ...(sources === undefined ? {} : { sources }),
      ...(memories === undefined ? {} : { memories }),
      ...(input.topologySystem === undefined ? {} : { topologySystem: input.topologySystem }),
      ...(input.adjudicationSystem === undefined ? {} : { adjudicationSystem: input.adjudicationSystem }),
    });
  } catch (error) {
    if (error instanceof PlanningPhaseError) {
      const accounting = accountStages({
        planner: error.plannerUsage,
        adjudicator: error.adjudicatorUsage,
        page: ZERO_USAGE,
        home: ZERO_USAGE,
      });
      return finish(failed(input, error.phase, error.cause, error.issueCodes, error.attempts, accounting));
    }
    return finish(failed(input, 'planning', error));
  }
  if (store && !checkpoint) store.savePlanning(fingerprint, planning);

  const homeBudget = prepared.homeBudget;
  // The plan as written: a page held for breaking a rule is kept as it was (#474 idea 4).
  let plan = planning.plan;
  let pageIndex = acceptedPageIndex(plan, input.existingWiki);
  const pageReads = sources ? pageEvidenceIds(planning.plan, input.wikiRootId) : undefined;
  const capture = prepared.provenance && input.provenanceRunRef
    ? new HomeCapture(input.engine, input.wikiRootId, input.provenanceRunRef, input.dryRun, prepared.provenance,
      homeBudget?.generatedAt, homeBudget ? HOME_BUDGET_ASSEMBLY : undefined, undefined, homeBudget ? homeBudget.timeZone : input.config.curatorTz) : null;
  // The home's capture is bound to the exact request checked here, so a changed page index is checked again.
  const preflightHome = async (budget: HomeBudgetContext, homeCapture = capture, evidence = prepared): Promise<void> => {
    if (!homeCapture || !evidence.provenance || !homeLlm.previewStructuredCall) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
    const preview = await homeLlm.previewStructuredCall({
      ...buildHomeRequest({ ...budget, evidence: evidence.text, pageIndex }),
      malformedOutputPolicy: 'fail-closed-redacted',
    });
    const issue = measureBundle(capturedBundle(preview, evidence.provenance, HOME_BUDGET_ASSEMBLY), budget.limits);
    if (issue) throw new EvidenceBudgetError('preflight', issue);
    await homeCapture.preflight(preview);
  };
  if (homeBudget) {
    try {
      await preflightHome(homeBudget);
    } catch (error) {
      const accounting = accountStages({
        planner: planning.plannerUsage, adjudicator: planning.adjudicatorUsage, page: ZERO_USAGE, home: ZERO_USAGE,
      });
      return finish(failed(input, 'provenance preflight', error instanceof EvidenceBudgetError ? error : new Error(closedCaptureReason(error)),
        planning.validationIssueCodes, planning.attempts, accounting));
    }
  }

  const reusable = checkpoint ? await reusablePages(input.engine, checkpoint.pages, capture !== null) : new Map<string, PageSynthesisResult>();
  // Pages whose staged derivations stay for the next attempt instead of being failed with this run.
  const checkpointed = new Set(reusable.keys());
  const pageCaptures = new Map<string, PageCapture>();
  // The home's capture and evidence: the run's own, or the retry's after an edit changed them mid-build.
  let homeCapture = capture;
  let homeEvidence = prepared;
  const failCaptures = async (keepCheckpointed = true): Promise<void> => {
    await Promise.all([...pageCaptures].filter(([key]) => !(keepCheckpointed && checkpointed.has(key)))
      .map(([, pageCapture]) => pageCapture.fail()));
    await homeCapture?.fail();
  };
  let reusedPages = 0;
  let pages;
  try {
    pages = await synthesizeAcceptedPages(pageLlm, input.engine, {
      topicEvidence: prepared.topicEvidence,
      model: policy.page.model,
      plan: planning.plan,
      existingWiki: input.existingWiki,
      evidenceNodes: prepared.nodes,
      ...(pageReads ? { evidenceIdsByTarget: pageReads } : {}),
      ...(sources ? { ruleIdsByTarget: pageRuleIds(planning.plan), checkRules: true, holdRuleBreaks: true,
        loadRuleMemories: async (ids: readonly number[]) => (await input.engine.listMemoriesWithTotal({ ids, limit: ids.length,
          ...(prepared.provenance ? { includeProvenance: true } : {}) })).memories } : {}),
      ...(prepared.memories && !prepared.topicEvidence ? { memories: prepared.memories } : {}),
      ...(prepared.contacts && !prepared.topicEvidence ? { contacts: prepared.contacts } : {}),
      ...(prepared.conflicts && !prepared.topicEvidence ? { conflicts: prepared.conflicts } : {}),
      ...(input.pageNoteStates && !prepared.topicEvidence ? { pageNoteStates: input.pageNoteStates } : {}),
      bodyCharCap: input.config.bodyCharCap,
      maxTokens: policy.page.maxTokens,
      wikiContext: wikiStageContext(policy.page),
      timeZone: input.config.curatorTz,
      ...(capture ? { generatedAt: capture.generatedAt, captureFactory: (target, _request, selection) => {
        const pageCapture = new PageCapture(input.engine, { projectId: input.wikiRootId,
          runRef: input.provenanceRunRef!, target, generatedAt: selection.generatedAt, dryRun: input.dryRun,
          items: selection.items, omissions: selection.omissions, timeZone: input.config.curatorTz });
        pageCaptures.set(targetKey(target), pageCapture);
        return pageCapture;
      } } : {}),
      ...(input.pageSystem === undefined ? {} : { system: input.pageSystem }),
      retryMalformed: true,
      reuse: target => {
        const page = reusable.get(targetKey(target));
        if (page) reuseNote = `reused checkpointed planning and ${++reusedPages} page(s)`;
        return page;
      },
      ...(store ? { onPage: (result: PageSynthesisResult) => {
        const key = targetKey(result.target);
        const attemptKey = pageCaptures.get(key)?.attemptKey;
        if (store.savePage(fingerprint, { result, ...(attemptKey === undefined ? {} : { attemptKey }) })) checkpointed.add(key);
      } } : {}),
    });
  } catch (error) {
    await failCaptures();
    const accounting = accountStages({
      planner: planning.plannerUsage,
      adjudicator: planning.adjudicatorUsage,
      page: error instanceof PageSynthesisError ? error.usage : ZERO_USAGE,
      home: ZERO_USAGE,
    });
    return finish(failed(input, 'page synthesis', error, planning.validationIssueCodes, planning.attempts, accounting));
  }
  const heldPages = pages.held ?? [];
  const heldWarnings = heldPages.map(page => `page ${'node_id' in page.target ? 'kept unchanged' : 'not created'}: ${page.title} ${page.detail}`);
  if (heldPages.length > 0) {
    plan = withHeldPages(plan, heldPages, input.existingWiki);
    pageIndex = acceptedPageIndex(plan, input.existingWiki);
    if (homeBudget) {
      try {
        await preflightHome(homeBudget);
      } catch (error) {
        await failCaptures();
        const accounting = accountStages({ planner: planning.plannerUsage, adjudicator: planning.adjudicatorUsage, page: pages.usage, home: ZERO_USAGE });
        return finish(failed(input, 'provenance preflight', error instanceof EvidenceBudgetError ? error : new Error(closedCaptureReason(error)),
          planning.validationIssueCodes, planning.attempts, accounting));
      }
    }
  }

  // An edit changed the home's evidence while the build ran (a note it read was saved again), so the
  // Engine won't record a home built from versions that are gone. Its capture is refused before the
  // home's call is sent, so nothing was paid for it. Wait for the edits to settle, read the evidence
  // again and build a fresh capture for one more try. The pages keep what they were built from, and
  // the run keeps its evidence hash, so a wiki whose notes moved shows as behind.
  const prepareHomeRetry = async (): Promise<{ capture: HomeCapture; evidence: ReconciliationEvidence } | { error: unknown }> => {
    await (input.waitBeforeHomeRetry ?? waitForEditsToSettle)();
    let evidence: ReconciliationEvidence;
    try {
      evidence = await input.prepareEvidence(policy, { fresh: true });
    } catch (error) {
      return { error };
    }
    if (!evidence.provenance || !input.provenanceRunRef) return { error: new Error('PROVENANCE_CAPTURE_UNSUPPORTED') };
    const retryCapture = new HomeCapture(input.engine, input.wikiRootId, input.provenanceRunRef, input.dryRun, evidence.provenance,
      evidence.homeBudget?.generatedAt, evidence.homeBudget ? HOME_BUDGET_ASSEMBLY : undefined, undefined,
      evidence.homeBudget ? evidence.homeBudget.timeZone : input.config.curatorTz);
    if (evidence.homeBudget) {
      try {
        await preflightHome(evidence.homeBudget, retryCapture, evidence);
      } catch (error) {
        return { error: error instanceof EvidenceBudgetError ? error : new Error(closedCaptureReason(error)) };
      }
    }
    return { capture: retryCapture, evidence };
  };

  let home;
  let provenance: ProvenanceBinding | null = null;
  for (let attempt = 0; ; attempt++) {
    const budget = homeEvidence.homeBudget;
    const topic = homeEvidence.topicEvidence;
    try {
      home = await synthesizeHomeOverview(homeLlm, {
        ...(topic ? { requestBudget: { context: topic, query: topic.query,
          maxBytes: topic.topicRequestMaxBytes, stage: 'home' as const } } : {}),
        ...(homeCapture ? { onPrepared: homeCapture.onPrepared, generatedAt: homeCapture.generatedAt } : {}),
        timeZone: input.config.curatorTz,
        model: policy.home.model,
        evidence: homeEvidence.text,
        pageIndex,
        maxTokens: policy.home.maxTokens,
        wikiContext: wikiStageContext(policy.home),
        ...(input.homeSystem === undefined ? {} : { system: input.homeSystem }),
        ...(input.homeFocusTasks === undefined ? {} : { focusTasks: input.homeFocusTasks }),
        ...(budget ? { model: budget.model, maxTokens: budget.maxTokens, system: budget.system, generatedAt: budget.generatedAt,
          timeZone: budget.timeZone } : {}),
      });
      if (homeCapture) provenance = await homeCapture.stage(home.sections, home.validatedSections);
      break;
    } catch (error) {
      let failure: unknown = homeCapture?.failureReason ? new Error(homeCapture.failureReason) : error;
      if (attempt === 0 && homeCapture?.failureReason === 'PROVENANCE_OBSERVATION_CHANGED') {
        homeRetryNote = "the home's notes changed during the build; read them again and retried the home once";
        await homeCapture.fail();
        const retry = await prepareHomeRetry();
        if ('capture' in retry) {
          homeCapture = retry.capture;
          homeEvidence = retry.evidence;
          continue;
        }
        homeRetryNote = "the home's notes changed during the build; reading them again for a retry failed";
        failure = retry.error;
      }
      await failCaptures();
      const accounting = accountStages({
        planner: planning.plannerUsage,
        adjudicator: planning.adjudicatorUsage,
        page: pages.usage,
        home: home?.usage ?? (error instanceof PageSynthesisError || error instanceof StructuredCallFailure ? error.usage ?? ZERO_USAGE : ZERO_USAGE),
      });
      return finish(failed(input, 'home synthesis', failure, planning.validationIssueCodes, planning.attempts, accounting));
    }
  }

  const curatedAt = (capture?.generatedAt ?? new Date()).toISOString();
  const accounting = accountStages({
    planner: planning.plannerUsage,
    adjudicator: planning.adjudicatorUsage,
    page: pages.usage,
    home: home.usage,
  });
  try {
    const reconciled = await executeReconciliation({
      engine: input.engine,
      project: input.project,
      wikiRootId: input.wikiRootId,
      evidenceHash: input.evidenceHash,
      existingWiki: input.existingWiki,
      plan,
      synthesizedPages: pages.pages,
      homeSections: home.sections,
      ...(provenance ? { provenance, provenanceMode: 'project-subpage-v1' as const } : {}),
      dryRun: input.dryRun,
      curatedAt,
      ...(input.buildStatus ? { homeStatus: input.buildStatus.homeStatus } : {}),
    });
    store?.clear();
    const topology = [...planning.adjudication.results, ...reconciled.topology];
    const limitWarnings = planning.droppedCreates.map(drop => `page not created (${drop.reason} limit): ${drop.title} [${drop.kind}]`);
    const keptWarnings = [...keptByDefaultWarnings(planning.keptByDefault, input.existingWiki),
      ...longBriefWarnings(planning.longBriefs, input.existingWiki, planning.plan)];
    // A zero per-run cap disables creates; only a positive cap defers them to a run that can make progress.
    const deferredCreates = pageLimits.maxCreatesPerRun > 0
      ? planning.droppedCreates.filter(drop => drop.reason === 'creates-per-run').length : 0;
    const warningDetail = [...planning.adjudication.warnings, ...keptWarnings, ...reconciled.warnings.map(warning => warning.message), ...limitWarnings, ...heldWarnings].join('; ');
    return finish({
      result: {
        project: input.project,
        outcome: 'written',
        detail: warningDetail === '' ? 'wiki reconciled' : `wiki reconciled; warnings: ${warningDetail}`,
        dryRun: input.dryRun,
        sections: home.sections,
        topology,
        topologyHash: reconciled.topologyHash,
        topologyAudit: {
          catalog: {
            valid: input.existingWiki.catalog_valid,
            missing_scope_node_ids: input.existingWiki.subpages.filter(page => page.wiki_scope === undefined).map(page => page.id),
          },
          proposedReviewedPageIds: planning.proposedPlan.reviewed_page_ids,
          finalReviewedPageIds: planning.plan.reviewed_page_ids,
          proposedActions: planning.proposedPlan.actions,
          finalActions: plan.actions,
          planningAttempts: projectPlanningAttempts(planning.attempts),
          adjudicationVerdicts: planning.adjudication.verdicts,
          validationIssueCodes: planning.validationIssueCodes,
          reconcileKey: reconciled.reconcileKey,
          warnings: [...keptWarnings, ...reconciled.warnings.map(warning => warning.message), ...limitWarnings, ...heldWarnings],
          enginePreview: reconciled.data.preview,
          homePreview: { title: reconciled.homeOutcome.title, created: reconciled.homeOutcome.created },
          mappings: reconciled.mappings,
          operationId: reconciled.data.operation_id,
          ...(reconciled.data.provenance_receipt ? { provenanceReceipt: reconciled.data.provenance_receipt } : {}),
          ...(reconciled.data.provenance_receipts ? { provenanceReceipts: reconciled.data.provenance_receipts } : {}),
        },
        themed: topologyToThemed(topology),
        wikiCuratedAt: input.dryRun ? priorCuratedAt : curatedAt,
        evidenceHash: input.evidenceHash,
        ...(deferredCreates > 0 ? { deferredCreates } : {}),
        ...(input.pageNoteStates && !input.dryRun && !prepared.topicEvidence
          ? { pageNoteStates: pageNoteStatesOf(reconciled.topology, reconciled.homeOutcome.node_id, pages.pages, prepared.nodes, input.existingWiki,
            pageReads ? { plan, idsByTarget: pageReads } : undefined) } : {}),
        usage: accounting.usage,
        costUsd: accounting.costUsd,
      },
      memories: home.memories,
    });
  } catch (error) {
    // A failed write may involve the reused pages themselves, so the next attempt starts clean.
    store?.clear();
    await failCaptures(false);
    return finish(error instanceof ReconciliationExecutionError
      ? failed(input, error.phase, error.cause, planning.validationIssueCodes, planning.attempts, accounting)
      : failed(input, 'reconciliation', error, planning.validationIssueCodes, planning.attempts, accounting));
  }
}

/** The topology results whose page got a synthesized body. A `keep` that only repairs a page's
 *  scope is written too, but its narrative read none of this build's notes (#352). */
const SYNTHESIZED_RESULTS: ReadonlySet<string> = new Set(['refreshed', 'reactivated', 'created', 'merged-target']);

/** What to record for the sub-pages a written build synthesized (#352): their ids, the ones
 *  rewritten from changed notes, and the text hash of each note the build read (its content hash
 *  from an Engine without text hashes; #332), so a link added later is no change. A page whose
 *  writer read only the notes the planner named (#474 idea 3) records only those, so a note it
 *  never read still counts as new to it next time. */
export function pageNoteStatesOf(topology: readonly ({ readonly action: string; readonly node_id: string; readonly title?: string } | { readonly action: string })[],
  homeId: string | null, pages: readonly PageSynthesisResult[], nodes: readonly EngineNode[], wiki: ExistingWiki,
  reads?: { readonly plan: TopologyPlan; readonly idsByTarget: Readonly<Record<string, readonly string[]>> },
): NonNullable<CurateResult['pageNoteStates']> {
  const wikiIds = new Set([wiki.home_id, ...wiki.subpages.map(page => page.id)]);
  const notes: Record<string, string> = {};
  for (const node of nodes) {
    const hash = node.metadata?.text_hash ?? node.metadata?.content_hash;
    if (hash && !wikiIds.has(node.id)) notes[node.id] = hash;
  }
  const writtenResults = topology.flatMap(result => SYNTHESIZED_RESULTS.has(result.action) && 'node_id' in result ? [result] : [])
    .filter(result => result.node_id !== homeId && !result.node_id.startsWith('plan:'));
  const pageNotes: Record<string, string[]> = {};
  if (reads) for (const result of writtenResults) {
    const ids = writtenPageReads({ node_id: result.node_id, title: result.title ?? '' }, reads.plan, reads.idsByTarget);
    if (ids) pageNotes[result.node_id] = ids.filter(id => notes[id] !== undefined);
  }
  return {
    written: [...new Set(writtenResults.map(result => result.node_id))],
    rewritten: pages.flatMap(page => page.rewrite && 'node_id' in page.target ? [page.target.node_id] : []),
    notes,
    ...(Object.keys(pageNotes).length > 0 ? { pageNotes } : {}),
  };
}

function pendingCreates(input: ReconciliationPipelineInput): boolean {
  return (input.deferred?.count ?? 0) > 0 && input.deferred?.evidenceHash === input.existingWiki.home?.wiki_evidence_hash;
}

/** Automatic sub-page caps from settings; unset caps do not limit. */
function pageLimitsFrom(config: Config): PageLimits {
  return {
    maxActivePages: config.archetypeTotalCap ?? Number.POSITIVE_INFINITY,
    maxActivePerKind: config.archetypeKindCap ?? Number.POSITIVE_INFINITY,
    maxCreatesPerRun: config.wikiPageCreatesPerRun ?? Number.POSITIVE_INFINITY,
  };
}

/** Unchanged wikis still get current Overdue/Upcoming rows; Engine skips identical renders. Best-effort. */
async function refreshUnchangedLive(input: ReconciliationPipelineInput): Promise<void> {
  if (!input.refreshLive || input.dryRun) return;
  try {
    await input.refreshLive(false);
  } catch (error) {
    console.warn(`[curator] live refresh failed for ${input.project}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function refreshedLive(input: ReconciliationPipelineInput, refresh: (dryRun: boolean) => Promise<void>,
  priorCuratedAt: string | null): Promise<ReconciliationPipelineResult> {
  try {
    await refresh(input.dryRun);
  } catch (error) {
    return failed(input, 'live refresh', error);
  }
  return {
    result: {
      project: input.project, outcome: 'refreshed_live', dryRun: input.dryRun,
      detail: `${input.dryRun ? 'dry run: ' : ''}only tasks changed; live sections ${input.dryRun ? 'would be ' : ''}refreshed without model calls`,
      wikiCuratedAt: priorCuratedAt, evidenceHash: input.evidenceHash, topologyHash: input.existingWiki.topology_hash,
    },
    memories: [],
  };
}

/** One warning naming the pages the planner gave no action, which the run kept unchanged (#323). */
function keptByDefaultWarnings(ids: readonly string[], existingWiki: ExistingWiki): string[] {
  if (ids.length === 0) return [];
  const titles = ids.map(id => existingWiki.subpages.find(page => page.id === id)?.title ?? id);
  return [`planner gave no action for ${ids.length} page(s), kept unchanged: ${titles.join(', ')}`];
}

/** One warning naming the pages whose brief the run kept over the target after asking the planner to shorten it (#633). */
function longBriefWarnings(briefs: readonly LongBrief[], existingWiki: ExistingWiki, plan: TopologyPlan): string[] {
  if (briefs.length === 0) return [];
  const titleOf = (target: LongBrief['target']): string => 'node_id' in target
    ? existingWiki.subpages.find(page => page.id === target.node_id)?.title ?? target.node_id
    : plan.actions.flatMap(action => action.op === 'create' && action.plan_key === target.plan_key ? [action.title] : [])[0] ?? target.plan_key;
  const titles = briefs.map(({ target, chars }) => `${titleOf(target)} (${chars} chars)`);
  return [`planner brief over the ${SYNTHESIS_BRIEF_TARGET_CHARS}-character target, kept for ${briefs.length} page(s): ${titles.join(', ')}`];
}

function held(input: ReconciliationPipelineInput, priorCuratedAt: string | null): ReconciliationPipelineResult {
  return {
    result: {
      project: input.project, outcome: 'skipped_failure_hold',
      detail: 'failure hold: the last run on this evidence failed after paid calls; retry by forcing or after a source change',
      dryRun: input.dryRun, wikiCuratedAt: priorCuratedAt, evidenceHash: input.evidenceHash, topologyHash: input.existingWiki.topology_hash,
    },
    memories: [],
  };
}

function budgetSkipped(input: ReconciliationPipelineInput, detail: string, priorCuratedAt: string | null): ReconciliationPipelineResult {
  return {
    result: {
      project: input.project, outcome: 'skipped_budget', detail, dryRun: input.dryRun,
      wikiCuratedAt: priorCuratedAt, evidenceHash: input.evidenceHash, topologyHash: input.existingWiki.topology_hash,
    },
    memories: [],
  };
}

function wouldCurate(input: ReconciliationPipelineInput, priorCuratedAt: string | null): ReconciliationPipelineResult {
  const reason = input.existingWiki.home_id === null ? 'no wiki yet' : input.force ? 'forced'
    : input.refreshDue ? 'refresh due'
    : pendingCreates(input) ? 'deferred page creates pending'
    : input.changedComponents?.length ? `${input.changedComponents.join(', ')} changed` : 'evidence or topology changed';
  return {
    result: {
      project: input.project, outcome: 'would_curate', detail: `dry run: would curate (${reason}); no model calls`,
      dryRun: true, wikiCuratedAt: priorCuratedAt, evidenceHash: input.evidenceHash, topologyHash: input.existingWiki.topology_hash,
      ...(input.force ? { evidenceUnchanged: shouldSkipReconciliation({ existingWiki: input.existingWiki, evidenceHash: input.evidenceHash,
        force: false, refreshDue: (input.refreshDue ?? false) || pendingCreates(input) }) } : {}),
    },
    memories: [],
  };
}

function skipped(input: ReconciliationPipelineInput, priorCuratedAt: string | null): ReconciliationPipelineResult {
  return {
    result: {
      project: input.project, outcome: 'skipped', detail: 'evidence and topology unchanged', dryRun: input.dryRun,
      wikiCuratedAt: priorCuratedAt, evidenceHash: input.evidenceHash, topologyHash: input.existingWiki.topology_hash,
    },
    memories: [],
  };
}

function failed(
  input: ReconciliationPipelineInput,
  phase: string,
  error: unknown,
  validationIssueCodes: readonly string[] = [],
  attempts: readonly PlanningAttemptAudit[] = [],
  accounting?: { readonly usage: CurateResult['usage']; readonly costUsd: CurateResult['costUsd'] },
): ReconciliationPipelineResult {
  const budgetRefused = isBudgetRefusal(error);
  const detail = budgetRefused ? budgetRefusalDetail(error) : error instanceof Error ? error.message : String(error);
  const proposed = attempts[0]?.plan;
  const final = attempts.at(-1)?.plan;
  return {
    result: {
      project: input.project, outcome: budgetRefused ? 'skipped_budget' : 'error', detail: `${phase}: ${detail}`, dryRun: input.dryRun,
      evidenceHash: input.evidenceHash, topologyHash: input.existingWiki.topology_hash,
      wikiCuratedAt: input.existingWiki.home?.wiki_curated_at ?? null,
      topology: [{ action: 'error', detail: `${phase}: ${detail}` }],
      themed: [{ kind: 'freeform', title: '(reconciliation)', action: 'error', detail: `${phase}: ${detail}` }],
      topologyAudit: {
        catalog: {
          valid: input.existingWiki.catalog_valid,
          missing_scope_node_ids: input.existingWiki.subpages.filter(page => page.wiki_scope === undefined).map(page => page.id),
        },
        proposedReviewedPageIds: proposed?.reviewed_page_ids ?? [],
        finalReviewedPageIds: final?.reviewed_page_ids ?? [],
        proposedActions: proposed?.actions.map(redactPlanningAction) ?? [],
        finalActions: final?.actions.map(redactPlanningAction) ?? [],
        planningAttempts: projectPlanningAttempts(attempts),
        adjudicationVerdicts: [], validationIssueCodes,
        warnings: [],
      },
      ...(accounting === undefined ? {} : accounting),
    },
    memories: [],
  };
}

function projectPlanningAttempts(attempts: readonly PlanningAttemptAudit[]): PlanningAttemptTopologyAudit[] {
  return attempts.map(({ phase, attempt, plan, issues }) => ({
    phase,
    attempt,
    plan: {
      reviewed_page_ids: [...plan.reviewed_page_ids],
      actions: plan.actions.map(projectPlanningAction),
    },
    issues: issues.map(issue => ({
      code: issue.code,
      ...(issue.action_index === undefined ? {} : { action_index: issue.action_index }),
      ...(issue.node_id === undefined ? {} : { node_id: issue.node_id }),
      ...(issue.plan_key === undefined ? {} : { plan_key: issue.plan_key }),
    })),
  }));
}

/** The brief itself is left out of the saved topology; its length is kept so long briefs can be counted (#633). */
function projectPlanningAction(action: PlanningAttemptAudit['plan']['actions'][number]): PlanningActionAudit {
  const scope = projectScope(action.scope);
  switch (action.op) {
    case 'keep':
    case 'retire':
      return { op: action.op, node_id: action.node_id, scope };
    case 'refresh':
    case 'reactivate':
      return { op: action.op, node_id: action.node_id, scope, synthesis_brief_chars: action.synthesis_brief.length };
    case 'create':
      return { op: action.op, plan_key: action.plan_key, title: action.title, kind: action.kind, scope,
        synthesis_brief_chars: action.synthesis_brief.length };
    case 'merge':
      return {
        op: action.op,
        target: 'node_id' in action.target ? { node_id: action.target.node_id } : { plan_key: action.target.plan_key },
        sources: [...action.sources],
        scope,
        synthesis_brief_chars: action.synthesis_brief.length,
      };
  }
}

function redactPlanningAction(action: TopologyAction): TopologyAction {
  const scope = projectScope(action.scope);
  switch (action.op) {
    case 'keep':
      return { op: action.op, node_id: action.node_id, scope };
    case 'refresh':
    case 'reactivate':
      return { op: action.op, node_id: action.node_id, scope, synthesis_brief: '' };
    case 'create':
      return {
        op: action.op, plan_key: action.plan_key, title: action.title, kind: action.kind,
        scope, synthesis_brief: '',
      };
    case 'merge':
      return {
        op: action.op,
        target: 'node_id' in action.target ? { node_id: action.target.node_id } : { plan_key: action.target.plan_key },
        sources: [...action.sources], scope, reason: '', synthesis_brief: '',
      };
    case 'retire':
      return { op: action.op, node_id: action.node_id, scope, state: action.state, reason: '' };
  }
}

function projectScope(scope: WikiScopeV1): WikiScopeV1 {
  return {
    v: 1,
    subject: scope.subject,
    facet: scope.facet,
    ...(scope.timeframe === undefined ? {} : { timeframe: scope.timeframe }),
    ...(scope.geography === undefined ? {} : { geography: scope.geography }),
    ...(scope.entities === undefined ? {} : { entities: [...scope.entities] }),
    ...(scope.exclusions === undefined ? {} : { exclusions: [...scope.exclusions] }),
  };
}

class InvalidCatalogError extends Error {
  override readonly name = 'InvalidCatalogError';

  constructor() {
    super('existing wiki catalog is invalid');
  }
}
