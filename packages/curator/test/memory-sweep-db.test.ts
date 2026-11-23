import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { createMemorySweepTables, ledgerHash, upsertLedger, lastSweepAt, setLastSweepAt } from '../src/db/memory-sweep.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('memory_sweep_ledger', () => {
  it('createMemorySweepTables creates exactly these two tables and is idempotent', () => {
    // Scoped to the DDL function's own output on a bare DB (not the full migration
    // chain) so this stays correct regardless of what later migrations add under the
    // same 'memory_sweep%' prefix — see memory_sweep_conversation_ledger (migration #9).
    const db = new Database(':memory:');
    createMemorySweepTables(db);
    createMemorySweepTables(db); // second call applies nothing new (CREATE TABLE IF NOT EXISTS)
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_sweep%' ORDER BY name`).all() as Array<{ name: string }>;
    expect(names.map(n => n.name)).toEqual(['memory_sweep_ledger', 'memory_sweep_state']);
  });

  it('ledgerHash returns undefined for an unseen node, the hash after upsert', () => {
    const db = freshDb();
    expect(ledgerHash(db, 'n1')).toBeUndefined();
    upsertLedger(db, 'n1', 'hash-a', '2026-07-09T00:00:00.000Z');
    expect(ledgerHash(db, 'n1')).toBe('hash-a');
  });

  it('upsertLedger replaces the hash on re-sweep (one row per node)', () => {
    const db = freshDb();
    upsertLedger(db, 'n1', 'hash-a', '2026-07-09T00:00:00.000Z');
    upsertLedger(db, 'n1', 'hash-b', '2026-07-10T00:00:00.000Z');
    expect(ledgerHash(db, 'n1')).toBe('hash-b');
    const count = db.prepare(`SELECT COUNT(*) AS c FROM memory_sweep_ledger`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('watermark: null until set, then the stored value; set replaces', () => {
    const db = freshDb();
    expect(lastSweepAt(db)).toBeNull();
    setLastSweepAt(db, '2026-07-09T05:00:00.000Z');
    expect(lastSweepAt(db)).toBe('2026-07-09T05:00:00.000Z');
    setLastSweepAt(db, '2026-07-10T05:00:00.000Z');
    expect(lastSweepAt(db)).toBe('2026-07-10T05:00:00.000Z');
  });
});
