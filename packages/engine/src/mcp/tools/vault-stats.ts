import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { ok } from './errors.js';
import type { ExtractorRegistry } from '../../extraction/registry.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';

export function registerVaultStats(server: McpServer, db: Database.Database, extractorRegistry?: ExtractorRegistry, embeddingIndexer?: EmbeddingIndexer): void {
  server.tool(
    'vault-stats',
    'Summary snapshot of vault health and size: node counts, type counts, field count, relationship count, orphan count, schema count, transcript/archive counters, and search index status. Also reports db_bytes/wal_bytes (cheap PRAGMA) and watcher liveness (last_event_at, state) derived from the sync log.',
    {},
    async () => {
      const nodeCount = (db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count;

      const typeCounts = db.prepare(
        'SELECT schema_type as type, COUNT(*) as count FROM node_types GROUP BY schema_type ORDER BY count DESC'
      ).all() as Array<{ type: string; count: number }>;

      const fieldCount = (db.prepare(
        'SELECT COUNT(DISTINCT field_name) as count FROM node_fields'
      ).get() as { count: number }).count;

      const relationshipCount = (db.prepare(
        'SELECT COUNT(*) as count FROM relationships'
      ).get() as { count: number }).count;

      const orphanCount = (db.prepare(
        `SELECT COUNT(*) as count FROM node_fields nf
         WHERE NOT EXISTS (
           SELECT 1 FROM node_types nt
           JOIN schema_field_claims sfc ON sfc.schema_name = nt.schema_type AND sfc.field = nf.field_name
           WHERE nt.node_id = nf.node_id
         )`
      ).get() as { count: number }).count;

      const schemaCount = (db.prepare(
        'SELECT COUNT(*) as count FROM schemas'
      ).get() as { count: number }).count;

      const undoActive = (db.prepare("SELECT COUNT(*) AS c FROM undo_operations WHERE status = 'active'").get() as { c: number }).c;
      // Approx byte size: sum of LENGTH on body + JSON columns.
      const undoBytes = (db.prepare(`
        SELECT COALESCE(SUM(
          IFNULL(LENGTH(body), 0) +
          IFNULL(LENGTH(types), 0) +
          IFNULL(LENGTH(fields), 0) +
          IFNULL(LENGTH(relationships), 0)
        ), 0) AS b FROM undo_snapshots
      `).get() as { b: number }).b;

      const hasTranscripts = (db.prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='attachment_transcripts'"
      ).get() as { c: number }).c > 0;
      const transcriptCols = hasTranscripts
        ? (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[]).map(c => c.name)
        : [];
      const hasMaterializedCol = transcriptCols.includes('materialized_node_id');
      const transcriptCounts = hasTranscripts
        ? (db.prepare(
            `SELECT COUNT(*) AS retained,
                    COALESCE(SUM(source_deleted), 0) AS orphaned,
                    ${hasMaterializedCol ? 'COUNT(materialized_node_id)' : '0'} AS materialized
             FROM attachment_transcripts`
          ).get() as { retained: number; orphaned: number; materialized: number })
        : { retained: 0, orphaned: 0, materialized: 0 };

      const hasArchiveLog = (db.prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='archive_log'"
      ).get() as { c: number }).c > 0;
      const archiveTotals = hasArchiveLog
        ? (db.prepare('SELECT COUNT(*) AS sources, COALESCE(SUM(bytes), 0) AS bytes FROM archive_log')
            .get() as { sources: number; bytes: number })
        : { sources: 0, bytes: 0 };

      // Cheap size pragmas (copied from vault-doctor's size block — NO integrity check).
      const pageCount = db.pragma('page_count', { simple: true }) as number;
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      const walPath = `${db.name}-wal`;
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;

      // Watcher liveness derived from the most recent sync_log row (no watcher coupling).
      const lastSync = db.prepare('SELECT timestamp, event FROM sync_log ORDER BY timestamp DESC LIMIT 1').get() as
        | { timestamp: number; event: string }
        | undefined;
      const watcher = {
        last_event_at: lastSync ? new Date(lastSync.timestamp).toISOString() : null,
        state: lastSync && Date.now() - lastSync.timestamp < 60_000 ? 'active' : 'idle',
      };

      const resultObj: Record<string, unknown> = {
        node_count: nodeCount,
        type_counts: typeCounts,
        field_count: fieldCount,
        relationship_count: relationshipCount,
        orphan_count: orphanCount,
        schema_count: schemaCount,
        db_bytes: pageCount * pageSize,
        wal_bytes: walBytes,
        watcher,
        retained_transcripts: transcriptCounts.retained,
        orphaned_transcripts: transcriptCounts.orphaned,
        materialized_transcripts: transcriptCounts.materialized,
        archived_sources: archiveTotals.sources,
        archived_bytes: archiveTotals.bytes,
        undo: {
          active_operations: undoActive,
          total_snapshot_bytes: undoBytes,
        },
      };

      if (extractorRegistry) {
        resultObj.extractors = extractorRegistry.getStatus();
      }

      if (embeddingIndexer) {
        resultObj.search_index = embeddingIndexer.getStatus();
      }

      return ok(resultObj);
    },
  );
}
