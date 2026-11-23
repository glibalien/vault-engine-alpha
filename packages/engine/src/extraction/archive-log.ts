// src/extraction/archive-log.ts
//
// Append-only provenance for source attachments retired by archive-source.
// Lives apart from attachment_transcripts because capture() upserts reset
// deletion state when a file reappears — provenance must survive that.
// Performs no filesystem access.

import type Database from 'better-sqlite3';

export interface ArchiveLogEntry {
  vaultPath: string;
  contentHash: string;
  bytes: number;
  mode: 'archive' | 'purge';
  archivePath: string | null;
  materializedNodeId: string | null;
  operationId: string | null;
}

export interface ArchiveLogRow {
  id: number;
  vault_path: string;
  content_hash: string;
  bytes: number;
  mode: string;
  archive_path: string | null;
  materialized_node_id: string | null;
  operation_id: string | null;
  archived_at: string;
}

export class ArchiveLog {
  private readonly stmtInsert;
  private readonly stmtListByPath;
  private readonly stmtTotals;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO archive_log
        (vault_path, content_hash, bytes, mode, archive_path, materialized_node_id, operation_id, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtListByPath = db.prepare('SELECT * FROM archive_log WHERE vault_path = ? ORDER BY archived_at DESC, id DESC');
    this.stmtTotals = db.prepare('SELECT COUNT(*) AS sources, COALESCE(SUM(bytes), 0) AS bytes FROM archive_log');
  }

  record(e: ArchiveLogEntry): void {
    this.stmtInsert.run(
      e.vaultPath, e.contentHash, e.bytes, e.mode,
      e.archivePath, e.materializedNodeId, e.operationId,
      new Date().toISOString(),
    );
  }

  listByPath(vaultPath: string): ArchiveLogRow[] {
    return this.stmtListByPath.all(vaultPath) as ArchiveLogRow[];
  }

  totals(): { sources: number; bytes: number } {
    return this.stmtTotals.get() as { sources: number; bytes: number };
  }
}
