import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { getWikiRoot, registerWikiRoot } from '../src/db/wiki-roots.js';
import { CurationQueue } from '../src/queue.js';
import { EngineError } from '../src/engine.js';
import {
  commitTopicRefreshBaseline,
  explicitTopicRefreshSources,
  observedTopicRefreshSources,
  replaceExplicitTopicRefreshSources,
  topicRefreshState,
} from '../src/db/topic-refresh.js';
import { topicVaultSourceFingerprint } from '../src/topic-refresh-evidence.js';
import { isPaused, setPaused } from '../src/db/control.js';

vi.mock('../src/topic.js', () => ({
  curateTopic: vi.fn(async () => ({ project: 'T', outcome: 'written', dryRun: false })),
  topicRefreshCommitMaterial: vi.fn((result: { __refreshCommitMaterial?: unknown }) => result.__refreshCommitMaterial),
}));
import { curateTopic } from '../src/topic.js';
import { createOrUpdateWiki, removeWiki, TOPIC_WIKIS_OFF, TOPIC_WIKIS_OFF_MESSAGE } from '../src/core.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';

const DEFAULT_VAULT = defaultsFor('vault') as unknown as VaultSettings;
import { BackgroundBuilds } from '../src/background-builds.js';
import { latestProjectRuns } from '../src/db/runs.js';
import { createOrUpdateWikiInput, makeCreateOrUpdateWikiHandler } from '../src/tools/create-or-update-wiki.js';

function deps(db: Database.Database) {
  const engine = {
    ensureTopicSchema: vi.fn(async () => {}),
    createNode: vi.fn(async () => ({ node_id: 'tnode', file_path: 'Topics/T.md' })),
    listActiveProjects: vi.fn(async () => []),
  };
  return { engine: engine as never, llm: {} as never, config: { activeStatuses: ['open'] } as never, queue: new CurationQueue(), db } as never;
}

function registerTopic(db: Database.Database, title = 'T', rootNodeId = 'topic-root'): void {
  registerWikiRoot(db, {
    root_title: title,
    root_node_id: rootNodeId,
    kind: 'topic',
    source: 'vault',
    cadence: null,
    brief: null,
    created_at: '2026-08-30T12:00:00.000Z',
    created_by: 'tester',
  });
}

function projection(nodeId: string) {
  return {
    nodeId,
    titleAtCommit: `Title ${nodeId}`,
    evidenceState: 'present' as const,
    bodyIncluded: 1 as const,
    fingerprintVersion: 1,
    evidenceHash: 'a'.repeat(64),
    capturedAt: '2026-08-30T12:00:00.000Z',
  };
}

function refreshMaterial(nodeIds: readonly string[]) {
  return {
    sourceProjections: nodeIds.map(projection),
    observedSourceNodeIds: [],
  };
}

function seedExplicitSources(db: Database.Database, title: string, nodeIds: readonly string[]): void {
  replaceExplicitTopicRefreshSources(db, title, nodeIds);
  commitTopicRefreshBaseline(db, {
    rootTitle: title,
    sourceProjections: nodeIds.map(projection),
    observedSourceNodeIds: [],
    sourceCommittedAt: '2026-08-30T12:00:00.000Z',
  });
}

function sourceDeps(db: Database.Database, options: {
  getNode?: (nodeId: string) => Promise<unknown>;
  homeId?: string | null;
  subpageIds?: string[];
  queue?: CurationQueue;
} = {}) {
  const engine = {
    ensureTopicSchema: vi.fn(async () => {}),
    createNode: vi.fn(async () => ({ node_id: 'topic-root', file_path: 'Topics/T.md' })),
    listActiveProjects: vi.fn(async () => []),
    projectEvidence: vi.fn(async () => ({
      project: { id: 'topic-root', title: 'T', file_path: '', status: null },
      existing_wiki: {
        home_id: options.homeId ?? 'wiki-home',
        home: null,
        topology_hash: '',
        catalog_valid: true,
        subpages: (options.subpageIds ?? ['wiki-subpage']).map(id => ({ id })),
      },
    })),
    getNode: vi.fn(options.getNode ?? (async (nodeId: string) => ({
      id: nodeId,
      title: `Title ${nodeId}`,
      file_path: `Notes/${nodeId}.md`,
      types: ['note'],
      fields: {},
      body: '',
    }))),
  };
  return {
    deps: {
      engine: engine as never,
      llm: {} as never,
      config: { activeStatuses: ['open'] } as never,
      queue: options.queue ?? new CurationQueue(),
      db,
    } as never,
    engine,
  };
}

beforeEach(() => (curateTopic as Mock).mockClear());

describe('createOrUpdateWiki — create path', () => {
  it('ensures schema, creates the topic node, registers it, and runs an initial curation', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    const res = await createOrUpdateWiki(d, { topic: 'The 2026 Metro Owls', brief: 'the topic', by: 'tester' });
    expect(res.ok).toBe(true);
    expect(res.root_node_id).toBe('tnode');
    expect(getWikiRoot(db, 'The 2026 Metro Owls')).toMatchObject({ root_node_id: 'tnode', kind: 'topic', source: 'vault' });
    expect((d as { engine: { ensureTopicSchema: Mock } }).engine.ensureTopicSchema).toHaveBeenCalled();
    expect(curateTopic).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('leaves the folder to the topic type by default, and uses topicDir when it is set', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db) as { engine: { ensureTopicSchema: Mock; createNode: Mock }; config: Record<string, unknown> };
    await createOrUpdateWiki(d as never, { topic: 'Owls', by: null });
    expect(d.engine.ensureTopicSchema).toHaveBeenLastCalledWith('topic', undefined);
    expect(d.engine.createNode.mock.lastCall?.[0]).not.toHaveProperty('directory');

    d.config = { ...d.config, topicDir: 'Subjects' };
    await createOrUpdateWiki(d as never, { topic: 'Herons', by: null });
    expect(d.engine.ensureTopicSchema).toHaveBeenLastCalledWith('topic', 'Subjects');
    expect(d.engine.createNode.mock.lastCall?.[0]).toMatchObject({ title: 'Herons', types: ['topic'], directory: 'Subjects' });
    db.close();
  });

  it('makes the topic note of the vault map\'s topic kind', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db) as { engine: { ensureTopicSchema: Mock; createNode: Mock }; config: Record<string, unknown> };
    d.config = { ...d.config, vault: { ...DEFAULT_VAULT, topicType: 'subject' } };
    const res = await createOrUpdateWiki(d as never, { topic: 'Owls', by: null });
    expect(res.ok).toBe(true);
    expect(d.engine.ensureTopicSchema).toHaveBeenLastCalledWith('subject', undefined);
    expect(d.engine.createNode.mock.lastCall?.[0]).toMatchObject({ title: 'Owls', types: ['subject'] });
    db.close();
  });

  it('refuses a new topic wiki when the topic kind is none, and keeps an existing one editable', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db) as { engine: { ensureTopicSchema: Mock; createNode: Mock }; config: Record<string, unknown> };
    d.config = { ...d.config, vault: { ...DEFAULT_VAULT, topicType: null } };
    const refused = await createOrUpdateWiki(d as never, { topic: 'Owls', brief: 'birds', by: null });
    expect(refused).toEqual({ ok: false, error: { code: TOPIC_WIKIS_OFF, message: TOPIC_WIKIS_OFF_MESSAGE } });
    expect(d.engine.ensureTopicSchema).not.toHaveBeenCalled();
    expect(d.engine.createNode).not.toHaveBeenCalled();
    expect(getWikiRoot(db, 'Owls')).toBeUndefined();

    registerTopic(db, 'Herons');
    const updated = await createOrUpdateWiki(d as never, { topic: 'Herons', brief: 'waders', by: null });
    expect(updated.ok).toBe(true);
    expect(getWikiRoot(db, 'Herons')).toMatchObject({ brief: 'waders' });
    expect(d.engine.ensureTopicSchema).not.toHaveBeenCalled();
    expect(d.engine.createNode).not.toHaveBeenCalled();
    db.close();
  });

  it('is idempotent on an already-registered topic (reuses, does not duplicate)', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'The 2026 Metro Owls', brief: 'a', by: null });
    await createOrUpdateWiki(d, { topic: 'The 2026 Metro Owls', brief: 'b', by: null });
    const all = db.prepare('SELECT COUNT(*) AS c FROM wiki_roots').get() as { c: number };
    expect(all.c).toBe(1);
    db.close();
  });

  it('reuses an existing vault topic node when createNode rejects with "already exists"', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const engine = {
      ensureTopicSchema: vi.fn(async () => {}),
      createNode: vi.fn(async () => { throw new EngineError('INVALID_PARAMS', 'File path "Topics/X.md" already exists'); }),
      projectEvidence: vi.fn(async () => ({
        project: { id: 'existing-node', title: 'X', file_path: '', status: null },
        existing_wiki: { home_id: null, subpages: [] },
      })),
      listActiveProjects: vi.fn(async () => []),
    };
    const d = { engine: engine as never, llm: {} as never, config: { activeStatuses: ['open'] } as never, queue: new CurationQueue(), db } as never;
    const res = await createOrUpdateWiki(d, { topic: 'X', brief: 'test', by: 'tester' });
    expect(res.ok).toBe(true);
    expect(res.root_node_id).toBe('existing-node');
    expect(engine.projectEvidence).toHaveBeenCalledWith('X');
    const row = getWikiRoot(db, 'X');
    expect(row).toMatchObject({ root_node_id: 'existing-node' });
    const all = db.prepare('SELECT COUNT(*) AS c FROM wiki_roots').get() as { c: number };
    expect(all.c).toBe(1);
    db.close();
  });

  it('commits the initial live topic baseline exactly once after a written Engine result', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    const fingerprint = topicVaultSourceFingerprint({
      nodeId: 'source-1', title: 'Source', types: ['note'], bodyIncluded: true, renderedBody: 'body',
    });
    (curateTopic as Mock).mockResolvedValueOnce({
      project: 'Initial Baseline', outcome: 'written', dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [{
          nodeId: 'source-1', titleAtCommit: 'Source', evidenceState: 'present', bodyIncluded: 1,
          fingerprintVersion: fingerprint.version, evidenceHash: fingerprint.hash,
          capturedAt: '2026-08-30T12:00:00.000Z',
        }],
        observedSourceNodeIds: ['source-1'],
      },
    });

    const response = await createOrUpdateWiki(d, { topic: 'Initial Baseline', by: null });

    expect(response).toMatchObject({ ok: true, outcome: 'written' });
    expect(observedTopicRefreshSources(db, 'Initial Baseline').map(row => row.node_id)).toEqual(['source-1']);
    expect(topicRefreshState(db, 'Initial Baseline')?.source_committed_at).toEqual(expect.any(String));
    db.close();
  });
});

/**
 * The engine names a wiki home page `<topic> Wiki`, so a caller told to "change
 * this wiki's cadence" while looking at that page naturally passes the PAGE title.
 * Left unguarded that silently stands up a whole second wiki (and a node whose
 * title collides with the first one's home page) — the 2026-08-04 incident.
 */
describe('createOrUpdateWiki — "<topic> Wiki" near-miss guard', () => {
  it('refuses a topic that is the wiki page of a registered root, naming the real topic', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'Orbital Builder Redux', brief: 'the game', by: null });
    (curateTopic as Mock).mockClear();
    const engine = (d as { engine: { createNode: Mock } }).engine;
    engine.createNode.mockClear();

    const res = await createOrUpdateWiki(d, { topic: 'Orbital Builder Redux Wiki', cadence: '7d', by: null });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('TOPIC_IS_A_WIKI_PAGE');
    expect(res.error?.message).toContain('Orbital Builder Redux');
    expect(getWikiRoot(db, 'Orbital Builder Redux Wiki')).toBeUndefined();
    expect(engine.createNode).not.toHaveBeenCalled();
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('refuses a topic that is the wiki page of an active project', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const engine = {
      ensureTopicSchema: vi.fn(async () => {}),
      createNode: vi.fn(async () => ({ node_id: 'tnode', file_path: 'Topics/T.md' })),
      listActiveProjects: vi.fn(async () => [{ id: 'p1', title: 'Vault Engine', file_path: '', status: 'open' }]),
    };
    const d = { engine: engine as never, llm: {} as never, config: { activeStatuses: ['open'] } as never, queue: new CurationQueue(), db } as never;

    const res = await createOrUpdateWiki(d, { topic: 'Vault Engine Wiki', by: null });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('TOPIC_IS_A_WIKI_PAGE');
    expect(res.error?.message).toContain('Vault Engine');
    expect(engine.createNode).not.toHaveBeenCalled();
    db.close();
  });

  it('allows a genuine topic ending in "Wiki" when nothing else owns the base name', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    const res = await createOrUpdateWiki(d, { topic: 'Wikipedia Wiki', brief: 'about the encyclopedia', by: null });
    expect(res.ok).toBe(true);
    expect(getWikiRoot(db, 'Wikipedia Wiki')).toMatchObject({ root_node_id: 'tnode' });
    db.close();
  });

  it('never blocks the update path: an already-registered "<x> Wiki" root stays editable', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'Orphan', brief: 'base', by: null });
    // A row the guard would refuse today, registered before it existed.
    db.prepare(`INSERT INTO wiki_roots (root_title, root_node_id, kind, source, cadence, brief, created_at, created_by)
                VALUES ('Orphan Wiki', 'legacy', 'topic', 'vault', NULL, NULL, '2026-08-04T00:00:00Z', NULL)`).run();
    const res = await createOrUpdateWiki(d, { topic: 'Orphan Wiki', cadence: '1d', by: null });
    expect(res.ok).toBe(true);
    expect(getWikiRoot(db, 'Orphan Wiki')).toMatchObject({ cadence: '1d' });
    db.close();
  });
});

describe('createOrUpdateWiki — created flag', () => {
  it('reports created:true for a brand-new wiki and created:false on an update', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    const made = await createOrUpdateWiki(d, { topic: 'Fresh', brief: 'b', by: null });
    expect(made).toMatchObject({ ok: true, created: true });
    expect(made.detail).toMatch(/new wiki/i);
    const updated = await createOrUpdateWiki(d, { topic: 'Fresh', cadence: '1d', by: null });
    expect(updated).toMatchObject({ ok: true, created: false });
    db.close();
  });
});

describe('createOrUpdateWiki — update path (preserve omitted fields)', () => {
  it('updates only the cadence on an existing topic, preserving source + brief, without re-curating', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'T', brief: 'the brief', source: 'vault+web', cadence: '7d', by: null });
    (curateTopic as Mock).mockClear();
    const res = await createOrUpdateWiki(d, { topic: 'T', cadence: '1d', by: null });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe('skipped');
    expect(res.detail).toBe('cadence updated; scheduled sweeps use it while curator-status shows wiki_reconciliation_mode "live"');
    expect(getWikiRoot(db, 'T')).toMatchObject({ source: 'vault+web', cadence: '1d', brief: 'the brief' });
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('re-call with no changes is a no-op: nothing clobbered, no re-curation', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'T', brief: 'b', source: 'vault+web', cadence: '1d', by: null });
    (curateTopic as Mock).mockClear();
    const res = await createOrUpdateWiki(d, { topic: 'T', by: null });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe('skipped');
    expect(res.detail).toBe('no changes');
    expect(getWikiRoot(db, 'T')).toMatchObject({ source: 'vault+web', cadence: '1d', brief: 'b' });
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('empty string explicitly clears: cadence resets to default, brief is removed', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'T', brief: 'b', source: 'vault+web', cadence: '1d', by: null });
    const res = await createOrUpdateWiki(d, { topic: 'T', cadence: '', brief: '', by: null });
    expect(res.ok).toBe(true);
    expect(getWikiRoot(db, 'T')).toMatchObject({ source: 'vault+web', cadence: null, brief: null });
    db.close();
  });

  it('a brief change re-curates with the merged spec (existing source + cadence preserved)', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'T', brief: 'old', source: 'vault+web', cadence: '1d', by: null });
    (curateTopic as Mock).mockClear();
    const res = await createOrUpdateWiki(d, { topic: 'T', brief: 'new', by: null });
    expect(res.ok).toBe(true);
    expect(getWikiRoot(db, 'T')).toMatchObject({ source: 'vault+web', cadence: '1d', brief: 'new' });
    expect(curateTopic).toHaveBeenCalledTimes(1);
    const spec = (curateTopic as Mock).mock.calls[0]![4];
    expect(spec).toMatchObject({ brief: 'new', source: 'vault+web', cadence: '1d' });
    db.close();
  });

  it('a source change re-curates', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'T', brief: 'b', by: null });
    (curateTopic as Mock).mockClear();
    const res = await createOrUpdateWiki(d, { topic: 'T', source: 'vault+web', by: null });
    expect(res.ok).toBe(true);
    expect(getWikiRoot(db, 'T')).toMatchObject({ source: 'vault+web', brief: 'b' });
    expect(curateTopic).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe('createOrUpdateWiki — explicit source membership', () => {
  it('preserves configured membership when source_node_ids is omitted and keeps cadence-only updates cheap', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['source-1']);
    const d = sourceDeps(db);

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', cadence: '1d', by: null });

    expect(res).toMatchObject({ ok: true, outcome: 'skipped', created: false });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['source-1']);
    expect(d.engine.projectEvidence).not.toHaveBeenCalled();
    expect(d.engine.getNode).not.toHaveBeenCalled();
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('clears membership atomically and forces curation when an empty list is supplied', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['source-1']);
    const d = sourceDeps(db);
    (curateTopic as Mock).mockResolvedValueOnce({
      project: 'T', outcome: 'written', dryRun: false,
      __refreshCommitMaterial: refreshMaterial([]),
    });

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: [], by: null });

    expect(res).toMatchObject({ ok: true, outcome: 'written', created: false });
    expect(res.detail).toMatch(/explicit sources updated.*curation written/i);
    expect(explicitTopicRefreshSources(db, 'T')).toEqual([]);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(0);
    expect(d.engine.projectEvidence).toHaveBeenCalledTimes(1);
    expect(d.engine.getNode).not.toHaveBeenCalled();
    expect(curateTopic).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('trims and deduplicates in caller order, validates every unique ID once without embeds, and persists stable IDs', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    const d = sourceDeps(db);
    (curateTopic as Mock).mockResolvedValueOnce({ project: 'T', outcome: 'error', detail: 'failed', dryRun: false });

    const res = await createOrUpdateWiki(d.deps, {
      topic: 'T', source_node_ids: [' source-b ', 'source-a', 'source-b'], by: null,
    });

    expect(res).toMatchObject({ ok: true, outcome: 'error' });
    expect(d.engine.projectEvidence).toHaveBeenCalledTimes(1);
    expect(d.engine.getNode.mock.calls).toEqual([
      ['source-b', { includeEmbeds: false }],
      ['source-a', { includeEmbeds: false }],
    ]);
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['source-b', 'source-a']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(1);
    db.close();
  });

  it('rejects unknown IDs closed after validating every unique proposal and preserves membership', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['existing']);
    const d = sourceDeps(db, {
      getNode: async (nodeId) => {
        if (nodeId === 'missing') throw new EngineError('NOT_FOUND', 'secret provider detail');
        return { id: nodeId, title: nodeId, types: [], fields: {}, body: '' };
      },
    });

    const res = await createOrUpdateWiki(d.deps, {
      topic: 'T', source_node_ids: ['missing', 'known'], by: null,
    });

    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_SOURCE_NODE' } });
    expect(res.error?.message).not.toContain('secret provider detail');
    expect(d.engine.getNode).toHaveBeenCalledTimes(2);
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['existing']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(0);
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ['topic root', 'topic-root'],
    ['wiki home', 'wiki-home'],
    ['managed subpage', 'wiki-subpage'],
  ])('rejects the %s stable ID as a self-source after exactly one get-node read', async (_label, nodeId) => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['existing']);
    const d = sourceDeps(db);

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: [nodeId], by: null });

    expect(res).toMatchObject({ ok: false, error: { code: 'SELF_SOURCE_NODE' } });
    expect(d.engine.projectEvidence).toHaveBeenCalledTimes(1);
    expect(d.engine.getNode).toHaveBeenCalledTimes(1);
    expect(d.engine.getNode).toHaveBeenCalledWith(nodeId, { includeEmbeds: false });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['existing']);
    db.close();
  });

  it('uses stable membership identity when a configured source title and path change', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['source-1']);
    const d = sourceDeps(db, {
      getNode: async (nodeId) => ({
        id: nodeId, title: 'Renamed source', file_path: 'Moved/Source.md', types: ['note'], fields: {}, body: '',
      }),
    });

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: ['source-1'], by: null });

    expect(res).toMatchObject({ ok: true, outcome: 'skipped', created: false });
    expect(res.detail).toMatch(/explicit sources unchanged/i);
    expect(res.detail).not.toMatch(/next sweep/); // only a live scheduled sweep reads the cadence (#544)
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['source-1']);
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('commits a changed setting before forced curation and clears pending through a successful baseline commit', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['old']);
    const d = sourceDeps(db);
    (curateTopic as Mock).mockResolvedValueOnce({
      project: 'T', outcome: 'written', dryRun: false,
      __refreshCommitMaterial: refreshMaterial(['new']),
    });

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: ['new'], by: null });

    expect(res).toMatchObject({ ok: true, outcome: 'written', created: false });
    expect(res.detail).toBe('explicit sources updated; curation written');
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['new']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(0);
    const curateOptions = (curateTopic as Mock).mock.calls[0]![5];
    expect(curateOptions).toMatchObject({ force: true, scheduled: false, explicitSourceNodeIds: ['new'] });
    db.close();
  });

  it('serializes source mutation behind an in-flight topic curation so an older baseline cannot clear the new pending change', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['old']);
    const queue = new CurationQueue();
    const d = sourceDeps(db, { queue });
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const olderCuration = queue.enqueue('T', async () => {
      markStarted();
      await gate;
      commitTopicRefreshBaseline(db, {
        rootTitle: 'T',
        sourceProjections: [projection('old')],
        observedSourceNodeIds: [],
        sourceCommittedAt: '2026-08-30T13:00:00.000Z',
      });
    });
    await started;
    (curateTopic as Mock).mockResolvedValueOnce({
      project: 'T', outcome: 'error', detail: 'forced curation failed', dryRun: false,
    });

    const update = createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: ['new'], by: null });
    await new Promise<void>(resolve => setImmediate(resolve));
    const membershipWhileOlderRunIsActive = explicitTopicRefreshSources(db, 'T').map(row => row.node_id);
    release();
    await olderCuration;
    const res = await update;

    expect(membershipWhileOlderRunIsActive).toEqual(['old']);
    expect(res).toMatchObject({ ok: true, outcome: 'error' });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['new']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(1);
    db.close();
  });

  it('keeps a committed source change pending and returns a bounded closed detail when forced curation fails', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['old']);
    const d = sourceDeps(db);
    const rawDetail = `provider secret ${'x'.repeat(1_000)}`;
    (curateTopic as Mock).mockResolvedValueOnce({ project: 'T', outcome: 'error', detail: rawDetail, dryRun: false });

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: ['new'], by: null });

    expect(res).toMatchObject({ ok: true, outcome: 'error', created: false });
    expect(res.detail).toBe('explicit sources updated; curation failed and source change remains pending');
    expect(res.detail).not.toContain('provider secret');
    expect(res.detail!.length).toBeLessThan(160);
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['new']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(1);
    db.close();
  });

  it('keeps a committed source change pending and returns ok when forced curation throws', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['old']);
    const d = sourceDeps(db);
    (curateTopic as Mock).mockRejectedValueOnce(new Error(`provider secret ${'x'.repeat(1_000)}`));

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: ['new'], by: null });

    expect(res).toMatchObject({ ok: true, outcome: 'error', created: false });
    expect(res.detail).toBe('explicit sources updated; curation failed and source change remains pending');
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['new']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(1);
    db.close();
  });

  it.each([
    ['transport failure', async () => { throw new Error('raw transport secret'); }],
    ['malformed result', async () => ({ title: 'missing stable id' })],
  ])('maps %s to CREATE_FAILED without changing membership', async (_label, getNode) => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    seedExplicitSources(db, 'T', ['existing']);
    const d = sourceDeps(db, { getNode });

    const res = await createOrUpdateWiki(d.deps, { topic: 'T', source_node_ids: ['proposed'], by: null });

    expect(res).toMatchObject({ ok: false, error: { code: 'CREATE_FAILED' } });
    expect(res.error?.message).not.toMatch(/raw transport secret|missing stable id/i);
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['existing']);
    expect(topicRefreshState(db, 'T')?.pending_source_change).toBe(0);
    db.close();
  });

  it('rejects more than 20 unique IDs before any Engine call', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db);
    const d = sourceDeps(db);

    const res = await createOrUpdateWiki(d.deps, {
      topic: 'T', source_node_ids: Array.from({ length: 21 }, (_, index) => `source-${index}`), by: null,
    });

    expect(res).toMatchObject({ ok: false, error: { code: 'TOO_MANY_SOURCE_NODES' } });
    expect(d.engine.ensureTopicSchema).not.toHaveBeenCalled();
    expect(d.engine.projectEvidence).not.toHaveBeenCalled();
    expect(d.engine.getNode).not.toHaveBeenCalled();
    db.close();
  });

  it('validates a new topic source before createNode so rejection cannot orphan a topic node', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = sourceDeps(db, {
      getNode: async () => { throw new EngineError('NOT_FOUND', 'missing source'); },
    });

    const res = await createOrUpdateWiki(d.deps, {
      topic: 'Brand New', source_node_ids: ['missing'], by: null,
    });

    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_SOURCE_NODE' } });
    expect(d.engine.getNode).toHaveBeenCalledWith('missing', { includeEmbeds: false });
    expect(d.engine.createNode).not.toHaveBeenCalled();
    expect(getWikiRoot(db, 'Brand New')).toBeUndefined();
    db.close();
  });
});

describe('create-or-update-wiki tool', () => {
  it('enforces curate:trigger', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const h = makeCreateOrUpdateWikiHandler(deps(db));
    const res = await h({ topic: 'X' }, { authInfo: { scopes: [] } });
    expect(res.isError).toBe(true);
    db.close();
  });

  it('does not default source in the input schema (omitted must stay omitted)', () => {
    const parsed = z.object(createOrUpdateWikiInput).parse({ topic: 'X' });
    expect(parsed.source).toBeUndefined();
    expect(parsed.cadence).toBeUndefined();
    expect(parsed.brief).toBeUndefined();
    expect(parsed.source_node_ids).toBeUndefined();
  });

  it('accepts empty and up to 20 unique stable IDs, applying the cap after deduplication', () => {
    const schema = z.object(createOrUpdateWikiInput);
    expect(schema.parse({ topic: 'X', source_node_ids: [] }).source_node_ids).toEqual([]);
    expect(schema.parse({
      topic: 'X', source_node_ids: Array.from({ length: 20 }, (_, index) => `source-${index}`),
    }).source_node_ids).toHaveLength(20);
    expect(schema.parse({
      topic: 'X', source_node_ids: [...Array.from({ length: 20 }, (_, index) => `source-${index}`), ' source-0 '],
    }).source_node_ids).toHaveLength(21);
    expect(() => schema.parse({
      topic: 'X', source_node_ids: Array.from({ length: 21 }, (_, index) => `source-${index}`),
    })).toThrow();
  });

  it('rejects blank source IDs at the edge and documents the update semantics', () => {
    const schema = z.object(createOrUpdateWikiInput);
    expect(() => schema.parse({ topic: 'X', source_node_ids: ['   '] })).toThrow();
    const description = createOrUpdateWikiInput.source_node_ids.description ?? '';
    expect(description).toMatch(/stable input.*anchor/i);
    expect(description).toMatch(/omit.*preserv/i);
    expect(description).toMatch(/empty.*clear/i);
    expect(description).toMatch(/non-empty.*replace/i);
    expect(description).toMatch(/forc.*curation/i);
  });
});

describe('createOrUpdateWiki — source + cadence threading', () => {
  it('stores source + cadence and forwards them to curateTopic', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    await createOrUpdateWiki(d, { topic: 'Owls', brief: 'b', source: 'vault+web', cadence: '24h', by: null });
    expect(getWikiRoot(db, 'Owls')).toMatchObject({ source: 'vault+web', cadence: '24h' });
    const spec = (curateTopic as Mock).mock.calls[0]![4];
    expect(spec).toMatchObject({ brief: 'b', source: 'vault+web', cadence: '24h' });
    db.close();
  });

  it('defaults source to vault for a new topic and rejects a malformed cadence', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    const ok = await createOrUpdateWiki(d, { topic: 'A', by: null });
    expect(ok.ok).toBe(true);
    expect(getWikiRoot(db, 'A')).toMatchObject({ source: 'vault' });
    const bad = await createOrUpdateWiki(d, { topic: 'B', cadence: 'soon', by: null });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('INVALID_CADENCE');
    db.close();
  });
});

describe('createOrUpdateWiki — paused, for a wiki made from a note (#387)', () => {
  const trigger = { authInfo: { scopes: ['curate:trigger'], clientId: 'caller' } };

  it('creates the wiki paused, still runs its first build, and says it is paused', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const { deps: d } = sourceDeps(db);
    const res = await createOrUpdateWiki(d, { topic: 'The 2026 Metro Owls', brief: 'The season.', source: 'vault+web',
      source_node_ids: ['clip-1'], paused: true, by: 'caller' });
    expect(res).toMatchObject({ ok: true, created: true, paused: true, outcome: 'written', root_node_id: 'topic-root' });
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(isPaused(db, 'The 2026 Metro Owls')).toBe(true);
    expect(getWikiRoot(db, 'The 2026 Metro Owls')).toMatchObject({ source: 'vault+web', brief: 'The season.' });
    expect(explicitTopicRefreshSources(db, 'The 2026 Metro Owls').map(row => row.node_id)).toEqual(['clip-1']);
    db.close();
  });

  it('paused:false creates the wiki unpaused, and omitting it keeps the old behavior', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const d = deps(db);
    setPaused(db, 'Stale', true, null, '2026-11-01T00:00:00.000Z');
    expect(await createOrUpdateWiki(d, { topic: 'Stale', paused: false, by: null })).toMatchObject({ ok: true, paused: false });
    expect(isPaused(db, 'Stale')).toBe(false);
    expect(await createOrUpdateWiki(d, { topic: 'Plain', by: null })).toMatchObject({ ok: true, created: true, paused: false });
    db.close();
  });

  it('refuses paused for a topic that already has a wiki, changing nothing', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    seedExplicitSources(db, 'T', ['older-1']);
    const { deps: d, engine } = sourceDeps(db);
    const res = await createOrUpdateWiki(d, { topic: 'T', brief: 'new', source_node_ids: ['older-1', 'clip-1'], paused: true, by: null });
    expect(res).toMatchObject({ ok: false, error: { code: 'WIKI_EXISTS' } });
    expect(curateTopic).not.toHaveBeenCalled();
    expect(engine.getNode).not.toHaveBeenCalled();
    expect(getWikiRoot(db, 'T')?.brief).toBeNull();
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['older-1']);
    expect(isPaused(db, 'T')).toBe(false);
    db.close();
  });

  it('adds a note as a source of an existing paused topic wiki: one rebuild, sources kept, still paused', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    seedExplicitSources(db, 'T', ['older-1']);
    setPaused(db, 'T', true, null, '2026-11-07T00:00:00.000Z');
    const { deps: d } = sourceDeps(db);
    const res = await createOrUpdateWiki(d, { topic: 'T', source_node_ids: ['older-1', 'clip-1'], by: null });
    expect(res).toMatchObject({ ok: true, created: false, paused: true });
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['older-1', 'clip-1']);
    expect(isPaused(db, 'T')).toBe(true);
    db.close();
  });

  it('takes paused over the tool and reports it back', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    expect(z.object(createOrUpdateWikiInput).parse({ topic: 'X' }).paused).toBeUndefined();
    const res = await makeCreateOrUpdateWikiHandler(deps(db))({ topic: 'X', paused: true }, trigger);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true, created: true, paused: true });
    expect(isPaused(db, 'X')).toBe(true);
    db.close();
  });
});

describe('createOrUpdateWiki — add_source_node_ids (#387)', () => {
  it('adds to the sources as they are when each call runs, so two adds both stay', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    seedExplicitSources(db, 'T', ['older-1']);
    const { deps: d, engine } = sourceDeps(db);
    expect(await createOrUpdateWiki(d, { topic: 'T', add_source_node_ids: ['clip-1'], by: null }))
      .toMatchObject({ ok: true, created: false });
    expect(await createOrUpdateWiki(d, { topic: 'T', add_source_node_ids: [' clip-2 ', 'clip-2'], by: null }))
      .toMatchObject({ ok: true, created: false });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['older-1', 'clip-1', 'clip-2']);
    expect(curateTopic).toHaveBeenCalledTimes(2);
    // Only the added ids are checked against the Engine.
    expect(engine.getNode.mock.calls.map(call => call[0])).toEqual(['clip-1', 'clip-2']);
    db.close();
  });

  it('skips ids already present without a rebuild, and keeps a source the Engine no longer has', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    seedExplicitSources(db, 'T', ['gone-1']);
    const { deps: d } = sourceDeps(db, { getNode: async (id: string) => {
      if (id === 'gone-1') throw new EngineError('NOT_FOUND', 'no node');
      return { id, title: id, file_path: `${id}.md`, types: ['note'], fields: {}, body: '' };
    } });
    expect(await createOrUpdateWiki(d, { topic: 'T', add_source_node_ids: ['gone-1'], by: null }))
      .toMatchObject({ ok: true, outcome: 'skipped' });
    expect(curateTopic).not.toHaveBeenCalled();
    expect(await createOrUpdateWiki(d, { topic: 'T', add_source_node_ids: ['clip-1'], by: null })).toMatchObject({ ok: true });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['gone-1', 'clip-1']);
    db.close();
  });

  it('refuses an add past 20 sources, and add with replace together, changing nothing', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    const twenty = Array.from({ length: 20 }, (_, i) => `s${i}`);
    seedExplicitSources(db, 'T', twenty);
    const { deps: d } = sourceDeps(db);
    expect(await createOrUpdateWiki(d, { topic: 'T', add_source_node_ids: ['clip-1'], by: null }))
      .toMatchObject({ ok: false, error: { code: 'TOO_MANY_SOURCE_NODES' } });
    expect(await createOrUpdateWiki(d, { topic: 'T', source_node_ids: ['s0'], add_source_node_ids: ['clip-1'], by: null }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_SOURCE_NODE' } });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(twenty);
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('gives a new topic its first sources', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const { deps: d } = sourceDeps(db);
    expect(await createOrUpdateWiki(d, { topic: 'New', add_source_node_ids: ['clip-1'], by: null }))
      .toMatchObject({ ok: true, created: true });
    expect(explicitTopicRefreshSources(db, 'New').map(row => row.node_id)).toEqual(['clip-1']);
    db.close();
  });

  it('takes add_source_node_ids over the tool', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    seedExplicitSources(db, 'T', ['older-1']);
    const { deps: d } = sourceDeps(db);
    const schema = z.object(createOrUpdateWikiInput);
    expect(() => schema.parse({ topic: 'T', add_source_node_ids: ['  '] })).toThrow();
    const res = await makeCreateOrUpdateWikiHandler(d)({ topic: 'T', add_source_node_ids: ['clip-1'] },
      { authInfo: { scopes: ['curate:trigger'], clientId: 'caller' } });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true, created: false });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['older-1', 'clip-1']);
    db.close();
  });
});

describe('createOrUpdateWiki — the server queues the build and replies at once (#387)', () => {
  function withBuilds(d: object) {
    const kept: Promise<unknown>[] = [];
    const builds = new BackgroundBuilds(work => { kept.push(work); });
    return { kept, builds, d: { ...d, builds } as never };
  }
  /** A curateTopic that stays running until released. */
  function holdBuild() {
    let release!: () => void;
    const done = new Promise<void>(r => { release = r; });
    (curateTopic as Mock).mockImplementationOnce(async (_e, _l, _c, root: { title: string }) => {
      await done;
      return { project: root.title, outcome: 'written', dryRun: false };
    });
    return release;
  }

  it('registers a paused wiki and replies "queued" before its first build runs, then builds it once', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const { d, kept, builds } = withBuilds(sourceDeps(db).deps);
    const release = holdBuild();
    const res = await createOrUpdateWiki(d, { topic: 'The 2026 Metro Owls', brief: 'The season.', source: 'vault+web',
      source_node_ids: ['clip-1'], paused: true, by: 'caller' });
    expect(res).toMatchObject({ ok: true, created: true, paused: true, outcome: 'queued', root_node_id: 'topic-root',
      detail: expect.stringMatching(/^new wiki "The 2026 Metro Owls" registered; its first build is queued\. .*curator-status/) });
    expect(builds.get('project:The 2026 Metro Owls')).toBeDefined(); // what curator-status reads as in_progress
    expect(kept).toHaveLength(1); // handed to the server lifecycle, so shutdown waits for it
    release();
    await kept[0];
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect((curateTopic as Mock).mock.calls[0]![4]).toMatchObject({ brief: 'The season.', source: 'vault+web' });
    expect(builds.get('project:The 2026 Metro Owls')).toBeUndefined();
    expect(latestProjectRuns(db, 'The 2026 Metro Owls').latest).toMatchObject({ outcome: 'written' });
    expect(isPaused(db, 'The 2026 Metro Owls')).toBe(true);
    db.close();
  });

  it('a change made while the build waits is built by it, not by a second build', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const { d, kept } = withBuilds(sourceDeps(db).deps);
    // Both calls reach the lane before the first one queues its build.
    const [created, added] = await Promise.all([
      createOrUpdateWiki(d, { topic: 'T', brief: 'First.', source: 'vault+web', source_node_ids: ['clip-1'], paused: true, by: null }),
      createOrUpdateWiki(d, { topic: 'T', brief: 'Edited.', add_source_node_ids: ['clip-2'], by: null }),
    ]);
    expect(created).toMatchObject({ ok: true, created: true, outcome: 'queued' });
    expect(added).toMatchObject({ ok: true, created: false, paused: true, outcome: 'in_progress',
      detail: expect.stringContaining('this change is included') });
    await Promise.all(kept);
    expect(kept).toHaveLength(1);
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect((curateTopic as Mock).mock.calls[0]![4]).toMatchObject({ brief: 'Edited.', source: 'vault+web' });
    expect(explicitTopicRefreshSources(db, 'T').map(row => row.node_id)).toEqual(['clip-1', 'clip-2']);
    db.close();
  });

  it('an update that rebuilds is queued too, and one that does not replies as before', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerTopic(db, 'T');
    seedExplicitSources(db, 'T', ['older-1']);
    const { d, kept } = withBuilds(sourceDeps(db).deps);
    expect(await createOrUpdateWiki(d, { topic: 'T', add_source_node_ids: ['clip-1'], by: null }))
      .toMatchObject({ ok: true, created: false, outcome: 'queued', detail: expect.stringMatching(/^explicit sources updated; its rebuild is queued/) });
    await Promise.all(kept);
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(await createOrUpdateWiki(d, { topic: 'T', cadence: '14d', by: null })).toMatchObject({ ok: true, outcome: 'skipped' });
    expect(kept).toHaveLength(1);
    db.close();
  });

  it('builds nothing for a wiki removed before its build started', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const { d, kept } = withBuilds(sourceDeps(db).deps);
    const [created, removed] = await Promise.all([
      createOrUpdateWiki(d, { topic: 'T', source_node_ids: ['clip-1'], paused: true, by: null }),
      removeWiki(d, { topic: 'T' }),
    ]);
    expect(created).toMatchObject({ ok: true, outcome: 'queued' });
    expect(removed).toMatchObject({ ok: true, removed: true });
    await Promise.all(kept);
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });
});
