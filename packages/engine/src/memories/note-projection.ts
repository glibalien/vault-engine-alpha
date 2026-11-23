import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { assertToolMutationFilePresent, executeMutation } from '../pipeline/execute.js';
import { readFileOrNull } from '../pipeline/file-writer.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import { MemoryService } from './service.js';
import type { MemoryNoteIngest } from './note-ingest.js';
import {
  renderMemoryNote,
  memoryNotePath,
  type MemoryNoteIssue,
  type RenderedMemoryNote,
} from './note-format.js';

/**
 * Render and write the canonical `Settings/Memories.md` projection through
 * `executeMutation` (Task 6 of the durable-memory markdown-projection plan).
 *
 * `preview()` renders/counts/hashes without DB/file/undo/sync-log mutation.
 * `refresh()` renders and writes through the mutation pipeline, then sets
 * `meta.memory_note.last_refresh_at`. A byte-identical refresh returns
 * `file_written: false` (executeMutation's no-op rule).
 *
 * Both first `drain()` the ingest so pending edits land before rendering.
 * No ordinary memory mutation writes the note — only this explicit refresh
 * (or the production scheduled daily sweep via the curator, Task 9).
 */

const META_LAST_REFRESH = 'memory_note.last_refresh_at';

export interface MemoryNoteProjectionDeps {
  db: Database.Database;
  writeLock: WriteLockManager;
  vaultPath: string;
  settingsDir: string;
  service: MemoryService;
  ingest: MemoryNoteIngest;
  syncLogger?: SyncLogger;
  embeddingIndexer?: EmbeddingIndexer;
}

export interface MemoryNoteRefreshPreview {
  file_path: string;
  node_id: string | null;
  live_count: number;
  historical_count: number;
  total: number;
  rendered_hash: string;
  bytes: number;
  would_write: boolean;
  issues_rendered: number;
  snapshot_at: string;
}

export interface MemoryNoteRefreshResult extends MemoryNoteRefreshPreview {
  file_written: boolean;
}

export class MemoryNoteProjection {
  private readonly deps: MemoryNoteProjectionDeps;
  private readonly notePath: string;

  constructor(deps: MemoryNoteProjectionDeps) {
    this.deps = deps;
    this.notePath = memoryNotePath(deps.settingsDir);
  }

  /**
   * Render and count with read-only DB/filesystem preflight, without writing
   * the projection, undo log, or sync log. Used by the dry-run
   * `refresh-memory-note` tool.
   */
  async preview(): Promise<MemoryNoteRefreshPreview> {
    await this.deps.ingest.drain();
    const issues = this.collectIssues();
    const snapshot = this.deps.service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, issues, this.snapshotAtFallback());
    const { existing: nodeRow } = this.readWritePreconditions();
    const wouldWrite = nodeRow ? rendered.content_hash !== nodeRow.content_hash : true;
    return {
      file_path: this.notePath,
      node_id: nodeRow?.id ?? null,
      live_count: rendered.live_count,
      historical_count: rendered.historical_count,
      total: rendered.live_count + rendered.historical_count,
      rendered_hash: rendered.hash,
      bytes: rendered.bytes.length,
      would_write: wouldWrite,
      issues_rendered: issues.length,
      snapshot_at: rendered.snapshot_at,
    };
  }

  /**
   * Render and write through `executeMutation`. After a successful/non-noop
   * refresh, sets `meta.memory_note.last_refresh_at`. Dry-run/failure never
   * advances it.
   */
  async refresh(): Promise<MemoryNoteRefreshResult> {
    await this.deps.ingest.drain();
    const issues = this.collectIssues();
    const snapshot = this.deps.service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, issues, this.snapshotAtFallback());

    const { existing, diskHash } = this.readWritePreconditions();

    if (existing) {
      // The executeMutation no-op rule already handles the case where
      // rendered hash == DB content_hash (byte-identical → no write, no
      // version bump). The expectedContentHash CAS below ensures we don't
      // overwrite a file that changed on disk since the watcher last indexed it.
      const result = executeMutation(this.deps.db, this.deps.writeLock, this.deps.vaultPath, {
        source: 'tool',
        node_id: existing.id,
        file_path: this.notePath,
        title: 'Memories',
        types: [],
        fields: rendered.fields,
        body: rendered.body,
        // The projection's bytes are the render; ingest parses them back.
        canonicalizeLinks: false,
        expectedContentHash: existing.content_hash,
        expectedVersion: existing.version,
        expectedDiskContentHash: diskHash,
      }, this.deps.syncLogger);

      const fileWritten = 'file_written' in result ? (result.file_written as boolean) : true;

      if (fileWritten) {
        this.setLastRefresh();
        // Enqueue search indexing after the write.
        this.deps.embeddingIndexer?.enqueue({ node_id: existing.id, source_type: 'node' });
      }

      return {
        file_path: this.notePath,
        node_id: existing.id,
        live_count: rendered.live_count,
        historical_count: rendered.historical_count,
        total: rendered.live_count + rendered.historical_count,
        rendered_hash: rendered.hash,
        bytes: rendered.bytes.length,
        would_write: fileWritten,
        file_written: fileWritten,
        issues_rendered: issues.length,
        snapshot_at: rendered.snapshot_at,
      };
    }

    // Missing note: create it at the configured path.
    const result = executeMutation(this.deps.db, this.deps.writeLock, this.deps.vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: this.notePath,
      title: 'Memories',
      types: [],
      fields: rendered.fields,
      body: rendered.body,
      canonicalizeLinks: false,
    }, this.deps.syncLogger);

    const nodeId = 'node_id' in result ? (result.node_id as string | null) : null;
    const fileWritten = 'file_written' in result ? (result.file_written as boolean) : true;

    if (fileWritten && nodeId) {
      this.setLastRefresh();
      this.deps.embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
    }

    return {
      file_path: this.notePath,
      node_id: nodeId,
      live_count: rendered.live_count,
      historical_count: rendered.historical_count,
      total: rendered.live_count + rendered.historical_count,
      rendered_hash: rendered.hash,
      bytes: rendered.bytes.length,
      would_write: false,
      file_written: fileWritten,
      issues_rendered: issues.length,
      snapshot_at: rendered.snapshot_at,
    };
  }

  /** Shared read-only preflight; live execution retains its final CAS checks. */
  private readWritePreconditions(): {
    existing: { id: string; content_hash: string; version: number } | undefined;
    diskHash: string | null;
  } {
    const existing = this.deps.db.prepare('SELECT id, content_hash, version FROM nodes WHERE file_path = ?').get(this.notePath) as
      | { id: string; content_hash: string; version: number }
      | undefined;
    // Creation keeps the live path's existing policy; only indexed notes
    // require a present projection whose bytes agree with the database.
    if (existing === undefined) return { existing, diskHash: null };
    const diskContent = readFileOrNull(safeVaultPath(this.deps.vaultPath, this.notePath));
    const diskHash = diskContent === null ? null : createHash('sha256').update(diskContent).digest('hex');
    if (diskHash !== existing.content_hash && diskHash !== null) {
      throw new Error(`content_hash conflict: disk ${diskHash} differs from indexed ${existing.content_hash}`);
    }
    assertToolMutationFilePresent(this.deps.db, this.deps.vaultPath, {
      source: 'tool', node_id: existing.id, file_path: this.notePath,
    });
    return { existing, diskHash };
  }

  // ---------------------------------------------------------------------------

  private collectIssues(): MemoryNoteIssue[] {
    const lastRefresh = this.getLastRefresh();
    const rows = this.deps.db.prepare(
      `SELECT event_type, details FROM edits_log
       WHERE event_type IN ('memory-note-rejected', 'memory-note-conflict', 'memory-note-apply-error')
         ${lastRefresh ? 'AND timestamp >= ?' : ''}
       ORDER BY timestamp DESC LIMIT 50`,
    ).all(...(lastRefresh ? [lastRefresh] : [])) as Array<{ event_type: string; details: string }>;

    const issues: MemoryNoteIssue[] = [];
    const seen = new Set<string>();
    const addIssue = (issue: MemoryNoteIssue): void => {
      const key = `${issue.block_key}\u0000${issue.outcome}\u0000${issue.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ ...issue, message: issue.message.slice(0, 200) });
    };
    for (const row of rows) {
      try {
        const details = JSON.parse(row.details) as Record<string, unknown>;
        const outcome: MemoryNoteIssue['outcome'] = row.event_type === 'memory-note-rejected'
          ? 'rejected' as const
          : row.event_type === 'memory-note-conflict'
            ? 'conflict' as const
            : 'rejected' as const; // apply-error → surface as rejected
        const structured = Array.isArray(details.issues) ? details.issues : null;
        if (structured) {
          for (const item of structured) {
            if (item && typeof item === 'object') {
              const issue = item as Record<string, unknown>;
              addIssue({ block_key: typeof issue.block_key === 'string' ? issue.block_key : 'note', outcome, message: String(issue.message ?? row.event_type) });
            }
          }
        } else if (Array.isArray(details.messages)) {
          for (const message of details.messages) addIssue({ block_key: 'note', outcome, message: String(message) });
        } else {
          addIssue({ block_key: typeof details.block_key === 'string' ? details.block_key : 'note', outcome, message: String(details.message ?? row.event_type) });
        }
      } catch {
        // skip malformed
      }
    }
    const receiptRows = this.deps.db.prepare(
      `SELECT block_key, outcome, details_json FROM memory_note_receipts
       WHERE outcome IN ('rejected', 'conflict', 'duplicate')
         ${lastRefresh ? 'AND applied_at >= ?' : ''}
       ORDER BY applied_at DESC LIMIT 50`,
    ).all(...(lastRefresh ? [new Date(lastRefresh).toISOString()] : [])) as Array<{
      block_key: string; outcome: 'rejected' | 'conflict' | 'duplicate'; details_json: string | null;
    }>;
    for (const receipt of receiptRows) {
      let message: string = receipt.outcome;
      try {
        const details = receipt.details_json ? JSON.parse(receipt.details_json) as Record<string, unknown> : null;
        if (details?.message) message = String(details.message);
      } catch {
        // Keep the outcome as a bounded, safe fallback.
      }
      addIssue({ block_key: receipt.block_key, outcome: receipt.outcome, message });
    }
    return issues;
  }

  private getLastRefresh(): number | null {
    const row = this.deps.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_LAST_REFRESH) as { value: string } | undefined;
    if (!row) return null;
    const ms = Date.parse(row.value);
    return isNaN(ms) ? null : ms;
  }

  private setLastRefresh(): void {
    const now = new Date().toISOString();
    this.deps.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(META_LAST_REFRESH, now);
  }

  private snapshotAtFallback(): { snapshotAt?: string | undefined } {
    return {};
  }
}
