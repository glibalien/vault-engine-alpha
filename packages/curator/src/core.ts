import { parseTopicSelection } from './topic-selection-state.js';
import { readRequestExecution, writeRequestExecution, clearRequestExecution, RequestExecutionExpiredError } from './db/request-execution.js';
import type { RequestExecutionStore } from './requested-page-recovery.js';
import { correctionInputs } from './db/provenance.js';
import { randomUUID } from 'node:crypto';
import { resolveWikiOutputPolicy, wikiOutputPolicyHash } from './wiki-output-policy.js';
import type { LlmClient } from './llm/types.js';
import type Database from 'better-sqlite3';
import { projectTypeOf, vaultOf, type Config } from './config.js';
import { EngineError } from './engine.js';
import type { Engine } from './engine.js';
import type { CurationQueue } from './queue.js';
import { projectBuildKey, projectBuildKeys, SWEEP_BUILD_KEY, type BackgroundBuilds, type InFlightBuild } from './background-builds.js';
import type { UsageReporter } from './usage-reporter.js';
import { curateProject, curateRequestedPage, type PageRequestSpec, type RequestedPageOutcome } from './curate.js';
import { curateTopic, topicRefreshCommitMaterial } from './topic.js';
import {
  admitTopicRefresh,
  type TopicRefreshAdmission,
  type TopicRefreshAdmissionWarning,
  type TopicRefreshAssessmentBudget,
  type TopicRefreshStateSnapshot,
} from './topic-refresh-admission.js';
import { assessTopicWebMateriality, type TopicWebMaterialityAssessment } from './topic-refresh-assessment.js';
import {
  buildCanonicalWebProbe,
  comparableTopicBody,
  type CanonicalWebProbe,
  type CanonicalWebProbeInput,
} from './topic-refresh-evidence.js';
import {
  armTopicRefreshBaselineRetry,
  commitTopicRefreshBaseline,
  deleteTopicRefreshState,
  explicitTopicRefreshSources,
  observedTopicRefreshSources,
  replaceExplicitTopicRefreshSources,
  storeTopicProbeCache,
  topicRefreshState,
} from './db/topic-refresh.js';
import { registerWikiRoot, getWikiRoot, deleteWikiRoot, projectWikiRoots, topicWikiRoots, type WikiRootRow } from './db/wiki-roots.js';
import { moveWikiTitle } from './db/wiki-title.js';
import { subpageTitle, RETIRED_SPINE_LABELS } from './spine.js';
import { isStale } from './staleness.js';
import {
  curateResultToRunRow,
  paidFailureHash,
  recordRun,
  requestedPageRunRow,
  type RunContext,
  type RunTrigger,
} from './db/runs.js';
import {
  insertPageRequest, pendingRequests, getPageRequest, markRequestFulfilled, markRequestFailed,
  pinnedPageNodeIds, repairFulfilledRequestTargets, retargetFulfilledRequests,
  deletePageRequests, type PageRequestRow,
} from './db/requests.js';
import { buildStatusTracker } from './wiki-status.js';
import { isPaused, pausedWikis, activeCorrections, clearWikiControl, setPaused } from './db/control.js';
import type { CurateResult, ExistingWiki, ProjectEvidence, ProjectRef, TokenUsage, TopicSpec, WikiCatalogPage } from './types.js';
import { isCadenceDue, parseCadence } from './cadence.js';
import { truncate } from './evidence.js';
import { runMemorySweep } from './memory-sweep.js';
import { runConversationSweep } from './conversation-sweep.js';
import {
  runConversationCaptureSweep,
  type ConversationCaptureSweepResult,
} from './conversation-capture-sweep.js';
import { runOrgSweep } from './org-sweep.js';
import { runReconcile } from './reconcile.js';
import { startDossier } from './dossier/build.js';
import { runDossierRebuilds } from './dossier/freshness.js';
import { runLinkSweep } from './link-sweep.js';
import { runMemoryNoteRefresh } from './memory-note-refresh.js';
import { runFieldGuessSweep } from './field-guess/sweep.js';
import type { RunBudgetFactory } from './budget.js';
import type { FieldGuessSweepResult } from './field-guess/types.js';
import type { ActionRecorder } from './journal/recorder.js';
import { budgetRefusalDetail, type BudgetGate } from './budget.js';
import { deleteEvidenceManifest, readEvidenceManifest, writeEvidenceManifest, type EvidenceManifest } from './db/evidence-manifests.js';
import { deletePageNoteStates, pageNoteEntries, readPageNoteStates, writePageNoteStates, type PageNoteState } from './db/page-note-states.js';
import { keptBothPairs } from './db/reconcile.js';
import { deleteDeferredCreates, readDeferredCreates, recordDeferredCreates, type DeferredCreates } from './db/deferred-creates.js';
import { deleteStageCheckpoint, stageCheckpointStore } from './db/stage-checkpoints.js';
import type { StageCheckpointStore } from './stage-checkpoints.js';
import { writeJournalEntry, type JournalScope } from './journal/writer.js';
import { clearWikiField, type WikiFieldClear } from './wiki-field.js';

export interface CoreDeps {
  /** Strict read-only settings reload for confirmed selective refreshes. */
  refreshDeps?: () => Promise<CoreDeps>;
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  /** When present, every curation is recorded to the runs table (best-effort). */
  db?: Database.Database;
  /** When present, every LLM call is reported to the engine spend ledger with run attribution. */
  usage?: UsageReporter;
  /** When present, every vault mutation + run summary lands in journal_events. */
  recorder?: ActionRecorder;
  /** When present, sweeps stop starting wikis once the daily budget is spent. */
  budget?: BudgetGate;
  /** When present (the server), live on-demand builds run in the background and their
   *  tool calls reply at once. Absent (the CLI), they run before the call returns. */
  builds?: BackgroundBuilds;
  /** Makes the budget of an on-demand run that states its own limit, apart from the daily cap (#644). */
  runBudget?: RunBudgetFactory;
  /** True once the server has begun shutting down: long background work stops at its next step. */
  stopping?: () => boolean;
}

export interface CurateOpts {
  dryRun: boolean;
  /** With dryRun, run the paid stages and preview without writing. Plain dry runs make no model calls. */
  preview?: boolean;
  force: boolean;
  /** Invocation source — recorded on the run row. Never known to curateProject. */
  trigger: RunTrigger;
}

export interface SweepOpts extends CurateOpts {
  limit?: number | null;
  /** Complete field-guess phase result for CLI/observer reporting; never folded into CurateResult[]. */
  onFieldGuessResult?: (result: FieldGuessSweepResult) => void | Promise<void>;
  /** Called once with the batch size after the active list is resolved. */
  onStart?: (count: number) => void;
  /** Optional per-result callback so the CLI can log incrementally. */
  onResult?: (result: CurateResult) => void;
  /** Optional capture-specific result callback, invoked before wiki observability. */
  onConversationCaptureResult?: (result: ConversationCaptureSweepResult) => void;
}

/** Record a run best-effort. Observability must never fail curation. */
function recordRunSafe(
  deps: CoreDeps,
  result: CurateResult,
  trigger: RunTrigger,
  durationMs: number,
  ts: string,
  refreshEvidence?: NonNullable<RunContext['refreshEvidence']>,
): void {
  if (!deps.db) return;
  try {
    recordRun(deps.db, curateResultToRunRow(result, {
      trigger,
      durationMs,
      ts,
      ...(refreshEvidence === undefined ? {} : { refreshEvidence }),
    }));
  } catch (err) {
    console.warn(`[curator] run not recorded for ${result.project}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function warn(msg: string, err: unknown): void {
  console.warn(`[curator] ${msg}: ${err instanceof Error ? err.message : String(err)}`);
}

function captureSweepFailureResult(dryRun: boolean, error: unknown): ConversationCaptureSweepResult {
  return {
    ran: false,
    dryRun,
    detail: `capture sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    scanned: 0,
    settled: 0,
    belowFloor: 0,
    unchanged: 0,
    unreliable: 0,
    protectedOnly: 0,
    evaluated: 0,
    notValuable: 0,
    fullyCovered: 0,
    partiallyCovered: 0,
    ungrounded: 0,
    coverageCalls: 0,
    uncoveredArtifacts: 0,
    partiallyCoveredArtifacts: 0,
    fullyCoveredArtifacts: 0,
    wouldCreate: 0,
    created: 0,
    wouldAppend: 0,
    appended: 0,
    deferred: 0,
    errors: 1,
    proposals: [],
  };
}

function recordFieldGuessPreAdmissionFailure(deps: CoreDeps, opts: SweepOpts): void {
  if (deps.recorder === undefined) return;
  try {
    deps.recorder.summaryWithContext(
      { runRef: null, trigger: opts.trigger, fn: 'field-guess-sweep' },
      'field guessing: failed before phase admission, 1 error',
      {
        ran: false,
        skipReason: 'phase_initialization_failed',
        scannedNodes: 0,
        modelCalls: 0,
        fieldsSet: 0,
        abstentions: 0,
        ledgerSkips: 0,
        missingHashSkips: 0,
        staleNodes: 0,
        deferredNodes: 0,
        providerErrors: 0,
        referenceErrors: 0,
        mutationErrors: 0,
        errors: 1,
      },
      opts.dryRun,
    );
  } catch {
    console.warn('[curator] field guess pre-admission summary failed');
  }
}

/** Journal-entry write, best-effort — requires both the recorder and the DB. */
async function writeJournalSafe(deps: CoreDeps, scope: JournalScope, label: string): Promise<void> {
  if (!deps.db || !deps.recorder) return;
  await writeJournalEntry(
    { engine: deps.engine, llm: deps.llm, config: deps.config, db: deps.db, recorder: deps.recorder, usage: deps.usage },
    scope, label,
  );
}

/** One human line for a project/topic curation's summary event. */
function wikiSummaryLine(title: string, r: CurateResult): string {
  if (r.outcome === 'error') return `${title} — ERROR: ${r.detail ?? 'unknown'}`;
  if (r.outcome === 'would_curate' || r.outcome === 'refreshed_live') return `${title} — ${r.detail ?? r.outcome}`;
  if (r.outcome !== 'written') return `${title} — skipped (${r.detail ?? 'evidence unchanged'})`;
  const topology = r.topology ?? [];
  const created = topology.filter(item => item.action === 'created').length;
  const refreshed = topology.filter(item => item.action === 'refreshed' || item.action === 'reactivated').length;
  const merged = topology.filter(item => item.action === 'merged-target').length;
  const retired = topology.filter(item => item.action === 'retired' || item.action === 'dormant').length;
  const counts = [created > 0 ? `${created} created` : '', refreshed > 0 ? `${refreshed} refreshed` : '', merged > 0 ? `${merged} merged` : '', retired > 0 ? `${retired} retired` : ''].filter(Boolean);
  return `${title} — written${counts.length > 0 ? ` (${counts.join(', ')})` : ''}`;
}

function recordTopologyActions(deps: CoreDeps, result: CurateResult): void {
  const key = result.topologyAudit?.reconcileKey ?? 'unavailable';
  const topology = result.topology ?? [];
  for (const item of topology) {
    if (item.action === 'created' || item.action === 'refreshed' || item.action === 'reactivated' || item.action === 'retired' || item.action === 'dormant') {
      const action = item.action === 'created' ? 'page-created'
        : item.action === 'reactivated' ? 'page-reactivated'
          : item.action === 'refreshed' ? 'page-refreshed' : 'page-retired';
      deps.recorder?.record({
        action, nodeId: item.node_id, target: item.title, dryRun: result.dryRun,
        detail: `${result.dryRun ? '[dry-run] would ' : ''}${action.replace('page-', '')} "${item.title}" (${item.node_id}) key=${key}`,
      });
    }
  }
  for (const target of topology.filter((item): item is Extract<NonNullable<CurateResult['topology']>[number], { action: 'merged-target' }> => item.action === 'merged-target')) {
    const sources = topology.filter((item): item is Extract<NonNullable<CurateResult['topology']>[number], { action: 'merged-source' }> => item.action === 'merged-source' && item.target_node_id === target.node_id);
    deps.recorder?.record({
      action: 'pages-merged', nodeId: target.node_id, target: target.title, dryRun: result.dryRun,
      detail: `${result.dryRun ? '[dry-run] would merge' : 'merged'} target "${target.title}" (${target.node_id}) with sources ${sources.map(source => `"${source.title}" (${source.node_id})`).join(', ')} key=${key}`,
    });
  }
}

/** Pin set, best-effort — a DB failure must never fail curation. */
async function pinnedSafe(
  deps: CoreDeps,
  projectTitle: string,
  projectId?: string | null,
  catalogEvidence?: ProjectEvidence & { readonly existing_wiki: ExistingWiki },
): Promise<Set<string>> {
  if (!deps.db) return new Set();
  let catalog: readonly WikiCatalogPage[];
  try {
    const evidence = catalogEvidence ?? await deps.engine.projectEvidence(projectId ?? projectTitle);
    const existingWiki: ExistingWiki = evidence.existing_wiki;
    catalog = existingWiki.subpages;
  } catch (err) {
    warn(`pin catalog unavailable for ${projectTitle}`, err);
    return new Set();
  }
  const pinned = new Set(catalog.filter(page => page.wiki_pinned).map(page => page.id));
  try {
    repairFulfilledRequestTargets(deps.db, projectTitle, catalog);
    for (const nodeId of pinnedPageNodeIds(deps.db, projectTitle)) pinned.add(nodeId);
  } catch (err) {
    warn(`pin set unavailable for ${projectTitle}`, err);
  }
  return pinned;
}

/** Sweeps stop starting paid wiki work once the daily budget is spent; the next sweep retries. */
async function budgetSkip(deps: CoreDeps, title: string, opts: CurateOpts): Promise<CurateResult | null> {
  const detail = await budgetSpentDetail(deps, opts);
  if (detail === null) return null;
  const result: CurateResult = { project: title, outcome: 'skipped_budget', detail, dryRun: opts.dryRun };
  recordRunSafe(deps, result, opts.trigger, 0, new Date().toISOString());
  return result;
}

/** Why a sweep may not start paid wiki work (budget spent or unreadable); null when it may. */
async function budgetSpentDetail(deps: CoreDeps, opts: CurateOpts): Promise<string | null> {
  if (!deps.budget || (opts.dryRun && !opts.preview)) return null;
  try {
    const remaining = await deps.budget.remainingUsd();
    if (remaining !== null && remaining <= 0) return 'daily budget spent; the next sweep retries';
    // The providers' own key limits (#342). Best-effort: a failed check admits the run, and
    // call admission still refuses a stopped provider.
    let keySpent: string | null = null;
    try {
      keySpent = await deps.budget.providerSpent?.() ?? null;
    } catch (error) {
      warn('provider key limit check failed', error);
    }
    return keySpent === null ? null : `${keySpent}; the next sweep retries`;
  } catch (error) {
    return budgetRefusalDetail(error);
  }
}

/** Evidence behind the current narrative; null when unknown, so the run refreshes fully. Best-effort. */
function evidenceManifestSafe(deps: CoreDeps, title: string): EvidenceManifest | null {
  if (!deps.db) return null;
  try {
    return readEvidenceManifest(deps.db, title);
  } catch (err) {
    warn(`evidence manifest unavailable for ${title}`, err);
    return null;
  }
}

/** What each sub-page was last built from (#352). Unreadable means none: those pages are
 *  synthesized in full and get a fresh record. Best-effort. */
function pageNoteStatesSafe(deps: CoreDeps, pageIds: readonly string[]): ReadonlyMap<string, PageNoteState> {
  if (!deps.db) return new Map();
  try {
    return readPageNoteStates(deps.db, pageIds);
  } catch (err) {
    warn('page note states unavailable', err);
    return new Map();
  }
}

/** The build's unsettled memory conflicts (#474 idea 4). Best effort: a failed read shows none. */
function memoryConflictsSafe(deps: CoreDeps, memoryIds: readonly number[]): ReadonlyArray<readonly [number, number]> {
  if (!deps.db) return [];
  try {
    return keptBothPairs(deps.db, memoryIds);
  } catch (err) {
    warn('memory conflicts unavailable', err);
    return [];
  }
}

/** Remember what each written sub-page was built from (`pageNoteEntries`). A lost write only
 *  costs that page a full synthesis next time. */
function recordPageNoteStatesSafe(deps: CoreDeps, title: string, result: CurateResult): void {
  const states = result.pageNoteStates;
  if (!deps.db || !states || states.written.length === 0 || !result.wikiCuratedAt) return;
  try {
    writePageNoteStates(deps.db, title, result.wikiCuratedAt, pageNoteEntries(states, readPageNoteStates(deps.db, states.rewritten)));
  } catch (err) {
    warn(`page note states not recorded for ${title}`, err);
  }
}

/** Remember the evidence a written narrative came from. A lost write only costs a full refresh later. */
function recordEvidenceManifestSafe(deps: CoreDeps, title: string, result: CurateResult): void {
  if (!deps.db || !result.evidenceComponents || !result.evidenceHash || !result.wikiCuratedAt) return;
  try {
    writeEvidenceManifest(deps.db, title, { evidenceHash: result.evidenceHash, components: result.evidenceComponents,
      curatedAt: result.wikiCuratedAt });
  } catch (err) {
    warn(`evidence manifest not recorded for ${title}`, err);
  }
}

/** The project's stage checkpoints for a real run; none for dry runs or without a curator DB. */
function stageCheckpointsFor(deps: CoreDeps, title: string, dryRun: boolean): StageCheckpointStore | undefined {
  return deps.db && !dryRun ? stageCheckpointStore(deps.db, title, warn) : undefined;
}

/** Creates the root's last written run deferred; null when none or unreadable. Best-effort. */
function deferredCreatesSafe(deps: CoreDeps, title: string): DeferredCreates | null {
  if (!deps.db) return null;
  try {
    return readDeferredCreates(deps.db, title);
  } catch (err) {
    warn(`deferred creates unavailable for ${title}`, err);
    return null;
  }
}

/** A written run replaces the root's deferred creates (none clears them). A lost write only delays pages. */
function recordDeferredCreatesSafe(deps: CoreDeps, title: string, result: CurateResult): void {
  if (!deps.db || result.outcome !== 'written' || result.dryRun || !result.evidenceHash) return;
  try {
    recordDeferredCreates(deps.db, title, { evidenceHash: result.evidenceHash, count: result.deferredCreates ?? 0 });
  } catch (err) {
    warn(`deferred creates not recorded for ${title}`, err);
  }
}

/** Scheduled, unforced runs only: the evidence hash a recent paid failure holds, while a topic's
 *  web evidence (`currentWebHash`) is still the failed run's. Best-effort. */
function failureHoldSafe(deps: CoreDeps, title: string, opts: CurateOpts, currentWebHash?: string): string | null {
  const days = deps.config.wikiFailureHoldDays ?? 7;
  if (!deps.db || opts.trigger !== 'scheduled' || opts.force || days <= 0) return null;
  try {
    return paidFailureHash(deps.db, title, new Date(Date.now() - days * 86_400_000).toISOString(), currentWebHash ?? null,
      currentOutputPolicyHash(deps));
  } catch (err) {
    warn(`failure hold unavailable for ${title}`, err);
    return null;
  }
}

/** Null when the policy can't be resolved: the run would fail on it too, so the hold stands. */
function currentOutputPolicyHash(deps: CoreDeps): string | null {
  try {
    return wikiOutputPolicyHash(resolveWikiOutputPolicy(deps.config, deps.llm));
  } catch {
    return null;
  }
}

/** Pause flag, best-effort — a DB failure must never block curation. */
function pausedSafe(deps: CoreDeps, projectTitle: string): boolean {
  if (!deps.db) return false;
  try {
    return isPaused(deps.db, projectTitle);
  } catch (err) {
    warn(`pause state unavailable for ${projectTitle}`, err);
    return false;
  }
}

/** Active correction notes for a wiki, best-effort → []. Standing — read every run. */
function correctionsSafe(deps: CoreDeps, projectTitle: string): string[] {
  if (!deps.db) return [];
  try {
    return activeCorrections(deps.db, projectTitle).map(c => c.note);
  } catch (err) {
    warn(`corrections unavailable for ${projectTitle}`, err);
    return [];
  }
}

/** Registered wiki-root row for a title, best-effort → undefined (plain project). */
/**
 * Project wikis exist only where someone asked the curator to create one. Keeps the
 * given projects that are registered (by node id, or title for renamed-safe lookup).
 * Without a curator DB there is no registry and every project passes; an unreadable
 * registry passes none.
 */
function registeredProjects(deps: CoreDeps, projects: ProjectRef[]): ProjectRef[] {
  if (!deps.db) return projects;
  try {
    const roots = projectWikiRoots(deps.db);
    // Node identity decides when both sides have one: a renamed project keeps its wiki, and a
    // new project that takes the old title does not inherit it.
    return projects.filter(p => roots.some(r => p.id !== null && r.root_node_id !== null
      ? r.root_node_id === p.id : r.root_title === p.title));
  } catch (err) {
    warn('project wiki registry unavailable', err);
    return [];
  }
}

/** A project outside the active list, looked up by exact title so a renamed, inactive project
 *  still matches its registration by node ID. Unresolved or ambiguous titles keep a null ID. */
async function inactiveProjectRef(deps: CoreDeps, title: string): Promise<ProjectRef> {
  let id: string | null = null;
  try {
    const projectType = projectTypeOf(deps.config);
    const projects = projectType === null ? []
      : (await deps.engine.findNodesByExactTitle(title, 2)).filter(node => node.types.includes(projectType));
    if (projects.length === 1) id = projects[0]!.id;
  } catch (err) {
    warn(`project lookup failed for ${title}`, err);
  }
  return { id, title, file_path: '', status: null };
}

/**
 * Wiki state is keyed by title, while a project wiki follows its project's node. Moves the wiki
 * of each renamed project (registered under its node, listed under a new title) and its
 * title-keyed state to the current title, so pauses, corrections and title-based tools keep
 * applying. Best-effort.
 */
function followProjectRenames(deps: CoreDeps, projects: readonly ProjectRef[]): void {
  if (!deps.db) return;
  try {
    const roots = projectWikiRoots(deps.db);
    for (const project of projects) {
      const row = project.id === null ? undefined
        : roots.find(r => r.root_node_id === project.id && r.root_title !== project.title);
      if (!row) continue;
      const moved = moveWikiTitle(deps.db, row.root_title, project.title);
      if (moved === 'title-in-use') warn(`wiki rename from "${row.root_title}" not followed`, `"${project.title}" is already registered`);
    }
  } catch (err) {
    warn('renamed project wikis not followed', err);
  }
}

/** Renamed projects as their wikis are still registered: dry runs read title-keyed state there
 *  instead of moving it. */
function asRegisteredTitles(deps: CoreDeps, projects: readonly ProjectRef[]): ProjectRef[] {
  if (!deps.db) return [...projects];
  try {
    const roots = projectWikiRoots(deps.db);
    return projects.map(project => {
      const row = project.id === null ? undefined
        : roots.find(r => r.root_node_id === project.id && r.root_title !== project.title);
      return row ? { ...project, title: row.root_title } : project;
    });
  } catch (err) {
    warn('renamed project wikis not resolved', err);
    return [...projects];
  }
}

/** Real runs move renamed projects' wiki state to their current titles; dry runs write nothing.
 *  Moves run in the curation queue only, so no in-flight run can write under a moved title. */
function resolveProjectRenames(deps: CoreDeps, projects: readonly ProjectRef[], dryRun: boolean): ProjectRef[] {
  if (dryRun) return asRegisteredTitles(deps, projects);
  followProjectRenames(deps, projects);
  return [...projects];
}

/** The project a title-based tool names when its wiki is still registered under an earlier title. */
async function renamedProjectRef(deps: CoreDeps, title: string): Promise<ProjectRef | null> {
  if (!deps.db || wikiRootSafe(deps, title)) return null;
  const ref = await inactiveProjectRef(deps, title);
  return ref.id === null ? null : ref;
}

/** Follows a rename named by a title-based tool, in the curation queue. */
export async function followRenamedTitle(deps: CoreDeps, title: string): Promise<void> {
  const ref = await renamedProjectRef(deps, title);
  if (ref) await deps.queue.enqueue(`follow rename: ${title}`, async () => followProjectRenames(deps, [ref]));
}

function noProjectWikiDetail(title: string): string {
  return `NO_WIKI: "${title}" has no project wiki; ask the curator to create one (create-project-wiki)`;
}

function wikiRootSafe(deps: CoreDeps, title: string): WikiRootRow | undefined {
  if (!deps.db) return undefined;
  try {
    return getWikiRoot(deps.db, title);
  } catch (err) {
    warn(`wiki root unavailable for ${title}`, err);
    return undefined;
  }
}

/** The wiki's registered evidence source — 'vault+web' only when the root row says
 *  so. Deliberately kind-agnostic: the registered source governs requested pages
 *  for any future root kind, not just 'topic' (today only topics are registered). */
function requestSource(deps: CoreDeps, title: string): 'vault' | 'vault+web' {
  return wikiRootSafe(deps, title)?.source === 'vault+web' ? 'vault+web' : 'vault';
}

/** TopicSpec from a wiki-roots row (unknown source values degrade to 'vault'). */
function topicSpecOf(row: WikiRootRow): TopicSpec {
  return { brief: row.brief ?? undefined, source: row.source === 'vault+web' ? 'vault+web' : 'vault', cadence: row.cadence };
}

function topicRefreshAssessmentBudget(cap: number): TopicRefreshAssessmentBudget {
  let consumed = 0;
  return {
    tryConsumeNovelCall(): boolean {
      if (consumed >= cap) return false;
      consumed += 1;
      return true;
    },
    remaining(): number {
      return Math.max(0, cap - consumed);
    },
  };
}

function manualTopicAdmission(force: boolean): TopicRefreshAdmission {
  return {
    admit: true,
    trigger: force ? 'manual_force' : 'manual_request',
    changedSourceNodeIds: [],
    warnings: [],
  };
}

function uniqueWarnings(
  warnings: readonly TopicRefreshAdmissionWarning[],
): TopicRefreshAdmissionWarning[] {
  return [...new Set(warnings)];
}

function canonicalProbeFromStored(
  hash: string | null | undefined,
  snapshotJson: string | null | undefined,
): CanonicalWebProbe | undefined {
  if (hash == null || snapshotJson == null) return undefined;
  const parsed = JSON.parse(snapshotJson) as { version?: unknown; results?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.results)) return undefined;
  const inputs: CanonicalWebProbeInput[] = [];
  for (const raw of parsed.results) {
    if (raw === null || typeof raw !== 'object') return undefined;
    const item = raw as Record<string, unknown>;
    if (typeof item['url'] !== 'string'
      || typeof item['title'] !== 'string'
      || typeof item['snippet'] !== 'string'
      || (typeof item['published'] !== 'string' && item['published'] !== null)) return undefined;
    inputs.push({
      url: item['url'],
      title: item['title'],
      snippet: item['snippet'],
      published: item['published'] as string | null,
    });
  }
  const built = buildCanonicalWebProbe(inputs);
  if (!built.ok || built.probe.hash !== hash || built.probe.snapshotJson !== snapshotJson) return undefined;
  return built.probe;
}

function storedAssessment(state: ReturnType<typeof topicRefreshState>): TopicWebMaterialityAssessment | undefined {
  if (state?.last_probe_verdict == null
    || state.last_probe_reason_code == null
    || state.last_probe_changed_urls_json == null) return undefined;
  const changedUrls = JSON.parse(state.last_probe_changed_urls_json) as unknown;
  if (!Array.isArray(changedUrls) || changedUrls.some(url => typeof url !== 'string')) return undefined;
  return {
    verdict: state.last_probe_verdict,
    reasonCode: state.last_probe_reason_code,
    changedUrls,
  };
}

function topicRefreshSnapshot(deps: CoreDeps, rootTitle: string): TopicRefreshStateSnapshot {
  if (deps.db === undefined) {
    return { pendingSourceChange: false, pendingBaselineRetry: false, committedSources: [] };
  }
  const state = topicRefreshState(deps.db, rootTitle);
  const byNodeId = new Map(
    [...explicitTopicRefreshSources(deps.db, rootTitle), ...observedTopicRefreshSources(deps.db, rootTitle)]
      .map(row => [row.node_id, row] as const),
  );
  const committedWebProbe = canonicalProbeFromStored(
    state?.committed_web_hash,
    state?.committed_web_snapshot_json,
  );
  const lastProbe = canonicalProbeFromStored(state?.last_probe_hash, state?.last_probe_snapshot_json);
  const lastAssessment = storedAssessment(state);
  return {
    pendingSourceChange: state?.pending_source_change === 1,
    pendingBaselineRetry: state?.pending_baseline_retry === 1,
    ...(state?.source_committed_at == null ? {} : { sourceCommittedAt: state.source_committed_at }),
    committedSources: [...byNodeId.values()],
    ...(committedWebProbe === undefined ? {} : { committedWebProbe }),
    ...(lastProbe === undefined || lastAssessment === undefined
      ? {}
      : { lastProbe: { probe: lastProbe, assessment: lastAssessment } }),
  };
}

function explicitTopicSourceIds(deps: CoreDeps, rootTitle: string): string[] {
  if (deps.db === undefined) return [];
  try {
    return explicitTopicRefreshSources(deps.db, rootTitle).map(row => row.node_id);
  } catch (error) {
    warn(`topic explicit sources unavailable for ${rootTitle}`, error);
    return [];
  }
}

/**
 * Admit a topic before pending requested pages can drain. Only scheduled
 * vault+web topics perform the early source/web pipeline; every other caller
 * returns its manual admission without early reads.
 */
async function scheduledTopicAdmissionSafe(
  deps: CoreDeps,
  root: ProjectRef,
  spec: TopicSpec,
  opts: CurateOpts,
  budget: TopicRefreshAssessmentBudget,
): Promise<RuntimeTopicAdmission> {
  if (opts.trigger !== 'scheduled' || spec.source !== 'vault+web' || opts.force) {
    return manualTopicAdmission(opts.force);
  }

  const evidence = await deps.engine.projectEvidence(root.id ?? root.title);
  const priorCuratedAt = evidence.existing_wiki.home?.wiki_curated_at ?? null;
  const cadenceDue = isCadenceDue(
    priorCuratedAt,
    parseCadence(spec.cadence, deps.config.topicWebCadenceMs),
    new Date(),
  );
  const refreshSnapshot = !cadenceDue && deps.config.topicEarlyRefreshEnabled
    ? topicRefreshSnapshot(deps, root.title)
    : undefined;
  const runRef = (opts as CurateOpts & { runRef?: string }).runRef ?? randomUUID();
  const admission = await admitTopicRefresh({
    scheduled: true,
    force: false,
    cadenceDue,
    earlyRefreshEnabled: deps.config.topicEarlyRefreshEnabled,
    persistProbeCache: !opts.dryRun,
  }, {
    loadState: () => refreshSnapshot ?? topicRefreshSnapshot(deps, root.title),
    readCommittedSources: async (sources) => ({
      results: await Promise.all(sources.map(async (source) => {
        try {
          const node = await deps.engine.getNode(source.node_id);
          const cap = source.selection_json == null ? deps.config.bodyCharCap : parseTopicSelection(source.selection_json).bodyCharCap;
          return {
            nodeId: source.node_id,
            state: 'present' as const,
            title: node.title ?? source.node_id,
            types: node.types,
            renderedBody: source.body_included === 1 ? truncate((node.body ?? '').trim(), cap) : '',
            comparableBody: source.body_included === 1 ? comparableTopicBody(node.body, cap) : '',
          };
        } catch (error) {
          if (error instanceof EngineError && error.code === 'NOT_FOUND') {
            return { nodeId: source.node_id, state: 'missing' as const };
          }
          return { nodeId: source.node_id, state: 'unavailable' as const };
        }
      })),
    }),
    probeWeb: async () => {
      const query = [root.title, spec.brief ?? ''].filter(Boolean).join(' ');
      const results = await deps.engine.webSearch(query, deps.config.webSearchResults);
      return buildCanonicalWebProbe(results.map(result => ({
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        published: result.published ?? null,
      })));
    },
    assessWeb: async (committed, current) => {
      deps.usage?.setContext({
        project: root.title,
        runRef,
        purpose: 'topic-refresh-assessment',
      });
      try {
        return (await assessTopicWebMateriality(deps.llm, {
          topic: root.title,
          ...(spec.brief === undefined ? {} : { brief: spec.brief }),
          committed,
          current,
          model: deps.config.topicEarlyRefreshAssessmentModel ?? deps.config.model,
          maxTokens: deps.config.topicEarlyRefreshAssessmentMaxTokens,
        })).assessment;
      } finally {
        deps.usage?.setContext({ project: root.title, runRef });
      }
    },
    ...(deps.db === undefined ? {} : {
      persistProbeCache: (probe: CanonicalWebProbe, assessment: TopicWebMaterialityAssessment) => {
        storeTopicProbeCache(deps.db!, {
          rootTitle: root.title,
          probe,
          assessment,
          assessedAt: new Date().toISOString(),
        });
      },
    }),
    // Plain dry runs make no model calls, so no assessment can authorize an early refresh.
    budget: opts.dryRun && !opts.preview ? topicRefreshAssessmentBudget(0) : budget,
  });
  return Object.assign(admission, {
    priorCuratedAt,
    ...(refreshSnapshot?.committedWebProbe === undefined
      ? {}
      : { committedWebHash: refreshSnapshot.committedWebProbe.hash }),
    ...(admission.webProbe === undefined ? {} : { currentWebHash: admission.webProbe.hash }),
  });
}

/** The set of paused wiki titles, loaded once for a sweep. Best-effort → empty set. */
function pausedSet(deps: CoreDeps): Set<string> {
  if (!deps.db) return new Set();
  try {
    return new Set(pausedWikis(deps.db).map(r => r.project_title));
  } catch (err) {
    warn('paused set unavailable', err);
    return new Set();
  }
}

/**
 * Fulfill one request and persist the outcome: written → fulfilled (the page
 * title becomes pinned), no-wiki → left pending (the caller runs a full
 * curation and retries). Tracked failures retain recoverable checkpoints; their
 * fulfillment and pin writes are atomic and required. Run recording is best-effort.
 */
async function fulfillOne(
  deps: CoreDeps, project: ProjectRef, row: { id: number; title: string; brief: string | null }, trigger: RunTrigger,
): Promise<RequestedPageOutcome> {
  const projectRequest = wikiRootSafe(deps, project.title)?.kind !== 'topic';
  let tracked = projectRequest && deps.config.projectHomeProvenanceEnabled;
  const store: RequestExecutionStore | undefined = projectRequest && deps.db ? {
    read: () => readRequestExecution(deps.db!, row.id),
    write: (generation, next) => writeRequestExecution(deps.db!, row.id, generation, next),
    clear: generation => clearRequestExecution(deps.db!, row.id, generation),
  } : undefined;
  const blocked = (detail: string): RequestedPageOutcome => ({ project: project.title, requestedTitle: row.title,
    qualifiedTitle: subpageTitle(project.title, row.title), outcome: 'error', detail, dryRun: false });
  try { const existing = store?.read(); tracked = tracked || !!existing; }
  catch (error) {
    if (error instanceof RequestExecutionExpiredError && deps.db && store) {
      deps.db.transaction(() => {
        markRequestFailed(deps.db!, row.id, 'REQUEST_EXECUTION_EXPIRED', new Date().toISOString());
        store.clear(error.generation);
      }).immediate();
    }
    return blocked('REQUEST_EXECUTION_UNAVAILABLE');
  }
  if (tracked && !store) return blocked('REQUEST_EXECUTION_REQUIRED');
  // Re-read inside the queue thunk: a sweep ahead of us in the lane may have
  // already drained this row. The single-lane queue makes this check
  // authoritative — without it we'd re-run synthesis and double-count cost.
  if (deps.db) {
    try {
      const fresh = getPageRequest(deps.db, row.id);
      // Removing a wiki deletes its requests; a removed request is never fulfilled.
      if (!fresh) return blocked('REQUEST_REMOVED');
      if (fresh.status !== 'pending') {
        return fresh.status === 'fulfilled'
          ? {
              project: project.title, requestedTitle: row.title,
              qualifiedTitle: fresh.page_title, outcome: 'written',
              nodeId: fresh.page_node_id ?? undefined, detail: 'already fulfilled', dryRun: false,
            }
          : {
              project: project.title, requestedTitle: row.title,
              qualifiedTitle: fresh.page_title, outcome: 'error',
              detail: fresh.error ?? 'previously failed', dryRun: false,
            };
      }
    } catch (err) {
      if (tracked) return blocked('REQUEST_EXECUTION_UNAVAILABLE');
      warn(`request ${row.id} status re-read failed`, err);
    }
  }
  const ts = new Date().toISOString();
  const t0 = Date.now();
  const spec: PageRequestSpec = { id: row.id, title: row.title, brief: row.brief ?? undefined };
  let res = await curateRequestedPage(deps.engine, deps.llm, deps.config, project, spec, false, requestSource(deps, project.title), {
    ...(store ? { store } : {}), kind: projectRequest ? 'project' : 'topic',
    // The memory pairs nothing has settled, as a full build shows them (#631).
    ...(projectRequest && deps.db ? { readConflicts: (memoryIds: readonly number[]) => memoryConflictsSafe(deps, memoryIds) } : {}),
  });
  const durationMs = Date.now() - t0;
  const db = deps.db;
  if (db && res.outcome !== 'no-wiki') {
    try {
      const persist = () => {
        if (res.outcome === 'written') {
          markRequestFulfilled(db, row.id, res.qualifiedTitle, res.nodeId ?? null, new Date().toISOString());
          if (res.nodeId !== undefined) retargetFulfilledRequests(db, project.title, res.mergedSourceNodeIds ?? [], res.nodeId, res.qualifiedTitle);
          if (tracked && store) {
            const state = store.read();
            if (!state || !('snapshot' in state) || !state.result) throw new Error('REQUEST_COMMIT_MISSING');
            store.write(state.generation, { version: 1, generation: state.generation, projectId: state.projectId,
              runRef: state.runRef, generatedAt: state.generatedAt, phase: 'committed',
              receipts: state.result.provenance_receipts, mappings: [...state.result.mappings], reconcileKey: state.result.reconcile_key });
          }
        } else if (res.budgetRefused) {
          // Nothing was dispatched: the request stays pending for the next run after the allowance resets.
        } else if (!tracked || !store?.read() || store.read()?.phase === 'failed') {
          markRequestFailed(db, row.id, res.detail ?? res.outcome, new Date().toISOString());
        }
      };
      if (tracked) db.transaction(persist).immediate(); else persist();
    } catch (err) {
      warn(`request ${row.id} not marked`, err);
      res = tracked ? { ...res, outcome: 'error', detail: 'REQUEST_BOOKKEEPING_PENDING' }
        : { ...res, detail: `${res.detail ?? 'engine operation committed'}; WARN: curator request DB update failed (${err instanceof Error ? err.message : String(err)})` };
    }
    try {
      recordRun(db, requestedPageRunRow(res, { trigger, durationMs, ts }));
    } catch (err) {
      warn(`request run not recorded for ${res.project}`, err);
    }
  }
  return res;
}

/**
 * Fulfill every pending request for a project. Runs at the top of the
 * project's full curation (inside the queue thunk). Returns how many were
 * skipped because the project has no wiki yet — the caller retries those after
 * the full run stands the wiki up.
 */
async function fulfillPendingRequests(deps: CoreDeps, project: ProjectRef, trigger: RunTrigger): Promise<number> {
  if (!deps.db) return 0;
  let rows: PageRequestRow[] = [];
  try {
    rows = pendingRequests(deps.db, project.title);
  } catch (err) {
    warn(`pending requests unavailable for ${project.title}`, err);
    return 0;
  }
  let noWiki = 0;
  for (const row of rows) {
    const res = await fulfillOne(deps, project, row, trigger);
    if (res.outcome === 'no-wiki') noWiki += 1;
  }
  return noWiki;
}

/**
 * Curate one project, timing the work inside the queue thunk (so duration_ms
 * excludes queue-wait and curateProject stays pure), then record the run. `ts`
 * is also captured at work-start, not at record-time, so the row reflects when
 * the curation ran rather than when it drained off a backlogged queue — keeping
 * lastSweepAt (catch-up source) honest under concurrent on-demand + sweep load.
 */
async function curateTimed(deps: CoreDeps, requested: ProjectRef, opts: CurateOpts, budgetSpent: string | null = null): Promise<CurateResult> {
  const { engine, llm, config, queue } = deps;
  let durationMs = 0;
  let ts = new Date().toISOString(); // overwritten at work-start inside the thunk
  const runRef = randomUUID();
  const result = await queue.enqueue(requested.title, async () => {
    // A rename is followed here, in the queue, so the title below is the one its state now lives under.
    const project = resolveProjectRenames(deps, [requested], opts.dryRun)[0]!;
    ts = new Date().toISOString();
    const t0 = Date.now();
    deps.usage?.setContext({ project: project.title, runRef });
    deps.recorder?.setContext({ runRef, trigger: opts.trigger, fn: 'wiki-curation', project: project.title });
    try {
      // remove-wiki may have run while this waited in the queue.
      if (registeredProjects(deps, [project]).length === 0) {
        return { project: project.title, outcome: 'error' as const, detail: noProjectWikiDetail(project.title), dryRun: opts.dryRun };
      }
      // Pending caller requests are fulfilled at the top of the full run, so
      // the pin set below includes them and the home write indexes them.
      const noWikiSkips = opts.dryRun || budgetSpent !== null ? 0 : await fulfillPendingRequests(deps, project, opts.trigger);
      const pinned = await pinnedSafe(deps, project.title, project.id);
      const corrections = correctionsSafe(deps, project.title);
      const status = buildStatusTracker(deps, project.title, project.id ?? project.title);
      const res = await curateProject(engine, llm, config, project, opts.dryRun, opts.force, pinned, corrections, runRef,
        config.projectHomeProvenanceEnabled && deps.db ? correctionInputs(deps.db, project.title) : undefined,
        { preview: opts.preview ?? false, failureHoldHash: failureHoldSafe(deps, project.title, opts),
          priorManifest: evidenceManifestSafe(deps, project.title), deferred: deferredCreatesSafe(deps, project.title),
          checkpoints: stageCheckpointsFor(deps, project.title, opts.dryRun),
          ...(deps.db ? { readPageNoteStates: (pageIds: readonly string[]) => pageNoteStatesSafe(deps, pageIds),
            readMemoryConflicts: (memoryIds: readonly number[]) => memoryConflictsSafe(deps, memoryIds) } : {}),
          ...(budgetSpent === null ? {} : { budgetSpent }),
          buildStatus: status.hooks });
      await status.finish(res);
      if (res.outcome === 'written' && !opts.dryRun) recordEvidenceManifestSafe(deps, project.title, res);
      if (res.outcome === 'written' && !opts.dryRun) recordPageNoteStatesSafe(deps, project.title, res);
      recordDeferredCreatesSafe(deps, project.title, res);
      recordTopologyActions(deps, res);
      // First curation just created the wiki → requests skipped for no-wiki can now fulfill.
      if (noWikiSkips > 0 && res.outcome === 'written') {
        await fulfillPendingRequests(deps, project, opts.trigger);
      }
      deps.recorder?.summary('wiki-curation', wikiSummaryLine(project.title, res),
        { outcome: res.outcome, errors: res.outcome === 'error' ? 1 : 0 }, opts.dryRun);
      return res;
    } finally {
      durationMs = Date.now() - t0;
      deps.usage?.setContext(null);
      deps.recorder?.setContext(null);
    }
  });
  const withRef: CurateResult = { ...result, runRef };
  recordRunSafe(deps, withRef, opts.trigger, durationMs, ts);
  return withRef;
}

type RuntimeTopicAdmission = TopicRefreshAdmission & {
  priorCuratedAt?: string | null;
  committedWebHash?: string;
  currentWebHash?: string;
};

function withRefreshAdmission(
  result: CurateResult,
  admission: TopicRefreshAdmission,
): CurateResult {
  return {
    ...result,
    refreshTrigger: admission.trigger,
    changedSourceNodeIds: admission.changedSourceNodeIds,
    ...(admission.webAssessment === undefined ? {} : { webAssessment: admission.webAssessment }),
    refreshWarnings: uniqueWarnings([
      ...(result.refreshWarnings ?? []),
      ...admission.warnings,
    ]),
  };
}

function topicRefreshJournalStats(result: CurateResult): Record<string, unknown> {
  if (result.refreshTrigger === undefined && result.refreshWarnings === undefined) return {};
  return {
    ...(result.refreshTrigger === undefined ? {} : { refresh_trigger: result.refreshTrigger }),
    ...(result.refreshWarnings === undefined ? {} : { refresh_warnings: result.refreshWarnings.slice(0, 8) }),
  };
}

function topicRefreshSkipDetail(
  admission: TopicRefreshAdmission,
  earlyRefreshEnabled: boolean,
): string {
  if (!earlyRefreshEnabled) return 'early refresh disabled';
  if (admission.warnings.length === 0 && admission.webAssessment === undefined) {
    return 'web probe unchanged';
  }
  return 'cadence not due';
}

async function finalizeTopicResult(
  deps: CoreDeps,
  root: ProjectRef,
  opts: CurateOpts,
  admission: TopicRefreshAdmission,
  result: CurateResult,
  scheduledRetrySupported: boolean,
): Promise<CurateResult> {
  const material = topicRefreshCommitMaterial(result);
  if (result.outcome !== 'written' || material === undefined) {
    return withRefreshAdmission(result, admission);
  }

  if (!opts.dryRun && deps.db !== undefined) {
    const committedAt = new Date().toISOString();
    if (scheduledRetrySupported) {
      try {
        armTopicRefreshBaselineRetry(deps.db, root.title);
      } catch (error) {
        warn(`topic refresh retry not armed for ${root.title}`, error);
        return {
          ...withRefreshAdmission(result, admission),
          outcome: 'error',
          detail: 'wiki content committed but refresh retry state did not; manual recovery required',
          refreshWarnings: uniqueWarnings([
            ...admission.warnings,
            'refresh_state_persist_failed',
          ]),
        };
      }
    }
    try {
      commitTopicRefreshBaseline(deps.db, {
        rootTitle: root.title,
        sourceProjections: material.sourceProjections,
        observedSourceNodeIds: material.observedSourceNodeIds,
        sourceCommittedAt: committedAt,
        ...(material.webProbe === undefined
          ? {}
          : { webProbe: material.webProbe, webCommittedAt: committedAt }),
      });
    } catch (error) {
      warn(`topic refresh baseline not committed for ${root.title}`, error);
      const failed: CurateResult = {
        ...withRefreshAdmission(result, admission),
        outcome: 'error',
        detail: 'wiki content committed but refresh state did not; scheduled retry remains pending',
        refreshWarnings: uniqueWarnings([
          ...admission.warnings,
          'refresh_state_persist_failed',
        ]),
      };
      return failed;
    }
  }

  let memories = result.memories;
  if (material.persistMemories !== undefined) {
    try {
      const persisted = await material.persistMemories();
      if (persisted.length > 0) memories = persisted;
    } catch (error) {
      warn(`topic memory persistence failed for ${root.title}`, error);
    }
  }
  return withRefreshAdmission({
    ...result,
    ...(memories === undefined ? {} : { memories }),
  }, admission);
}

/** Curate one topic wiki while already holding the single queue lane. */
async function curateTopicInLane(
  deps: CoreDeps,
  root: ProjectRef,
  spec: TopicSpec,
  opts: CurateOpts,
  budget: TopicRefreshAssessmentBudget = topicRefreshAssessmentBudget(
    deps.config.topicEarlyRefreshAssessmentCap,
  ),
  catalogEvidence?: ProjectEvidence & { readonly existing_wiki: ExistingWiki },
): Promise<CurateResult> {
  const { engine, llm, config } = deps;
  let durationMs = 0;
  const ts = new Date().toISOString();
  const runRef = randomUUID();
  let refreshEvidence: NonNullable<RunContext['refreshEvidence']> | undefined;
  const result = await (async () => {
    const t0 = Date.now();
    deps.usage?.setContext({ project: root.title, runRef });
    deps.recorder?.setContext({ runRef, trigger: opts.trigger, fn: 'topic-curation', project: root.title });
    try {
      let admission: RuntimeTopicAdmission;
      try {
        admission = await scheduledTopicAdmissionSafe(
          deps,
          root,
          spec,
          Object.assign({}, opts, { runRef }),
          budget,
        );
        if (admission.committedWebHash !== undefined || admission.currentWebHash !== undefined) {
          refreshEvidence = {
            ...(admission.committedWebHash === undefined
              ? {}
              : { committedWebHash: admission.committedWebHash }),
            ...(admission.currentWebHash === undefined
              ? {}
              : { currentWebHash: admission.currentWebHash }),
          };
        }
      } catch (error) {
        warn(`topic cadence preflight unavailable for ${root.title}`, error);
        const failed: CurateResult = {
          project: root.title,
          outcome: 'error',
          detail: `cadence admission: ${error instanceof Error ? error.message : String(error)}`,
          dryRun: opts.dryRun,
        };
        deps.recorder?.summary('topic-curation', wikiSummaryLine(root.title, failed),
          { outcome: failed.outcome, errors: 1 }, opts.dryRun);
        return failed;
      }
      if (!admission.admit) {
        const notDue = withRefreshAdmission({
          project: root.title,
          outcome: 'skipped_cadence_not_due',
          detail: topicRefreshSkipDetail(admission, deps.config.topicEarlyRefreshEnabled),
          dryRun: opts.dryRun,
          wikiCuratedAt: admission.priorCuratedAt ?? null,
        }, admission);
        deps.recorder?.summary('topic-curation', wikiSummaryLine(root.title, notDue),
          { outcome: notDue.outcome, errors: 0, ...topicRefreshJournalStats(notDue) }, opts.dryRun);
        return notDue;
      }
      // Pending caller requests drain here exactly as in curateTimed, so a
      // next-run request against a topic wiki is fulfilled and pinned before
      // the full topic write indexes it.
      const noWikiSkips = opts.dryRun ? 0 : await fulfillPendingRequests(deps, root, opts.trigger);
      const pinned = await pinnedSafe(deps, root.title, root.id, catalogEvidence);
      const corrections = correctionsSafe(deps, root.title);
      const status = buildStatusTracker(deps, root.title, root.id ?? root.title);
      const raw = await curateTopic(engine, llm, config, root, spec, {
        dryRun: opts.dryRun,
        preview: opts.preview ?? false,
        failureHoldHash: failureHoldSafe(deps, root.title, opts, admission.currentWebHash),
        deferred: deferredCreatesSafe(deps, root.title),
        force: opts.force,
        pinnedNodeIds: pinned,
        corrections,
        runRef,
        scheduled: opts.trigger === 'scheduled',
        admission,
        explicitSourceNodeIds: explicitTopicSourceIds(deps, root.title),
        prioritySourceNodeIds: admission.changedSourceNodeIds,
        buildStatus: status.hooks,
      });
      const res = await finalizeTopicResult(
        deps,
        root,
        opts,
        admission,
        raw,
        spec.source === 'vault+web',
      );
      await status.finish(res);
      recordDeferredCreatesSafe(deps, root.title, res);
      recordTopologyActions(deps, res);
      // First curation just created the wiki → requests skipped for no-wiki can now fulfill.
      if (noWikiSkips > 0 && res.outcome === 'written') {
        await fulfillPendingRequests(deps, root, opts.trigger);
      }
      deps.recorder?.summary('topic-curation', wikiSummaryLine(root.title, res),
        {
          outcome: res.outcome,
          errors: res.outcome === 'error' ? 1 : 0,
          ...topicRefreshJournalStats(res),
        }, opts.dryRun);
      return res;
    } finally {
      durationMs = Date.now() - t0;
      deps.usage?.setContext(null);
      deps.recorder?.setContext(null);
    }
  })();
  const withRef: CurateResult = { ...result, runRef };
  recordRunSafe(deps, withRef, opts.trigger, durationMs, ts, refreshEvidence);
  return withRef;
}

/** Curate one topic wiki through the queue, timed + recorded (sibling of curateTimed). */
export function curateTopicTimed(
  deps: CoreDeps,
  root: ProjectRef,
  spec: TopicSpec,
  opts: CurateOpts,
  budget: TopicRefreshAssessmentBudget = topicRefreshAssessmentBudget(
    deps.config.topicEarlyRefreshAssessmentCap,
  ),
  catalogEvidence?: ProjectEvidence & { readonly existing_wiki: ExistingWiki },
): Promise<CurateResult> {
  return deps.queue.enqueue(
    root.title,
    () => curateTopicInLane(deps, root, spec, opts, budget, catalogEvidence),
  );
}

export interface CreateOrUpdateWikiArgs {
  topic: string;
  brief?: string;
  source?: 'vault' | 'vault+web';
  cadence?: string | null;
  source_node_ids?: string[];
  /** Added to the sources the wiki has when the call runs (on a create, its first sources). Not with source_node_ids. */
  add_source_node_ids?: string[];
  /** Create only: register the new wiki paused (true) or not (false). Its first build still runs.
   *  Given for a topic that already has a wiki, the call is refused, so a create never updates one. */
  paused?: boolean;
  by?: string | null;
}
export interface CreateOrUpdateWikiResponse {
  ok: boolean;
  topic?: string;
  root_node_id?: string | null;
  /** The build's outcome when the call awaited it (no build queue). The server queues the build instead and
   *  answers "queued", or "in_progress" when a build of the wiki is already queued. */
  outcome?: CurateResult['outcome'] | 'queued' | 'in_progress';
  /** Whether this call brought a NEW wiki into existence (vs. updated one that
   *  already existed). Explicit because "created a second wiki by accident" and
   *  "updated the wiki you meant" otherwise look identical in the response. */
  created?: boolean;
  /** Whether the wiki is paused after this call: a paused wiki changes only on request. */
  paused?: boolean;
  detail?: string;
  error?: { code: string; message: string };
}

/** The engine names a wiki home page `<topic> Wiki` (see wiki-write). */
const WIKI_PAGE_SUFFIX = ' Wiki';
export const MAX_EXPLICIT_SOURCE_NODE_IDS = 20;

type SourceNodeValidation =
  | { ok: true; catalogEvidence?: ProjectEvidence & { readonly existing_wiki: ExistingWiki } }
  | { ok: false; code: 'INVALID_SOURCE_NODE' | 'SELF_SOURCE_NODE' | 'CREATE_FAILED'; message: string };

function normalizeSourceNodeIds(
  value: string[] | undefined,
): { ok: true; nodeIds: string[] | undefined } | {
  ok: false;
  code: 'INVALID_SOURCE_NODE' | 'TOO_MANY_SOURCE_NODES';
  message: string;
} {
  if (value === undefined) return { ok: true, nodeIds: undefined };
  const nodeIds = [...new Set(value.map(id => id.trim()))];
  if (nodeIds.some(id => id.length === 0)) {
    return {
      ok: false,
      code: 'INVALID_SOURCE_NODE',
      message: 'source_node_ids must contain only non-blank stable Engine node IDs',
    };
  }
  if (nodeIds.length > MAX_EXPLICIT_SOURCE_NODE_IDS) {
    return {
      ok: false,
      code: 'TOO_MANY_SOURCE_NODES',
      message: `source_node_ids may contain at most ${MAX_EXPLICIT_SOURCE_NODE_IDS} unique IDs`,
    };
  }
  return { ok: true, nodeIds };
}

function catalogForbiddenSourceIds(
  value: unknown,
  rootNodeId: string,
): Set<string> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const existingWiki = (value as { existing_wiki?: unknown }).existing_wiki;
  if (existingWiki === null || typeof existingWiki !== 'object') return undefined;
  const homeId = (existingWiki as { home_id?: unknown }).home_id;
  const subpages = (existingWiki as { subpages?: unknown }).subpages;
  if ((homeId !== null && typeof homeId !== 'string') || !Array.isArray(subpages)) return undefined;
  const forbidden = new Set([rootNodeId]);
  if (typeof homeId === 'string') forbidden.add(homeId);
  for (const subpage of subpages) {
    if (subpage === null || typeof subpage !== 'object'
      || typeof (subpage as { id?: unknown }).id !== 'string') return undefined;
    forbidden.add((subpage as { id: string }).id);
  }
  return forbidden;
}

async function validateSourceNodeIds(
  engine: Engine,
  nodeIds: readonly string[],
  rootNodeId?: string,
  catalogEvidence?: unknown,
): Promise<SourceNodeValidation> {
  let validationUnavailable = false;
  let forbidden = new Set<string>();
  let resolvedCatalogEvidence: unknown;
  if (rootNodeId !== undefined) {
    try {
      resolvedCatalogEvidence = catalogEvidence ?? await engine.projectEvidence(rootNodeId);
      const catalogIds = catalogForbiddenSourceIds(resolvedCatalogEvidence, rootNodeId);
      if (catalogIds === undefined) validationUnavailable = true;
      else forbidden = catalogIds;
    } catch {
      validationUnavailable = true;
    }
  }

  let hasInvalidNode = false;
  let hasSelfSource = false;
  for (const nodeId of nodeIds) {
    if (forbidden.has(nodeId)) hasSelfSource = true;
    try {
      const node = await engine.getNode(nodeId, { includeEmbeds: false });
      if (node === null || typeof node !== 'object' || node.id !== nodeId) {
        validationUnavailable = true;
      }
    } catch (error) {
      if (error instanceof EngineError && error.code === 'NOT_FOUND') hasInvalidNode = true;
      else validationUnavailable = true;
    }
  }

  if (validationUnavailable) {
    return {
      ok: false,
      code: 'CREATE_FAILED',
      message: 'Could not validate source_node_ids against Engine; no source membership was changed',
    };
  }
  if (hasSelfSource) {
    return {
      ok: false,
      code: 'SELF_SOURCE_NODE',
      message: 'source_node_ids cannot include the topic root, wiki home, or managed wiki subpages',
    };
  }
  if (hasInvalidNode) {
    return {
      ok: false,
      code: 'INVALID_SOURCE_NODE',
      message: 'One or more source_node_ids do not identify an existing Engine node',
    };
  }
  return resolvedCatalogEvidence === undefined
    ? { ok: true }
    : {
        ok: true,
        catalogEvidence: resolvedCatalogEvidence as ProjectEvidence & { readonly existing_wiki: ExistingWiki },
      };
}

/**
 * Detect the one caller mistake that silently duplicates a wiki: passing a wiki
 * *page* title where a *topic* title belongs. A caller looking at "Orbital Builder Redux
 * Wiki" and asked to change "this wiki" naturally sends that page title — which,
 * unguarded, stands up a second wiki whose own home page is "Orbital Builder Redux Wiki
 * Wiki" and whose topic node title collides with the first wiki's home page.
 *
 * Returns the title of the wiki the caller almost certainly meant, or null.
 * Registry hit is local and free; the active-project lookup only runs for a title
 * that already looks suspicious, so normal calls pay nothing.
 */
export async function wikiPageTitleOwner(deps: CoreDeps, topic: string): Promise<string | null> {
  if (!topic.endsWith(WIKI_PAGE_SUFFIX)) return null;
  const base = topic.slice(0, -WIKI_PAGE_SUFFIX.length).trim();
  if (!base) return null;
  if (deps.db && getWikiRoot(deps.db, base)) return base;
  const projects = await deps.engine.listActiveProjects(deps.config.activeStatuses, deps.config.projectType, deps.config.projectStatusField);
  return projects.some(p => p.title === base) ? base : null;
}

/** The refusal code and message for a new topic wiki when the vault map's topic kind is none. */
export const TOPIC_WIKIS_OFF = 'TOPIC_WIKIS_OFF';
export const TOPIC_WIKIS_OFF_MESSAGE = 'Topic wikis are off: topicType is none in Settings/Vault.md. '
  + 'Name the kind topic notes take to create a topic wiki; topic wikis that already exist keep working.';

/**
 * Stand up — or update — a vault-grounded topic wiki, idempotent on the topic
 * title. New topic: ensure the topic schema, create (or reuse) the
 * <topic> node (in topicDir, else the topic type's folder), register it in wiki_roots, and run an initial curation
 * (forced, so the first build always happens). Existing topic: omitted fields
 * keep their stored values ('' explicitly clears); a brief, source mode, or
 * explicit source-membership change re-curates, while a cadence-only change
 * just updates the registry — scheduled sweeps use it while wikiReconciliationMode
 * is live, no LLM run.
 */
async function createOrUpdateWikiInLane(
  deps: CoreDeps,
  db: Database.Database,
  args: CreateOrUpdateWikiArgs,
  sourceNodeIds: string[] | undefined,
  explicitCadence: string | null | undefined,
  addSourceNodeIds?: string[],
): Promise<CreateOrUpdateWikiResponse> {
  const { engine } = deps;
  try {
    const existing = getWikiRoot(db, args.topic);
    if (existing && existing.kind !== 'topic') {
      return { ok: false, error: { code: 'WIKI_IS_A_PROJECT', message:
        `"${args.topic}" is a project wiki, not a topic; manage it with create-project-wiki and remove-wiki.` } };
    }
    if (existing && args.paused !== undefined) {
      return { ok: false, error: { code: 'WIKI_EXISTS', message:
        `"${args.topic}" already has a wiki, and paused applies only when creating one; nothing was changed. `
        + 'To add sources or change its settings, re-call without paused. To pause or resume it, use set-wiki-paused.' } };
    }
    // A new topic wiki gets a topic note of the vault map's topic kind; with no topic kind
    // (none) it can't be made. A registered topic wiki keeps its note and stays editable.
    const topicType = vaultOf(deps.config).topicType;
    if (topicType === null && !existing?.root_node_id) {
      return { ok: false, error: { code: TOPIC_WIKIS_OFF, message: TOPIC_WIKIS_OFF_MESSAGE } };
    }
    // Create path only — a root that is already registered stays editable under
    // whatever it is called, including a name the guard would refuse today.
    if (!existing) {
      const owner = await wikiPageTitleOwner(deps, args.topic);
      if (owner) {
        return { ok: false, error: { code: 'TOPIC_IS_A_WIKI_PAGE', message:
          `"${args.topic}" is the wiki page of "${owner}", not a topic of its own — creating it would stand up a second wiki. ` +
          `To change that wiki's settings, re-call with topic: "${owner}". To create a genuinely separate wiki, give it a name that is not "<existing topic> Wiki".` } };
      }
    }
    // Additions apply to the sources as they are now, in the lane, so two adds from proposals made
    // before either was confirmed both stay. Only the new ids are validated.
    let validateIds = sourceNodeIds;
    if (addSourceNodeIds !== undefined) {
      const current = existing ? explicitTopicRefreshSources(db, args.topic).map(row => row.node_id) : [];
      const added = addSourceNodeIds.filter(id => !current.includes(id));
      if (current.length + added.length > MAX_EXPLICIT_SOURCE_NODE_IDS) {
        return { ok: false, error: { code: 'TOO_MANY_SOURCE_NODES', message:
          `"${args.topic}" has ${current.length} sources; adding ${added.length} would pass the maximum of ${MAX_EXPLICIT_SOURCE_NODE_IDS}. Nothing was changed.` } };
      }
      sourceNodeIds = [...current, ...added];
      validateIds = added;
    }
    const source = args.source ?? (existing?.source as 'vault' | 'vault+web' | undefined) ?? 'vault';
    const cadence = explicitCadence !== undefined ? explicitCadence : (existing?.cadence ?? null);
    const brief = args.brief !== undefined ? (args.brief.trim() || null) : (existing?.brief ?? null);
    const preRef = randomUUID();
    let rootNodeId = existing?.root_node_id ?? null;
    let validatedCatalogEvidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki } | undefined;
    const isNew = rootNodeId == null;
    if (validateIds !== undefined && validateIds.length > 0) {
      const validation = await validateSourceNodeIds(
        engine,
        validateIds,
        rootNodeId ?? undefined,
      );
      if (!validation.ok) {
        return { ok: false, error: { code: validation.code, message: validation.message } };
      }
      validatedCatalogEvidence = validation.catalogEvidence;
    }

    const topicDir = deps.config.topicDir ?? undefined;
    if (topicType !== null) await engine.ensureTopicSchema(topicType, topicDir);
    deps.recorder?.setContext({ runRef: preRef, trigger: 'on-demand', fn: 'topic-curation', project: args.topic });
    try {
      if (!rootNodeId) {
        if (topicType === null) throw new Error(TOPIC_WIKIS_OFF_MESSAGE); // refused above
        try {
          const node = await engine.createNode({ title: args.topic, types: [topicType], fields: {}, body: '',
            ...(topicDir === undefined ? {} : { directory: topicDir }) });
          rootNodeId = node.node_id;
        } catch (err) {
          // The topic node may already exist in the vault even when our registry lost
          // the row (e.g. a .state DB wipe). Resolve and reuse it rather than failing.
          if (err instanceof EngineError && /exist/i.test(err instanceof Error ? err.message : String(err))) {
            const ev = await engine.projectEvidence(args.topic);
            rootNodeId = ev.project.id;
            if (sourceNodeIds !== undefined && sourceNodeIds.length > 0) {
              const forbidden = catalogForbiddenSourceIds(ev, rootNodeId);
              if (forbidden === undefined) {
                return { ok: false, error: {
                  code: 'CREATE_FAILED',
                  message: 'Could not validate source_node_ids against Engine; no source membership was changed',
                } };
              }
              if (sourceNodeIds.some(nodeId => forbidden.has(nodeId))) {
                return { ok: false, error: {
                  code: 'SELF_SOURCE_NODE',
                  message: 'source_node_ids cannot include the topic root, wiki home, or managed wiki subpages',
                } };
              }
              validatedCatalogEvidence = ev;
            }
          } else {
            throw err;
          }
        }
      }

      let sourceMembershipChanged = false;
      db.transaction(() => {
        const registeredAt = new Date().toISOString();
        registerWikiRoot(db, {
          root_title: args.topic, root_node_id: rootNodeId, kind: 'topic', source,
          cadence, brief,
          created_at: registeredAt, created_by: args.by ?? null,
        });
        // In the same transaction, so a sweep never sees a wiki created paused as unpaused.
        if (args.paused !== undefined) setPaused(db, args.topic, args.paused, args.by ?? null, registeredAt);
        if (sourceNodeIds !== undefined) {
          sourceMembershipChanged = replaceExplicitTopicRefreshSources(
            db,
            args.topic,
            sourceNodeIds,
          ).changed;
        }
      })();

      // Only brief/source/source membership affect synthesis; a cadence-only
      // change (or a pure no-op) updates the registry without an LLM run.
      // Only a live sweep reads the cadence, so none is promised otherwise (#544).
      if (!isNew && existing != null && source === existing.source
        && brief === (existing.brief ?? null) && !sourceMembershipChanged) {
        const cadenceUsed = 'cadence updated; scheduled sweeps use it while curator-status shows wiki_reconciliation_mode "live"';
        const detail = sourceNodeIds === undefined
          ? (cadence === (existing.cadence ?? null)
              ? 'no changes'
              : cadenceUsed)
          : (cadence === (existing.cadence ?? null)
              ? 'no changes; explicit sources unchanged'
              : `${cadenceUsed}; explicit sources unchanged`);
        await writeJournalSafe(deps, { kind: 'run-refs', runRefs: [preRef] }, `on-demand: ${args.topic}`);
        return { ok: true, topic: args.topic, root_node_id: rootNodeId, outcome: 'skipped', created: false, detail };
      }

      // The server queues the build and replies at once: a build with web research runs for minutes,
      // longer than callers wait (#284, #387). Without a build queue (tests) it is awaited below.
      if (deps.builds) {
        await writeJournalSafe(deps, { kind: 'run-refs', runRefs: [preRef] }, `on-demand: ${args.topic}`);
        return queueTopicBuild(deps, deps.builds, args.topic, rootNodeId, existing == null, sourceMembershipChanged);
      }
      const root: ProjectRef = { id: rootNodeId, title: args.topic, file_path: '', status: null };
      const spec: TopicSpec = { brief: brief ?? undefined, source, cadence };
      let result: CurateResult;
      try {
        result = await curateTopicInLane(
          deps,
          root,
          spec,
          { dryRun: false, force: true, trigger: 'on-demand' },
          undefined,
          validatedCatalogEvidence,
        );
      } catch (error) {
        if (!sourceMembershipChanged) throw error;
        await writeJournalSafe(deps, { kind: 'run-refs', runRefs: [preRef] }, `on-demand: ${args.topic}`);
        const created = existing == null;
        const detail = 'explicit sources updated; curation failed and source change remains pending';
        return {
          ok: true,
          topic: args.topic,
          root_node_id: rootNodeId,
          outcome: 'error',
          created,
          detail: created ? `new wiki "${args.topic}" registered — ${detail}` : detail,
        };
      }
      await writeJournalSafe(
        deps,
        { kind: 'run-refs', runRefs: [preRef, ...(result.runRef ? [result.runRef] : [])] },
        `on-demand: ${args.topic}`,
      );
      const created = existing == null;
      let detail = result.detail;
      if (sourceMembershipChanged) {
        const pending = topicRefreshState(db, args.topic)?.pending_source_change === 1;
        detail = result.outcome === 'written' && !pending
          ? 'explicit sources updated; curation written'
          : 'explicit sources updated; curation failed and source change remains pending';
      } else if (sourceNodeIds !== undefined) {
        detail = result.outcome === 'written'
          ? 'explicit sources unchanged; curation written'
          : `explicit sources unchanged; curation outcome ${result.outcome}`;
      }
      return {
        ok: true, topic: args.topic, root_node_id: rootNodeId, outcome: result.outcome, created,
        detail: created ? `new wiki "${args.topic}" registered — ${detail ?? result.outcome}` : detail,
      };
    } finally {
      deps.recorder?.setContext(null);
    }
  } catch (err) {
    return { ok: false, error: { code: 'CREATE_FAILED', message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * create-or-update-wiki's server path: queue the topic's build behind this call, in the one lane, and
 * reply at once. The build reads the wiki's settings and sources when it starts, so a change made while
 * it waits is built too, and a second call while it waits reports it instead of queueing another.
 * Forced, as the awaited build is: a create always gets its first build, even paused.
 */
function queueTopicBuild(deps: CoreDeps, builds: BackgroundBuilds, topic: string,
  rootNodeId: string | null, created: boolean, sourcesChanged: boolean): CreateOrUpdateWikiResponse {
  const queued = startTopicBuild(deps, builds, topic, rootNodeId, { dryRun: false, force: true, trigger: 'on-demand' });
  const done = created ? `new wiki "${topic}" registered` : sourcesChanged ? 'explicit sources updated' : 'settings updated';
  const what = created ? 'its first build' : 'its rebuild';
  const detail = queued.started
    ? `${done}; ${what} is queued. ${TOPIC_QUEUED_NOTE}`
    : `${done}; a build of "${topic}" is already queued (at ${queued.build.since}) and builds the wiki as it is when it starts, `
      + 'so this change is included. Not starting another. curator-status with project shows the outcome.';
  return { ok: true, topic, root_node_id: rootNodeId, outcome: queued.started ? 'queued' : 'in_progress', created, detail };
}

/** Plain-language status for a topic build a call queued instead of running. */
const TOPIC_QUEUED_NOTE = 'It usually finishes within a few minutes, longer with web research, but it does not run if today\'s '
  + 'spend cap is reached. Do not call again to check: curator-status with project shows the outcome.';

/**
 * Queue one topic wiki's build behind the caller's reply. The one queued path for a topic wiki's
 * on-demand build: create-or-update-wiki's (#387) and curate-project-wiki's (#425) share its in-flight
 * keys (the title and the root node id), so a create or update build and a rebuild of one wiki are
 * never both queued.
 */
function startTopicBuild(deps: CoreDeps, builds: BackgroundBuilds, topic: string, rootNodeId: string | null,
  opts: CurateOpts): { started: boolean; build: InFlightBuild } {
  return builds.start(projectBuildKeys(topic, rootNodeId), `build of ${topic}`, rootNodeId,
    recordingFailure(deps, topic, opts.trigger, () => curateTopicOnDemand(deps, topic, opts)),
    recordingInterruption(deps, topic, opts.trigger));
}

/**
 * Curate one topic wiki on request: the sweep's topic curation, through the queue. Its registration
 * is read again in the lane, so settings changed while the call waited are used, and a wiki removed
 * meanwhile isn't built (that run is recorded, so curator-status says why). Pause is decided by the
 * caller, before the queue; the run leaves it as it was. A live run gets its journal entry.
 */
async function curateTopicOnDemand(deps: CoreDeps, title: string, opts: CurateOpts): Promise<CurateResult> {
  const result = await deps.queue.enqueue(title, async () => {
    const row = wikiRootSafe(deps, title);
    if (row?.kind === 'topic') {
      return curateTopicInLane(deps, { id: row.root_node_id, title: row.root_title, file_path: '', status: null }, topicSpecOf(row), opts);
    }
    // An error, as for a project wiki removed while its build waited: a skip would be recorded without its reason.
    const removed: CurateResult = { project: title, outcome: 'error', detail: `"${title}" was removed before its build started`, dryRun: opts.dryRun };
    if (!opts.dryRun) recordRunSafe(deps, removed, opts.trigger, 0, new Date().toISOString());
    return removed;
  });
  if (!opts.dryRun) {
    await writeJournalSafe(deps, { kind: 'run-refs', runRefs: result.runRef ? [result.runRef] : [] },
      `${opts.trigger === 'cli' ? 'CLI' : 'on-demand'}: ${title}`);
  }
  return result;
}

export async function createOrUpdateWiki(
  deps: CoreDeps,
  args: CreateOrUpdateWikiArgs,
): Promise<CreateOrUpdateWikiResponse> {
  const { db } = deps;
  if (!db) return { ok: false, error: { code: 'NO_DB', message: 'create-or-update-wiki requires the curator DB (server mode)' } };
  if (args.source_node_ids !== undefined && args.add_source_node_ids !== undefined) {
    return { ok: false, error: { code: 'INVALID_SOURCE_NODE', message:
      'Pass source_node_ids to replace the sources or add_source_node_ids to add to them, not both.' } };
  }
  const normalizedSources = normalizeSourceNodeIds(args.source_node_ids);
  if (!normalizedSources.ok) {
    return { ok: false, error: { code: normalizedSources.code, message: normalizedSources.message } };
  }
  const normalizedAdds = normalizeSourceNodeIds(args.add_source_node_ids);
  if (!normalizedAdds.ok) {
    return { ok: false, error: { code: normalizedAdds.code, message: normalizedAdds.message } };
  }
  // undefined = keep the stored value on an existing topic; '' (or null) = clear.
  const explicitCadence = args.cadence !== undefined ? (args.cadence?.trim() || null) : undefined;
  if (explicitCadence != null) {
    try { parseCadence(explicitCadence, 0); }
    catch (err) { return { ok: false, error: { code: 'INVALID_CADENCE', message: err instanceof Error ? err.message : String(err) } }; }
  }
  const res = await deps.queue.enqueue(
    args.topic,
    () => createOrUpdateWikiInLane(
      deps,
      db,
      args,
      normalizedSources.nodeIds,
      explicitCadence,
      normalizedAdds.nodeIds,
    ),
  );
  return res.ok && res.topic !== undefined ? { ...res, paused: pausedSafe(deps, res.topic) } : res;
}

export interface RemoveWikiArgs { topic: string; }
export interface RemoveWikiResponse {
  ok: boolean;
  topic?: string;
  removed?: boolean;
  cleared?: { paused: number; corrections: number; page_requests: number };
  /** Wiki pages this leaves in the vault — deregistering never deletes notes. */
  pages_left_behind?: string[];
  /** Project wikis only: whether `wiki: true` was removed from the project note, so the
   *  wiki-field check doesn't register the wiki again (#385). */
  wiki_field?: WikiFieldClear['outcome'];
  detail?: string;
  error?: { code: string; message: string };
}

/**
 * Deregister a topic wiki: the sweep stops curating it and all title-keyed state
 * (pause flag, corrections, page requests) goes with it, in one transaction. The
 * vault pages are deliberately left alone — the curator does not delete a user's
 * notes on a caller's word; the response names what remains so the caller can.
 * An unregistered title is an error, never a silent no-op.
 */
/** A registered wiki's sub-page titles from Engine's catalog, whatever they are named; null when unreadable. */
async function wikiSubpageTitles(deps: CoreDeps, root: WikiRootRow): Promise<string[] | null> {
  try {
    const evidence = await deps.engine.projectEvidence(root.root_node_id ?? root.root_title);
    return evidence.existing_wiki.subpages.map(page => page.title);
  } catch (err) {
    warn(`wiki catalog unavailable for ${root.root_title}`, err);
    return null;
  }
}

/** Removes `<field>: true` (the vault map's `wikiFlagField`) from a deregistered project's note
 *  (#385). Runs in removeWiki's queue slot, so the journal context it sets can't mix with a curation's. */
async function clearProjectWikiField(deps: CoreDeps, root: WikiRootRow, field: string): Promise<WikiFieldClear> {
  if (root.root_node_id === null) return { outcome: 'not_cleared', reason: 'the registration has no project node id' };
  deps.recorder?.setContext({ runRef: randomUUID(), trigger: 'on-demand', fn: 'wiki-field' });
  try {
    return await clearWikiField(deps.engine, root.root_node_id, root.root_title, field);
  } finally {
    deps.recorder?.setContext(null);
  }
}

function wikiFieldDetail(clear: WikiFieldClear, field: string): string {
  if (clear.outcome === 'cleared') return `. Removed ${field}: true from the project note, so the Curator won't register the wiki again`;
  if (clear.outcome === 'not_set') return '';
  return `. Could not check or remove ${field}: true on the project note (${clear.reason}); if the note has it, `
    + 'the Curator registers this wiki again within about 15 minutes, so remove the field yourself';
}

export async function removeWiki(deps: CoreDeps, args: RemoveWikiArgs): Promise<RemoveWikiResponse> {
  const { db } = deps;
  if (!db) return { ok: false, error: { code: 'NO_DB', message: 'remove-wiki requires the curator DB (server mode)' } };
  // The wiki request field; none (null) means nothing asks for a wiki, so there is none to clear.
  const flagField = vaultOf(deps.config).wikiFlagField;
  return deps.queue.enqueue(args.topic, async () => {
    let wikiField: WikiFieldClear | null = null;
    try {
      const renamed = await renamedProjectRef(deps, args.topic);
      if (renamed) followProjectRenames(deps, [renamed]);
      const root = getWikiRoot(db, args.topic);
      if (!root) {
        return { ok: false, error: { code: 'NOT_REGISTERED', message:
          `No wiki is registered as "${args.topic}" — check the exact topic titles under wikis in curator-status.` } };
      }
      const subpages = await wikiSubpageTitles(deps, root);
      // Cleared before deregistering: a wiki-field check reads the registry before the notes,
      // so one that sees this wiki gone also sees the field gone and doesn't register it again.
      wikiField = root.kind === 'project' && flagField !== null ? await clearProjectWikiField(deps, root, flagField) : null;
      const outcome = db.transaction(() => {
        const removed = deleteWikiRoot(db, args.topic);
        const control = clearWikiControl(db, args.topic);
        const pageRequests = deletePageRequests(db, args.topic);
        deleteTopicRefreshState(db, args.topic);
        deleteEvidenceManifest(db, args.topic);
        deletePageNoteStates(db, args.topic);
        deleteDeferredCreates(db, args.topic);
        deleteStageCheckpoint(db, args.topic);
        return { removed, cleared: { ...control, page_requests: pageRequests } };
      })();
      const home = `${args.topic}${WIKI_PAGE_SUFFIX}`;
      const pages = subpages === null
        ? `deregistered — the vault keeps "${home}" and any "${args.topic} — …" sub-pages; delete those yourself if you want them gone`
        : `deregistered — the vault keeps the ${subpages.length + 1} wiki page(s) in pages_left_behind; delete those yourself if you want them gone`;
      return {
        ok: true, topic: args.topic, ...outcome,
        pages_left_behind: [home, ...(subpages ?? [])],
        ...(wikiField ? { wiki_field: wikiField.outcome } : {}),
        detail: `${pages}${wikiField && flagField !== null ? wikiFieldDetail(wikiField, flagField) : ''}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'REMOVE_FAILED', message: wikiField?.outcome === 'cleared'
        ? `${message}. The wiki is still registered, but ${flagField}: true was already removed from the project note` : message } };
    }
  });
}

export interface CreateProjectWikiArgs {
  /** Project note title (or node id). */
  readonly project: string;
  readonly dryRun: boolean;
  readonly by?: string | null;
  /** Asked again in the queued registration step, with the project's node id: false answers
   *  NO_LONGER_REQUESTED and registers nothing. The wiki-field check re-reads the note's field
   *  here, so a remove-wiki that ran while the check waited isn't undone (#385). */
  readonly stillWanted?: (projectId: string) => Promise<boolean>;
}

/** createProjectWiki's answer when `stillWanted` said no in the queued step. */
export const NO_LONGER_REQUESTED = 'NO_LONGER_REQUESTED';

/** create-project-wiki's first full curation, when the wiki has never been built: its
 *  result when it ran before the reply (the CLI); "queued" when it runs after the reply
 *  (the server); "in_progress" when a build for the project was already queued or
 *  running. Null when no build is needed, and on dry runs. */
export type FirstBuild = CurateResult | 'queued' | 'in_progress' | null;

export type CreateProjectWikiResponse =
  | {
    readonly ok: true; readonly project: string;
    /** Null only when the call found a build already in flight and its project id is unknown. */
    readonly project_id: string | null; readonly dry_run: boolean;
    /** False when the project wiki was already registered. */
    readonly created: boolean;
    /** True when an empty home page was (or, on a dry run, would be) written. */
    readonly home_created: boolean;
    readonly first_build: FirstBuild;
    readonly detail: string;
  }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Plain-language status for a build a tool call queued instead of running. It promises no sweep
 *  retry: scheduled sweeps build wikis only while wikiReconciliationMode is live (#544). */
const QUEUED_OUTCOME_NOTE = 'It should finish within a few minutes, but not if today\'s spend cap is reached. '
  + 'curator-status shows the outcome.';

/** A queued build that throws gets a run row, so curator-status shows the failure the caller
 *  was told to look for (a build normally records its own runs; a throw skips that). */
function recordingFailure(deps: CoreDeps, project: string, trigger: RunTrigger, work: () => Promise<unknown>): () => Promise<unknown> {
  return async () => {
    const ts = new Date().toISOString();
    const t0 = Date.now();
    try {
      return await work();
    } catch (err) {
      recordRunSafe(deps, { project, outcome: 'error', dryRun: false,
        detail: `on-demand build failed: ${err instanceof Error ? err.message : String(err)}` }, trigger, Date.now() - t0, ts);
      throw err;
    }
  };
}

/** Records an on-demand build as an error run if shutdown gives up on it before it ends (#405),
 *  so curator-status shows the cut-off build instead of the run before it. Unpaid as far as the
 *  runs table knows, so it never holds the wiki. */
function recordingInterruption(deps: CoreDeps, project: string, trigger: RunTrigger): (detail: string) => void {
  const ts = new Date().toISOString();
  const t0 = Date.now();
  return detail => recordRunSafe(deps, { project, outcome: 'error', dryRun: false, detail }, trigger, Date.now() - t0, ts);
}

function inFlightDetail(what: string, build: InFlightBuild): string {
  return `${what} is already queued or running (queued at ${build.since}); not starting another. curator-status shows the outcome.`;
}

/**
 * Start maintaining a project's wiki at the caller's request. Registers the project
 * so sweeps keep it current, writes an empty home (narrative sections awaiting the
 * first curation plus live task sections, no model call) when none exists, then runs
 * the first curation within the daily budget. With `deps.builds` (the server) the first
 * curation is queued and the call replies at once; a build already in flight for the
 * project is reported instead of queueing another. Idempotent: an already-built wiki is
 * only confirmed. A dry run reports the plan without writes or model calls.
 */
export async function createProjectWiki(deps: CoreDeps, args: CreateProjectWikiArgs): Promise<CreateProjectWikiResponse> {
  const { db, engine } = deps;
  if (!db) return { ok: false, error: { code: 'NO_DB', message: 'create-project-wiki requires the curator DB (server mode)' } };
  // Checked before the queue: a retry must not wait behind the build it is asking about.
  const inFlight = deps.builds?.get(projectBuildKey(args.project));
  if (inFlight) {
    return { ok: true, project: args.project, project_id: inFlight.projectId, dry_run: args.dryRun, created: false,
      home_created: false, first_build: 'in_progress', detail: inFlightDetail(`A build for "${args.project}"`, inFlight) };
  }
  const opened = await deps.queue.enqueue(`create wiki: ${args.project}`, async () => {
    let evidence: Awaited<ReturnType<Engine['projectEvidence']>>;
    try {
      evidence = await engine.projectEvidence(args.project, deps.config.meetingReads);
      const node = await engine.getNode(evidence.project.id);
      const projectType = projectTypeOf(deps.config);
      if (projectType === null || !node.types.includes(projectType)) {
        return { ok: false as const, error: { code: 'NOT_A_PROJECT', message: `"${evidence.project.title}" is not a project note` } };
      }
    } catch (err) {
      return { ok: false as const, error: { code: 'UNKNOWN_PROJECT',
        message: `No project note matches "${args.project}": ${err instanceof Error ? err.message : String(err)}` } };
    }
    const { id, title } = evidence.project;
    if (args.stillWanted && !(await args.stillWanted(id))) {
      return { ok: false as const, error: { code: NO_LONGER_REQUESTED, message: `"${title}" no longer asks for a wiki` } };
    }
    const byTitle = getWikiRoot(db, title);
    if (byTitle && byTitle.kind !== 'project') {
      return { ok: false as const, error: { code: 'TITLE_IN_USE', message: `"${title}" is already a ${byTitle.kind} wiki` } };
    }
    if (byTitle?.root_node_id && byTitle.root_node_id !== id) {
      return { ok: false as const, error: { code: 'TITLE_IN_USE', message: `"${title}" is still registered to a renamed `
        + 'project; call create-project-wiki for that project under its new title first' } };
    }
    // A renamed project keeps its one registration, moved to the current title.
    const existing = byTitle ?? projectWikiRoots(db).find(r => r.root_node_id === id);
    const homeMissing = evidence.existing_wiki.home_id === null;
    if (!args.dryRun) {
      db.transaction(() => {
        // Moving keeps the renamed wiki's pause flag, corrections and other title-keyed state.
        if (existing && existing.root_title !== title) moveWikiTitle(db, existing.root_title, title);
        registerWikiRoot(db, { root_title: title, root_node_id: id, kind: 'project', source: 'vault', cadence: null, brief: null,
          created_at: existing?.created_at ?? new Date().toISOString(), created_by: existing?.created_by ?? args.by ?? null });
      })();
      if (homeMissing) {
        try {
          await engine.wikiCreateHome(id, false);
        } catch (err) {
          return { ok: false as const, error: { code: 'HOME_CREATE_FAILED', message:
            `"${title}" is registered, but its empty home could not be written (calling create-project-wiki again writes it): `
            + `${err instanceof Error ? err.message : String(err)}` } };
        }
      }
    }
    return { ok: true as const, id, title, created: existing === undefined, homeMissing,
      needsBuild: homeMissing || evidence.existing_wiki.home?.wiki_evidence_hash === undefined };
  });
  if (!opened.ok) return opened;
  // The resolved node, not its title: an active namesake must not take the first build.
  const ref: ProjectRef = { id: opened.id, title: opened.title, file_path: '', status: null };
  const buildOpts: CurateOpts = { dryRun: false, force: false, trigger: 'on-demand' };
  let firstBuild: FirstBuild = null;
  let inFlightBuild: InFlightBuild | null = null;
  if (opened.needsBuild && !args.dryRun) {
    // A paused wiki is answered now: queued, it would be skipped without a run to show.
    const refused = deps.builds ? refusedBeforeQueue(deps, ref, buildOpts) : null;
    if (refused) {
      firstBuild = refused;
    } else if (deps.builds) {
      const queued = deps.builds.start(projectBuildKeys(args.project, opened.title, opened.id), `first build of ${opened.title}`,
        opened.id, recordingFailure(deps, opened.title, buildOpts.trigger, () => curateRef(deps, ref, buildOpts)),
        recordingInterruption(deps, opened.title, buildOpts.trigger));
      firstBuild = queued.started ? 'queued' : 'in_progress';
      inFlightBuild = queued.build;
    } else {
      firstBuild = await curateRef(deps, ref, buildOpts);
    }
  }
  const registered = `wiki registered${opened.homeMissing ? ' with an empty home' : ''}`;
  // A first build that didn't run is built on request; a sweep builds it only while wikiReconciliationMode
  // is live, so none is promised (#544). create-project-wiki takes no pause, so a pause predates the call.
  const detail = args.dryRun
    ? `dry run: would ${opened.created ? 'register' : 'keep'} the wiki${opened.homeMissing ? ', create its home' : ''}`
      + `${opened.needsBuild ? ' and run its first curation' : ''}; no writes or model calls`
    : firstBuild === null ? 'already maintained; nothing to build'
    : firstBuild === 'queued' ? `${registered}; its first build is queued. ${QUEUED_OUTCOME_NOTE}`
    : firstBuild === 'in_progress' ? `${registered}; ${inFlightDetail('its first build', inFlightBuild!)}`
    : firstBuild.outcome === 'written' ? 'wiki created and built'
    : firstBuild.outcome === 'skipped' && firstBuild.detail === 'paused'
      ? `${registered}; it was already paused, so its first build did not run. `
        + 'curate-project-wiki with force: true builds it on request and leaves it paused'
    : `${registered}; first build ${firstBuild.outcome}`
      + `${firstBuild.detail ? ` (${firstBuild.detail})` : ''}; build it later with curate-project-wiki and force: true`;
  return { ok: true, project: opened.title, project_id: opened.id, dry_run: args.dryRun, created: opened.created,
    home_created: opened.homeMissing, first_build: firstBuild, detail };
}

/** Curate one project by title (active-list lookup with bare-ref fallback). */
export async function curateOne(deps: CoreDeps, project: string, opts: CurateOpts): Promise<CurateResult> {
  return curateRef(deps, await resolveProjectRef(deps, project), opts);
}

/** A project title as a ref: the active project of that title, else a bare lookup. */
async function resolveProjectRef(deps: CoreDeps, project: string): Promise<ProjectRef> {
  const active = await deps.engine.listActiveProjects(deps.config.activeStatuses, deps.config.projectType, deps.config.projectStatusField);
  return active.find((p) => p.title === project) ?? await inactiveProjectRef(deps, project);
}

/** Why a project can't be curated, decided before it is queued: no registered wiki,
 *  or paused (unless forced). Null when it can be. */
function refusedBeforeQueue(deps: CoreDeps, ref: ProjectRef, opts: CurateOpts): CurateResult | null {
  if (registeredProjects(deps, [ref]).length === 0) {
    return { project: ref.title, outcome: 'error', detail: noProjectWikiDetail(ref.title), dryRun: opts.dryRun };
  }
  // Outside the queue only read: a renamed wiki's pause flag may still be under its registered title.
  const registeredTitle = asRegisteredTitles(deps, [ref])[0]!.title;
  if (!opts.force && (pausedSafe(deps, ref.title) || pausedSafe(deps, registeredTitle))) {
    return { project: ref.title, outcome: 'skipped', detail: 'paused', dryRun: opts.dryRun };
  }
  return null;
}

/** Curate one resolved project, if it has a registered wiki. */
async function curateRef(deps: CoreDeps, ref: ProjectRef, opts: CurateOpts): Promise<CurateResult> {
  const refused = refusedBeforeQueue(deps, ref, opts);
  if (refused) return refused;
  const result = await curateTimed(deps, ref, opts);
  if (!opts.dryRun) {
    await writeJournalSafe(
      deps,
      { kind: 'run-refs', runRefs: result.runRef ? [result.runRef] : [] },
      `${opts.trigger === 'cli' ? 'CLI' : 'on-demand'}: ${ref.title}`,
    );
  }
  return result;
}

/**
 * The registered topic wiki a one-wiki curate-project-wiki call names (#425), with the answer it
 * gets before the queue when it can't run: paused (unless forced), or a name that also reaches a
 * project wiki (a renamed project whose wiki couldn't move to a title a topic holds). Null when the
 * name is a project's. `ref` is the name resolved as a project.
 */
function namedTopicWiki(deps: CoreDeps, name: string, ref: ProjectRef, opts: CurateOpts):
{ readonly row: WikiRootRow; readonly refused: CurateResult | null } | null {
  const row = wikiRootSafe(deps, name);
  if (row?.kind !== 'topic') return null;
  if (registeredProjects(deps, [ref]).length > 0) {
    return { row, refused: { project: name, outcome: 'error', dryRun: opts.dryRun, detail: `AMBIGUOUS_WIKI: "${name}" names `
      + 'both a topic wiki and the wiki of a renamed project; rename one of them first. Nothing was curated.' } };
  }
  // Paused is answered before the queue, as for a project, unless forced.
  return { row, refused: !opts.force && pausedSafe(deps, row.root_title)
    ? { project: row.root_title, outcome: 'skipped', detail: 'paused', dryRun: opts.dryRun } : null };
}

/**
 * Curate the active project set (the daily sweep), each serialized through the
 * queue. Fetches the active list once for the whole batch (delegating to
 * curateOne would re-list per project); callers needing a single project use
 * curateOne.
 */
export async function runSweep(deps: CoreDeps, opts: SweepOpts): Promise<CurateResult[]> {
  const work = () => runSweepInContext(deps, opts);
  return deps.usage ? deps.usage.withSweep({ ref: randomUUID(), trigger: opts.trigger }, work) : work();
}

async function runSweepInContext(deps: CoreDeps, opts: SweepOpts): Promise<CurateResult[]> {
  // A plain dry run makes no model calls: the paid maintenance phases run only live or under preview.
  const paidPhases = !opts.dryRun || opts.preview === true;
  if (paidPhases) {
    // Capture is independent of wiki mode and the active-project list. Its own
    // queue-backed contract never rejects; retain this boundary so a regression
    // cannot prevent the rest of an all-project sweep.
    let captureResult: ConversationCaptureSweepResult;
    try {
      captureResult = await runConversationCaptureSweep(deps, { dryRun: opts.dryRun, trigger: opts.trigger });
    } catch (err) {
      warn('conversation capture sweep failed', err);
      captureResult = captureSweepFailureResult(opts.dryRun, err);
    }
    try {
      opts.onConversationCaptureResult?.(captureResult);
    } catch (err) {
      warn('conversation capture result callback failed', err);
    }

    let fieldGuessPhaseEntered = false;
    try {
      const sweepRunRef = randomUUID();
      fieldGuessPhaseEntered = true;
      const fieldGuessResult = await runFieldGuessSweep(deps, {
        dryRun: opts.dryRun,
        runRef: sweepRunRef,
        trigger: opts.trigger,
      });
      try {
        await opts.onFieldGuessResult?.(fieldGuessResult);
      } catch {
        console.warn('[curator] field guess result callback failed');
      }
    } catch {
      // runFieldGuessSweep contains its own worker and queue failures. Keep this
      // boundary too so a future regression cannot suppress project discovery.
      if (!fieldGuessPhaseEntered) recordFieldGuessPreAdmissionFailure(deps, opts);
      console.warn('[curator] field guess sweep failed before a phase result was available');
    }
  }
  const { engine, config } = deps;
  const wikiMode = opts.trigger === 'scheduled' ? config.wikiReconciliationMode : 'live';
  const wikiOpts = wikiMode === 'dry-run' ? { ...opts, dryRun: true } : opts;
  const results: CurateResult[] = [];
  let projects: ProjectRef[] = [];
  if (wikiMode === 'off') {
    opts.onStart?.(0);
    const runRef = randomUUID();
    const disabled: CurateResult = {
      project: 'Scheduled wiki reconciliation',
      outcome: 'skipped_mode_disabled',
      detail: 'mode disabled (off)',
      dryRun: opts.dryRun,
      runRef,
    };
    deps.recorder?.setContext({
      runRef, trigger: opts.trigger, fn: 'wiki-curation', project: disabled.project,
    });
    try {
      deps.recorder?.summary(
        'wiki-curation', wikiSummaryLine(disabled.project, disabled),
        { outcome: disabled.outcome, errors: 0 }, opts.dryRun,
      );
    } finally {
      deps.recorder?.setContext(null);
    }
    recordRunSafe(deps, disabled, opts.trigger, 0, new Date().toISOString());
    results.push(disabled);
    opts.onResult?.(disabled);
  } else {
    const topicBudget = topicRefreshAssessmentBudget(config.topicEarlyRefreshAssessmentCap);
    projects = registeredProjects(deps, await engine.listActiveProjects(config.activeStatuses, config.projectType, config.projectStatusField));
    // Dry runs move nothing, so a renamed wiki's pause flag may still be under its registered title.
    const registered = asRegisteredTitles(deps, projects);
    // Real runs move renamed wikis to their current titles in the queue, after any in-flight run of theirs.
    if (!wikiOpts.dryRun && registered.some((ref, i) => ref.title !== projects[i]!.title)) {
      const listed = projects;
      await deps.queue.enqueue('follow project renames', async () => followProjectRenames(deps, listed));
    }
    const paused = pausedSet(deps);
    if (paused.size > 0) projects = projects.filter((p, i) => !paused.has(p.title) && !paused.has(registered[i]!.title));
    if (opts.limit != null) projects = projects.slice(0, opts.limit);
    opts.onStart?.(projects.length);
    for (const project of projects) {
      // A spent budget still lets unchanged and task-only wikis refresh their live sections; no paid stage starts.
      const result = await curateTimed(deps, project, wikiOpts, await budgetSpentDetail(deps, wikiOpts));
      results.push(result);
      opts.onResult?.(result);
    }
    // --- Topic wikis (registered via create-or-update-wiki) — curate after the active projects. ---
    // Paused topics are excluded (the control store is title-keyed). Topics are NOT
    // auto-backlogged (the staleness nudge below is project-status-specific). The brief
    // is passed to curateTopicTimed separately — ProjectRef itself carries no brief.
    if (deps.db) {
      let roots: WikiRootRow[] = [];
      try {
        roots = topicWikiRoots(deps.db);
        // Re-read after the roots: a topic created paused while the projects ran is registered
        // and paused in one transaction, so it must not pass on the pause set read before it existed.
        const pausedNow = pausedSet(deps);
        roots = roots.filter((r) => !paused.has(r.root_title) && !pausedNow.has(r.root_title));
      } catch (err) {
        warn('topic wiki roots unavailable', err);
      }
      for (const r of roots) {
        const root: ProjectRef = { id: r.root_node_id, title: r.root_title, file_path: '', status: null };
        const result = await budgetSkip(deps, root.title, wikiOpts) ?? await curateTopicTimed(deps, root, topicSpecOf(r), wikiOpts, topicBudget);
        results.push(result);
        opts.onResult?.(result);
      }
    }
  }
  // --- Backlog staleness (policy lives here, not in curateProject) ---
  // A project whose wiki hasn't been curated in staleProjectDays is probably
  // inactive; auto-set its status to backlog. Auto-set only, never auto-clear.
  // Suppressed under dry-run. Scheduled-sweep only (curateOne does not backlog).
  // An empty staleProjectStatus designates no status for it: off (#447).
  // No project status field (none in the vault map): there is no status to set.
  const statusField = config.projectStatusField;
  if (wikiMode === 'live' && !opts.dryRun && statusField !== null && (config.staleProjectStatus ?? '').trim() !== '') {
    const now = new Date();
    deps.recorder?.setContext({ runRef: randomUUID(), trigger: opts.trigger, fn: 'staleness-nudge' });
    try {
      for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        const result = results[i];
        if (!project || project.id === null || !result || !isStale(result.wikiCuratedAt, project.status, config, now)) continue;
        // Budget and failure-hold skips say nothing about project activity; a live refresh means tasks moved.
        if (result.outcome === 'skipped_budget' || result.outcome === 'skipped_failure_hold' || result.outcome === 'refreshed_live') continue;
        try {
          await engine.updateNodeFields(project.id, { [statusField]: config.staleProjectStatus }, project.title);
        } catch {
          // Best-effort nudge; a failed status flip simply retries next sweep.
        }
      }
    } finally {
      deps.recorder?.setContext(null);
    }
  }
  if (paidPhases) {
    // --- Memory sweep (v1.6) — final phase, after all wiki work, best-effort. ---
    // runMemorySweep never rejects by construction; the catch is belt-and-braces so
    // a future regression there still cannot fail the nightly run.
    try {
      await runMemorySweep(deps, { dryRun: opts.dryRun, trigger: opts.trigger });
    } catch (err) {
      warn('memory sweep failed', err);
    }
    // --- Conversation memory sweep — settled VEfO conversations, after the note
    // sweep (notes get first claim on the night) and before reconciliation (so
    // tonight's new memories are eligible for tonight's adjudication).
    // runConversationSweep never rejects by construction; the catch is
    // belt-and-braces so a future regression there still cannot fail the run.
    try {
      await runConversationSweep(deps, { dryRun: opts.dryRun, trigger: opts.trigger });
    } catch (err) {
      warn('conversation sweep failed', err);
    }
    // --- Organization sweep — after the memory sweep, best-effort. ---
    try {
      await runOrgSweep(deps, { dryRun: opts.dryRun, trigger: opts.trigger });
    } catch (err) {
      warn('org sweep failed', err);
    }
    // --- Reconciliation (§4c) — cross-source memory adjudication, best-effort,
    // LAST so its journal actions land in the same nightly entry. ---
    try {
      await runReconcile(deps, { dryRun: opts.dryRun, trigger: opts.trigger });
    } catch (err) {
      warn('reconcile failed', err);
    }
    // --- Dossier rebuilds (#714) — after the memory phases, so tonight's memories are in: the
    // dossiers whose note says `dossier: on-change` and that are behind, at most 5, from the daily
    // cap. Each build records its own run and journal summary. A dry run rebuilds nothing. ---
    try {
      const rebuilds = await runDossierRebuilds(deps, { dryRun: opts.dryRun },
        (built, nodeId, stillWanted) => startDossier(built, { node_id: nodeId }, { wait: true, stillWanted }));
      if (rebuilds.considered > 0) {
        deps.recorder?.setContext({ runRef: randomUUID(), trigger: opts.trigger, fn: 'entity-dossier' });
        deps.recorder?.summary('entity-dossier', `Dossiers behind and set to rebuild: ${rebuilds.considered}; rebuilt ${rebuilds.rebuilt}`
          + `${rebuilds.skipped > 0 ? `, ${rebuilds.skipped} already being built or current` : ''}`
          + `${rebuilds.failed > 0 ? `, ${rebuilds.failed} failed` : ''}`
          + `${rebuilds.leftForLater > 0 ? `, ${rebuilds.leftForLater} left for ${rebuilds.stoppedBy === 'budget' ? 'when there is budget' : 'another night'}` : ''}.`,
          { ...rebuilds }, false);
        deps.recorder?.setContext(null);
      }
    } catch (err) {
      warn('dossier rebuilds failed', err);
    }
  }
  // --- Link sweep (#332) — on the daily schedule, after the other phases. Report-only and free
  // (no model calls), so a dry run runs it too, changing no bookkeeping. Never rejects; the
  // catch is belt-and-braces. Its events land in this sweep's journal entry. ---
  try {
    await runLinkSweep(deps, { dryRun: opts.dryRun, trigger: opts.trigger, schedule: 'daily' });
  } catch (err) {
    warn('link sweep failed', err);
  }
  // --- Memory note refresh (Task 9) — render + write Settings/Memories.md
  // through executeMutation. Only the scheduled sweep calls this (CLI and
  // on-demand sweeps do not), after reconciliation and before the journal. ---
  deps.recorder?.setContext({ runRef: randomUUID(), trigger: opts.trigger, fn: 'memory-note-refresh' });
  try {
    const refreshResult = await runMemoryNoteRefresh(deps.engine, deps.config, { dryRun: opts.dryRun, trigger: opts.trigger });
    if (refreshResult.ran && refreshResult.file_written) {
      deps.recorder?.record({
        action: 'memory-note-refreshed',
        target: 'Settings/Memories.md',
        detail: `live=${refreshResult.live_count} historical=${refreshResult.historical_count} issues=${refreshResult.issues_rendered}`,
      });
    }
    if (refreshResult.error) {
      warn('memory-note-refresh reported an error', refreshResult.error);
    }
  } catch (err) {
    warn('memory-note-refresh failed', err);
  } finally {
    deps.recorder?.setContext(null);
  }
  // --- Journal entry — one per sweep, written INSIDE runSweep so every caller
  // (scheduler, CLI sweep, triggerCuration sweep) gets exactly one. Sweeps take
  // everything unjournaled, catching stragglers from any earlier failed write.
  if (!opts.dryRun) {
    const label = opts.trigger === 'scheduled' ? 'nightly sweep'
      : opts.trigger === 'cli' ? 'CLI sweep' : 'on-demand sweep';
    await writeJournalSafe(deps, { kind: 'all-unjournaled' }, label);
  }
  return results;
}

export interface TriggerCurationArgs {
  /** A project title to curate exactly one; null/absent sweeps the active set. */
  project?: string | null;
  force: boolean;
  dryRun: boolean;
  /** Sweep-only cap; ignored when `project` is set. */
  limit?: number | null;
  /** With dryRun, run the paid stages and preview without writing. */
  preview?: boolean;
}

export type ReconcileWikiPagesArgs = {
  readonly wiki: string;
  readonly dryRun: boolean;
  readonly preview?: boolean;
  readonly force: boolean;
};

export type ReconcileWikiPagesResponse =
  | { readonly ok: true; readonly wiki: string; readonly kind: 'project' | 'topic'; readonly dry_run: boolean; readonly result: CurateResult }
  | { readonly ok: false; readonly error: { readonly code: 'NO_DB' | 'UNKNOWN_WIKI' | 'AMBIGUOUS_WIKI'; readonly message: string; readonly available: readonly string[] } };

export async function reconcileWikiPages(deps: CoreDeps, args: ReconcileWikiPagesArgs): Promise<ReconcileWikiPagesResponse> {
  if (!deps.db) return { ok: false, error: { code: 'NO_DB', message: 'reconcile-wiki-pages requires the curator DB', available: [] } };
  const active = await deps.engine.listActiveProjects(deps.config.activeStatuses, deps.config.projectType, deps.config.projectStatusField);
  const topics = topicWikiRoots(deps.db);
  const project = active.find(item => item.title === args.wiki);
  const topic = topics.find(item => item.root_title === args.wiki);
  const available = [...new Set([...active.map(item => item.title), ...topics.map(item => item.root_title)])].sort();
  if (project !== undefined && topic !== undefined) {
    return { ok: false, error: { code: 'AMBIGUOUS_WIKI', message: `"${args.wiki}" matches both an active project and a registered topic`, available } };
  }
  if (project === undefined && topic === undefined) {
    return { ok: false, error: { code: 'UNKNOWN_WIKI', message: `No active project or registered topic is named "${args.wiki}"`, available } };
  }
  if (topic !== undefined) {
    const root: ProjectRef = { id: topic.root_node_id, title: topic.root_title, file_path: '', status: null };
    const result = await curateTopicTimed(deps, root, topicSpecOf(topic), { dryRun: args.dryRun, preview: args.preview ?? false, force: args.force, trigger: 'on-demand' });
    return { ok: true, wiki: args.wiki, kind: 'topic', dry_run: args.dryRun, result };
  }
  const result = await curateOne(deps, args.wiki, { dryRun: args.dryRun, preview: args.preview ?? false, force: args.force, trigger: 'on-demand' });
  return { ok: true, wiki: args.wiki, kind: 'project', dry_run: args.dryRun, result };
}

/**
 * One-or-sweep trigger shared by the curate-project-wiki tool, mirroring the
 * CLI's branch: a present project curates exactly that one (curateOne), or that
 * topic wiki when it names a registered one (#425); an absent project sweeps the
 * active set (runSweep). Returns one CurateResult per
 * project curated — length 1 for a single project, N for a sweep, 0 when the
 * sweep finds no active project. Adds no policy of its own; recording, queue
 * serialization, and the auto-backlog nudge live in curateOne/runSweep.
 */
export async function triggerCuration(
  deps: CoreDeps,
  args: TriggerCurationArgs,
  trigger: RunTrigger,
): Promise<CurateResult[]> {
  if (args.project) {
    const opts: CurateOpts = { dryRun: args.dryRun, preview: args.preview ?? false, force: args.force, trigger };
    const ref = await resolveProjectRef(deps, args.project);
    const topic = namedTopicWiki(deps, args.project, ref, opts);
    if (topic) return [topic.refused ?? await curateTopicOnDemand(deps, topic.row.root_title, opts)];
    return [await curateRef(deps, ref, opts)];
  }
  return runSweep(deps, { dryRun: args.dryRun, preview: args.preview ?? false, force: args.force, trigger, limit: args.limit ?? null });
}

/** A curate-project-wiki call answered without waiting for the curation. */
export interface QueuedCuration {
  readonly status: 'queued' | 'in_progress';
  /** The project, or null for a sweep. */
  readonly project: string | null;
  /** When the build in flight was queued (ISO). */
  readonly queued_at: string;
  readonly detail: string;
}

/**
 * curate-project-wiki's server path (#284). A build already queued or running for the
 * same project (or an on-demand sweep, for a sweep) is reported instead of starting
 * another, whatever the call's mode: a dry run would only wait behind it. A live run is
 * queued and reported at once, except a single project that can't be curated (no wiki,
 * paused), which is answered right away. A registered topic wiki's name runs the topic
 * curation the same way (#425). Returns null for a dry run with nothing in flight, which
 * the caller runs synchronously as before.
 */
export async function startOnDemandCuration(
  deps: CoreDeps,
  builds: BackgroundBuilds,
  args: TriggerCurationArgs,
  trigger: RunTrigger,
): Promise<QueuedCuration | CurateResult[] | null> {
  const project = args.project ?? null;
  const key = project === null ? SWEEP_BUILD_KEY : projectBuildKey(project);
  const what = project === null ? 'An on-demand sweep' : `A curation of "${project}"`;
  const inFlight = (build: InFlightBuild): QueuedCuration =>
    ({ status: 'in_progress', project, queued_at: build.since, detail: inFlightDetail(what, build) });
  const existing = builds.get(key);
  if (existing) return inFlight(existing);
  if (args.dryRun) return null;
  const opts: CurateOpts = { dryRun: false, preview: false, force: args.force, trigger };
  if (project === null) {
    const limit = args.limit ?? null;
    const queued = builds.start(key, 'on-demand sweep', null,
      recordingFailure(deps, 'On-demand sweep', trigger, () => runSweep(deps, { ...opts, limit })),
      recordingInterruption(deps, 'On-demand sweep', trigger));
    return queued.started
      ? { status: 'queued', project, queued_at: queued.build.since, detail: `Queued a sweep of the active project wikis`
        + `${limit === null ? '' : ` (at most ${limit})`}. It can take a while; curator-status shows each outcome. `
        + 'Projects refused because today\'s spend cap is reached are retried by the next scheduled sweep only while '
        + 'curator-status shows wiki_reconciliation_mode "live"; otherwise call this again once there is budget.' }
      : inFlight(queued.build);
  }
  const ref = await resolveProjectRef(deps, project);
  const topic = namedTopicWiki(deps, project, ref, opts);
  if (topic) {
    if (topic.refused) return [topic.refused];
    const title = topic.row.root_title;
    const queuedTopic = startTopicBuild(deps, builds, title, topic.row.root_node_id, opts);
    return queuedTopic.started
      ? { status: 'queued', project, queued_at: queuedTopic.build.since,
        detail: `Queued a rebuild of the topic wiki "${title}". A paused wiki stays paused. ${TOPIC_QUEUED_NOTE}` }
      : inFlight(queuedTopic.build);
  }
  const refused = refusedBeforeQueue(deps, ref, opts);
  if (refused) return [refused];
  const queued = builds.start(projectBuildKeys(project, ref.title, ref.id), `curation of ${ref.title}`, ref.id,
    recordingFailure(deps, ref.title, trigger, () => curateRef(deps, ref, opts)),
    recordingInterruption(deps, ref.title, trigger));
  return queued.started
    ? { status: 'queued', project, queued_at: queued.build.since, detail: `Queued a curation of "${ref.title}". ${QUEUED_OUTCOME_NOTE}` }
    : inFlight(queued.build);
}

export interface RequestPageArgs {
  project: string;
  title: string;
  brief?: string;
  mode: 'immediate' | 'next-run';
  requestedBy?: string;
}

export interface RequestPageResponse {
  ok: boolean;
  request_id?: number;
  status?: 'pending' | 'fulfilled' | 'failed';
  page?: { node_id: string | null; title: string };
  resolvedTo?: RequestedPageOutcome['resolvedTo'];
  detail?: string;
  error?: { code: string; message: string };
  usage?: TokenUsage | null;
  cost_usd?: number | null;
}

/**
 * The request-wiki-page tool's core. next-run queues a pending row for the
 * project's next full run; immediate fulfills now through the curation queue
 * (single lane — never overlaps a running curation). A project with no wiki
 * yet gets a first full curation, then the page (caller-friendly, per spec).
 */
export async function requestWikiPage(deps: CoreDeps, args: RequestPageArgs): Promise<RequestPageResponse> {
  const { engine, llm, config, queue, db } = deps;
  if (!db) {
    return { ok: false, error: { code: 'NO_DB', message: 'page requests require the curator DB (server mode)' } };
  }
  const active = await engine.listActiveProjects(config.activeStatuses, config.projectType, config.projectStatusField);
  const activeRef = active.find((p) => p.title === args.project);
  const registeredTopic = wikiRootSafe(deps, args.project);
  if (activeRef !== undefined && registeredTopic?.kind === 'topic') {
    return {
      ok: false,
      error: {
        code: 'AMBIGUOUS_WIKI',
        message: `"${args.project}" matches both an active project and a registered topic`,
      },
    };
  }
  const ref: ProjectRef = activeRef ?? (registeredTopic?.kind === 'topic'
    ? { id: registeredTopic.root_node_id, title: args.project, file_path: '', status: null }
    : await inactiveProjectRef(deps, args.project));
  if (registeredTopic?.kind !== 'topic' && registeredProjects(deps, [ref]).length === 0) {
    return { ok: false, error: { code: 'NO_WIKI', message: noProjectWikiDetail(ref.title) } };
  }

  // A request named after a retired spine label would be retired by the legacy
  // migration on the project's next full run (the migration routes by title and
  // pins don't guard it) — reject up front rather than fulfill-then-destroy.
  const bareLabel = args.title.startsWith(`${ref.title} — `)
    ? args.title.slice(`${ref.title} — `.length)
    : args.title;
  if (RETIRED_SPINE_LABELS.includes(bareLabel)) {
    return {
      ok: false,
      error: {
        code: 'RESERVED_TITLE',
        message: `"${bareLabel}" is a retired spine page name — choose a different page title`,
      },
    };
  }

  let requestId: number;
  try {
    requestId = insertPageRequest(db, {
      project_node_id: ref.id,
      project_title: ref.title,
      title: args.title,
      page_title: subpageTitle(ref.title, args.title),
      brief: args.brief ?? null,
      requested_by: args.requestedBy ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    return { ok: false, error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) } };
  }

  if (args.mode === 'next-run') {
    return {
      ok: true, request_id: requestId, status: 'pending',
      detail: "queued — fulfilled at the top of the wiki's next full curation run",
    };
  }

  const runRef = randomUUID();
  const res = await queue.enqueue(`${ref.title} → ${args.title}`, async () => {
    deps.usage?.setContext({ project: ref.title, runRef });
    deps.recorder?.setContext({ runRef, trigger: 'on-demand', fn: 'requested-page', project: ref.title });
    try {
      // remove-wiki may have run while this waited in the queue.
      if (registeredTopic?.kind === 'topic' ? !wikiRootSafe(deps, ref.title) : registeredProjects(deps, [ref]).length === 0) {
        return { project: ref.title, requestedTitle: args.title, qualifiedTitle: subpageTitle(ref.title, args.title),
          outcome: 'error' as const, detail: noProjectWikiDetail(ref.title), dryRun: false };
      }
      let r = await fulfillOne(deps, ref, { id: requestId, title: args.title, brief: args.brief ?? null }, 'on-demand');
      if (r.outcome === 'no-wiki') {
        // Stand the wiki up first, then fulfill the page (spec: caller-friendly,
        // never "run curate-project-wiki first"). A registered topic root gets a
        // topic curation — the project spine/salience machinery does not apply.
        const fullTs = new Date().toISOString();
        const t0 = Date.now();
        const root = wikiRootSafe(deps, ref.title);
        const full = root?.kind === 'topic'
          ? await (async () => {
              const topicRoot = { ...ref, id: root.root_node_id ?? ref.id };
              const admission = manualTopicAdmission(false);
              const raw = await curateTopic(
                engine,
                llm,
                config,
                topicRoot,
                topicSpecOf(root),
                {
                  dryRun: false,
                  force: false,
                  pinnedNodeIds: await pinnedSafe(deps, ref.title, ref.id),
                  corrections: correctionsSafe(deps, ref.title),
                  runRef,
                  scheduled: false,
                  admission,
                  explicitSourceNodeIds: explicitTopicSourceIds(deps, ref.title),
                  prioritySourceNodeIds: [],
                },
              );
              return finalizeTopicResult(
                deps,
                topicRoot,
                { dryRun: false, force: false, trigger: 'on-demand' },
                admission,
                raw,
                root.source === 'vault+web',
              );
            })()
          : await curateProject(engine, llm, config, ref, false, false, await pinnedSafe(deps, ref.title, ref.id), correctionsSafe(deps, ref.title), runRef, config.projectHomeProvenanceEnabled && deps.db ? correctionInputs(deps.db, ref.title) : undefined);
        recordRunSafe(deps, full, 'on-demand', Date.now() - t0, fullTs);
        if (full.outcome === 'written') {
          r = await fulfillOne(deps, ref, { id: requestId, title: args.title, brief: args.brief ?? null }, 'on-demand');
        } else {
          try {
            markRequestFailed(db, requestId, `first curation failed: ${full.detail ?? full.outcome}`, new Date().toISOString());
          } catch (err) {
            warn(`request ${requestId} not marked`, err);
          }
        }
      }
      return r;
    } finally {
      deps.usage?.setContext(null);
      deps.recorder?.setContext(null);
    }
  });

  await writeJournalSafe(deps, { kind: 'run-refs', runRefs: [runRef] }, `requested page: ${args.title} (${ref.title})`);

  if (res.outcome === 'written') {
    return {
      ok: true, request_id: requestId, status: 'fulfilled',
      page: { node_id: res.nodeId ?? null, title: res.qualifiedTitle },
      resolvedTo: res.resolvedTo,
      detail: res.detail, usage: res.usage ?? null, cost_usd: res.costUsd ?? null,
    };
  }
  const code = res.outcome === 'unknown-project' ? 'UNKNOWN_PROJECT'
    : res.outcome === 'no-wiki' ? 'FIRST_CURATION_FAILED' : res.budgetRefused ? 'BUDGET_REFUSED' : 'FULFILLMENT_FAILED';
  return {
    ok: false, request_id: requestId, status: getPageRequest(db, requestId)?.status ?? 'failed',
    error: { code, message: res.detail ?? res.outcome },
  };
}
