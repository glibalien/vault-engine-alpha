import { globalChangeNeedsGuard, previewEnumGroupChange } from '../../classification/preview.js';
import { enumGroupsSchema } from '../../classification/input.js';
import { ClassificationError } from '../../classification/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { getGlobalField, updateGlobalField, TypeChangeRequiresDiscardError, definitionToWire } from '../../global-fields/crud.js';
import { withGlobalFieldTransaction } from '../../global-fields/transaction.js';
import { renderFieldsFile, renderSchemaFile } from '../../schema/render.js';
import { assertFieldRerenderFilesPresent, rerenderNodesWithField } from '../../schema/propagate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureGlobalFieldSnapshot } from '../../undo/global-field-snapshot.js';

const fieldTypeEnum = z.enum(['string', 'number', 'date', 'boolean', 'reference', 'enum', 'list']);

export function registerUpdateGlobalField(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger; embeddingIndexer?: EmbeddingIndexer }): void {
  server.tool(
    'update-global-field',
    'Updates an existing global field definition. For type changes, omit confirm to preview impact; set confirm=true to apply. If existing values cannot coerce to the new type, the apply is refused with CONFIRMATION_REQUIRED unless discard_uncoercible: true is also set.',
    {
      dry_run: z.boolean().optional(),
      expected_enum_groups_hash: z.string().optional(),
      name: z.string().describe('Field name to update'),
      field_type: fieldTypeEnum.optional().describe('New field type (triggers type-change flow if different)'),
      enum_groups: enumGroupsSchema.nullable().optional(),
      enum_values: z.array(z.string()).optional().describe('New allowed values for enum fields'),
      reference_target: z.string().optional().describe('New target schema type for reference fields'),
      description: z.string().optional().describe('New description'),
      default_value: z.unknown().optional().describe('New default value'),
      required: z.boolean().optional().describe('New required flag'),
      ai_guessable: z.boolean().optional().describe('Whether AI may infer this field when values are missing'),
      list_item_type: fieldTypeEnum.optional().describe('New item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_groups: z.boolean().optional(),
        enum_values: z.boolean().optional(),
        ai_guessable: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      ui: z.object({
        widget: z.enum(['text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags']).optional(),
        label: z.string().max(80).optional(),
        help: z.string().max(280).optional(),
        order: z.number().int().optional(),
      }).nullable().optional().describe('UI rendering hints. Pass null or {} to clear; absent key = no change; populated object = REPLACE existing hints (no merge).'),
      confirm: z.boolean().optional().describe('Set true to apply a type change (otherwise previews impact)'),
      discard_uncoercible: z.boolean().optional().describe('When applying a type change with uncoercible values, set true to delete those values. Default: refuse the change with CONFIRMATION_REQUIRED.'),
    },
    async ({ name, dry_run, expected_enum_groups_hash, ...rest }) => {
      let operation_id: string | null = null;
      try {
        const guarded = globalChangeNeedsGuard(db,name,rest);
        if (dry_run) {
          const supported = ['enum_groups','enum_values','overrides_allowed'];
          if (!guarded || Object.keys(rest).some(k=>!supported.includes(k)) || Object.keys(rest.overrides_allowed??{}).some(k=>k!=='enum_groups')) return fail('INVALID_PARAMS','Classification dry run supports only enum_groups, enum_values and overrides_allowed.enum_groups.');
          return ok({classification:previewEnumGroupChange(db,{field:name,input:{...rest,expected_enum_groups_hash}})});
        }
        if (guarded) previewEnumGroupChange(db,{field:name,input:{...rest,expected_enum_groups_hash}});
        const current = rest.field_type && !rest.confirm ? getGlobalField(db, name) : null;
        if (current && current.field_type !== rest.field_type) {
          const preview = updateGlobalField(db, name, rest);
          if (ctx?.vaultPath && ctx.writeLock) {
            assertFieldRerenderFilesPresent(db, ctx.vaultPath, name, preview.uncoercible?.map(u => u.node_id));
          }
          return ok(preview);
        }

        const applied = withGlobalFieldTransaction(db, fsRollback => {
          if (guarded) previewEnumGroupChange(db,{field:name,input:{...rest,expected_enum_groups_hash}});
          const transactionOperationId = createOperation(db, {
            source_tool: 'update-global-field',
            description: `update-global-field: ${name}`,
          });
          captureGlobalFieldSnapshot(db, transactionOperationId, name);
          const result = updateGlobalField(db, name, rest);
          // Include discarded values' nodes even though their field rows are
          // gone, and keep every re-render inside the field's transaction.
          const rerender = rest.confirm && rest.field_type && ctx?.vaultPath && ctx.writeLock
            ? rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, name,
              result.uncoercible?.map(u => u.node_id), ctx.syncLogger, fsRollback)
            : undefined;
          // Projections share the mutation rollback boundary.
          if (ctx?.vaultPath) {
            renderFieldsFile(db, ctx.vaultPath, fsRollback);
            const claimingSchemas = db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
              .all(name) as Array<{ schema_name: string }>;
            for (const { schema_name } of claimingSchemas) {
              renderSchemaFile(db, ctx.vaultPath, schema_name, fsRollback);
            }
          }
          return { operation_id: transactionOperationId, result, rerender };
        });
        operation_id = applied.operation_id;
        const { result, rerender } = applied;

        const wireResult = result.field
          ? { ...result, field: definitionToWire(result.field) }
          : result;

        if (rerender) {
          // Refresh embeddings only after the complete field operation commits.
          for (const nodeId of rerender.changed_node_ids) {
            ctx?.embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
          }
          return ok({ ...wireResult, operation_id, nodes_rerendered: rerender.nodes_rerendered });
        }

        return ok({ ...wireResult, operation_id });
      } catch (err) {
        if (err instanceof ClassificationError) return fail(err.code, err.message, {details:err.details as Record<string,unknown>});
        if (err instanceof TypeChangeRequiresDiscardError) {
          return fail(
            'CONFIRMATION_REQUIRED',
            `${err.details.uncoercible.length} value(s) cannot coerce to the new type. Set discard_uncoercible: true to delete them, or omit confirm to preview.`,
            { details: {
                affected_nodes: err.details.affected_nodes,
                coercible_count: err.details.coercible_count,
                uncoercible: err.details.uncoercible,
              } },
          );
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
    },
  );
}
