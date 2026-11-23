import { readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { getMeta, setMeta } from '../db/meta.js';
import { explicitNullKeys, replaceExplicitNullFields } from '../fields/explicit-null.js';
import { sha256 } from '../indexer/hash.js';
import { parseFrontmatter } from '../parser/frontmatter.js';
import { safeVaultPath } from '../pipeline/safe-path.js';

export const EXPLICIT_NULL_BACKFILL_META_KEY = 'explicit_null_fields_backfill_v1';

export interface ExplicitNullBackfillWatcher {
  suspendDelivery(): void;
  waitUntilReady?(): Promise<void>;
  enqueueScanDetectedUnlink(relPath: string): void;
  completeSuspendedHandoff(markComplete: () => void): Promise<void>;
  abortSuspendedDelivery(): Promise<void>;
}

export interface ExplicitNullBackfillDeps {
  db: Database.Database;
  vaultPath: string;
  watcher: ExplicitNullBackfillWatcher;
  ingestThroughWatcher(filePath: string): Promise<void> | void;
  /**
   * Test seam: overrides the filesystem read of an already safe-path-resolved
   * absolute path. Defaults to `node:fs/promises` readFile. Production leaves it
   * unset, so the default read path is unchanged.
   */
  readFile?(absolutePath: string): Promise<string>;
}

export interface ExplicitNullBackfillStats {
  scanned: number;
  reingested: number;
  markers: number;
}

const ZERO_STATS: ExplicitNullBackfillStats = {
  scanned: 0,
  reingested: 0,
  markers: 0,
};

/**
 * Populate explicit-null presence for databases created before the marker
 * table was filled by watcher mutations. Hash mismatches and events accepted
 * during the scan stay on the normal watcher DB-ingest path.
 */
export async function backfillExplicitNullFields(
  deps: ExplicitNullBackfillDeps,
): Promise<ExplicitNullBackfillStats> {
  if (getMeta(deps.db, EXPLICIT_NULL_BACKFILL_META_KEY) === 'complete') {
    return { ...ZERO_STATS };
  }

  deps.watcher.suspendDelivery();
  let completed = false;
  const stats: ExplicitNullBackfillStats = { ...ZERO_STATS };
  const readContent =
    deps.readFile ?? ((absolutePath: string) => readFile(absolutePath, 'utf-8'));

  try {
    await deps.watcher.waitUntilReady?.();
    const nodes = deps.db.prepare(`
      SELECT id, file_path, content_hash
      FROM nodes
      ORDER BY file_path
    `).all() as Array<{ id: string; file_path: string; content_hash: string }>;

    for (const node of nodes) {
      stats.scanned++;
      const filePath = safeVaultPath(deps.vaultPath, node.file_path);
      let content: string;
      try {
        content = await readContent(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A file removed after the DB snapshot is the unlink side of an
        // ordinary watcher race. Queue it into the same suspended handoff so
        // rename grace, identity matching, deletion, and final quiescence all
        // remain owned by one protocol.
        deps.watcher.enqueueScanDetectedUnlink(node.file_path);
        stats.reingested++;
        continue;
      }

      if (sha256(content) !== node.content_hash) {
        await deps.ingestThroughWatcher(node.file_path);
        stats.reingested++;
        continue;
      }

      const parsed = parseFrontmatter(content);
      if (parsed.parseError !== null) {
        // Frontmatter that does not parse has no fields to mark, and the watcher
        // keeps such a note's stored state the same way. Fixing the note changes
        // its hash, so normal ingest records its markers then. Stopping here
        // instead kept Engine from starting on any vault with one broken note.
        console.warn(
          `[explicit-null backfill] skipped ${node.file_path}: its frontmatter does not parse (${parsed.parseError.split('\n')[0]})`,
        );
        continue;
      }
      const markers = explicitNullKeys(parsed.fields);
      deps.db.transaction(() => {
        replaceExplicitNullFields(deps.db, node.id, markers);
      })();
      stats.markers += markers.length;
    }

    await deps.watcher.completeSuspendedHandoff(() => {
      setMeta(deps.db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });
    completed = true;
    return stats;
  } finally {
    if (!completed) await deps.watcher.abortSuspendedDelivery();
  }
}
