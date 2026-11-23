import type Database from 'better-sqlite3';

export type JournalTrigger = 'scheduled' | 'on-demand' | 'cli';

export type JournalFunction =
  | 'wiki-curation' | 'topic-curation' | 'requested-page'
  | 'org-sweep' | 'memory-sweep' | 'conversation-sweep' | 'reconcile' | 'staleness-nudge' | 'link-sweep'
  | 'conversation-capture'
  | 'memory-note-refresh'
  | 'field-guess-sweep'
  | 'wiki-field'
  | 'entity-dossier'
  | 'spine-migration' | 'unknown';

/** One recorded curator action or per-function run summary. `detail` is the
 *  human-readable line for actions; JSON `{line, stats}` for summaries. */
export interface JournalEventInsert {
  ts: string;
  run_ref: string | null;
  trigger: JournalTrigger | null;
  function: JournalFunction;
  kind: 'action' | 'summary';
  action: string | null;
  node_id: string | null;
  target: string | null;
  detail: string;
  dry_run: number;
}

export interface JournalEventRow extends JournalEventInsert {
  id: number;
  /** null until the event has been included in a journal entry (the pickup cursor). */
  journaled_at: string | null;
}

/** DDL for the journal-events table. Called by migration #7, not on every boot. */
export function createJournalTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL,
      run_ref      TEXT,
      "trigger"    TEXT,
      "function"   TEXT    NOT NULL,
      kind         TEXT    NOT NULL,
      action       TEXT,
      node_id      TEXT,
      target       TEXT,
      detail       TEXT    NOT NULL,
      dry_run      INTEGER NOT NULL,
      journaled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_unjournaled ON journal_events(journaled_at);
    CREATE INDEX IF NOT EXISTS idx_journal_run_ref ON journal_events(run_ref);
    CREATE INDEX IF NOT EXISTS idx_journal_ts ON journal_events(ts);
  `);
}

export function insertJournalEvent(db: Database.Database, e: JournalEventInsert): void {
  db.prepare(`
    INSERT INTO journal_events (ts, run_ref, "trigger", "function", kind, action, node_id, target, detail, dry_run)
    VALUES (@ts, @run_ref, @trigger, @function, @kind, @action, @node_id, @target, @detail, @dry_run)
  `).run(e);
}

/** Everything not yet journaled, oldest first. Dry-run events are never journaled. */
export function unjournaledEvents(db: Database.Database): JournalEventRow[] {
  return db.prepare(
    'SELECT * FROM journal_events WHERE journaled_at IS NULL AND dry_run = 0 ORDER BY id',
  ).all() as JournalEventRow[];
}

/** The unjournaled events of specific runs (an on-demand entry's scope). */
export function eventsForRunRefs(db: Database.Database, refs: string[]): JournalEventRow[] {
  if (refs.length === 0) return [];
  const marks = refs.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM journal_events
     WHERE journaled_at IS NULL AND dry_run = 0 AND run_ref IN (${marks}) ORDER BY id`,
  ).all(...refs) as JournalEventRow[];
}

/** Mark events as included in a written journal entry. Called ONLY after the
 *  vault append succeeded — a failed write leaves them to roll into the next entry. */
export function stampJournaled(db: Database.Database, ids: number[], ts: string): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  db.prepare(`UPDATE journal_events SET journaled_at = ? WHERE id IN (${marks})`).run(ts, ...ids);
}
