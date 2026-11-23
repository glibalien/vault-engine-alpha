// src/db/search-version.ts
//
// Tracks the embedding pipeline version so the engine can detect when an
// upgrade requires a full clear + re-embed. Bump CURRENT_SEARCH_VERSION
// whenever a change makes existing stored vectors semantically wrong.

import type Database from 'better-sqlite3';

/**
 * v1: full-content embeddings, truncated by tokenizer at 8192 tokens.
 * v2: chunked embeddings + extraction embeddings.
 * v3: context-rich chunk embeddings (semantic-context-v3 hash: parent
 *     identity, human-readable frontmatter, links, and heading trails).
 *     v2→v3 is a ROLLING upgrade — see planSearchUpgrade below.
 */
export const CURRENT_SEARCH_VERSION = 3;

export type SearchUpgradeMode = 'none' | 'rolling' | 'clear';

/**
 * Decide how to handle a stored→current version gap at startup.
 *
 * - 'rolling' (v2→v3): keep existing vectors searchable. Every group is
 *   enqueued; the versioned source hash differs for all v2 rows, so each
 *   group's transaction atomically swaps old vectors for contextualized ones.
 *   The stored version is only persisted after the initial drain finishes
 *   with zero terminal failures (a crash simply re-enqueues on restart;
 *   already-updated groups hash-skip).
 * - 'clear' (v1→v3): pre-chunking vectors are structurally incompatible —
 *   full clear + rebuild, version persisted immediately (legacy behavior).
 */
export function planSearchUpgrade(storedVersion: number, currentVersion: number = CURRENT_SEARCH_VERSION): SearchUpgradeMode {
  if (storedVersion >= currentVersion) return 'none';
  return storedVersion >= 2 ? 'rolling' : 'clear';
}

const KEY = 'search_version';

export function getSearchVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (!row) return 1;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 1;
}

export function setSearchVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KEY, String(version));
}
