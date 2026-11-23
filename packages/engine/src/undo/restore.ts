// src/undo/restore.ts
//
// Conflict detection + restore orchestration. See design spec:
// docs/superpowers/specs/2026-04-19-undo-system-design.md

import { createFieldMap } from '../fields/field-map.js';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { executeMutation } from '../pipeline/execute.js';
import { catalogIdentity, sameCatalogIdentity, shareCatalogs, type CatalogIdentity, type SharedCatalogs } from '../pipeline/shared-catalogs.js';
import { executeDeletion } from '../pipeline/delete.js';
import { WriteLockManager } from '../sync/write-lock.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { sha256 } from '../indexer/hash.js';
import type { Conflict, ConflictReason, KeptMovedFile, RestoreResult, UndoSnapshotRow } from './types.js';
import { getSnapshots, getOperation, markUndone } from './operation.js';
import { restoreSchemaSnapshot, type SchemaRestoreFileAction } from './schema-snapshot.js';
import { restoreGlobalFieldSnapshot, type GlobalFieldRestoreFileAction } from './global-field-snapshot.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { atomicWriteFile, readFileIfExists, readFileOrNull } from '../pipeline/file-writer.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { rejectedValueFields, validateProposedState } from '../validation/validate.js';
import { renderNode } from '../renderer/render.js';
import { computeFieldOrdering, frontmatterKeyOrder } from '../renderer/field-order.js';
import { renderFieldsFile, renderSchemaFile, schemaFilePath } from '../schema/render.js';
import { readExplicitNullFields, renameExplicitNullField } from '../fields/explicit-null.js';
import { assertFieldGuessCandidateIdentityBudget } from '../field-guess/candidate-contract.js';
import { keptFileFields, readFileFields, type FileField } from '../pipeline/kept-file-fields.js';
import { snapshotFileOnlyFields } from './file-only-fields.js';
import { restoreLinkBindings } from './link-bindings.js';
import { restoreMemorySubjects } from './memory-subjects.js';
import { notifyToolWrite, settingsNoteDomain } from '../settings/hook.js';

export interface RestoreOptions {
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
  /** Apply DB restore logic inside a caller-owned rollback transaction, without files. */
  preflight?: boolean;
  /** Simulate node restores inside a caller-owned rollback transaction, without observers or files. */
  simulate?: boolean;
}

/**
 * Where a restore moved a node back from: the path an operation (a rename or a move) had
 * put it at, as it stood just before the restore (#509).
 */
interface MovedFrom {
  file_path: string;
  /** The file there, read before the restore. The restored file keeps the typed values
   * it holds that the watcher did not take (#501), since the file at the restored path
   * is gone. */
  content: string | null;
  /** The node's indexed content hash: what Engine last wrote or read there. */
  content_hash: string | null;
}

interface RestoredNodeWrite {
  file_path: string;
  /** The fields the restore changed (#501). */
  touched: string[];
  moved_from?: MovedFrom;
  /** Fields whose lines only the note's file held before the operation (#656). */
  file_only?: readonly FileField[];
}

interface RestoreFileEffects {
  /** Restored nodes, with the fields each restore changed (#501). */
  nodeWrites: Map<string, RestoredNodeWrite>;
  nodeDeletes: string[];
  schemaActions: SchemaRestoreFileAction[];
  globalFieldActions: GlobalFieldRestoreFileAction[];
}

export function detectConflicts(
  db: Database.Database,
  vaultPath: string,
  operation_id: string,
  snapshots: UndoSnapshotRow[],
  operations_in_this_call: Set<string>,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const snap of snapshots) {
    // Skip was_deleted=1 if current node absent (nothing to reconcile)
    const currentNode = db.prepare('SELECT id, body, content_hash FROM nodes WHERE id = ?').get(snap.node_id) as { id: string; body: string | null; content_hash: string | null } | undefined;

    if (snap.was_deleted === 1) {
      // Undoing a create: we intend to delete the node. No conflict checks needed.
      continue;
    }

    // snap.was_deleted === 0 below.

    // Path occupancy: undo-delete path is occupied by a different node
    if (!currentNode) {
      const occupant = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(snap.file_path) as { id: string } | undefined;
      if (occupant && occupant.id !== snap.node_id) {
        conflicts.push(buildConflict(snap, 'path_occupied', { occupant_node_id: occupant.id }));
        continue;
      }
    } else {
      // Post-op drift
      if (snap.post_mutation_hash && currentNode.content_hash && currentNode.content_hash !== snap.post_mutation_hash) {
        conflicts.push(buildConflict(snap, 'modified_after_operation', {}));
      }
    }

    // Superseded by later op (NOT part of this undo call)
    const superseding = db.prepare(`
      SELECT o.operation_id, o.source_tool, o.timestamp
      FROM undo_snapshots s
      JOIN undo_operations o ON o.operation_id = s.operation_id
      WHERE s.node_id = ?
        AND o.status = 'active'
        AND o.timestamp > (SELECT timestamp FROM undo_operations WHERE operation_id = ?)
    `).all(snap.node_id, operation_id) as Array<{ operation_id: string; source_tool: string; timestamp: number }>;

    const outsideSet = superseding.filter(row => !operations_in_this_call.has(row.operation_id));
    if (outsideSet.length > 0) {
      const existing = conflicts.find(c => c.node_id === snap.node_id && c.reason === 'superseded_by_later_op');
      if (!existing) {
        conflicts.push(buildConflict(
          snap,
          'superseded_by_later_op',
          { modified_by: outsideSet.map(r => `${r.source_tool} at ${new Date(r.timestamp).toISOString()}`) },
        ));
      }
    }
  }
  return conflicts;
}

function buildConflict(
  snap: UndoSnapshotRow,
  reason: ConflictReason,
  extra: Record<string, unknown>,
): Conflict {
  const current_summary: Record<string, unknown> = {};
  const would_restore_summary: Record<string, unknown> = {};
  if (snap.title !== null) would_restore_summary.title = snap.title;
  // Summaries are intentionally thin — the caller can fetch full state via get-node.
  return {
    operation_id: snap.operation_id,
    node_id: snap.node_id,
    file_path: snap.file_path,
    reason,
    ...(extra.modified_by ? { modified_by: extra.modified_by as string[] } : {}),
    current_summary,
    would_restore_summary,
  };
}

export function restoreOperation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  operation_id: string,
  operations_in_this_call: Set<string>,
  opts: RestoreOptions = {},
): RestoreResult {
  const op = getOperation(db, operation_id);
  if (!op) {
    return {
      operations: [],
      conflicts: [],
      total_undone: 0,
      total_conflicts: 0,
      total_skipped: 0,
    };
  }

  const snapshots = getSnapshots(db, operation_id);
  const conflicts = detectConflicts(db, vaultPath, operation_id, snapshots, operations_in_this_call);
  const conflictedIds = new Set(conflicts.map(c => c.node_id));

  // Schema snapshots tied to this operation. Schema-level conflicts are not
  // detected; re-updates between the operation and the undo overwrite without
  // warning. Node-level snapshots still run through detectConflicts.
  const schemaSnaps = db.prepare(
    'SELECT schema_name FROM undo_schema_snapshots WHERE operation_id = ?',
  ).all(operation_id) as Array<{ schema_name: string }>;
  const globalFieldSnaps = tableExists(db, 'undo_global_field_snapshots')
    ? db.prepare(
      'SELECT field_name FROM undo_global_field_snapshots WHERE operation_id = ?',
    ).all(operation_id) as Array<{ field_name: string }>
    : [];

  // Partition resolve_conflicts
  const resolveMap = new Map<string, 'revert' | 'skip'>();
  for (const r of opts.resolve_conflicts ?? []) resolveMap.set(r.node_id, r.action);

  let undone = 0;
  const deletedNodeIds: string[] = [];
  let skipped = 0;
  let blockedSchemaExports: string[] = [];
  let keptFiles: KeptMovedFile[] = [];
  const fileEffects: RestoreFileEffects = {
    nodeWrites: new Map(),
    nodeDeletes: [],
    schemaActions: [],
    globalFieldActions: [],
  };

  if (!opts.dry_run || opts.simulate) {
    const txn = db.transaction(() => {
      // Schema-first pass: restore schema state before any node work so
      // node restores re-validate against the pre-change schema.
      for (const snap of schemaSnaps) {
        const action = restoreSchemaSnapshot(db, vaultPath, operation_id, snap.schema_name, { render: false });
        if (action) fileEffects.schemaActions.push(action);
      }

      // Global fields before node snapshots so later node restores validate
      // against restored global field definitions.
      for (const snap of globalFieldSnaps) {
        const markerNodeIds = (db.prepare(
          'SELECT node_id FROM node_explicit_null_fields WHERE field_name = ? ORDER BY node_id',
        ).all(snap.field_name) as Array<{ node_id: string }>).map(row => row.node_id);
        const snapRow = db.prepare(
          'SELECT was_new, was_renamed_from FROM undo_global_field_snapshots WHERE operation_id = ? AND field_name = ?',
        ).get(operation_id, snap.field_name) as { was_new: number; was_renamed_from: string | null } | undefined;
        const action = restoreGlobalFieldSnapshot(db, operation_id, snap.field_name, vaultPath);
        if (snapRow?.was_renamed_from) {
          renameExplicitNullField(db, snap.field_name, snapRow.was_renamed_from);
        }
        if (action) {
          // Undoing a creation leaves every note as it is, empty values included.
          if (snapRow?.was_new !== 1) action.nodeIds = [...new Set([...action.nodeIds, ...markerNodeIds])].sort();
          fileEffects.globalFieldActions.push(action);
        }
      }

      // Schema/global snapshots can re-enable AI candidate identities. Keep
      // the restore and its undo-status transition atomic with the same bound
      // enforced by ordinary definition mutations.
      assertFieldGuessCandidateIdentityBudget(db);

      // The multi-operation preflight needs only the combined definition
      // state for this invariant. Node restores cannot change that universe;
      // skipping them also guarantees the rollback probe has no write-lock,
      // filesystem, logging, or other observer side effects.
      if (opts.preflight) return;

      // Creates first, then updates, then deletes (within this op)
      const buckets = { create: [] as UndoSnapshotRow[], update: [] as UndoSnapshotRow[], delete: [] as UndoSnapshotRow[] };
      for (const s of snapshots) {
        const resolution = resolveMap.get(s.node_id);
        if (conflictedIds.has(s.node_id) && resolution !== 'revert') {
          if (resolution === 'skip') skipped++;
          continue;
        }
        const currentNode = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(s.node_id);
        if (s.was_deleted === 1) buckets.delete.push(s);
        else if (!currentNode) buckets.create.push(s);
        else buckets.update.push(s);
      }

      for (const s of buckets.create) {
        const written = restoreCreate(db, writeLock, vaultPath, s);
        if (written) {
          fileEffects.nodeWrites.set(written.node_id, {
            file_path: written.file_path, touched: written.touched,
            ...(written.file_only ? { file_only: written.file_only } : {}),
          });
        }
        undone++;
      }
      // Like a rename's reference rewrites (#575), the restores share the node catalogs
      // their writes resolve links against. Each building its own from every node in the
      // vault made an undo cost its notes times the vault's size (#589). A restore that puts
      // back its note's path, title or types builds its own, as before; after a restore that
      // changed its note's path, title, types or aliases, the next ones start a new set.
      // Creates come first and each adds a note, so the set starts here.
      let shared: SharedCatalogs | null = null;
      for (const s of buckets.update) {
        const before = catalogIdentity(db, s.node_id);
        const keepsIdentity = restoreKeepsIdentity(before, s);
        if (keepsIdentity) shared ??= shareCatalogs(db);
        const written = restoreUpdate(db, writeLock, vaultPath, s, keepsIdentity ? shared ?? undefined : undefined);
        if (!keepsIdentity || !sameCatalogIdentity(before, catalogIdentity(db, s.node_id))) shared = null;
        if (written) {
          fileEffects.nodeWrites.set(written.node_id, {
            file_path: written.file_path,
            touched: written.touched,
            ...(written.moved_from ? { moved_from: written.moved_from } : {}),
            ...(written.file_only ? { file_only: written.file_only } : {}),
          });
        }
        undone++;
      }
      for (const s of buckets.delete) {
        // A note created and then renamed or moved has its file at its current path (#509).
        const current = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(s.node_id) as
          | { file_path: string }
          | undefined;
        restoreDelete(db, writeLock, vaultPath, s, opts.simulate);
        fileEffects.nodeDeletes.push(current?.file_path ?? s.file_path);
        deletedNodeIds.push(s.node_id);
        undone++;
      }

      // Links the operation bound elsewhere without writing their own notes go back to the
      // notes they were bound to, now that those exist again (#665).
      restoreLinkBindings(db, operation_id);
      // Memory subjects the operation moved off those notes go back to them (#554).
      restoreMemorySubjects(db, operation_id);

      markUndone(db, operation_id);
    });
    txn();
    // Files change only once the restore has committed.
    if (!opts.preflight && !opts.simulate) {
      ({ blockedSchemas: blockedSchemaExports, keptFiles } = applyRestoreFileEffects(db, writeLock, vaultPath, fileEffects));
      // A restore that removed, rewrote or moved a Settings/Models/ note refreshes the
      // cached model catalog, as a tool write or delete does (#595). The hook ignores
      // every other path.
      for (const path of restoredFilePaths(fileEffects)) notifyToolWrite(path);
    }
  }

  const restoredNodeIds = new Set(fileEffects.nodeWrites.keys());
  for (const action of fileEffects.globalFieldActions) {
    for (const nodeId of action.nodeIds) restoredNodeIds.add(nodeId);
  }

  return {
    operations: [{
      operation_id,
      node_count: op.node_count,
      schema_count: op.schema_count ?? 0,
      global_field_count: op.global_field_count ?? 0,
      status: opts.dry_run ? 'would_undo' : 'undone',
    }],
    conflicts,
    total_undone: opts.dry_run ? 0 : undone,
    total_conflicts: conflicts.length,
    total_skipped: opts.dry_run ? 0 : skipped,
    restored_node_ids: opts.dry_run ? [] : [...restoredNodeIds],
    deleted_node_ids: opts.dry_run ? [] : deletedNodeIds,
    ...(blockedSchemaExports.length ? { blocked_schema_exports: blockedSchemaExports } : {}),
    ...(keptFiles.length ? { kept_files: keptFiles } : {}),
  };
}

function restoredFilePaths(effects: RestoreFileEffects): Set<string> {
  const paths = new Set(effects.nodeDeletes);
  for (const { file_path, moved_from } of effects.nodeWrites.values()) {
    paths.add(file_path);
    if (moved_from) paths.add(moved_from.file_path);
  }
  return paths;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}

/**
 * The fields whose stored values a restore of `snapshotFields` changes on the node: set,
 * changed or removed. A render of the restored note writes them from the database, never
 * as the file shows them (#501).
 */
function fieldsRestoreChanges(db: Database.Database, nodeId: string, snapshotFields: Record<string, unknown>): string[] {
  const current = createFieldMap<unknown>();
  const rows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  for (const row of rows) current[row.field_name] = reconstructValue(row);
  const names = new Set([...Object.keys(current), ...Object.keys(snapshotFields)]);
  return [...names].filter(name => !isDeepStrictEqual(
    Object.hasOwn(current, name) ? current[name] : undefined,
    Object.hasOwn(snapshotFields, name) ? snapshotFields[name] : undefined,
  ));
}

/** Restore a deleted node by re-creating it with its original id. */
function restoreCreate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): { node_id: string; file_path: string; touched: string[]; file_only?: readonly FileField[] } | null {
  if (snap.types === null) return null;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields = createFieldMap<unknown>();
  const rawFieldTexts = createFieldMap<string>();
  for (const r of fieldsRows) {
    fields[r.field_name] = reconstructValue(r);
    if (r.value_raw_text !== null && r.value_raw_text !== undefined) rawFieldTexts[r.field_name] = r.value_raw_text;
  }

  const touched = fieldsRestoreChanges(db, snap.node_id, fields);
  const fileOnly = snapshotFileOnlyFields(snap.file_only_fields);
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    raw_field_texts: rawFieldTexts,
    explicitNullFields: JSON.parse(snap.explicit_null_fields ?? '[]') as string[],
    body: snap.body ?? '',
    db_only: true,
    touchedFields: touched,
    ...(fileOnly.length > 0 ? { restoredFileFields: fileOnly } : {}),
  });
  return { node_id: result.node_id, file_path: result.file_path, touched, ...(fileOnly.length > 0 ? { file_only: fileOnly } : {}) };
}

/**
 * Whether restoring `snap` leaves its note's path, title and types as they are now, so the
 * write can resolve against catalogs built before it (an undo write keeps the title given).
 */
function restoreKeepsIdentity(current: CatalogIdentity | null, snap: UndoSnapshotRow): boolean {
  if (current === null || snap.types === null) return false;
  const types = [...(JSON.parse(snap.types) as string[])].sort();
  return current.file_path === snap.file_path
    && current.title === (snap.title ?? '')
    && isDeepStrictEqual(current.types, types);
}

/** Restore an updated node to its pre-state. */
function restoreUpdate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
  /** Catalogs shared with the other restores of the operation (#589). */
  catalogs?: SharedCatalogs,
): { node_id: string; file_path: string; touched: string[]; moved_from?: MovedFrom; file_only?: readonly FileField[] } | null {
  if (snap.types === null) return null;
  // An operation that renamed or moved the note left its file at another path (#509).
  const current = db.prepare('SELECT file_path, content_hash FROM nodes WHERE id = ?').get(snap.node_id) as
    | { file_path: string; content_hash: string | null }
    | undefined;
  const movedFrom: MovedFrom | undefined = current !== undefined && current.file_path !== snap.file_path
    ? {
      file_path: current.file_path,
      content: readFileOrNull(safeVaultPath(vaultPath, current.file_path)),
      content_hash: current.content_hash,
    }
    : undefined;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields = createFieldMap<unknown>();
  const rawFieldTexts = createFieldMap<string>();
  for (const r of fieldsRows) {
    fields[r.field_name] = reconstructValue(r);
    if (r.value_raw_text !== null && r.value_raw_text !== undefined) rawFieldTexts[r.field_name] = r.value_raw_text;
  }

  const touched = fieldsRestoreChanges(db, snap.node_id, fields);
  const fileOnly = restorableFileOnlyFields(vaultPath, snap, current, movedFrom, touched);
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    raw_field_texts: rawFieldTexts,
    explicitNullFields: JSON.parse(snap.explicit_null_fields ?? '[]') as string[],
    body: snap.body ?? '',
    db_only: true,
    touchedFields: touched,
    ...(fileOnly.length > 0 ? { restoredFileFields: fileOnly } : {}),
    ...(catalogs ? { referenceCatalog: catalogs.referenceCatalog, targetLookup: catalogs.targetLookup } : {}),
    // The note's file is still at the path it is moved back from: the render reads its
    // fields and key order there, as renderRestoredNodeFile does.
    ...(movedFrom?.content != null
      ? { previewContent: movedFrom.content, previewKeyOrder: frontmatterKeyOrder(movedFrom.content) }
      : {}),
  });
  return {
    node_id: result.node_id, file_path: result.file_path, touched,
    ...(movedFrom ? { moved_from: movedFrom } : {}),
    ...(fileOnly.length > 0 ? { file_only: fileOnly } : {}),
  };
}

/**
 * The snapshot's file-only fields an update's restore writes back (#656): only those the
 * restore changes, since a field it leaves alone keeps what the file shows now, as before.
 * None when the file holds an edit the database has not read: the restore cannot tell that
 * text from the operation's, and must not put old text over it.
 */
function restorableFileOnlyFields(
  vaultPath: string,
  snap: UndoSnapshotRow,
  current: { file_path: string; content_hash: string | null } | undefined,
  movedFrom: MovedFrom | undefined,
  touched: readonly string[],
): FileField[] {
  const fields = snapshotFileOnlyFields(snap.file_only_fields);
  if (fields.length === 0 || current === undefined) return fields;
  const content = movedFrom !== undefined ? movedFrom.content : readFileOrNull(safeVaultPath(vaultPath, current.file_path));
  if (content !== null && (current.content_hash === null || sha256(content) !== current.content_hash)) return [];
  const changed = new Set(touched);
  return fields.filter(field => changed.has(field.name));
}

/** Undo a create by deleting the node that was created. */
function restoreDelete(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
  simulate = false,
): void {
  executeDeletion(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    unlink_file: false,
  }, undefined, { suppressObservers: simulate });
}

function applyRestoreFileEffects(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  effects: RestoreFileEffects,
): { blockedSchemas: string[]; keptFiles: KeptMovedFile[] } {
  const blockedSchemas = new Set<string>();
  for (const action of effects.schemaActions) {
    if (action.type === 'render') {
      if (!renderRestoredSchemaFile(db, vaultPath, action.schema_name)) blockedSchemas.add(action.schema_name);
    } else {
      deleteRestoredSchemaFile(vaultPath, action.schema_name);
    }
  }

  applyGlobalFieldFileActions(db, writeLock, vaultPath, effects.globalFieldActions, blockedSchemas);

  for (const filePath of effects.nodeDeletes) {
    unlinkRestoredNodeFile(writeLock, vaultPath, filePath);
  }

  for (const [nodeId, { touched, moved_from, file_only }] of effects.nodeWrites) {
    renderRestoredNodeFile(db, writeLock, vaultPath, nodeId, touched, moved_from?.content ?? null, file_only ?? []);
  }
  // Each moved note's file is written at its restored path first, so a failure leaves
  // two files rather than none.
  const keptFiles: KeptMovedFile[] = [];
  for (const [nodeId, { file_path, moved_from }] of effects.nodeWrites) {
    if (!moved_from) continue;
    const kept = removeMovedFromFile(db, writeLock, vaultPath, nodeId, file_path, moved_from);
    if (kept) keptFiles.push(kept);
  }
  return { blockedSchemas: [...blockedSchemas].sort(), keptFiles };
}

/**
 * Remove the file at the path a restore moved a note back from (#509), once the restore
 * has committed and written the note at its restored path. The file goes only while it is
 * still the one Engine wrote or last read there: its bytes hash to the content hash the
 * database held for the note just before the restore. A file changed since then is kept
 * and reported. A file at a path a note now holds again, or that is the restored file
 * itself (a case-only rename on a case-insensitive file system), is left alone.
 *
 * The node no longer has the path in the database and the removal holds the write lock,
 * as a tool delete does, so the watcher's unlink event finds no node to delete.
 */
function removeMovedFromFile(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  restoredPath: string,
  movedFrom: MovedFrom,
): KeptMovedFile | null {
  if (db.prepare('SELECT 1 FROM nodes WHERE file_path = ?').get(movedFrom.file_path) !== undefined) return null;
  const absPath = safeVaultPath(vaultPath, movedFrom.file_path);
  const restoredAbs = safeVaultPath(vaultPath, restoredPath);
  const kept = (reason: KeptMovedFile['reason'], err?: unknown): KeptMovedFile => ({
    node_id: nodeId,
    file_path: movedFrom.file_path,
    restored_file_path: restoredPath,
    reason,
    ...(err !== undefined ? { error: err instanceof Error ? err.message : String(err) } : {}),
  });
  return writeLock.withLockSync(absPath, () => {
    let content: string | null;
    try {
      content = readFileIfExists(absPath);
      if (content === null) return null;
      // Never remove the note's only file.
      const file = statSync(absPath);
      const restored = statSync(restoredAbs, { throwIfNoEntry: false });
      if (restored === undefined || (restored.dev === file.dev && restored.ino === file.ino)) return null;
    } catch (err) {
      return kept('remove_failed', err);
    }
    if (movedFrom.content_hash === null || sha256(content) !== movedFrom.content_hash) return kept('changed');
    try {
      unlinkSync(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return kept('remove_failed', err);
    }
    return null;
  });
}

function applyGlobalFieldFileActions(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  actions: GlobalFieldRestoreFileAction[],
  blockedSchemas: Set<string>,
): void {
  if (actions.length === 0) return;

  if (actions.some(action => action.renderFieldsCatalog)) {
    renderFieldsFile(db, vaultPath);
  }

  const schemaNames = new Set<string>();
  // Each note, with the fields whose values a restore put back on it.
  const nodeFields = new Map<string, Set<string>>();
  for (const action of actions) {
    for (const schemaName of action.schemaNames) schemaNames.add(schemaName);
    for (const nodeId of action.nodeIds) {
      const fields = nodeFields.get(nodeId) ?? new Set<string>();
      for (const field of action.fieldNames ?? []) fields.add(field);
      nodeFields.set(nodeId, fields);
    }
  }

  for (const schemaName of [...schemaNames].sort()) {
    if (!renderRestoredSchemaFile(db, vaultPath, schemaName)) blockedSchemas.add(schemaName);
  }
  for (const nodeId of [...nodeFields.keys()].sort()) {
    renderRestoredNodeFile(db, writeLock, vaultPath, nodeId, nodeFields.get(nodeId)!);
  }
}

function renderRestoredSchemaFile(db: Database.Database, vaultPath: string, schemaName: string): boolean {
  return renderSchemaFile(db, vaultPath, schemaName);
}

function deleteRestoredSchemaFile(vaultPath: string, schemaName: string): void {
  try {
    // Null for a name outside .schemas/ (or over _fields.yaml): such a file is never touched.
    const absPath = schemaFilePath(vaultPath, schemaName);
    if (absPath !== null && existsSync(absPath)) unlinkSync(absPath);
  } catch {
    // Preserve the historical best-effort behavior for schema YAML deletion.
  }
}

function unlinkRestoredNodeFile(writeLock: WriteLockManager, vaultPath: string, filePath: string): void {
  const absPath = safeVaultPath(vaultPath, filePath);
  writeLock.withLockSync(absPath, () => {
    try {
      unlinkSync(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  });
}

function renderRestoredNodeFile(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  touched: Iterable<string>,
  /** The note's file at the path the restore moved it back from, read before the restore (#509). */
  movedFromContent: string | null = null,
  /** Fields whose lines only the note's file held before the operation (#656). */
  fileOnly: readonly FileField[] = [],
): void {
  const node = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as
    | { file_path: string; title: string | null; body: string | null }
    | undefined;
  if (!node) return;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order')
    .all(nodeId) as Array<{ schema_type: string }>).map(r => r.schema_type);
  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?'
  ).all(nodeId) as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;

  const fields = createFieldMap<unknown>();
  const rawFieldTexts = createFieldMap<string>();
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
    if (row.value_raw_text !== null) rawFieldTexts[row.field_name] = row.value_raw_text;
  }

  const { claimsByType, globalFields } = loadSchemaContext(db, types);
  const validation = validateProposedState(fields, types, claimsByType, globalFields, { skipDefaults: true });
  const finalFields = createFieldMap<unknown>();
  for (const [fieldName, cv] of Object.entries(validation.coerced_state)) {
    finalFields[fieldName] = cv.value;
  }
  // The file is a projection of the database, so it holds every value the
  // database does, one its definition now rejects included, as the pipeline
  // keeps such a value on undo. Left out, a re-index would delete it (#499).
  for (const fieldName of rejectedValueFields(validation, fields)) {
    finalFields[fieldName] = fields[fieldName];
  }

  const referenceFields = new Set<string>();
  const listReferenceFields = new Set<string>();
  for (const [name, gf] of globalFields) {
    if (gf.field_type === 'reference') referenceFields.add(name);
    if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
  }

  const orphanRawValues = createFieldMap<string>();
  for (const fieldName of validation.orphan_fields) {
    if (Object.hasOwn(rawFieldTexts, fieldName)) orphanRawValues[fieldName] = rawFieldTexts[fieldName];
  }

  const absPath = safeVaultPath(vaultPath, node.file_path);
  const explicitNullFields = readExplicitNullFields(db, nodeId);
  // A note moved back reads its file where the operation had put it, as the pipeline did.
  const currentContent = movedFromContent ?? readFileOrNull(absPath);
  // Typed values the watcher did not take stay in the file as typed (#501), decided as the
  // pipeline decides it for an undo: from the restored state, never for a field the restore
  // changed.
  const projection = settingsNoteDomain(node.file_path) !== null || Object.hasOwn(finalFields, 'vault_engine_projection');
  const keptFields = projection ? new Map<string, FileField>() : keptFileFields(readFileFields(currentContent), {
    stored: finalFields,
    touched,
    explicitNull: explicitNullFields,
    effectiveFields: validation.effective_fields,
    keepUnstored: false,
  });
  // Lines only the file held before the operation go back where the restored state does not
  // hold them, as the pipeline decided for the database's render (#656).
  if (!projection && fileOnly.length > 0) {
    const restored = keptFileFields(fileOnly, {
      stored: finalFields,
      touched: [],
      explicitNull: explicitNullFields,
      effectiveFields: validation.effective_fields,
      keepUnstored: true,
    });
    for (const [name, field] of restored) keptFields.set(name, field);
  }
  const keptUnclaimed = [...keptFields.keys()].filter(f => !validation.effective_fields.has(f));
  const orderFields = createFieldMap(finalFields);
  for (const [name, field] of keptFields) {
    if (!Object.hasOwn(orderFields, name)) orderFields[name] = field.raw;
  }
  const content = renderNode({
    types,
    fields: finalFields,
    body: node.body ?? '',
    fieldOrdering: computeFieldOrdering(validation.effective_fields, [...validation.orphan_fields, ...keptUnclaimed], orderFields,
      Object.hasOwn(finalFields, 'vault_engine_projection') ? [] : frontmatterKeyOrder(currentContent),
      explicitNullFields),
    referenceFields,
    listReferenceFields,
    orphanRawValues,
    explicitNullFields,
    ...(keptFields.size > 0 ? { keptFields } : {}),
  });

  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
  writeLock.withLockSync(absPath, () => {
    atomicWriteFile(absPath, content, tmpDir);
  });
}

export interface RestoreManyParams {
  operation_ids?: string[];
  since?: string;
  until?: string;
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
}

export function restoreMany(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  params: RestoreManyParams,
): RestoreResult {
  // Resolve target operation_ids
  let ids: string[];
  if (params.operation_ids && params.operation_ids.length > 0) {
    ids = params.operation_ids;
  } else {
    const clauses: string[] = ["status = 'active'"];
    const values: (string | number)[] = [];
    if (params.since) { clauses.push('timestamp >= ?'); values.push(new Date(params.since).getTime()); }
    if (params.until) { clauses.push('timestamp <= ?'); values.push(new Date(params.until).getTime()); }
    const rows = db.prepare(
      `SELECT operation_id FROM undo_operations WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC`
    ).all(...values) as Array<{ operation_id: string }>;
    ids = rows.map(r => r.operation_id);
  }

  // Sort reverse chrono
  const idRows = db.prepare(
    `SELECT operation_id, timestamp FROM undo_operations WHERE operation_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as Array<{ operation_id: string; timestamp: number }>;
  idRows.sort((a, b) => b.timestamp - a.timestamp);

  const inCall = new Set(idRows.map(r => r.operation_id));
  // Dry-run must reject the same combined definition state as live undo.
  // Multi-operation live undo also needs this rollback-only pass because its
  // ordinary per-operation transactions commit independently.
  if (idRows.length > 0 && (params.dry_run === true || idRows.length > 1)) {
    preflightRestoreOperations(
      db,
      writeLock,
      vaultPath,
      idRows,
      inCall,
      params.resolve_conflicts,
    );
  }
  const aggregate: RestoreResult = {
    operations: [],
    conflicts: [],
    total_undone: 0,
    total_conflicts: 0,
    total_skipped: 0,
    restored_node_ids: [],
    deleted_node_ids: [],
  };

  const restoredIds = new Set<string>();
  const deletedIds = new Set<string>();
  const blockedSchemas = new Set<string>();
  const keptFiles: KeptMovedFile[] = [];
  const simulate = params.dry_run === true && idRows.length > 1;
  // Preview needs the same intermediate DB state as sequential live undo.
  // Use a private lock manager so the caller's lock observers remain untouched.
  const restoreLock = simulate ? new WriteLockManager() : writeLock;
  const restore = () => {
    for (const row of idRows) {
      const result = restoreOperation(db, restoreLock, vaultPath, row.operation_id, inCall, {
        dry_run: params.dry_run,
        resolve_conflicts: params.resolve_conflicts,
        simulate,
      });
      aggregate.operations.push(...result.operations);
      aggregate.conflicts.push(...result.conflicts);
      aggregate.total_undone += result.total_undone;
      aggregate.total_conflicts += result.total_conflicts;
      aggregate.total_skipped += result.total_skipped;
      for (const id of result.restored_node_ids ?? []) restoredIds.add(id);
      for (const id of result.deleted_node_ids ?? []) deletedIds.add(id);
      for (const schema of result.blocked_schema_exports ?? []) blockedSchemas.add(schema);
      keptFiles.push(...result.kept_files ?? []);
    }
  };
  if (simulate) {
    const rollbackSignal = {};
    try {
      db.transaction(() => {
        restore();
        throw rollbackSignal;
      })();
    } catch (error) {
      if (error !== rollbackSignal) throw error;
    }
  } else {
    restore();
  }
  aggregate.restored_node_ids = [...restoredIds];
  aggregate.deleted_node_ids = [...deletedIds];
  if (blockedSchemas.size) aggregate.blocked_schema_exports = [...blockedSchemas].sort();
  if (keptFiles.length) aggregate.kept_files = keptFiles;

  return aggregate;
}

function preflightRestoreOperations(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  idRows: ReadonlyArray<{ operation_id: string }>,
  operationsInThisCall: Set<string>,
  resolveConflicts: RestoreOptions['resolve_conflicts'],
): void {
  const rollbackSignal = {};
  const preflight = db.transaction(() => {
    for (const row of idRows) {
      restoreOperation(db, writeLock, vaultPath, row.operation_id, operationsInThisCall, {
        dry_run: false,
        resolve_conflicts: resolveConflicts,
        preflight: true,
      });
    }
    throw rollbackSignal;
  });

  try {
    preflight();
  } catch (error) {
    if (error !== rollbackSignal) throw error;
  }
}
