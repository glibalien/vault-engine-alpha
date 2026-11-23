import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import Database from 'better-sqlite3';
import type { CurateResult, ProjectRef } from '../src/types.js';

vi.mock('../src/curate.js', () => ({
  curateProject: vi.fn(async (_e, _l, _c, project: ProjectRef, dryRun: boolean): Promise<CurateResult> => ({
    project: project.title, outcome: 'written', dryRun,
  })),
  curateRequestedPage: vi.fn(),
}));

import { curateProject } from '../src/curate.js';
import { runMigrations } from '../src/db/migrate.js';
import { getWikiRoot, registerWikiRoot, deleteWikiRoot } from '../src/db/wiki-roots.js';
import { setPaused } from '../src/db/control.js';
import { CurationQueue } from '../src/queue.js';
import { BackgroundBuilds } from '../src/background-builds.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { EngineError } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { CoreDeps } from '../src/core.js';
import { startWikiFieldTimer, WikiFieldCheck, wikiFieldCheckLog, WIKI_FIELD_CHECK_EVERY_MS } from '../src/wiki-field-check.js';

interface Note { id: string; title: string; value: unknown; types?: string[]; field?: string }

function setup(notes: Note[]) {
  const db = new Database(':memory:'); runMigrations(db);
  const appends: string[] = [];
  const find = (ref: string) => notes.find(n => n.id === ref || n.title === ref);
  const engine = {
    listNodesWithField: vi.fn(async (_type: string, _field: string) => notes.map(({ id, title, value }) => ({ id, title, value }))),
    projectEvidence: vi.fn(async (ref: string) => {
      const note = find(ref);
      if (!note) throw new EngineError('NOT_FOUND', `Project not found: ${ref}`);
      return { project: { id: note.id, title: note.title, file_path: '', status: 'open' },
        existing_wiki: { home_id: null, home: null, subpages: [], topology_hash: 't', catalog_valid: true } };
    }),
    getNode: vi.fn(async (id: string) => ({ id, title: find(id)?.title ?? id, types: find(id)?.types ?? ['project'], fields: {}, body: '' })),
    readNodeField: vi.fn(async (id: string, field: string) => (field === (notes.find(n => n.id === id)?.field ?? 'wiki') ? find(id)?.value : undefined)),
    wikiCreateHome: vi.fn(async () => ({ node_id: 'home', created: true })),
    listActiveProjects: vi.fn(async () => []),
    findNodesByExactTitle: vi.fn(async () => []),
    getNodeByTitle: vi.fn(async () => ({ id: 'journal-note' })),
    appendNodeBody: vi.fn(async (_id: string, text: string) => { appends.push(text); }),
  };
  const kept: Promise<unknown>[] = [];
  const llm = { structuredCall: vi.fn(async () => { throw new Error('the check makes no model calls'); }) };
  const config = { journalEnabled: true, curatorTz: 'UTC', model: 'm', activeStatuses: ['open'], projectType: 'project' } as unknown as Config;
  const core: CoreDeps = { engine: engine as never, llm, config, queue: new CurationQueue(), db,
    recorder: new ActionRecorder(db), builds: new BackgroundBuilds(work => { kept.push(work); }) };
  const coreDeps = vi.fn(async () => core);
  let projectType = 'project';
  let wikiFlagField: string | null = 'wiki';
  const vocabulary = vi.fn(async () => ({ projectType, wikiFlagField }));
  const check = new WikiFieldCheck({ engine, db, vocabulary, coreDeps });
  return { db, engine, kept, llm, appends, coreDeps, check, core, vocabulary, setType: (t: string) => { projectType = t; },
    setField: (field: string | null) => { wikiFlagField = field; } };
}

function registerProject(db: Database.Database, title: string, nodeId: string | null) {
  registerWikiRoot(db, { root_title: title, root_node_id: nodeId, kind: 'project', source: 'vault', cadence: null, brief: null,
    created_at: '2026-11-01T00:00:00Z', created_by: 'client-1' });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('WikiFieldCheck', () => {
  it('registers a wiki for a project note that says wiki: true and queues its first build like create-project-wiki', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }]);
    const result = await f.check.run();
    expect(result).toEqual({ field: 'wiki', asked: 1, created: [{ title: 'Atlas', detail: expect.stringMatching(/^wiki registered with an empty home; its first build is queued\./) }],
      refused: [] });
    expect(f.engine.listNodesWithField).toHaveBeenCalledWith('project', 'wiki');
    expect(getWikiRoot(f.db, 'Atlas')).toMatchObject({ kind: 'project', root_node_id: 'p-1', created_by: 'wiki-field' });
    expect(f.engine.wikiCreateHome).toHaveBeenCalledWith('p-1', false);
    expect(f.kept).toHaveLength(1); // the first build went through BackgroundBuilds
    await f.kept[0];
    expect(curateProject).toHaveBeenCalledTimes(1);
    expect((curateProject as Mock).mock.calls[0]![3]).toMatchObject({ id: 'p-1', title: 'Atlas' });
    expect(f.llm.structuredCall).not.toHaveBeenCalled();
    expect(wikiFieldCheckLog(result)).toEqual([expect.stringMatching(
      /^wiki field check: registered a wiki for "Atlas" \(its note says wiki: true\): wiki registered with an empty home; its first build is queued\./)]);
    // Next time it is registered: one read, nothing else.
    const reads = f.engine.projectEvidence.mock.calls.length;
    expect(await f.check.run()).toEqual({ field: 'wiki', asked: 1, created: [], refused: [] });
    expect(f.engine.projectEvidence).toHaveBeenCalledTimes(reads);
    expect(f.coreDeps).toHaveBeenCalledTimes(1);
    f.db.close();
  });

  it('leaves registered wikis alone, paused or not, renamed or registered by title only', async () => {
    const f = setup([
      { id: 'p-1', title: 'Atlas', value: true },
      { id: 'p-2', title: 'Beacon (renamed)', value: true },
      { id: 'p-3', title: 'Comet', value: true },
    ]);
    registerProject(f.db, 'Atlas', 'p-1');
    setPaused(f.db, 'Atlas', true, 'tester', '2026-11-01T00:00:00Z');
    registerProject(f.db, 'Beacon', 'p-2');
    registerProject(f.db, 'Comet', null);
    expect(await f.check.run()).toEqual({ field: 'wiki', asked: 3, created: [], refused: [] });
    expect(f.coreDeps).not.toHaveBeenCalled(); // nothing to create: the read was the whole check
    expect(f.engine.projectEvidence).not.toHaveBeenCalled();
    f.db.close();
  });

  it('ignores a wiki field that does not say true', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: false }, { id: 'p-2', title: 'Beacon', value: 'someday' }]);
    expect(await f.check.run()).toEqual({ field: 'wiki', asked: 0, created: [], refused: [] });
    expect(getWikiRoot(f.db, 'Atlas')).toBeUndefined();
    expect(f.coreDeps).not.toHaveBeenCalled();
    f.db.close();
  });

  it('reads notes of the Engine\'s project type', async () => {
    const f = setup([]);
    f.setType('initiative');
    await f.check.run();
    expect(f.engine.listNodesWithField).toHaveBeenCalledWith('initiative', 'wiki');
    f.db.close();
  });

  it('reads the vault map\'s wiki request field, and re-reads that field before registering', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true, field: 'make wiki' }]);
    f.setField('make wiki');
    const result = await f.check.run();
    expect(f.engine.listNodesWithField).toHaveBeenCalledWith('project', 'make wiki');
    expect(f.engine.readNodeField).toHaveBeenCalledWith('p-1', 'make wiki');
    expect(result).toMatchObject({ field: 'make wiki', asked: 1, created: [{ title: 'Atlas' }] });
    expect(wikiFieldCheckLog(result)).toEqual([expect.stringContaining('(its note says make wiki: true)')]);
    expect(getWikiRoot(f.db, 'Atlas')).toMatchObject({ kind: 'project', created_by: 'wiki-field' });
    f.db.close();
  });

  it('reads the vocabulary afresh on every check, so a field emptied between checks stops the next one', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }]);
    f.setField(null);
    await f.check.run();
    f.setField('wiki');
    expect(await f.check.run()).toMatchObject({ field: 'wiki', asked: 1, created: [{ title: 'Atlas' }] });
    f.setField(null);
    deleteWikiRoot(f.db, 'Atlas');
    expect(await f.check.run()).toEqual({ field: null, asked: 0, created: [], refused: [] });
    expect(f.vocabulary).toHaveBeenCalledTimes(3);
    expect(f.engine.listNodesWithField).toHaveBeenCalledTimes(1);
    f.db.close();
  });

  it('is off when the request field is none: no read, nothing registered', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }]);
    f.setField(null);
    expect(await f.check.run()).toEqual({ field: null, asked: 0, created: [], refused: [] });
    expect(f.engine.listNodesWithField).not.toHaveBeenCalled();
    expect(f.coreDeps).not.toHaveBeenCalled();
    expect(getWikiRoot(f.db, 'Atlas')).toBeUndefined();
    f.db.close();
  });

  it('journals a refusal once per note and reason, with no model call', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }]);
    registerWikiRoot(f.db, { root_title: 'Atlas', root_node_id: 'topic-1', kind: 'topic', source: 'vault', cadence: null,
      brief: null, created_at: '2026-11-01T00:00:00Z', created_by: null });
    const first = await f.check.run();
    expect(first.refused).toEqual([{ title: 'Atlas', code: 'TITLE_IN_USE', message: '"Atlas" is already a topic wiki', reported: true }]);
    expect(f.appends).toHaveLength(1);
    expect(f.appends[0]).toContain('— wiki field check');
    expect(f.appends[0]).toContain('**Wiki field on project notes**');
    expect(f.appends[0]).toContain('no wiki created for "Atlas", whose note says wiki: true: "Atlas" is already a topic wiki (TITLE_IN_USE)');
    expect(f.llm.structuredCall).not.toHaveBeenCalled();
    expect(wikiFieldCheckLog(first)).toEqual(['wiki field check: no wiki created for "Atlas": "Atlas" is already a topic wiki (TITLE_IN_USE)']);

    // Still refused for the same reason: not journaled or logged again.
    const second = await f.check.run();
    expect(second.refused).toEqual([expect.objectContaining({ code: 'TITLE_IN_USE', reported: false })]);
    expect(wikiFieldCheckLog(second)).toEqual([]);
    expect(f.appends).toHaveLength(1);

    // A different reason is news.
    deleteWikiRoot(f.db, 'Atlas');
    f.engine.projectEvidence.mockRejectedValueOnce(new Error('engine busy'));
    expect((await f.check.run()).refused).toEqual([expect.objectContaining({ code: 'UNKNOWN_PROJECT', reported: true })]);
    expect(f.appends).toHaveLength(2);

    // Once it works, the wiki is registered and a later refusal would be journaled again.
    expect((await f.check.run()).created).toEqual([expect.objectContaining({ title: 'Atlas' })]);
    f.db.close();
  });

  it('journals the same refusal again after the note stopped asking and asks again', async () => {
    const notes: Note[] = [{ id: 'p-1', title: 'Atlas', value: true, types: ['note'] }];
    const f = setup(notes);
    expect((await f.check.run()).refused).toEqual([expect.objectContaining({ code: 'NOT_A_PROJECT', reported: true })]);
    notes[0]!.value = null;
    await f.check.run();
    notes[0]!.value = true;
    expect((await f.check.run()).refused).toEqual([expect.objectContaining({ code: 'NOT_A_PROJECT', reported: true })]);
    expect(f.appends).toHaveLength(2);
    f.db.close();
  });

  it('does not undo a remove-wiki that cleared the field while the check waited for the queue', async () => {
    const notes: Note[] = [{ id: 'p-1', title: 'Atlas', value: true }, { id: 'p-2', title: 'Beacon', value: true }];
    const f = setup(notes);
    // While Atlas registers, Beacon gets a wiki elsewhere and remove-wiki takes it away again, clearing its field.
    f.engine.wikiCreateHome.mockImplementationOnce(async () => { notes[1]!.value = null; return { node_id: 'home', created: true }; });
    const result = await f.check.run();
    expect(result.created).toEqual([expect.objectContaining({ title: 'Atlas' })]);
    expect(result.refused).toEqual([]);
    expect(getWikiRoot(f.db, 'Beacon')).toBeUndefined();
    expect(f.engine.readNodeField).toHaveBeenCalledWith('p-2', 'wiki');
    expect(f.appends.filter(text => text.includes('wiki field check'))).toEqual([]);
    f.db.close();
  });

  it('registers nothing when the field cannot be read again in the queue, and says so', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }]);
    f.engine.readNodeField.mockRejectedValueOnce(new Error('engine busy'));
    expect((await f.check.run()).refused).toEqual([expect.objectContaining({ code: 'CREATE_FAILED', message: 'engine busy', reported: true })]);
    expect(getWikiRoot(f.db, 'Atlas')).toBeUndefined();
    f.db.close();
  });

  it('stops before the next project once shutdown begins', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }, { id: 'p-2', title: 'Beacon', value: true }]);
    let stopping = false;
    f.engine.wikiCreateHome.mockImplementationOnce(async () => { stopping = true; return { node_id: 'home', created: true }; });
    expect((await f.check.run(() => stopping)).created).toEqual([expect.objectContaining({ title: 'Atlas' })]);
    expect(getWikiRoot(f.db, 'Beacon')).toBeUndefined();
    f.db.close();
  });

  it('fails without registering anything when the read fails', async () => {
    const f = setup([{ id: 'p-1', title: 'Atlas', value: true }]);
    f.engine.listNodesWithField.mockRejectedValueOnce(new Error('engine down'));
    await expect(f.check.run()).rejects.toThrow('engine down');
    expect(getWikiRoot(f.db, 'Atlas')).toBeUndefined();
    f.db.close();
  });
});

describe('startWikiFieldTimer', () => {
  function fakeTimers() {
    const armed: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
    const setTimer = (fire: () => void, ms: number) => {
      const t = { ms, fire, cleared: false };
      armed.push(t);
      return { clear: () => { t.cleared = true; } };
    };
    return { armed, setTimer };
  }
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));

  it('checks once at startup and again 15 minutes after each check ends, never overlapping', async () => {
    const { armed, setTimer } = fakeTimers();
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const timer = startWikiFieldTimer({ check, setTimer });
    expect(armed.map(t => t.ms)).toEqual([0]);
    armed[0]!.fire();
    expect(check).toHaveBeenCalledTimes(1);
    await settle();
    expect(armed).toHaveLength(1); // the next check waits for this one
    release();
    await settle();
    expect(armed.map(t => t.ms)).toEqual([0, WIKI_FIELD_CHECK_EVERY_MS]);
    expect(WIKI_FIELD_CHECK_EVERY_MS).toBe(15 * 60_000);
    timer.stop();
    expect(armed[1]!.cleared).toBe(true);
  });

  it('reports a failed check and tries again at the next interval', async () => {
    const { armed, setTimer } = fakeTimers();
    const onError = vi.fn();
    startWikiFieldTimer({ check: () => Promise.reject(new Error('engine down')), onError, setTimer, everyMs: 5 });
    armed[0]!.fire();
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'engine down' }));
    expect(armed.map(t => t.ms)).toEqual([0, 5]);
  });

  it('ends when the server stops accepting work, and tells a running check to stop', async () => {
    const { armed, setTimer } = fakeTimers();
    startWikiFieldTimer({ check: () => undefined, setTimer });
    armed[0]!.fire();
    await settle();
    expect(armed).toHaveLength(1);

    const later = fakeTimers();
    let stopped: (() => boolean) | undefined;
    let release!: () => void;
    const timer = startWikiFieldTimer({ setTimer: later.setTimer,
      check: s => { stopped = s; return new Promise<void>(resolve => { release = resolve; }); } });
    later.armed[0]!.fire();
    expect(stopped!()).toBe(false);
    timer.stop();
    expect(stopped!()).toBe(true);
    release();
    await settle();
    expect(later.armed).toHaveLength(1);
  });
});
