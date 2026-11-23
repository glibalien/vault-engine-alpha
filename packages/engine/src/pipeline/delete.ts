import { unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { safeVaultPath } from './safe-path.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { readNodeResolutionIdentity, refreshTypedReferences } from '../resolver/typed-refresh.js';
import { refreshOnDelete } from '../resolver/refresh.js';
import type { UndoContext } from './types.js';
import { assertExpectedNodeVersion } from './execute.js';
import { readExplicitNullFields } from '../fields/explicit-null.js';
import { captureFileOnlyFields, saveFileOnlyFields } from '../undo/file-only-fields.js';

export interface ProposedDeletion {
  source: 'tool' | 'watcher' | 'reconciler' | 'fullIndex' | 'batch' | 'undo';
  node_id: string;
  file_path: string;
  unlink_file: boolean;
  reason?: string;
  expectedVersion?: number;
}

export interface DeletionResult {
  node_id: string;
  file_path: string;
  file_unlinked: boolean;
  unlink_error?: string;
  /** Live memories expired by this deletion (scope='node' on the node OR evidence-linked to it), reason 'source-deleted'. */
  memories_expired: number;
}

export function executeDeletion(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  deletion: ProposedDeletion,
  undoContext?: UndoContext,
  options: { suppressObservers?: boolean; deferTypedReferences?: boolean } = {},
): DeletionResult {
  const existing = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(deletion.node_id) as
    | { rowid: number }
    | undefined;

  if (!existing) {
    return {
      node_id: deletion.node_id,
      file_path: deletion.file_path,
      file_unlinked: false,
      memories_expired: 0,
    };
  }

  const details: Record<string, unknown> = {
    file_path: deletion.file_path,
    source: deletion.source,
  };
  if (deletion.reason !== undefined) {
    details.reason = deletion.reason;
  }

  const nowIso = new Date().toISOString();
  let memoriesExpired = 0;
  const txn = db.transaction(() => {
    assertExpectedNodeVersion(db, deletion.node_id, deletion.expectedVersion);
    const referenceBefore = readNodeResolutionIdentity(db, deletion.node_id);

    // ── Undo snapshot capture (pre-delete state) ────────────────────
    if (undoContext) {
      const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
        .get(deletion.node_id) as { file_path: string; title: string | null; body: string | null } | undefined;
      if (nodeRow) {
        const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
          .all(deletion.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);
        const fieldsRows = db.prepare(
          'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
        ).all(deletion.node_id);
        const relRows = db.prepare(
          'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
        ).all(deletion.node_id);
        const explicitNullFields = [...readExplicitNullFields(db, deletion.node_id)];

        // OR IGNORE: keep the first snapshot if multiple calls share an
        // operation_id for the same node (defensive; delete-paths normally
        // run once per node).
        const info = db.prepare(`
          INSERT OR IGNORE INTO undo_snapshots (
            operation_id, node_id, file_path, title, body, types, fields, relationships,
            explicit_null_fields, was_deleted, post_mutation_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          undoContext.operation_id,
          deletion.node_id,
          nodeRow.file_path,
          nodeRow.title,
          nodeRow.body,
          JSON.stringify(typesArr),
          JSON.stringify(fieldsRows),
          JSON.stringify(relRows),
          JSON.stringify(explicitNullFields),
        );
        // Text only the file holds goes with the file: keep its lines for the undo (#656).
        if (info.changes > 0) {
          saveFileOnlyFields(db, undoContext.operation_id, deletion.node_id,
            captureFileOnlyFields(db, vaultPath, deletion.node_id, nodeRow.file_path, fieldsRows as Parameters<typeof captureFileOnlyFields>[4]));
        }
      }
    }

    db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(existing.rowid);
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ).run(deletion.node_id, Date.now(), 'file-deleted', JSON.stringify(details));
    // Memories v3 §4b: a deleted note's dependent memories are EXPIRED (visible
    // lineage), never cascade-deleted — before the nodes row goes, because the
    // node_id FK's ON DELETE SET NULL would otherwise make the scope='node'
    // class unfindable. Covers both dependent classes in one statement so a
    // memory that is both node-scoped AND evidence-linked counts once. The FK
    // backstop still fires after this; a LIVE node-scoped row with NULL node_id
    // is the doctor's memories_orphan_node_scope anomaly, expired ones are not.
    // The Settings/Memories.md projection is a rendered view of the memory store, not a
    // source: an owner memory written or edited there records the note as its evidence, but
    // deleting the view must not retire those memories (#300). Only its node-scoped
    // memories (none in practice) follow it.
    const isMemoryProjection = db.prepare(
      `SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = 'vault_engine_projection' AND value_text = 'memories'`,
    ).get(deletion.node_id) !== undefined;
    memoriesExpired = db.prepare(
      `UPDATE memories
       SET expired_at = ?, expire_reason = 'source-deleted', updated_at = ?
       WHERE expired_at IS NULL
         AND ((scope = 'node' AND node_id = ?) OR (? = 0 AND evidence_node_id = ?))`,
    ).run(nowIso, nowIso, deletion.node_id, isMemoryProjection ? 1 : 0, deletion.node_id).changes;
    // Embedding cleanup must precede the nodes DELETE: embedding_meta
    // cascades on nodes deletion, and the vec delete resolves ids via
    // embedding_meta — after the cascade the subquery matches nothing and
    // the vec rows leak (the no-FK virtual table is invisible to cascades).
    db.prepare(
      'DELETE FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = ?)'
    ).run(deletion.node_id);
    db.prepare('DELETE FROM embedding_meta WHERE node_id = ?').run(deletion.node_id);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(deletion.node_id);
    if (!options.deferTypedReferences) refreshTypedReferences(db, { kind: 'node', before: referenceBefore, after: null });
    refreshOnDelete(db, deletion.node_id);
  });
  txn();

  if (memoriesExpired > 0 && !options.suppressObservers) {
    console.log(`[executeDeletion] expired ${memoriesExpired} dependent memor${memoriesExpired === 1 ? 'y' : 'ies'} for ${deletion.node_id} (source-deleted)`);
  }

  let fileUnlinked = false;
  let unlinkError: string | undefined;
  if (deletion.unlink_file) {
    const absPath = safeVaultPath(vaultPath, deletion.file_path);
    writeLock.withLockSync(absPath, () => {
      try {
        unlinkSync(absPath);
        fileUnlinked = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          fileUnlinked = true;
        } else {
          unlinkError = `${code ?? 'UNKNOWN'}: ${(err as Error).message}`;
          console.error(`[executeDeletion] unlink failed for ${deletion.file_path}: ${unlinkError}`);
        }
      }
    });
  }

  return {
    node_id: deletion.node_id,
    file_path: deletion.file_path,
    file_unlinked: fileUnlinked,
    memories_expired: memoriesExpired,
    ...(unlinkError ? { unlink_error: unlinkError } : {}),
  };
}
