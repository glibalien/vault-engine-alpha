import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import { createFieldMap } from '../fields/field-map.js';
import { overlayExplicitNullFields, readExplicitNullFields } from '../fields/explicit-null.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { mergeFieldClaims } from '../validation/merge.js';
import { dropStoredTypeKeyField } from '../validation/type-key-field.js';
import { assertExpectedNodeVersion, ContentHashMismatchError, executeMutation, previewMutation } from '../pipeline/execute.js';
import type { PipelineResult, ProposedMutation } from '../pipeline/types.js';
import type { CoercedValue } from '../validation/types.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { createOperation, finalizeOperation } from '../undo/operation.js';
import { buildIdentityIndex } from './identity.js';
import { planReferenceEdit } from './plan.js';
import { checkListLimit, REFERENCE_EDIT_LIMITS, ReferenceEditError, type IdentityRow, type MemberPlan, type ReferenceEdit } from './types.js';

export interface ReferenceEditRequest {
  node_id: string; reference_edit: ReferenceEdit; dry_run: boolean;
  expected_version?: number; expected_content_hash?: string;
}
export interface ReferenceEditContext {
  db: Database.Database; writeLock: WriteLockManager; vaultPath: string; syncLogger?: SyncLogger;
}
export interface ReferenceEditState {
  request: ReferenceEditRequest;
  node: { node_id: string; file_path: string; title: string; types: string[] };
  pipeline: PipelineResult; plan: MemberPlan;
  observed_version: number; observed_content_hash: string;
  result_version: number; result_content_hash: string;
  operation_id: string | null; observed_target_id: string | null;
}
interface SourceRow { id: string; file_path: string; title: string; body: string; version: number; content_hash: string }
interface FieldRow { field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }

function diskHash(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

/** Owns the outer transaction: callers must not compose this in another transaction. */
export function executeReferenceEdit<T>(
  { db, writeLock, vaultPath, syncLogger }: ReferenceEditContext,
  request: ReferenceEditRequest,
  preflight: (state: ReferenceEditState) => T,
): T {
  if (db.inTransaction) throw new ReferenceEditError('INVALID_PARAMS', 'Reference edit must own its transaction', { reason: 'nested_transaction' });
  const { field, action, target } = request.reference_edit;
  if (['__proto__', 'prototype', 'constructor'].includes(field)) {
    throw new ReferenceEditError('NOT_ELIGIBLE', 'Reserved field name', { reason: 'reserved_field' });
  }
  if ('stored_value' in target && (action !== 'remove' || request.expected_version === undefined || request.expected_content_hash === undefined)) {
    throw new ReferenceEditError('INVALID_PARAMS', 'Stored-value removal requires both source guards', { reason: 'stored_value_guards' });
  }
  const fsUndos: Array<() => void> = [];
  const afterCommit: Array<() => void> = [];
  let writtenPath: string | undefined;
  let originalHash: string | undefined;
  let response: T;
  try {
    response = db.transaction(() => {
      const source = db.prepare('SELECT id, file_path, title, body, version, content_hash FROM nodes WHERE id = ?').get(request.node_id) as SourceRow | undefined;
      if (!source) throw new ReferenceEditError('NOT_FOUND', 'Source node not found', { reason: 'source_missing' });
      assertExpectedNodeVersion(db, source.id, request.expected_version);
      if (request.expected_content_hash !== undefined && request.expected_content_hash !== source.content_hash) {
        throw new ContentHashMismatchError(source.id, request.expected_content_hash, source.content_hash);
      }
      const path = safeVaultPath(vaultPath, source.file_path);
      writeLock.withLockSync(path, () => {
        const hash = diskHash(path);
        if (hash === null || hash !== source.content_hash) throw new ContentHashMismatchError(source.id, source.content_hash, hash);
      });
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type').all(source.id) as Array<{ schema_type: string }>).map(row => row.schema_type);
      const schema = loadSchemaContext(db, types);
      const merged = mergeFieldClaims(types, schema.claimsByType, schema.globalFields);
      if (!merged.ok) throw new ReferenceEditError('NOT_ELIGIBLE', 'Conflicting schema claims', { reason: 'schema_conflict' });
      const definition = merged.effective_fields.get(field)?.global_field;
      if (!definition || definition.field_type !== 'list' || definition.list_item_type !== 'reference') {
        throw new ReferenceEditError('NOT_ELIGIBLE', 'Field must be a claimed reference list', { reason: 'field_kind' });
      }
      if ('node_id' in target) {
        if (!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(target.node_id)) {
          throw new ReferenceEditError('NOT_FOUND', 'Reference target not found', { reason: 'target_missing' });
        }
        if (action === 'add' && definition.reference_target && !db.prepare('SELECT 1 FROM node_types WHERE node_id = ? AND schema_type = ?').get(target.node_id, definition.reference_target)) {
          throw new ReferenceEditError('NOT_ELIGIBLE', 'Reference target has the wrong type', { reason: 'target_type', required_type: definition.reference_target });
        }
      }
      const fields = createFieldMap<unknown>();
      for (const row of db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?').all(source.id) as FieldRow[]) {
        try { fields[row.field_name] = reconstructValue(row); }
        catch { throw new ReferenceEditError('NOT_ELIGIBLE', 'Malformed stored field JSON', { reason: 'malformed_json' }); }
      }
      // A stored field named like the type key is no semantic value: the write drops it (#480).
      dropStoredTypeKeyField(fields);
      const nulls = readExplicitNullFields(db, source.id);
      const current = nulls.has(field) ? null : fields[field];
      if (current !== undefined && current !== null && (!Array.isArray(current) || !current.every(v => typeof v === 'string'))) {
        throw new ReferenceEditError('NOT_ELIGIBLE', 'Stored reference list must contain only strings', { reason: 'malformed_list' });
      }
      checkListLimit(current ?? []);
      const identity = buildIdentityIndex(
        db.prepare('SELECT id, file_path, title FROM nodes LIMIT ?').iterate(REFERENCE_EDIT_LIMITS.catalogNodes + 1) as IterableIterator<IdentityRow>,
      );
      const plan = planReferenceEdit({ edit: request.reference_edit, before: {
        presence: current === null ? 'explicit_null' : current === undefined ? 'absent' : 'list',
        values: current ?? [],
      }, identity });
      if (plan.changed) fields[field] = [...plan.values];
      const touchedFields = plan.changed ? [field] : [];
      const mutation: ProposedMutation = {
        source: 'tool', node_id: source.id, file_path: source.file_path, title: source.title,
        types, fields, body: source.body, touchedFields,
        expectedVersion: request.expected_version, expectedContentHash: request.expected_content_hash,
        expectedDiskContentHash: source.content_hash,
        // A member edit changes exactly one member; rewriting other links
        // would be the normalization this service refuses to perform.
        canonicalizeLinks: false,
      };
      const pipeline = previewMutation(db, writeLock, vaultPath, mutation);
      if (plan.changed) {
        const intended = overlayExplicitNullFields(fields, nulls, touchedFields).fields;
        const actual = createFieldMap<unknown>();
        for (const [name, value] of Object.entries(pipeline.validation.coerced_state)) actual[name] = value.value;
        for (const [name, value] of Object.entries(intended)) if (value === null) actual[name] = null;
        if (!isDeepStrictEqual(actual, intended)) {
          throw new ReferenceEditError('VALIDATION_FAILED', 'Member edit would change unrelated semantic values or normalize stored members', { reason: 'semantic_normalization' });
        }
      } else {
        // No-op results describe stored values, not the normalization/defaults a
        // hypothetical whole-node write would produce. Still run preview guards.
        const stored = createFieldMap<CoercedValue>();
        for (const [name, value] of Object.entries(fields)) {
          if (nulls.has(name) || value === null) continue;
          stored[name] = { field: name, value, changed: false,
            source: pipeline.validation.orphan_fields.includes(name) ? 'orphan' : 'provided' };
        }
        pipeline.validation = { ...pipeline.validation, coerced_state: stored };
        pipeline.rendered_hash = source.content_hash;
      }
      const committing = plan.changed && !request.dry_run;
      const operationId = committing ? createOperation(db, { source_tool: 'update-node', description: `reference_edit: ${action} ${field}` }) : null;
      const state: ReferenceEditState = {
        request, node: { node_id: source.id, file_path: source.file_path, title: source.title, types }, pipeline, plan,
        observed_version: source.version, observed_content_hash: source.content_hash,
        result_version: source.version + (committing ? 1 : 0),
        result_content_hash: committing ? pipeline.rendered_hash : source.content_hash,
        operation_id: operationId, observed_target_id: 'node_id' in target ? target.node_id : null,
      };
      const prepared = preflight(state);
      if (committing && operationId) {
        writtenPath = path;
        originalHash = source.content_hash;
        const applied = executeMutation(db, writeLock, vaultPath, mutation, undefined,
          { operation_id: operationId }, fsUndos, { afterCommit, resolveReference(request) {
            // The membership identity index is transaction-local; this v1
            // callback preserves its existing one-scan projection behavior.
            const candidates = identity.candidates(request.rawTarget);
            const winner = candidates.reduce<IdentityRow | null>((best, row) =>
              best === null || row.file_path.length < best.file_path.length ? row : best, null);
            const details = { tier: null, candidateCount: candidates.length,
              candidates: candidates.slice(0, 10).map(row => ({ ...row, types: [] })),
              candidatesTruncated: candidates.length > 10 };
            return winner === null
              ? { status: 'unresolved', reason: 'missing', ...details }
              : { status: 'resolved', targetId: winner.id, ...details };
          } });
        const saved = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(source.id) as SourceRow;
        if (saved.version !== state.result_version || saved.content_hash !== state.result_content_hash || !isDeepStrictEqual(applied.validation.coerced_state, pipeline.validation.coerced_state)) {
          throw new ReferenceEditError('INTERNAL_ERROR', 'Member edit diverged from preflight', { reason: 'preflight_mismatch' });
        }
        finalizeOperation(db, operationId);
        const op = db.prepare('SELECT node_count FROM undo_operations WHERE operation_id = ?').get(operationId) as { node_count: number } | undefined;
        if (op?.node_count !== 1) throw new ReferenceEditError('INTERNAL_ERROR', 'Undo snapshot was not finalized', { reason: 'undo_finalize' });
        afterCommit.push(() => { syncLogger?.fileWritten(source.file_path, 'tool', applied.rendered_hash); });
      }
      return prepared;
    }).immediate();
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const undo of fsUndos.reverse()) {
      try { undo(); } catch (rollbackError) { rollbackErrors.push(String(rollbackError).slice(0, 512)); }
    }
    if (fsUndos.length > 0 && writtenPath && diskHash(writtenPath) !== originalHash) {
      throw new ReferenceEditError('INTERNAL_ERROR', 'Database rolled back; projection restoration incomplete', {
        reason: 'rollback_incomplete', cause: error instanceof Error ? error.message.slice(0, 512) : 'Mutation failed', rollback_errors: rollbackErrors,
      });
    }
    if (rollbackErrors.length) throw new ReferenceEditError('INTERNAL_ERROR', 'Projection rollback reported an error', { reason: 'rollback_error', rollback_errors: rollbackErrors });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') {
      throw new ReferenceEditError('CONFLICT', 'Another writer holds the database; retry the member intent', { reason: 'writer_busy' });
    }
    throw error;
  }
  for (const effect of afterCommit) {
    try { effect(); } catch (error) { console.error('[reference-edit] post-commit observer failed', error); }
  }
  return response;
}
