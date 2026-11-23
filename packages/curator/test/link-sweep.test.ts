import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { CurationQueue } from '../src/queue.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { countLinkSweepRechecks, countReportedLinkSweepNotes, knownLinkSweepNames, linkSweepNoteStatuses, markLinkSweepNote, pendingLinkSweepNotes, readLinkSweepWatermark } from '../src/db/link-sweep.js';
import { ledgerHash, upsertLedger } from '../src/db/memory-sweep.js';
import { orgLedgerHash, upsertOrgLedger } from '../src/db/org-sweep.js';
import { readPageNoteStates, writePageNoteStates } from '../src/db/page-note-states.js';
import type { Config } from '../src/config.js';
import { EngineError, type Engine, type LinkSweepNoteRef } from '../src/engine.js';
import type { EngineNode } from '../src/types.js';

// #332: the link sweep's orchestration, with a fake Engine. Names are made up.

const writeJournalEntry = vi.fn(async () => {});
vi.mock('../src/journal/writer.js', () => ({ writeJournalEntry: (...args: unknown[]) => writeJournalEntry(...(args as [])) }));
const { runLinkSweep, runLinkSweepOnTimer, linkTargetTypes, FIRST_RUN_LOOKBACK_MS, NEW_NAMES_PER_RUN, applicableMention, linkable, standsAlone, withLinks } = await import('../src/link-sweep.js');

const NOW = new Date('2026-11-17T05:00:00Z');
const MIN = 60_000;

function config(over: Partial<Config> = {}): Config {
  return {
    linkSweepEnabled: true, linkSweepMode: 'report', linkSweepBacklog: 'off', linkSweepSchedule: 'daily', linkSweepQuietMinutes: 30, linkSweepTargetTypes: [], linkSweepNoteCap: 50,
    settingsDir: 'Settings', journalEnabled: true,
    ...over,
  } as Config;
}

interface FakeNote { ref: LinkSweepNoteRef; body: string; links?: string[]; failRead?: boolean; version?: number; hash?: string; inlinks?: number; outlinks?: number }

function fakeEngine(notes: FakeNote[], targets: Array<{ id: string; title: string; aliases: string[]; type?: string }> = [
  { id: 'acme', title: 'Acme', aliases: ['Acme Corp'] },
  { id: 'sam', title: 'Sam Rivera', aliases: [] },
], opts: { pageLimit?: number; notesTotal?: number; mentionCounts?: Record<string, number>; titleCounts?: Record<string, number>; writeError?: Record<string, Error>; noNewHash?: boolean } = {}) {
  const calls = {
    created: [] as Array<Record<string, unknown>>, byId: [] as string[][], read: [] as string[], targetTypes: [] as string[][], counted: [] as Array<string | undefined>,
    writes: [] as Array<{ nodeId: string; body: string; expectedVersion: number; expectedContentHash: string }>, titled: [] as string[],
    backlog: [] as Array<Record<string, unknown>>, naming: [] as string[],
  };
  const byId = new Map(notes.map(n => [n.ref.id, n]));
  const engine = {
    listLinkTargets: async (types: string[]) => { calls.targetTypes.push(types); return targets.map(t => ({ type: 'company', ...t })); },
    countNotes: async (text?: string) => {
      calls.counted.push(text);
      return text === undefined ? (opts.notesTotal ?? 1000) : (opts.mentionCounts?.[text] ?? 0);
    },
    listCreatedNotes: async (args: Record<string, unknown>) => {
      calls.created.push(args);
      const since = Date.parse(String(args.createdSince));
      const listed = notes.map(n => n.ref).filter(r => typeof r.created_at !== 'number' || r.created_at >= since);
      return opts.pageLimit !== undefined && listed.length > opts.pageLimit
        ? { nodes: listed.slice(0, opts.pageLimit), truncated: true }
        : { nodes: listed, truncated: false };
    },
    listNotesById: async (ids: string[]) => { calls.byId.push(ids); return ids.flatMap(id => byId.get(id)?.ref ?? []); },
    // The notes holding a name as whole words, any case (#699).
    listNotesNaming: async (text: string) => {
      calls.naming.push(text);
      const words = new RegExp(`(?<![\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
      return notes.filter(n => words.test(n.body)).map(n => n.ref.id);
    },
    // Every note, as the Engine lists them for the backlog (#697), with link counts.
    listLinkSweepBacklog: async (args: Record<string, unknown>) => {
      calls.backlog.push(args);
      return { nodes: notes.map(n => ({ ...n.ref, inlink_count: n.inlinks ?? 0, outlink_count: n.outlinks ?? 0 })) };
    },
    getNode: async (id: string): Promise<EngineNode> => {
      calls.read.push(id);
      const n = byId.get(id)!;
      if (n.failRead) throw new Error('engine unavailable');
      return {
        id, title: n.ref.title, types: [], fields: {}, body: n.body, version: n.version ?? 3,
        metadata: { content_hash: n.hash ?? `hash-${id}` },
        relationships: { outgoing: { wikilink: (n.links ?? []).map(t => ({ target_id: t, target_title: t })) }, incoming: {} },
      } as EngineNode;
    },
    countTitled: async (title: string) => { calls.titled.push(title); return opts.titleCounts?.[title] ?? 1; },
    setBodyCas: async (input: { nodeId: string; body: string; expectedVersion: number; expectedContentHash: string }) => {
      const failure = opts.writeError?.[input.nodeId];
      if (failure) throw failure;
      calls.writes.push(input);
      return { operationId: `op-${input.nodeId}`, contentHash: opts.noNewHash ? null : `linked-${input.nodeId}` };
    },
  };
  return { engine: engine as unknown as Engine, calls };
}

let db: Database.Database;
let recorder: ActionRecorder;
const events = () => db.prepare('SELECT kind, action, function, target, detail, dry_run FROM journal_events ORDER BY id').all() as
  Array<{ kind: string; action: string | null; function: string; target: string | null; detail: string; dry_run: number }>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  recorder = new ActionRecorder(db);
  writeJournalEntry.mockClear();
});
afterEach(() => db.close());

const note = (id: string, body: string, minutesAgo = 120, extra: Partial<FakeNote> = {}): FakeNote =>
  ({ ref: { id, title: `Note ${id}`, file_path: `Notes/Note ${id}.md`, file_mtime: NOW.getTime() - minutesAgo * MIN }, body, ...extra });

const run = (deps: Parameters<typeof runLinkSweep>[0], over: Partial<Parameters<typeof runLinkSweep>[1]> = {}) =>
  runLinkSweep(deps, { dryRun: false, trigger: 'scheduled', schedule: 'daily', now: () => NOW, ...over });

describe('runLinkSweep (#332)', () => {
  it('does nothing when off, or on another schedule', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Acme')]);
    const queue = new CurationQueue();
    expect((await run({ engine, config: config({ linkSweepEnabled: false }), queue, db, recorder })).ran).toBe(false);
    expect((await run({ engine, config: config({ linkSweepSchedule: 'timer' }), queue, db, recorder })).ran).toBe(false);
    expect(calls.read).toEqual([]);
    expect(events()).toEqual([]);
  });

  it('reports each new note\'s mentions in the journal, changes nothing, and moves its mark', async () => {
    const { engine, calls } = fakeEngine([
      note('a', 'Met Sam Rivera from Acme Corp.'),
      note('b', 'Nothing to link here.'),
      note('c', 'Acme again, already linked.', 120, { links: ['acme'] }),
    ]);
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder });

    expect(r).toMatchObject({ ran: true, read: 3, notesWithLinks: 1, links: 2, leftForLater: 0, errors: 0 });
    // A first run looks back a day; settings and wiki pages are left out.
    expect(calls.created[0]).toMatchObject({ createdSince: new Date(NOW.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString(), withoutTypes: ['wiki'], withoutPathPrefix: 'Settings/' });
    expect(calls.targetTypes[0]).toEqual(['project', 'person', 'company']);
    const [proposed, summary] = events();
    expect(proposed).toMatchObject({ kind: 'action', action: 'links-proposed', function: 'link-sweep', target: 'Note a', dry_run: 0 });
    expect(proposed!.detail).toBe('could link 2 mentions in "Note a": Sam Rivera: "Met Sam Rivera from Acme Corp."; Acme (as "Acme Corp"): "Met Sam Rivera from Acme Corp."');
    expect(JSON.parse(summary!.detail).line).toBe('read 3 new notes; 2 links to propose in 1 note. Report only: no note was changed.');
    expect(readLinkSweepWatermark(db)).toBe(NOW.toISOString());
    expect([...linkSweepNoteStatuses(db, ['a', 'b', 'c']).values()]).toEqual(['reported', 'reported', 'reported']);
  });

  it('reports a note once, even when the listing shows it again', async () => {
    const fake = fakeEngine([note('a', 'Acme')]);
    const deps = { engine: fake.engine, config: config(), queue: new CurationQueue(), db, recorder };
    await run(deps);
    const again = await run(deps, { now: () => new Date(NOW.getTime() + 60 * MIN) });
    expect(again).toMatchObject({ read: 0, links: 0 });
    expect(fake.calls.created[1]).toMatchObject({ createdSince: NOW.toISOString() });
  });

  it('leaves a note edited too recently, or past the cap, for a later run, then reads it', async () => {
    const fake = fakeEngine([note('a', 'Acme', 10), note('b', 'Sam Rivera'), note('c', 'Acme Corp')]);
    const deps = { engine: fake.engine, config: config({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder };
    const first = await run(deps);
    expect(first).toMatchObject({ read: 1, leftForLater: 2 });
    expect(JSON.parse(events().at(-1)!.detail).line).toContain('2 left for a later run');
    expect(pendingLinkSweepNotes(db).sort()).toEqual(['a', 'c']);

    // An hour later, both are read: fetched by id, though created before the mark.
    const later = await run({ ...deps, config: config() }, { now: () => new Date(NOW.getTime() + 60 * MIN) });
    expect(fake.calls.byId.at(-1)!.sort()).toEqual(['a', 'c']);
    expect(later).toMatchObject({ read: 2, leftForLater: 0 });
    expect(pendingLinkSweepNotes(db)).toEqual([]);
  });

  it('moves past a truncated listing, so notes after its last page are reached (Codex on #624)', async () => {
    const created = (id: string, minutesAgo: number) => {
      const n = note(id, 'Acme');
      n.ref.created_at = NOW.getTime() - minutesAgo * MIN;
      return n;
    };
    const fake = fakeEngine([created('a', 300), created('b', 200), created('c', 100)], undefined, { pageLimit: 2 });
    const deps = { engine: fake.engine, config: config(), queue: new CurationQueue(), db, recorder };
    const first = await run(deps);
    expect(first).toMatchObject({ read: 2, detail: 'more new notes than one run lists; the rest come next run' });
    expect(readLinkSweepWatermark(db)).toBe(new Date(NOW.getTime() - 200 * MIN).toISOString());
    const second = await run(deps, { now: () => new Date(NOW.getTime() + 60 * MIN) });
    expect(second.read).toBe(1);
    expect(fake.calls.read).toEqual(['a', 'b', 'c']);
    expect(readLinkSweepWatermark(db)).toBe(new Date(NOW.getTime() + 60 * MIN).toISOString());
  });

  it('forgets a pending note deleted while it waited, and keeps one it could not read', async () => {
    const fake = fakeEngine([note('a', 'Acme', 10), note('b', 'Acme', 120, { failRead: true })]);
    const deps = { engine: fake.engine, config: config(), queue: new CurationQueue(), db, recorder };
    const r = await run(deps);
    expect(r).toMatchObject({ read: 0, errors: 1, leftForLater: 1 });
    expect(pendingLinkSweepNotes(db).sort()).toEqual(['a', 'b']);
    const gone = fakeEngine([]);
    await run({ ...deps, engine: gone.engine }, { now: () => new Date(NOW.getTime() + 60 * MIN) });
    expect(pendingLinkSweepNotes(db)).toEqual([]);
  });

  it('puts a note whose read failed behind the others, so it can\'t block them (Codex on #624)', async () => {
    const fake = fakeEngine([note('a', 'Acme', 120, { failRead: true }), note('b', 'Sam Rivera'), note('c', 'Acme Corp')]);
    const deps = { engine: fake.engine, config: config({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder };
    const t = (minutes: number) => ({ now: () => new Date(NOW.getTime() + minutes * MIN) });
    await run(deps);                    // tries a (fails); b and c wait for the cap
    await run(deps, t(60));             // b and c have waited longer than a: b is read
    await run(deps, t(120));            // then c
    expect(fake.calls.read).toEqual(['a', 'b', 'c']);
    expect(pendingLinkSweepNotes(db)).toEqual(['a']);
  });

  it('changes no bookkeeping on a dry run, and marks its events as dry', async () => {
    const { engine } = fakeEngine([note('a', 'Acme'), note('b', 'Sam Rivera', 5)]);
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder }, { dryRun: true });
    expect(r).toMatchObject({ read: 1, links: 1, leftForLater: 1, dryRun: true });
    expect(events().every(e => e.dry_run === 1)).toBe(true);
    expect(readLinkSweepWatermark(db)).toBeNull();
    expect(linkSweepNoteStatuses(db, ['a', 'b']).size).toBe(0);
  });

  it('uses the configured kinds, and says so when there are none', async () => {
    expect(linkTargetTypes(config({ linkSweepTargetTypes: ['client', 'vendor'] }))).toEqual(['client', 'vendor']);
    const noKinds = config({ vault: { projectType: null, personType: null, companyType: null } as Config['vault'] });
    const { engine } = fakeEngine([note('a', 'Acme')]);
    const r = await run({ engine, config: noKinds, queue: new CurationQueue(), db, recorder });
    expect(r.detail).toContain('no kinds to link to');
    expect(r.read).toBe(0);
  });
});

describe('runLinkSweep: people and common names (#332 tightening)', () => {
  it("matches a note of the vault's person kind only by its full name", async () => {
    const { engine } = fakeEngine([note('a', 'Sam said hi to Sam Rivera.'), note('b', 'Sam agreed.')],
      [{ id: 'sam', title: 'Sam Rivera', aliases: ['Sam'], type: 'person' }]);
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ read: 2, notesWithLinks: 1, links: 1 });
    expect(events()[0]!.detail).toBe('could link one mention in "Note a": Sam Rivera: "Sam said hi to Sam Rivera."');
  });

  it('leaves out a name found in at least 5% of notes and 200 of them, counting each name once a run', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Acme and Sam Rivera.'), note('b', 'Acme again.')], undefined,
      { notesTotal: 4000, mentionCounts: { Acme: 400, 'Sam Rivera': 150 } });
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ read: 2, notesWithLinks: 1, links: 1, commonNames: ['Acme 10%'] });
    expect(calls.counted).toEqual([undefined, 'Acme', 'Sam Rivera']);
    const summary = events().find(e => e.kind === 'summary')!;
    expect(JSON.parse(summary.detail).line).toBe('read 2 new notes; 1 link to propose in 1 note; 1 name skipped as too common (Acme 10%). Report only: no note was changed.');
  });

  it('keeps a name below the note floor, however large its share of a small vault', async () => {
    const { engine } = fakeEngine([note('a', 'Acme')], undefined, { notesTotal: 300, mentionCounts: { Acme: 150 } });
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ links: 1, commonNames: [] });
  });

  it('stops on a note when the Engine counts every note for a name (an Engine older than #687)', async () => {
    const { engine } = fakeEngine([note('a', 'Acme')], undefined, { notesTotal: 4000, mentionCounts: { Acme: 4000 } });
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ read: 0, links: 0, errors: 1, commonNames: [] });
    expect(pendingLinkSweepNotes(db)).toEqual(['a']);   // read again next run
  });
});

describe('Engine.countNotes (#687)', () => {
  it('counts whole words with full_text_words, not a substring with full_text', async () => {
    const { Engine } = await import('../src/engine.js');
    const engine = new Engine({ url: 'http://unused', token: 'unused' } as never);
    const call = vi.fn(async () => ({ total: 7 }));
    (engine as unknown as { call: typeof call }).call = call;
    expect(await engine.countNotes('Ark')).toBe(7);
    expect(await engine.countNotes()).toBe(7);
    expect(call.mock.calls).toEqual([
      ['query-nodes', { full_text_words: 'Ark', select: ['id'], limit: 1 }],
      ['query-nodes', { select: ['id'], limit: 1 }],
    ]);
  });
});

describe('runLinkSweepOnTimer', () => {
  it('runs only on the timer schedule, and writes its own journal entry only when it found something', async () => {
    const llm = { structuredCall: vi.fn() };
    const quiet = fakeEngine([note('a', 'Nothing here.')]);
    const deps = { engine: quiet.engine, llm, config: config({ linkSweepSchedule: 'timer' }), queue: new CurationQueue(), db, recorder };
    expect((await runLinkSweepOnTimer(deps, () => {}, () => NOW)).read).toBe(1);
    expect(events()).toEqual([]);                    // an empty timer run stays out of the journal
    expect(writeJournalEntry).not.toHaveBeenCalled();

    const busy = fakeEngine([note('b', 'Lunch with Sam Rivera.')]);
    const r = await runLinkSweepOnTimer({ ...deps, engine: busy.engine }, () => {}, () => NOW);
    expect(r.links).toBe(1);
    expect(writeJournalEntry).toHaveBeenCalledTimes(1);
    expect(writeJournalEntry.mock.calls[0]).toEqual([
      expect.objectContaining({ db, recorder }), { kind: 'run-refs', runRefs: [r.runRef] }, 'link sweep', expect.any(Date), { modelLede: false },
    ]);
    expect(llm.structuredCall).not.toHaveBeenCalled();

    // On the daily schedule the timer does nothing.
    const daily = await runLinkSweepOnTimer({ ...deps, config: config() }, () => {}, () => NOW);
    expect(daily.ran).toBe(false);
  });
});

describe('runLinkSweep in apply mode (#332)', () => {
  const kinds: Array<{ id: string; title: string; aliases: string[]; type: string }> = [
    { id: 'acme', title: 'Acme', aliases: ['Acme Corp'], type: 'company' },
    { id: 'northwind', title: 'Northwind Trading', aliases: [], type: 'company' },
    { id: 'sam', title: 'Sam Rivera', aliases: [], type: 'person' },
    { id: 'orion', title: 'Orion Launch', aliases: [], type: 'project' },
  ];
  const applyConfig = (over: Partial<Config> = {}) => config({ linkSweepMode: 'apply', ...over });
  const lineOf = (e: { detail: string }) => JSON.parse(e.detail).line as string;

  it('links people and companies named as written, lists the rest, and writes each note once under its read guards', async () => {
    const body = 'Met Sam Rivera from Acme Corp about the Orion Launch. Also northwind trading.';
    const { engine, calls } = fakeEngine([note('a', body, 120, { version: 7, hash: 'h7' }), note('b', 'Nothing here.')], kinds);
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });

    expect(r).toMatchObject({ read: 2, linksAdded: 2, notesLinked: 1, links: 2, notesWithLinks: 1, errors: 0 });
    expect(calls.writes).toEqual([{
      nodeId: 'a', expectedVersion: 7, expectedContentHash: 'h7',
      body: 'Met [[Sam Rivera]] from [[Acme|Acme Corp]] about the Orion Launch. Also northwind trading.',
    }]);
    const [added, proposed, summary] = events();
    expect(added).toMatchObject({ action: 'links-added', target: 'Note a', dry_run: 0 });
    expect(added!.detail).toMatch(/^linked 2 mentions in "Note a": Sam Rivera: "Met Sam Rivera from .*"; Acme \(as "Acme Corp"\): "Met Sam Rivera from Acme Corp .*" \(undo-operations op-a\)$/);
    expect(proposed).toMatchObject({ action: 'links-proposed' });
    expect(proposed!.detail).toMatch(/^could link 2 mentions in "Note a": Orion Launch: .*; Northwind Trading \(as "northwind trading"\): /);
    expect(lineOf(summary!)).toBe('read 2 notes; added 2 links in 1 note; 2 more links to propose in 1 note. Undo one note with the undo-operations id on its line, or this whole run in one call: undo-operations with operation_ids ["op-a"]. The Engine keeps undo for 24 hours.');
    expect(JSON.parse(summary!.detail).stats.operationIds).toEqual(['op-a']);
    expect([...linkSweepNoteStatuses(db, ['a', 'b']).values()]).toEqual(['applied', 'applied']);
  });

  it('lists a mention inside brackets instead of nesting a link in them (Codex, #689)', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Brackets [Acme] with no definition, and Sam Rivera.')], kinds);
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ linksAdded: 1, links: 1 });
    expect(calls.writes[0]!.body).toBe('Brackets [Acme] with no definition, and [[Sam Rivera]].');
  });

  it('moves the memory and typing records of a note they read as it was, so links alone never make it look new', async () => {
    upsertLedger(db, 'a', 'h-a', '2026-11-16T10:00:00Z');        // memory sweep read a as the sweep reads it
    upsertOrgLedger(db, 'a', 'h-a', '2026-11-16T10:00:00Z');
    upsertLedger(db, 'b', 'older', '2026-11-16T10:00:00Z');      // b was edited after the memory sweep read it
    const { engine } = fakeEngine([note('a', 'Lunch with Sam Rivera.', 120, { hash: 'h-a' }), note('b', 'Call with Acme.', 120, { hash: 'h-b' }),
      note('c', 'Met Sam Rivera.', 120, { hash: 'h-c' })], kinds);
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ notesLinked: 3, ledgersKept: 1 });
    expect(ledgerHash(db, 'a')).toBe('linked-a');
    expect(orgLedgerHash(db, 'a')).toBe('linked-a');
    expect(ledgerHash(db, 'b')).toBe('older');                   // read again by the memory sweep, edit and all
    expect(ledgerHash(db, 'c')).toBeUndefined();                 // never read by it: nothing made up
    expect(JSON.parse(events().at(-1)!.detail).stats.ledgersKept).toBe(1);
  });

  it('moves a wiki page\'s record of a note it read as the sweep read it, so its next rewrite does not take the note as changed (#332)', async () => {
    writePageNoteStates(db, 'Orion', '2026-11-16T10:00:00Z', [
      { pageId: 'page-1', notes: { a: 'h-a', b: 'h-b-older', z: 'h-z' } },  // a as the sweep reads it, b edited since
      { pageId: 'page-2', notes: { z: 'h-z' } },                          // never read a
    ]);
    const { engine } = fakeEngine([note('a', 'Lunch with Sam Rivera.', 120, { hash: 'h-a' }), note('b', 'Call with Acme.', 120, { hash: 'h-b' })], kinds);
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ notesLinked: 2, ledgersKept: 1 });
    const states = readPageNoteStates(db, ['page-1', 'page-2']);
    expect(states.get('page-1')?.notes).toEqual({ a: 'linked-a', b: 'h-b-older', z: 'h-z' });
    expect(states.get('page-2')?.notes).toEqual({ z: 'h-z' });
  });

  it('keeps no record without the hash after the write, nor on a dry run', async () => {
    upsertLedger(db, 'a', 'h-a', '2026-11-16T10:00:00Z');
    const noHash = fakeEngine([note('a', 'Lunch with Sam Rivera.', 120, { hash: 'h-a' })], kinds, { noNewHash: true });
    await run({ engine: noHash.engine, config: applyConfig(), queue: new CurationQueue(), db, recorder }, { dryRun: true });
    expect(ledgerHash(db, 'a')).toBe('h-a');
    const r = await run({ engine: noHash.engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ notesLinked: 1, ledgersKept: 0 });
    expect(ledgerHash(db, 'a')).toBe('h-a');
  });

  it('writes nothing in report mode', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Met Sam Rivera from Acme.')], kinds);
    const r = await run({ engine, config: config(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ links: 2, linksAdded: 0 });
    expect(calls.writes).toEqual([]);
    expect(calls.titled).toEqual([]);
  });

  it('only lists a name more than one note has as its title, whatever the letter case', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Lunch with Sam Rivera.')], kinds, { titleCounts: { 'Sam Rivera': 2 } });
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ linksAdded: 0, links: 1 });
    expect(calls.titled).toEqual(['Sam Rivera']);
    expect(calls.writes).toEqual([]);
  });

  it('leaves a note edited between the read and the write for the next run, and journals nothing for it', async () => {
    const stale = new EngineError('STALE_NODE', 'version moved');
    const { engine, calls } = fakeEngine([note('a', 'Lunch with Sam Rivera.'), note('b', 'Call with Acme.')], kinds, { writeError: { a: stale } });
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ read: 1, linksAdded: 1, notesLinked: 1, leftForLater: 1, errors: 0 });
    expect(calls.writes.map(w => w.nodeId)).toEqual(['b']);
    expect(events().filter(e => e.kind === 'action').map(e => e.target)).toEqual(['Note b']);
    expect(pendingLinkSweepNotes(db)).toEqual(['a']);
    expect(linkSweepNoteStatuses(db, ['b']).get('b')).toBe('applied');
  });

  it('counts any other refused write as an error and reads the note again later', async () => {
    const { engine } = fakeEngine([note('a', 'Lunch with Sam Rivera.')], kinds, { writeError: { a: new EngineError('VALIDATION_FAILED', 'no') } });
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r).toMatchObject({ read: 0, linksAdded: 0, errors: 1 });
    expect(pendingLinkSweepNotes(db)).toEqual(['a']);
    expect(events().filter(e => e.kind === 'action')).toEqual([]);
  });

  it('reads again the notes report-only runs read, after the new ones, and only as far as the cap', async () => {
    const fake = fakeEngine([note('a', 'Lunch with Sam Rivera.'), note('b', 'Call with Acme.'), note('c', 'Nothing.')], kinds);
    const deps = { engine: fake.engine, config: config(), queue: new CurationQueue(), db, recorder };
    await run(deps);                                                    // the trial: all three reported
    expect(countReportedLinkSweepNotes(db)).toBe(3);

    const t = (minutes: number) => ({ now: () => new Date(NOW.getTime() + minutes * MIN) });
    const fresh = fakeEngine([note('a', 'Lunch with Sam Rivera.'), note('b', 'Call with Acme.'), note('c', 'Nothing.'),
      { ...note('d', 'Met Acme.'), ref: { ...note('d', '').ref, created_at: NOW.getTime() + 30 * MIN } }], kinds);
    const first = await run({ ...deps, engine: fresh.engine, config: applyConfig({ linkSweepNoteCap: 2 }) }, t(60));
    expect(fresh.calls.read).toEqual(['d', 'a']);                       // the new note first, then the oldest reported
    expect(first).toMatchObject({ read: 2, reread: 1, rereadLeft: 2, linksAdded: 2, leftForLater: 0 });
    expect(lineOf(events().at(-1)!)).toBe('read 2 notes (1 read again from report-only runs); added 2 links in 2 notes; 2 notes from report-only runs still to read. Undo one note with the undo-operations id on its line, or this whole run in one call: undo-operations with operation_ids ["op-d","op-a"]. The Engine keeps undo for 24 hours.');

    const second = await run({ ...deps, engine: fresh.engine, config: applyConfig({ linkSweepNoteCap: 2 }) }, t(120));
    expect(second).toMatchObject({ read: 2, reread: 2, rereadLeft: 0, linksAdded: 1 });
    expect(fresh.calls.writes.map(w => w.nodeId)).toEqual(['d', 'a', 'b']);
    expect([...linkSweepNoteStatuses(db, ['a', 'b', 'c', 'd']).values()]).toEqual(['applied', 'applied', 'applied', 'applied']);
    const third = await run({ ...deps, engine: fresh.engine, config: applyConfig() }, t(180));
    expect(third).toMatchObject({ read: 0, reread: 0 });
  });

  it('moves a reported note edited too recently to the pending queue, and forgets one deleted since', async () => {
    const fake = fakeEngine([note('a', 'Lunch with Sam Rivera.'), note('b', 'Call with Acme.')], kinds);
    await run({ engine: fake.engine, config: config(), queue: new CurationQueue(), db, recorder });
    const later = fakeEngine([note('a', 'Lunch with Sam Rivera, edited.', -50)], kinds); // b deleted; a edited 10 min before the run
    const r = await run({ engine: later.engine, config: applyConfig(), queue: new CurationQueue(), db, recorder }, { now: () => new Date(NOW.getTime() + 60 * MIN) });
    expect(r).toMatchObject({ read: 0, leftForLater: 1, rereadLeft: 0 });
    expect([...linkSweepNoteStatuses(db, ['a', 'b']).entries()]).toEqual([['a', 'pending']]);
  });

  it('moves a reread that fails out of the way, so the rest of the reported backlog is read (Codex, #689)', async () => {
    const fake = fakeEngine([note('a', 'Lunch with Sam Rivera.'), note('b', 'Call with Acme.')], kinds);
    await run({ engine: fake.engine, config: config(), queue: new CurationQueue(), db, recorder });
    const t = (minutes: number) => ({ now: () => new Date(NOW.getTime() + minutes * MIN) });
    const failing = fakeEngine([note('a', 'Lunch with Sam Rivera.', 120, { failRead: true }), note('b', 'Call with Acme.')], kinds);
    const deps = { engine: failing.engine, config: applyConfig({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder };
    const first = await run(deps, t(60));
    expect(first).toMatchObject({ read: 0, errors: 1 });
    expect(pendingLinkSweepNotes(db)).toEqual(['a']);
    const second = await run(deps, t(120));                 // a waits behind, failed; b, the next reread, takes the cap
    expect(failing.calls.read).toEqual(['a', 'b']);
    expect(second).toMatchObject({ read: 1, reread: 1, errors: 0, linksAdded: 1 });
    expect([...linkSweepNoteStatuses(db, ['a', 'b']).entries()]).toEqual([['a', 'pending'], ['b', 'applied']]);
    await run(deps, t(180));                                 // with room again, a is tried again
    expect(failing.calls.read).toEqual(['a', 'b', 'a']);
  });

  it('lists only the undo ids of notes it linked, so a refused write leaves none behind', async () => {
    const stale = new EngineError('STALE_NODE', 'version moved');
    const { engine } = fakeEngine([note('a', 'Lunch with Sam Rivera.'), note('b', 'Call with Acme.'), note('c', 'Acme Corp, again.')], kinds,
      { writeError: { b: stale } });
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(r.operationIds).toEqual(['op-a', 'op-c']);
    expect(lineOf(events().at(-1)!)).toContain('undo-operations with operation_ids ["op-a","op-c"]');
  });

  it('writes nothing and keeps no bookkeeping on a dry run, journaling what it would link', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Lunch with Sam Rivera.')], kinds);
    const r = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder }, { dryRun: true });
    expect(r).toMatchObject({ linksAdded: 1, notesLinked: 1, operationIds: [] });
    expect(lineOf(events().at(-1)!)).toMatch(/would add 1 link in 1 note\.$/);
    expect(calls.writes).toEqual([]);
    expect(events()[0]).toMatchObject({ action: 'links-added', dry_run: 1 });
    expect(events()[0]!.detail).toMatch(/^would link one mention in "Note a": Sam Rivera: /);
    expect(linkSweepNoteStatuses(db, ['a']).size).toBe(0);
  });

  it('writes its own journal entry on the timer when it added links', async () => {
    const llm = { structuredCall: vi.fn() };
    const { engine } = fakeEngine([note('a', 'Lunch with Sam Rivera.')], kinds);
    const r = await runLinkSweepOnTimer({ engine, llm, config: applyConfig({ linkSweepSchedule: 'timer' }), queue: new CurationQueue(), db, recorder }, () => {}, () => NOW);
    expect(r).toMatchObject({ linksAdded: 1, links: 0 });
    expect(writeJournalEntry).toHaveBeenCalledTimes(1);
  });
});

describe('apply mode rules (#332)', () => {
  const mention = (text: string, title: string, start = 0) => ({ targetId: 't', title, text, start, end: start + text.length, context: text });
  const kinds = { person: 'person', company: 'company' };

  it('takes a person by any full-name mention and a company only by a name as written', () => {
    expect(applicableMention(mention('sam rivera', 'Sam Rivera'), { title: 'Sam Rivera', aliases: [], type: 'person' }, kinds)).toBe(true);
    const acme = { title: 'Acme Holdings', aliases: ['Acme', 'acme hq'], type: 'company' };
    expect(applicableMention(mention('Acme Holdings', 'Acme Holdings'), acme, kinds)).toBe(true);
    expect(applicableMention(mention('Acme  Holdings', 'Acme Holdings'), acme, kinds)).toBe(true);  // spacing aside
    expect(applicableMention(mention('acme holdings', 'Acme Holdings'), acme, kinds)).toBe(false);
    expect(applicableMention(mention('acme hq', 'Acme Holdings'), acme, kinds)).toBe(true);         // an alias as written
    expect(applicableMention(mention('Orion Launch', 'Orion Launch'), { title: 'Orion Launch', aliases: [], type: 'project' }, kinds)).toBe(false);
    expect(applicableMention(mention('Sam Rivera', 'Sam Rivera'), { title: 'Sam Rivera', aliases: [], type: 'person' }, { person: null, company: null })).toBe(false);
  });

  it('never writes a link to a title that ends like a file name (Codex, #689)', () => {
    expect(linkable('Acme.md', 'Acme.md')).toBe(false);
    expect(linkable('Northwind.ai', 'Northwind.ai')).toBe(false);
    expect(linkable('J.W. Rivera', 'J.W. Rivera')).toBe(true);
    expect(linkable('Acme 2.0', 'Acme 2.0')).toBe(true);
  });

  it('only writes a mention that can become a link in place (Codex, #689)', () => {
    const at = (body: string, text: string) => ({ start: body.indexOf(text), end: body.indexOf(text) + text.length });
    expect(standsAlone('Met Acme today.', at('Met Acme today.', 'Acme'))).toBe(true);
    expect(standsAlone('Acme', at('Acme', 'Acme'))).toBe(true);
    expect(standsAlone('Brackets [Acme] here.', at('Brackets [Acme] here.', 'Acme'))).toBe(false);
    expect(standsAlone('Wow!Acme', at('Wow!Acme', 'Acme'))).toBe(false);
    expect(standsAlone('Not \\Acme', at('Not \\Acme', 'Acme'))).toBe(false);
    expect(standsAlone('See Acme] there', at('See Acme] there', 'Acme'))).toBe(false);
  });

  it('never writes a link around a line break or link syntax', () => {
    expect(linkable('Sam Rivera', 'Sam Rivera')).toBe(true);
    expect(linkable('Sam Rivera', 'Sam\nRivera')).toBe(false);
    expect(linkable('Acme | Co', 'Acme')).toBe(false);
    expect(linkable('Acme #1', 'Acme')).toBe(false);
    expect(linkable('Acme', 'Acme]')).toBe(false);
  });

  it('splices every link in place, last first, keeping the text as written', () => {
    const body = 'Sam Rivera met ACME HQ.';
    expect(withLinks(body, [mention('Sam Rivera', 'Sam Rivera', 0), mention('ACME HQ', 'Acme', 15)]))
      .toBe('[[Sam Rivera]] met [[Acme|ACME HQ]].');
  });
});

describe('the backlog: older notes, fewest links first (#697)', () => {
  const DAY = 24 * 60 * MIN;
  const applyConfig = (over: Partial<Config> = {}) => config({ linkSweepMode: 'apply', ...over });
  const lineOf = (e: { detail: string }) => JSON.parse(e.detail).line as string;
  /** A note made `daysAgo` days ago, before the sweep's first look-back, with these link counts. */
  const older = (id: string, daysAgo: number, inlinks: number, outlinks: number, body = `Lunch with Sam Rivera, note ${id}.`, minutesAgo = 600) =>
    ({ ...note(id, body, minutesAgo), inlinks, outlinks, ref: { ...note(id, body, minutesAgo).ref, created_at: NOW.getTime() - daysAgo * DAY } });
  const fresh = (id: string) => ({ ...note(id, 'Met Sam Rivera.'), ref: { ...note(id, 'Met Sam Rivera.').ref, created_at: NOW.getTime() - 60 * MIN } });

  it('reads new notes first, then the notes it never read with the fewest links, newest first among equals', async () => {
    const { engine, calls } = fakeEngine([
      fresh('new'),
      older('busy', 30, 3, 2),
      older('zero-old', 400, 0, 0),
      older('zero-recent', 10, 0, 0),
      older('one', 5, 1, 0),
    ]);
    const r = await run({ engine, config: config({ linkSweepBacklog: 'fewest-links', linkSweepNoteCap: 4 }), queue: new CurationQueue(), db, recorder });

    expect(calls.read).toEqual(['new', 'zero-recent', 'zero-old', 'one']);
    expect(r).toMatchObject({ read: 4, backlogRead: 3, backlogLeft: 1, leftForLater: 0 });
    expect(calls.backlog[0]).toMatchObject({ withoutTypes: ['wiki'], withoutPathPrefix: 'Settings/' });
    expect(lineOf(events().at(-1)!)).toBe('read 4 notes (3 older, fewest links first); 4 links to propose in 4 notes; 1 older note still to read. Report only: no note was changed.');
    expect(JSON.parse(events().at(-1)!.detail).stats).toMatchObject({ backlogRead: 3, backlogLeft: 1 });

    // The next run goes on where this one stopped: only the busy note is left.
    calls.read.length = 0;
    const next = await run({ engine, config: config({ linkSweepBacklog: 'fewest-links', linkSweepNoteCap: 4 }), queue: new CurationQueue(), db, recorder });
    expect(calls.read).toEqual(['busy']);
    expect(next).toMatchObject({ backlogRead: 1, backlogLeft: 0 });
  });

  it('never reads a note twice, and queues none it leaves for the cap or the quiet window', async () => {
    markLinkSweepNote(db, 'zero-recent', 'applied', 0, NOW.toISOString());
    const { engine, calls } = fakeEngine([
      older('zero-recent', 10, 0, 0),
      older('typing', 20, 0, 0, 'Still writing about Sam Rivera.', 5),   // saved 5 minutes ago
      older('zero-old', 400, 0, 0),
      older('one', 5, 1, 0),
    ]);
    const r = await run({ engine, config: config({ linkSweepBacklog: 'fewest-links', linkSweepNoteCap: 2 }), queue: new CurationQueue(), db, recorder });

    // The note still being edited is passed over for the next one, not given the room (Codex, #701).
    expect(calls.read).toEqual(['zero-old', 'one']);
    expect(r).toMatchObject({ backlogRead: 2, leftForLater: 0 });
    expect(pendingLinkSweepNotes(db)).toEqual([]);
    expect(linkSweepNoteStatuses(db, ['typing']).size).toBe(0);
  });

  it('marks backlog notes like new ones: applied in apply mode, with their links written', async () => {
    const { engine, calls } = fakeEngine([older('zero', 50, 0, 0, 'Lunch with Sam Rivera.')]);
    const r = await run({ engine, config: applyConfig({ linkSweepBacklog: 'fewest-links' }), queue: new CurationQueue(), db, recorder });

    expect(r).toMatchObject({ backlogRead: 1, linksAdded: 1 });
    expect(calls.writes.map(w => w.body)).toEqual(['Lunch with [[Sam Rivera]].']);
    expect([...linkSweepNoteStatuses(db, ['zero']).values()]).toEqual(['applied']);
  });

  it('lists no backlog when off', async () => {
    const off = fakeEngine([fresh('new'), older('zero', 50, 0, 0)]);
    await run({ engine: off.engine, config: config({ linkSweepBacklog: 'off' }), queue: new CurationQueue(), db, recorder });
    expect(off.calls.backlog).toEqual([]);
    expect(off.calls.read).toEqual(['new']);
  });

  it('lists no backlog when the new notes fill the cap', async () => {
    const full = fakeEngine([fresh('n1'), fresh('n2'), older('zero', 50, 0, 0)]);
    await run({ engine: full.engine, config: config({ linkSweepBacklog: 'fewest-links', linkSweepNoteCap: 2 }), queue: new CurationQueue(), db, recorder });
    expect(full.calls.backlog).toEqual([]);
  });
});

describe('names that got a note after notes naming them were read (#699)', () => {
  const applyConfig = (over: Partial<Config> = {}) => config({ linkSweepMode: 'apply', ...over });
  const lineOf = (e: { detail: string }) => JSON.parse(e.detail).line as string;
  const typed = (): Array<{ id: string; title: string; aliases: string[]; type: string }> => [
    { id: 'acme', title: 'Acme', aliases: ['Acme Corp'], type: 'company' },
    { id: 'sam', title: 'Sam Rivera', aliases: [], type: 'person' },
  ];
  /** A note made long before the sweep's look-back, so no run lists it as new. */
  const old = (id: string, body: string) => ({ ...note(id, body), ref: { ...note(id, body).ref, created_at: NOW.getTime() - 400 * 24 * 60 * MIN } });

  it('records the names on its first run, then reads again a note that names a person who got a note', async () => {
    const targets = typed();
    const { engine, calls } = fakeEngine([note('a', 'Lunch with Dana Whitfield.')], targets);
    const first = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(first).toMatchObject({ read: 1, linksAdded: 0, newNames: 0 });
    expect(calls.naming).toEqual([]);
    expect([...knownLinkSweepNames(db)].sort()).toEqual(['acme', 'acme corp', 'sam rivera']);

    targets.push({ id: 'dana', title: 'Dana Whitfield', aliases: [], type: 'person' });
    const second = await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });

    expect(calls.naming).toEqual(['Dana Whitfield']);
    expect(second).toMatchObject({ newNames: 1, rechecked: 1, recheckLeft: 0, linksAdded: 1 });
    expect(calls.writes.map(w => w.body)).toEqual(['Lunch with [[Dana Whitfield]].']);
    expect(countLinkSweepRechecks(db)).toBe(0);
    expect(lineOf(events().at(-1)!)).toMatch(/^read 1 note \(1 read again for a name that got a note\); added 1 link in 1 note; looked for 1 name that got a note\. Undo/);
    // Seen once, looked for once.
    calls.naming.length = 0;
    await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(calls.naming).toEqual([]);
  });

  it('looks for no one-word person, project, shared or too common name, and queues only notes read before', async () => {
    const targets = typed();
    const { engine, calls } = fakeEngine([
      note('b', 'Call with Initech about Globex.'),
      old('c', 'Initech came up here too, never read.'),
    ], targets, { notesTotal: 1000, mentionCounts: { Globex: 500 } });
    await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });

    targets.push(
      { id: 'cher', title: 'Cher', aliases: [], type: 'person' },                 // a first name alone never matches
      { id: 'apollo', title: 'Apollo Launch', aliases: [], type: 'project' },     // never linked in apply mode
      { id: 'pat1', title: 'Pat Kim', aliases: [], type: 'person' },             // two notes answer to it
      { id: 'pat2', title: 'Pat Kim', aliases: [], type: 'person' },
      { id: 'globex', title: 'Globex', aliases: [], type: 'company' },           // in half the notes
      { id: 'initech', title: 'Initech', aliases: [], type: 'company' },
    );
    const r = await run({ engine, config: applyConfig({ linkSweepNoteCap: 10 }), queue: new CurationQueue(), db, recorder });

    expect(calls.naming).toEqual(['Initech']);
    expect(r).toMatchObject({ newNames: 2, rechecked: 1 });
    expect(calls.writes.map(w => w.nodeId)).toEqual(['b']);
    const known = knownLinkSweepNames(db);
    expect(['globex', 'initech'].every(k => known.has(k))).toBe(true);
    expect(['cher', 'apollo launch', 'pat kim'].some(k => known.has(k))).toBe(false);
    expect(linkSweepNoteStatuses(db, ['c']).size).toBe(0);
  });

  it('keeps a queued note queued past the cap, and spreads many new names over runs', async () => {
    const targets = typed();
    const notes = [note('a', 'Met Dana Whitfield.'), note('b', 'Dana Whitfield again.'), note('c', 'And Dana Whitfield.')];
    const { engine } = fakeEngine(notes, targets);
    await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });

    targets.push({ id: 'dana', title: 'Dana Whitfield', aliases: [], type: 'person' });
    for (let i = 0; i < NEW_NAMES_PER_RUN; i++) targets.push({ id: `co${i}`, title: `Company ${String(i).padStart(3, '0')}`, aliases: [], type: 'company' });
    const second = await run({ engine, config: applyConfig({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder });

    // 51 new names, 50 looked for: in name order, "Company …" first, so Dana waits a run.
    expect(second).toMatchObject({ newNames: NEW_NAMES_PER_RUN, newNamesLeft: 1, rechecked: 0 });
    const third = await run({ engine, config: applyConfig({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder });
    expect(third).toMatchObject({ newNames: 1, newNamesLeft: 0, rechecked: 1, recheckLeft: 2 });
    expect(pendingLinkSweepNotes(db)).toEqual([]);
  });

  it('sends a queued note still being edited to the pending queue, so the quiet ones behind it are read (Codex, #701)', async () => {
    const targets = typed();
    const notes = [note('a', 'Met Dana Whitfield.'), note('b', 'Dana Whitfield again.')];
    const { engine, calls } = fakeEngine(notes, targets);
    await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });

    targets.push({ id: 'dana', title: 'Dana Whitfield', aliases: [], type: 'person' });
    notes[0]!.ref.file_mtime = NOW.getTime() - 5 * MIN;   // a is open in the editor again
    calls.read.length = 0;
    const r = await run({ engine, config: applyConfig({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder });
    // a leaves the queue for the pending queue rather than keeping the front of it.
    expect(calls.read).toEqual([]);
    expect(r).toMatchObject({ rechecked: 0, recheckLeft: 1 });
    expect(pendingLinkSweepNotes(db)).toEqual(['a']);

    // So the next run reaches b, although a is still being edited.
    const next = await run({ engine, config: applyConfig({ linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder });
    expect(calls.read).toEqual(['b']);
    expect(next).toMatchObject({ rechecked: 1, recheckLeft: 0 });
    expect(countLinkSweepRechecks(db)).toBe(0);
  });

  it('reads a note whose read failed before the backlog, which may take months (Codex, #701)', async () => {
    const failing = { ...note('f', 'Met Sam Rivera.'), failRead: true };
    const notes: FakeNote[] = [failing];
    const { engine, calls } = fakeEngine(notes, typed());
    await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder });
    expect(pendingLinkSweepNotes(db)).toEqual(['f']);

    failing.failRead = false;
    notes.push(old('zero', 'Lunch with Sam Rivera.'));
    calls.read.length = 0;
    await run({ engine, config: applyConfig({ linkSweepBacklog: 'fewest-links', linkSweepNoteCap: 1 }), queue: new CurationQueue(), db, recorder });
    expect(calls.read).toEqual(['f']);
  });

  it('records and queues nothing on a dry run', async () => {
    const { engine, calls } = fakeEngine([note('a', 'Lunch with Dana Whitfield.')], typed());
    await run({ engine, config: applyConfig(), queue: new CurationQueue(), db, recorder }, { dryRun: true });
    expect(knownLinkSweepNames(db).size).toBe(0);
    expect(calls.naming).toEqual([]);
  });
});
