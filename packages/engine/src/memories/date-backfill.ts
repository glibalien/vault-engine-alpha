import type Database from 'better-sqlite3';
import { datedByNote, evidenceNoteDate, markChangedBy, recordMemoryHistory } from './service.js';

/**
 * Dates for memories written before they were dated by their notes (#706). `create-memory` now
 * dates a memory drawn from a dated note by that note (`noteDatedValidAt`); this gives every live
 * note memory written before the same date, by the same rule. Owner's scope (2026-11-20): all live
 * note memories, not only those of extraction runs and the nightly sweep, which has read older
 * notes since July.
 *
 * A memory whose `valid_at` equals its `created_at` was dated by its write, and takes its note's
 * day. A different `valid_at` is a consolidation verdict's: it is kept, unless it is a day later
 * than the note's, which the rule does not allow. The day is never later than when the memory was
 * written. Expired memories keep their dates.
 *
 * Each change is kept in `memory_history` (reason `dated-by-note`, the date it replaced) and
 * moves the memory's `updated_at`, as the consolidation replay's own date edits do: the memory
 * note shows `valid_at` as read-only, so a block rendered before must read as stale, not as an
 * edit. `undoMemoryDates` puts the old dates back on the memories nothing has changed since.
 */

/** The reason on the history row of each date this backfill changes; its undo looks for it. */
export const DATED_BY_NOTE = 'dated-by-note';
/** The reason on the history row of each date its undo puts back. */
export const DATED_BY_NOTE_UNDONE = 'dated-by-note-undone';

export interface DateBackfillResult {
  dry_run: boolean;
  /** Live memories drawn from a note. */
  note_memories: number;
  /** Of those, memories whose note has no readable date (or is gone): left as they are. */
  undated_notes: number;
  /** Memories whose date changes, or would in a preview. */
  redated: number;
  /** Of those, a verdict's date later than the note's day, brought back to the note's day. */
  capped: number;
  samples: Array<{
    memory_id: number;
    content: string;
    note_title: string | null;
    note_date: string;
    valid_at_before: string | null;
    valid_at_after: string;
  }>;
}

export interface DateUndoResult {
  dry_run: boolean;
  /** Memories given back the date they had before the backfill. */
  restored: number;
  /** Memories changed since the backfill dated them (edited, retired, re-dated): left as they are. */
  changed_since: number;
  /** Memories whose backfill date was already undone. */
  already_undone: number;
}

interface NoteMemoryRow {
  id: number;
  content: string;
  created_at: string;
  valid_at: string | null;
  evidence_node_id: string;
}

export function backfillMemoryDates(
  db: Database.Database,
  opts: { dryRun: boolean; samples?: number; /** The chat client running it, marked on each memory it changes (#532). */ changedBy?: string | undefined },
): DateBackfillResult {
  const rows = db.prepare(
    `SELECT id, content, created_at, valid_at, evidence_node_id FROM memories
      WHERE expired_at IS NULL AND evidence_kind = 'note' AND evidence_node_id IS NOT NULL ORDER BY id`,
  ).all() as NoteMemoryRow[];
  const days = new Map<string, string | null>();
  const dayOf = (nodeId: string): string | null => {
    if (!days.has(nodeId)) days.set(nodeId, evidenceNoteDate(db, nodeId));
    return days.get(nodeId)!;
  };
  const titleOf = db.prepare<[string], { title: string | null }>('SELECT title FROM nodes WHERE id = ?');

  const wanted = opts.samples ?? 10;
  const samples: DateBackfillResult['samples'] = [];
  const plans: Array<{ id: number; before: string | null; after: string }> = [];
  let undated = 0;
  let capped = 0;
  for (const row of rows) {
    const day = dayOf(row.evidence_node_id);
    if (day === null) { undated++; continue; }
    // A date that is not the write's own is a verdict's.
    const verdict = row.valid_at !== null && row.valid_at !== row.created_at ? row.valid_at : undefined;
    const after = datedByNote(day, verdict, row.created_at);
    if (after === row.valid_at) continue;
    if (verdict !== undefined) capped++;
    plans.push({ id: row.id, before: row.valid_at, after });
    if (samples.length < wanted) {
      const content = row.content.length > 200 ? `${row.content.slice(0, 199)}…` : row.content;
      samples.push({
        memory_id: row.id, content, note_title: titleOf.get(row.evidence_node_id)?.title ?? null,
        note_date: day, valid_at_before: row.valid_at, valid_at_after: after,
      });
    }
  }

  if (!opts.dryRun && plans.length > 0) {
    const now = new Date().toISOString();
    const update = db.prepare('UPDATE memories SET valid_at = ?, updated_at = ? WHERE id = ? AND expired_at IS NULL');
    db.transaction(() => {
      for (const plan of plans) {
        if (update.run(plan.after, now, plan.id).changes === 0) continue;
        recordMemoryHistory(db, plan.id, 'edited', DATED_BY_NOTE, { valid_at: plan.before }, now);
        if (opts.changedBy !== undefined) markChangedBy(db, plan.id, opts.changedBy);
      }
    })();
  }
  return { dry_run: opts.dryRun, note_memories: rows.length, undated_notes: undated, redated: plans.length, capped, samples };
}

/**
 * Put back the dates the backfill replaced, on each memory whose latest change is the backfill's:
 * its newest history row is the backfill's and its `updated_at` is still that row's time. A memory
 * edited, retired or re-dated since is left as it is.
 */
export function undoMemoryDates(
  db: Database.Database,
  opts: { dryRun: boolean; changedBy?: string | undefined },
): DateUndoResult {
  const rows = db.prepare(
    `SELECT h.memory_id, h.changed_at, h.reason, h.previous_json, m.updated_at
       FROM memory_history h JOIN memories m ON m.id = h.memory_id
      WHERE h.id = (SELECT max(h2.id) FROM memory_history h2 WHERE h2.memory_id = h.memory_id)
        AND h.memory_id IN (SELECT memory_id FROM memory_history WHERE reason = ?)
      ORDER BY h.memory_id`,
  ).all(DATED_BY_NOTE) as Array<{ memory_id: number; changed_at: string; reason: string | null; previous_json: string; updated_at: string }>;

  const plans: Array<{ id: number; previous: string | null }> = [];
  let changedSince = 0;
  let alreadyUndone = 0;
  for (const row of rows) {
    if (row.reason === DATED_BY_NOTE_UNDONE) { alreadyUndone++; continue; }
    if (row.reason !== DATED_BY_NOTE || row.updated_at !== row.changed_at) { changedSince++; continue; }
    const previous = (JSON.parse(row.previous_json) as { valid_at?: string | null }).valid_at ?? null;
    plans.push({ id: row.memory_id, previous });
  }

  if (!opts.dryRun && plans.length > 0) {
    const now = new Date().toISOString();
    const current = db.prepare<[number], { valid_at: string | null }>('SELECT valid_at FROM memories WHERE id = ?');
    const update = db.prepare('UPDATE memories SET valid_at = ?, updated_at = ? WHERE id = ?');
    db.transaction(() => {
      for (const plan of plans) {
        const before = current.get(plan.id)?.valid_at ?? null;
        update.run(plan.previous, now, plan.id);
        recordMemoryHistory(db, plan.id, 'edited', DATED_BY_NOTE_UNDONE, { valid_at: before }, now);
        if (opts.changedBy !== undefined) markChangedBy(db, plan.id, opts.changedBy);
      }
    })();
  }
  return { dry_run: opts.dryRun, restored: plans.length, changed_since: changedSince, already_undone: alreadyUndone };
}
