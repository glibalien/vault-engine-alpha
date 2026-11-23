// src/extraction/transcript-store.ts
//
// Durable store for transcripts extracted from embedded non-markdown files.
// Keyed by embed ref (the ![[ref]] string), indexed by vault-relative path.
// Unlike extraction_cache (keyed by a hash of the live file's bytes), this
// store is reachable WITHOUT the source file, so transcripts survive deletion.
// Performs no filesystem access — operates only on stored vault-relative
// strings, so it is path-traversal-safe by construction.

import type Database from 'better-sqlite3';

export interface TranscriptRow {
  embed_ref: string;
  vault_path: string | null;
  content_hash: string;
  extracted_text: string;
  media_type: string;
  extractor_id: string;
  source_deleted: number;
  captured_at: string;
  deleted_at: string | null;
  metadata_json: string | null;
  materialized_node_id: string | null;
  materialized_at: string | null;
}

export interface CaptureInput {
  embedRef: string;
  vaultPath: string | null;
  contentHash: string;
  extractedText: string;
  mediaType: string;
  extractorId: string;
  metadataJson?: string | null;
}

export interface ListOptions {
  sourceDeleted?: boolean;
  limit?: number;
}

export class TranscriptStore {
  private readonly stmtCapture;
  private readonly stmtGetByRef;
  // A single vault path may be embedded via several distinct ![[ref]] strings,
  // so one path can map to multiple rows.  getByPath returns any one row
  // (LIMIT 1) for the fallback look-up use case, while markDeleted updates ALL
  // rows for the path so every transcript reflects the deletion.
  private readonly stmtGetByPath;
  private readonly stmtListByPath;
  private readonly stmtMarkDeleted;
  private readonly stmtMarkMaterialized;
  private readonly stmtListAll;
  private readonly stmtListFiltered;
  private readonly stmtListSourceDeleted;
  private readonly stmtClearSourceDeleted;

  constructor(private readonly db: Database.Database) {
    // Upsert by embed_ref; a fresh capture always clears prior deletion state.
    this.stmtCapture = db.prepare(`
      INSERT INTO attachment_transcripts
        (embed_ref, vault_path, content_hash, extracted_text, media_type,
         extractor_id, source_deleted, captured_at, deleted_at, metadata_json)
      VALUES (@embed_ref, @vault_path, @content_hash, @extracted_text, @media_type,
              @extractor_id, 0, @captured_at, NULL, @metadata_json)
      ON CONFLICT(embed_ref) DO UPDATE SET
        vault_path     = excluded.vault_path,
        content_hash   = excluded.content_hash,
        extracted_text = excluded.extracted_text,
        media_type     = excluded.media_type,
        extractor_id   = excluded.extractor_id,
        source_deleted = 0,
        captured_at    = excluded.captured_at,
        deleted_at     = NULL,
        metadata_json  = excluded.metadata_json
    `);
    this.stmtGetByRef = db.prepare('SELECT * FROM attachment_transcripts WHERE embed_ref = ?');
    this.stmtGetByPath = db.prepare('SELECT * FROM attachment_transcripts WHERE vault_path = ? LIMIT 1');
    this.stmtListByPath = db.prepare('SELECT * FROM attachment_transcripts WHERE vault_path = ?');
    this.stmtMarkDeleted = db.prepare(
      `UPDATE attachment_transcripts SET source_deleted = 1, deleted_at = ?
       WHERE vault_path = ? AND source_deleted = 0`
    );
    this.stmtMarkMaterialized = db.prepare(
      `UPDATE attachment_transcripts SET materialized_node_id = ?, materialized_at = ?
       WHERE embed_ref = ?`
    );
    this.stmtListAll = db.prepare(
      'SELECT * FROM attachment_transcripts ORDER BY captured_at DESC LIMIT ?'
    );
    this.stmtListFiltered = db.prepare(
      'SELECT * FROM attachment_transcripts WHERE source_deleted = ? ORDER BY captured_at DESC LIMIT ?'
    );
    this.stmtListSourceDeleted = db.prepare(
      'SELECT DISTINCT vault_path FROM attachment_transcripts WHERE source_deleted = 1 AND vault_path IS NOT NULL',
    );
    this.stmtClearSourceDeleted = db.prepare(
      `UPDATE attachment_transcripts SET source_deleted = 0, deleted_at = NULL
       WHERE vault_path = ? AND source_deleted = 1`,
    );
  }

  capture(input: CaptureInput): void {
    this.stmtCapture.run({
      embed_ref: input.embedRef,
      vault_path: input.vaultPath,
      content_hash: input.contentHash,
      extracted_text: input.extractedText,
      media_type: input.mediaType,
      extractor_id: input.extractorId,
      captured_at: new Date().toISOString(),
      metadata_json: input.metadataJson ?? null,
    });
  }

  getByRef(embedRef: string): TranscriptRow | null {
    return (this.stmtGetByRef.get(embedRef) as TranscriptRow | undefined) ?? null;
  }

  getByPath(vaultPath: string): TranscriptRow | null {
    return (this.stmtGetByPath.get(vaultPath) as TranscriptRow | undefined) ?? null;
  }

  /**
   * ALL rows sharing a vault path (one binary may be embedded under several
   * distinct ![[ref]] spellings). archive-source verification must check every
   * row, not the arbitrary LIMIT 1 row getByPath returns.
   */
  listByPath(vaultPath: string): TranscriptRow[] {
    return this.stmtListByPath.all(vaultPath) as TranscriptRow[];
  }

  markDeleted(vaultPath: string): number {
    const res = this.stmtMarkDeleted.run(new Date().toISOString(), vaultPath);
    return res.changes;
  }

  /** Distinct vault paths of transcripts whose source is currently flagged deleted. */
  listSourceDeletedPaths(): string[] {
    return (this.stmtListSourceDeleted.all() as { vault_path: string }[]).map((r) => r.vault_path);
  }

  /**
   * Inverse of markDeleted: clears source_deleted (and deleted_at) for ALL rows
   * sharing a vault path (one binary may be embedded under several ![[ref]]
   * spellings). Used by the reconciler when a source file reappears on disk.
   * Returns the number of rows changed.
   */
  clearSourceDeleted(vaultPath: string): number {
    return this.stmtClearSourceDeleted.run(vaultPath).changes;
  }

  /**
   * Link a transcript row to the node it was materialized into. Keyed by
   * embed_ref (the upsert primary key). Returns the number of rows changed
   * (0 if the ref is unknown). Does not touch source_deleted/text.
   */
  markMaterialized(embedRef: string, nodeId: string): number {
    const res = this.stmtMarkMaterialized.run(nodeId, new Date().toISOString(), embedRef);
    return res.changes;
  }

  list(opts: ListOptions): TranscriptRow[] {
    const limit = opts.limit ?? 200;
    if (opts.sourceDeleted === undefined) {
      return this.stmtListAll.all(limit) as TranscriptRow[];
    }
    return this.stmtListFiltered.all(opts.sourceDeleted ? 1 : 0, limit) as TranscriptRow[];
  }
}
