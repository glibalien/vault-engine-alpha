import type Database from 'better-sqlite3';

/** Page creates a written run left to the next one under the per-run cap. */
export interface DeferredCreates {
  /** The evidence hash that run stamped; the debt applies only while the home still carries it. */
  evidenceHash: string;
  count: number;
}

/** DDL for migration 27. Keyed by wiki root title, for project and topic wikis alike. */
export function createDeferredCreatesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE wiki_deferred_creates (
      root_title    TEXT PRIMARY KEY,
      evidence_hash TEXT NOT NULL,
      count         INTEGER NOT NULL CHECK (count > 0)
    );
  `);
}

export function readDeferredCreates(db: Database.Database, rootTitle: string): DeferredCreates | null {
  const row = db.prepare('SELECT evidence_hash, count FROM wiki_deferred_creates WHERE root_title = ?')
    .get(rootTitle) as { evidence_hash: string; count: number } | undefined;
  return row ? { evidenceHash: row.evidence_hash, count: row.count } : null;
}

/** Replaces the root's deferred creates; a count of zero clears them. */
export function recordDeferredCreates(db: Database.Database, rootTitle: string, deferred: DeferredCreates): void {
  if (deferred.count <= 0) {
    deleteDeferredCreates(db, rootTitle);
    return;
  }
  db.prepare(`
    INSERT INTO wiki_deferred_creates (root_title, evidence_hash, count) VALUES (?, ?, ?)
    ON CONFLICT(root_title) DO UPDATE SET evidence_hash = excluded.evidence_hash, count = excluded.count
  `).run(rootTitle, deferred.evidenceHash, deferred.count);
}

export function deleteDeferredCreates(db: Database.Database, rootTitle: string): void {
  db.prepare('DELETE FROM wiki_deferred_creates WHERE root_title = ?').run(rootTitle);
}
