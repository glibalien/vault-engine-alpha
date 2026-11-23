import { validateCapturedReceipts } from './reconcile-write-result.js';
import { isBudgetRefusal } from './budget.js';
import { randomUUID } from 'node:crypto';
import { EngineError, type Engine, type WikiReconcileResult } from './engine.js';
import { assertRequestCommitCapacity, liveRequestedCaptures, RequestExecutionExpiredError, type ActivePageRequestExecution, type PageRequestExecution, type RequestedCaptureRecord } from './db/request-execution.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from './llm/types.js';
import { jsonDigest } from './provenance-evidence.js';
import type { Json, PreparedReceipt, StageRequest } from './provenance-types.js';
import { addUsage, ZERO_USAGE } from './pricing.js';
import type { TokenUsage } from './types.js';

export interface RequestExecutionStore {
  read(): PageRequestExecution | null;
  write(expectedGeneration: string | null, next: PageRequestExecution): void;
  clear(expectedGeneration: string): void;
}
export interface RequestedExecutionContext {
  store: RequestExecutionStore;
  runRef: string;
  generatedAt: Date;
  llmFor(llm: LlmClient, key: string): LlmClient;
}
export function activeExecution(store: RequestExecutionStore): ActivePageRequestExecution {
  const value = store.read();
  if (!value || !('snapshot' in value) || value.phase === 'uncertain') throw new Error('REQUEST_EXECUTION_BLOCKED');
  return value;
}
/** Saved call results, each with the frozen stage model that produced it (planner and adjudicator
 *  calls ran on the planning model). Checkpoints without a stage policy used the snapshot model. */
export function savedRequestedCalls(state: ActivePageRequestExecution): Array<readonly [model: string, usage: TokenUsage]> {
  const policy = state.snapshot.config.wikiOutputPolicy;
  const stageModel = (key: string): string | undefined => {
    const stage = key.slice(0, key.indexOf(':'));
    return stage === 'planner' || stage === 'adjudicator' ? policy?.planning.model
      : stage === 'page' ? policy?.page.model : stage === 'home' ? policy?.home.model : undefined;
  };
  return state.calls.flatMap(call => call.result
    ? [[stageModel(call.key) ?? state.snapshot.config.model, call.result.usage] as const] : []);
}

export function savedRequestedUsage(state: ActivePageRequestExecution): TokenUsage {
  return savedRequestedCalls(state).reduce((sum, [, usage]) => addUsage(sum, usage), ZERO_USAGE);
}

export function updateExecution(store: RequestExecutionStore, change: (state: ActivePageRequestExecution) => ActivePageRequestExecution): void {
  const state = activeExecution(store);
  store.write(state.generation, change(state));
}
export async function checkpointRequestedCall(input: {
  store: RequestExecutionStore; key: string; requestDigest: string; invoke: () => Promise<StructuredCallResult>;
}): Promise<StructuredCallResult> {
  const state = activeExecution(input.store);
  const prior = state.calls.find(call => call.key === input.key);
  if (prior && prior.requestDigest !== input.requestDigest) throw new Error('REQUEST_CALL_MISMATCH');
  if (prior?.state === 'result' && prior.result) return structuredClone(prior.result);
  if (prior?.state === 'sent') throw new Error('REQUEST_CALL_UNCERTAIN');
  const call = { key: input.key, requestDigest: input.requestDigest, state: 'sent' as const };
  input.store.write(state.generation, { ...state, phase: 'sent', calls: [...state.calls.filter(c => c.key !== input.key), call] });
  let result: StructuredCallResult;
  try {
    result = await input.invoke();
  } catch (error) {
    // The daily budget refuses before dispatch: nothing was sent, so the call stays retryable.
    if (isBudgetRefusal(error)) {
      const current = activeExecution(input.store);
      input.store.write(state.generation, { ...current, phase: state.phase,
        calls: current.calls.flatMap(c => c.key !== input.key ? [c] : prior ? [prior] : []) });
    }
    throw error;
  }
  const next = activeExecution(input.store);
  if (next.generation !== state.generation) throw new Error('REQUEST_EXECUTION_CONFLICT');
  input.store.write(state.generation, { ...next, calls: next.calls.map(c => c.key === input.key ? { ...c, state: 'result', result } : c) });
  return result;
}

/** Preview preparation persists the receipt before dispatch intent. The adapter's
 * hook only checks equality: it must never prepare the same call a second time. */
export function requestedExecutionContext(store: RequestExecutionStore): RequestedExecutionContext {
  const initial = activeExecution(store);
  const boundStore: RequestExecutionStore = {
    read: () => {
      const current = store.read();
      if (current?.generation !== initial.generation) throw new Error('REQUEST_EXECUTION_CONFLICT');
      return current;
    },
    write: (generation, next) => {
      if (generation !== initial.generation || next.generation !== initial.generation) throw new Error('REQUEST_EXECUTION_CONFLICT');
      store.write(generation, next);
    },
    clear: generation => {
      if (generation !== initial.generation) throw new Error('REQUEST_EXECUTION_CONFLICT');
      store.clear(generation);
    },
  };
  return { store: boundStore, runRef: initial.runRef, generatedAt: new Date(initial.generatedAt),
    llmFor: (llm, key) => ({
      supportsPreparedCapture: llm.supportsPreparedCapture,
      ...(llm.previewStructuredCall ? { previewStructuredCall: llm.previewStructuredCall.bind(llm) } : {}),
      structuredCall: async request => {
        if (activeExecution(store).generation !== initial.generation) throw new Error('REQUEST_EXECUTION_CONFLICT');
        const { onPrepared, ...plain } = request;
        const effective: StructuredCallRequest = { ...plain, malformedOutputPolicy: 'fail-closed-redacted' };
        const preview = llm.previewStructuredCall ? await llm.previewStructuredCall(effective) : undefined;
        if (activeExecution(store).generation !== initial.generation) throw new Error('REQUEST_EXECUTION_CONFLICT');
        const { wikiContext: _context, ...digestRequest } = effective;
        const digest = jsonDigest((preview ?? digestRequest) as unknown as Json);
        const existing = activeExecution(store).calls.find(call => call.key === key);
        if (existing && existing.requestDigest !== digest) throw new Error('REQUEST_CALL_MISMATCH');
        if (!existing || existing.state === 'ready') {
          if (onPrepared) {
            if (!preview) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
            await onPrepared(preview);
          }
        }
        return checkpointRequestedCall({ store: boundStore, key, requestDigest: digest, invoke: () => llm.structuredCall({ ...effective,
          ...(onPrepared ? { onPrepared: async actual => {
            if (jsonDigest(actual as unknown as Json) !== digest) throw new Error('PROVENANCE_PREVIEW_MISMATCH');
          } } : {}),
        }) });
      },
    }),
  };
}

/** A capture's durable record, created on first use. `draft: 2` is a page's second draft after a
 *  rule check sent the first back (#631): its own attempt key, saved before it is prepared. */
export function requestedCaptureCheckpoints(store: RequestExecutionStore, flow: RequestedCaptureRecord['flow'], target?: RequestedCaptureRecord['target'],
  draft?: 2) {
  let record = activeExecution(store).captures.find(c => c.flow === flow && JSON.stringify(c.target) === JSON.stringify(target) && c.draft === draft);
  if (!record) {
    record = { flow, attemptKey: randomUUID(), ...(target ? { target } : {}), ...(draft ? { draft } : {}) };
    const created = record;
    updateExecution(store, state => ({ ...state, captures: [...state.captures, created] }));
  }
  const attemptKey = record.attemptKey;
  return {
    attemptKey,
    beforeDispatch: async (receipt: PreparedReceipt) => updateExecution(store, state => ({ ...state,
      expiresAt: new Date(Math.min(Date.parse(state.expiresAt), Date.parse(receipt.lease_expires_at))).toISOString(),
      captures: state.captures.map(c => c.attemptKey === attemptKey ? { ...c, receipt } : c),
    })),
    beforeStage: async (stageRequest: StageRequest) => updateExecution(store, state => ({ ...state,
      captures: state.captures.map(c => c.attemptKey === attemptKey && c.receipt?.state === 'prepared' ? { ...c, stageRequest } : c),
    })),
    afterStage: async () => updateExecution(store, state => ({ ...state, captures: state.captures.map(c => {
      if (c.attemptKey !== attemptKey || !c.receipt) return c;
      const { stageRequest: _discard, ...retained } = c;
      return { ...retained, receipt: { ...c.receipt, state: 'result_staged' } };
    }) })),
  };
}

/** Cleanup is best effort, but must not race a replacement request or cancel a
 * possibly submitted batch. An authoritative stale rejection proves nonpublication.
 * Engine's expected-state transition closes the inspection-to-commit race. */
async function abandon(engine: Engine, store: RequestExecutionStore, state: ActivePageRequestExecution,
  errorCode: string, rejectedBeforePublication = false): Promise<'blocked'> {
  if (!state.result && !state.captures.some(c => c.receipt?.state === 'committed')
    && (!state.reconcile || rejectedBeforePublication)) {
    for (const capture of state.captures) {
      try {
        if (store.read()?.generation !== state.generation) break;
        const inspected = await engine.inspectProvenance({ select: 'attempt', flow: capture.flow, attempt_key: capture.attemptKey });
        if (store.read()?.generation !== state.generation) break;
        if (inspected.select !== 'attempt') continue;
        const attempt = inspected.attempt;
        if (!attempt || attempt.availability !== 'retained'
          || (attempt.state !== 'prepared' && attempt.state !== 'result_staged')
          || (capture.receipt && (attempt.derivation_id !== capture.receipt.derivation_id
            || attempt.bundle_digest !== capture.receipt.bundle_digest))) continue;
        await engine.transitionProvenance({ derivation_id: attempt.derivation_id, action: 'abandon', expected_state: attempt.state });
      } catch { /* Primary failure wins; unavailable cleanup falls back to the lease. */ }
    }
  }
  store.write(state.generation, { version: 1, generation: state.generation, projectId: state.projectId,
    runRef: state.runRef, generatedAt: state.generatedAt, phase: 'failed', errorCode });
  return 'blocked';
}
/** Only completed, unpublishable results can be discarded here. A saved
 * reconciliation may have committed despite a lost response; retain it. */
export async function abandonInvalidRequestedResult(engine: Engine, store: RequestExecutionStore): Promise<boolean> {
  const state = activeExecution(store);
  if (state.reconcile || state.result || state.captures.some(c => c.receipt?.state === 'committed')
    || !state.calls.length || state.calls.some(c => c.state !== 'result' || !c.result)) return false;
  await abandon(engine, store, state, 'REQUEST_RESULT_INVALID');
  return true;
}
export function validateRequestedCommit(state: ActivePageRequestExecution, result: WikiReconcileResult): void {
  const receipts = result.provenance_receipts ?? [];
  const captures = liveRequestedCaptures(state);
  if (!state.reconcile || result.dry_run || result.reconcile_key !== state.reconcile.reconcile_key
    || receipts.length !== captures.length || captures.some(c => !c.receipt ||
      !receipts.some(r => r.derivation_id === c.receipt!.derivation_id && r.reconcile_key === result.reconcile_key))) {
    throw new Error('REQUEST_COMMIT_MISMATCH');
  }
  validateCapturedReceipts({ provenanceMode: 'project-subpage-v1', dryRun: false, provenance: state.reconcile.home.provenance },
    state.reconcile.reconcile_key, result, state.reconcile.pages);
}
function isDefinitiveStaleRejection(error: unknown): boolean {
  if (!(error instanceof EngineError) || error.code !== 'STALE_NODE'
    || !error.details || typeof error.details !== 'object') return false;
  const details = error.details as { reason?: unknown; issues?: unknown };
  if (details.reason === 'PROVENANCE_OBSERVATION_CHANGED') return true;
  return Array.isArray(details.issues) && details.issues.some(issue => issue && typeof issue === 'object'
    && (issue.code === 'EXPECTED_VERSION_MISMATCH' || issue.code === 'HOME_EXPECTED_VERSION_MISMATCH'));
}
/** Only typed prepublication rejections may erase checkpoints. Known commits
 * take precedence over a contradictory rejection and remain available for repair. */
export async function abandonDefinitiveStaleRejection(engine: Engine, store: RequestExecutionStore, state: ActivePageRequestExecution,
  error: unknown, knownCommitted = false): Promise<boolean> {
  if (knownCommitted || state.result || state.captures.some(c => c.receipt?.state === 'committed')
    || !isDefinitiveStaleRejection(error)) return false;
  await abandon(engine, store, state, 'REQUEST_PROJECT_CHANGED', true);
  return true;
}
export async function recoverRequestedPage(engine: Engine, store: RequestExecutionStore): Promise<'start' | 'resume' | 'committed' | 'blocked'> {
  let state: PageRequestExecution | null;
  try { state = store.read(); }
  catch (error) {
    // Core atomically marks the public request failed and clears using this
    // generation. A standalone recovery must not clear to a retryable null.
    if (error instanceof RequestExecutionExpiredError) return 'blocked';
    throw error;
  }
  if (!state) return 'start';
  if (state.phase === 'failed') return 'blocked';
  if (!('snapshot' in state)) return 'committed';
  if (Date.parse(state.expiresAt) <= Date.now()) return abandon(engine, store, state, 'REQUEST_EXECUTION_EXPIRED');
  if (state.phase === 'uncertain' || state.calls.some(c => c.state === 'sent')) return abandon(engine, store, state, 'REQUEST_CALL_UNCERTAIN');
  let knownCommitted = !!state.result;
  const live = new Set(liveRequestedCaptures(state));
  for (const capture of state.captures) {
    const inspected = await engine.inspectProvenance({ select: 'attempt', flow: capture.flow, attempt_key: capture.attemptKey });
    if (inspected.select !== 'attempt') throw new Error('REQUEST_CAPTURE_UNAVAILABLE');
    const attempt = inspected.attempt;
    if (!live.has(capture)) {
      // A first draft the rule check sent back (#631) is never staged, so it can't have been
      // published. It is failed in Engine, or is failed when the second draft is resumed.
      if (attempt?.state === 'committed') return abandon(engine, store, state, 'REQUEST_COMMIT_MISMATCH');
      continue;
    }
    if (!attempt && !capture.receipt) continue;
    if (!attempt || attempt.availability !== 'retained' || Date.parse(attempt.lease_expires_at) <= Date.now()
      || attempt.state === 'failed' || attempt.state === 'abandoned') return abandon(engine, store, state, 'REQUEST_CAPTURE_UNAVAILABLE');
    if (capture.receipt && (attempt.derivation_id !== capture.receipt.derivation_id || attempt.bundle_digest !== capture.receipt.bundle_digest))
      return abandon(engine, store, state, 'REQUEST_CAPTURE_MISMATCH');
    if (attempt.state === 'committed' && !state.reconcile) return abandon(engine, store, state, 'REQUEST_COMMIT_MISMATCH');
    if (attempt.state === 'committed') knownCommitted = true;
  }
  if (state.reconcile) {
    if (!knownCommitted) assertRequestCommitCapacity(state);
    let committed;
    try { committed = await engine.wikiReconcile(state.reconcile); }
    catch (error) {
      // Only an authoritative prepublication rejection can abandon this exact
      // request. Transport ambiguity or any known commit must remain replayable.
      if (await abandonDefinitiveStaleRejection(engine, store, state, error, knownCommitted)) return 'blocked';
      throw error;
    }
    validateRequestedCommit(state, committed.data);
    store.write(state.generation, { ...state, result: committed.data });
    return 'committed';
  }
  const current = await engine.projectEvidence(state.projectId, state.snapshot.config.meetingReads);
  const prior = state.snapshot.existingWiki;
  if (current.project.id !== state.projectId || current.evidence_hash !== state.snapshot.evidenceHash
    || current.existing_wiki.topology_hash !== prior.topology_hash
    || current.existing_wiki.home?.version !== prior.home?.version
    || JSON.stringify(current.existing_wiki.subpages) !== JSON.stringify(prior.subpages)) {
    return abandon(engine, store, state, 'REQUEST_PROJECT_CHANGED');
  }
  return 'resume';
}
