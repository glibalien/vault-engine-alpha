import { inputDefinitionHash } from '../../classification/preview.js';
import { loadClassificationInput } from '../../classification/read.js';
import { createClassificationReadContext } from '../../classification/read.js';
import { describeRelationshipViews } from '../../rollups/definitions.js';
import { createFieldMap } from '../../fields/field-map.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';

interface SchemaRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
}

interface ClaimRow {
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number | null;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
  enum_groups_override: string | null;
  ai_guessable_override: number | null;
}

interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  enum_groups: string | null;
  overrides_allowed_enum_groups: number;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  ai_guessable: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  overrides_allowed_ai_guessable: number;
  list_item_type: string | null;
  ui_hints: string | null;
}

interface OrphanRow {
  field_name: string;
  count: number;
}

const includeSchema = z.array(z.enum(['coverage', 'orphans', 'overrides', 'relationship_views', 'classification'])).optional();

export function registerDescribeSchema(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-schema',
    'Returns a named schema in a compact creation-oriented shape, including filename_template and default_directory for type-based file placement. Pass `include` to layer in audit data: "coverage" (node_count + field_coverage), "orphans" (orphan_field_names), "overrides" (per-field override detail + full global_field blocks).',
    {
      name: z.string().describe('Schema name'),
      include: includeSchema.describe('Audit sections to add. Any subset of coverage, orphans, overrides, relationship_views.'),
    },
    async ({ name, include }) => {
      const row = db.prepare('SELECT name, display_name, icon, filename_template, default_directory, metadata FROM schemas WHERE name = ?')
        .get(name) as SchemaRow | undefined;

      if (!row) {
        return fail('NOT_FOUND', `Schema '${name}' not found`);
      }

      const includeSet = new Set(include ?? []);
      const wantCoverage = includeSet.has('coverage');
      const wantOrphans = includeSet.has('orphans');
      const wantOverrides = includeSet.has('overrides');

      const claims = db.prepare(
        'SELECT field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override, enum_groups_override, ai_guessable_override FROM schema_field_claims WHERE schema_name = ? ORDER BY sort_order ASC, field ASC'
      ).all(name) as ClaimRow[];

      const globalFieldStmt = db.prepare('SELECT * FROM global_fields WHERE name = ?');
      const fields = claims.map(claim => {
        const gf = globalFieldStmt.get(claim.field) as GlobalFieldRow | undefined;
        const overridden = claim.default_value_overridden === 1;
        const defaultValueOverride = overridden
          ? (claim.default_value_override !== null ? JSON.parse(claim.default_value_override) : null)
          : undefined;
        const enumValuesOverride = claim.enum_values_override !== null
          ? JSON.parse(claim.enum_values_override) : null;

        const resolvedRequired = claim.required_override !== null
          ? Boolean(claim.required_override)
          : (gf ? Boolean(gf.required) : false);
        const resolvedAiGuessable = claim.ai_guessable_override !== null
          ? Boolean(claim.ai_guessable_override)
          : (gf ? Boolean(gf.ai_guessable) : false);
        const resolvedDefaultValue = overridden
          ? defaultValueOverride
          : (gf?.default_value ? JSON.parse(gf.default_value) : null);
        const resolvedEnumValues = enumValuesOverride !== null
          ? enumValuesOverride
          : (gf?.enum_values ? JSON.parse(gf.enum_values) : null);

        const field: Record<string, unknown> = {
          name: claim.field,
          type: gf?.field_type ?? 'unknown',
          required: resolvedRequired,
          ai_guessable: resolvedAiGuessable,
          default_value: resolvedDefaultValue,
        };

        // Only include shape-specific attributes when they apply
        if (resolvedEnumValues !== null) field.enum_values = resolvedEnumValues;
        if (gf?.reference_target) field.reference_target = gf.reference_target;
        if (gf?.list_item_type) field.list_item_type = gf.list_item_type;

        // Label/description: include only when non-null
        const description = claim.description ?? gf?.description ?? null;
        if (claim.label !== null) field.label = claim.label;
        if (description !== null) field.description = description;

        // ui hints (always present in shape; null when unset).
        // v1: per-claim ui equals the global-field ui (no per-type override).
        field.ui = gf?.ui_hints ? JSON.parse(gf.ui_hints) : null;

        if (wantOverrides) {
          field.required_override = claim.required_override === null ? null : Boolean(claim.required_override);
          field.default_value_override = overridden
            ? { overridden: true, value: defaultValueOverride }
            : { overridden: false };
          field.enum_values_override = enumValuesOverride;
          field.enum_groups_override = claim.enum_groups_override ? JSON.parse(claim.enum_groups_override) : null;
          field.ai_guessable_override = claim.ai_guessable_override === null ? null : Boolean(claim.ai_guessable_override);
          field.sort_order = claim.sort_order;
          field.global_field = gf ? {
            field_type: gf.field_type,
            enum_groups: gf.enum_groups ? JSON.parse(gf.enum_groups) : null,
            enum_values: gf.enum_values ? JSON.parse(gf.enum_values) : null,
            reference_target: gf.reference_target,
            description: gf.description,
            default_value: gf.default_value ? JSON.parse(gf.default_value) : null,
            required: Boolean(gf.required),
            ai_guessable: Boolean(gf.ai_guessable),
            overrides_allowed: {
              enum_groups: Boolean(gf.overrides_allowed_enum_groups),
              required: Boolean(gf.overrides_allowed_required),
              default_value: Boolean(gf.overrides_allowed_default_value),
              enum_values: Boolean(gf.overrides_allowed_enum_values),
              ai_guessable: Boolean(gf.overrides_allowed_ai_guessable),
            },
            list_item_type: gf.list_item_type,
            ui_hints: gf.ui_hints ? JSON.parse(gf.ui_hints) : null,
          } : null;
        }

        return field;
      });

      const response: Record<string, unknown> = {
        name: row.name,
        display_name: row.display_name,
        icon: row.icon,
        filename_template: row.filename_template,
        default_directory: row.default_directory,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        fields,
      };

      if (wantCoverage) {
        const nodeCountRow = db.prepare(
          'SELECT COUNT(*) as count FROM node_types WHERE schema_type = ?'
        ).get(name) as { count: number };
        response.node_count = nodeCountRow.count;

        const coverageStmt = db.prepare(
          `SELECT COUNT(*) as count FROM node_fields nf
           JOIN node_types nt ON nt.node_id = nf.node_id AND nt.schema_type = ?
           WHERE nf.field_name = ?`
        );
        const field_coverage = createFieldMap<{ have_value: number; total: number }>();
        for (const claim of claims) {
          const coverageRow = coverageStmt.get(name, claim.field) as { count: number };
          field_coverage[claim.field] = { have_value: coverageRow.count, total: nodeCountRow.count };
        }
        response.field_coverage = field_coverage;
      }

      if (wantOrphans) {
        const orphan_field_names = db.prepare(
          `SELECT nf.field_name, COUNT(*) as count
           FROM node_fields nf
           JOIN node_types nt ON nt.node_id = nf.node_id AND nt.schema_type = ?
           WHERE nf.field_name NOT IN (SELECT field FROM schema_field_claims WHERE schema_name = ?)
           GROUP BY nf.field_name
           ORDER BY count DESC`
        ).all(name, name) as OrphanRow[];
        response.orphan_field_names = orphan_field_names.map(r => ({ field: r.field_name, count: r.count }));
      }

      if (includeSet.has('relationship_views')) {
        const views = describeRelationshipViews(db, name);
        response.relationship_views = views;
        response.relationship_views_hash = views.relationship_views_hash;
      }
      if (includeSet.has('classification')) {
        response.classification = db.transaction(() => {
          const fields = createFieldMap<unknown>();
          const read = createClassificationReadContext(db);
          for (const claim of claims) {
            const field = db.prepare('SELECT field_type FROM global_fields WHERE name=?').get(claim.field) as {field_type:string};
            if (field.field_type !== 'enum') continue;
            try { fields[claim.field] = { available: true, ...read.resolve({schema:name,field:claim.field}) }; }
            catch(error) { fields[claim.field] = {available:false,definition_hash:inputDefinitionHash(loadClassificationInput(db,{schema:name,field:claim.field})),issue:{code:'CLASSIFICATION_INVALID_CONFIG',message:error instanceof Error ? error.message : String(error)}}; }
          }
          return {version:1,operators:['in_group','is_unclassified'],fields};
        }).deferred();
      }
      return ok(response);
    },
  );
}
