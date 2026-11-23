// src/wiki/status-versions.ts
//
// Versions of a wiki home that only a status write produced (#547), or the status check's one-time
// restamp of its evidence by the current formula (#332). The Engine writes `behind`
// to a home in the background, and the Curator writes paused, resumed and building, so a page
// request or a home refresh that read the home before such a write would otherwise fail its
// version check after its model calls. A reconcile rebuilds the home from what is stored when it
// writes, so a status write it did not see is kept: nothing is lost by letting it through.

import type Database from 'better-sqlite3';

/** Record that `toVersion` of the home came from `fromVersion` by a write that changed only its `wiki_status`. */
export function recordStatusOnlyWrite(db: Database.Database, nodeId: string, fromVersion: number, toVersion: number): void {
  db.prepare(`
    INSERT INTO wiki_status_versions (node_id, base_version, last_version) VALUES (@node_id, @from, @to)
    ON CONFLICT(node_id) DO UPDATE SET
      base_version = CASE WHEN wiki_status_versions.last_version = @from THEN wiki_status_versions.base_version ELSE @from END,
      last_version = @to
  `).run({ node_id: nodeId, from: fromVersion, to: toVersion });
}

/**
 * Whether a reader that saw the home at `expected` still sees it as it is at `current`: the same
 * version, or one that only status writes have moved on since.
 */
export function sameButForStatus(db: Database.Database, nodeId: string, expected: number, current: number): boolean {
  if (expected === current) return true;
  if (expected > current) return false;
  const row = db.prepare('SELECT base_version, last_version FROM wiki_status_versions WHERE node_id = ?').get(nodeId) as
    | { base_version: number; last_version: number }
    | undefined;
  return row !== undefined && row.last_version === current && row.base_version <= expected;
}

/**
 * The home's version as a reader comparing versions should see it: the version before any status
 * writes that followed it, else its current version. A home refresh's guard carries it, so a
 * preview stays good across the Engine's `behind` write while any other edit still voids it.
 */
export function contentVersion(db: Database.Database, nodeId: string, current: number): number {
  const row = db.prepare('SELECT base_version, last_version FROM wiki_status_versions WHERE node_id = ?').get(nodeId) as
    | { base_version: number; last_version: number }
    | undefined;
  return row !== undefined && row.last_version === current ? row.base_version : current;
}
