import type Database from 'better-sqlite3';
import { STAGE_CHECKPOINT_MAX_AGE_MS, parseStageCheckpoint, type StageCheckpoint, type StageCheckpointPage,
  type StageCheckpointStore } from '../stage-checkpoints.js';
import type { PlanningResult } from '../reconciliation-planning.js';

/** DDL for migration 28. One row per wiki root title, for project and topic wikis alike. */
export function createStageCheckpointsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE wiki_stage_checkpoints (
      root_title    TEXT PRIMARY KEY,
      fingerprint   TEXT NOT NULL,
      planning_json TEXT NOT NULL,
      pages_json    TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL
    );
  `);
}

/** The root's checkpoint when it matches `fingerprint` and is younger than the max age; any other row is removed. */
export function readStageCheckpoint(db: Database.Database, rootTitle: string, fingerprint: string,
  now: Date = new Date()): StageCheckpoint | null {
  const row = db.prepare('SELECT fingerprint, planning_json, pages_json, created_at FROM wiki_stage_checkpoints WHERE root_title = ?')
    .get(rootTitle) as { fingerprint: string; planning_json: string; pages_json: string; created_at: string } | undefined;
  if (!row) return null;
  const age = now.getTime() - Date.parse(row.created_at);
  const checkpoint = row.fingerprint === fingerprint && age >= 0 && age < STAGE_CHECKPOINT_MAX_AGE_MS
    ? parseStageCheckpoint(row.planning_json, row.pages_json, row.created_at) : null;
  if (!checkpoint) deleteStageCheckpoint(db, rootTitle);
  return checkpoint;
}

/** Starts the root's checkpoint at `fingerprint` with a completed planning stage, replacing any earlier one. */
export function writeStagePlanning(db: Database.Database, rootTitle: string, fingerprint: string, planning: PlanningResult,
  now: Date = new Date()): void {
  db.prepare(`
    INSERT INTO wiki_stage_checkpoints (root_title, fingerprint, planning_json, pages_json, created_at) VALUES (?, ?, ?, '[]', ?)
    ON CONFLICT(root_title) DO UPDATE SET fingerprint = excluded.fingerprint, planning_json = excluded.planning_json,
      pages_json = '[]', created_at = excluded.created_at
  `).run(rootTitle, fingerprint, JSON.stringify(planning), now.toISOString());
}

/** Adds a completed page to the root's checkpoint at `fingerprint`; false when no such checkpoint exists. */
export function appendStagePage(db: Database.Database, rootTitle: string, fingerprint: string, page: StageCheckpointPage): boolean {
  const append = db.transaction(() => {
    const row = db.prepare('SELECT pages_json FROM wiki_stage_checkpoints WHERE root_title = ? AND fingerprint = ?')
      .get(rootTitle, fingerprint) as { pages_json: string } | undefined;
    if (!row) return false;
    const pages = JSON.parse(row.pages_json) as StageCheckpointPage[];
    db.prepare('UPDATE wiki_stage_checkpoints SET pages_json = ? WHERE root_title = ?')
      .run(JSON.stringify([...pages, page]), rootTitle);
    return true;
  });
  return append();
}

export function deleteStageCheckpoint(db: Database.Database, rootTitle: string): void {
  db.prepare('DELETE FROM wiki_stage_checkpoints WHERE root_title = ?').run(rootTitle);
}

/** A best-effort store for one root: a checkpoint failure only costs reuse, never the run. */
export function stageCheckpointStore(db: Database.Database, rootTitle: string,
  warn: (message: string, error: unknown) => void, now: () => Date = () => new Date()): StageCheckpointStore {
  const attempt = <T>(what: string, fallback: T, run: () => T): T => {
    try { return run(); } catch (error) { warn(`stage checkpoint ${what} failed for ${rootTitle}`, error); return fallback; }
  };
  return {
    load: fingerprint => attempt('read', null, () => readStageCheckpoint(db, rootTitle, fingerprint, now())),
    savePlanning: (fingerprint, planning) => attempt('write', false, () => {
      writeStagePlanning(db, rootTitle, fingerprint, planning, now());
      return true;
    }),
    savePage: (fingerprint, page) => attempt('write', false, () => appendStagePage(db, rootTitle, fingerprint, page)),
    clear: () => attempt('delete', undefined, () => deleteStageCheckpoint(db, rootTitle)),
  };
}
