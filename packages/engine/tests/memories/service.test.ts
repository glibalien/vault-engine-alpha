import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { MemoryService, normalizeForDedup, floatsToBytes, lineageOf, addTemporalReadConditions } from '../../src/memories/service.js';
import type { MemoryRow } from '../../src/memories/types.js';

const EV = { kind: 'conversation', ref: 'test#0' } as const;

describe('normalizeForDedup', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeForDedup('  USER   Prefers  ')).toBe('user prefers');
    expect(normalizeForDedup('Dark Mode')).toBe('dark mode');
  });
});

describe('floatsToBytes', () => {
  it('is a zero-copy view over the Float32Array buffer', () => {
    const v = new Float32Array([1.5, -2.25]);
    const bytes = floatsToBytes(v);
    expect(bytes.byteLength).toBe(8);
    // round-trips back to the same floats
    expect(Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)))
      .toEqual([1.5, -2.25]);
  });
});

describe('addTemporalReadConditions', () => {
  it('as_of adds created/expired/valid/invalid predicates', () => {
    const conditions: string[] = [];
    const args: unknown[] = [];
    addTemporalReadConditions(conditions, args, { as_of: '2026-01-01T00:00:00.000Z' });
    expect(conditions).toHaveLength(4);
    expect(args).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });
  it('default (no include_superseded) excludes expired', () => {
    const conditions: string[] = [];
    addTemporalReadConditions(conditions, [], {});
    expect(conditions).toEqual(['expired_at IS NULL']);
  });
  it('include_superseded=true adds nothing', () => {
    const conditions: string[] = [];
    addTemporalReadConditions(conditions, [], { include_superseded: true });
    expect(conditions).toEqual([]);
  });
  it('qualifier prefixes column names', () => {
    const conditions: string[] = [];
    addTemporalReadConditions(conditions, [], { include_superseded: false }, 'm');
    expect(conditions).toEqual(['m.expired_at IS NULL']);
  });
});

describe('MemoryService (direct, no MCP envelope)', () => {
  let db: Database.Database;
  let service: MemoryService;

  beforeEach(() => {
    db = createTestDb();
    service = new MemoryService(db);
  });
  afterEach(() => db.close());

  it('create returns a ServiceResult ok with operation add', async () => {
    const { result, warnings } = await service.create({ source: 'chat', content: 'a fact', scope: 'vault', evidence: EV });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe('add');
      expect(result.data.id).toBeGreaterThan(0);
      expect(result.data.dedup_checked).toBe(true);
      expect(result.data.embedding).toBe(false);
    }
    // no embedder -> degraded warning
    expect(warnings.some((w) => w.code === 'MEMORY_DEDUP_DEGRADED')).toBe(true);
  });

  it('create surfaces DUPLICATE_MEMORY as a ServiceResult error (same shape the tool wraps)', async () => {
    await service.create({ source: 'chat', content: 'duplicate fact', scope: 'vault', evidence: EV });
    const { result } = await service.create({ source: 'chat', content: 'duplicate fact', scope: 'vault', evidence: EV });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DUPLICATE_MEMORY');
      expect(result.error.details?.dedup_method).toBe('fts');
    }
  });

  it('get/list/search return ServiceResult directly (synchronous)', async () => {
    const created = await service.create({ source: 'chat', content: 'find me', scope: 'vault', evidence: EV });
    const id = created.result.ok ? created.result.data.id : -1;

    const got = service.get({ id });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.data.content).toBe('find me');

    const listed = service.list({ limit: 50, offset: 0 });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.total).toBe(1);

    const searched = service.list({ query: 'find', limit: 10, offset: 0 });
    expect(searched.ok).toBe(true);
    if (searched.ok) expect(searched.data).toMatchObject({ total: 1, query: 'find' });
    if (searched.ok) expect(searched.data.memories).toHaveLength(1);
  });

  it('lists only the memories asked for by id, and only live ones (#474)', async () => {
    const ids: number[] = [];
    for (const content of ['first rule', 'second rule', 'unrelated fact']) {
      const created = await service.create({ source: 'curator', content, scope: 'vault', evidence: EV });
      if (created.result.ok) ids.push(created.result.data.id);
    }
    await service.expire({ id: ids[1]!, reason: 'contradicted' });
    const listed = service.list({ ids: [ids[0]!, ids[1]!, 999_999], limit: 50, offset: 0 });
    expect(listed.ok && listed.data.memories.map(m => m.id)).toEqual([ids[0]]);
    const withExpired = service.list({ ids: [ids[0]!, ids[1]!], include_superseded: true, limit: 50, offset: 0 });
    expect(withExpired.ok && withExpired.data.memories.map(m => m.id).sort()).toEqual([ids[0], ids[1]].sort());
    const none = service.list({ ids: [], limit: 50, offset: 0 });
    expect(none.ok && none.data.total).toBe(0);
  });

  it('snapshotAll returns the full stock with derived predecessors and embedded flag', async () => {
    await service.create({ source: 'chat', content: 'v1', scope: 'vault', evidence: EV });
    const first = (db.prepare('SELECT id FROM memories ORDER BY id LIMIT 1').get() as { id: number }).id;
    // version it (content change) -> old row superseded_by new
    await service.update({ id: first, content: 'v2', evidence: EV });
    const snapshot = service.snapshotAll();
    expect(snapshot).toHaveLength(2);
    const newRow = snapshot.find((r) => r.content === 'v2')!;
    const oldRow = snapshot.find((r) => r.content === 'v1')!;
    expect(newRow.predecessors).toEqual([oldRow.id]);
    expect(oldRow.superseded_by).toBe(newRow.id);
    // no embedder was configured
    expect(snapshot.every((r) => r.embedded === false)).toBe(true);
  });

  it('snapshotAll tolerates malformed metadata_json (raw fallback to {})', () => {
    db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, metadata_json)
       VALUES ('chat','vault','broken meta','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','unknown','{not valid json')`,
    ).run();
    const snapshot = service.snapshotAll();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.metadata).toEqual({});
  });
});

describe('lineageOf', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('walks predecessors and successors through the superseded_by chain', () => {
    // Build a 3-row chain by hand: 1 -> superseded_by 2 -> superseded_by 3
    const T = '2026-01-01T00:00:00.000Z';
    for (const id of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO memories (id, source, scope, content, created_at, updated_at, valid_at, evidence_kind)
         VALUES (?, 'chat','vault', ?, ?, ?, ?, 'unknown')`,
      ).run(id, `v${id}`, T, T, T);
    }
    db.prepare('UPDATE memories SET superseded_by = 2, expired_at = ? WHERE id = 1').run(T);
    db.prepare('UPDATE memories SET superseded_by = 3, expired_at = ? WHERE id = 2').run(T);
    const chain = lineageOf(db, 2) as MemoryRow[];
    expect(chain.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('returns [] for a missing id', () => {
    expect(lineageOf(db, 99999)).toEqual([]);
  });
});
