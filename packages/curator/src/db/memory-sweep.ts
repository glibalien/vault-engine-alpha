import type Database from 'better-sqlite3';

/**
 * DDL for the memory-sweep idempotency ledger + watermark. Called by migration #5.
 * The ledger is the CORRECTNESS guarantee (one row per node, latest content_hash
 * processed); the watermark in memory_sweep_state is only an efficiency filter
 * for the modified_since candidate query.
 */
export function createMemorySweepTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sweep_ledger (
      node_id      TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      swept_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_sweep_state (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_sweep_at TEXT
    );
  `);
}

export function ledgerHash(db: Database.Database, nodeId: string): string | undefined {
  const row = db.prepare(`SELECT content_hash FROM memory_sweep_ledger WHERE node_id = ?`)
    .get(nodeId) as { content_hash: string } | undefined;
  return row?.content_hash;
}

export function upsertLedger(db: Database.Database, nodeId: string, contentHash: string, sweptAt: string): void {
  db.prepare(`
    INSERT INTO memory_sweep_ledger (node_id, content_hash, swept_at) VALUES (?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash = excluded.content_hash, swept_at = excluded.swept_at
  `).run(nodeId, contentHash, sweptAt);
}

/** Forget that a note was read, when the ledger still holds the hash it was read at: an undone
 *  extraction run's note (#659), so a later run reads it again. A later read is left alone. */
export function forgetLedgerHash(db: Database.Database, nodeId: string, contentHash: string): boolean {
  return db.prepare('DELETE FROM memory_sweep_ledger WHERE node_id = ? AND content_hash = ?').run(nodeId, contentHash).changes > 0;
}

export function lastSweepAt(db: Database.Database): string | null {
  const row = db.prepare(`SELECT last_sweep_at FROM memory_sweep_state WHERE id = 1`)
    .get() as { last_sweep_at: string | null } | undefined;
  return row?.last_sweep_at ?? null;
}

export function setLastSweepAt(db: Database.Database, ts: string): void {
  db.prepare(`
    INSERT INTO memory_sweep_state (id, last_sweep_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_sweep_at = excluded.last_sweep_at
  `).run(ts);
}
