import type Database from 'better-sqlite3';

export interface WikiControlRow {
  project_title: string;
  paused: number; // 0 | 1
  paused_at: string | null;
  paused_by: string | null;
  updated_at: string;
}

export type CorrectionStatus = 'active' | 'resolved';

export interface WikiCorrectionRow {
  id: number;
  project_title: string;
  note: string;
  created_at: string;
  created_by: string | null;
  status: CorrectionStatus;
  resolved_at: string | null;
}

export type CorrectionInsert = Pick<WikiCorrectionRow, 'project_title' | 'note' | 'created_by' | 'created_at'>;

/** A wiki's control state — the shape the control MCP tools return. */
export interface ControlState {
  project: string;
  paused: boolean;
  corrections: Array<{ id: number; note: string; created_at: string }>;
}

/** DDL for the control tables. Called by migration #3 (not on every boot). */
export function createWikiControlTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_control (
      project_title TEXT PRIMARY KEY,
      paused        INTEGER NOT NULL DEFAULT 0,
      paused_at     TEXT,
      paused_by     TEXT,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_corrections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_title TEXT NOT NULL,
      note          TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      created_by    TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      resolved_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_corrections_project_status
      ON wiki_corrections(project_title, status);
  `);
}

/** Pause or resume a wiki (upsert one control row). paused_at/paused_by clear on resume. */
export function setPaused(
  db: Database.Database, projectTitle: string, paused: boolean, by: string | null, ts: string,
): void {
  db.prepare(`
    INSERT INTO wiki_control (project_title, paused, paused_at, paused_by, updated_at)
    VALUES (@project_title, @paused, @paused_at, @paused_by, @updated_at)
    ON CONFLICT(project_title) DO UPDATE SET
      paused = @paused, paused_at = @paused_at, paused_by = @paused_by, updated_at = @updated_at
  `).run({
    project_title: projectTitle,
    paused: paused ? 1 : 0,
    paused_at: paused ? ts : null,
    paused_by: paused ? by : null,
    updated_at: ts,
  });
}

export function isPaused(db: Database.Database, projectTitle: string): boolean {
  const row = db.prepare(`SELECT paused FROM wiki_control WHERE project_title = ?`).get(projectTitle) as
    | { paused: number } | undefined;
  return row?.paused === 1;
}

export function pausedWikis(db: Database.Database): WikiControlRow[] {
  return db.prepare(`SELECT * FROM wiki_control WHERE paused = 1 ORDER BY project_title`).all() as WikiControlRow[];
}

export function addCorrection(db: Database.Database, row: CorrectionInsert): number {
  const res = db.prepare(`
    INSERT INTO wiki_corrections (project_title, note, created_by, created_at, status)
    VALUES (@project_title, @note, @created_by, @created_at, 'active')
  `).run(row);
  return Number(res.lastInsertRowid);
}

export function activeCorrections(db: Database.Database, projectTitle: string): WikiCorrectionRow[] {
  return db.prepare(
    `SELECT * FROM wiki_corrections WHERE project_title = ? AND status = 'active' ORDER BY id`,
  ).all(projectTitle) as WikiCorrectionRow[];
}

export function allActiveCorrections(db: Database.Database): WikiCorrectionRow[] {
  return db.prepare(
    `SELECT * FROM wiki_corrections WHERE status = 'active' ORDER BY project_title, id`,
  ).all() as WikiCorrectionRow[];
}

/** Mark a correction resolved. Returns true iff an active row with that id existed. */
export function resolveCorrection(db: Database.Database, id: number, ts: string): boolean {
  const res = db.prepare(
    `UPDATE wiki_corrections SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'active'`,
  ).run(ts, id);
  return res.changes > 0;
}

/**
 * Drop every control row for a wiki title — the pause flag and all corrections,
 * resolved ones included. For deregistration: leaving them behind would silently
 * re-apply (a stale pause, an obsolete steering note) if the same title is ever
 * registered again. Returns what went away.
 */
export function clearWikiControl(db: Database.Database, projectTitle: string): { paused: number; corrections: number } {
  const paused = db.prepare(`DELETE FROM wiki_control WHERE project_title = ?`).run(projectTitle).changes;
  const corrections = db.prepare(`DELETE FROM wiki_corrections WHERE project_title = ?`).run(projectTitle).changes;
  return { paused, corrections };
}

/** The control state for a wiki — the shape the tools return. */
export function controlState(db: Database.Database, projectTitle: string): ControlState {
  return {
    project: projectTitle,
    paused: isPaused(db, projectTitle),
    corrections: activeCorrections(db, projectTitle).map(c => ({ id: c.id, note: c.note, created_at: c.created_at })),
  };
}
