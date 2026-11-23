import type Database from 'better-sqlite3';
import { createGlobalField, getGlobalField } from '../global-fields/crud.js';
import { createSchemaDefinition, getSchemaDefinition, patchSchemaDefinition, type ClaimInput } from '../schema/crud.js';
import { captureGlobalFieldSnapshot } from '../undo/global-field-snapshot.js';
import { captureSchemaSnapshot } from '../undo/schema-snapshot.js';
import { getWikiConfig, requireWikiType, type WikiConfig } from './config.js';
import { WIKI_STATUSES } from './status-values.js';

const WIKI_FIELD_CLAIMS = [
  { field: 'wiki_for', sort_order: 100 },
  { field: 'wiki_parent', sort_order: 110 },
  { field: 'wiki_evidence_hash', sort_order: 120 },
  { field: 'wiki_status', sort_order: 125 },
  { field: 'wiki_curated_at', sort_order: 130 },
  { field: 'wiki_state', sort_order: 140 },
  { field: 'wiki_kind', sort_order: 150 },
  { field: 'wiki_origin', sort_order: 160 },
  { field: 'wiki_scope', sort_order: 170 },
  { field: 'wiki_replaced_by', sort_order: 180 },
  { field: 'wiki_pinned', sort_order: 190 },
  { field: 'wiki_topology_hash', sort_order: 200 },
  { field: 'wiki_reconcile_key', sort_order: 210 },
] satisfies readonly ClaimInput[];

interface SchemaClaimRow {
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
}

export interface BootstrapResult {
  created_global_fields: string[];
  created_schemas: string[];
  added_schema_claims: string[];
}

function readSchemaClaims(db: Database.Database, schemaName: string): ClaimInput[] {
  const rows = db.prepare(`
    SELECT field, label, description, sort_order, required_override,
      default_value_override, default_value_overridden, enum_values_override
    FROM schema_field_claims
    WHERE schema_name = ?
    ORDER BY rowid
  `).all(schemaName) as SchemaClaimRow[];

  return rows.map(row => ({
    field: row.field,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.description === null ? {} : { description: row.description }),
    sort_order: row.sort_order,
    ...(row.required_override === null ? {} : { required: row.required_override === 1 }),
    ...(row.default_value_overridden === 0 ? {} : {
      default_value: row.default_value_override === null ? null : JSON.parse(row.default_value_override),
    }),
    ...(row.enum_values_override === null ? {} : { enum_values_override: JSON.parse(row.enum_values_override) }),
  }));
}

function missingWikiClaims(claims: readonly ClaimInput[]): ClaimInput[] {
  const claimedFields = new Set(claims.map(claim => claim.field));
  return WIKI_FIELD_CLAIMS.filter(claim => !claimedFields.has(claim.field)).map(claim => ({ ...claim }));
}

export function getWikiBootstrapPlan(db: Database.Database, config: WikiConfig): BootstrapResult {
  const wikiType = requireWikiType(config);
  const created_global_fields: string[] = [];
  if (!getGlobalField(db, 'wiki_for')) created_global_fields.push('wiki_for');
  if (!getGlobalField(db, 'wiki_parent')) created_global_fields.push('wiki_parent');
  if (!getGlobalField(db, 'wiki_evidence_hash')) created_global_fields.push('wiki_evidence_hash');
  if (!getGlobalField(db, 'wiki_status')) created_global_fields.push('wiki_status');
  if (!getGlobalField(db, 'wiki_curated_at')) created_global_fields.push('wiki_curated_at');
  if (!getGlobalField(db, 'wiki_state')) created_global_fields.push('wiki_state');
  if (!getGlobalField(db, 'wiki_kind')) created_global_fields.push('wiki_kind');
  if (!getGlobalField(db, 'wiki_origin')) created_global_fields.push('wiki_origin');
  if (!getGlobalField(db, 'wiki_scope')) created_global_fields.push('wiki_scope');
  if (!getGlobalField(db, 'wiki_replaced_by')) created_global_fields.push('wiki_replaced_by');
  if (!getGlobalField(db, 'wiki_pinned')) created_global_fields.push('wiki_pinned');
  if (!getGlobalField(db, 'wiki_topology_hash')) created_global_fields.push('wiki_topology_hash');
  if (!getGlobalField(db, 'wiki_reconcile_key')) created_global_fields.push('wiki_reconcile_key');
  const schemaExists = getSchemaDefinition(db, wikiType) !== null;
  const added_schema_claims = missingWikiClaims(schemaExists ? readSchemaClaims(db, wikiType) : []);
  return {
    created_global_fields,
    created_schemas: schemaExists ? [] : [wikiType],
    added_schema_claims: added_schema_claims.map(claim => claim.field),
  };
}

export function ensureWikiSchema(
  db: Database.Database,
  config: WikiConfig,
  operation_id?: string,
): BootstrapResult {
  const wikiType = requireWikiType(config);
  const result: BootstrapResult = { created_global_fields: [], created_schemas: [], added_schema_claims: [] };
  const tx = db.transaction(() => {
    if (!getGlobalField(db, 'wiki_for')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_for', { was_new: true });
      // Untyped: wiki roots are projects or Curator topics, and writers store the
      // root's exact path. A typed target leaves topic homes unresolved under
      // reference policy v2 (#220).
      createGlobalField(db, {
        name: 'wiki_for',
        field_type: 'reference',
        description: 'Project or topic this wiki page summarizes',
      });
      result.created_global_fields.push('wiki_for');
    }

    if (!getGlobalField(db, 'wiki_parent')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_parent', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_parent',
        field_type: 'reference',
        reference_target: wikiType,
        description: 'Home wiki page for this wiki sub-page',
      });
      result.created_global_fields.push('wiki_parent');
    }

    // Curation-state fields, written by the external vault-curator on each run so
    // it can skip re-synthesis when a project's evidence is unchanged.
    if (!getGlobalField(db, 'wiki_evidence_hash')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_evidence_hash', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_evidence_hash',
        field_type: 'string',
        description: 'Curator: fingerprint of the project evidence at last curation; used to skip re-synthesis when unchanged.',
      });
      result.created_global_fields.push('wiki_evidence_hash');
    }

    // The wiki's state, on its home page only (#547). The Curator writes paused, building
    // and failed; the Engine moves current to behind (and paused to paused-behind) when the
    // project's evidence stops matching the last build (wiki/status.ts).
    if (!getGlobalField(db, 'wiki_status')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_status', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_status',
        field_type: 'enum',
        enum_values: [...WIKI_STATUSES],
        description: 'The wiki\'s state, on its home page: current, behind (its notes changed since the last build), paused, paused-behind (paused, and its notes changed since the last build), building or failed.',
      });
      result.created_global_fields.push('wiki_status');
    }

    if (!getGlobalField(db, 'wiki_curated_at')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_curated_at', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_curated_at',
        field_type: 'date',
        description: 'Curator: timestamp of the last automated curation of this wiki page.',
      });
      result.created_global_fields.push('wiki_curated_at');
    }

    // Lifecycle state of a wiki sub-page, set by the external curator when it
    // retires an emergent themed page. Absence renders as "active" (defaults are
    // creation-only), so this never needs backfilling onto existing pages.
    if (!getGlobalField(db, 'wiki_state')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_state', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_state',
        field_type: 'enum',
        enum_values: ['active', 'dormant', 'retired'],
        description: 'Curator: lifecycle state of a wiki sub-page (active workstream, dormant, or retired). Absence renders as active.',
      });
      result.created_global_fields.push('wiki_state');
    }

    if (!getGlobalField(db, 'wiki_kind')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_kind', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_kind',
        field_type: 'enum',
        enum_values: ['workstream', 'decision-log', 'risk-register', 'timeline', 'stakeholder-map', 'spotlight', 'freeform'],
        description: 'Curator: presentation archetype for a wiki sub-page; not unique identity.',
      });
      result.created_global_fields.push('wiki_kind');
    }

    if (!getGlobalField(db, 'wiki_origin')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_origin', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_origin',
        field_type: 'enum',
        enum_values: ['automatic', 'requested'],
        description: 'Curator: creation origin. Legacy absence is interpreted as automatic.',
      });
      result.created_global_fields.push('wiki_origin');
    }

    if (!getGlobalField(db, 'wiki_scope')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_scope', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_scope',
        field_type: 'string',
        description: 'Curator: canonical WikiScopeV1 JSON.',
      });
      result.created_global_fields.push('wiki_scope');
    }

    if (!getGlobalField(db, 'wiki_replaced_by')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_replaced_by', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_replaced_by',
        field_type: 'reference',
        reference_target: wikiType,
        description: 'Curator: canonical successor after a merge.',
      });
      result.created_global_fields.push('wiki_replaced_by');
    }

    if (!getGlobalField(db, 'wiki_pinned')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_pinned', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_pinned',
        field_type: 'boolean',
        description: 'Curator: owner-requested retention intent.',
      });
      result.created_global_fields.push('wiki_pinned');
    }

    if (!getGlobalField(db, 'wiki_topology_hash')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_topology_hash', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_topology_hash',
        field_type: 'string',
        description: 'Curator: post-write sub-page topology fingerprint on the home page.',
      });
      result.created_global_fields.push('wiki_topology_hash');
    }

    if (!getGlobalField(db, 'wiki_reconcile_key')) {
      if (operation_id) captureGlobalFieldSnapshot(db, operation_id, 'wiki_reconcile_key', { was_new: true });
      createGlobalField(db, {
        name: 'wiki_reconcile_key',
        field_type: 'string',
        description: 'Curator: versioned JSON containing the latest idempotency key and normalized plan digest on the home page.',
      });
      result.created_global_fields.push('wiki_reconcile_key');
    }

    const existingSchema = getSchemaDefinition(db, wikiType);
    if (!existingSchema) {
      if (operation_id) captureSchemaSnapshot(db, operation_id, wikiType, { was_new: true });
      createSchemaDefinition(db, {
        name: wikiType,
        display_name: 'Wiki',
        default_directory: config.wikiDir,
        field_claims: missingWikiClaims([]),
        metadata: { engine_managed: true, feature: 'project-wiki' },
      });
      result.created_schemas.push(wikiType);
      result.added_schema_claims.push(...WIKI_FIELD_CLAIMS.map(claim => claim.field));
    } else {
      const existingClaims = readSchemaClaims(db, wikiType);
      const addedClaims = missingWikiClaims(existingClaims);
      if (addedClaims.length > 0) {
        if (operation_id) captureSchemaSnapshot(db, operation_id, wikiType);
        patchSchemaDefinition(db, wikiType, { add_field_claims: addedClaims });
        result.added_schema_claims.push(...addedClaims.map(claim => claim.field));
      }
    }
  });
  tx();

  if (operation_id && (result.created_schemas.length > 0 || result.added_schema_claims.length > 0)) {
    db.prepare('UPDATE undo_operations SET schema_count = schema_count + 1 WHERE operation_id = ?').run(operation_id);
  }
  return result;
}

/**
 * At Engine start, give an existing wiki schema the fields and claims a newer Engine
 * defines (`wiki_status`, #547), so they are claimed before anything writes them. It
 * changes no file. A vault with no wiki schema yet gets one at its first wiki write, as
 * before. Returns what it added, or null when nothing was missing.
 */
export function upgradeWikiSchemaOnBoot(db: Database.Database): BootstrapResult | null {
  const config = getWikiConfig(db);
  if (config.wikiType === null || getSchemaDefinition(db, config.wikiType) === null) return null;
  const plan = getWikiBootstrapPlan(db, config);
  if (plan.created_global_fields.length === 0 && plan.added_schema_claims.length === 0) return null;
  return ensureWikiSchema(db, config);
}
