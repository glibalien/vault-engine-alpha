import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { admitHomeRefresh, getHomeRefresh, transitionHomeRefresh } from '../src/db/home-refresh.js';
import { recoverHomeRefreshes, readHomeRefreshStatus } from '../src/home-refresh.js';
import { startHomeRefreshRecovery } from '../src/home-refresh-recovery.js';
import { CurationQueue } from '../src/queue.js';
import type { CoreDeps } from '../src/core.js';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'home-refresh-recovery-'));
  const path = join(dir, 'curator.db');
  let db = new Database(path); runMigrations(db);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = { request_id: randomUUID(), confirm_paid: true as const, guard: { version: 1 as const, vault_namespace: 'vault',
    project_id: 'project', home_node_id: 'home', output_revision_id: 'output', home_version: 1, topology_hash: 'topology',
    configuration_digest: 'config', corrections_digest: 'corrections' } };
  admitHomeRefresh(db, request);
  const structuredCall = vi.fn();
  const deps = { db, queue: new CurationQueue(), llm: { structuredCall },
    engine: { inspectProvenance: vi.fn() } } as unknown as CoreDeps;
  return { request, deps, structuredCall,
    reopen: () => { db.close(); db = new Database(path); runMigrations(db); deps.db = db; },
    drain: () => deps.queue.enqueue('drain', async () => {}),
  };
}
it.each(['purged', 'expired'])('clears transient result after reopened %s capture without model work', async availability => {
  const f = fixture();
  transitionHomeRefresh(f.deps.db!, f.request.request_id, 'queued', { phase: 'stage_pending', stage_json: '{"private":"body"}', publication_json: '{"private":"body"}' });
  const attemptKey = getHomeRefresh(f.deps.db!, f.request.request_id)!.attempt_key;
  f.reopen();
  expect(getHomeRefresh(f.deps.db!, f.request.request_id)!.attempt_key).toBe(attemptKey);
  vi.mocked(f.deps.engine.inspectProvenance).mockImplementation(async req => (req.select === 'status'
    ? { select: 'status', vault_namespace: 'vault' }
    : { select: 'attempt', attempt: { state: 'result_staged', availability, lease_expires_at: '2099-01-01' } }) as any);
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.request.request_id).phase).toBe('failed');
  expect(getHomeRefresh(f.deps.db!, f.request.request_id)?.stage_json).toBeNull();
  expect(getHomeRefresh(f.deps.db!, f.request.request_id)?.publication_json).toBeNull();
  expect(f.structuredCall).not.toHaveBeenCalled();
});
it('preserves recovery phase while Engine is unavailable and status never enqueues work', async () => {
  const f = fixture();
  transitionHomeRefresh(f.deps.db!, f.request.request_id, 'queued', { phase: 'publishing', stage_json: '{}', publication_json: '{}' });
  vi.mocked(f.deps.engine.inspectProvenance).mockRejectedValue(Error('connection private detail'));
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.request.request_id)).toMatchObject({ phase: 'awaiting_recovery' });
  expect(getHomeRefresh(f.deps.db!, f.request.request_id)?.resume_phase).toBe('publishing');
  const calls = vi.mocked(f.deps.engine.inspectProvenance).mock.calls.length;
  readHomeRefreshStatus(f.deps, f.request.request_id);
  expect(f.deps.queue.state.depth).toBe(0);
  expect(f.deps.engine.inspectProvenance).toHaveBeenCalledTimes(calls);
  expect(f.structuredCall).not.toHaveBeenCalled();
});
it('stops the recovery timer on shutdown', async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.deps.engine.inspectProvenance).mockRejectedValue(Error('offline'));
  const recovery = startHomeRefreshRecovery(f.deps); await f.drain();
  const before = vi.mocked(f.deps.engine.inspectProvenance).mock.calls.length;
  recovery.stop();
  await vi.advanceTimersByTimeAsync(60_000); await f.drain();
  expect(f.deps.engine.inspectProvenance).toHaveBeenCalledTimes(before);
});

it('clears expired staged text locally while offline, then recovers an already-committed receipt', async () => {
  const f = fixture();
  transitionHomeRefresh(f.deps.db!, f.request.request_id, 'queued', { phase: 'publishing',
    stage_json: '{"private":"generated text"}', publication_json: '{"private":"generated text"}',
    lease_expires_at: '2000-01-01T00:00:00Z' } as any);
  f.reopen();
  vi.mocked(f.deps.engine.inspectProvenance).mockRejectedValue(Error('offline'));
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(getHomeRefresh(f.deps.db!, f.request.request_id)?.stage_json).toBeNull();
  expect(getHomeRefresh(f.deps.db!, f.request.request_id)?.publication_json).toBeNull();
  expect(readHomeRefreshStatus(f.deps, f.request.request_id).phase).toBe('awaiting_recovery');
  vi.mocked(f.deps.engine.inspectProvenance).mockImplementation(async req => (req.select === 'status'
    ? { select: 'status', vault_namespace: 'vault' }
    : { select: 'attempt', attempt: { state: 'committed', availability: 'expired', output: { output_revision_id: 'new' } } }) as any);
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.request.request_id).phase).toBe('committed');
  expect(f.structuredCall).not.toHaveBeenCalled();
});
