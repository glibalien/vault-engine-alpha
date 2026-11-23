import type Database from 'better-sqlite3';

/**
 * "No subjects" answers of on-demand subject runs (#554), so a run started again does not pay to
 * ask the same question of the same memory. A memory's text never changes in place (a new text
 * is a new memory), but what the model is shown with it can: the names its source note links, the
 * owner's name. So an answer holds for one question only: the memory as the model was shown it
 * (`shown_hash`), the call around it (`call_hash`: the instructions and the settings that shape
 * the call), and the model.
 *
 * A memory given subjects needs no row: it has left the set of memories with none.
 */

/** DDL for migration 38. */
export function createSubjectVerdictTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE subject_run_verdicts (
      memory_id  INTEGER PRIMARY KEY,
      shown_hash TEXT NOT NULL,
      call_hash  TEXT NOT NULL,
      model      TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
  `);
}

export interface SubjectQuestion { memoryId: number; shownHash: string; callHash: string; model: string }

/** The memories answered "no subjects" for this call and model, each with the memory as it was shown. */
export function answeredNone(db: Database.Database, asked: { callHash: string; model: string }): Map<number, string> {
  const rows = db.prepare('SELECT memory_id, shown_hash FROM subject_run_verdicts WHERE call_hash = ? AND model = ?')
    .all(asked.callHash, asked.model) as Array<{ memory_id: number; shown_hash: string }>;
  return new Map(rows.map(row => [row.memory_id, row.shown_hash]));
}

export function recordNoSubjects(db: Database.Database, question: SubjectQuestion, decidedAt: string): void {
  db.prepare(`
    INSERT INTO subject_run_verdicts (memory_id, shown_hash, call_hash, model, decided_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET shown_hash = excluded.shown_hash, call_hash = excluded.call_hash,
      model = excluded.model, decided_at = excluded.decided_at
  `).run(question.memoryId, question.shownHash, question.callHash, question.model, decidedAt);
}
