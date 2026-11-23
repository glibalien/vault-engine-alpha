// src/db/retention.ts
//
// Retention sweeps for the unbounded tables (DB-health Part B). Runs inside
// the maintenance interval — no timer of its own.
// Spec: docs/superpowers/specs/2026-06-09-db-health-bundle-design.md

import type Database from 'better-sqlite3';

export interface RetentionOptions {
  editsLogRetentionDays?: number;        // default 90 (EDITS_LOG_RETENTION_DAYS)
  extractionCacheRetentionDays?: number; // default 30 (EXTRACTION_CACHE_RETENTION_DAYS)
}

export interface RetentionResult {
  editsLogDeleted: number;
  extractionCacheEvicted: number;
  embeddingVecOrphansDeleted: number;
  memoryEmbeddingVecOrphansDeleted: number;
}

/**
 * edits_log event types that are the only durable record of intentionally
 * discarded user data — exempt from retention forever (charter: "data is
 * never silently deleted"). Currently just the update-global-field
 * discard_uncoercible record (src/global-fields/crud.ts).
 */
export const PRESERVED_EDITS_LOG_EVENT_TYPES = ['value-removed'] as const;

export function runRetentionSweeps(
  db: Database.Database,
  opts: RetentionOptions = {},
): RetentionResult {
  const editsDays = opts.editsLogRetentionDays ?? 90;
  const cacheDays = opts.extractionCacheRetentionDays ?? 30;
  const editsCutoffMs = Date.now() - editsDays * 86_400_000;            // edits_log.timestamp is unix ms
  const cacheCutoffIso = new Date(Date.now() - cacheDays * 86_400_000).toISOString(); // ISO strings compare lexicographically

  const placeholders = PRESERVED_EDITS_LOG_EVENT_TYPES.map(() => '?').join(', ');
  // One transaction for both sweeps is deliberate: both tables always exist
  // (createSchema + B1 migration run at startup), and a single atomic sweep
  // keeps the counters consistent with what actually happened.
  const run = db.transaction((): RetentionResult => {
    const editsLogDeleted = db.prepare(
      `DELETE FROM edits_log WHERE timestamp < ? AND event_type NOT IN (${placeholders})`
    ).run(editsCutoffMs, ...PRESERVED_EDITS_LOG_EVENT_TYPES).changes;

    // Pure perf cache since transcript retention; durable knowledge lives in
    // attachment_transcripts. NULL last_used_at is treated as fresh.
    const extractionCacheEvicted = db.prepare(
      'DELETE FROM extraction_cache WHERE last_used_at IS NOT NULL AND last_used_at < ?'
    ).run(cacheCutoffIso).changes;

    // Safety net for the no-FK embedding_vec virtual table: any ordering
    // regression in a delete path turns into a self-healing, logged event
    // instead of a permanent leak. Embeddings are derived data — regenerable.
    const embeddingVecOrphansDeleted = db.prepare(
      'DELETE FROM embedding_vec WHERE id NOT IN (SELECT id FROM embedding_meta)'
    ).run().changes;

    // Same safety net as above, but for the DEDICATED memory_embedding_vec
    // table (Durable Memories v1) — deliberately independent of the
    // embedding_vec/embedding_meta sweep above. memories.node_id's FK is
    // ON DELETE SET NULL (v3), so a nodes delete can no longer cascade-
    // delete a memories row; this sweep is the safety net for a crash
    // mid-delete of a memory (or legacy leftovers from before v3), since
    // the vec0 virtual table has no FK support of its own. memories.vec_id
    // is nullable (a memory may have no embedding yet), hence the NULL
    // guard mirrors the FK-less pairing here.
    const memoryEmbeddingVecOrphansDeleted = db.prepare(
      'DELETE FROM memory_embedding_vec WHERE id NOT IN (SELECT vec_id FROM memories WHERE vec_id IS NOT NULL)'
    ).run().changes;

    return { editsLogDeleted, extractionCacheEvicted, embeddingVecOrphansDeleted, memoryEmbeddingVecOrphansDeleted };
  });
  return run();
}
