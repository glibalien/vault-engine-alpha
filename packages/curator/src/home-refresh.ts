import { resolveConfiguredWikiStage, bindWikiStageClient } from './wiki-output-policy.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CoreDeps } from './core.js';
import { EngineError, type WikiReconcileInput } from './engine.js';
import type { HomeRefreshRequest, HomeRefreshPhase, HomeRefreshStatus } from './home-refresh-types.js';
import { isHomeRefreshTerminal } from './home-refresh-types.js';
import { homeRefreshRequestSchema } from './home-refresh-schema.js';
import { admitHomeRefresh, getHomeRefresh, transitionHomeRefresh, listRecoverableHomeRefreshes,
  homeRefreshStatus, type HomeRefreshRow } from './db/home-refresh.js';
import { previewHomeRefresh, digest, pageRefreshSystem } from './home-refresh-preview.js';
import { correctionInputs } from './db/provenance.js';
import { labelProjectMemories, prepareHomeEvidence } from './home-evidence.js';
import { memoryConflicts } from './wiki-memories.js';
import { keptBothPairs } from './db/reconcile.js';
import { HomeCapture } from './provenance-home.js';
import { buildHomeRequest } from './home-request.js';
import { synthesizeAcceptedPages, synthesizeHomeOverview, PageSynthesisError } from './page-synthesis.js';
import { PageRuleError } from './page-rules.js';
import { PageCapture } from './provenance-page.js';
import { gatherCapturedRequestedEvidence, requestMemories } from './requested-page.js';
import { budgetRefusalDetail, isBudgetRefusal, isShutdownRefusal } from './budget.js';
import { persistMemories } from './persist-memories.js';
import { capturedBundle, HOME_BUDGET_ASSEMBLY } from './provenance-evidence.js';
import { EvidenceBudgetError, measureBundle } from './provenance-budget.js';
import type { InspectData, OutputReceipt, ProvenanceFlow, StageRequest } from './provenance-types.js';
import type { EngineNode, ExistingWiki, PageSynthesisResult, TopologyPlan } from './types.js';
import { StructuredCallFailure } from './llm/types.js';

const pending = new WeakMap<Database.Database, Set<string>>();

/** Best effort, as in a full build: a failed ledger read shows no conflicts. */
function keptBothPairsSafe(db: Database.Database, memoryIds: readonly number[]): ReadonlyArray<readonly [number, number]> {
  try {
    return keptBothPairs(db, memoryIds);
  } catch (err) {
    console.warn(`[curator] memory conflicts unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
function requiredDb(deps: CoreDeps): Database.Database {
  if (!deps.db) throw new Error('STORAGE_UNAVAILABLE');
  return deps.db;
}
export function readHomeRefreshStatus(deps: CoreDeps, requestId: string): HomeRefreshStatus {
  const row = getHomeRefresh(requiredDb(deps), requestId);
  if (!row) throw new Error('REQUEST_NOT_FOUND');
  return homeRefreshStatus(row);
}
/** Durable admission; paid work is detached but serialized, never awaited by MCP. */
export async function executeHomeRefresh(deps: CoreDeps, input: HomeRefreshRequest): Promise<HomeRefreshStatus> {
  const request = homeRefreshRequestSchema.parse(input);
  const db = requiredDb(deps);
  const old = getHomeRefresh(db, request.request_id, digest(request));
  if (old) {
    return homeRefreshStatus(old);
  }
  await validateGuard(deps, request);
  const row = admitHomeRefresh(db, request);
  const result = homeRefreshStatus(row);
  schedule(deps, row.request_id);
  return result;
}
async function validateGuard(deps: CoreDeps, request: HomeRefreshRequest): Promise<void> {
  const p = await previewHomeRefresh(deps, request.guard.output_revision_id);
  if (p.reasons.some(reason => reason.code === 'READINESS_UNAVAILABLE')) throw new Error('READINESS_UNAVAILABLE');
  if (!p.eligible || digest(p.guard) !== digest(request.guard)) throw new Error('GUARD_CONFLICT');
}
export function recoverHomeRefreshes(deps: CoreDeps): void {
  for (const row of listRecoverableHomeRefreshes(requiredDb(deps))) schedule(deps, row.request_id);
}
function schedule(deps: CoreDeps, requestId: string): void {
  const db = requiredDb(deps);
  let active = pending.get(db);
  if (!active) { active = new Set(); pending.set(db, active); }
  if (active.has(requestId)) return;
  active.add(requestId);
  void deps.queue.enqueue('Rebuild wiki page', () => run(deps, requestId))
    .catch(() => { /* A failed checkpoint leaves the last durable phase for recovery. */ })
    .finally(() => active!.delete(requestId));
}
async function run(original: CoreDeps, id: string): Promise<void> {
  const db = requiredDb(original);
  let row = getHomeRefresh(db, id)!;
  if (isHomeRefreshTerminal(row.phase)) return;
  const update = (patch: Parameters<typeof transitionHomeRefresh>[3]) =>
    (row = transitionHomeRefresh(db, id, row.phase, patch));
  const request = JSON.parse(row.request_json) as HomeRefreshRequest;
  const pageTarget = request.guard.page_node_id !== undefined;
  const noun = pageTarget ? 'page' : 'home';
  const committed = (output: OutputReceipt) => update({ phase: 'committed', result_json: JSON.stringify(output),
    message: pageTarget ? 'Page rebuilt. The home and the other pages were not changed.' : 'Project home refreshed. Subpages were not changed.' });
  const terminal = async (phase: 'failed' | 'conflict', message: string) => {
    const output = await releaseFailedCapture(original, row);
    if (output) committed(output);
    else update({ phase, message });
  };
  try {
    // Enforce local retention even while Engine cannot answer. Keep attempt identity
    // so an already-committed receipt can still be recovered after reconnect.
    if (row.lease_expires_at && Date.parse(row.lease_expires_at) <= Date.now() && (row.stage_json || row.publication_json))
      update({ stage_json: null, publication_json: null });
    // Recovery needs Engine identity, not live model settings: a saved result is never regenerated.
    const identity = await original.engine.inspectProvenance({ select: 'status' });
    if (identity.select !== 'status' || identity.vault_namespace !== row.vault_namespace) throw new Error('GUARD_CONFLICT');
    if (row.phase === 'awaiting_recovery') update({ phase: row.resume_phase ?? 'preparing', resume_phase: null });
    let predecessor = row.predecessor_attempt_id ?? undefined;
    if (row.phase !== 'queued') {
      const inspected = await original.engine.inspectProvenance({ select: 'attempt', attempt_key: row.attempt_key, ...attemptFlow(request) });
      if (inspected.select !== 'attempt') throw new Error('ENGINE_UNAVAILABLE');
      const attempt = inspected.attempt;
      if (attempt?.state === 'committed' && attempt.output) { committed(attempt.output); return; }
      if (row.phase === 'dispatch_intent') {
        update({ phase: 'uncertain', message: 'The model call may have run. No automatic retry will be made. Preview again to explicitly start a new request.' }); return;
      }
      if (attempt && (attempt.availability !== 'retained' || Date.parse(attempt.lease_expires_at) <= Date.now()
        || attempt.state === 'failed' || attempt.state === 'abandoned')) {
        update({ phase: 'failed', message: 'The capture is no longer available. Preview again to start a new request.' }); return;
      }
      if (row.phase === 'stage_pending' || row.phase === 'publishing') {
        if (!attempt || !row.stage_json || !row.publication_json) throw new Error('CAPTURE_LOST');
        await publish(original, row, update, committed); return;
      }
      if (row.phase === 'preparing' && attempt) {
        // No dispatch intent was durably recorded: the old prepared call was never released.
        predecessor = attempt.derivation_id;
        // Persist replacement identity BEFORE remote abandonment. Abandon is
        // idempotent; a lost reply resumes this transition, not the old attempt.
        update({ attempt_key: randomUUID(), predecessor_attempt_id: predecessor, lease_expires_at: null });
      }
    }
    if (predecessor) await original.engine.transitionProvenance({ derivation_id: predecessor, action: 'abandon', expected_state: 'prepared' });
    const deps = original.refreshDeps ? await original.refreshDeps() : original;
    // Validate the snapshot actually used to assemble/dispatch, not a second reload.
    await validateGuard({ ...deps, refreshDeps: undefined }, request);
    update({ phase: 'preparing', message: `Gathering evidence for this ${noun}.` });
    if (pageTarget) {
      await rebuildPage({ deps, original, request, row: () => row, update, committed });
      return;
    }
    const { engine, config } = deps;
    const homePolicy = resolveConfiguredWikiStage(config, deps.llm, 'home');
    const llm = bindWikiStageClient(deps.llm, homePolicy);
    const evidence = await engine.projectEvidence(request.guard.project_id, config.meetingReads, undefined, { includeProvenance: true });
    const wiki: ExistingWiki = evidence.existing_wiki;
    if (wiki.home_id !== request.guard.home_node_id || !wiki.catalog_valid || wiki.topology_hash !== request.guard.topology_hash
      || wiki.subpages.some(p => !p.wiki_scope)) throw new Error('GUARD_CONFLICT');
    const corrections = correctionInputs(db, evidence.project.title);
    const generatedAt = new Date(row.generated_at);
    const prepared = await prepareHomeEvidence({ homePolicy, engine, llm, config, evidence,
      project: { id: request.guard.project_id, title: evidence.project.title, status: evidence.project.status, file_path: evidence.project.file_path },
      pinnedTitles: new Set(wiki.subpages.filter(p => p.wiki_pinned).map(p => p.title)),
      corrections: corrections.map(c => c.note), trackedCorrections: corrections, runRef: row.run_ref, generatedAt,
      readConflicts: memoryIds => keptBothPairsSafe(db, memoryIds) });
    if (!prepared.provenance || !prepared.homeBudget || !llm.previewStructuredCall) throw new Error('CAPTURE_LOST');
    const pageIndex = wiki.subpages.filter(p => p.wiki_state !== 'retired').map(p =>
      ({ target: { node_id: p.id }, title: p.title, scope: p.wiki_scope!, action: 'keep' as const }));
    let dispatchGuardFailure: unknown;
    const capture = new HomeCapture(engine, request.guard.project_id, row.run_ref, false, prepared.provenance,
      generatedAt, HOME_BUDGET_ASSEMBLY, {
        attemptKey: row.attempt_key, predecessorAttemptId: predecessor, recoverTransportErrors: true,
        beforeDispatch: async receipt => {
          try { await validateGuard(original, request); }
          catch (error) { dispatchGuardFailure = error; throw error; }
          update({ phase: 'dispatch_intent', lease_expires_at: receipt.lease_expires_at,
            message: 'Generating this home. One paid model call is authorized.' });
        },
        beforeStage: async (stage) => {
          const publication: WikiReconcileInput = { project: evidence.project.title, project_id: request.guard.project_id,
            reconcile_key: `wiki-reconcile:provenance-v1:${stage.derivation_id}`, pages: [],
            home_refresh: { home_node_id: request.guard.home_node_id, expected_output_revision_id: request.guard.output_revision_id,
              expected_topology_hash: request.guard.topology_hash },
            home: { expected_version: request.guard.home_version, sections: stage.contribution, evidence_hash: evidence.evidence_hash,
              curated_at: row.generated_at, refresh_live: true, provenance: { derivation_id: stage.derivation_id,
                bundle_digest: stage.bundle_digest, contribution_digest: digest(stage.contribution) } }, dry_run: false };
          update({ phase: 'stage_pending', message: 'Saving the generated home.', stage_json: JSON.stringify(stage), publication_json: JSON.stringify(publication) });
        },
      }, prepared.homeBudget.timeZone);
    const homeInput = { ...prepared.homeBudget, generatedAt, evidence: prepared.text, pageIndex,
      wikiContext: { policyVersion: 1 as const, ...homePolicy } };
    const preview = await llm.previewStructuredCall({ ...buildHomeRequest(homeInput), malformedOutputPolicy: 'fail-closed-redacted' });
    if (measureBundle(capturedBundle(preview, prepared.provenance, HOME_BUDGET_ASSEMBLY), prepared.homeBudget.limits)) throw new Error('CAPTURE_LOST');
    await capture.preflight(preview);
    deps.usage?.setContext({ project: evidence.project.title, runRef: row.run_ref, purpose: 'project-home-refresh' });
    const home = await synthesizeHomeOverview(llm, { ...homeInput, onPrepared: capture.onPrepared })
      // Capture/model adapters deliberately redact callback errors. Keep this
      // local guard outcome so a verified conflict is not mistaken for an outage.
      .catch(error => { throw dispatchGuardFailure ?? error; })
      .finally(() => deps.usage?.setContext(null));
    update({ usage_json: home.usageKnown === false ? null : JSON.stringify(home.usage) });
    await capture.stage({ ...home.sections,
      // This operation refreshes all five managed sections, including optional
      // model fields. Retain the unmodified model result as validatedSections.
      at_a_glance: home.sections.at_a_glance ?? '', sources: home.sections.sources ?? '',
      // Keep equal same-day narratives distinguishable without visible ID noise.
      // The durable request ID also keeps staged/replayed bytes identical.
      log_entry: `${home.sections.log_entry}\n<!-- home-refresh-request:${row.request_id} -->`,
    }, home.validatedSections);
    await publish(deps, row, update, committed, true);
    // The refresh asks for memory proposals like a full build does, so keep them (#299). Best
    // effort and only on this direct path: a refresh recovered later no longer has the output.
    await persistMemories(deps.engine, request.guard.home_node_id, home.memories, {
      enabled: config.memoryWriteEnabled, cap: config.memoryWriteCap, dryRun: false,
      evidence: { runRef: row.run_ref, hash: evidence.evidence_hash }, sourceRef: evidence.project.title,
    });
  } catch (error) {
    row = getHomeRefresh(db, id)!;
    if (isHomeRefreshTerminal(row.phase)) return;
    if (error instanceof StructuredCallFailure && error.usage !== undefined) update({ usage_json: JSON.stringify(error.usage) });
    if (error instanceof PageSynthesisError && error.usageKnown !== false) update({ usage_json: JSON.stringify(error.usage) });
    if (isShutdownRefusal(error)) {
      // Refused before dispatch because the server is stopping (#405). The row keeps its last
      // durable phase, so startup recovery resumes the rebuild after the restart.
      return;
    }
    if (isBudgetRefusal(error)) {
      // Waiting would spend the money the owner capped, at a time they didn't choose.
      await terminal('failed', `${budgetRefusalDetail(error)} Nothing was rebuilt. Preview again once there's budget.`);
      return;
    }
    const reason = error instanceof EngineError && error.details && typeof error.details === 'object'
      && 'reason' in error.details ? error.details.reason : error instanceof Error ? error.message : '';
    if (error instanceof EvidenceBudgetError) {
      await terminal('failed', `The required ${noun} evidence exceeds capture limits. Reduce the evidence or adjust capture limits, then preview again before starting a new request.`);
    } else if (reason === 'CAPTURE_LOST' || ['PROVENANCE_REVOKED', 'PROVENANCE_LEASE_EXPIRED', 'PROVENANCE_UNAVAILABLE'].includes(String(reason))) {
      await terminal('failed', 'The capture could not be retained. Preview again to start a new request.');
    } else if (reason === 'PROVENANCE_LIMIT' || error instanceof EngineError && error.code === 'INVALID_PARAMS') {
      await terminal('failed', 'Engine rejected this capture or generated result. Check capture limits and preview again before starting a new request.');
    } else if (reason === 'GUARD_CONFLICT' || reason === 'PROVENANCE_KEY_CONFLICT'
      || error instanceof EngineError && ['STALE_NODE', 'CONFLICT', 'VALIDATION_FAILED', 'CONTENT_HASH_MISMATCH', 'NOT_FOUND'].includes(error.code)) {
      await terminal('conflict', `The ${noun} or confirmed settings changed. Preview again before starting another request.`);
    } else if (error instanceof PageSynthesisError && error.cause instanceof PageRuleError) {
      // A definite outcome, not an uncertain one: both drafts were checked and broke a rule (#474 idea 4).
      await terminal('failed', `The page wasn't published and is unchanged: both drafts broke a rule on what to say (${error.cause.message.replace(/^breaks a rule on what to say: /, '')}).`);
    } else if (row.phase === 'dispatch_intent') {
      update({ phase: 'uncertain', message: 'The model call may have run, but no durable result is available. No automatic paid retry will be made.' });
    } else {
      update({ phase: 'awaiting_recovery', resume_phase: row.phase === 'awaiting_recovery' ? row.resume_phase : row.phase,
        message: 'Waiting to reconnect and recover this request. No extra model call is authorized.' });
    }
  }
}
/** Release unused capacity only for definitive outcomes, never ambiguous dispatch/publication.
 * Like full curation's HomeCapture.fail, offline cleanup falls back to Engine's lease.
 * Re-inspect first: an authoritative committed receipt always wins over a local error. */
async function releaseFailedCapture(deps: CoreDeps, row: HomeRefreshRow): Promise<OutputReceipt | null> {
  try {
    const identity = await deps.engine.inspectProvenance({ select: 'status' });
    if (identity.select !== 'status' || identity.vault_namespace !== row.vault_namespace) return null;
    const inspected = await deps.engine.inspectProvenance({ select: 'attempt', attempt_key: row.attempt_key,
      ...attemptFlow(JSON.parse(row.request_json) as HomeRefreshRequest) });
    if (inspected.select !== 'attempt' || !inspected.attempt) return null;
    const attempt = inspected.attempt;
    if (attempt.state === 'committed') return attempt.output;
    if (attempt.availability === 'retained' && (attempt.state === 'prepared' || attempt.state === 'result_staged'))
      await deps.engine.transitionProvenance({ derivation_id: attempt.derivation_id, action: 'fail', expected_state: attempt.state });
  } catch { /* Never overwrite a possibly committed attempt; its lease bounds unused capacity. */ }
  return null;
}
async function publish(deps: CoreDeps, row: HomeRefreshRow,
  update: (patch: Parameters<typeof transitionHomeRefresh>[3]) => HomeRefreshRow,
  committed: (receipt: OutputReceipt) => unknown, alreadyStaged = false): Promise<void> {
  if (!alreadyStaged) await deps.engine.stageProvenanceResult(JSON.parse(row.stage_json!) as StageRequest);
  const input = JSON.parse(row.publication_json!) as WikiReconcileInput;
  update({ phase: 'publishing', message: `Publishing the captured ${(JSON.parse(row.request_json) as HomeRefreshRequest).guard.page_node_id ? 'page' : 'home'}.` });
  await deps.engine.wikiReconcile({ ...input, dry_run: true });
  const { data } = await deps.engine.wikiReconcile(input);
  if (!data.provenance_receipt) throw new Error('ENGINE_UNAVAILABLE');
  committed(data.provenance_receipt);
}
/** Engine files a page's attempt under its own flow, so a lookup without it finds nothing. */
function attemptFlow(request: HomeRefreshRequest): { flow?: ProvenanceFlow } {
  return request.guard.page_node_id ? { flow: 'project-subpage-v1' } : {};
}

/** The notes the page's current build read, so a changed source reaches the rebuild. Wiki pages are
 *  left out, since the page's own text reaches the model as its current target. */
async function priorSourceIds(engine: CoreDeps['engine'], outputId: string, wiki: ExistingWiki): Promise<string[]> {
  const excluded = new Set([wiki.home_id, ...wiki.subpages.map(page => page.id)]);
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const read: InspectData = await engine.inspectProvenance({ select: 'output', output_revision_id: outputId, limit: 100, ...(cursor ? { cursor } : {}) });
    if (read.select !== 'output') throw new Error('ENGINE_UNAVAILABLE');
    for (const input of read.inputs) {
      if (input.source?.kind === 'node' && !excluded.has(input.source.native_id)) ids.add(input.source.native_id);
    }
    cursor = read.next_cursor;
  } while (cursor);
  return [...ids];
}

/** The current bytes of those notes, with their observations. A note deleted since is just skipped. */
async function readSources(engine: CoreDeps['engine'], ids: readonly string[]): Promise<EngineNode[]> {
  const nodes: EngineNode[] = [];
  for (const id of ids) {
    try { nodes.push(await engine.getNode(id, { includeProvenance: true, includeEmbeds: false })); }
    catch (error) { if (!(error instanceof EngineError && error.code === 'NOT_FOUND')) throw error; }
  }
  return nodes;
}

/** The model sees the page's current text, what its current build read, what's related now and
 *  the memories a full build would pick. The plan is fixed: no planner, so nothing but this page
 *  can change. One paid call writes it; a page with rules on what to say also gets a check of them
 *  after each draft, and one more draft when the first breaks a rule (#474 idea 4), so at most four. */
async function rebuildPage(input: { deps: CoreDeps; original: CoreDeps; request: HomeRefreshRequest; row: () => HomeRefreshRow;
  update: (patch: Parameters<typeof transitionHomeRefresh>[3]) => HomeRefreshRow; committed: (receipt: OutputReceipt) => unknown }): Promise<void> {
  const { deps, original, request, row, update, committed } = input;
  const { engine, config } = deps;
  const guard = request.guard;
  const policy = resolveConfiguredWikiStage(config, deps.llm, 'page');
  const llm = bindWikiStageClient(deps.llm, policy);
  const evidence = await engine.projectEvidence(guard.project_id, config.meetingReads, undefined, { includeProvenance: true });
  const wiki: ExistingWiki = evidence.existing_wiki;
  const page = wiki.subpages.find(candidate => candidate.id === guard.page_node_id);
  if (wiki.home_id !== guard.home_node_id || !wiki.catalog_valid || wiki.topology_hash !== guard.topology_hash
    || wiki.subpages.some(candidate => !candidate.wiki_scope) || !page?.wiki_scope || page.wiki_state !== 'active'
    || page.version !== guard.page_version) throw new Error('GUARD_CONFLICT');
  const scope = page.wiki_scope;
  const prior = await priorSourceIds(engine, guard.output_revision_id, wiki);
  const known = new Set(prior);
  const brief = `Rebuild this page from the current evidence, keeping to its scope: ${scope.facet}.`;
  const gathered = await gatherCapturedRequestedEvidence(engine, config, evidence, { title: page.title, brief });
  const evidenceNodes = [...await readSources(engine, prior), ...gathered.nodes.filter(node => node.body && !known.has(node.id))];
  const project = { id: guard.project_id, title: evidence.project.title, status: evidence.project.status, file_path: evidence.project.file_path };
  // Dated and sourced, newest first, as a full build shows them (#474 idea 4). A rebuild that is
  // prepared again after a restart gathers its evidence afresh, so nothing here is saved.
  const memories = labelProjectMemories(await requestMemories(engine, project, evidence, gathered.related, true),
    evidence, evidenceNodes, gathered.related, config.curatorTz);
  const plan: TopologyPlan = { reviewed_page_ids: wiki.subpages.map(candidate => candidate.id), actions: wiki.subpages.map(candidate =>
    candidate.id === page.id ? { op: 'refresh' as const, node_id: page.id, scope, synthesis_brief: brief }
      : { op: 'keep' as const, node_id: candidate.id, scope: candidate.wiki_scope! }) };
  const current = row();
  const generatedAt = new Date(current.generated_at);
  let dispatchGuardFailure: unknown;
  let captureRefusal: unknown;
  // The draft before a rule-driven retry, whose capture the retry fails.
  let previousCapture: PageCapture | undefined;
  deps.usage?.setContext({ project: evidence.project.title, runRef: current.run_ref, purpose: 'project-page-refresh' });
  const built = await synthesizeAcceptedPages(llm, engine, {
    generatedAt, timeZone: config.curatorTz, model: policy.model, maxTokens: policy.maxTokens, plan, existingWiki: wiki, evidenceNodes,
    system: pageRefreshSystem(deps), bodyCharCap: config.bodyCharCap,
    wikiContext: { policyVersion: 1 as const, ...policy },
    ...(memories.length ? { memories } : {}),
    contacts: evidence.contacts,
    // The memory pairs nothing has settled, as a full build shows them (#474 idea 4).
    conflicts: deps.db ? memoryConflicts(memories, memoryIds => keptBothPairsSafe(deps.db!, memoryIds)) : [],
    checkRules: true,
    // A rule on the page stays while its memory is live, even outside the rebuild's memories.
    loadRuleMemories: async ids => (await engine.listMemoriesWithTotal({ ids, limit: ids.length, includeProvenance: true })).memories,
    captureFactory: async (target, _request, selection) => {
      const retry = previousCapture !== undefined;
      if (previousCapture) {
        // The check found the first draft breaking a rule (#474 idea 4). Its capture is failed in
        // Engine, and a fresh attempt identity is saved before the second is prepared, so recovery
        // and cleanup always find the live one. The row stays in dispatch_intent: a crash now
        // leaves the request uncertain, never re-run.
        await previousCapture.fail();
        update({ attempt_key: randomUUID(), lease_expires_at: null });
      }
      const capture = new PageCapture(engine, { projectId: guard.project_id, runRef: current.run_ref, target,
        generatedAt: selection.generatedAt, dryRun: false, items: selection.items, omissions: selection.omissions,
        timeZone: config.curatorTz }, {
        attemptKey: row().attempt_key,
        beforeDispatch: async receipt => {
          try { await validateGuard(original, request); }
          catch (error) { dispatchGuardFailure = error; throw error; }
          update({ phase: 'dispatch_intent', lease_expires_at: receipt.lease_expires_at,
            message: retry ? 'Writing this page again: the first draft broke a rule on what to say. This is the last authorized draft.'
              : 'Generating this page. One paid model call is authorized, plus a check of its rules on what to say after each draft and one more draft if the first breaks a rule: at most four calls.' });
        },
        beforeStage: async stage => {
          const sections = boundContribution(stage.contribution);
          const publication: WikiReconcileInput = { project: evidence.project.title, project_id: guard.project_id,
            provenance_mode: 'project-subpage-v1', reconcile_key: `wiki-reconcile:provenance-v1:${stage.derivation_id}`,
            page_refresh: { page_node_id: page.id, expected_output_revision_id: guard.output_revision_id, expected_topology_hash: guard.topology_hash },
            pages: [{ op: 'upsert', target: { mode: 'existing', node_id: page.id, expected_version: guard.page_version! },
              scope, kind: page.wiki_kind ?? 'freeform', origin: page.wiki_origin, pinned: page.wiki_pinned, sections,
              provenance: { derivation_id: stage.derivation_id, bundle_digest: stage.bundle_digest, contribution_digest: digest(sections) } }],
            home: { sections: [], evidence_hash: evidence.evidence_hash, curated_at: current.generated_at, refresh_live: true }, dry_run: false };
          update({ phase: 'stage_pending', message: 'Saving the generated page.', stage_json: JSON.stringify(stage), publication_json: JSON.stringify(publication) });
        },
      });
      previousCapture = capture;
      return { fail: async () => { /* The caller's terminal path, or a rule retry, releases it. */ },
        onPrepared: async prepared => {
          try { await capture.onPrepared(prepared); }
          catch (error) { captureRefusal = error; throw error; }
        },
        stage: result => capture.stage(markedForRequest(result, request.request_id)) };
    },
    // Page synthesis redacts capture errors. Without the reason, a refusal that can't change, such
    // as evidence over Engine's limits, would be retried by recovery every 30 seconds indefinitely.
  }).catch(error => { throw dispatchGuardFailure ?? captureRefusal ?? error; }).finally(() => deps.usage?.setContext(null));
  update({ usage_json: JSON.stringify(built.usage) });
  await publish(deps, row(), update, committed, true);
}

/** Keeps equal same-day notes apart without visible ID noise, as the home's log entry does. */
function markedForRequest(result: PageSynthesisResult, requestId: string): PageSynthesisResult {
  return result.log_note === undefined ? result : { ...result, log_note: `${result.log_note.trim()}\n<!-- page-refresh-request:${requestId} -->` };
}

/** A page's contribution as Engine binds it, trimmed and sorted by section name. The digest is
 *  worked out here because the publication has to be saved before Engine replies to the stage. */
function boundContribution(sections: StageRequest['contribution']): StageRequest['contribution'] {
  return sections.map(section => ({ ...section, content: section.content.trim() }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
