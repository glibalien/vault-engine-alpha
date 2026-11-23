import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';
import { readLastBackup, resolveBackupDir, listBackups } from '../../db/maintenance.js';
import { findNearMissTargets } from '../../resolver/near-miss.js';
import { findFilenameUnresolvableLinks } from '../../resolver/file-link.js';
import { computeNearPairs } from './memory-pairs.js';
import { MEMORY_NEAR_DUP, MEMORY_RECONCILE_REPORT_FAR } from './memories.js';
import { typeKey } from '../../parser/type-key.js';

interface InvariantReport {
  name: string;
  ok: boolean;
  count: number;
  detail: string;
}

export function registerVaultDoctor(server: McpServer, db: Database.Database): void {
  server.tool(
    'vault-doctor',
    'Read-only database health report: SQLite integrity check (quick_check; full:true for exhaustive integrity_check), file/WAL/free-page sizes, per-table row counts, last-backup status, and cross-table invariant checks (embedding sync, dangling resolved targets, unresolved near-miss references, links unresolvable by filename, dangling materialized transcripts, orphan fields, fields named like the type key). Never mutates anything — invariant ok:false is a signal to investigate, not a tool error. Synchronous and proportional to DB size — call on demand for diagnostics, not routinely.',
    {
      full: z.boolean().optional().describe('Run exhaustive PRAGMA integrity_check instead of quick_check (slower)'),
    },
    async (params) => {
      const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

      // --- integrity ---
      const check = params.full ? 'integrity_check' : 'quick_check';
      const rows = db.pragma(check) as Array<Record<string, unknown>>;
      const messages = rows.map(r => String(Object.values(r)[0])).filter(m => m !== 'ok');
      const integrity = { check, ok: messages.length === 0, messages };

      // --- size ---
      const pageCount = db.pragma('page_count', { simple: true }) as number;
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      const freelistCount = db.pragma('freelist_count', { simple: true }) as number;
      const walPath = `${db.name}-wal`;
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;

      // User tables + virtual tables, minus the virtual tables' shadow tables
      // (vec0/fts5 internals would only add noise). Virtual tables appear in
      // sqlite_master as type='table' and COUNT(*) works on vec0/fts5.
      const tableNames = (db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE 'nodes_fts_%'
           AND name NOT LIKE 'embedding_vec_%'
           AND name NOT LIKE 'memory_embedding_vec_%'
           AND name NOT LIKE 'memories_fts_%'
         ORDER BY name`
      ).all() as { name: string }[]).map(r => r.name);
      const tableRows: Record<string, number> = {};
      for (const name of tableNames) {
        tableRows[name] = count(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`);
      }
      const size = {
        db_bytes: pageCount * pageSize,
        wal_bytes: walBytes,
        free_bytes: freelistCount * pageSize, // vacuumable space; VACUUM INTO backups drop it
        table_rows: tableRows,
      };

      // --- backup ---
      const last = readLastBackup(db);
      const backup = {
        last_backup_at: last?.at ?? null,
        last_backup_ok: last?.ok ?? null,
        backup_count: listBackups(resolveBackupDir(db.name)).length,
      };

      // --- invariants (read-only NOT EXISTS anti-joins) ---
      const invariants: InvariantReport[] = [];

      const danglingMeta = count(
        `SELECT COUNT(*) AS c FROM embedding_meta m
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = m.node_id)`
      );
      invariants.push({
        name: 'embedding_meta_dangling_node',
        ok: danglingMeta === 0,
        count: danglingMeta,
        detail: 'embedding_meta rows whose node_id no longer exists in nodes — an ordering regression in executeDeletion (embedding rows must be deleted before the nodes row)',
      });

      const vecOrphans = count(
        `SELECT COUNT(*) AS c FROM embedding_vec v
         WHERE NOT EXISTS (SELECT 1 FROM embedding_meta m WHERE m.id = v.id)`
      );
      const metaWithoutVec = count(
        `SELECT COUNT(*) AS c FROM embedding_meta m
         WHERE NOT EXISTS (SELECT 1 FROM embedding_vec v WHERE v.id = m.id)`
      );
      invariants.push({
        name: 'embedding_vec_meta_sync',
        ok: vecOrphans + metaWithoutVec === 0,
        count: vecOrphans + metaWithoutVec,
        detail: `embedding_vec rows without embedding_meta (${vecOrphans}) + embedding_meta rows without a vector (${metaWithoutVec}); the virtual table has no FK cascade`,
      });

      // Durable Memories v1: memory_embedding_vec is a DEDICATED vec0 table
      // (never shared with embedding_vec/embedding_meta) with no FK cascade;
      // a crash mid-delete of a memories row can orphan its vector (nodes-
      // cascade deletion of memories is impossible since v3 — the node_id FK
      // is ON DELETE SET NULL). Deliberately one-directional (unlike
      // embedding_vec_meta_sync) — memories.vec_id is nullable (a memory may
      // have no embedding yet), so a memories row without a vec is normal.
      const memVecOrphans = count(
        `SELECT COUNT(*) AS c FROM memory_embedding_vec v
         WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.vec_id = v.id)`
      );
      invariants.push({
        name: 'memories_vec_orphans',
        ok: memVecOrphans === 0,
        count: memVecOrphans,
        detail: 'memory_embedding_vec rows with no memories row pointing at them — e.g. a crash mid-delete; the virtual table has no FK cascade',
      });

      // Memories v3 (evidence governance) invariants — all informational.
      const danglingSupersede = count(
        `SELECT COUNT(*) AS c FROM memories m
         WHERE m.superseded_by IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM memories x WHERE x.id = m.superseded_by)`
      );
      invariants.push({
        name: 'memories_dangling_supersede',
        ok: danglingSupersede === 0,
        count: danglingSupersede,
        detail: 'superseded_by pointing at a purged memory — broken lineage link (purge is allowed to cause this; informational)',
      });

      const orphanNodeScope = count(
        `SELECT COUNT(*) AS c FROM memories
         WHERE scope = 'node' AND node_id IS NULL AND expired_at IS NULL`
      );
      invariants.push({
        name: 'memories_orphan_node_scope',
        ok: orphanNodeScope === 0,
        count: orphanNodeScope,
        detail: 'live node-scoped memories with NULL node_id — the ON DELETE SET NULL backstop fired without the app-level expiry',
      });

      const nearBand = computeNearPairs(db, { near: MEMORY_NEAR_DUP, far: MEMORY_RECONCILE_REPORT_FAR, limit: 0 });
      invariants.push({
        name: 'memories_near_pair_band',
        ok: true,
        count: nearBand.total_in_band,
        detail: `live memory pairs close enough to be reconciliation candidates (${MEMORY_NEAR_DUP}-${MEMORY_RECONCILE_REPORT_FAR}) across sources${nearBand.truncated ? ' (pairwise cap hit; undercount)' : ''}`,
      });

      const stock = db.prepare(
        `SELECT source,
                SUM(CASE WHEN expired_at IS NULL THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired
         FROM memories GROUP BY source ORDER BY source`
      ).all() as Array<{ source: string; live: number; expired: number }>;
      invariants.push({
        name: 'memories_stock',
        ok: true,
        count: stock.reduce((s, r) => s + r.live, 0),
        detail: stock.map((r) => `${r.source}: ${r.live} live / ${r.expired} expired`).join('; ') || 'no memories',
      });

      const danglingResolved = count(
        `SELECT COUNT(*) AS c FROM relationships r
         WHERE r.resolved_target_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.resolved_target_id)`
      );
      invariants.push({
        name: 'relationships_dangling_resolved_target',
        ok: danglingResolved === 0,
        count: danglingResolved,
        detail: 'relationships.resolved_target_id pointing at a missing node — a missed refreshOnDelete',
      });

      const nearMiss = findNearMissTargets(db);
      const nearMissEdges = nearMiss.reduce((sum, g) => sum + g.edge_count, 0);
      invariants.push({
        name: 'unresolved_near_miss',
        ok: nearMissEdges === 0,
        count: nearMissEdges,
        detail:
          'unresolved references whose target normalizes (filename sanitization + unicode whitespace) to an existing note\'s name or alias — repaired on engine startup and when the target note is created; a count that survives a restart is a link with several candidates or a note that could not be re-saved (see the startup log)',
      });

      // The complement of the check above: these edges DO resolve (tier 2 of the
      // resolver matches on title), so near-miss detection is blind to them — but
      // no consumer other than the engine has a title tier, so they are dead
      // links to every reader of the files themselves.
      const unresolvableByFilename = findFilenameUnresolvableLinks(db);
      const unresolvableEdges = unresolvableByFilename.reduce((sum, g) => sum + g.edge_count, 0);
      invariants.push({
        name: 'links_unresolvable_by_filename',
        ok: unresolvableEdges === 0,
        count: unresolvableEdges,
        detail:
          'links that resolve in the DB but not from the files themselves — the target note\'s stored title differs from its filename, so every consumer but the engine sees a dead link; rewritten on engine startup and on tool writes of the linking note, so a count that survives a restart is a note that could not be re-saved (see the startup log)',
      });

      // attachment_transcripts exists only via migration; guard like vault-stats.
      const hasTranscripts = count(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'attachment_transcripts'"
      ) > 0;
      const hasMaterializedCol = hasTranscripts &&
        (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[])
          .some(c => c.name === 'materialized_node_id');
      const danglingTranscripts = hasMaterializedCol
        ? count(
            `SELECT COUNT(*) AS c FROM attachment_transcripts t
             WHERE t.materialized_node_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = t.materialized_node_id)`
          )
        : 0;
      invariants.push({
        name: 'transcript_dangling_materialized_node',
        ok: danglingTranscripts === 0,
        count: danglingTranscripts,
        detail: 'attachment_transcripts.materialized_node_id pointing at a missing node',
      });

      // Same query as vault-stats. Expected under orphan preservation — ok is
      // always true; the count is informational.
      const orphanFields = count(
        `SELECT COUNT(*) AS c FROM node_fields nf
         WHERE NOT EXISTS (
           SELECT 1 FROM node_types nt
           JOIN schema_field_claims sfc ON sfc.schema_name = nt.schema_type AND sfc.field = nf.field_name
           WHERE nt.node_id = nf.node_id
         )`
      );
      invariants.push({
        name: 'orphan_field_values',
        ok: true,
        count: orphanFields,
        detail: 'node_fields rows not claimed by any schema on the node — expected under orphan preservation; informational',
      });

      // A field named like the type key, accepted by tool writes before #480 and written over
      // the note's types in the file. The note's next write drops it (edits log: value-removed).
      const key = typeKey();
      const typeKeyFieldNotes = (db.prepare(
        `SELECT n.file_path FROM node_fields nf JOIN nodes n ON n.id = nf.node_id
         WHERE nf.field_name = ? ORDER BY n.file_path`
      ).all(key) as Array<{ file_path: string }>).map(r => r.file_path);
      const shown = typeKeyFieldNotes.slice(0, 10);
      invariants.push({
        name: 'type_key_field_values',
        ok: typeKeyFieldNotes.length === 0,
        count: typeKeyFieldNotes.length,
        detail: `notes with a stored field named "${key}", the frontmatter key that holds their types — left by a tool write before #480, `
          + 'which wrote the field over the types in the file, so an edit of the file in Obsidian would make the field\'s value '
          + 'the note\'s types. Any Engine write of the note (for example update-node with only node_id) drops the field, '
          + 're-renders the types from the database and keeps the value in the edits log (value-removed)'
          + (shown.length > 0 ? `: ${shown.join(', ')}${typeKeyFieldNotes.length > shown.length ? ', …' : ''}` : ''),
      });

      return ok({ integrity, size, backup, invariants });
    },
  );
}
