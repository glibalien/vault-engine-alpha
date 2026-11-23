import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { getWikiRoot, registerWikiRoot, wikiRootExists } from '../src/db/wiki-roots.js';
import { setPaused, addCorrection, isPaused, activeCorrections } from '../src/db/control.js';
import { insertPageRequest, pendingRequests } from '../src/db/requests.js';
import { CurationQueue } from '../src/queue.js';
import { removeWiki } from '../src/core.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';
import { removeWikiInput, makeRemoveWikiHandler } from '../src/tools/remove-wiki.js';
import {
  commitTopicRefreshBaseline,
  explicitTopicRefreshSources,
  observedTopicRefreshSources,
  replaceExplicitTopicRefreshSources,
  storeTopicProbeCache,
  topicRefreshState,
} from '../src/db/topic-refresh.js';
import { buildCanonicalWebProbe } from '../src/topic-refresh-evidence.js';
import { readStageCheckpoint, writeStagePlanning } from '../src/db/stage-checkpoints.js';
import type { PlanningResult } from '../src/reconciliation-planning.js';

function db() { const d = new Database(':memory:'); runMigrations(d); return d; }
function deps(d: Database.Database) {
  return { engine: {} as never, llm: {} as never, config: {} as never, queue: new CurationQueue(), db: d } as never;
}
function register(d: Database.Database, title: string) {
  registerWikiRoot(d, {
    root_title: title, root_node_id: `${title}-node`, kind: 'topic', source: 'vault',
    cadence: null, brief: null, created_at: '2026-08-04T00:00:00Z', created_by: 'tester',
  });
}

function sourceProjection(nodeId: string) {
  return {
    nodeId,
    titleAtCommit: nodeId,
    evidenceState: 'present' as const,
    bodyIncluded: 1 as const,
    fingerprintVersion: 1,
    evidenceHash: 'a'.repeat(64),
    capturedAt: '2026-08-30T12:00:00.000Z',
  };
}

function seedRefreshState(d: Database.Database, title: string): void {
  replaceExplicitTopicRefreshSources(d, title, ['explicit-source']);
  const committed = buildCanonicalWebProbe([{
    url: 'https://example.com/committed', title: 'Committed', snippet: 'Old', published: null,
  }]);
  if (!committed.ok) throw new Error('invalid committed probe fixture');
  commitTopicRefreshBaseline(d, {
    rootTitle: title,
    sourceProjections: [sourceProjection('explicit-source'), sourceProjection('observed-source')],
    observedSourceNodeIds: ['observed-source'],
    sourceCommittedAt: '2026-08-30T12:00:00.000Z',
    webProbe: committed.probe,
    webCommittedAt: '2026-08-30T12:00:00.000Z',
  });
  const current = buildCanonicalWebProbe([{
    url: 'https://example.com/current', title: 'Current', snippet: 'New', published: null,
  }]);
  if (!current.ok) throw new Error('invalid current probe fixture');
  storeTopicProbeCache(d, {
    rootTitle: title,
    probe: current.probe,
    assessment: { verdict: 'uncertain', reasonCode: 'insufficient_evidence', changedUrls: [] },
    assessedAt: '2026-08-30T13:00:00.000Z',
  });
}

describe('removeWiki', () => {
  it('deregisters the root so the sweep stops curating it, leaving other roots alone', async () => {
    const d = db();
    register(d, 'Bogus Wiki');
    register(d, 'Orbital Builder Redux');

    const res = await removeWiki(deps(d), { topic: 'Bogus Wiki' });

    expect(res).toMatchObject({ ok: true, topic: 'Bogus Wiki', removed: true });
    expect(wikiRootExists(d, 'Bogus Wiki')).toBe(false);
    expect(wikiRootExists(d, 'Orbital Builder Redux')).toBe(true);
    d.close();
  });

  it('clears the title-keyed control state so a later re-create starts clean', async () => {
    const d = db();
    register(d, 'Gone');
    setPaused(d, 'Gone', true, 'tester', '2026-08-04T00:00:00Z');
    addCorrection(d, { project_title: 'Gone', note: 'stop surfacing X', created_at: '2026-08-04T00:00:00Z', created_by: 'tester' });
    insertPageRequest(d, {
      project_node_id: 'n1', project_title: 'Gone', title: 'Gone', page_title: 'Gone — Sub',
      brief: null, requested_by: 'tester', created_at: '2026-08-04T00:00:00Z',
    });

    const res = await removeWiki(deps(d), { topic: 'Gone' });

    expect(res).toMatchObject({ ok: true, removed: true, cleared: { paused: 1, corrections: 1, page_requests: 1 } });
    expect(isPaused(d, 'Gone')).toBe(false);
    expect(activeCorrections(d, 'Gone')).toHaveLength(0);
    expect(pendingRequests(d, 'Gone')).toHaveLength(0);
    d.close();
  });

  it('lists the sub-pages actually left in the vault, whatever their titles', async () => {
    const d = db();
    register(d, 'Gone');
    const projectEvidence = async (ref: string) => {
      expect(ref).toBe('Gone-node');
      return { existing_wiki: { home_id: 'home', subpages: [{ id: 'a', title: 'Gone — Risks' }, { id: 'b', title: 'GoneCo Engagement Timeline' }] } };
    };
    const res = await removeWiki({ ...(deps(d) as object), engine: { projectEvidence } } as never, { topic: 'Gone' });
    expect(res).toMatchObject({ ok: true, removed: true,
      pages_left_behind: ['Gone Wiki', 'Gone — Risks', 'GoneCo Engagement Timeline'] });
    expect(res.detail).toContain('3 wiki page(s)');
    d.close();
  });

  it('falls back to the naming convention when the catalog cannot be read', async () => {
    const d = db();
    register(d, 'Gone');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = { projectEvidence: async () => { throw new Error('engine down'); } };
      const res = await removeWiki({ ...(deps(d) as object), engine } as never, { topic: 'Gone' });
      expect(res).toMatchObject({ ok: true, removed: true, pages_left_behind: ['Gone Wiki'] });
      expect(res.detail).toContain('"Gone — …" sub-pages');
      expect(getWikiRoot(d, 'Gone')).toBeUndefined();
    } finally { warn.mockRestore(); d.close(); }
  });

  it('drops stage checkpoints so a re-created wiki pays for fresh planning', async () => {
    const d = db();
    register(d, 'Gone');
    const plan = { reviewed_page_ids: [], actions: [] };
    writeStagePlanning(d, 'Gone', 'fp', { proposedPlan: plan, plan, attempts: [], droppedCreates: [], keptByDefault: [], validationIssueCodes: [],
      adjudication: { results: [], warnings: [], verdicts: [] } } as unknown as PlanningResult);
    await removeWiki(deps(d), { topic: 'Gone' });
    expect(readStageCheckpoint(d, 'Gone', 'fp')).toBeNull();
    expect(d.prepare('SELECT COUNT(*) AS c FROM wiki_stage_checkpoints').get()).toEqual({ c: 0 });
    d.close();
  });

  it('clears explicit, observed, state, and probe-cache rows in the deregistration transaction', async () => {
    const d = db();
    register(d, 'Gone');
    seedRefreshState(d, 'Gone');

    const res = await removeWiki(deps(d), { topic: 'Gone' });

    expect(res).toMatchObject({ ok: true, removed: true });
    expect(explicitTopicRefreshSources(d, 'Gone')).toEqual([]);
    expect(observedTopicRefreshSources(d, 'Gone')).toEqual([]);
    expect(topicRefreshState(d, 'Gone')).toBeUndefined();
    expect(res.pages_left_behind).toContain('Gone Wiki');
    d.close();
  });

  it('rolls back root, control, requests, and refresh deletion when a refresh-state delete fails', async () => {
    const d = db();
    register(d, 'Gone');
    setPaused(d, 'Gone', true, 'tester', '2026-08-04T00:00:00Z');
    addCorrection(d, { project_title: 'Gone', note: 'keep me', created_at: '2026-08-04T00:00:00Z', created_by: 'tester' });
    insertPageRequest(d, {
      project_node_id: 'n1', project_title: 'Gone', title: 'Gone', page_title: 'Gone — Sub',
      brief: null, requested_by: 'tester', created_at: '2026-08-04T00:00:00Z',
    });
    seedRefreshState(d, 'Gone');
    d.exec(`
      CREATE TRIGGER reject_topic_refresh_state_delete
      BEFORE DELETE ON topic_refresh_state
      WHEN OLD.root_title = 'Gone'
      BEGIN
        SELECT RAISE(ABORT, 'forced refresh delete failure');
      END;
    `);

    const res = await removeWiki(deps(d), { topic: 'Gone' });

    expect(res).toMatchObject({ ok: false, error: { code: 'REMOVE_FAILED' } });
    expect(getWikiRoot(d, 'Gone')).toBeDefined();
    expect(isPaused(d, 'Gone')).toBe(true);
    expect(activeCorrections(d, 'Gone')).toHaveLength(1);
    expect(pendingRequests(d, 'Gone')).toHaveLength(1);
    expect(explicitTopicRefreshSources(d, 'Gone')).toHaveLength(1);
    expect(observedTopicRefreshSources(d, 'Gone')).toHaveLength(1);
    expect(topicRefreshState(d, 'Gone')).toBeDefined();
    d.close();
  });

  it('waits behind in-flight topic curation so its late baseline cannot recreate refresh state after deregistration', async () => {
    const d = db();
    register(d, 'Gone');
    seedRefreshState(d, 'Gone');
    const queue = new CurationQueue();
    const coreDeps = {
      engine: {} as never,
      llm: {} as never,
      config: {} as never,
      queue,
      db: d,
    };
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const olderCuration = queue.enqueue('Gone', async () => {
      markStarted();
      await gate;
      commitTopicRefreshBaseline(d, {
        rootTitle: 'Gone',
        sourceProjections: [sourceProjection('explicit-source')],
        observedSourceNodeIds: [],
        sourceCommittedAt: '2026-08-30T14:00:00.000Z',
      });
    });
    await started;

    const removal = removeWiki(coreDeps, { topic: 'Gone' });
    await new Promise<void>(resolve => setImmediate(resolve));
    const rootWhileOlderRunIsActive = getWikiRoot(d, 'Gone');
    const queuedDepth = queue.state.depth;
    release();
    await olderCuration;
    const res = await removal;

    expect(queuedDepth).toBe(2);
    expect(rootWhileOlderRunIsActive).toBeDefined();
    expect(res).toMatchObject({ ok: true, removed: true });
    expect(getWikiRoot(d, 'Gone')).toBeUndefined();
    expect(explicitTopicRefreshSources(d, 'Gone')).toEqual([]);
    expect(observedTopicRefreshSources(d, 'Gone')).toEqual([]);
    expect(topicRefreshState(d, 'Gone')).toBeUndefined();
    d.close();
  });

  it('reports an unregistered topic as an error rather than a silent success', async () => {
    const d = db();
    register(d, 'Orbital Builder Redux');
    const res = await removeWiki(deps(d), { topic: 'Orbital Builder Redux Wiki' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NOT_REGISTERED');
    expect(wikiRootExists(d, 'Orbital Builder Redux')).toBe(true);
    d.close();
  });

  it('leaves the vault pages in place and says so', async () => {
    const d = db();
    register(d, 'Gone');
    const res = await removeWiki(deps(d), { topic: 'Gone' });
    expect(res.pages_left_behind).toContain('Gone Wiki');
    d.close();
  });

  describe('the project note\'s wiki field (#385)', () => {
    function registerProject(d: Database.Database, title: string) {
      registerWikiRoot(d, { root_title: title, root_node_id: `${title}-node`, kind: 'project', source: 'vault',
        cadence: null, brief: null, created_at: '2026-11-01T00:00:00Z', created_by: 'wiki-field' });
    }
    function fieldEngine(d: Database.Database, value: unknown) {
      const registeredWhenCleared: boolean[] = [];
      const engine = {
        projectEvidence: async () => ({ existing_wiki: { home_id: 'home', subpages: [] } }),
        readNodeField: vi.fn(async (_id: string, _field: string) => value),
        updateNodeFields: vi.fn(async (_id: string, _fields: Record<string, unknown>, _title?: string) => {
          registeredWhenCleared.push(getWikiRoot(d, 'Atlas') !== undefined);
        }),
      };
      return { engine, registeredWhenCleared };
    }

    it('removes wiki: true from the project note before deregistering, so the wiki-field check does not register it again', async () => {
      const d = db();
      registerProject(d, 'Atlas');
      const { engine, registeredWhenCleared } = fieldEngine(d, true);
      const res = await removeWiki({ ...(deps(d) as object), engine } as never, { topic: 'Atlas' });
      expect(res).toMatchObject({ ok: true, removed: true, wiki_field: 'cleared' });
      expect(res.detail).toMatch(/Removed wiki: true from the project note, so the Curator won't register the wiki again$/);
      expect(engine.readNodeField).toHaveBeenCalledWith('Atlas-node', 'wiki');
      expect(engine.updateNodeFields).toHaveBeenCalledWith('Atlas-node', { wiki: null }, 'Atlas');
      expect(registeredWhenCleared).toEqual([true]);
      expect(getWikiRoot(d, 'Atlas')).toBeUndefined();
      d.close();
    });

    it('leaves a project note without the field alone', async () => {
      const d = db();
      registerProject(d, 'Atlas');
      const { engine } = fieldEngine(d, undefined);
      const res = await removeWiki({ ...(deps(d) as object), engine } as never, { topic: 'Atlas' });
      expect(res).toMatchObject({ ok: true, removed: true, wiki_field: 'not_set' });
      expect(res.detail).not.toContain('wiki: true');
      expect(engine.updateNodeFields).not.toHaveBeenCalled();
      d.close();
    });

    it('still deregisters when the field cannot be removed, and says the wiki will come back', async () => {
      const d = db();
      registerProject(d, 'Atlas');
      const { engine } = fieldEngine(d, true);
      engine.updateNodeFields.mockRejectedValueOnce(new Error('engine busy'));
      const res = await removeWiki({ ...(deps(d) as object), engine } as never, { topic: 'Atlas' });
      expect(res).toMatchObject({ ok: true, removed: true, wiki_field: 'not_cleared' });
      expect(res.detail).toContain('Could not check or remove wiki: true on the project note (engine busy)');
      expect(res.detail).toContain('registers this wiki again within about 15 minutes');
      expect(getWikiRoot(d, 'Atlas')).toBeUndefined();
      d.close();
    });

    it('says the field is gone when deregistering fails after it was removed', async () => {
      const d = db();
      registerProject(d, 'Atlas');
      d.exec(`CREATE TRIGGER reject_root_delete BEFORE DELETE ON wiki_roots BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END;`);
      const { engine } = fieldEngine(d, true);
      const res = await removeWiki({ ...(deps(d) as object), engine } as never, { topic: 'Atlas' });
      expect(res).toMatchObject({ ok: false, error: { code: 'REMOVE_FAILED',
        message: 'forced delete failure. The wiki is still registered, but wiki: true was already removed from the project note' } });
      expect(getWikiRoot(d, 'Atlas')).toBeDefined();
      d.close();
    });

    it('removes the vault map\'s wiki request field, and nothing when it is none', async () => {
      const d = db();
      registerProject(d, 'Atlas');
      const { engine } = fieldEngine(d, true);
      const vault = { ...(defaultsFor('vault') as unknown as VaultSettings), wikiFlagField: 'make wiki' };
      const withVault = (v: VaultSettings) => ({ ...(deps(d) as { config: object }), engine,
        config: { ...(deps(d) as { config: object }).config, vault: v } }) as never;
      const res = await removeWiki(withVault(vault), { topic: 'Atlas' });
      expect(res).toMatchObject({ ok: true, removed: true, wiki_field: 'cleared' });
      expect(res.detail).toMatch(/Removed make wiki: true from the project note/);
      expect(engine.updateNodeFields).toHaveBeenCalledWith('Atlas-node', { 'make wiki': null }, 'Atlas');

      registerProject(d, 'Atlas');
      engine.readNodeField.mockClear();
      const off = await removeWiki(withVault({ ...vault, wikiFlagField: null }), { topic: 'Atlas' });
      expect(off).toMatchObject({ ok: true, removed: true });
      expect(off).not.toHaveProperty('wiki_field');
      expect(engine.readNodeField).not.toHaveBeenCalled();
      expect(getWikiRoot(d, 'Atlas')).toBeUndefined();
      d.close();
    });

    it('does not touch notes for a topic wiki', async () => {
      const d = db();
      register(d, 'Atlas');
      const { engine } = fieldEngine(d, true);
      const res = await removeWiki({ ...(deps(d) as object), engine } as never, { topic: 'Atlas' });
      expect(res).toMatchObject({ ok: true, removed: true });
      expect(res).not.toHaveProperty('wiki_field');
      expect(engine.readNodeField).not.toHaveBeenCalled();
      d.close();
    });
  });

  it('requires the curator DB (server mode)', async () => {
    const res = await removeWiki({ engine: {} as never, llm: {} as never, config: {} as never, queue: new CurationQueue() } as never, { topic: 'X' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NO_DB');
  });
});

describe('remove-wiki tool', () => {
  it('enforces curate:trigger', async () => {
    const d = db();
    register(d, 'Gone');
    const h = makeRemoveWikiHandler(deps(d));
    const res = await h({ topic: 'Gone' }, { authInfo: { scopes: [] } });
    expect(res.isError).toBe(true);
    expect(wikiRootExists(d, 'Gone')).toBe(true);
    d.close();
  });

  it('passes the topic through and reports the outcome', async () => {
    const d = db();
    register(d, 'Gone');
    const h = makeRemoveWikiHandler(deps(d));
    const res = await h({ topic: 'Gone' }, { authInfo: { scopes: ['curate:trigger'] } });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ ok: true, removed: true });
    expect(wikiRootExists(d, 'Gone')).toBe(false);
    d.close();
  });

  it('takes only a topic', () => {
    expect(Object.keys(removeWikiInput)).toEqual(['topic']);
    expect(() => removeWikiInput.topic.parse('')).toThrow();
  });
});
