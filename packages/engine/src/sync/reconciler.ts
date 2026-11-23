import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { collectNewPathHashes, pairRenames, type MissingNode } from './rename-pairing.js';
import { shouldIgnore } from '../indexer/ignore.js';
import { executeDeletion } from '../pipeline/delete.js';
import { processFileChange } from './watcher.js';
import type { IndexMutex } from './mutex.js';
import { WriteLockManager } from './write-lock.js';
import type { SyncLogger } from './sync-logger.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import type { TranscriptStore } from '../extraction/transcript-store.js';

export interface ReconcilerOptions {
  initialDelayMs?: number;
  intervalMs?: number;
}

export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock?: WriteLockManager,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  options?: ReconcilerOptions,
  transcriptStore?: TranscriptStore,
): { stop: () => void } {
  const initialDelayMs = options?.initialDelayMs ?? 2 * 60 * 1000;
  const intervalMs = options?.intervalMs ?? 15 * 60 * 1000;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function sweep(): void {
    mutex.run(async () => {
      const stats = { indexed: 0, skipped: 0, deleted: 0, renamed: 0, errors: 0, transcripts_undeleted: 0 };

      // Walk vault and collect files
      const diskFiles = new Set<string>();
      walkDir(vaultPath, vaultPath, diskFiles);

      // Detect deletions — but first pair missing nodes with brand-new disk
      // paths by content hash: a rename the watcher missed must keep its node
      // id (board links, card-spec filters, and incoming edges are keyed on
      // it), not be deleted and re-created.
      const dbNodes = db.prepare('SELECT id, file_path, content_hash FROM nodes').all() as MissingNode[];
      const dbPaths = new Set(dbNodes.map(n => n.file_path));
      const missing = dbNodes.filter(n => !diskFiles.has(n.file_path));

      const renamedByPath = missing.length > 0 && writeLock
        ? pairRenames(missing, collectNewPathHashes(vaultPath, diskFiles, dbPaths))
        : new Map<string, MissingNode>();
      const renamedNodeIds = new Set([...renamedByPath.values()].map(n => n.id));

      for (const node of missing) {
        if (renamedNodeIds.has(node.id)) continue;
        executeDeletion(db, writeLock ?? new WriteLockManager(), vaultPath, {
          source: 'reconciler',
          node_id: node.id,
          file_path: node.file_path,
          unlink_file: false,
        });
        embeddingIndexer?.removeNode(node.id);
        stats.deleted++;
      }

      // Apply renames in place through the pipeline (node id preserved). If
      // the file changed between pairing and here, the matcher's hash check
      // fails and the file indexes as a new node; the still-missing old node
      // is deleted on the next sweep.
      for (const [toPath, node] of renamedByPath) {
        try {
          processFileChange(join(vaultPath, toPath), toPath, db, writeLock!, vaultPath, syncLogger, embeddingIndexer, {
            matchRename: (hash) =>
              hash === node.content_hash ? { node_id: node.id, from_path: node.file_path } : null,
            renameSource: 'reconciler',
          });
          stats.renamed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reconciler] rename apply failed for ${toPath}: ${msg}`);
          logReconcilerError(db, node.id, { step: 'rename', file_path: toPath, error: msg });
          stats.errors++;
        }
      }

      // Process changed files
      for (const relPath of diskFiles) {
        try {
          const absPath = join(vaultPath, relPath);
          const st = statSync(absPath);
          const mtime = Math.floor(st.mtimeMs);

          const existing = db.prepare('SELECT content_hash, file_mtime FROM nodes WHERE file_path = ?')
            .get(relPath) as { content_hash: string; file_mtime: number } | undefined;

          // Skip unchanged files
          if (existing && existing.file_mtime === mtime) {
            stats.skipped++;
            continue;
          }

          // Hash check
          const content = readFileSync(absPath, 'utf-8');
          const hash = sha256(content);
          if (existing && existing.content_hash === hash) {
            db.prepare('UPDATE nodes SET file_mtime = ? WHERE file_path = ?').run(mtime, relPath);
            stats.skipped++;
            continue;
          }

          // Process through pipeline if writeLock available, else skip
          if (writeLock) {
            processFileChange(absPath, relPath, db, writeLock, vaultPath, syncLogger);
          }
          stats.indexed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reconciler] sweep error for ${relPath}: ${msg}`);
          logReconcilerError(db, null, { step: 'sweep', file_path: relPath, error: msg });
          stats.errors++;
        }
      }

      // Reconcile retained-transcript source_deleted flags against disk. The
      // watcher SETS the flag on file removal but nothing CLEARS it when a file
      // reappears (capture() only runs on note re-enqueue). walkDirAllFiles
      // excludes dotfolder paths, so .vault-engine/archive/ paths are never
      // present -> genuinely archived rows stay flagged while files back in the
      // vault get un-flagged. Clear-only, presence-based (no re-extraction);
      // case-folded so a folder case-flip self-heals.
      if (transcriptStore) {
        try {
          const allDiskFilesLower = new Set<string>();
          walkDirAllFiles(vaultPath, vaultPath, allDiskFilesLower);
          for (const vp of transcriptStore.listSourceDeletedPaths()) {
            if (allDiskFilesLower.has(vp.toLowerCase())) {
              stats.transcripts_undeleted += transcriptStore.clearSourceDeleted(vp);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reconciler] transcript reconciliation failed: ${msg}`);
          logReconcilerError(db, null, { step: 'transcript-reconcile', error: msg });
        }
      }

      const logStmt = db.prepare(
        'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
      );
      logStmt.run(null, Date.now(), 'reconciler-sweep', JSON.stringify(stats));
    });
  }

  const initialHandle = setTimeout(() => {
    sweep();
    intervalHandle = setInterval(sweep, intervalMs);
  }, initialDelayMs);

  return {
    stop: () => {
      clearTimeout(initialHandle);
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
      }
    },
  };
}

/**
 * One `reconciler-error` row. Its details are a JSON object, as every other
 * edits_log writer's are; before #512 they were the text `<path>: <message>`.
 */
function logReconcilerError(
  db: Database.Database,
  nodeId: string | null,
  details: { step: 'rename' | 'sweep' | 'transcript-reconcile'; file_path?: string; error: string },
): void {
  db.prepare(
    'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
  ).run(nodeId, Date.now(), 'reconciler-error', JSON.stringify(details));
}

function walkDir(dir: string, vaultPath: string, results: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reconciler] walkDir failed for ${dir}: ${msg}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walkDir(join(dir, entry.name), vaultPath, results);
    } else if (entry.isFile()) {
      const absPath = join(dir, entry.name);
      const relPath = relative(vaultPath, absPath);
      if (!shouldIgnore(relPath)) results.add(relPath);
    }
  }
}

/**
 * Walk the vault collecting all non-ignored paths (markdown AND non-markdown),
 * lowercased, into `results`. Used by the transcript reconciliation pass so that
 * attachment files (.m4a, .pdf, etc.) are visible for presence checks.
 * Dotfolders are skipped at the directory level, mirroring walkDir behaviour, so
 * .vault-engine/archive/ paths are never included.
 */
function walkDirAllFiles(dir: string, vaultPath: string, results: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reconciler] walkDirAllFiles failed for ${dir}: ${msg}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walkDirAllFiles(join(dir, entry.name), vaultPath, results);
    } else if (entry.isFile()) {
      const absPath = join(dir, entry.name);
      const relPath = relative(vaultPath, absPath);
      // Reuse shouldIgnore with allowNonMarkdown so custom excluded dirs
      // (VAULT_EXCLUDE_DIRS) and dotfolder segment rules still apply.
      if (!shouldIgnore(relPath, { allowNonMarkdown: true })) {
        results.add(relPath.toLowerCase());
      }
    }
  }
}
