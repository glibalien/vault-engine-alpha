import { withGlobalFieldTransaction } from '../../global-fields/transaction.js';
import { previewSchemaClassification } from '../../classification/preview.js';
import { enumGroupsSchema } from '../../classification/input.js';
import { ClassificationError } from '../../classification/types.js';
import { RollupError } from '../../rollups/definitions.js';
import { relationshipViewsToolInput } from './relationship-views-input.js';
import { SummaryError } from '../../summaries/errors.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import {
  patchSchemaDefinition,
  updateSchemaDefinition,
  type PatchSchemaInput,
  type UpdateSchemaInput,
} from '../../schema/crud.js';
import { diffClaims, propagateSchemaChange } from '../../schema/propagate.js';
import { readCurrentClaims } from '../../schema/claims.js';
import { renderSchemaFile } from '../../schema/render.js';
import { previewSchemaChange, previewSchemaPatch } from '../../schema/preview.js';
import { SchemaValidationError } from '../../schema/errors.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  ai_guessable: z.boolean().optional(),
  default_value: z.unknown().optional(),
  default_value_overridden: z.boolean().optional().describe('Set true when default_value key is present, even if null'),
  enum_groups_override: enumGroupsSchema.nullable().optional(),
  expected_enum_groups_hash: z.string().optional(),
  expected_global_enum_groups_hash: z.string().optional(),
  enum_values_override: z.array(z.string()).optional().describe('Per-type enum values (replaces global for this type)'),
});

const TOOL_DESC =
  'Updates an existing schema definition. If field_claims is provided, it replaces all existing claims. ' +
  'Alternatively, use add_field_claims, update_field_claims, and remove_field_claims for patch-style claim edits. ' +
  'When dry_run=true, returns a preview (claim diff, orphan counts, propagation numbers) without committing — ' +
  'a response with ok:false on a dry-run means the change WOULD BE REJECTED if committed, not that the dry-run itself failed; ' +
  'preview data is then in error.details alongside groups. ' +
  'When a non-dry-run commit would orphan any field value(s), the response is ok:false with error.code CONFIRMATION_REQUIRED; ' +
  're-call with confirm_large_change:true to proceed.';

export function registerUpdateSchema(
  server: McpServer,
  db: Database.Database,
  ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger; embeddingIndexer?: EmbeddingIndexer },
): void {
  server.registerTool(
    'update-schema',
    {
      description: TOOL_DESC,
      inputSchema: relationshipViewsToolInput({
        name: z.string().describe('Schema name to update'),
        display_name: z.string().optional().describe('New display name'),
        icon: z.string().optional().describe('New icon identifier'),
        filename_template: z.string().optional().describe('New filename template (name only, e.g. "{date} - {title}.md")'),
        default_directory: z.string().optional().describe('New default directory for files of this type'),
        field_claims: z.array(fieldClaimSchema).optional().describe('New field claims (replaces existing)'),
        add_field_claims: z.array(fieldClaimSchema).optional().describe('Field claims to add without replacing existing claims'),
        update_field_claims: z.array(fieldClaimSchema).optional().describe('Existing field claims to patch by field name without changing other claims'),
        remove_field_claims: z.array(z.string()).optional().describe('Field names to remove from this schema without replacing other claims'),
        metadata: z.unknown().optional().describe('New metadata; saved definitions are preserved'),
        expected_relationship_views_hash: z.string().optional().describe('Required current discovery hash when updating saved definitions'),
        dry_run: z.boolean().optional().describe('Preview the effect without committing'),
        confirm_large_change: z.boolean().optional().describe('Acknowledge the change would orphan field values. Required when propagation would orphan any field.'),
      }, { description: 'Replace saved relation/rollup definitions; null removes them', allowRemoval: true }),
    },
    async ({ name, dry_run, confirm_large_change, ...rest }) => {
      if (!ctx?.writeLock || !ctx?.vaultPath) {
        return fail('INTERNAL_ERROR', 'update-schema requires write context (writeLock + vaultPath).');
      }
      const writeLock = ctx.writeLock;
      const vaultPath = ctx.vaultPath;

      let normalized;
      try {
        normalized = normalizeSchemaUpdate(rest);
      } catch (err) {
        if (err instanceof ClassificationError) return fail(err.code, err.message, {details:err.details as Record<string,unknown>});
        if (err instanceof RollupError || err instanceof SummaryError) return fail(err.code, err.message, { details: err.details });
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }

      // Preview first — no operation created, no side effects.
      let preview;
      let classification;
      try {
        classification = previewSchemaClassification(db,name,normalized.input);
        preview = normalized.kind === 'patch'
          ? previewSchemaPatch(db, writeLock, vaultPath, name, normalized.input)
          : previewSchemaChange(db, writeLock, vaultPath, name, normalized.input);
      } catch (err) {
        if (err instanceof ClassificationError) return fail(err.code, err.message, {details:err.details as Record<string,unknown>});
        if (err instanceof RollupError || err instanceof SummaryError) return fail(err.code, err.message, { details: err.details });
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }

      if (!preview.ok) {
        return fail(
          'VALIDATION_FAILED',
          `Schema change rejected: ${preview.groups.length} validation group(s).`,
          { details: {
              groups: preview.groups,
              ...(preview.relationship_views ? { relationship_views: preview.relationship_views } : {}),
              claims_added: preview.claims_added,
              claims_removed: preview.claims_removed,
              claims_modified: preview.claims_modified,
              orphaned_field_names: preview.orphaned_field_names,
              propagation: preview.propagation,
            } },
        );
      }

      if (dry_run) {
        return ok({
          would_commit: true,
          ...(classification?.length ? {classification} : {}),
          claims_added: preview.claims_added,
          claims_removed: preview.claims_removed,
          claims_modified: preview.claims_modified,
          orphaned_field_names: preview.orphaned_field_names,
          propagation: preview.propagation,
          ...(preview.relationship_views ? { relationship_views: preview.relationship_views } : {}),
        });
      }

      // Confirm gate: once we're past the dry_run early-return, any orphan-producing
      // commit must set confirm_large_change:true. Dry-runs stay gate-free by design
      // (return above runs first on dry_run: true).
      if (preview.propagation.fields_orphaned > 0 && !confirm_large_change) {
        const fieldCount = preview.orphaned_field_names.length;
        return fail(
          'CONFIRMATION_REQUIRED',
          `This change would orphan ${preview.propagation.fields_orphaned} field value(s) across ${fieldCount} field(s). Set confirm_large_change: true to proceed, or run with dry_run: true to preview.`,
          { details: {
              orphaned_field_names: preview.orphaned_field_names,
              propagation: preview.propagation,
              claims_removed: preview.claims_removed,
            } },
        );
      }

      // Live-commit path. Create the undo operation inside the mutation
      // transaction so any governed rejection rolls back both together.
      let operation_id: string | undefined;
      let finalResult: ReturnType<typeof updateSchemaDefinition> | undefined;
      let propagation: ReturnType<typeof propagateSchemaChange> | undefined;
      try {
        let rendered = true;
        operation_id = withGlobalFieldTransaction(db, fsRollback => {
          previewSchemaClassification(db,name,normalized.input);
          const transactionOperationId = createOperation(db, {
            source_tool: 'update-schema',
            description: buildDescription(
              name,
              normalized.kind === 'patch' || normalized.input.field_claims !== undefined,
              preview,
            ),
          });
          captureSchemaSnapshot(db, transactionOperationId, name);
          const hasClaimMutation = normalized.kind === 'patch'
            ? normalized.input.add_field_claims !== undefined ||
              normalized.input.update_field_claims !== undefined ||
              normalized.input.remove_field_claims !== undefined
            : normalized.input.field_claims !== undefined;
          const oldClaims = hasClaimMutation ? readCurrentClaims(db, name) : [];
          finalResult = normalized.kind === 'patch'
            ? patchSchemaDefinition(db, name, normalized.input)
            : updateSchemaDefinition(db, name, normalized.input);
          if (hasClaimMutation) {
            const diff = diffClaims(oldClaims, readCurrentClaims(db, name));
            propagation = propagateSchemaChange(
              db, writeLock, vaultPath, name, diff, ctx.syncLogger,
              { operation_id: transactionOperationId, fsRollback },
            );
          }
          rendered = renderSchemaFile(db, vaultPath, name, fsRollback);
          return transactionOperationId;
        });

        db.prepare(
          'UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?',
        ).run(operation_id);

        // Cycle 5: propagation re-rendered nodes through the pipeline inside
        // the txn — enqueue their embedding refreshes only now, post-commit.
        if (propagation) {
          for (const nodeId of propagation.changed_node_ids) {
            ctx.embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
          }
        }
        return ok({ ...finalResult!, propagation, operation_id }, !rendered ? [{
          code: 'SCHEMA_FILE_RENDER_BLOCKED', severity: 'warning',
          message: 'Schema definitions committed; YAML export was blocked by an external edit.', details: { schema: name },
        }] : []);
      } catch (err) {
        if (err instanceof ClassificationError) return fail(err.code, err.message, {details:err.details as Record<string,unknown>});
        if (err instanceof RollupError || err instanceof SummaryError) return fail(err.code, err.message, { details: err.details });
        if (err instanceof SchemaValidationError) {
          return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
    },
  );
}

type RawUpdateRest = {
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims?: z.infer<typeof fieldClaimSchema>[];
  add_field_claims?: z.infer<typeof fieldClaimSchema>[];
  update_field_claims?: z.infer<typeof fieldClaimSchema>[];
  remove_field_claims?: string[];
  metadata?: unknown;
  relationship_views?: unknown;
  expected_relationship_views_hash?: string;
};

type NormalizedSchemaUpdate =
  | { kind: 'replace'; input: UpdateSchemaInput }
  | { kind: 'patch'; input: PatchSchemaInput };

function normalizeSchemaUpdate(
  rest: RawUpdateRest,
): NormalizedSchemaUpdate {
  const {
    add_field_claims,
    update_field_claims,
    remove_field_claims,
    ...base
  } = rest;

  const hasPatchOps =
    add_field_claims !== undefined ||
    update_field_claims !== undefined ||
    remove_field_claims !== undefined;

  if (base.field_claims !== undefined && hasPatchOps) {
    throw new Error('field_claims replaces all claims and cannot be combined with add_field_claims, update_field_claims, or remove_field_claims.');
  }

  if (!hasPatchOps) return { kind: 'replace', input: base };

  const input: PatchSchemaInput = {
    add_field_claims,
    update_field_claims,
    remove_field_claims,
  };
  if (base.display_name !== undefined) input.display_name = base.display_name;
  if (base.icon !== undefined) input.icon = base.icon;
  if (base.filename_template !== undefined) input.filename_template = base.filename_template;
  if (base.default_directory !== undefined) input.default_directory = base.default_directory;
  if (base.metadata !== undefined) input.metadata = base.metadata;
  if (base.relationship_views !== undefined) input.relationship_views = base.relationship_views;
  if (base.expected_relationship_views_hash !== undefined) input.expected_relationship_views_hash = base.expected_relationship_views_hash;

  return { kind: 'patch', input };
}

function buildDescription(
  name: string,
  hasClaimMutation: boolean,
  preview: { claims_added: string[]; claims_removed: string[]; claims_modified: string[] },
): string {
  if (!hasClaimMutation) return `update-schema: ${name}`;
  const a = preview.claims_added.length;
  const r = preview.claims_removed.length;
  const m = preview.claims_modified.length;
  return `update-schema: ${name} (+${a}/-${r}/~${m} claims)`;
}
