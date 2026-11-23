import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { setPaused } from '../src/db/control.js';
import { registerWikiRoot } from '../src/db/wiki-roots.js';
import { EngineError, type WikiStatus, type WikiStatusResult } from '../src/engine.js';
import { CurationQueue } from '../src/queue.js';
import {
  buildStatusTracker, failedStatus, pausedStatus, resumedStatus, stampPause, startupStatus,
  startWikiStatusSync, syncWikiStatuses,
} from '../src/wiki-status.js';
import type { CurateResult } from '../src/types.js';

/** An Engine `wiki-status` over a map of homes keyed by root. */
function fakeEngine(homes: Record<string, { status: WikiStatus | null; built?: boolean } | null>) {
  const versions = new Map<string, number>();
  const calls: Array<{ root: string; status?: WikiStatus }> = [];
  const engine = {
    calls,
    homes,
    wikiStatus: vi.fn(async (root: string, status?: WikiStatus): Promise<WikiStatusResult> => {
      calls.push({ root, ...(status === undefined ? {} : { status }) });
      if (!(root in homes)) throw new EngineError('NOT_FOUND', `no root ${root}`);
      const home = homes[root];
      if (!home) return { root_id: root, home_node_id: null, status: null, version: null, built: false, written: false };
      const version = versions.get(root) ?? 1;
      if (status === undefined || status === home.status) {
        return { root_id: root, home_node_id: `${root}-home`, status: home.status, version, built: home.built ?? true, written: false };
      }
      const previous = home.status;
      home.status = status;
      versions.set(root, version + 1);
      return { root_id: root, home_node_id: `${root}-home`, previous_status: previous, status, version: version + 1, built: home.built ?? true, written: true };
    }),
  };
  return engine;
}

function curatorDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function register(db: Database.Database, title: string, kind: 'project' | 'topic' = 'project'): void {
  registerWikiRoot(db, { root_title: title, root_node_id: `${title}-id`, kind, source: 'vault', cadence: null, brief: null,
    created_at: '2026-11-15T00:00:00Z', created_by: null });
}

const written = { project: 'Alpha', outcome: 'written', dryRun: false } as CurateResult;
const errored = { project: 'Alpha', outcome: 'error', dryRun: false } as CurateResult;

describe('wiki status transitions (#547)', () => {
  it('pausing keeps behind as paused-behind and leaves a build under way alone', () => {
    expect(pausedStatus('current')).toBe('paused');
    expect(pausedStatus('failed')).toBe('paused');
    expect(pausedStatus(null)).toBe('paused');
    expect(pausedStatus('behind')).toBe('paused-behind');
    expect(pausedStatus('paused-behind')).toBe('paused-behind');
    expect(pausedStatus('building')).toBeNull();
  });

  it('resuming makes paused current and paused-behind behind', () => {
    expect(resumedStatus('paused')).toBe('current');
    expect(resumedStatus('paused-behind')).toBe('behind');
    for (const other of ['current', 'behind', 'building', 'failed', null] as const) expect(resumedStatus(other)).toBeNull();
  });

  it('a failed build is failed, or keeps a paused wiki\'s own status', () => {
    expect(failedStatus('behind', false)).toBe('failed');
    expect(failedStatus('paused-behind', true)).toBe('paused-behind');
    expect(failedStatus('paused', true)).toBe('paused');
    expect(failedStatus(null, true)).toBe('paused');
  });

  it('settles a leftover building, a missing status and one the pause table disagrees with', () => {
    expect(startupStatus('building', false, true)).toBe('current');
    expect(startupStatus('building', false, false)).toBe('failed');
    expect(startupStatus('building', true, true)).toBe('paused');
    expect(startupStatus(null, true, false)).toBe('paused');
    expect(startupStatus(null, false, true)).toBe('current');
    expect(startupStatus(null, false, false)).toBeNull();
    expect(startupStatus('behind', true, true)).toBe('paused-behind');
    expect(startupStatus('paused-behind', false, true)).toBe('behind');
    expect(startupStatus('paused-behind', true, true)).toBeNull();
    expect(startupStatus('current', false, true)).toBeNull();
  });
});

describe('build status tracker (#547)', () => {
  it('marks the home building', async () => {
    const engine = fakeEngine({ 'Alpha-id': { status: 'behind' } });
    const tracker = buildStatusTracker({ engine, db: curatorDb() }, 'Alpha', 'Alpha-id');

    await tracker.hooks.onBuildStart('Alpha-home');
    expect(engine.homes['Alpha-id']?.status).toBe('building');
  });

  it('reads the pause table when the build writes its home, so a pause during the build holds', () => {
    const db = curatorDb();
    const tracker = buildStatusTracker({ engine: fakeEngine({}), db }, 'Alpha', 'Alpha-id');
    expect(tracker.hooks.homeStatus).toBe('current');
    setPaused(db, 'Alpha', true, null, '2026-11-15T00:00:00Z');
    expect(tracker.hooks.homeStatus).toBe('paused');
  });

  it('marks a build that started and did not write failed', async () => {
    const engine = fakeEngine({ 'Alpha-id': { status: 'behind' } });
    const tracker = buildStatusTracker({ engine, db: curatorDb() }, 'Alpha', 'Alpha-id');
    await tracker.hooks.onBuildStart('Alpha-home');

    await tracker.finish(errored);

    expect(engine.homes['Alpha-id']?.status).toBe('failed');
  });

  it('gives a paused wiki whose forced build failed its paused status back', async () => {
    const db = curatorDb();
    setPaused(db, 'Alpha', true, null, '2026-11-15T00:00:00Z');
    const engine = fakeEngine({ 'Alpha-id': { status: 'paused-behind' } });
    const tracker = buildStatusTracker({ engine, db }, 'Alpha', 'Alpha-id');
    await tracker.hooks.onBuildStart('Alpha-home');

    await tracker.finish(errored);

    expect(engine.homes['Alpha-id']?.status).toBe('paused-behind');
  });

  it('settles a written build the Engine did not stamp, and leaves one it did', async () => {
    const engine = fakeEngine({ 'Alpha-id': { status: 'current' } });
    const tracker = buildStatusTracker({ engine, db: curatorDb() }, 'Alpha', 'Alpha-id');
    await tracker.hooks.onBuildStart('Alpha-home');
    await tracker.finish(written);
    expect(engine.homes['Alpha-id']?.status).toBe('current');

    await tracker.hooks.onBuildStart('Alpha-home');
    engine.homes['Alpha-id']!.status = 'behind'; // the Engine's check after the build's own stamp
    const before = engine.calls.length;
    await tracker.finish(written);
    expect(engine.calls.slice(before)).toEqual([{ root: 'Alpha-id' }]);
    expect(engine.homes['Alpha-id']?.status).toBe('behind');
  });

  it('writes nothing after a build that never started', async () => {
    const engine = fakeEngine({ 'Alpha-id': { status: 'current' } });
    const tracker = buildStatusTracker({ engine, db: curatorDb() }, 'Alpha', 'Alpha-id');
    await tracker.finish(errored);
    expect(engine.calls).toEqual([]);
  });

  it('never fails the build when the Engine refuses', async () => {
    const engine = { wikiStatus: vi.fn(async () => { throw new EngineError('CONFLICT', 'unread edit'); }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = buildStatusTracker({ engine, db: curatorDb() }, 'Alpha', 'Alpha-id');
    await expect(tracker.hooks.onBuildStart('Alpha-home')).resolves.toBeUndefined();
    await expect(tracker.finish(errored)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('pause stamps (#547)', () => {
  it('writes paused-behind when pausing a behind wiki, and behind when resuming it', async () => {
    const db = curatorDb();
    register(db, 'Alpha');
    const engine = fakeEngine({ 'Alpha-id': { status: 'behind' } });

    expect(await stampPause({ engine, db }, 'Alpha', true)).toBe('paused-behind');
    expect(await stampPause({ engine, db }, 'Alpha', false)).toBe('behind');
  });

  it('finds an unregistered wiki by its title, and reports nothing when it has no home', async () => {
    const engine = fakeEngine({ Beta: null });
    expect(await stampPause({ engine, db: curatorDb() }, 'Beta', true)).toBeNull();
    expect(engine.calls).toEqual([{ root: 'Beta' }]);
  });
});

describe('startup status check (#547)', () => {
  it('settles every registered wiki and skips one the Engine refuses', async () => {
    const db = curatorDb();
    register(db, 'Alpha');
    register(db, 'Gone');
    register(db, 'Garden', 'topic');
    setPaused(db, 'Garden', true, null, '2026-11-15T00:00:00Z');
    const engine = fakeEngine({ 'Alpha-id': { status: 'building' }, 'Garden-id': { status: null, built: false } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.fn();

    expect(await syncWikiStatuses({ engine, db }, log)).toBe(true);

    warn.mockRestore();
    expect(engine.homes['Alpha-id']?.status).toBe('current');
    expect(engine.homes['Garden-id']?.status).toBe('paused');
    expect(log).toHaveBeenCalledWith('wiki status: set the status of 2 wiki home(s)');
  });

  it('tries again later when the Engine cannot be reached', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = curatorDb();
      register(db, 'Alpha');
      let reachable = false;
      const fake = fakeEngine({ 'Alpha-id': { status: null } });
      const engine = { wikiStatus: vi.fn(async (root: string, status?: WikiStatus) => {
        if (!reachable) throw new Error('fetch failed');
        return fake.wikiStatus(root, status);
      }) };
      const kept: Promise<unknown>[] = [];
      const sync = startWikiStatusSync({ engine, db, queue: new CurationQueue() }, () => {}, work => { kept.push(work); },
        { retryMs: 1_000, everyMs: 60_000 });
      await Promise.all(kept);
      expect(fake.homes['Alpha-id']?.status).toBeNull();

      reachable = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(kept);
      expect(fake.homes['Alpha-id']?.status).toBe('current');

      // Later passes put right a status that went wrong in between.
      fake.homes['Alpha-id']!.status = 'building';
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all(kept);
      expect(fake.homes['Alpha-id']?.status).toBe('current');
      sync.stop();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
