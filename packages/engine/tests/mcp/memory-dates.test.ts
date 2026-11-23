import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { registerMemoriesTools } from '../../src/mcp/tools/memories.js';
import { MemoryService, insertMemoryRow, insertMemoryVector, markConsolidationPending } from '../../src/memories/service.js';
import { ConsolidationReplay } from '../../src/memories/consolidation-replay.js';
import { memoriesBearingOn } from '../../src/memories/bearing.js';
import { parseMemoryNote, renderMemoryNote, validateParsedMemoryNote } from '../../src/memories/note-format.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { ConsolidationInput, ConsolidationVerdict, MemoryConsolidator } from '../../src/mcp/tools/memory-consolidation.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = await tool.handler(parsed, {});
  return JSON.parse(result.content[0].text);
}

/** A unit vector at angle θ: distance(a, b) = 1 − cos(θa − θb). */
function vec(theta: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}
/** Angle for a cosine distance from θ = 0. */
const at = (distance: number) => Math.acos(1 - distance);

function embedder(map: Record<string, Float32Array>): Embedder {
  return {
    isReady: () => true,
    async embedQuery(text: string) { return map[text] ?? vec(Math.PI / 2); },
    async embedDocument(text: string) { return [map[text] ?? vec(Math.PI / 2)]; },
  };
}

const OLD_DAY = '2021-03-04T00:00:00.000Z';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** Notes dated by their titles (`evidenceNoteDate`'s rule): one in 2021, one with no date, one dated far ahead. */
function setup(opts: { embeddings?: Record<string, Float32Array>; verdict?: (input: ConsolidationInput) => ConsolidationVerdict } = {}) {
  db = createTestDb();
  const consolidator: MemoryConsolidator | undefined = opts.verdict
    ? { async consolidate(input) { return opts.verdict!(input); } }
    : undefined;
  const service = new MemoryService(db, {
    ...(opts.embeddings ? { embedder: embedder(opts.embeddings) } : {}),
    ...(consolidator ? { consolidator } : {}),
  });
  const server = new McpServer({ name: 'test', version: '0' });
  registerMemoriesTools(server, service);
  const note = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)');
  note.run('old', 'Meetings/Kickoff 2021-03-04.md', 'Kickoff 2021-03-04', '', 'h-old');
  note.run('plain', 'Notes/Ideas.md', 'Ideas', '', 'h-plain');
  note.run('ahead', 'Notes/Plan 2999-01-01.md', 'Plan 2999-01-01', '', 'h-ahead');
  const fromNote = (content: string, nodeId: string) =>
    callTool(server, 'create-memory', { evidence: { kind: 'note', node_id: nodeId, hash: `h-${nodeId}` }, source: 'curator', content });
  const fromChat = (content: string) =>
    callTool(server, 'create-memory', { evidence: { kind: 'conversation', ref: 'c#1' }, source: 'curator', content });
  const row = (id: number) => db!.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, string | null>;
  return { server, service, fromNote, fromChat, row };
}

describe('a memory drawn from a note is dated by it (#706)', () => {
  it("takes a dated note's day; one from an undated note or a chat keeps its write time", async () => {
    const t = setup();
    const old = await t.fromNote('Fact from the 2021 kickoff', 'old');
    expect(old.data.valid_at).toBe(OLD_DAY);
    expect(t.row(old.data.id).valid_at).toBe(OLD_DAY);
    expect(t.row(old.data.id).created_at! > OLD_DAY).toBe(true);
    const plain = await t.fromNote('Fact from an undated note', 'plain');
    expect(t.row(plain.data.id).valid_at).toBe(t.row(plain.data.id).created_at);
    const chat = await t.fromChat('Fact from a chat');
    expect(t.row(chat.data.id).valid_at).toBe(t.row(chat.data.id).created_at);
  });

  it('dates a memory from a note dated ahead by today, not by the note', async () => {
    const t = setup();
    const ahead = await t.fromNote('Fact from next month\'s plan', 'ahead');
    expect(t.row(ahead.data.id).valid_at).toBe(t.row(ahead.data.id).created_at);
  });

  it("dates a memory from a note dated ahead by today, whatever the verdict's date", async () => {
    const t = setup({
      embeddings: { base: vec(0), similar: vec(at(0.2)) },
      verdict: () => ({ operation: 'add', reason: 'distinct', valid_at: '2999-01-01T00:00:00.000Z' }),
    });
    await t.fromChat('base');
    const res = await t.fromNote('similar', 'ahead');
    expect(t.row(res.data.id).valid_at).toBe(t.row(res.data.id).created_at);
  });

  it.each([
    ['keeps a verdict date before the note day', '2020-06-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z'],
    ['keeps a verdict date on the note day', '2021-03-04T15:00:00.000Z', '2021-03-04T15:00:00.000Z'],
    ['brings a verdict date after the note day back to it', '2026-12-01T00:00:00.000Z', OLD_DAY],
  ])('%s', async (_name, verdictDate, expected) => {
    const t = setup({
      embeddings: { base: vec(0), similar: vec(at(0.2)) },
      verdict: () => ({ operation: 'add', reason: 'distinct', valid_at: verdictDate }),
    });
    await t.fromChat('base');
    const res = await t.fromNote('similar', 'old');
    expect(res.data.valid_at).toBe(expected);
    expect(t.row(res.data.id).valid_at).toBe(expected);
  });

  it('dates the new version an update verdict mints by its note', async () => {
    const t = setup({
      embeddings: { base: vec(0), similar: vec(at(0.2)) },
      verdict: (input) => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'refines' }),
    });
    const base = await t.fromChat('base');
    // Said before the note, so the older-note guard lets the note replace it.
    db!.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00.000Z', valid_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(base.data.id);
    const res = await t.fromNote('similar', 'old');
    expect(res.data.operation).toBe('update');
    expect(t.row(res.data.id).valid_at).toBe(OLD_DAY);
    expect(t.row(base.data.id).superseded_by).toBe(res.data.id);
  });

  it("dates a contradiction's winner and the loser's end by the note", async () => {
    const t = setup({
      embeddings: { base: vec(0), similar: vec(at(0.2)) },
      verdict: (input) => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'moved' }),
    });
    const base = await t.fromChat('base');
    db!.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00.000Z', valid_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(base.data.id);
    const res = await t.fromNote('similar', 'old');
    expect(res.data.operation).toBe('contradict');
    expect(t.row(res.data.id).valid_at).toBe(OLD_DAY);
    expect(t.row(base.data.id).invalid_at).toBe(OLD_DAY);
  });

  it('a chat memory keeps the verdict date, as before', async () => {
    const t = setup({
      embeddings: { base: vec(0), similar: vec(at(0.2)) },
      verdict: () => ({ operation: 'add', reason: 'distinct', valid_at: '2026-12-01T00:00:00.000Z' }),
    });
    await t.fromChat('base');
    const res = await t.fromChat('similar');
    expect(t.row(res.data.id).valid_at).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('newest first reads when each memory became true (#706)', () => {
  it('lists a fact from an old note read today after newer facts', async () => {
    const t = setup();
    db!.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('review', 'Meetings/Review 2024-05-01.md', 'Review 2024-05-01', '', 'h-review')").run();
    await t.fromNote('From the 2021 kickoff', 'old');
    await t.fromChat('From a chat');
    await t.fromNote('From the 2024 review', 'review');
    const listed = await callTool(t.server, 'list-memories', {});
    expect(listed.data.memories.map((m: { content: string }) => m.content))
      .toEqual(['From a chat', 'From the 2024 review', 'From the 2021 kickoff']);
  });

  it("orders a note's bearing memories by when each became true", async () => {
    const t = setup();
    // About the note, from a chat; then a fact drawn from the note, written later but dated 2021.
    await callTool(t.server, 'create-memory', {
      evidence: { kind: 'conversation', ref: 'c#2' }, source: 'chat', scope: 'node', node_id: 'old', content: 'Said in a chat about the kickoff',
    });
    await t.fromNote('Drawn from the kickoff', 'old');
    const bearing = memoriesBearingOn(t.service, 'old');
    expect(bearing.memories.map(m => [m.content, m.valid_at?.slice(0, 4)])).toEqual([
      ['Said in a chat about the kickoff', String(new Date().getUTCFullYear())],
      ['Drawn from the kickoff', '2021'],
    ]);
  });
});

describe('backfill-memory-dates (#706)', () => {
  const WRITTEN = '2026-11-01T10:00:00.000Z';

  function insert(content: string, extra: { note?: string; valid_at?: string } = {}): number {
    return insertMemoryRow(db!, {
      source: 'curator', scope: 'vault', node_id: null, content, category: null, metadata_json: null,
      created_at: WRITTEN, updated_at: WRITTEN, valid_at: extra.valid_at ?? WRITTEN,
      ...(extra.note
        ? { evidence_kind: 'note', evidence_node_id: extra.note, evidence_hash: 'h', evidence_ref: null }
        : { evidence_kind: 'conversation', evidence_node_id: null, evidence_hash: null, evidence_ref: 'c#1' }),
    });
  }

  function staged() {
    const t = setup();
    const ids = {
      defaulted: insert('Dated by its write', { note: 'old' }),
      earlierVerdict: insert('Dated earlier by a verdict', { note: 'old', valid_at: '2020-01-01T00:00:00.000Z' }),
      laterVerdict: insert('Dated after its note by a verdict', { note: 'old', valid_at: '2026-06-01T00:00:00.000Z' }),
      undated: insert('From an undated note', { note: 'plain' }),
      ahead: insert('From a note dated ahead', { note: 'ahead' }),
      aheadVerdict: insert('Dated ahead by a verdict', { note: 'ahead', valid_at: '2999-01-01T00:00:00.000Z' }),
      chat: insert('From a chat'),
      retired: insert('Retired', { note: 'old' }),
    };
    db!.prepare('UPDATE memories SET expired_at = ? WHERE id = ?').run(WRITTEN, ids.retired);
    const backfill = (args: Record<string, unknown>) => callTool(t.server, 'backfill-memory-dates', args);
    return { ...t, ids, backfill };
  }

  it("previews by default: the live note memories, those whose note has no date, and each change", async () => {
    const t = staged();
    const res = await t.backfill({});
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ dry_run: true, note_memories: 6, undated_notes: 1, redated: 3, capped: 2 });
    expect(res.data.samples).toEqual([
      { memory_id: t.ids.defaulted, content: 'Dated by its write', note_title: 'Kickoff 2021-03-04', note_date: '2021-03-04', valid_at_before: WRITTEN, valid_at_after: OLD_DAY },
      { memory_id: t.ids.laterVerdict, content: 'Dated after its note by a verdict', note_title: 'Kickoff 2021-03-04', note_date: '2021-03-04', valid_at_before: '2026-06-01T00:00:00.000Z', valid_at_after: OLD_DAY },
      { memory_id: t.ids.aheadVerdict, content: 'Dated ahead by a verdict', note_title: 'Plan 2999-01-01', note_date: '2999-01-01', valid_at_before: '2999-01-01T00:00:00.000Z', valid_at_after: WRITTEN },
    ]);
    expect(t.row(t.ids.defaulted).valid_at).toBe(WRITTEN);
  });

  it('writes the dates, keeps each old one in history and moves updated_at', async () => {
    const t = staged();
    const res = await t.backfill({ dry_run: false });
    expect(res.data).toMatchObject({ dry_run: false, redated: 3 });
    expect(t.row(t.ids.defaulted).valid_at).toBe(OLD_DAY);
    expect(t.row(t.ids.laterVerdict).valid_at).toBe(OLD_DAY);
    expect(t.row(t.ids.earlierVerdict).valid_at).toBe('2020-01-01T00:00:00.000Z');
    expect(t.row(t.ids.undated).valid_at).toBe(WRITTEN);
    expect(t.row(t.ids.ahead).valid_at).toBe(WRITTEN);
    expect(t.row(t.ids.aheadVerdict).valid_at).toBe(WRITTEN);
    expect(t.row(t.ids.chat).valid_at).toBe(WRITTEN);
    expect(t.row(t.ids.retired).valid_at).toBe(WRITTEN);
    expect(t.row(t.ids.defaulted).updated_at! > WRITTEN).toBe(true);
    expect(t.row(t.ids.chat).updated_at).toBe(WRITTEN);
    const history = t.service.get({ id: t.ids.defaulted, include_history: true });
    expect(history.ok && history.data.history).toEqual([expect.objectContaining({
      change: 'edited', reason: 'dated-by-note', previous: { valid_at: WRITTEN },
    })]);
    // A second run finds nothing more to date.
    expect((await t.backfill({})).data).toMatchObject({ redated: 0, capped: 0 });
  });

  it('undo puts back the old dates on memories nothing changed since, once', async () => {
    const t = staged();
    await t.backfill({ dry_run: false });
    // A later edit of one of them: undo leaves it alone.
    await callTool(t.server, 'update-memory', { id: t.ids.laterVerdict, category: 'fact' });
    const preview = await t.backfill({ undo: true });
    expect(preview.data).toEqual({ dry_run: true, restored: 2, changed_since: 1, already_undone: 0 });
    expect(t.row(t.ids.defaulted).valid_at).toBe(OLD_DAY);
    const undone = await t.backfill({ undo: true, dry_run: false });
    expect(undone.data).toEqual({ dry_run: false, restored: 2, changed_since: 1, already_undone: 0 });
    expect(t.row(t.ids.defaulted).valid_at).toBe(WRITTEN);
    expect(t.row(t.ids.laterVerdict).valid_at).toBe(OLD_DAY);
    expect((await t.backfill({ undo: true, dry_run: false })).data).toEqual({ dry_run: false, restored: 0, changed_since: 1, already_undone: 2 });
    // And the backfill dates it again.
    expect((await t.backfill({})).data).toMatchObject({ redated: 2 });
  });

  it('leaves the memory note editable: a block rendered before reads as stale, not as an edit', async () => {
    const t = staged();
    const before = renderMemoryNote(t.service.snapshotAll(), []);
    await t.backfill({ dry_run: false });
    const parsed = parseMemoryNote(before.bytes);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, t.service.snapshotAll());
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.ops.every(op => op.kind === 'noop')).toBe(true);
    // Without the moved updated_at, the same note would read as an edit of a read-only field.
    db!.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(WRITTEN, t.ids.defaulted);
    expect(validateParsedMemoryNote(parsed, t.service.snapshotAll()).ok).toBe(false);
  });
});

describe('consolidation replay caps a verdict date at the note day (#706)', () => {
  it("brings a contradiction's date after the note day back to it, for both memories", async () => {
    const t = setup({
      embeddings: {},
      verdict: (input) => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'moved', valid_at: '2026-12-01T00:00:00.000Z' }),
    });
    const now = '2026-01-01T00:00:00.000Z';
    const base = { source: 'curator', scope: 'vault', node_id: null, category: null, metadata_json: null, created_at: now, updated_at: now, valid_at: now };
    // Said in 2020, before the note, so the older-note guard lets the replay replace it.
    const said = '2020-01-01T00:00:00.000Z';
    const older = insertMemoryRow(db!, { ...base, created_at: said, updated_at: said, valid_at: said, content: 'older', evidence_kind: 'conversation', evidence_node_id: null, evidence_hash: null, evidence_ref: 'c#1' });
    insertMemoryVector(db!, older, vec(0));
    const replayed = insertMemoryRow(db!, { ...base, content: 'replayed', evidence_kind: 'note', evidence_node_id: 'old', evidence_hash: 'h', evidence_ref: null });
    insertMemoryVector(db!, replayed, vec(at(0.2)));
    markConsolidationPending(db!, replayed, 'test', now);
    const replay = ConsolidationReplay.for(t.service);
    await callTool(t.server, 'replay-memory-consolidation', { action: 'start', dry_run: false });
    await replay.settled();
    expect(t.row(replayed).valid_at).toBe(OLD_DAY);
    expect(t.row(older).invalid_at).toBe(OLD_DAY);
  });
});

describe('an older note does not replace what a chat said (#706 follow-up)', () => {
  const embeddings = { said: vec(0), noted: vec(at(0.2)) };
  /** A chat-drawn memory written at `writtenAt`, then a memory from the 2021 note the verdict aims at it. */
  async function chatThenNote(operation: 'update' | 'contradict', writtenAt?: string) {
    const t = setup({ embeddings, verdict: (input) => ({ operation, target_id: input.candidates[0]!.id, reason: 'conflict' }) });
    const said = await t.fromChat('said');
    if (writtenAt !== undefined) db!.prepare('UPDATE memories SET created_at = ?, valid_at = ? WHERE id = ?').run(writtenAt, writtenAt, said.data.id);
    const noted = await t.fromNote('noted', 'old');
    return { ...t, said: said.data.id as number, noted };
  }

  it.each(['update', 'contradict'] as const)('%s from a note older than the chat keeps both', async (operation) => {
    const t = await chatThenNote(operation);
    expect(t.noted.data.operation).toBe('add');
    expect(t.row(t.said).expired_at).toBeNull();
    expect(t.row(t.noted.data.id).expired_at).toBeNull();
  });

  it('a contradiction from a note of the same day as the chat keeps both; an update stands', async () => {
    const contradict = await chatThenNote('contradict', '2021-03-04T15:00:00.000Z');
    expect(contradict.noted.data.operation).toBe('add');
    expect(contradict.row(contradict.said).expired_at).toBeNull();
    db!.close(); db = undefined;
    const update = await chatThenNote('update', '2021-03-04T15:00:00.000Z');
    expect(update.noted.data.operation).toBe('update');
    expect(update.row(update.said).superseded_by).toBe(update.noted.data.id);
  });

  it('a note later than the chat still replaces it', async () => {
    const t = await chatThenNote('contradict', '2020-01-01T00:00:00.000Z');
    expect(t.noted.data.operation).toBe('contradict');
    expect(t.row(t.said).superseded_by).toBe(t.noted.data.id);
  });

  it("a chat still corrects an older note's memory", async () => {
    const t = setup({ embeddings: { noted: vec(0), said: vec(at(0.2)) }, verdict: (input) => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'corrected' }) });
    const noted = await t.fromNote('noted', 'old');
    const said = await t.fromChat('said');
    expect(said.data.operation).toBe('contradict');
    expect(t.row(noted.data.id).superseded_by).toBe(said.data.id);
  });

  it('replay keeps both when its memory is from a note older than the chat it would replace', async () => {
    const t = setup({ embeddings: {}, verdict: (input) => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'conflict' }) });
    const now = '2026-11-01T00:00:00.000Z';
    const base = { source: 'curator', scope: 'vault', node_id: null, category: null, metadata_json: null, created_at: now, updated_at: now, valid_at: now };
    const said = insertMemoryRow(db!, { ...base, content: 'said', evidence_kind: 'conversation', evidence_node_id: null, evidence_hash: null, evidence_ref: 'c#1' });
    insertMemoryVector(db!, said, vec(0));
    const noted = insertMemoryRow(db!, { ...base, content: 'noted', valid_at: OLD_DAY, evidence_kind: 'note', evidence_node_id: 'old', evidence_hash: 'h', evidence_ref: null });
    insertMemoryVector(db!, noted, vec(at(0.2)));
    markConsolidationPending(db!, noted, 'test', now);
    const replay = ConsolidationReplay.for(t.service);
    await callTool(t.server, 'replay-memory-consolidation', { action: 'start', dry_run: false });
    await replay.settled();
    const status = await callTool(t.server, 'replay-memory-consolidation', {});
    expect(status.data.outcomes).toMatchObject({ kept_both: 1, contradict: 0 });
    expect(t.row(said).expired_at).toBeNull();
  });
});
