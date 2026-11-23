// src/mcp/tools/undo-operations.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { getOperation } from '../../undo/operation.js';
import { restoreMany } from '../../undo/restore.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { FieldGuessCandidateIdentityBudgetError } from '../../field-guess/candidate-contract.js';

const paramsShape = {
  operation_ids: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  dry_run: z.boolean().optional(),
  skip_missing: z.boolean().optional()
    .describe('operation_ids only: leave out ids that are not active (expired, already undone, unknown) and report them as not_found, instead of failing.'),
  resolve_conflicts: z.array(z.object({
    node_id: z.string(),
    action: z.enum(['revert', 'skip']),
  })).optional(),
};

export function registerUndoOperations(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'undo-operations',
    'Undo one or more previously captured operations. Provide either operation_ids (explicit list, cherry-pickable) or since/until (time range). dry_run defaults to true — preview conflicts before committing. With operation_ids, skip_missing leaves out ids that are no longer active and lists them under not_found. When conflicts arise (modified_after_operation, path_occupied, superseded_by_later_op) they are returned for user mediation; call back with resolve_conflicts to revert or skip per node.',
    paramsShape,
    async (params) => {
      const hasIds = Array.isArray(params.operation_ids) && params.operation_ids.length > 0;
      const hasRange = Boolean(params.since || params.until);

      if (!hasIds && !hasRange) {
        return fail('INVALID_PARAMS', 'Provide either operation_ids or since/until.');
      }
      if (hasIds && hasRange) {
        return fail('INVALID_PARAMS', 'Provide exactly one of operation_ids or since/until, not both.');
      }

      // Existence check for operation_ids
      let operationIds = params.operation_ids;
      const notFound: string[] = [];
      if (hasIds) {
        const active: string[] = [];
        for (const id of params.operation_ids!) {
          const op = getOperation(db, id);
          if (op && op.status === 'active') {
            active.push(id);
          } else if (params.skip_missing) {
            notFound.push(id);
          } else {
            return fail(
              'OPERATION_NOT_FOUND',
              `Operation '${id}' is not active or does not exist.`,
              { details: { operation_id: id } },
            );
          }
        }
        operationIds = active;
      } else if (params.skip_missing) {
        return fail('INVALID_PARAMS', 'skip_missing applies to operation_ids.');
      }

      const dry_run = params.dry_run ?? true;
      // Every id was left out: nothing to restore.
      if (hasIds && operationIds!.length === 0) {
        return ok({ dry_run, operations: [], conflicts: [], total_undone: 0, total_conflicts: 0, total_skipped: 0, not_found: notFound });
      }

      let result: ReturnType<typeof restoreMany>;
      try {
        result = restoreMany(db, writeLock, vaultPath, {
          operation_ids: operationIds,
          since: params.since,
          until: params.until,
          dry_run,
          resolve_conflicts: params.resolve_conflicts,
        });
      } catch (error) {
        if (error instanceof FieldGuessCandidateIdentityBudgetError) {
          return fail('INVALID_PARAMS', error.message);
        }
        throw error;
      }

      // Cycle 5: restores rewrite nodes through the pipeline without firing
      // watcher events — refresh (or remove) their embeddings post-commit.
      if (!dry_run) {
        for (const nodeId of result.restored_node_ids ?? []) {
          embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
        }
        for (const nodeId of result.deleted_node_ids ?? []) {
          embeddingIndexer?.removeNode(nodeId);
        }
      }

      return ok({
        dry_run,
        operations: result.operations,
        conflicts: result.conflicts,
        total_undone: result.total_undone,
        total_conflicts: result.total_conflicts,
        total_skipped: result.total_skipped,
        ...(params.skip_missing ? { not_found: notFound } : {}),
      }, [
        ...(result.blocked_schema_exports ?? []).map(schema => ({
          code: 'SCHEMA_FILE_RENDER_BLOCKED' as const, severity: 'warning' as const,
          message: 'Schema database state restored; YAML export was blocked.',
          details: { schema },
        })),
        // A renamed or moved note is back at its old path, but its file at the new path
        // was kept (#509): it changed after Engine wrote it, or could not be removed.
        ...(result.kept_files ?? []).map(file => ({
          code: 'UNDO_FILE_KEPT' as const, severity: 'warning' as const,
          message: file.reason === 'changed'
            ? `Restored the note at '${file.restored_file_path}' and kept '${file.file_path}': it changed after Engine wrote it, so it will be indexed as a separate note.`
            : `Restored the note at '${file.restored_file_path}' but could not remove '${file.file_path}'${file.error ? ` (${file.error})` : ''}; it will be indexed as a separate note.`,
          details: file,
        })),
      ]);
    },
  );
}
