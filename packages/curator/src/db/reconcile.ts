import type Database from 'better-sqlite3';

/**
 * DDL + DAO for the §4c reconciliation ledger. One row per adjudicated pair,
 * keyed (id_a, id_b) with id_a < id_b ALWAYS (orderPair normalizes — callers
 * never pre-sort). A content change on either member (its updated_at differs
 * from the stored stamp) re-opens the pair: the caller compares stamps via
 * ledgerVerdict and re-adjudicates. Verdict failures are never ledgered.
 * Relies on the engine's never-reused memory ids (AUTOINCREMENT watermark,
 * preserved by the P1 rebuild).
 */
export function createReconcileTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reconcile_ledger (
      id_a           INTEGER NOT NULL,
      id_b           INTEGER NOT NULL,
      updated_at_a   TEXT NOT NULL,
      updated_at_b   TEXT NOT NULL,
      verdict        TEXT NOT NULL,
      adjudicated_at TEXT NOT NULL,
      PRIMARY KEY (id_a, id_b)
    );
  `);
}

/** Normalize a pair to (low, high) — the ledger's key invariant. */
export function orderPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export function ledgerVerdict(
  db: Database.Database, idA: number, idB: number,
): { verdict: string; updated_at_a: string; updated_at_b: string } | undefined {
  const [lo, hi] = orderPair(idA, idB);
  return db.prepare(
    'SELECT verdict, updated_at_a, updated_at_b FROM reconcile_ledger WHERE id_a = ? AND id_b = ?',
  ).get(lo, hi) as { verdict: string; updated_at_a: string; updated_at_b: string } | undefined;
}

/**
 * Pairs the reconciler kept both of (#474 idea 4): two memories that disagree, where neither's note
 * is later, so it couldn't tell which is right. Only pairs whose members are both among `ids`.
 */
export function keptBothPairs(db: Database.Database, ids: readonly number[]): Array<readonly [number, number]> {
  const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id));
  if (unique.length < 2) return [];
  const marks = unique.map(() => '?').join(',');
  return (db.prepare(`SELECT id_a, id_b FROM reconcile_ledger WHERE verdict = 'kept_both' AND id_a IN (${marks}) AND id_b IN (${marks})
    ORDER BY id_a, id_b`).all(...unique, ...unique) as Array<{ id_a: number; id_b: number }>).map(row => [row.id_a, row.id_b] as const);
}

export function upsertVerdict(db: Database.Database, row: {
  idA: number; idB: number; updatedAtA: string; updatedAtB: string; verdict: string; adjudicatedAt: string;
}): void {
  const [lo, hi] = orderPair(row.idA, row.idB);
  const [uLo, uHi] = row.idA < row.idB ? [row.updatedAtA, row.updatedAtB] : [row.updatedAtB, row.updatedAtA];
  db.prepare(`
    INSERT INTO reconcile_ledger (id_a, id_b, updated_at_a, updated_at_b, verdict, adjudicated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_a, id_b) DO UPDATE SET
      updated_at_a = excluded.updated_at_a, updated_at_b = excluded.updated_at_b,
      verdict = excluded.verdict, adjudicated_at = excluded.adjudicated_at
  `).run(lo, hi, uLo, uHi, row.verdict, row.adjudicatedAt);
}
