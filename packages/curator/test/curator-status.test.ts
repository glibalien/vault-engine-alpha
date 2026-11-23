import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { recordRun, type RunRowInsert } from '../src/db/runs.js';
import { makeCuratorStatusHandler } from '../src/tools/curator-status.js';
import { CurationQueue } from '../src/queue.js';
import { setPaused, addCorrection } from '../src/db/control.js';
import { registerWikiRoot } from '../src/db/wiki-roots.js';
import {
  commitTopicRefreshBaseline,
  replaceExplicitTopicRefreshSources,
  storeTopicProbeCache,
} from '../src/db/topic-refresh.js';
import { buildCanonicalWebProbe } from '../src/topic-refresh-evidence.js';

const config = {
  curatorSweepAt: '05:00', curatorTz: 'UTC',
  staleProjectDays: 14, staleSkipStatuses: [], topicEarlyRefreshEnabled: false,
};

function deps(db: Database.Database, wikiReconciliationMode: 'off' | 'dry-run' | 'live' = 'off') {
  return { engine: {} as never, llm: {} as never, config: { ...config, wikiReconciliationMode } as never, queue: new CurationQueue(), db };
}

const base: RunRowInsert = {
  ts: '', project: '', trigger: 'scheduled', dry_run: 0, outcome: 'written',
  evidence_hash: 'h', wiki_curated_at: null, home_written: 1,
  spine_written: 1, spine_total: 1, themed_created: 0, themed_retired: 0,
  input_tokens: 100, output_tokens: 50, cache_read: 10, cache_write: 5,
  cost_usd: 0.01, duration_ms: 1234, error: null,
  topology_json: null,
  refresh_trigger: null, refresh_evidence_json: null,
};

const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

async function call(handler: ReturnType<typeof makeCuratorStatusHandler>, scopes: string[]) {
  return handler({ limit: 20, window_hours: 168 }, { authInfo: { scopes } });
}

describe('curator-status', () => {
  it('lists the project wikis the curator was asked to keep', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: 'Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-25T00:00:00Z', created_by: 'client-1' });
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.project_wikis).toEqual([{ project: 'Atlas', root_node_id: 'p-1', created_at: '2026-10-25T00:00:00Z',
      created_by: 'client-1', last_curated_at: null }]);
    expect(body.topics).toEqual([]);
    db.close();
  });

  it('reports today\'s budget cap, spend and remaining allowance', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const status = async (dailyBudgetCents: number | null, budget?: { remainingUsd(): Promise<number | null> }) => {
      const d = { ...deps(db), config: { ...config, wikiReconciliationMode: 'off', dailyBudgetCents } as never, ...(budget ? { budget } : {}) };
      const res = await call(makeCuratorStatusHandler(d, new Date()), ['curate:read']);
      return JSON.parse(res.content[0]!.text).daily_budget;
    };
    expect(await status(100, { remainingUsd: async () => 0.62 })).toEqual({ cap_usd: 1, spent_usd: 0.38, remaining_usd: 0.62 });
    expect(await status(100, { remainingUsd: async () => -0.05 })).toEqual({ cap_usd: 1, spent_usd: 1.05, remaining_usd: 0 });
    expect(await status(100, { remainingUsd: async () => { throw new Error('engine down'); } }))
      .toEqual({ cap_usd: 1, spent_usd: null, remaining_usd: null, unavailable: true });
    expect(await status(null)).toEqual({ cap_usd: null, spent_usd: null, remaining_usd: null });
    db.close();
  });


  it('reports each exact wiki reconciliation mode', async () => {
    for (const wikiReconciliationMode of ['off', 'dry-run', 'live'] as const) {
      const db = new Database(':memory:'); runMigrations(db);
      const res = await call(makeCuratorStatusHandler(deps(db, wikiReconciliationMode), new Date()), ['curate:read']);
      const body = JSON.parse(res.content[0]!.text);
      expect(body.server.wiki_reconciliation_mode).toBe(wikiReconciliationMode);
      db.close();
    }
  });

  it('rejects a caller without curate:read', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:trigger']);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('FORBIDDEN');
    db.close();
  });

  it('returns runs, latest-per-project, aggregate, and server health', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    // Run timestamps must be relative to now: the aggregate window is measured
    // from the real clock (curator-status uses `new Date()`, not the injected
    // start time), so absolute fixture dates age out of the 168h window and the
    // run_count/input_tokens aggregate silently drops to 0 once they're >7d old.
    const t1 = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const t2 = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const t3 = new Date(Date.now() - 1 * 3_600_000).toISOString();
    recordRun(db, { ...base, ts: t1, project: 'A', wiki_curated_at: recent });
    recordRun(db, { ...base, ts: t2, project: 'A', wiki_curated_at: old });
    recordRun(db, { ...base, ts: t3, project: 'B', wiki_curated_at: null });
    const res = await call(makeCuratorStatusHandler(deps(db), new Date('2026-06-07T00:00:00.000Z')), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.recent_runs).toHaveLength(3);
    expect(body.recent_runs[0].project).toBe('B'); // newest ts first
    expect(body.projects).toHaveLength(2); // latest per project
    const a = body.projects.find((p: { project: string }) => p.project === 'A');
    expect(a.last_run_at).toBe(t2); // newest A row
    expect(a.stale).toBe(true); // its wiki_curated_at is 40d old
    expect(body.aggregate.run_count).toBe(3);
    expect(body.aggregate.input_tokens).toBe(300);
    expect(body.aggregate.window_hours).toBe(168);
    expect(body.queue).toMatchObject({ running: false, depth: 0 });
    expect(typeof body.server.next_sweep_at).toBe('string');
    expect(body.server.last_sweep_at).toBe(t3);
    expect(body.server.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.requests).toEqual({ pending: 0, fulfilled: 0, failed: 0 });
    db.close();
  });

  describe('project (#372)', () => {
    const ask = async (d: ReturnType<typeof deps>, project: string) => JSON.parse((await makeCuratorStatusHandler(d, new Date())(
      { limit: 20, window_hours: 168, project }, { authInfo: { scopes: ['curate:read'] } } as never)).content[0]!.text);
    const withModels = (db: Database.Database) => ({ ...deps(db), config: { ...config, wikiReconciliationMode: 'off',
      model: 'shared', wikiPageModel: 'pages', dailyBudgetCents: null } as never });

    it('returns only that wiki, without topology or the rest of the status', async () => {
      const db = new Database(':memory:'); runMigrations(db);
      recordRun(db, { ...base, ts: recent, project: 'Other', outcome: 'written' });
      recordRun(db, { ...base, ts: recent, project: 'Wiki', outcome: 'written', cost_usd: 0.25, topology_json: '{"actions":[]}' });
      recordRun(db, { ...base, ts: recent, project: 'Wiki', outcome: 'skipped_budget', cost_usd: null });
      recordRun(db, { ...base, ts: recent, project: 'Wiki', outcome: 'would_curate', dry_run: 1 });

      const body = await ask(withModels(db), 'Wiki');

      expect(body).toMatchObject({ project: 'Wiki', in_progress: null, paused: false,
        models: { planning: 'shared', page: 'pages', home: 'shared' },
        latest_run: { outcome: 'skipped_budget' }, last_written: { outcome: 'written', cost_usd: 0.25 } });
      expect(body.latest_run.id).toBeGreaterThan(body.last_written.id);
      expect(JSON.stringify(body)).not.toContain('topology');
      expect(body.recent_runs).toBeUndefined();
      expect(body.control).toBeUndefined();
      db.close();
    });

    it('says when a build is queued or running', async () => {
      const db = new Database(':memory:'); runMigrations(db);
      const d = withModels(db);
      const builds = { get: (key: string) => (key === 'project:Wiki' ? { since: recent, projectId: null } : undefined) };
      const body = await ask({ ...d, builds } as never, 'Wiki');
      expect(body.in_progress).toEqual({ since: recent });
      expect(await ask({ ...d, builds } as never, 'Other')).toMatchObject({ in_progress: null, latest_run: null, last_written: null });
      db.close();
    });

    it('reports a paused wiki', async () => {
      const db = new Database(':memory:'); runMigrations(db);
      setPaused(db, 'Wiki', true, null, recent);
      expect((await ask(withModels(db), 'Wiki')).paused).toBe(true);
      db.close();
    });

    it('says whether the title is a project wiki, a topic wiki with its source, or neither (#425)', async () => {
      const db = new Database(':memory:'); runMigrations(db);
      registerWikiRoot(db, { root_title: 'Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
        brief: null, created_at: recent, created_by: null });
      registerWikiRoot(db, { root_title: 'Tidal Power', root_node_id: 't-1', kind: 'topic', source: 'vault+web', cadence: '7d',
        brief: 'Tidal energy.', created_at: recent, created_by: null });
      registerWikiRoot(db, { root_title: 'Garden', root_node_id: null, kind: 'topic', source: 'vault', cadence: null,
        brief: null, created_at: recent, created_by: null });
      const d = withModels(db);
      expect(await ask(d, 'Atlas')).toMatchObject({ kind: 'project', root_node_id: 'p-1', source: null });
      expect(await ask(d, 'Tidal Power')).toMatchObject({ project: 'Tidal Power', kind: 'topic', root_node_id: 't-1', source: 'vault+web' });
      expect(await ask(d, 'Garden')).toMatchObject({ kind: 'topic', root_node_id: null, source: 'vault' });
      expect(await ask(d, 'Unknown')).toMatchObject({ kind: null, root_node_id: null, source: null });
      db.close();
    });
  });

  it('excludes dry-run rows from last_sweep_at', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    recordRun(db, { ...base, dry_run: 1, ts: '2026-06-07T05:00:00.000Z', project: 'A' });
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.server.last_sweep_at).toBeNull();
    db.close();
  });

  it('leaves topology out of recent_runs and says which runs have one', async () => {
    // Given
    const db = new Database(':memory:'); runMigrations(db);
    recordRun(db, { ...base, ts: recent, project: 'with', topology_json: JSON.stringify({ actions: [{ action: 'created' }] }) });
    recordRun(db, { ...base, ts: recent, project: 'without', topology_json: null });

    // When
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    const runs = body.recent_runs as Array<Record<string, unknown>>;

    // Then
    expect(runs.every(run => !('topology' in run) && !('topology_json' in run))).toBe(true);
    expect(runs.find(run => run['project'] === 'with')?.['has_topology']).toBe(true);
    expect(runs.find(run => run['project'] === 'without')?.['has_topology']).toBe(false);
    expect('run_topology' in body).toBe(false);
    db.close();
  });

  it('returns one run\'s topology on request, and null for bad JSON or an unknown run', async () => {
    // Given
    const db = new Database(':memory:'); runMigrations(db);
    recordRun(db, { ...base, ts: recent, project: 'valid', topology_json: JSON.stringify({ actions: [{ action: 'created' }] }) });
    recordRun(db, { ...base, ts: recent, project: 'bad', topology_json: '{bad' });
    const handler = makeCuratorStatusHandler(deps(db), new Date());
    const ask = async (id: number) => JSON.parse((await handler({ limit: 1, window_hours: 24, topology_run_id: id }, {
      authInfo: { scopes: ['curate:read'], clientId: 'c', token: 't' },
    } as never)).content[0]!.text).run_topology;

    // Then
    expect(await ask(1)).toEqual({ run_id: 1, project: 'valid', ts: recent, topology: { actions: [{ action: 'created' }] } });
    expect((await ask(2)).topology).toBeNull();
    expect(await ask(99)).toBeNull();
    db.close();
  });

  it('does not expose private refresh evidence or web hashes in recent runs', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const committedWebHash = 'a'.repeat(64);
    const currentWebHash = 'b'.repeat(64);
    recordRun(db, {
      ...base,
      ts: recent,
      project: 'Topic',
      refresh_trigger: 'not_due',
      refresh_evidence_json: JSON.stringify({
        committed_web_hash: committedWebHash,
        current_web_hash: currentWebHash,
      }),
    });

    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);

    expect(body.recent_runs[0]).not.toHaveProperty('refresh_evidence_json');
    expect(JSON.stringify(body)).not.toContain(committedWebHash);
    expect(JSON.stringify(body)).not.toContain(currentWebHash);
    db.close();
  });

  it('reflects paused wikis and active corrections in the control section', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    setPaused(db, 'A', true, 'tester', new Date().toISOString());
    addCorrection(db, { project_title: 'A', note: 'stop tracking X', created_by: null, created_at: new Date().toISOString() });
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.control.paused).toEqual([
      { project: 'A', paused_at: expect.any(String), paused_by: 'tester' },
    ]);
    expect(body.control.corrections).toHaveLength(1);
    expect(body.control.corrections[0]).toMatchObject({ project: 'A', note: 'stop tracking X' });
    expect(typeof body.control.corrections[0].id).toBe('number');
    db.close();
  });

  it('lists registered topic wikis in the topics section', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: 'The 2026 Metro Owls', root_node_id: 'n1', kind: 'topic', source: 'vault', cadence: null, brief: 'b', created_at: new Date().toISOString(), created_by: 'tester' });
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.topics).toEqual([{
      topic: 'The 2026 Metro Owls', root_node_id: 'n1', source: 'vault', cadence: null,
      brief: 'b', last_curated_at: null,
      early_refresh: {
        enabled: false, vault_baseline_ready: false, web_baseline_ready: false,
        pending_source_change: false, explicit_sources: [], observed_source_count: 0,
        source_committed_at: null, web_committed_at: null, last_probe_at: null,
        last_probe_verdict: null,
      },
    }]);
    db.close();
  });

  it('lists registered topic wikis with cadence + last_curated_at', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: 'The 2026 Metro Owls', root_node_id: 'n1', kind: 'topic', source: 'vault+web', cadence: '7d', brief: 'b', created_at: new Date().toISOString(), created_by: 'tester' });
    recordRun(db, { ...base, ts: new Date().toISOString(), project: 'The 2026 Metro Owls', wiki_curated_at: recent });
    const res = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.topics).toEqual([{
      topic: 'The 2026 Metro Owls', root_node_id: 'n1', source: 'vault+web', cadence: '7d',
      brief: 'b', last_curated_at: recent,
      early_refresh: {
        enabled: false, vault_baseline_ready: false, web_baseline_ready: false,
        pending_source_change: false, explicit_sources: [], observed_source_count: 0,
        source_committed_at: null, web_committed_at: null, last_probe_at: null,
        last_probe_verdict: null,
      },
    }]);
    db.close();
  });

  it('maps present, missing, and uncommitted explicit rows from local DB without Engine reads', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 'root', kind: 'topic', source: 'vault+web', cadence: '7d', brief: null, created_at: recent, created_by: 'tester' });
    replaceExplicitTopicRefreshSources(db, 'Topic', ['present', 'missing']);
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Topic', observedSourceNodeIds: ['observed'], sourceCommittedAt: '2026-08-30T12:00:00.000Z',
      sourceProjections: [
        { nodeId: 'present', titleAtCommit: 'Committed title', evidenceState: 'present', bodyIncluded: 1, fingerprintVersion: 1, evidenceHash: 'a'.repeat(64), capturedAt: '2026-08-30T12:00:00.000Z' },
        { nodeId: 'missing', titleAtCommit: null, evidenceState: 'missing', bodyIncluded: 0, fingerprintVersion: 1, evidenceHash: 'b'.repeat(64), capturedAt: '2026-08-30T12:00:00.000Z' },
        { nodeId: 'observed', titleAtCommit: 'Observed', evidenceState: 'present', bodyIncluded: 1, fingerprintVersion: 1, evidenceHash: 'c'.repeat(64), capturedAt: '2026-08-30T12:00:00.000Z' },
      ],
    });
    replaceExplicitTopicRefreshSources(db, 'Topic', ['present', 'missing', 'unavailable']);
    const guardedDeps = {
      ...deps(db),
      config: { ...config, wikiReconciliationMode: 'off', topicEarlyRefreshEnabled: true } as never,
      engine: new Proxy({}, { get: () => { throw new Error('Engine read attempted'); } }) as never,
    };

    const response = await call(makeCuratorStatusHandler(guardedDeps as never, new Date()), ['curate:read']);
    const early = JSON.parse(response.content[0]!.text).topics[0].early_refresh;

    expect(early).toMatchObject({
      enabled: true, vault_baseline_ready: true, web_baseline_ready: false,
      pending_source_change: true, observed_source_count: 1,
      source_committed_at: '2026-08-30T12:00:00.000Z', web_committed_at: null,
      explicit_sources: [
        { node_id: 'present', title_at_commit: 'Committed title', state: 'present' },
        { node_id: 'missing', title_at_commit: null, state: 'missing' },
        { node_id: 'unavailable', title_at_commit: null, state: 'unavailable' },
      ],
    });
    db.close();
  });

  it('recognizes empty committed source and web groups and bounds explicit source output', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 'root', kind: 'topic', source: 'vault+web', cadence: null, brief: null, created_at: recent, created_by: 'tester' });
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Topic', sourceProjections: [], observedSourceNodeIds: [],
      sourceCommittedAt: '2026-08-30T12:00:00.000Z',
    });
    const built = buildCanonicalWebProbe([{ url: 'https://example.com', title: 'Title', snippet: 'Secret snippet', published: null }]);
    if (!built.ok) throw new Error('probe fixture overflowed');
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Topic', sourceProjections: [], observedSourceNodeIds: [],
      sourceCommittedAt: '2026-08-30T13:00:00.000Z', webProbe: built.probe,
      webCommittedAt: '2026-08-30T13:00:00.000Z',
    });
    storeTopicProbeCache(db, {
      rootTitle: 'Topic', probe: built.probe,
      assessment: { verdict: 'immaterial', reasonCode: 'restatement', changedUrls: [] },
      assessedAt: '2026-08-30T14:00:00.000Z',
    });

    const response = await call(makeCuratorStatusHandler(deps(db), new Date()), ['curate:read']);
    const early = JSON.parse(response.content[0]!.text).topics[0].early_refresh;

    expect(early).toMatchObject({
      vault_baseline_ready: true, web_baseline_ready: true, observed_source_count: 0,
      source_committed_at: '2026-08-30T13:00:00.000Z',
      web_committed_at: '2026-08-30T13:00:00.000Z',
      last_probe_at: '2026-08-30T14:00:00.000Z', last_probe_verdict: 'immaterial',
    });
    expect(JSON.stringify(early)).not.toContain('Secret snippet');
    expect(early.explicit_sources.length).toBeLessThanOrEqual(20);
    db.close();
  });
});
