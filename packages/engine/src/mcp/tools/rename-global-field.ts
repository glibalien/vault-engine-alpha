import { RollupError } from '../../rollups/definitions.js';
import { renameRelationshipViewFields } from '../../rollups/mutation.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail, type Issue } from './errors.js';
import { renameGlobalField } from '../../global-fields/crud.js';
import { withGlobalFieldTransaction } from '../../global-fields/transaction.js';
import { renderFieldsFile, renderSchemaFile } from '../../schema/render.js';
import { rerenderNodesWithField } from '../../schema/propagate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureGlobalFieldSnapshot } from '../../undo/global-field-snapshot.js';

export function registerRenameGlobalField(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger; embeddingIndexer?: EmbeddingIndexer }): void {
  server.tool(
    'rename-global-field',
    'Renames a global field, updating all schema claims and node field values.',
    {
      old_name: z.string().describe('Current field name'),
      new_name: z.string().describe('New field name'),
    },
    async ({ old_name, new_name }) => {
      let operation_id: string | undefined;
      try {
        const applied = withGlobalFieldTransaction(db, fsRollback => {
          const transactionOperationId = createOperation(db, {
            source_tool: 'rename-global-field',
            description: `rename-global-field: ${old_name} -> ${new_name}`,
          });
          captureGlobalFieldSnapshot(db, transactionOperationId, new_name, { was_renamed_from: old_name });
          const result = renameGlobalField(db, old_name, new_name);
          const rollupSchemas = renameRelationshipViewFields(db, old_name, new_name, transactionOperationId);
          db.prepare('UPDATE undo_operations SET schema_count = ? WHERE operation_id = ?').run(rollupSchemas.length, transactionOperationId);
          const rerender = ctx?.writeLock && ctx?.vaultPath
            ? rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, new_name, undefined, ctx.syncLogger, fsRollback, [old_name])
            : { nodes_rerendered: 0, changed_node_ids: [] };
          const claimingSchemas = ctx?.vaultPath
            ? (db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
              .all(new_name) as Array<{ schema_name: string }>).map(r => r.schema_name)
            : [];

          const warnings: Issue[] = [];
          if (ctx?.vaultPath) {
            renderFieldsFile(db, ctx.vaultPath, fsRollback);
            for (const schema of new Set([...claimingSchemas, ...rollupSchemas])) {
              const rendered = renderSchemaFile(db, ctx.vaultPath, schema, fsRollback);
              if (!rendered && rollupSchemas.includes(schema)) warnings.push({
                code: 'SCHEMA_FILE_RENDER_BLOCKED', severity: 'warning',
                message: 'Saved field references committed; YAML export was blocked by an external edit.', details: { schema },
              });
            }
          }
          return {
            warnings,
            operation_id: transactionOperationId,
            result,
            rollupSchemas,
            rerender,
          };
        });
        operation_id = applied.operation_id;

        const { nodes_rerendered, changed_node_ids } = applied.rerender;
        const warnings = applied.warnings;
        // Refresh embeddings only after the complete field operation commits.
        for (const nodeId of changed_node_ids) {
          ctx?.embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
        }

        return ok({ ...applied.result, operation_id, nodes_rerendered }, warnings);
      } catch (err) {
        if (err instanceof RollupError) return fail(err.code, err.message, { details: err.details });
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
    },
  );
}
