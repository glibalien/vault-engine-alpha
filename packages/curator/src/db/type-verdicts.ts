import type Database from 'better-sqlite3';

/**
 * "No type fits" verdicts of on-demand typing runs (#644), so a run started again does not pay to
 * ask the same question of the same note.
 *
 * A verdict holds for one question only: the note as the model was shown it (its title, its path
 * and its text), the catalog the model was shown, this model. A new type, a narrower offer, a type
 * whose fields or folder changed, or a note that was edited, renamed or moved is a different
 * question and is asked. That is why these are kept apart from the nightly sweep's ledger
 * (`org_sweep_ledger`), which is keyed by the note's content alone and would skip a note that a
 * type created since might fit.
 *
 * `version` is the note's version when it was asked. A note still at that version has not
 * changed, which a listing can tell without reading the note: a run leaves such notes out of its
 * scope before it counts them, so they never fill the scope a run takes on.
 *
 * A typed note needs no row: it has left the untyped set.
 */

/** DDL for migration 36. */
export function createTypeVerdictTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE type_run_verdicts (
      node_id      TEXT PRIMARY KEY,
      note_hash    TEXT NOT NULL,
      version      INTEGER NOT NULL,
      offered_hash TEXT NOT NULL,
      model        TEXT NOT NULL,
      decided_at   TEXT NOT NULL
    );
  `);
}

/** `noteHash` identifies the note as the model is shown it; `offeredHash` the catalog as the model is shown it. */
export interface TypeQuestion { nodeId: string; noteHash: string; offeredHash: string; model: string }

/** Whether this exact question was already answered "no type fits". */
export function typeAlreadyRefused(db: Database.Database, question: TypeQuestion): boolean {
  const row = db.prepare('SELECT note_hash, offered_hash, model FROM type_run_verdicts WHERE node_id = ?')
    .get(question.nodeId) as { note_hash: string; offered_hash: string; model: string } | undefined;
  return row !== undefined && row.note_hash === question.noteHash && row.offered_hash === question.offeredHash
    && row.model === question.model;
}

export function recordTypeRefusal(db: Database.Database, question: TypeQuestion & { version: number }, decidedAt: string): void {
  db.prepare(`
    INSERT INTO type_run_verdicts (node_id, note_hash, version, offered_hash, model, decided_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET note_hash = excluded.note_hash, version = excluded.version,
      offered_hash = excluded.offered_hash, model = excluded.model, decided_at = excluded.decided_at
  `).run(question.nodeId, question.noteHash, question.version, question.offeredHash, question.model, decidedAt);
}

/**
 * The notes answered "no type fits" for this catalog and model, each with the version it was
 * asked at. A note listed at that same version is unchanged and need not be read to know it.
 */
export function refusedVersions(db: Database.Database, asked: { offeredHash: string; model: string }): Map<string, number> {
  const rows = db.prepare('SELECT node_id, version FROM type_run_verdicts WHERE offered_hash = ? AND model = ?')
    .all(asked.offeredHash, asked.model) as Array<{ node_id: string; version: number }>;
  return new Map(rows.map(row => [row.node_id, row.version]));
}
