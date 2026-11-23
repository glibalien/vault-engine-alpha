import type Database from 'better-sqlite3';

/**
 * The link sweep's bookkeeping (#332). `link_sweep_state` holds one row: the time of the last
 * run, so the next one reads only notes created since. `link_sweep_notes` remembers each note it
 * has read, so a note is read once, and the notes it left for later (edited too recently, or past
 * the run's cap), so the next run reads them whatever their creation time.
 *
 * - `pending`: left for a later run.
 * - `reported`: read by a report-only run; its links were listed, none written. Apply mode reads
 *   it again (`reportedLinkSweepNotes`), so the links reviewed during the trial are not skipped.
 * - `applied`: read in apply mode; the links it could take were written (migration 37).
 */
export type LinkSweepNoteStatus = 'pending' | 'reported' | 'applied';

/** DDL for migration 34. */
export function createLinkSweepTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE link_sweep_state (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      watermark  TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE link_sweep_notes (
      node_id    TEXT PRIMARY KEY,
      status     TEXT NOT NULL CHECK (status IN ('pending', 'reported')),
      proposals  INTEGER NOT NULL DEFAULT 0,
      -- Reads of this note that failed; a note that keeps failing waits behind the rest.
      failures   INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX idx_link_sweep_notes_status ON link_sweep_notes(status);
  `);
}

/** Migration 37: allow `applied`. SQLite cannot change a CHECK, so the table is copied. */
export function addLinkSweepApplied(db: Database.Database): void {
  db.exec(`
    CREATE TABLE link_sweep_notes_37 (
      node_id    TEXT PRIMARY KEY,
      status     TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'applied')),
      proposals  INTEGER NOT NULL DEFAULT 0,
      failures   INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    );
    INSERT INTO link_sweep_notes_37 (node_id, status, proposals, failures, checked_at)
      SELECT node_id, status, proposals, failures, checked_at FROM link_sweep_notes;
    DROP TABLE link_sweep_notes;
    ALTER TABLE link_sweep_notes_37 RENAME TO link_sweep_notes;
    CREATE INDEX idx_link_sweep_notes_status ON link_sweep_notes(status);
  `);
}

export function readLinkSweepWatermark(db: Database.Database): string | null {
  const row = db.prepare('SELECT watermark FROM link_sweep_state WHERE id = 1').get() as { watermark: string } | undefined;
  return row?.watermark ?? null;
}

export function writeLinkSweepWatermark(db: Database.Database, watermark: string, now: string): void {
  db.prepare(`INSERT INTO link_sweep_state (id, watermark, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET watermark = excluded.watermark, updated_at = excluded.updated_at`).run(watermark, now);
}

/** Notes left for a later run: fewest failed reads first, then longest waiting. */
export function pendingLinkSweepNotes(db: Database.Database): string[] {
  return (db.prepare(`SELECT node_id FROM link_sweep_notes WHERE status = 'pending' ORDER BY failures, checked_at, node_id`).all() as Array<{ node_id: string }>)
    .map(r => r.node_id);
}

/** Notes a report-only run read, longest ago first, for apply mode to read again. */
export function reportedLinkSweepNotes(db: Database.Database, limit: number): string[] {
  return (db.prepare(`SELECT node_id FROM link_sweep_notes WHERE status = 'reported' ORDER BY checked_at, node_id LIMIT ?`).all(limit) as Array<{ node_id: string }>)
    .map(r => r.node_id);
}

/** How many notes report-only runs read that apply mode has not read again yet. */
export function countReportedLinkSweepNotes(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM link_sweep_notes WHERE status = 'reported'`).get() as { n: number }).n;
}

/** How many reads or writes of each listed note have failed, for the notes that have a record. */
export function linkSweepNoteFailures(db: Database.Database, nodeIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const read = db.prepare('SELECT failures FROM link_sweep_notes WHERE node_id = ?');
  for (const id of new Set(nodeIds)) {
    const row = read.get(id) as { failures: number } | undefined;
    if (row) out.set(id, row.failures);
  }
  return out;
}

/** The status of each listed note that has one. */
export function linkSweepNoteStatuses(db: Database.Database, nodeIds: readonly string[]): Map<string, LinkSweepNoteStatus> {
  const out = new Map<string, LinkSweepNoteStatus>();
  const read = db.prepare('SELECT status FROM link_sweep_notes WHERE node_id = ?');
  for (const id of new Set(nodeIds)) {
    const row = read.get(id) as { status: LinkSweepNoteStatus } | undefined;
    if (row) out.set(id, row.status);
  }
  return out;
}

/** Record a note's outcome. `failed` counts a failed read, which moves it behind the others. */
export function markLinkSweepNote(
  db: Database.Database, nodeId: string, status: LinkSweepNoteStatus, proposals: number, now: string, failed = false,
): void {
  db.prepare(`INSERT INTO link_sweep_notes (node_id, status, proposals, failures, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET status = excluded.status, proposals = excluded.proposals,
      failures = link_sweep_notes.failures + excluded.failures, checked_at = excluded.checked_at`)
    .run(nodeId, status, proposals, failed ? 1 : 0, now);
}

/** Forget a note, e.g. one deleted while it waited. */
export function forgetLinkSweepNote(db: Database.Database, nodeId: string): void {
  db.prepare('DELETE FROM link_sweep_notes WHERE node_id = ?').run(nodeId);
}

/**
 * Migration 39 (#699): the names the link sweep has seen, and the notes to read again because a
 * name in them got a note after they were read. `link_sweep_names_seeded` marks the first run that
 * recorded the names, so a vault with none yet still counts its first ones as new.
 */
export function createLinkSweepNameTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE link_sweep_names (
      name_key   TEXT PRIMARY KEY,
      target_id  TEXT NOT NULL,
      seen_at    TEXT NOT NULL
    );
    CREATE TABLE link_sweep_names_seeded (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      seeded_at  TEXT NOT NULL
    );
    CREATE TABLE link_sweep_rechecks (
      node_id    TEXT PRIMARY KEY,
      -- The new name that queued the note, as written in its note's title or alias.
      name       TEXT NOT NULL,
      queued_at  TEXT NOT NULL
    );
    CREATE INDEX idx_link_sweep_rechecks_queued ON link_sweep_rechecks(queued_at);
  `);
}

/** Whether a run has recorded the names it found (#699). */
export function linkSweepNamesSeeded(db: Database.Database): boolean {
  return db.prepare('SELECT 1 FROM link_sweep_names_seeded WHERE id = 1').get() !== undefined;
}

/** Record every name as seen, without looking for it, and mark the names recorded. */
export function seedLinkSweepNames(db: Database.Database, names: ReadonlyArray<{ key: string; targetId: string }>, now: string): void {
  const insert = db.prepare('INSERT OR IGNORE INTO link_sweep_names (name_key, target_id, seen_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const name of names) insert.run(name.key, name.targetId, now);
    db.prepare('INSERT OR IGNORE INTO link_sweep_names_seeded (id, seeded_at) VALUES (1, ?)').run(now);
  })();
}

/** The keys of every name the sweep has seen. */
export function knownLinkSweepNames(db: Database.Database): Set<string> {
  return new Set((db.prepare('SELECT name_key FROM link_sweep_names').all() as Array<{ name_key: string }>).map(r => r.name_key));
}

/** Record one name as seen. */
export function recordLinkSweepName(db: Database.Database, key: string, targetId: string, now: string): void {
  db.prepare('INSERT OR IGNORE INTO link_sweep_names (name_key, target_id, seen_at) VALUES (?, ?, ?)').run(key, targetId, now);
}

/** Queue notes to be read again for `name`; a note already queued keeps its place. */
export function queueLinkSweepRechecks(db: Database.Database, nodeIds: readonly string[], name: string, now: string): number {
  const insert = db.prepare('INSERT OR IGNORE INTO link_sweep_rechecks (node_id, name, queued_at) VALUES (?, ?, ?)');
  let queued = 0;
  db.transaction(() => { for (const id of new Set(nodeIds)) queued += insert.run(id, name, now).changes; })();
  return queued;
}

/** Notes queued to be read again, longest waiting first. */
export function linkSweepRechecks(db: Database.Database, limit: number): string[] {
  return (db.prepare('SELECT node_id FROM link_sweep_rechecks ORDER BY queued_at, node_id LIMIT ?').all(limit) as Array<{ node_id: string }>)
    .map(r => r.node_id);
}

/** How many notes are queued to be read again. */
export function countLinkSweepRechecks(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM link_sweep_rechecks').get() as { n: number }).n;
}

/** Take a note off the queue: it was read again, failed and went to the pending queue, or is gone. */
export function dropLinkSweepRecheck(db: Database.Database, nodeId: string): void {
  db.prepare('DELETE FROM link_sweep_rechecks WHERE node_id = ?').run(nodeId);
}
