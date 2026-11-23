// src/schema/propagate.ts
//
// Schema change propagation: when schema claims change, affected nodes
// are re-rendered through the write pipeline (source='propagation').
// Defaults are populated for added claims; removed claims become orphans.

import { createFieldMap } from '../fields/field-map.js';
import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { mergeFieldClaims } from '../validation/merge.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { resolveDefaultValue } from '../validation/resolve-default.js';
import type { FileContext } from '../validation/resolve-default.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { assertMutationFilePresent, executeMutation } from '../pipeline/execute.js';
import { PipelineError } from '../pipeline/types.js';
import { SchemaValidationError, groupValidationIssues, type PerNodeIssue, type ValidationGroup } from './errors.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import { loadNodeState, type LoadedNodeState } from '../pipeline/node-state.js';
import type { ClaimDiffShape } from './claims.js';

export interface PropagationOptions {
  fsRollback?: { push(undo: () => void): void };
  preview?: boolean;
  operation_id?: string;
}

export interface PropagationResult {
  nodes_affected: number;
  nodes_rerendered: number;
  defaults_populated: number;
  fields_orphaned: number;
  /** IDs of nodes re-rendered through the pipeline (embedding refresh
   *  targets — the caller enqueues them after the transaction commits). */
  changed_node_ids: string[];
  // Preview-mode augmentations (present iff opts.preview was true):
  validation_groups?: ValidationGroup[];
  orphaned_field_names?: Array<{ field: string; count: number }>;
}

interface ClaimDiff {
  added: string[];    // field names added to claims
  removed: string[];  // field names removed from claims
  changed: string[];  // field names with changed metadata
  /** Changed metadata that can alter validation or rendered Markdown. Omitted
   *  only by legacy/manual callers, which retain the old changed behavior. */
  renderChanged?: string[];
}

// Effects on existing nodes. Validation changes retain the full propagation
// pipeline, including its existing default-population and validation policies.
const CLAIM_PROPERTY_EFFECTS = {
  sort_order: 'render',
  required: 'validation',
  default_value: 'validation',
  enum_values_override: 'validation',
  enum_groups_override: 'metadata',
  label: 'metadata',
  description: 'metadata',
  ai_guessable: 'metadata',
} as const satisfies Record<Exclude<keyof ClaimDiffShape, 'field'>, 'render' | 'validation' | 'metadata'>;
const CLAIM_PROPERTIES = Object.keys(CLAIM_PROPERTY_EFFECTS) as Array<keyof typeof CLAIM_PROPERTY_EFFECTS>;

/**
 * Diff old claims against new claims to determine what changed.
 */
export function diffClaims(
  oldClaims: ClaimDiffShape[],
  newClaims: ClaimDiffShape[],
): ClaimDiff {
  const oldSet = new Map(oldClaims.map(c => [c.field, c]));
  const newSet = new Map(newClaims.map(c => [c.field, c]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const renderChanged: string[] = [];

  for (const [field] of newSet) {
    if (!oldSet.has(field)) added.push(field);
    else {
      const o = oldSet.get(field)!;
      const n = newSet.get(field)!;
      let hasChange = false;
      let requiresPropagation = false;
      for (const property of CLAIM_PROPERTIES) {
        const differs = property === 'default_value' || property === 'enum_values_override' || property === 'enum_groups_override'
          ? JSON.stringify(o[property]) !== JSON.stringify(n[property])
          : o[property] !== n[property];
        if (!differs) continue;
        hasChange = true;
        if (CLAIM_PROPERTY_EFFECTS[property] !== 'metadata') requiresPropagation = true;
      }
      if (hasChange) changed.push(field);
      if (requiresPropagation) renderChanged.push(field);
    }
  }

  for (const [field] of oldSet) {
    if (!newSet.has(field)) removed.push(field);
  }

  return { added, removed, changed, renderChanged };
}

/**
 * Build a FileContext for date-token resolution of adoption defaults.
 * Falls back to { mtimeMs: now, createdAtMs: null } if the file is missing.
 */
function buildFileContext(db: Database.Database, vaultPath: string, nodeId: string, filePath: string): FileContext {
  const absPath = safeVaultPath(vaultPath, filePath);
  let mtimeMs = Date.now();
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    // File missing — fall back to now; caller continues regardless
  }
  const row = db.prepare('SELECT created_at FROM nodes WHERE id = ?').get(nodeId) as { created_at: number | null } | undefined;
  return { mtimeMs, createdAtMs: row?.created_at ?? null };
}

/**
 * Shared per-node primitive: load node state, inject adoption defaults,
 * call executeMutation with source='propagation'.
 * Returns null if the node disappeared between query and processing.
 */
function rerenderNodeThroughPipeline(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  adoptionDefaults: Record<string, unknown>,
  syncLogger: SyncLogger | undefined,
  preLoaded?: LoadedNodeState,
  opts?: {
    dbOnly?: boolean;
    operation_id?: string;
    fsRollback?: { push(undo: () => void): void };
    /** Fields the operation changed in the database before this re-render (#501). */
    touchedFields?: readonly string[];
  },
): { node_id: string; file_path: string; file_written: boolean } | null {
  const state = preLoaded ?? loadNodeState(db, nodeId);
  if (!state) return null;

  // DB-only simulation must still satisfy the live propagation prerequisite.
  if (opts?.dbOnly) {
    assertMutationFilePresent(db, vaultPath, {
      source: 'propagation', node_id: nodeId, file_path: state.file_path, db_only: false,
    });
  }

  // Merge adoption defaults into currentFields — never overwrite existing values.
  const mergedFields = createFieldMap(state.currentFields);
  for (const [field, value] of Object.entries(adoptionDefaults)) {
    if (!Object.hasOwn(mergedFields, field) && !state.explicitNullFields.has(field)) {
      mergedFields[field] = value;
    }
  }

  const undoCtx = opts?.operation_id ? { operation_id: opts.operation_id } : undefined;

  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'propagation',
    node_id: nodeId,
    file_path: state.file_path,
    title: state.title,
    types: state.types,
    fields: mergedFields,
    body: state.body,
    raw_field_texts: state.rawFieldTexts,
    db_only: opts?.dbOnly === true,
    ...(opts?.touchedFields !== undefined ? { touchedFields: opts.touchedFields } : {}),
  }, syncLogger, undoCtx, opts?.fsRollback);

  return {
    node_id: result.node_id,
    file_path: result.file_path,
    file_written: result.file_written,
  };
}

/**
 * Propagate schema claim changes to all affected nodes.
 * Re-renders affected nodes through executeMutation and populates defaults
 * for added claims. Emits `field-defaulted` and `fields-orphaned` edits_log
 * rows post-mutation with source='propagation'.
 *
 * Per-node PipelineError with validation issues are collected across the full
 * loop. If any are collected, a SchemaValidationError is thrown at the end,
 * which rolls back the enclosing db.transaction. On any transaction failure,
 * reverse completed file writes through the pipeline's hash-guarded callbacks;
 * files changed or moved by an external editor are left untouched.
 */
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  syncLogger?: SyncLogger,
  opts: PropagationOptions = {},
): PropagationResult {
  const preview = opts.preview === true;
  const orphanCounts = new Map<string, number>();

  const result: PropagationResult = {
    nodes_affected: 0,
    nodes_rerendered: 0,
    defaults_populated: 0,
    fields_orphaned: 0,
    changed_node_ids: [],
  };
  const renderChanged = diff.renderChanged ?? diff.changed;

  if (diff.added.length === 0 && diff.removed.length === 0 && renderChanged.length === 0) {
    if (preview) {
      result.validation_groups = [];
      result.orphaned_field_names = [];
    }
    return result;
  }

  const nodeIds = (db.prepare('SELECT node_id FROM node_types WHERE schema_type = ?').all(schemaName) as Array<{ node_id: string }>)
    .map(r => r.node_id);

  if (nodeIds.length === 0) {
    if (preview) {
      result.validation_groups = [];
      result.orphaned_field_names = [];
    }
    return result;
  }
  result.nodes_affected = nodeIds.length;

  const trigger = `update-schema: ${schemaName}`;
  const mergeCache = new Map<string, ReturnType<typeof mergeFieldClaims>>();
  const insertLog = db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)');

  const perNodeIssues: PerNodeIssue[] = [];
  const fsUndos: Array<() => void> = [];

  const runLoop = db.transaction(() => {
    for (const nodeId of nodeIds) {
      const state = loadNodeState(db, nodeId);
      if (!state) continue;

      // Cache merge results by sorted type-set key
      const typeKey = [...state.types].sort().join(',');
      let mergeResult = mergeCache.get(typeKey);
      if (!mergeResult) {
        const ctx = loadSchemaContext(db, state.types);
        mergeResult = mergeFieldClaims(state.types, ctx.claimsByType, ctx.globalFields);
        mergeCache.set(typeKey, mergeResult);
      }
      const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

      // Identify fields that need adoption defaults on this node.
      const adoptionFieldsToDefault: Array<{ field: string; value: unknown }> = [];
      let fileCtx: FileContext | null = null;
      for (const field of diff.added) {
        if (Object.hasOwn(state.currentFields, field) || state.explicitNullFields.has(field)) continue;
        const ef = effectiveFields.get(field);
        if (!ef?.resolved_required) continue;
        if (ef.resolved_default_value === null || ef.resolved_default_value === undefined) continue;

        if (fileCtx === null) fileCtx = buildFileContext(db, vaultPath, nodeId, state.file_path);
        adoptionFieldsToDefault.push({
          field,
          value: resolveDefaultValue(ef.resolved_default_value, fileCtx),
        });
      }

      // Resolve default source ('global' vs 'claim') for each adoption default
      // from the already-computed mergeResult.effective_fields.
      const adoptionDefaults = createFieldMap<unknown>();
      const adoptionSources = createFieldMap<'global' | 'claim'>();
      for (const { field, value } of adoptionFieldsToDefault) {
        adoptionDefaults[field] = value;
        adoptionSources[field] = effectiveFields.get(field)?.default_source ?? 'global';
      }

      // Pipeline call — collect validation failures instead of re-throwing
      let pipelineResult: { node_id: string; file_path: string; file_written: boolean } | null = null;
      try {
        pipelineResult = rerenderNodeThroughPipeline(
          db, writeLock, vaultPath, nodeId, adoptionDefaults, syncLogger, state,
          { dbOnly: preview, operation_id: opts.operation_id, fsRollback: fsUndos },
        );
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          for (const issue of err.validation.issues) {
            perNodeIssues.push({
              node_id: nodeId,
              title: state.title,
              field: issue.field,
              code: issue.code,
              value: state.currentFields[issue.field],
            });
          }
          continue;
        }
        throw err;
      }
      if (!pipelineResult) continue;

      // Post-mutation emission: field-defaulted (adoption)
      const now = Date.now();
      for (const [field, value] of Object.entries(adoptionDefaults)) {
        if (!preview) {
          insertLog.run(nodeId, now, 'field-defaulted', JSON.stringify({
            source: 'propagation',
            field,
            default_value: value,
            default_source: adoptionSources[field],
            trigger,
            node_types: state.types,
          }));
        }
        result.defaults_populated++;
      }

      // Post-mutation emission: fields-orphaned (one row per node, listing all)
      const orphanedInThisNode = diff.removed.filter(
        f => Object.hasOwn(state.currentFields, f) || state.explicitNullFields.has(f),
      );
      if (orphanedInThisNode.length > 0) {
        if (!preview) {
          insertLog.run(nodeId, now, 'fields-orphaned', JSON.stringify({
            source: 'propagation',
            trigger,
            orphaned_fields: orphanedInThisNode,
            node_types: state.types,
          }));
        }
        result.fields_orphaned += orphanedInThisNode.length;
        if (preview) {
          for (const f of orphanedInThisNode) {
            orphanCounts.set(f, (orphanCounts.get(f) ?? 0) + 1);
          }
        }
      }

      if (pipelineResult.file_written) {
        result.nodes_rerendered++;
        // file_written is the pipeline's content-changed signal — a no-op
        // re-render would hash-skip anyway, so only real changes enqueue.
        // Preview runs are db_only — no refresh needed.
        if (!preview) result.changed_node_ids.push(nodeId);
      }
    }

    if (perNodeIssues.length > 0) {
      const groups = groupValidationIssues(perNodeIssues);
      if (groups.length > 0) {
        if (preview) {
          result.validation_groups = groups;
        } else {
          throw new SchemaValidationError(groups);
        }
      }
    }
  });

  try {
    runLoop();
  } catch (err) {
    // The SQLite transaction has rolled back. Revert only bytes still owned
    // by this attempt, in reverse order, using the existing pipeline seam.
    // One failed restore must not prevent the remaining files from recovering.
    for (let i = fsUndos.length - 1; i >= 0; i--) {
      try {
        fsUndos[i]!();
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error(`[schema-propagation] filesystem rollback failed: ${message}`);
      }
    }
    throw err;
  }

  for (const undo of fsUndos) opts.fsRollback?.push(undo);

  if (preview) {
    result.validation_groups = result.validation_groups ?? [];
    result.orphaned_field_names = Array.from(orphanCounts.entries())
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
  }
  return result;
}

/**
 * Re-render all nodes that have a specific field.
 * Used after rename-global-field and update-global-field type changes.
 * No adoption/orphan events — schema claims don't change here.
 *
 * The caller changed this field's stored values (converted, discarded or renamed them)
 * before the re-render, so the file's text for it is replaced, never kept as typed
 * (#501); a rename also names the field's old name in `previousNames`.
 *
 * Returns the re-render count plus the changed node IDs so callers can
 * enqueue embedding refreshes after the surrounding work commits.
 */
export function rerenderNodesWithField(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  fieldName: string,
  additionalNodeIds?: string[],
  syncLogger?: SyncLogger,
  fsRollback?: { push(undo: () => void): void },
  previousNames: readonly string[] = [],
): { nodes_rerendered: number; changed_node_ids: string[] } {
  const nodeIds = fieldRerenderNodeIds(db, fieldName, additionalNodeIds);

  if (nodeIds.length === 0) return { nodes_rerendered: 0, changed_node_ids: [] };

  let rerendered = 0;
  const changedNodeIds: string[] = [];
  for (const nodeId of nodeIds) {
    const pipelineResult = rerenderNodeThroughPipeline(
      db, writeLock, vaultPath, nodeId, {}, syncLogger, undefined,
      { fsRollback, touchedFields: [fieldName, ...previousNames] },
    );
    if (pipelineResult?.file_written) {
      rerendered++;
      // file_written is the pipeline's content-changed signal — no-op
      // re-renders would hash-skip, so only real changes are returned.
      changedNodeIds.push(nodeId);
    }
  }

  return { nodes_rerendered: rerendered, changed_node_ids: changedNodeIds };
}

function fieldRerenderNodeIds(db: Database.Database, fieldName: string, additionalNodeIds?: string[]): string[] {
  const fromField = (db.prepare('SELECT DISTINCT node_id FROM node_fields WHERE field_name = ?').all(fieldName) as Array<{ node_id: string }>)
    .map(r => r.node_id);
  const fromExplicitNull = (db.prepare(
    'SELECT DISTINCT node_id FROM node_explicit_null_fields WHERE field_name = ?',
  ).all(fieldName) as Array<{ node_id: string }>).map(r => r.node_id);

  const nodeIdSet = new Set([...fromField, ...fromExplicitNull]);
  if (additionalNodeIds) {
    for (const id of additionalNodeIds) nodeIdSet.add(id);
  }
  return Array.from(nodeIdSet);
}

/** Read-only projection preflight over exactly the live field re-render targets. */
export function assertFieldRerenderFilesPresent(
  db: Database.Database,
  vaultPath: string,
  fieldName: string,
  additionalNodeIds?: string[],
): void {
  for (const nodeId of fieldRerenderNodeIds(db, fieldName, additionalNodeIds)) {
    const node = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(nodeId) as
      | { file_path: string }
      | undefined;
    if (!node) continue;
    assertMutationFilePresent(db, vaultPath, {
      source: 'propagation', node_id: nodeId, file_path: node.file_path, db_only: false,
    });
  }
}
