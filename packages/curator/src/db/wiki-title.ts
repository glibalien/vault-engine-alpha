import type Database from 'better-sqlite3';
import { getWikiRoot } from './wiki-roots.js';

export type WikiTitleMove = 'moved' | 'missing' | 'title-in-use';

/** Title-keyed tables holding at most one row per wiki. */
const SINGLE_ROW_STATE = [
  ['wiki_control', 'project_title'],
  ['wiki_evidence_manifests', 'project'],
  ['wiki_deferred_creates', 'root_title'],
] as const;

/**
 * Moves a registered wiki and its title-keyed state from `from` to `to` in one transaction:
 * the registration, pause flag, corrections, page requests, evidence manifest and deferred
 * creates. Single-row state already under `to` is kept, since it was set more recently. Stage
 * checkpoints are dropped (their fingerprint names the old title). Run history stays as recorded.
 */
export function moveWikiTitle(db: Database.Database, from: string, to: string): WikiTitleMove {
  return db.transaction((): WikiTitleMove => {
    if (!getWikiRoot(db, from)) return 'missing';
    if (getWikiRoot(db, to)) return 'title-in-use';
    db.prepare('UPDATE wiki_roots SET root_title = ? WHERE root_title = ?').run(to, from);
    for (const [table, column] of SINGLE_ROW_STATE) {
      db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from);
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(from);
    }
    db.prepare('UPDATE wiki_corrections SET project_title = ? WHERE project_title = ?').run(to, from);
    db.prepare('UPDATE page_requests SET project_title = ? WHERE project_title = ?').run(to, from);
    db.prepare('DELETE FROM wiki_stage_checkpoints WHERE root_title = ?').run(from);
    return 'moved';
  })();
}
