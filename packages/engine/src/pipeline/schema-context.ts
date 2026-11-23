// src/pipeline/schema-context.ts
//
// Stage 1: Load schema context (claims-by-type and global field definitions)
// from the DB for a set of proposed types.

import type Database from 'better-sqlite3';
import type { EffectiveFieldSet, FieldClaim, GlobalFieldDefinition } from '../validation/types.js';
import { getGlobalField, listGlobalFields } from '../global-fields/crud.js';
import { mergeFieldClaims } from '../validation/merge.js';

export interface SchemaContext {
  claimsByType: Map<string, FieldClaim[]>;
  globalFields: Map<string, GlobalFieldDefinition>;
}

interface FieldClaimRow {
  schema_name: string;
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

function rowToFieldClaim(row: FieldClaimRow): FieldClaim {
  return {
    schema_name: row.schema_name,
    field: row.field,
    label: row.label,
    description: row.description,
    sort_order: row.sort_order ?? 1000,
    required_override: row.required_override !== null ? row.required_override === 1 : null,
    default_value_override: row.default_value_overridden === 1
      ? {
          kind: 'override',
          value: row.default_value_override !== null ? JSON.parse(row.default_value_override) : null,
        }
      : { kind: 'inherit' },
    enum_groups_override: row.enum_groups_override ? JSON.parse(row.enum_groups_override) : null,
    enum_values_override: row.enum_values_override !== null
      ? JSON.parse(row.enum_values_override) as string[]
      : null,
    ai_guessable_override: row.ai_guessable_override !== null
      ? row.ai_guessable_override === 1
      : null,
  };
}

/**
 * Load claims-by-type and global field definitions for the given types.
 * Same pattern as the validate-node tool handler, extracted for reuse.
 */
export function loadSchemaContext(db: Database.Database, types: string[]): SchemaContext {
  const claimsByType = new Map<string, FieldClaim[]>();

  for (const typeName of types) {
    const rows = db.prepare(`
      SELECT *
      FROM schema_field_claims
      WHERE schema_name = ?
      ORDER BY sort_order, field
    `).all(typeName) as FieldClaimRow[];

    if (rows.length > 0) {
      claimsByType.set(typeName, rows.map(rowToFieldClaim));
    }
  }

  const globalFields = new Map<string, GlobalFieldDefinition>();
  const allFieldNames = new Set<string>();
  for (const claims of claimsByType.values()) {
    for (const c of claims) allFieldNames.add(c.field);
  }
  for (const name of allFieldNames) {
    const gf = getGlobalField(db, name);
    if (gf) globalFields.set(name, gf);
  }

  return { claimsByType, globalFields };
}

/** Load the immutable schema inputs once for callers evaluating many nodes. */
export function loadAllSchemaContext(db: Database.Database): SchemaContext {
  const claimsByType = new Map<string, FieldClaim[]>();
  const rows = db.prepare(`
    SELECT *
    FROM schema_field_claims
    ORDER BY schema_name, sort_order, field
  `).all() as FieldClaimRow[];
  for (const row of rows) {
    const claims = claimsByType.get(row.schema_name) ?? [];
    claims.push(rowToFieldClaim(row));
    claimsByType.set(row.schema_name, claims);
  }

  const globalFields = new Map(
    listGlobalFields(db).map(field => [field.name, field]),
  );
  return { claimsByType, globalFields };
}

export function loadEffectiveFields(db: Database.Database, types: string[]): EffectiveFieldSet {
  const { claimsByType, globalFields } = loadSchemaContext(db, types);
  const merged = mergeFieldClaims(types, claimsByType, globalFields);
  if (!merged.ok) throw new Error('Unexpected effective field merge failure');
  return merged.effective_fields;
}
