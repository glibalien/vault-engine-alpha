import { createHash } from 'node:crypto';
import { SUITE_NOTE_FIELD } from '../notes/suite-notes.js';
import { relative } from 'node:path';
import type Database from 'better-sqlite3';
import type { DrainSummary, EmbeddingQueueItem, SearchIndexStatus } from './types.js';
import type { Embedder } from './embedder.js';
import {
  assembleDocumentContext,
  semanticSourceHash,
  type EmbeddingDocumentContext,
} from './semantic-context.js';
import { resolveEmbedRef } from '../extraction/resolve.js';
import { ExtractionDisabledError, UnsupportedExtensionError } from '../extraction/types.js';
import type { ExtractionCache } from '../extraction/cache.js';
import type { TranscriptStore } from '../extraction/transcript-store.js';
import { parseEmbedReferences } from '../extraction/assembler.js';
import { CURRENT_SEARCH_VERSION, getSearchVersion } from '../db/search-version.js';

const UNAVAILABLE_EXTRACTION_REASONS = [
  'dependencies_unavailable',
  'unsafe_reference',
  'missing_attachment',
  'unsupported_extension',
  'extraction_disabled',
  'empty_extraction',
] as const;
/** Suite notes (the memory note, the Curator Journal) are never embedded (#600). */
const SEMANTIC_EXCLUSION_FIELD = SUITE_NOTE_FIELD;
type UnavailableExtractionReason = (typeof UNAVAILABLE_EXTRACTION_REASONS)[number];

export interface EmbeddingIndexer {
  enqueue(item: EmbeddingQueueItem): void;
  processOne(): Promise<boolean>;
  processAll(): Promise<DrainSummary>;
  drain(): Promise<void>;
  assembleContent(nodeId: string): string;
  contentHash(nodeId: string): string;
  getStatus(): SearchIndexStatus;
  removeNode(nodeId: string): void;
  clearAll(): void;
  queueSize(): number;
}

interface NodeRow {
  title: string | null;
  body: string | null;
}

interface FieldRow {
  field_name: string;
  value_text: string;
}

interface CountRow {
  cnt: number;
}

export interface EmbeddingIndexerDeps {
  extractionCache?: ExtractionCache;
  vaultPath?: string;
  transcriptStore?: TranscriptStore;
}

export function createEmbeddingIndexer(
  db: Database.Database,
  embedder: Embedder,
  deps?: EmbeddingIndexerDeps
): EmbeddingIndexer {
  // Prepared statements created once in closure
  const stmtGetNode = db.prepare<[string], NodeRow>(
    'SELECT title, body FROM nodes WHERE id = ?'
  );

  const stmtGetStringFields = db.prepare<[string], FieldRow>(
    'SELECT field_name, value_text FROM node_fields WHERE node_id = ? AND value_text IS NOT NULL'
  );

  // Check whether a node carries the `vault_engine_projection` frontmatter
  // field — suite notes (Settings/Memories.md, the Curator Journal) are FTS-searchable for
  // humans but excluded from semantic embeddings and all autonomous
  // memory/organization evidence enumeration (Task 7).
  const stmtIsProjection = db.prepare<[string, string], { c: number }>(
    `SELECT COUNT(*) as c FROM node_fields
     WHERE node_id = ? AND field_name = ? AND value_text IS NOT NULL`
  );

  // extraction_ref IS ? (not = ?) handles NULL comparison correctly in SQL
  const stmtGetAnyHashForGroup = db.prepare<[string, string, string | null], { source_hash: string }>(
    `SELECT source_hash FROM embedding_meta
     WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?
     LIMIT 1`
  );

  const stmtDeleteVecByGroup = db.prepare<[string, string, string | null], void>(
    `DELETE FROM embedding_vec WHERE id IN (
       SELECT id FROM embedding_meta
       WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?
     )`
  );

  const stmtDeleteMetaByGroup = db.prepare<[string, string, string | null], void>(
    `DELETE FROM embedding_meta
     WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?`
  );

  const stmtInsertMeta = db.prepare(
    `INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const stmtInsertVec = db.prepare<[bigint, Uint8Array], void>(
    'INSERT INTO embedding_vec (id, vector) VALUES (?, ?)'
  );

  const stmtDeleteVecByNode = db.prepare<[string], void>(
    `DELETE FROM embedding_vec WHERE id IN (
       SELECT id FROM embedding_meta WHERE node_id = ?
     )`
  );

  const stmtDeleteMetaByNode = db.prepare<[string], void>(
    'DELETE FROM embedding_meta WHERE node_id = ?'
  );

  const stmtClearVec = db.prepare<[], void>('DELETE FROM embedding_vec');
  const stmtClearMeta = db.prepare<[], void>('DELETE FROM embedding_meta');

  // Prepared statements for the "delete all extraction rows for a node" fast path
  // used by pruneStaleExtractions when currentRefs is empty.
  const stmtDeleteVecExtractionsByNode = db.prepare<[string], void>(
    `DELETE FROM embedding_vec WHERE id IN (
       SELECT id FROM embedding_meta
       WHERE node_id = ? AND source_type = 'extraction'
     )`
  );

  const stmtDeleteMetaExtractionsByNode = db.prepare<[string], void>(
    `DELETE FROM embedding_meta WHERE node_id = ? AND source_type = 'extraction'`
  );

  // Atomic transaction for the empty-refs fast path.
  const pruneAllExtractions = db.transaction((nodeId: string) => {
    stmtDeleteVecExtractionsByNode.run(nodeId);
    stmtDeleteMetaExtractionsByNode.run(nodeId);
  });

  // Atomic delete-then-insert of an entire chunk group. Wrapping this in a
  // transaction prevents partial state (e.g. mid-loop insert failure) that
  // would otherwise be indistinguishable from a fully-indexed group on retry,
  // because the hash check succeeds once any row for the group exists.
  const writeGroup = db.transaction((
    nodeId: string,
    sourceType: string,
    extractionRef: string | null,
    hash: string,
    vectors: Float32Array[],
    now: string,
  ) => {
    stmtDeleteVecByGroup.run(nodeId, sourceType, extractionRef);
    stmtDeleteMetaByGroup.run(nodeId, sourceType, extractionRef);
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const res = stmtInsertMeta.run(nodeId, sourceType, hash, i, extractionRef, now);
      stmtInsertVec.run(BigInt(res.lastInsertRowid), bytes);
    }
  });

  const stmtCountNodes = db.prepare<[], CountRow>('SELECT COUNT(*) as cnt FROM nodes');
  const stmtCountIndexed = db.prepare<[], CountRow>(
    "SELECT COUNT(DISTINCT node_id) as cnt FROM embedding_meta WHERE source_type = 'node'"
  );

  const stmtCountExcluded = db.prepare<[string], CountRow>(
    `SELECT COUNT(DISTINCT node_id) as cnt
     FROM node_fields
     WHERE field_name = ? AND value_text IS NOT NULL`
  );

  const stmtCountUnindexed = db.prepare<[string], CountRow>(
    `SELECT COUNT(*) as cnt
     FROM nodes n
     WHERE NOT EXISTS (
       SELECT 1 FROM node_fields nf
       WHERE nf.node_id = n.id
         AND nf.field_name = ?
         AND nf.value_text IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM embedding_meta em
       WHERE em.node_id = n.id AND em.source_type = 'node'
     )`
  );

  const stmtExtractionCacheExists = db.prepare<[], { cnt: number }>(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
  );

  const stmtCountExtractions = db.prepare<[], CountRow>(
    'SELECT COUNT(*) as cnt FROM extraction_cache'
  );

  // Count EXTRACTIONS, not nodes. `extractions_total` counts extraction_cache rows,
  // so counting DISTINCT node_id here compared two different units while presenting
  // them as a ratio — a note embedding three attachments read as "1 of 3 indexed".
  // (Still not a strict ratio: extraction_cache is content-hash keyed, so one cached
  // extraction can back the same file embedded from several notes.)
  const stmtCountExtractionsIndexed = db.prepare<[], CountRow>(
    `SELECT COUNT(*) as cnt FROM (
       SELECT DISTINCT node_id, extraction_ref FROM embedding_meta WHERE source_type = 'extraction'
     )`
  );

  // In-memory queue. Draining is self-scheduled: enqueue() kicks a single
  // background loop (guarded by drainPromise) so no caller has to remember to
  // pump, and a multi-item enqueue (node + N extractions) never strands items.
  const queue: EmbeddingQueueItem[] = [];
  let drainPromise: Promise<DrainSummary> | null = null;
  // Liveness signal: when the drain loop last made forward progress. Lets
  // vault-stats distinguish a healthy idle queue from a wedged embedder.
  let lastDrainAt: string | null = null;

  // Cycle 5 drain accounting. lastOutcome is set by processOne on every
  // terminal disposition; requeues ('retry') are not tallied until the item
  // reaches a final state. Permanent unavailable-extraction blockers are also
  // terminal failures. The rolling v2→v3 upgrade only persists the new version
  // when the initial drain reports none.
  type ProcessOutcome = 'completed' | 'skipped' | 'retry' | 'dropped';
  let lastOutcome: ProcessOutcome = 'skipped';
  let terminalFailures = 0;
  let lastDrainSummary: DrainSummary = { completed: 0, skipped: 0, failed: 0 };

  // Start the drain loop if one isn't already running; return the in-flight
  // promise either way. The loop drains until the queue is empty, including
  // items enqueued mid-drain. processOne() never throws (it catches + requeues
  // up to 3x, then drops), so the loop always terminates.
  function scheduleDrain(): Promise<DrainSummary> {
    if (!drainPromise) {
      drainPromise = (async () => {
        const summary: DrainSummary = { completed: 0, skipped: 0, failed: 0 };
        while (queue.length > 0) {
          const ok = await processOne();
          if (ok) {
            summary[lastOutcome === 'completed' ? 'completed' : 'skipped']++;
            lastDrainAt = new Date().toISOString();
          } else if (lastOutcome === 'dropped') {
            summary.failed++;
          }
          // 'retry': item was requeued — counted at its final disposition.
        }
        lastDrainSummary = summary;
        return summary;
      })().finally(() => {
        drainPromise = null;
      });
      // The loop body can't reject (processOne swallows), but guard anyway so a
      // future change can't produce an unhandled rejection.
      drainPromise.catch((err) =>
        console.error('[embedding-indexer] drain loop error:', err instanceof Error ? err.message : err),
      );
    }
    return drainPromise;
  }

  // Await full quiescence: queue empty AND no loop running. Re-checks because
  // items can be enqueued while we await (used by shutdown + deterministic tests).
  async function drain(): Promise<void> {
    while (queue.length > 0 || drainPromise) {
      await scheduleDrain();
    }
  }

  function itemKey(item: EmbeddingQueueItem): string {
    return `${item.node_id}::${item.source_type}::${item.extraction_ref ?? ''}`;
  }

  function isLikelyMarkdownRef(ref: string): boolean {
    const dot = ref.lastIndexOf('.');
    if (dot === -1) return true; // no extension → treat as md
    return ref.slice(dot).toLowerCase() === '.md';
  }

  /**
   * Permanent extraction skips are harmless when no vector group exists. During
   * a rolling upgrade, however, treating an unavailable existing group as an
   * ordinary skip would allow index.ts to certify v3 while retaining v2 rows.
   */
  function finishUnavailableExtraction(item: EmbeddingQueueItem, reason: UnavailableExtractionReason): boolean {
    const existing = stmtGetAnyHashForGroup.get(
      item.node_id,
      'extraction',
      item.extraction_ref ?? null,
    );
    if (existing && getSearchVersion(db) < CURRENT_SEARCH_VERSION) {
      terminalFailures++;
      console.error(
        `[embedding-indexer] rolling upgrade blocked reason=${reason} terminal_failures=${terminalFailures}`,
      );
      lastOutcome = 'dropped';
      return false;
    }
    return true;
  }

  // v2 legacy: ad hoc concatenation of title + body + string field values.
  // Retained on the interface for existing callers/tests; the v3 embedding
  // path uses body-only source text + a structured semantic context instead.
  function assembleContent(nodeId: string): string {
    const node = stmtGetNode.get(nodeId);
    if (!node) return '';

    const parts: string[] = [];
    if (node.title) parts.push(node.title);
    if (node.body) parts.push(node.body);

    const fields = stmtGetStringFields.all(nodeId);
    for (const field of fields) {
      parts.push(field.value_text);
    }

    return parts.join('\n\n');
  }

  // v3 source text: the chunkable content. For nodes this is the body — the
  // title/fields/links now travel in the semantic context, so editing them
  // changes the hash without duplicating them into every chunk body.
  function sourceTextForNode(nodeId: string): string {
    const node = stmtGetNode.get(nodeId);
    return node?.body ?? '';
  }

  function contentHash(nodeId: string): string {
    const context = assembleDocumentContext(db, nodeId);
    if (!context) return createHash('sha256').update('').digest('hex');
    return semanticSourceHash(context, sourceTextForNode(nodeId));
  }

  // Delete extraction rows whose extraction_ref is NOT in the current body's
  // non-markdown ref list. Used to reconcile when a node's embeds change.
  // Wrapped in a transaction to prevent orphan vec rows if a delete fails
  // mid-sequence. The "no refs" fast path uses cached prepared statements;
  // the variadic path builds SQL at call time (necessary for variable-length
  // NOT IN clauses) but still runs atomically.
  function pruneStaleExtractions(nodeId: string, currentRefs: string[]): void {
    if (currentRefs.length === 0) {
      pruneAllExtractions(nodeId);
      return;
    }
    const placeholders = currentRefs.map(() => '?').join(',');
    const vecStmt = db.prepare(
      `DELETE FROM embedding_vec WHERE id IN (
         SELECT id FROM embedding_meta
         WHERE node_id = ? AND source_type = 'extraction'
           AND extraction_ref NOT IN (${placeholders})
       )`
    );
    const metaStmt = db.prepare(
      `DELETE FROM embedding_meta
       WHERE node_id = ? AND source_type = 'extraction'
         AND extraction_ref NOT IN (${placeholders})`
    );
    const pruneSome = db.transaction(() => {
      vecStmt.run(nodeId, ...currentRefs);
      metaStmt.run(nodeId, ...currentRefs);
    });
    pruneSome();
  }

  function enqueue(item: EmbeddingQueueItem): void {
    const key = itemKey(item);
    if (!queue.some(q => itemKey(q) === key)) {
      queue.push(item);
    }

    if (item.source_type === 'node' && deps?.extractionCache && deps?.vaultPath) {
      const row = stmtGetNode.get(item.node_id);
      if (row && row.body) {
        const refs = parseEmbedReferences(row.body);
        const currentNonMdRefs = refs.filter(r => !isLikelyMarkdownRef(r));

        // Reconcile: drop extraction rows for refs that are no longer in the body.
        pruneStaleExtractions(item.node_id, currentNonMdRefs);

        for (const ref of currentNonMdRefs) {
          const extractionItem: EmbeddingQueueItem = {
            node_id: item.node_id,
            source_type: 'extraction',
            extraction_ref: ref,
          };
          const extKey = itemKey(extractionItem);
          if (!queue.some(q => itemKey(q) === extKey)) {
            queue.push(extractionItem);
          }
        }
      } else if (row) {
        // Body was emptied entirely — drop all extraction rows for this node.
        pruneStaleExtractions(item.node_id, []);
      }
    }

    // Self-drain: defer to setImmediate so synchronous post-enqueue inspection
    // (and existing manual-pump unit tests) see the queued item before the loop
    // shifts it. scheduleDrain() is idempotent, so many enqueues are harmless.
    setImmediate(() => {
      void scheduleDrain();
    });
  }

  async function processOne(): Promise<boolean> {
    const item = queue.shift();
    if (!item) return false;
    // Default disposition for every early-return path below (unsupported
    // extension, empty extraction, vanished node, ...): nothing written.
    lastOutcome = 'skipped';

    try {
      if (item.source_type === 'node') {
        const extractionRef = item.extraction_ref ?? null;
        const context = assembleDocumentContext(db, item.node_id);
        if (!context) return true; // node vanished between enqueue and drain

        // Suite notes (vault_engine_projection: memories, journal) are excluded
        // from semantic embeddings: remove any prior vectors and skip. The
        // FTS row stays so humans can still find memory text via full-text
        // search (Task 7).
        if (extractionRef === null) {
          const proj = stmtIsProjection.get(item.node_id, SEMANTIC_EXCLUSION_FIELD);
          if (proj && proj.c > 0) {
            removeNode(item.node_id);
            lastOutcome = 'skipped';
            return true;
          }
        }

        const sourceText = sourceTextForNode(item.node_id);
        const hash = semanticSourceHash(context, sourceText);
        const existing = stmtGetAnyHashForGroup.get(item.node_id, item.source_type, extractionRef);
        if (existing && existing.source_hash === hash) {
          lastOutcome = 'skipped';
          return true;
        }

        const vectors = await embedder.embedDocument(sourceText, context);
        const now = new Date().toISOString();

        writeGroup(item.node_id, item.source_type, extractionRef, hash, vectors, now);
        lastOutcome = 'completed';
      }

      if (item.source_type === 'extraction') {
        if (!deps?.extractionCache || !deps?.vaultPath || !item.extraction_ref) {
          return finishUnavailableExtraction(item, 'dependencies_unavailable');
        }
        const extractionRef = item.extraction_ref;

        // resolveEmbedRef may throw on path traversal (safeVaultPath guard). Treat
        // traversal attempts the same as unresolvable refs — silently no-op.
        // Any other error (e.g. locked DB) is a real failure — rethrow so the
        // outer catch retries up to 3×.
        let resolved: Awaited<ReturnType<typeof resolveEmbedRef>> = null;
        try {
          resolved = await resolveEmbedRef(db, deps.vaultPath, extractionRef);
        } catch (err) {
          // safeVaultPath throws "Path traversal blocked" for `../` escape attempts.
          // Treat as unresolvable (no retry). Anything else is a real error — rethrow
          // so the outer catch retries up to 3x.
          if (err instanceof Error && err.message.includes('Path traversal')) {
            return finishUnavailableExtraction(item, 'unsafe_reference');
          }
          throw err;
        }

        // Source file missing/unresolvable: fall back to the retained transcript
        // so search survives deletion of the binary (and full rebuilds).
        if (!resolved || resolved.isMarkdown) {
          if (!resolved && deps.transcriptStore) {
            const retained = deps.transcriptStore.getByRef(extractionRef);
            if (retained && retained.extracted_text.length > 0) {
              const context = assembleDocumentContext(db, item.node_id, {
                ref: extractionRef,
                ...(retained.media_type ? { mediaType: retained.media_type } : {}),
              });
              if (!context) return true;
              const hash = semanticSourceHash(context, retained.extracted_text);
              const existing = stmtGetAnyHashForGroup.get(item.node_id, 'extraction', extractionRef);
              if (existing && existing.source_hash === hash) {
                lastOutcome = 'skipped';
                return true;
              }
              const vectors = await embedder.embedDocument(retained.extracted_text, context);
              writeGroup(item.node_id, 'extraction', extractionRef, hash, vectors, new Date().toISOString());
              lastOutcome = 'completed';
              return true;
            }
          }
          return finishUnavailableExtraction(
            item,
            resolved?.isMarkdown === true ? 'unsupported_extension' : 'missing_attachment',
          );
        }

        // Unsupported extensions and extraction turned off are permanent for the
        // process — skip without the 3x retry loop.
        let extraction: Awaited<ReturnType<ExtractionCache['getExtraction']>>;
        try {
          extraction = await deps.extractionCache.getExtraction(resolved.filePath);
        } catch (err) {
          if (err instanceof UnsupportedExtensionError) {
            return finishUnavailableExtraction(item, 'unsupported_extension');
          }
          if (err instanceof ExtractionDisabledError) {
            return finishUnavailableExtraction(item, 'extraction_disabled');
          }
          throw err;
        }
        const text = extraction.text ?? '';
        if (text.length === 0) {
          return finishUnavailableExtraction(item, 'empty_extraction');
        }

        // Snapshot the transcript into the durable store on every extraction.
        // Intentionally BEFORE the hash-skip below: a hash-match would otherwise
        // skip capture and leave already-indexed vaults without a retained copy.
        if (deps.transcriptStore) {
          deps.transcriptStore.capture({
            embedRef: extractionRef,
            vaultPath: relative(deps.vaultPath, resolved.filePath),
            contentHash: extraction.contentHash,
            extractedText: text,
            mediaType: extraction.mediaType,
            extractorId: extraction.extractorId,
            metadataJson: extraction.metadata != null ? JSON.stringify(extraction.metadata) : null,
          });
        }

        const context = assembleDocumentContext(db, item.node_id, {
          ref: extractionRef,
          ...(extraction.mediaType ? { mediaType: extraction.mediaType } : {}),
        });
        if (!context) return true;
        const hash = semanticSourceHash(context, text);
        const existing = stmtGetAnyHashForGroup.get(item.node_id, 'extraction', extractionRef);
        if (existing && existing.source_hash === hash) {
          lastOutcome = 'skipped';
          return true;
        }

        const vectors = await embedder.embedDocument(text, context);
        writeGroup(item.node_id, 'extraction', extractionRef, hash, vectors, new Date().toISOString());
        lastOutcome = 'completed';
      }

      return true;
    } catch (err) {
      const retries = (item.retries ?? 0) + 1;
      if (retries < 3) {
        console.warn(`[embedding-indexer] embed failed for ${item.node_id} (attempt ${retries}), requeueing:`, err);
        queue.push({ ...item, retries });
        lastOutcome = 'retry';
      } else {
        console.error(`[embedding-indexer] embed failed for ${item.node_id} after 3 attempts, dropping:`, err);
        terminalFailures++;
        lastOutcome = 'dropped';
      }
      return false;
    }
  }

  async function processAll(): Promise<DrainSummary> {
    return scheduleDrain();
  }

  function getStatus(): SearchIndexStatus {
    const nodesTotal = (stmtCountNodes.get() as CountRow).cnt;
    const nodesIndexed = (stmtCountIndexed.get() as CountRow).cnt;
    const nodesExcluded = (stmtCountExcluded.get(SEMANTIC_EXCLUSION_FIELD) as CountRow).cnt;
    const nodesUnindexed = (stmtCountUnindexed.get(SEMANTIC_EXCLUSION_FIELD) as CountRow).cnt;
    const extractionCacheExists = ((stmtExtractionCacheExists.get() as { cnt: number }).cnt) > 0;

    let extractionsTotal = 0;
    let extractionsIndexed = 0;

    if (extractionCacheExists) {
      extractionsTotal = (stmtCountExtractions.get() as CountRow).cnt;
      extractionsIndexed = (stmtCountExtractionsIndexed.get() as CountRow).cnt;
    }

    const status = !embedder.isReady() ? 'disabled' as const
      : queue.length > 0 || drainPromise !== null ? 'indexing' as const
      : 'ready' as const;

    // Cycle 5 rolling-upgrade observability (additive vault-stats fields).
    const storedVersion = getSearchVersion(db);

    return {
      status,
      nodes_total: nodesTotal,
      nodes_indexed: nodesIndexed,
      nodes_excluded: nodesExcluded,
      nodes_unindexed: nodesUnindexed,
      extractions_total: extractionsTotal,
      extractions_indexed: extractionsIndexed,
      pending: queue.length,
      last_drain_at: lastDrainAt,
      stored_version: storedVersion,
      target_version: CURRENT_SEARCH_VERSION,
      rolling_upgrade: storedVersion < CURRENT_SEARCH_VERSION,
      terminal_failures: terminalFailures,
      last_drain: lastDrainSummary,
    };
  }

  function removeNode(nodeId: string): void {
    // Delete vec rows FIRST (they reference meta IDs via subquery), then meta rows
    stmtDeleteVecByNode.run(nodeId);
    stmtDeleteMetaByNode.run(nodeId);
  }

  function clearAll(): void {
    stmtClearVec.run();
    stmtClearMeta.run();
    queue.length = 0;
  }

  function queueSize(): number {
    return queue.length;
  }

  return {
    enqueue,
    processOne,
    processAll,
    drain,
    assembleContent,
    contentHash,
    getStatus,
    removeNode,
    clearAll,
    queueSize,
  };
}
