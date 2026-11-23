import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { registerMemoriesTools } from '../../src/mcp/tools/memories.js';
import { MEMORY_DEDUP_K, MemoryService, insertMemoryRow, insertMemoryVector, markConsolidationPending } from '../../src/memories/service.js';
import { ConsolidationReplay, CONSECUTIVE_FAILURES_BEFORE_STOP } from '../../src/memories/consolidation-replay.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { ConsolidationAttribution, ConsolidationInput, ConsolidationVerdict, MemoryConsolidator } from '../../src/mcp/tools/memory-consolidation.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = await tool.handler(parsed, {});
  return JSON.parse(result.content[0].text);
}

/** P2 enforcement: create-memory requires evidence. */
const EV = { kind: 'conversation', ref: 'test#0' } as const;

/** A unit vector at angle θ in the first two dimensions: distance(a, b) = 1 − cos(θa − θb). */
function vec(theta: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

/** Angle for a target cosine distance from θ = 0. */
const at = (distance: number) => Math.acos(1 - distance);

/** A vector 0.2 from vec(0), and 0.36 from any other spoke: gray against the base, unrelated to its peers. */
function spoke(i: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = 0.8;
  v[1 + i] = 0.6;
  return v;
}

function fakeEmbedder(map: Record<string, Float32Array>): Embedder {
  return {
    isReady: () => true,
    async embedQuery(text: string) { return map[text] ?? vec(Math.PI / 2); },
    async embedDocument(text: string) { return [map[text] ?? vec(Math.PI / 2)]; },
  };
}

type Script = (input: ConsolidationInput) => ConsolidationVerdict | Error;

/** A consolidator whose answer the test sets per call; it records what it was asked. */
function scriptedConsolidator(initial: Script) {
  const state = {
    script: initial,
    calls: [] as Array<{ input: ConsolidationInput; attribution: ConsolidationAttribution | undefined }>,
  };
  const consolidator: MemoryConsolidator = {
    async consolidate(input, attribution) {
      state.calls.push({ input, attribution });
      const answer = state.script(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { consolidator, state };
}

const keyLimit = () => new Error('403 Key limit exceeded (daily limit). Manage it using https://openrouter.example/keys/abc123 $1.00 of $1.00 used');

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function setup(embeddings: Record<string, Float32Array>, consolidator?: MemoryConsolidator) {
  db = createTestDb();
  const service = new MemoryService(db, { embedder: fakeEmbedder(embeddings), ...(consolidator ? { consolidator } : {}) });
  const server = new McpServer({ name: 'test', version: '0' });
  registerMemoriesTools(server, service);
  const replay = ConsolidationReplay.for(service);
  const create = (content: string, extra: Record<string, unknown> = {}) =>
    callTool(server, 'create-memory', { evidence: EV, source: 'curator', content, ...extra });
  const run = async (args: Record<string, unknown>) => {
    const started = await callTool(server, 'replay-memory-consolidation', { action: 'start', ...args });
    await replay.settled();
    const status = await callTool(server, 'replay-memory-consolidation', {});
    return { started, status };
  };
  const row = (id: number) => db!.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>;
  const pendingIds = () => (db!.prepare('SELECT memory_id FROM memory_consolidation_pending ORDER BY memory_id').all() as Array<{ memory_id: number }>).map((r) => r.memory_id);
  return { server, service, replay, create, run, row, pendingIds };
}

describe('create-memory when consolidation fails (#346)', () => {
  it('adds the memory, flags it for replay and warns the caller without the provider URL', async () => {
    const { consolidator } = scriptedConsolidator(() => keyLimit());
    const t = setup({ base: vec(0), similar: vec(at(0.2)) }, consolidator);
    await t.create('base');
    const res = await t.create('similar');
    expect(res.ok).toBe(true);
    expect(res.data.operation).toBe('add');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].code).toBe('MEMORY_CONSOLIDATION_FAILED');
    expect(res.warnings[0].message).toContain('Key limit exceeded');
    expect(res.warnings[0].message).not.toContain('openrouter.example');
    expect(t.pendingIds()).toEqual([res.data.id]);
  });

  it('flags nothing when consolidation answers', async () => {
    const { consolidator } = scriptedConsolidator(() => ({ operation: 'add', reason: 'new' }));
    const t = setup({ base: vec(0), similar: vec(at(0.2)) }, consolidator);
    await t.create('base');
    const res = await t.create('similar');
    expect(res.warnings).toEqual([]);
    expect(t.pendingIds()).toEqual([]);
  });

  it('moves the flag to the new version when the memory is edited', async () => {
    const { consolidator } = scriptedConsolidator(() => keyLimit());
    const t = setup({ base: vec(0), similar: vec(at(0.2)), edited: vec(at(0.3)) }, consolidator);
    await t.create('base');
    const res = await t.create('similar');
    const edited = await callTool(t.server, 'update-memory', { id: res.data.id, content: 'edited', evidence: EV });
    expect(edited.data.id).not.toBe(res.data.id);
    expect(t.pendingIds()).toEqual([edited.data.id]);
  });

  it('drops the flag when the memory is purged', async () => {
    const { consolidator } = scriptedConsolidator(() => keyLimit());
    const t = setup({ base: vec(0), similar: vec(at(0.2)) }, consolidator);
    await t.create('base');
    const res = await t.create('similar');
    await callTool(t.server, 'expire-memory', { id: res.data.id, purge: true, confirm: true });
    expect(t.pendingIds()).toEqual([]);
  });
});

describe('replay-memory-consolidation (#346)', () => {
  /** base (id 1), then `similar` added after a failed consolidation (id 2, pending). */
  async function withPendingPair(verdict: (input: ConsolidationInput) => ConsolidationVerdict) {
    const c = scriptedConsolidator(() => keyLimit());
    const t = setup({ base: vec(0), similar: vec(at(0.2)) }, c.consolidator);
    const base = (await t.create('base')).data.id as number;
    const similar = (await t.create('similar')).data.id as number;
    c.state.script = verdict;
    c.state.calls = [];
    return { ...t, base, similar, calls: c.state.calls };
  }

  it('reports idle with the pending count before any run', async () => {
    const t = await withPendingPair(() => ({ operation: 'add', reason: '' }));
    const status = await callTool(t.server, 'replay-memory-consolidation', {});
    expect(status.data).toMatchObject({ state: 'idle', pending_total: 1 });
  });

  it('a dry run reports the verdict and changes nothing', async () => {
    const t = await withPendingPair((input) => ({ operation: 'noop', target_id: input.candidates[0]!.id, reason: 'same fact', costUsd: 0.004 }));
    const { started, status } = await t.run({});
    expect(started.data).toMatchObject({ state: 'running', dry_run: true, selected: 1 });
    expect(status.data).toMatchObject({
      state: 'finished', dry_run: true, processed: 1, last_id: t.similar, model_calls: 1, cost_usd: 0.004,
      outcomes: { noop: 1, unchanged: 0 }, pending_total: 1,
    });
    expect(status.data.samples).toEqual([
      { id: t.similar, content: 'similar', outcome: 'noop', target_id: t.base, target_content: 'base', reason: 'same fact' },
    ]);
    expect(t.row(t.similar).expired_at).toBeNull();
    expect(t.pendingIds()).toEqual([t.similar]);
  });

  it('spends on the Engine account under the run, comparing only against older memories', async () => {
    const t = await withPendingPair(() => ({ operation: 'add', reason: 'new' }));
    const { status } = await t.run({ dry_run: false });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.input.candidates.map((c) => c.id)).toEqual([t.base]);
    expect(t.calls[0]!.attribution).toEqual({ service: 'engine', runRef: status.data.run_ref, sourceRef: 'consolidation-replay' });
  });

  it('noop: expires the replayed memory as a duplicate of its neighbour', async () => {
    const t = await withPendingPair((input) => ({ operation: 'noop', target_id: input.candidates[0]!.id, reason: 'same' }));
    const { status } = await t.run({ dry_run: false });
    expect(status.data.outcomes.noop).toBe(1);
    expect(t.row(t.similar)).toMatchObject({ expire_reason: `duplicate-of:${t.base}`, superseded_by: t.base });
    expect(t.row(t.base).expired_at).toBeNull();
    expect(t.pendingIds()).toEqual([]);
  });

  it('update: expires the older memory, superseded by the replayed one', async () => {
    const t = await withPendingPair((input) => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'refines' }));
    await t.run({ dry_run: false });
    expect(t.row(t.base)).toMatchObject({ expire_reason: 'superseded-by-update', superseded_by: t.similar });
    expect(t.row(t.similar).expired_at).toBeNull();
    expect(t.pendingIds()).toEqual([]);
  });

  it('contradict: expires the older memory as contradicted, invalid from the verdict time', async () => {
    const t = await withPendingPair((input) => ({
      operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'moved', valid_at: '2026-03-01T00:00:00.000Z',
    }));
    await t.run({ dry_run: false });
    expect(t.row(t.base)).toMatchObject({
      expire_reason: 'contradicted', superseded_by: t.similar, invalid_at: '2026-03-01T00:00:00.000Z',
    });
    expect(t.pendingIds()).toEqual([]);
  });

  it('add: keeps both memories and clears the flag', async () => {
    const t = await withPendingPair(() => ({ operation: 'add', reason: 'distinct' }));
    const { status } = await t.run({ dry_run: false });
    expect(status.data.outcomes.unchanged).toBe(1);
    expect(t.row(t.base).expired_at).toBeNull();
    expect(t.row(t.similar).expired_at).toBeNull();
    expect(t.pendingIds()).toEqual([]);
  });

  it('expires a memory that sits below the duplicate threshold without a model call', async () => {
    const c = scriptedConsolidator(() => keyLimit());
    const t = setup({ base: vec(0), twin: vec(at(0.01)) }, c.consolidator);
    const base = (await t.create('base')).data.id as number;
    // A lowered threshold sends the twin to consolidation, which fails, so it is added and flagged.
    const twin = (await t.create('twin', { dedup_threshold: 0 })).data.id as number;
    c.state.calls = [];
    const { status } = await t.run({ dry_run: false });
    expect(c.state.calls).toHaveLength(0);
    expect(status.data.outcomes.duplicate).toBe(1);
    expect(t.row(twin)).toMatchObject({ expire_reason: `duplicate-of:${base}`, superseded_by: base });
  });

  /** A row and its vector, written directly so a test can stage a store create would not build. */
  function insert(content: string, v: Float32Array, extra: { source?: string; scope?: string; node_id?: string | null; category?: string; metadata_json?: string; note?: string } = {}): number {
    const now = '2026-01-01T00:00:00.000Z';
    const id = insertMemoryRow(db!, {
      source: extra.source ?? 'curator', scope: extra.scope ?? 'vault', node_id: extra.node_id ?? null, content,
      category: extra.category ?? null, metadata_json: extra.metadata_json ?? null, created_at: now, updated_at: now, valid_at: now,
      ...(extra.note
        ? { evidence_kind: 'note', evidence_node_id: extra.note, evidence_hash: 'h', evidence_ref: null }
        : { evidence_kind: 'conversation', evidence_node_id: null, evidence_hash: null, evidence_ref: 'test#0' }),
    });
    insertMemoryVector(db!, id, v);
    return id;
  }

  /** older (id 1, with a category and metadata), then a pending `replayed` memory in its gray band. */
  function stagedPair(verdict: (input: ConsolidationInput) => ConsolidationVerdict, replayedExtra: { category?: string; metadata_json?: string } = {}) {
    const c = scriptedConsolidator(verdict);
    const t = setup({}, c.consolidator);
    const older = insert('older', vec(0), { category: 'fact', metadata_json: '{"from":"older"}' });
    const replayed = insert('replayed', vec(at(0.2)), replayedExtra);
    markConsolidationPending(db!, replayed, 'test', '2026-01-01T00:00:00.000Z');
    const history = () => t.service.get({ id: replayed, include_history: true });
    return { ...t, older, replayed, history, calls: () => c.state.calls };
  }

  it('update: the surviving memory inherits a category and metadata it lacks, keeping history', async () => {
    const t = stagedPair((input) => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'refines' }));
    await t.run({ dry_run: false });
    expect(t.row(t.replayed)).toMatchObject({ category: 'fact', metadata_json: '{"from":"older"}' });
    const res = t.history();
    expect(res.ok && res.data.history).toEqual([expect.objectContaining({
      change: 'edited', reason: 'consolidation-replay', previous: { category: null, metadata: null },
    })]);
    const found = db!.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'category:fact' ORDER BY rowid").all() as Array<{ rowid: number }>;
    expect(found.map((r) => r.rowid)).toContain(t.replayed);
  });

  it('update: a surviving memory with its own category and metadata keeps them', async () => {
    const t = stagedPair((input) => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'refines' }), { category: 'preference', metadata_json: '{"from":"new"}' });
    await t.run({ dry_run: false });
    expect(t.row(t.replayed)).toMatchObject({ category: 'preference', metadata_json: '{"from":"new"}' });
    const res = t.history();
    expect(res.ok && res.data.history).toEqual([]);
  });

  it('contradict: the surviving memory takes the verdict date, keeping the one it replaces', async () => {
    const t = stagedPair((input) => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'moved', valid_at: '2026-12-01T00:00:00.000Z' }));
    await t.run({ dry_run: false });
    expect(t.row(t.replayed).valid_at).toBe('2026-12-01T00:00:00.000Z');
    expect(t.row(t.older).invalid_at).toBe('2026-12-01T00:00:00.000Z');
    const res = t.history();
    expect(res.ok && res.data.history).toEqual([expect.objectContaining({ previous: { valid_at: '2026-01-01T00:00:00.000Z' } })]);
  });

  describe('a verdict from an earlier note (#349)', () => {
    /** `kept` has the lower id but the later note; each `replayed` memory is pending, from the earlier note. */
    function backfill(verdict: (input: ConsolidationInput) => ConsolidationVerdict, count = 1) {
      const c = scriptedConsolidator(verdict);
      const t = setup({}, c.consolidator);
      const addNote = db!.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
      addNote.run('later', 'later.md', 'Later 2026-10-01');
      addNote.run('earlier', 'earlier.md', 'Earlier 2026-09-01');
      const kept = insert('kept', vec(0), { note: 'later' });
      const replayed = Array.from({ length: count }, (_, i) => insert(`replayed ${i}`, spoke(i), { note: 'earlier' }));
      for (const id of replayed) markConsolidationPending(db!, id, 'test', '2026-01-01T00:00:00.000Z');
      // Written after both notes, as a real backfill is: a note memory's date is never later than its write (#706).
      db!.prepare("UPDATE memories SET created_at = '2026-11-01T00:00:00.000Z', valid_at = '2026-11-01T00:00:00.000Z'").run();
      return { ...t, kept, replayed, calls: () => c.state.calls };
    }

    it.each(['update', 'contradict'] as const)('%s keeps both and clears the flag', async (operation) => {
      const t = backfill((input) => ({ operation, target_id: input.candidates[0]!.id, reason: 'narrower', valid_at: '2026-06-01T00:00:00.000Z' }));
      const { status } = await t.run({ dry_run: false });
      expect(status.data.outcomes).toMatchObject({ kept_both: 1, update: 0, contradict: 0, unchanged: 0 });
      expect(t.row(t.kept)).toMatchObject({ expired_at: null, superseded_by: null });
      expect(t.row(t.replayed[0]!)).toMatchObject({ expired_at: null, valid_at: '2026-06-01T00:00:00.000Z' });
      expect(t.pendingIds()).toEqual([]);
      expect(status.data.samples).toEqual([expect.objectContaining({
        outcome: 'kept_both', target_id: t.kept, reason: `from an earlier note; the model said ${operation}: narrower`,
      })]);
    });

    it('a noop still expires the repeat', async () => {
      const t = backfill((input) => ({ operation: 'noop', target_id: input.candidates[0]!.id, reason: 'covered' }));
      const { status } = await t.run({ dry_run: false });
      expect(status.data.outcomes).toMatchObject({ noop: 1, kept_both: 0 });
      expect(t.row(t.replayed[0]!).expire_reason).toBe(`duplicate-of:${t.kept}`);
      expect(t.row(t.kept).expired_at).toBeNull();
    });

    it('a dry run does not count the kept memory as gone', async () => {
      const t = backfill((input) => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'narrower' }), 2);
      const { status } = await t.run({ dry_run: true });
      expect(status.data.outcomes.kept_both).toBe(2);
      expect(t.calls()[1]!.input.candidates.map((c) => c.id)).toContain(t.kept);
      expect(t.row(t.kept).expired_at).toBeNull();
      expect(t.pendingIds()).toEqual(t.replayed);
    });

    /** Two memories from notes of the same date; the higher id is pending. */
    function sameDay(operation: 'update' | 'contradict') {
      const c = scriptedConsolidator((input) => ({ operation, target_id: input.candidates[0]!.id, reason: 'conflict' }));
      const t = setup({}, c.consolidator);
      const addNote = db!.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
      addNote.run('one', 'one.md', 'One 2026-09-01');
      addNote.run('two', 'two.md', 'Two 2026-09-01');
      const older = insert('older', vec(0), { note: 'one' });
      const replayed = insert('replayed', spoke(0), { note: 'two' });
      markConsolidationPending(db!, replayed, 'test', '2026-01-01T00:00:00.000Z');
      return { ...t, older, replayed };
    }

    it('a contradict from a same-day note keeps both (#351)', async () => {
      const t = sameDay('contradict');
      const { status } = await t.run({ dry_run: false });
      expect(status.data.outcomes).toMatchObject({ kept_both: 1, contradict: 0 });
      expect(t.row(t.older)).toMatchObject({ expired_at: null, superseded_by: null });
      expect(status.data.samples).toEqual([expect.objectContaining({
        outcome: 'kept_both', target_id: t.older, reason: 'from a same-day note; the model said contradict: conflict',
      })]);
    });

    it('an update from a same-day note still replaces (#351)', async () => {
      const t = sameDay('update');
      const { status } = await t.run({ dry_run: false });
      expect(status.data.outcomes).toMatchObject({ update: 1, kept_both: 0 });
      expect(t.row(t.older).expire_reason).toBe('superseded-by-update');
    });

    it('a memory from the later note still replaces the older one', async () => {
      const c = scriptedConsolidator((input) => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'covers it' }));
      const t = setup({}, c.consolidator);
      const addNote = db!.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
      addNote.run('later', 'later.md', 'Later 2026-10-01');
      addNote.run('earlier', 'earlier.md', 'Earlier 2026-09-01');
      const replaced = insert('replaced', vec(0), { note: 'earlier' });
      const replayed = insert('replayed', spoke(0), { note: 'later' });
      markConsolidationPending(db!, replayed, 'test', '2026-01-01T00:00:00.000Z');
      const { status } = await t.run({ dry_run: false });
      expect(status.data.outcomes).toMatchObject({ update: 1, kept_both: 0 });
      expect(t.row(replaced).expire_reason).toBe('superseded-by-update');
    });
  });

  it('add: the memory takes the verdict date as create would have', async () => {
    const t = stagedPair(() => ({ operation: 'add', reason: 'new', valid_at: '2026-06-01T00:00:00.000Z' }));
    const { status } = await t.run({ dry_run: false });
    expect(status.data.outcomes.unchanged).toBe(1);
    expect(t.row(t.replayed).valid_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('a dry run changes no fields', async () => {
    const t = stagedPair((input) => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'moved', valid_at: '2026-12-01T00:00:00.000Z' }));
    await t.run({});
    expect(t.row(t.replayed)).toMatchObject({ valid_at: '2026-01-01T00:00:00.000Z', category: null });
    expect(t.row(t.older)).toMatchObject({ expired_at: null, invalid_at: null });
  });

  it('a dry run treats what a live run would have expired as gone', async () => {
    const script: Script = (input) => (input.content === 'b'
      ? { operation: 'noop', target_id: input.candidates[0]!.id, reason: 'same' }
      : { operation: 'add', reason: 'new' });
    const c = scriptedConsolidator(script);
    const t = setup({}, c.consolidator);
    const a = insert('a', vec(0));
    const b = insert('b', vec(at(0.2)));
    // c sits below the duplicate threshold of b, and in the gray band of a.
    const cId = insert('c', vec(at(0.21)));
    markConsolidationPending(db!, b, 'test', 'x');
    markConsolidationPending(db!, cId, 'test', 'x');
    const { status } = await t.run({});
    expect(status.data).toMatchObject({ outcomes: { noop: 1, duplicate: 0, unchanged: 1 }, model_calls: 2 });
    expect(c.state.calls[1]!.input.candidates.map((m) => m.id)).toEqual([a]);
    expect(t.row(b).expired_at).toBeNull();
  });

  describe('a dry run shows later memories the edits a live run would make (#348)', () => {
    const VALID_AT = '2026-12-01T00:00:00.000Z';
    /** older, then two pending memories: `middle` in older's gray band, `later` in middle's only. */
    function chain(forMiddle: (input: ConsolidationInput) => ConsolidationVerdict) {
      const c = scriptedConsolidator((input) => (input.content === 'middle' ? forMiddle(input) : { operation: 'add', reason: 'new' }));
      const t = setup({}, c.consolidator);
      const older = insert('older', vec(0), { category: 'fact' });
      const middle = insert('middle', vec(at(0.2)));
      const later = insert('later', vec(1.1));
      markConsolidationPending(db!, middle, 'test', 'x');
      markConsolidationPending(db!, later, 'test', 'x');
      const seenByLater = () => c.state.calls.find((x) => x.input.content === 'later')!.input.candidates.find((m) => m.id === middle);
      return { ...t, older, middle, seenByLater };
    }
    const update = (input: ConsolidationInput): ConsolidationVerdict => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'refines' });
    const contradict = (input: ConsolidationInput): ConsolidationVerdict => ({ operation: 'contradict', target_id: input.candidates[0]!.id, reason: 'moved', valid_at: VALID_AT });

    it.each([
      ['dry', true],
      ['live', false],
    ])('update: a category the memory inherits, %s', async (_label, dry_run) => {
      const t = chain(update);
      await t.run({ dry_run });
      expect(t.seenByLater()).toMatchObject({ category: 'fact', valid_at: '2026-01-01T00:00:00.000Z' });
    });

    it.each([
      ['dry', true],
      ['live', false],
    ])('contradict: a valid_at from the verdict, %s', async (_label, dry_run) => {
      const t = chain(contradict);
      await t.run({ dry_run });
      expect(t.seenByLater()).toMatchObject({ category: null, valid_at: VALID_AT });
    });

    it.each([
      ['dry', true],
      ['live', false],
    ])('add: a valid_at from the verdict, %s', async (_label, dry_run) => {
      const t = chain(() => ({ operation: 'add', reason: 'new', valid_at: VALID_AT }));
      await t.run({ dry_run });
      expect(t.seenByLater()).toMatchObject({ valid_at: VALID_AT });
    });

    it('stores none of it', async () => {
      const t = chain(contradict);
      await t.run({ dry_run: true });
      expect(t.row(t.middle)).toMatchObject({ category: null, valid_at: '2026-01-01T00:00:00.000Z' });
    });

    it('keeps a category the memory already has', async () => {
      const c = scriptedConsolidator((input) => (input.content === 'middle' ? update(input) : { operation: 'add', reason: 'new' }));
      const t = setup({}, c.consolidator);
      insert('older', vec(0), { category: 'fact' });
      const middle = insert('middle', vec(at(0.2)), { category: 'preference' });
      const later = insert('later', vec(1.1));
      markConsolidationPending(db!, middle, 'test', 'x');
      markConsolidationPending(db!, later, 'test', 'x');
      await t.run({ dry_run: true });
      const seen = c.state.calls.find((x) => x.input.content === 'later')!.input.candidates.find((m) => m.id === middle);
      expect(seen).toMatchObject({ category: 'preference' });
    });
  });

  it('finds an older memory even when more newer ones than the search limit sit closer', async () => {
    const c = scriptedConsolidator((input) => ({ operation: 'noop', target_id: input.candidates[0]!.id, reason: 'same' }));
    const t = setup({}, c.consolidator);
    const older = insert('older', vec(at(0.3)));
    const target = insert('target', vec(0));
    for (let i = 0; i < MEMORY_DEDUP_K + 5; i++) insert(`newer ${i}`, vec(at(0.001)));
    markConsolidationPending(db!, target, 'test', '2026-01-01T00:00:00.000Z');
    const { status } = await t.run({ dry_run: false });
    expect(c.state.calls.map((x) => x.input.candidates.map((m) => m.id))).toEqual([[older]]);
    expect(status.data.outcomes).toMatchObject({ noop: 1, unchanged: 0 });
    expect(t.row(target)).toMatchObject({ expire_reason: `duplicate-of:${older}`, superseded_by: older });
  });

  it('compares a memory only with older live memories of its own source and scope, nearest first', async () => {
    const c = scriptedConsolidator(() => ({ operation: 'add', reason: 'new' }));
    const t = setup({}, c.consolidator);
    db!.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES ('n1', 'n1.md', 'n1', '', 'h', 0, 0), ('n2', 'n2.md', 'n2', '', 'h', 0, 0)").run();
    const vaultFar = insert('vault far', vec(at(0.3)));
    const vaultNear = insert('vault near', vec(at(0.1)));
    const expired = insert('expired', vec(at(0.08)));
    db!.prepare("UPDATE memories SET expired_at = 'x' WHERE id = ?").run(expired);
    insert('other source', vec(at(0.09)), { source: 'claude' });
    insert('other node', vec(at(0.12)), { scope: 'node', node_id: 'n2' });
    const sameNode = insert('same node', vec(at(0.2)), { scope: 'node', node_id: 'n1' });
    const vaultTarget = insert('vault target', vec(0));
    const nodeTarget = insert('node target', vec(0), { scope: 'node', node_id: 'n1' });
    markConsolidationPending(db!, vaultTarget, 'test', 'x');
    markConsolidationPending(db!, nodeTarget, 'test', 'x');
    await t.run({ dry_run: false });
    expect(c.state.calls.map((x) => x.input.candidates.map((m) => m.id))).toEqual([[vaultNear, vaultFar], [sameNode]]);
    expect(c.state.calls[0]!.input.candidates[0]!.distance).toBeCloseTo(0.1, 5);
  });

  it('replays a created_at window in id order, each memory against the ones before it', async () => {
    const c = scriptedConsolidator(() => ({ operation: 'add', reason: 'new' }));
    // c is in the gray band of both a (0.2) and b (0.18).
    const cVec = new Float32Array(256);
    cVec[0] = 0.8; cVec[2] = 0.3; cVec[3] = Math.sqrt(0.27);
    const t = setup({ a: vec(0), b: spoke(1), c: cVec }, c.consolidator);
    const a = (await t.create('a')).data.id as number;
    const b = (await t.create('b')).data.id as number;
    const cId = (await t.create('c')).data.id as number;
    db!.prepare("UPDATE memories SET created_at = '2026-11-04T05:00:00.000Z' WHERE id IN (?, ?)").run(b, cId);
    db!.prepare("UPDATE memories SET created_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(a);
    c.state.calls = [];
    c.state.script = (input) => input.candidates.some((x) => x.id === a) && input.content === 'b'
      ? { operation: 'noop', target_id: a, reason: 'same' }
      : { operation: 'add', reason: 'new' };
    const { status } = await t.run({ dry_run: false, created_since: '2026-11-04T03:00:00Z', created_until: '2026-11-04T09:00:00Z' });
    expect(status.data).toMatchObject({ selected: 2, processed: 2, outcomes: { noop: 1, unchanged: 1 } });
    // b ran first and was expired, so c was compared only with a.
    expect(c.state.calls.map((x) => x.input.content)).toEqual(['b', 'c']);
    expect(c.state.calls[1]!.input.candidates.map((x) => x.id)).toEqual([a]);
    expect(t.row(b).expire_reason).toBe(`duplicate-of:${a}`);
  });

  it(`stops after ${CONSECUTIVE_FAILURES_BEFORE_STOP} failed calls in a row, queues what failed and names the resume cursor`, async () => {
    const c = scriptedConsolidator(() => ({ operation: 'add', reason: 'new' }));
    const embeddings: Record<string, Float32Array> = { base: vec(0) };
    for (let i = 1; i <= 5; i++) embeddings[`m${i}`] = spoke(i);
    const t = setup(embeddings, c.consolidator);
    await t.create('base');
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await t.create(`m${i}`)).data.id as number);
    db!.prepare("UPDATE memories SET created_at = '2026-01-01T00:00:00.000Z'").run();
    db!.prepare("UPDATE memories SET created_at = '2026-11-05T13:10:00.000Z' WHERE id >= ?").run(ids[0]);
    c.state.script = () => keyLimit();
    const { status } = await t.run({ dry_run: false, created_since: '2026-11-05T13:00:00Z', created_until: '2026-11-05T13:30:00Z' });
    expect(status.data).toMatchObject({ state: 'stopped', processed: CONSECUTIVE_FAILURES_BEFORE_STOP, outcomes: { failed: 3 } });
    expect(status.data.stop_reason).toContain(`after_id ${ids[2]}`);
    expect(status.data.stop_reason).not.toContain('openrouter.example');
    expect(t.pendingIds()).toEqual(ids.slice(0, 3));
  });

  it('refuses a second start while one runs, and stops on request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embeddings: Record<string, Float32Array> = { base: vec(0), m1: spoke(1), m2: spoke(2) };
    const slow: MemoryConsolidator = {
      async consolidate() { await gate; return { operation: 'add', reason: 'new' }; },
    };
    const failing = scriptedConsolidator(() => keyLimit());
    let useSlow = false;
    const t = setup(embeddings, { consolidate: (i, a) => (useSlow ? slow : failing.consolidator).consolidate(i, a) });
    await t.create('base');
    await t.create('m1');
    await t.create('m2');
    useSlow = true;
    const started = await callTool(t.server, 'replay-memory-consolidation', { action: 'start' });
    expect(started.data.state).toBe('running');
    const again = await callTool(t.server, 'replay-memory-consolidation', { action: 'start' });
    expect(again.error.code).toBe('CONFLICT');
    const stopping = await callTool(t.server, 'replay-memory-consolidation', { action: 'stop' });
    expect(stopping.data).toMatchObject({ state: 'running', stop_requested: true });
    release();
    await t.replay.settled();
    const status = await callTool(t.server, 'replay-memory-consolidation', {});
    expect(status.data).toMatchObject({ state: 'stopped', processed: 1, stop_reason: 'stopped on request' });
  });

  it('gives the event loop a turn between memories that need no model call', async () => {
    const c = scriptedConsolidator(() => ({ operation: 'add', reason: 'new' }));
    const embeddings: Record<string, Float32Array> = {};
    for (let i = 0; i < 20; i++) {
      const axis = new Float32Array(256);
      axis[i] = 1;
      embeddings[`m${i}`] = axis;
    }
    const t = setup(embeddings, c.consolidator);
    for (let i = 0; i < 20; i++) await t.create(`m${i}`);
    await callTool(t.server, 'replay-memory-consolidation', { action: 'start', dry_run: false, created_since: '2000-01-01T00:00:00Z' });
    // Microtasks all run before a setImmediate does, so a job that never yielded would be done by now.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(t.replay.status().state).toBe('running');
    await t.replay.settled();
    expect(t.replay.status()).toMatchObject({ state: 'finished', processed: 20, model_calls: 0, outcomes: { unchanged: 20 } });
  });

  it('refuses without a consolidator, without a selection, and with a bad window', async () => {
    const t = setup({});
    const none = await callTool(t.server, 'replay-memory-consolidation', { action: 'start' });
    expect(none.error.code).toBe('UPSTREAM_ERROR');
    db!.close();
    const c = scriptedConsolidator(() => ({ operation: 'add', reason: '' }));
    const u = setup({}, c.consolidator);
    const noSelection = await callTool(u.server, 'replay-memory-consolidation', { action: 'start', pending: false });
    expect(noSelection.error.code).toBe('INVALID_PARAMS');
    const badDate = await callTool(u.server, 'replay-memory-consolidation', { action: 'start', created_since: 'yesterday-ish' });
    expect(badDate.error.code).toBe('INVALID_PARAMS');
    const backwards = await callTool(u.server, 'replay-memory-consolidation', {
      action: 'start', created_since: '2026-11-05T00:00:00Z', created_until: '2026-11-04T00:00:00Z',
    });
    expect(backwards.error.code).toBe('INVALID_PARAMS');
  });
});

describe('replay shows each memory its source note (#352)', () => {
  it("passes the replayed memory's note and each candidate's", async () => {
    const c = scriptedConsolidator(() => keyLimit());
    const t = setup({ base: vec(0), similar: vec(at(0.2)) }, c.consolidator);
    db!.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'Acme sync.md', 'Acme sync', '', 'h1')").run();
    await t.create('base', { evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });
    await t.create('similar');
    c.state.script = () => ({ operation: 'add', reason: 'new' });
    await t.run({ pending: true });
    const input = c.state.calls.at(-1)!.input;
    expect(input.content).toBe('similar');
    expect(input.note).toBeNull();
    expect(input.candidates.map((m) => m.note)).toEqual([{ title: 'Acme sync', date: null, projects: [] }]);
  });
});
