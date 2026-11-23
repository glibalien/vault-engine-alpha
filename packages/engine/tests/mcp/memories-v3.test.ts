import type Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { makeMemoriesServer, callTool } from './memories.test.js';
import { validateEvidence } from '../../src/mcp/tools/memory-evidence.js';
import { evidenceNoteDate } from '../../src/memories/service.js';
import { setStoredSettings } from '../../src/settings/store.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { ConsolidationVerdict, MemoryConsolidator } from '../../src/mcp/tools/memory-consolidation.js';

/** P2 enforcement: create-memory requires evidence. Tests not about evidence use this stamp. */
const EV = { kind: 'conversation', ref: 'test#0' } as const;

/** Any two texts starting with "GRAY" embed at cosine distance ~0.2 (gray band). */
function bandEmbedder(): Embedder {
  let calls = 0;
  const make = (angle: number): Float32Array => {
    const v = new Float32Array(256);
    v[0] = Math.cos(angle);
    v[1] = Math.sin(angle);
    return v;
  };
  return {
    isReady: () => true,
    async embedQuery(text: string) {
      if (!text.startsWith('GRAY')) return make(Math.PI / 2 + calls++);
      // successive GRAY texts step by acos(0.8) ≈ 0.6435 rad → distance 0.2
      return make(0.6435 * calls++);
    },
    async embedDocument(text: string) { return [await this.embedQuery(text)]; },
  };
}

function fakeConsolidator(verdict: ConsolidationVerdict): MemoryConsolidator {
  return { async consolidate() { return verdict; } };
}

describe('validateEvidence', () => {
  it('note requires node_id and hash', () => {
    expect(validateEvidence({ kind: 'note' })).toMatch(/evidence\.node_id and evidence\.hash/);
    expect(validateEvidence({ kind: 'note', node_id: 'n1' })).toMatch(/evidence\.hash/);
    expect(validateEvidence({ kind: 'note', node_id: 'n1', hash: 'h' })).toBeNull();
  });

  it('conversation and curation-run require ref', () => {
    expect(validateEvidence({ kind: 'conversation' })).toMatch(/requires evidence\.ref/);
    expect(validateEvidence({ kind: 'conversation', ref: 'c1#3' })).toBeNull();
    expect(validateEvidence({ kind: 'curation-run', ref: 'run-1' })).toBeNull();
  });
});

describe('create-memory evidence (optional in P1)', () => {
  it('persists evidence columns and returns them in the serialized shape', async () => {
    const { server, db } = makeMemoriesServer({});
    const res = await callTool(server, 'create-memory', {
      source: 'curator', content: 'a well-evidenced fact',
      evidence: { kind: 'note', node_id: 'n1', hash: 'abc' },
    });
    expect(res.ok).toBe(true);
    const got = await callTool(server, 'get-memory', { id: res.data.id });
    expect(got.data.evidence_kind).toBe('note');
    expect(got.data.evidence_node_id).toBe('n1');
    expect(got.data.evidence_hash).toBe('abc');
    expect(got.data.evidence_ref).toBeNull();
    expect(got.data.expire_reason).toBeNull();
    db.close();
  });

  it('rejects malformed evidence naming the missing fields', async () => {
    const { server, db } = makeMemoriesServer({});
    const res = await callTool(server, 'create-memory', {
      source: 'chat', content: 'x', evidence: { kind: 'conversation' },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toMatch(/evidence\.ref/);
    db.close();
  });

  it('rejects create-memory without evidence (P2 enforcement flip)', async () => {
    const { server, db } = makeMemoriesServer({});
    const res = await callTool(server, 'create-memory', { source: 'chat', content: 'no evidence' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toMatch(/evidence is required/);
    expect(res.error.message).toMatch(/evidence\.node_id \+ evidence\.hash/); // names the per-kind fields
    expect(res.error.message).toMatch(/evidence\.ref/);
    db.close();
  });

  it('grandfathered unknown rows (prod shape) stay fully readable after the flip', async () => {
    const { server, db } = makeMemoriesServer({});
    const T = '2026-01-01T00:00:00.000Z';
    // Pre-v3 rows only exist via the migration backfill — arrange in SQL, like prod.
    db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind)
       VALUES ('chat','vault','pre-v3 grandfathered fact', ?, ?, ?, 'unknown')`,
    ).run(T, T, T);
    const list = await callTool(server, 'list-memories', { source: 'chat' });
    expect(list.data.memories.map((m: { content: string }) => m.content)).toEqual(['pre-v3 grandfathered fact']);
    const search = await callTool(server, 'list-memories', { query: 'grandfathered' });
    expect(search.data.memories).toHaveLength(1);
    const byKind = await callTool(server, 'list-memories', { evidence_kind: 'unknown' });
    expect(byKind.data.memories).toHaveLength(1);
    db.close();
  });
});

describe('dedup_threshold description drift', () => {
  it('says default 0.06, not 0.15', async () => {
    const { server, db } = makeMemoriesServer({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools['create-memory'];
    const desc = String(tool.inputSchema.shape.dedup_threshold.description);
    expect(desc).toContain('0.06');
    expect(desc).not.toContain('0.15');
    db.close();
  });
});

describe('expire-memory', () => {
  it('expires a live memory with reason; default reads then exclude it', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'to retire' });
    const res = await callTool(server, 'expire-memory', { id: created.data.id, reason: 'no longer relevant' });
    expect(res.ok).toBe(true);
    expect(res.data.expired_at).not.toBeNull();
    expect(res.data.expire_reason).toBe('no longer relevant');
    const list = await callTool(server, 'list-memories', { source: 'chat' });
    expect(list.data.memories).toHaveLength(0);
    const withSuperseded = await callTool(server, 'list-memories', { source: 'chat', include_superseded: true });
    expect(withSuperseded.data.memories).toHaveLength(1);
    db.close();
  });

  it('supersede link: validates target exists and is live; records superseded_by + invalid_at', async () => {
    const { server, db } = makeMemoriesServer({});
    const loser = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'old fact' });
    const winner = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'new fact' });
    const bad = await callTool(server, 'expire-memory', { id: loser.data.id, reason: 'x', superseded_by: 424242 });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('INVALID_PARAMS');
    const self = await callTool(server, 'expire-memory', { id: loser.data.id, reason: 'x', superseded_by: loser.data.id });
    expect(self.ok).toBe(false);
    const res = await callTool(server, 'expire-memory', {
      id: loser.data.id, reason: 'contradicted', superseded_by: winner.data.id, invalid_at: '2026-07-01T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    expect(res.data.superseded_by).toBe(winner.data.id);
    expect(res.data.invalid_at).toBe('2026-07-01T00:00:00.000Z');
    // an expired memory cannot be a supersede target
    const third = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'third fact' });
    const ontoExpired = await callTool(server, 'expire-memory', { id: third.data.id, reason: 'x', superseded_by: loser.data.id });
    expect(ontoExpired.ok).toBe(false);
    expect(ontoExpired.error.message).toMatch(/must be live/);
    db.close();
  });

  it('expiring an already-expired memory is an idempotent ok with already_expired', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'x' });
    await callTool(server, 'expire-memory', { id: created.data.id, reason: 'first' });
    const again = await callTool(server, 'expire-memory', { id: created.data.id, reason: 'second' });
    expect(again.ok).toBe(true);
    expect(again.data.already_expired).toBe(true);
    expect(again.data.expire_reason).toBe('first');
    db.close();
  });

  it('reactivate clears expiry state; rejects combining with superseded_by/invalid_at; NOT_FOUND for missing id', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'phoenix' });
    await callTool(server, 'expire-memory', { id: created.data.id, reason: 'oops' });
    const badCombo = await callTool(server, 'expire-memory', { id: created.data.id, reason: 'r', reactivate: true, superseded_by: 1 });
    expect(badCombo.ok).toBe(false);
    const res = await callTool(server, 'expire-memory', { id: created.data.id, reason: 'expired by mistake', reactivate: true });
    expect(res.ok).toBe(true);
    expect(res.data.reactivated).toBe(true);
    expect(res.data.expired_at).toBeNull();
    expect(res.data.expire_reason).toBeNull();
    const list = await callTool(server, 'list-memories', { source: 'chat' });
    expect(list.data.memories).toHaveLength(1);
    const missing = await callTool(server, 'expire-memory', { id: 424242, reason: 'x' });
    expect(missing.error.code).toBe('NOT_FOUND');
    db.close();
  });
});

describe('contradict verdict records expire_reason (v3)', () => {
  it("consolidator 'contradict' stamps the loser with expire_reason=contradicted", async () => {
    const { server, db } = makeMemoriesServer({
      embedder: bandEmbedder(), consolidator: fakeConsolidator({ operation: 'contradict', target_id: 1, reason: 'changed' }),
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'GRAY old fact' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'GRAY new fact' });
    expect(res.data.operation).toBe('contradict');
    const loser = db.prepare('SELECT expire_reason FROM memories WHERE id = 1').get() as { expire_reason: string | null };
    expect(loser.expire_reason).toBe('contradicted');
    db.close();
  });
});

describe('update and contradict from an earlier note (#349)', () => {
  function addNote(db: Database.Database, id: string, title: string, date?: string): void {
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run(id, `${id}.md`, title);
    if (date) db.prepare("INSERT INTO node_fields (node_id, field_name, value_date) VALUES (?, 'date', ?)").run(id, date);
  }
  const fromNote = (nodeId: string) => ({ kind: 'note', node_id: nodeId, hash: 'h' }) as const;
  const liveIds = (db: Database.Database) =>
    (db.prepare('SELECT id FROM memories WHERE expired_at IS NULL ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);

  async function pair(operation: 'update' | 'contradict', existing: Record<string, unknown>, incoming: Record<string, unknown>, notes: (db: Database.Database) => void) {
    const { server, db } = makeMemoriesServer({
      embedder: bandEmbedder(),
      consolidator: fakeConsolidator({ operation, target_id: 1, reason: 'model verdict', valid_at: '2026-03-01T00:00:00.000Z' }),
    });
    notes(db);
    await callTool(server, 'create-memory', { source: 'curator', content: 'GRAY existing', evidence: existing });
    const res = await callTool(server, 'create-memory', { source: 'curator', content: 'GRAY incoming', evidence: incoming });
    return { db, res };
  }
  const twoNotes = (db: Database.Database) => {
    addNote(db, 'earlier', 'Earlier', '2026-09-01');
    addNote(db, 'later', 'Later', '2026-10-01');
  };

  it.each(['update', 'contradict'] as const)('%s from an earlier note adds the memory and keeps both', async (operation) => {
    const { db, res } = await pair(operation, fromNote('later'), fromNote('earlier'), twoNotes);
    expect(res.data.operation).toBe('add');
    expect(res.data.superseded).toEqual([]);
    expect(res.data.valid_at).toBe('2026-03-01T00:00:00.000Z');
    expect(liveIds(db)).toEqual([1, res.data.id]);
    db.close();
  });

  it.each(['update', 'contradict'] as const)('%s from a later note still replaces the candidate', async (operation) => {
    const { db, res } = await pair(operation, fromNote('earlier'), fromNote('later'), twoNotes);
    expect(res.data.operation).toBe(operation);
    expect(liveIds(db)).toEqual([res.data.id]);
    db.close();
  });

  const sameDay = (d: Database.Database) => {
    addNote(d, 'a', 'A', '2026-09-01');
    addNote(d, 'b', 'B', '2026-09-01');
  };

  it('an update from a note of the same day still replaces', async () => {
    const { db, res } = await pair('update', fromNote('a'), fromNote('b'), sameDay);
    expect(res.data.operation).toBe('update');
    expect(liveIds(db)).toEqual([res.data.id]);
    db.close();
  });

  it('a contradict from a note of the same day adds the memory and keeps both (#351)', async () => {
    const { db, res } = await pair('contradict', fromNote('a'), fromNote('b'), sameDay);
    expect(res.data.operation).toBe('add');
    expect(res.data.superseded).toEqual([]);
    expect(res.data.valid_at).toBe('2026-03-01T00:00:00.000Z');
    expect(liveIds(db)).toEqual([1, res.data.id]);
    db.close();
  });

  it('a contradict with an unknown date still replaces, so chat corrections work (#351)', async () => {
    const conversation = await pair('contradict', fromNote('a'), EV, sameDay);
    expect(conversation.res.data.operation).toBe('contradict');
    conversation.db.close();
    const undated = await pair('contradict', fromNote('a'), fromNote('undated'), (d) => {
      addNote(d, 'a', 'A', '2026-09-01');
      addNote(d, 'undated', 'Undated');
    });
    expect(undated.res.data.operation).toBe('contradict');
    undated.db.close();
  });

  it('reads the date from the title when the note has no date field', async () => {
    const { db, res } = await pair('update', fromNote('week'), fromNote('day'), (d) => {
      addNote(d, 'week', 'Week in review 2020-10-24 to 2020-10-30');
      addNote(d, 'day', '2020-10-29');
    });
    expect(res.data.operation).toBe('add');
    db.close();
  });

  it('leaves the verdict alone when a date is unknown', async () => {
    const noDate = await pair('update', fromNote('later'), fromNote('undated'), (d) => {
      addNote(d, 'later', 'Later', '2026-10-01');
      addNote(d, 'undated', 'Undated');
    });
    expect(noDate.res.data.operation).toBe('update');
    noDate.db.close();
    // A candidate drawn from a chat is dated by its write: an older note no longer replaces it (#706 follow-up).
    const conversation = await pair('update', EV, fromNote('earlier'), twoNotes);
    expect(conversation.res.data.operation).toBe('add');
    conversation.db.close();
    const missingNote = await pair('update', fromNote('later'), fromNote('never-indexed'), twoNotes);
    expect(missingNote.res.data.operation).toBe('update');
    missingNote.db.close();
  });
});

describe('evidenceNoteDate (#349)', () => {
  const read = (title: string, field?: { value_date?: string; value_text?: string }) => {
    const { db } = makeMemoriesServer({});
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('n', 'n.md', title);
    if (field) {
      db.prepare("INSERT INTO node_fields (node_id, field_name, value_date, value_text) VALUES ('n', 'date', ?, ?)")
        .run(field.value_date ?? null, field.value_text ?? null);
    }
    const date = evidenceNoteDate(db, 'n');
    db.close();
    return date;
  };

  it('prefers the date field over the title', () => {
    expect(read('Sync 2027-08-03', { value_date: '2026-08-03' })).toBe('2026-08-03');
  });

  it('trims a time from the field, and reads a date stored as text', () => {
    expect(read('Sync', { value_date: '2026-08-03T10:00:00.000Z' })).toBe('2026-08-03');
    expect(read('Sync', { value_text: ' 2026-08-03 ' })).toBe('2026-08-03');
  });

  it('falls back to the last real date in the title', () => {
    expect(read('Week 2020-10-24 to 2020-10-30')).toBe('2020-10-30');
    expect(read('Sync 2026-08-03', { value_text: 'next tuesday' })).toBe('2026-08-03');
    expect(read('Sync 2026-13-45')).toBeNull();
  });

  it('reads the vault map\'s date field, and only the title when it is none', () => {
    const { db } = makeMemoriesServer({});
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('n', 'n.md', 'Sync 2026-08-05');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('n', 'date', '2026-08-03')").run();
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('n', 'written', '2026-08-04')").run();
    expect(evidenceNoteDate(db, 'n')).toBe('2026-08-03');
    setStoredSettings(db, 'vault', { dateField: 'written' });
    expect(evidenceNoteDate(db, 'n')).toBe('2026-08-04');
    setStoredSettings(db, 'vault', { dateField: null });
    expect(evidenceNoteDate(db, 'n')).toBe('2026-08-05');
    db.close();
  });

  it('is null with no node id, an unknown node, or no date', () => {
    const { db } = makeMemoriesServer({});
    expect(evidenceNoteDate(db, null)).toBeNull();
    expect(evidenceNoteDate(db, 'missing')).toBeNull();
    db.close();
    expect(read('Plain title')).toBeNull();
  });
});

describe('expire-memory soft delete and purge', () => {
  it('reason "deleted" is a soft delete — row and vector survive', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'soft target' });
    const res = await callTool(server, 'expire-memory', { id: created.data.id, reason: 'deleted' });
    expect(res.ok).toBe(true);
    expect(res.data.expire_reason).toBe('deleted');
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    const again = await callTool(server, 'expire-memory', { id: created.data.id, reason: 'deleted' });
    expect(again.ok).toBe(true);
    expect(again.data.already_expired).toBe(true);
    db.close();
  });

  it('purge without confirm → CONFIRMATION_REQUIRED; with confirm → hard delete incl. vector', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'purge target' });
    const gated = await callTool(server, 'expire-memory', { id: created.data.id, purge: true });
    expect(gated.ok).toBe(false);
    expect(gated.error.code).toBe('CONFIRMATION_REQUIRED');
    const purged = await callTool(server, 'expire-memory', { id: created.data.id, purge: true, confirm: true });
    expect(purged.ok).toBe(true);
    expect(purged.data.deleted.id).toBe(created.data.id);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('requires a reason unless purging, and rejects purge combined with expiry options', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'guard target' });
    const noReason = await callTool(server, 'expire-memory', { id: created.data.id });
    expect(noReason).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    for (const extra of [{ reactivate: true }, { superseded_by: created.data.id }, { invalid_at: '2026-01-01T00:00:00Z' }]) {
      const mixed = await callTool(server, 'expire-memory', { id: created.data.id, purge: true, confirm: true, ...extra });
      expect(mixed).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    }
    expect((db.prepare('SELECT COUNT(*) c FROM memories WHERE expired_at IS NULL').get() as { c: number }).c).toBe(1);
    db.close();
  });
});

describe('versioned update-memory', () => {
  it('content change mints a new row, expires the old with superseded_by → new', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'v1 of the fact', category: 'fact' });
    const res = await callTool(server, 'update-memory', { id: created.data.id, content: 'v2 of the fact', evidence: EV });
    expect(res.ok).toBe(true);
    expect(res.data.operation).toBe('update');
    expect(res.data.id).not.toBe(created.data.id);
    expect(res.data.content).toBe('v2 of the fact');
    expect(res.data.category).toBe('fact'); // inherited
    expect(res.data.superseded).toEqual([{ id: created.data.id, content: 'v1 of the fact', reason: 'superseded-by-update' }]);
    const old = await callTool(server, 'get-memory', { id: created.data.id });
    expect(old.data.expired_at).not.toBeNull();
    expect(old.data.expire_reason).toBe('superseded-by-update');
    expect(old.data.superseded_by).toBe(res.data.id);
    // lineage walks the chain
    const lineage = await callTool(server, 'get-memory', { id: created.data.id, include_lineage: true });
    expect(lineage.data.lineage.map((m: { id: number }) => m.id)).toEqual([created.data.id, res.data.id]);
    db.close();
  });

  it('explicit evidence attaches to the new version; overriding evidence replaces it', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', {
      source: 'curator', content: 'sourced fact', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' },
    });
    const explicit = await callTool(server, 'update-memory', {
      id: created.data.id, content: 'sourced fact v2', evidence: { kind: 'note', node_id: 'n1', hash: 'h1a' },
    });
    expect(explicit.data.evidence_kind).toBe('note');
    expect(explicit.data.evidence_hash).toBe('h1a');
    const overridden = await callTool(server, 'update-memory', {
      id: explicit.data.id, content: 'sourced fact v3', evidence: { kind: 'note', node_id: 'n1', hash: 'h2' },
    });
    expect(overridden.data.evidence_hash).toBe('h2');
    db.close();
  });

  it('category/metadata-only updates stay in place (same id, no new row)', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'stable' });
    const res = await callTool(server, 'update-memory', { id: created.data.id, category: 'preference' });
    expect(res.data.id).toBe(created.data.id);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('refuses a content update on an expired memory', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'gone' });
    await callTool(server, 'expire-memory', { id: created.data.id, reason: 'x' });
    const res = await callTool(server, 'update-memory', { id: created.data.id, content: 'zombie edit', evidence: EV });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toMatch(/expired/);
    db.close();
  });

  it("consolidator 'update' verdict versions instead of rewriting in place", async () => {
    const { server, db } = makeMemoriesServer({
      embedder: bandEmbedder(), consolidator: fakeConsolidator({ operation: 'update', target_id: 1, reason: 'refine' }),
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'GRAY base fact' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'GRAY refined fact' });
    expect(res.data.operation).toBe('update');
    expect(res.data.id).not.toBe(1);
    expect(res.data.superseded).toEqual([{ id: 1, content: 'GRAY base fact', reason: 'superseded-by-update' }]);
    const old = db.prepare('SELECT expired_at, superseded_by FROM memories WHERE id = 1').get() as { expired_at: string | null; superseded_by: number | null };
    expect(old.expired_at).not.toBeNull();
    expect(old.superseded_by).toBe(res.data.id);
    db.close();
  });

  it('rejects evidence on a non-content update (no silent drop)', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'stable fact' });
    const res = await callTool(server, 'update-memory', {
      id: created.data.id, category: 'preference', evidence: { kind: 'conversation', ref: 'c9#1' },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toMatch(/content change/);
    db.close();
  });

  it('ignores stamped evidence on a no-op content update — original provenance kept', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', {
      source: 'curator', content: 'stable sourced fact', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' },
    });
    // A stamping client resends identical content (+ a category tweak) with its stamp.
    const res = await callTool(server, 'update-memory', {
      id: created.data.id, content: 'stable sourced fact', category: 'preference',
      evidence: { kind: 'conversation', ref: 'c7#2' },
    });
    expect(res.ok).toBe(true);
    expect(res.data.id).toBe(created.data.id); // in place, no version minted
    expect(res.data.category).toBe('preference');
    expect(res.data.evidence_kind).toBe('note'); // stamp ignored, original evidence kept
    expect(res.data.evidence_node_id).toBe('n1');
    expect(res.data.evidence_hash).toBe('h1');
    expect(res.data.evidence_ref).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('rejects a content CHANGE without evidence (provenance mandatory on every channel)', async () => {
    const { server, db } = makeMemoriesServer({});
    const created = await callTool(server, 'create-memory', { source: 'chat', content: 'original fact', evidence: EV });
    const res = await callTool(server, 'update-memory', { id: created.data.id, content: 'changed fact' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toMatch(/evidence is required for a content change/);
    // the row is untouched
    const got = await callTool(server, 'get-memory', { id: created.data.id });
    expect(got.data.content).toBe('original fact');
    db.close();
  });
});

describe('evidence filters', () => {
  it('list-memories filters by evidence_node_id / evidence_kind / evidence_ref', async () => {
    const { server, db } = makeMemoriesServer({});
    await callTool(server, 'create-memory', { source: 'curator', content: 'from note one', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });
    await callTool(server, 'create-memory', { source: 'curator', content: 'from note two', evidence: { kind: 'note', node_id: 'n2', hash: 'h2' } });
    await callTool(server, 'create-memory', { source: 'chat', content: 'from a chat', evidence: { kind: 'conversation', ref: 'c1#5' } });
    const byNode = await callTool(server, 'list-memories', { evidence_node_id: 'n1' });
    expect(byNode.data.memories.map((m: { content: string }) => m.content)).toEqual(['from note one']);
    const byKind = await callTool(server, 'list-memories', { evidence_kind: 'note' });
    expect(byKind.data.total).toBe(2);
    const byRef = await callTool(server, 'list-memories', { evidence_ref: 'c1#5' });
    expect(byRef.data.memories).toHaveLength(1);
    db.close();
  });

  it('list-memories filters by any of several evidence nodes (#297)', async () => {
    const { server, db } = makeMemoriesServer({});
    await callTool(server, 'create-memory', { source: 'curator', content: 'from note one', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });
    await callTool(server, 'create-memory', { source: 'curator', content: 'from note two', evidence: { kind: 'note', node_id: 'n2', hash: 'h2' } });
    await callTool(server, 'create-memory', { source: 'curator', content: 'from note three', evidence: { kind: 'note', node_id: 'n3', hash: 'h3' } });
    const both = await callTool(server, 'list-memories', { evidence_node_ids: ['n1', 'n3', 'missing'] });
    expect(both.data.memories.map((m: { content: string }) => m.content).sort()).toEqual(['from note one', 'from note three']);
    expect(both.data.total).toBe(2);
    const none = await callTool(server, 'list-memories', { evidence_node_ids: [] });
    expect(none.data.total).toBe(0);
    db.close();
  });

  it('list-memories query composes an evidence filter with the FTS match', async () => {
    const { server, db } = makeMemoriesServer({});
    await callTool(server, 'create-memory', { source: 'curator', content: 'dentist appointment fact', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });
    await callTool(server, 'create-memory', { source: 'curator', content: 'dentist insurance fact', evidence: { kind: 'note', node_id: 'n2', hash: 'h2' } });
    const res = await callTool(server, 'list-memories', { query: 'dentist', evidence_node_id: 'n2' });
    expect(res.data.memories.map((m: { content: string }) => m.content)).toEqual(['dentist insurance fact']);
    db.close();
  });

  it('list-memories query filters by evidence_kind and evidence_ref', async () => {
    const { server, db } = makeMemoriesServer({});
    await callTool(server, 'create-memory', { source: 'curator', content: 'dentist appointment fact', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });
    await callTool(server, 'create-memory', { source: 'chat', content: 'dentist chat fact', evidence: { kind: 'conversation', ref: 'c1#2' } });
    const byKind = await callTool(server, 'list-memories', { query: 'dentist', evidence_kind: 'note' });
    expect(byKind.data.memories.map((m: { content: string }) => m.content)).toEqual(['dentist appointment fact']);
    const byRef = await callTool(server, 'list-memories', { query: 'dentist', evidence_ref: 'c1#2' });
    expect(byRef.data.memories.map((m: { content: string }) => m.content)).toEqual(['dentist chat fact']);
    db.close();
  });

  it('combined evidence filters AND together on both list and search paths', async () => {
    const { server, db } = makeMemoriesServer({});
    await callTool(server, 'create-memory', { source: 'curator', content: 'dentist note-one fact', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });
    await callTool(server, 'create-memory', { source: 'curator', content: 'dentist note-two fact', evidence: { kind: 'note', node_id: 'n2', hash: 'h2' } });
    const list = await callTool(server, 'list-memories', { evidence_kind: 'note', evidence_node_id: 'n2' });
    expect(list.data.memories.map((m: { content: string }) => m.content)).toEqual(['dentist note-two fact']);
    const disjoint = await callTool(server, 'list-memories', { evidence_kind: 'conversation', evidence_node_id: 'n2' });
    expect(disjoint.data.memories).toHaveLength(0); // AND, not OR
    const search = await callTool(server, 'list-memories', { query: 'dentist', evidence_kind: 'note', evidence_node_id: 'n1' });
    expect(search.data.memories.map((m: { content: string }) => m.content)).toEqual(['dentist note-one fact']);
    db.close();
  });
});
