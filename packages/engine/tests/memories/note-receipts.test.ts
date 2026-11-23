import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToMemoryNoteReceipts } from '../../src/db/migrate.js';
import { MemoryNoteReceipts } from '../../src/memories/note-receipts.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  upgradeToMemoryNoteReceipts(db);
  return db;
}

describe('upgradeToMemoryNoteReceipts', () => {
  it('creates the table + index on a fresh DB', () => {
    const db = new Database(':memory:');
    // table is part of createSchema; verify it's absent before migration only
    // when createSchema hasn't run. Here we run createSchema first (fresh boot
    // order) and confirm the migration is a no-op idempotent pass.
    createSchema(db);
    upgradeToMemoryNoteReceipts(db);
    const cols = (db.prepare('PRAGMA table_info(memory_note_receipts)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual([
      'block_key', 'edit_hash', 'source_memory_id', 'result_memory_id',
      'outcome', 'details_json', 'applied_at',
    ]);
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_note_receipts'",
    ).all() as Array<{ name: string }>).map((i) => i.name).sort();
    expect(indexes).toContain('idx_memory_note_receipts_block');
    db.close();
  });

  it('is idempotent (rerun is a no-op)', () => {
    const db = makeDb();
    expect(() => upgradeToMemoryNoteReceipts(db)).not.toThrow();
    expect(() => upgradeToMemoryNoteReceipts(db)).not.toThrow();
    db.close();
  });

  it('creates the table even when createSchema did not declare it (upgrade path)', () => {
    // Simulate a pre-projection DB: build schema without the receipts table by
    // dropping it after createSchema, then run the migration.
    const db = new Database(':memory:');
    createSchema(db);
    db.exec('DROP TABLE memory_note_receipts');
    upgradeToMemoryNoteReceipts(db);
    expect(db.prepare('SELECT COUNT(*) c FROM memory_note_receipts').get()).toBeDefined();
    db.close();
  });
});

describe('MemoryNoteReceipts', () => {
  let db: Database.Database;
  let receipts: MemoryNoteReceipts;

  beforeEach(() => {
    db = makeDb();
    receipts = new MemoryNoteReceipts(db);
  });
  afterEach(() => db.close());

  it('find returns undefined before record and the receipt after', () => {
    expect(receipts.find('mem:418', 'sha256:abc')).toBeUndefined();
    receipts.record({
      block_key: 'mem:418',
      edit_hash: 'sha256:abc',
      source_memory_id: 418,
      result_memory_id: 419,
      outcome: 'updated',
      applied_at: '2026-08-13T09:00:00.000Z',
    });
    const got = receipts.find('mem:418', 'sha256:abc');
    expect(got).toBeDefined();
    expect(got!.outcome).toBe('updated');
    expect(got!.source_memory_id).toBe(418);
    expect(got!.result_memory_id).toBe(419);
    expect(got!.details_json).toBeNull();
  });

  it('receipt uniqueness: (block_key, edit_hash) is the primary key', () => {
    receipts.record({ block_key: 'mem:1', edit_hash: 'h1', outcome: 'updated', applied_at: 't1' });
    expect(() =>
      receipts.record({ block_key: 'mem:1', edit_hash: 'h1', outcome: 'noop', applied_at: 't2' }),
    ).toThrow(); // PK collision — caller must pre-check find()
    // a different edit_hash for the same block is allowed (re-edit after a no-op)
    expect(() =>
      receipts.record({ block_key: 'mem:1', edit_hash: 'h2', outcome: 'updated', applied_at: 't3' }),
    ).not.toThrow();
  });

  it('findByBlockKey returns every receipt for a block, newest first', () => {
    receipts.record({ block_key: 'mem:9', edit_hash: 'h1', outcome: 'updated', applied_at: '2026-01-01T00:00:00.000Z' });
    receipts.record({ block_key: 'mem:9', edit_hash: 'h2', outcome: 'expired', applied_at: '2026-02-01T00:00:00.000Z' });
    const all = receipts.findByBlockKey('mem:9');
    expect(all).toHaveLength(2);
    expect(all[0]!.applied_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('purged-memory survival: receipt persists after the memory row is hard-deleted', () => {
    // No FK on the receipt table, so deleting the memory it references leaves
    // the receipt intact (privacy purge must not erase the audit trail).
    db.prepare(
      `INSERT INTO memories (id, source, scope, content, created_at, updated_at, valid_at, evidence_kind)
       VALUES (77, 'chat','vault','soon to be purged','t','t','t','unknown')`,
    ).run();
    receipts.record({ block_key: 'mem:77', edit_hash: 'h', source_memory_id: 77, result_memory_id: 77, outcome: 'updated', applied_at: 't' });
    db.prepare('DELETE FROM memories WHERE id = 77').run();
    const got = receipts.find('mem:77', 'h');
    expect(got).toBeDefined();
    expect(got!.source_memory_id).toBe(77);
  });

  it('records details_json as serialized JSON', () => {
    receipts.record({ block_key: 'mem:5', edit_hash: 'h', outcome: 'conflict', details: { reason: 'stale', current_id: 12 }, applied_at: 't' });
    const got = receipts.find('mem:5', 'h');
    expect(JSON.parse(got!.details_json!)).toEqual({ reason: 'stale', current_id: 12 });
  });

  it('composes inside a caller-provided transaction (atomic with the mutation)', () => {
    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO memories (id, source, scope, content, created_at, updated_at, valid_at, evidence_kind)
         VALUES (88, 'chat','vault','tx fact','t','t','t','unknown')`,
      ).run();
      receipts.record({ block_key: 'mem:88', edit_hash: 'h', source_memory_id: 88, result_memory_id: 88, outcome: 'created', applied_at: 't' });
      throw new Error('force rollback');
    });
    expect(() => txn()).toThrow();
    // neither the memory nor the receipt landed
    expect(receipts.find('mem:88', 'h')).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) c FROM memories WHERE id = 88').get() as { c: number }).c).toBe(0);
  });
});
