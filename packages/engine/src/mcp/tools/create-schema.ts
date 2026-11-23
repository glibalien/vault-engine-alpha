import { withGlobalFieldTransaction } from '../../global-fields/transaction.js';
import { previewSchemaClassification } from '../../classification/preview.js';
import { enumGroupsSchema } from '../../classification/input.js';
import { ClassificationError } from '../../classification/types.js';
import { parseRelationshipViews, RollupError } from '../../rollups/definitions.js';
import { relationshipViewsToolInput } from './relationship-views-input.js';
import { SummaryError } from '../../summaries/errors.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { exampleNamesFor, type ExampleNames } from '../example-names.js';
import { createSchemaDefinition } from '../../schema/crud.js';
import { schemaNameProblem } from '../../schema/name.js';
import { renderSchemaFile } from '../../schema/render.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';

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

/** The name parameter's description, its examples the vault's own project and person kinds. */
function schemaNameDescription({ vault }: ExampleNames): string {
  const examples = [vault.projectType, vault.personType].filter((name): name is string => typeof name === 'string');
  return examples.length > 0 ? `Unique schema name (e.g. ${examples.map(name => JSON.stringify(name)).join(', ')})` : 'Unique schema name';
}

export function registerCreateSchema(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.registerTool(
    'create-schema',
    {
      description: 'Creates a new schema definition with field claims. Referenced global fields must already exist.',
      inputSchema: relationshipViewsToolInput({
        name: z.string().describe(schemaNameDescription(exampleNamesFor(db))),
        display_name: z.string().optional().describe('Human-friendly display name'),
        icon: z.string().optional().describe('Icon identifier for the schema'),
        filename_template: z.string().optional().describe('Template for generating filenames (name only, e.g. "{date} - {title}.md")'),
        default_directory: z.string().optional().describe('Default directory for new files of this type (e.g. "Persons")'),
        field_claims: z.array(fieldClaimSchema).describe('Fields this schema claims from the global pool'),
        metadata: z.unknown().optional().describe('Arbitrary metadata outside the reserved saved-definition namespace'),
      }, { description: 'Saved relationship and rollup definitions' }),
    },
    async (params) => {
      const nameProblem = schemaNameProblem(params.name);
      if (nameProblem !== null) return fail('INVALID_PARAMS', nameProblem);

      let operation_id: string | undefined;
      try {
        // Creation accepts definitions only; null is an update-only removal request.
        if (params.relationship_views !== undefined) parseRelationshipViews(params.relationship_views);
        let result: ReturnType<typeof createSchemaDefinition> | undefined;
        let rendered = true;
        operation_id = withGlobalFieldTransaction(db, fsRollback => {
          previewSchemaClassification(db,params.name,params);
          const transactionOperationId = createOperation(db, {
            source_tool: 'create-schema',
            description: `create-schema: ${params.name}`,
          });
          captureSchemaSnapshot(db, transactionOperationId, params.name, { was_new: true });
          result = createSchemaDefinition(db, params);
          if (ctx?.vaultPath) rendered = renderSchemaFile(db, ctx.vaultPath, params.name, fsRollback);
          return transactionOperationId;
        });

        db.prepare('UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?').run(operation_id);

        return ok({ ...result!, operation_id }, !rendered && params.relationship_views !== undefined ? [{
          code: 'SCHEMA_FILE_RENDER_BLOCKED', severity: 'warning',
          message: 'Schema definitions committed; YAML export was blocked by an external edit.', details: { schema: params.name },
        }] : []);
      } catch (err) {
        if (err instanceof ClassificationError) return fail(err.code, err.message, {details:err.details as Record<string,unknown>});
        if (err instanceof RollupError || err instanceof SummaryError) return fail(err.code, err.message, { details: err.details });
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
    },
  );
}
