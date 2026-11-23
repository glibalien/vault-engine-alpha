// src/schema/crud.ts

import { getGlobalField } from '../global-fields/crud.js';
import { resolveEnumGroups } from '../classification/resolver.js';
import type { EnumGroupsV1 } from '../classification/types.js';
import { normalizeRelationshipViewsMutation, type RelationshipViewsMutationInput } from '../rollups/mutation.js';
import type Database from 'better-sqlite3';
import { SchemaValidationError, type ValidationGroup } from './errors.js';
import { readCurrentClaims } from './claims.js';
import { supportsAiGuessing } from '../field-guess/field-name.js';
import { assertFieldGuessCandidateIdentityBudget } from '../field-guess/candidate-contract.js';
import { schemaNameProblem } from './name.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface SchemaDefinition {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: unknown;
}

export interface ClaimInput {
  expected_enum_groups_hash?: string;
  expected_global_enum_groups_hash?: string;
  field: string;
  label?: string;
  description?: string;
  sort_order?: number;
  required?: boolean;                        // maps to required_override column
  ai_guessable?: boolean;                    // maps to ai_guessable_override column
  default_value?: unknown;                   // maps to default_value_override column
  default_value_overridden?: boolean;        // true when default_value key is present (even if null)
  enum_groups_override?: EnumGroupsV1 | null;
  enum_values_override?: string[];           // maps to enum_values_override column
}

export interface CreateSchemaInput extends RelationshipViewsMutationInput {
  name: string;
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims: ClaimInput[];
  metadata?: unknown;
}

export interface UpdateSchemaInput extends RelationshipViewsMutationInput {
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims?: ClaimInput[];
  metadata?: unknown;
}

export interface PatchSchemaInput extends RelationshipViewsMutationInput {
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  add_field_claims?: ClaimInput[];
  update_field_claims?: ClaimInput[];
  remove_field_claims?: string[];
  metadata?: unknown;
}

// ── Row → SchemaDefinition ────────────────────────────────────────────

interface SchemaRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
}

function rowToDefinition(row: SchemaRow): SchemaDefinition {
  return {
    name: row.name,
    display_name: row.display_name,
    icon: row.icon,
    filename_template: row.filename_template,
    default_directory: row.default_directory,
    metadata: row.metadata !== null ? JSON.parse(row.metadata) : null,
  };
}

// ── Claim validation ──────────────────────────────────────────────────

interface GlobalFieldRow {
  name: string;
  field_type: string;
  list_item_type: string | null;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  overrides_allowed_ai_guessable: number;
}

function validateClaims(
  db: Database.Database,
  claims: ClaimInput[],
  existingAiGuessableOverrides: ReadonlyMap<string, boolean> = new Map(),
  preservedRequiredOverrides: ReadonlyMap<string, boolean> = new Map(),
): void {
  const groups: ValidationGroup[] = [];

  for (const claim of claims) {
    const gf = db
      .prepare(`SELECT name, field_type, list_item_type, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, overrides_allowed_ai_guessable FROM global_fields WHERE name = ?`)
      .get(claim.field) as GlobalFieldRow | undefined;

    if (!gf) {
      groups.push({
        reason: 'UNKNOWN_FIELD',
        field: claim.field,
        count: 1,
        message: `Global field '${claim.field}' does not exist. Create it first with create-global-field.`,
      });
      continue; // subsequent checks on this claim are meaningless without gf
    }

    const definition = getGlobalField(db, claim.field)!;
    if (claim.enum_groups_override != null || definition.enum_groups != null) resolveEnumGroups({context:{schema:'claim-validation',field:claim.field},fieldType:definition.field_type,globalValues:definition.enum_values,typeValues:claim.enum_values_override ?? null,globalGroups:definition.enum_groups ?? null,override:claim.enum_groups_override ?? null,overrideAllowed:definition.overrides_allowed.enum_groups === true});

    const preservesRequiredOverride = claim.required !== undefined
      && preservedRequiredOverrides.get(claim.field) === claim.required;
    if (claim.required !== undefined && !preservesRequiredOverride && gf.overrides_allowed_required !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow required overrides. Set overrides_allowed.required = true on the global field.`,
      });
    }
    if ((claim.default_value !== undefined || claim.default_value_overridden) && gf.overrides_allowed_default_value !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow default_value overrides. Set overrides_allowed.default_value = true on the global field.`,
      });
    }
    if (claim.enum_values_override !== undefined && gf.overrides_allowed_enum_values !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow enum_values overrides. Set overrides_allowed.enum_values = true on the global field.`,
      });
    }
    const preservesExistingAiGuessableOverride =
      claim.ai_guessable !== undefined &&
      existingAiGuessableOverrides.get(claim.field) === claim.ai_guessable;
    if (claim.ai_guessable !== undefined && !preservesExistingAiGuessableOverride && gf.overrides_allowed_ai_guessable !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow ai_guessable overrides. Set overrides_allowed.ai_guessable = true on the global field.`,
      });
    }
    if (claim.ai_guessable === true && !preservesExistingAiGuessableOverride && !supportsAiGuessing(claim.field)) {
      groups.push({
        reason: 'STRUCTURAL_INCOMPAT',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' cannot enable AI guessing because its name is reserved.`,
      });
    }

    if (claim.enum_values_override !== undefined) {
      const isEnumCompatible =
        gf.field_type === 'enum' ||
        (gf.field_type === 'list' && gf.list_item_type === 'enum');
      if (!isEnumCompatible) {
        groups.push({
          reason: 'STRUCTURAL_INCOMPAT',
          field: claim.field,
          count: 1,
          message: `Field '${claim.field}' (${gf.field_type}${gf.list_item_type ? '<' + gf.list_item_type + '>' : ''}) is structurally incompatible with enum_values_override. Only enum and list<enum> fields support enum overrides.`,
        });
      }
    }
  }

  if (groups.length > 0) throw new SchemaValidationError(groups);
}

// ── Insert claims ─────────────────────────────────────────────────────

function insertClaims(db: Database.Database, schemaName: string, claims: ClaimInput[]): void {
  const stmt = db.prepare(`
    INSERT INTO schema_field_claims (schema_name, field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override, ai_guessable_override, enum_groups_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const claim of claims) {
    const requiredInt =
      claim.required === undefined ? null : claim.required ? 1 : 0;
    const aiGuessableInt =
      claim.ai_guessable === undefined ? null : claim.ai_guessable ? 1 : 0;

    // Discriminated union: default_value_overridden distinguishes inherit from override-to-null
    const overridden = claim.default_value_overridden ?? (claim.default_value !== undefined);
    const defaultValueJson = overridden
      ? (claim.default_value !== undefined && claim.default_value !== null ? JSON.stringify(claim.default_value) : null)
      : null;

    const enumOverrideJson = claim.enum_values_override
      ? JSON.stringify(claim.enum_values_override)
      : null;

    stmt.run(
      schemaName,
      claim.field,
      claim.label ?? null,
      claim.description ?? null,
      claim.sort_order ?? null,
      requiredInt,
      defaultValueJson,
      overridden ? 1 : 0,
      enumOverrideJson,
      aiGuessableInt,
      claim.enum_groups_override == null ? null : JSON.stringify(claim.enum_groups_override),
    );
  }
}

// ── getSchemaDefinition ───────────────────────────────────────────────

export function getSchemaDefinition(
  db: Database.Database,
  name: string,
): SchemaDefinition | null {
  const row = db
    .prepare(`SELECT name, display_name, icon, filename_template, default_directory, metadata FROM schemas WHERE name = ?`)
    .get(name) as SchemaRow | undefined;
  return row ? rowToDefinition(row) : null;
}

// ── createSchemaDefinition ────────────────────────────────────────────

export function createSchemaDefinition(
  db: Database.Database,
  input: CreateSchemaInput,
): SchemaDefinition {
  // Every new schema comes through here (create-schema, the wiki and transcript kinds), so
  // this is where a name that can't be a file in .schemas/ is refused (#473).
  const nameProblem = schemaNameProblem(input.name);
  if (nameProblem !== null) throw new Error(nameProblem);
  validateClaims(db, input.field_claims);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO schemas (name, display_name, icon, filename_template, default_directory, field_claims, metadata)
      VALUES (?, ?, ?, ?, ?, '[]', ?)
    `).run(
      input.name,
      input.display_name ?? null,
      input.icon ?? null,
      input.filename_template ?? null,
      input.default_directory ?? null,
      null,
    );

    const metadata = normalizeRelationshipViewsMutation(db, undefined, input, true);
    db.prepare('UPDATE schemas SET metadata=? WHERE name=?').run(metadata === undefined ? null : JSON.stringify(metadata), input.name);
    insertClaims(db, input.name, input.field_claims);
    assertFieldGuessCandidateIdentityBudget(db);
  });

  tx();

  return getSchemaDefinition(db, input.name)!;
}

// ── updateSchemaDefinition ────────────────────────────────────────────

function applySchemaDefinitionUpdate(
  db: Database.Database,
  name: string,
  input: UpdateSchemaInput,
  preservedAiGuessableOverrides: ReadonlyMap<string, boolean> = new Map(),
  preservedRequiredOverrides: ReadonlyMap<string, boolean> = new Map(),
): SchemaDefinition {
  const current = getSchemaDefinition(db, name);
  if (!current) {
    throw new Error(`Schema '${name}' not found`);
  }

  if (input.field_claims !== undefined) {
    validateClaims(db, input.field_claims, preservedAiGuessableOverrides, preservedRequiredOverrides);
  }

  const tx = db.transaction(() => {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.display_name !== undefined) {
      updates.push('display_name = ?');
      params.push(input.display_name);
    }
    if (input.icon !== undefined) {
      updates.push('icon = ?');
      params.push(input.icon);
    }
    if (input.filename_template !== undefined) {
      updates.push('filename_template = ?');
      params.push(input.filename_template);
    }
    if (input.default_directory !== undefined) {
      updates.push('default_directory = ?');
      params.push(input.default_directory);
    }
    if (input.metadata !== undefined || input.relationship_views !== undefined) {
      const metadata = normalizeRelationshipViewsMutation(db, getSchemaDefinition(db, name)!.metadata, input);
      updates.push('metadata = ?');
      params.push(JSON.stringify(metadata));
    }

    if (updates.length > 0) {
      params.push(name);
      db.prepare(`UPDATE schemas SET ${updates.join(', ')} WHERE name = ?`).run(...params);
    }

    if (input.field_claims !== undefined) {
      db.prepare(`DELETE FROM schema_field_claims WHERE schema_name = ?`).run(name);
      insertClaims(db, name, input.field_claims);
    }
    assertFieldGuessCandidateIdentityBudget(db);
  });

  tx();

  return getSchemaDefinition(db, name)!;
}

// ── updateSchemaDefinition ────────────────────────────────────────────

export function updateSchemaDefinition(
  db: Database.Database,
  name: string,
  input: UpdateSchemaInput,
): SchemaDefinition {
  return applySchemaDefinitionUpdate(db, name, input);
}

// ── patchSchemaDefinition ───────────────────────────

export function patchSchemaDefinition(
  db: Database.Database,
  name: string,
  input: PatchSchemaInput,
): SchemaDefinition {
  if (Object.prototype.hasOwnProperty.call(input, 'field_claims')) {
    throw new Error('field_claims is a full replacement and is not accepted by patchSchemaDefinition.');
  }

  const current = getSchemaDefinition(db, name);
  if (!current) {
    throw new Error(`Schema '${name}' not found`);
  }

  const currentClaims = readCurrentClaims(db, name);
  const claimsByField = new Map<string, ClaimInput>();
  const preservedAiGuessableOverrides = new Map<string, boolean>();
  const preservedRequiredOverrides = new Map<string, boolean>();

  for (const claim of currentClaims) {
    claimsByField.set(claim.field, {
      field: claim.field,
      sort_order: claim.sort_order,
      label: claim.label,
      description: claim.description,
      required: claim.required ?? undefined,
      ai_guessable: claim.ai_guessable ?? undefined,
      default_value: claim.default_value,
      default_value_overridden: claim.default_value !== undefined,
      enum_values_override: claim.enum_values_override ?? undefined,
      enum_groups_override: claim.enum_groups_override ?? null,
    });
    // A patch carries forward stored requirements; only explicitly supplied overrides need permission.
    if (claim.required !== null && claim.required !== undefined) {
      preservedRequiredOverrides.set(claim.field, claim.required);
    }
    if (claim.ai_guessable !== null && claim.ai_guessable !== undefined) {
      preservedAiGuessableOverrides.set(claim.field, claim.ai_guessable);
    }
  }

  for (const claim of input.add_field_claims ?? []) {
    if (claimsByField.has(claim.field)) {
      throw new Error(`Cannot add claim '${claim.field}' because schema '${name}' already claims it. Use update_field_claims to modify it.`);
    }
    claimsByField.set(claim.field, claim);
  }

  for (const claim of input.update_field_claims ?? []) {
    const existing = claimsByField.get(claim.field);
    if (!existing) {
      throw new Error(`Cannot update claim '${claim.field}' because schema '${name}' does not claim it. Use add_field_claims to add it.`);
    }
    claimsByField.set(claim.field, {
      ...existing,
      ...claim,
      default_value_overridden: claim.default_value !== undefined
        ? true
        : claim.default_value_overridden ?? existing.default_value_overridden,
    });
    if (claim.required !== undefined) {
      preservedRequiredOverrides.delete(claim.field);
    }
    if (claim.ai_guessable !== undefined) {
      preservedAiGuessableOverrides.delete(claim.field);
    }
  }

  for (const field of input.remove_field_claims ?? []) {
    if (!claimsByField.has(field)) {
      throw new Error(`Cannot remove claim '${field}' because schema '${name}' does not claim it.`);
    }
    claimsByField.delete(field);
    preservedAiGuessableOverrides.delete(field);
    preservedRequiredOverrides.delete(field);
  }

  const update: UpdateSchemaInput = {
    field_claims: Array.from(claimsByField.values()),
  };
  if (input.display_name !== undefined) update.display_name = input.display_name;
  if (input.icon !== undefined) update.icon = input.icon;
  if (input.filename_template !== undefined) update.filename_template = input.filename_template;
  if (input.default_directory !== undefined) update.default_directory = input.default_directory;
  if (input.metadata !== undefined) update.metadata = input.metadata;
  if (input.relationship_views !== undefined) update.relationship_views = input.relationship_views;
  if (input.expected_relationship_views_hash !== undefined) update.expected_relationship_views_hash = input.expected_relationship_views_hash;

  return applySchemaDefinitionUpdate(db, name, update, preservedAiGuessableOverrides, preservedRequiredOverrides);
}

// ── deleteSchemaDefinition ───────────────────────────

export function deleteSchemaDefinition(
  db: Database.Database,
  name: string,
): { affected_nodes: number } {
  const current = getSchemaDefinition(db, name);
  if (!current) {
    throw new Error(`Schema '${name}' not found`);
  }

  const affectedNodes = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = ?`)
      .get(name) as { cnt: number }
  ).cnt;

  // CASCADE removes schema_field_claims
  db.prepare(`DELETE FROM schemas WHERE name = ?`).run(name);

  return { affected_nodes: affectedNodes };
}
