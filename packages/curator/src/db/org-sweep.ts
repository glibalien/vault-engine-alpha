import type Database from 'better-sqlite3';

/**
 * DDL for the org-sweep "no type fits" ledger. Called by migration #6.
 * Records LLM null verdicts by content hash so an unclassifiable node is not
 * re-billed nightly; the node re-enters the candidate set when its content
 * changes. Typed nodes need no ledger — they leave the untyped set naturally.
 */
export function createOrgSweepTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_sweep_ledger (
      node_id      TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      decided_at   TEXT NOT NULL
    );
  `);
}

export function orgLedgerHash(db: Database.Database, nodeId: string): string | undefined {
  const row = db.prepare(`SELECT content_hash FROM org_sweep_ledger WHERE node_id = ?`)
    .get(nodeId) as { content_hash: string } | undefined;
  return row?.content_hash;
}

export function upsertOrgLedger(db: Database.Database, nodeId: string, contentHash: string, decidedAt: string): void {
  db.prepare(`
    INSERT INTO org_sweep_ledger (node_id, content_hash, decided_at) VALUES (?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash = excluded.content_hash, decided_at = excluded.decided_at
  `).run(nodeId, contentHash, decidedAt);
}
