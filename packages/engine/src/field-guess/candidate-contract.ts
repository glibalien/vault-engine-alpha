import {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  fieldGuessCandidateIdentityProjectionChars,
  fieldGuessCandidateMandatoryProjectionChars,
  type FieldGuessCandidateIdentity,
  type FieldGuessCandidateMandatory,
} from '@vault/contract';
import type Database from 'better-sqlite3';
import type { FieldType } from '../validation/types.js';

interface CandidateIdentityRow {
  field: string;
  field_type: string;
  list_item_type: string | null;
}

interface CandidateMandatoryRow extends CandidateIdentityRow {
  enum_values: string | null;
  reference_target: string | null;
}

interface CandidateConstraintRow {
  field: string;
  schema_name: string;
  enum_values_override: string | null;
}

export class FieldGuessCandidateIdentityBudgetError extends Error {
  readonly actual_chars: number;
  readonly maximum_chars = FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS;

  constructor(actualChars: number) {
    super(
      `AI field-guess candidate identity projection is ${actualChars.toLocaleString('en-US')} UTF-16 characters `
      + `and exceeds the ${FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS.toLocaleString('en-US')}-character maximum. `
      + 'Disable AI guessing for one or more claimed fields, shorten field names, or remove schema claims.',
    );
    this.name = 'FieldGuessCandidateIdentityBudgetError';
    this.actual_chars = actualChars;
  }
}

export class FieldGuessCandidateMandatoryBudgetError
  extends FieldGuessCandidateIdentityBudgetError {
  constructor(actualChars: number) {
    super(actualChars);
    this.name = 'FieldGuessCandidateMandatoryBudgetError';
    this.message =
      `AI field-guess mandatory offered projection is ${actualChars.toLocaleString('en-US')} UTF-16 characters `
      + `and exceeds the ${FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS.toLocaleString('en-US')}-character maximum. `
      + 'Disable AI guessing for one or more claimed fields, or shorten enum values, reference targets, or schema claims.';
  }
}

function parseStoredStringArray(
  serialized: string | null,
  context: string,
): string[] | null {
  if (serialized === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`Invalid stored ${context}: expected a JSON string array`);
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Invalid stored ${context}: expected a JSON string array`);
  }
  return [...value];
}

/**
 * Return every distinct global field which could be effectively AI-guessable
 * for at least one schema claim. An explicit true override always includes the
 * field; inherit includes it only while the global definition is true.
 */
export function loadPotentialFieldGuessCandidateIdentities(
  db: Database.Database,
): FieldGuessCandidateIdentity[] {
  const rows = db.prepare(`
    SELECT DISTINCT
      gf.name AS field,
      gf.field_type,
      gf.list_item_type
    FROM global_fields AS gf
    INNER JOIN schema_field_claims AS sfc ON sfc.field = gf.name
    WHERE sfc.ai_guessable_override = 1
       OR (sfc.ai_guessable_override IS NULL AND gf.ai_guessable = 1)
    ORDER BY gf.name ASC
  `).all() as CandidateIdentityRow[];

  return rows.map(row => ({
    field: row.field,
    field_type: row.field_type as FieldType,
    list_item_type: row.list_item_type as FieldType | null,
  }));
}

/**
 * Return the complete mandatory projection which can be offered by any field
 * guess. Every potentially-effective field occurs once. Per-type constraints
 * include exactly the claims which can coexist in some resolved-AI-true type
 * combination, in deterministic schema order.
 */
export function loadPotentialFieldGuessCandidateMandatory(
  db: Database.Database,
): FieldGuessCandidateMandatory[] {
  const fields = db.prepare(`
    SELECT DISTINCT
      gf.name AS field,
      gf.field_type,
      gf.list_item_type,
      gf.enum_values,
      gf.reference_target
    FROM global_fields AS gf
    INNER JOIN schema_field_claims AS sfc ON sfc.field = gf.name
    WHERE sfc.ai_guessable_override = 1
       OR (sfc.ai_guessable_override IS NULL AND gf.ai_guessable = 1)
    ORDER BY gf.name ASC
  `).all() as CandidateMandatoryRow[];

  // For a potential field, true and inherited claims can participate. A false
  // claim participates only when true/false disagreement falls back to a true
  // global flag. Filter here so unreachable enum blobs are never materialized.
  const constraints = db.prepare(`
    WITH potential_fields AS (
      SELECT DISTINCT
        gf.name AS field,
        gf.ai_guessable
      FROM global_fields AS gf
      INNER JOIN schema_field_claims AS potential_claim ON potential_claim.field = gf.name
      WHERE potential_claim.ai_guessable_override = 1
         OR (potential_claim.ai_guessable_override IS NULL AND gf.ai_guessable = 1)
    )
    SELECT
      sfc.field,
      sfc.schema_name,
      sfc.enum_values_override
    FROM schema_field_claims AS sfc
    INNER JOIN potential_fields ON potential_fields.field = sfc.field
    WHERE sfc.ai_guessable_override = 1
       OR sfc.ai_guessable_override IS NULL
       OR (
         sfc.ai_guessable_override = 0
         AND potential_fields.ai_guessable = 1
         AND EXISTS (
           SELECT 1
           FROM schema_field_claims AS true_claim
           WHERE true_claim.field = sfc.field
             AND true_claim.ai_guessable_override = 1
         )
       )
    ORDER BY sfc.field ASC, sfc.schema_name ASC
  `).all() as CandidateConstraintRow[];

  const constraintsByField = new Map<string, CandidateConstraintRow[]>();
  for (const constraint of constraints) {
    const entries = constraintsByField.get(constraint.field) ?? [];
    entries.push(constraint);
    constraintsByField.set(constraint.field, entries);
  }

  return fields.map(row => {
    const enumValues = parseStoredStringArray(
      row.enum_values,
      `global enum values for field ${JSON.stringify(row.field)}`,
    );
    const claims = constraintsByField.get(row.field) ?? [];
    const hasAnyEnumOverride = claims.some(claim => claim.enum_values_override !== null);
    return {
      field: row.field,
      field_type: row.field_type as FieldType,
      list_item_type: row.list_item_type as FieldType | null,
      enum_values: enumValues,
      ...(hasAnyEnumOverride
        ? {
            per_type_enum_values: claims.map(claim => ({
              type: claim.schema_name,
              values: claim.enum_values_override === null
                ? enumValues === null ? null : [...enumValues]
                : parseStoredStringArray(
                    claim.enum_values_override,
                    `enum override for field ${JSON.stringify(row.field)} in schema ${JSON.stringify(claim.schema_name)}`,
                  ),
            })),
          }
        : {}),
      reference_target: row.reference_target,
    };
  });
}

export function fieldGuessCandidateIdentityProjectionCharsForDb(
  db: Database.Database,
): number {
  return fieldGuessCandidateIdentityProjectionChars(
    loadPotentialFieldGuessCandidateIdentities(db),
  );
}

export function fieldGuessCandidateMandatoryProjectionCharsForDb(
  db: Database.Database,
): number {
  return fieldGuessCandidateMandatoryProjectionChars(
    loadPotentialFieldGuessCandidateMandatory(db),
  );
}

export function assertFieldGuessCandidateIdentityBudget(
  db: Database.Database,
): void {
  const identityChars = fieldGuessCandidateIdentityProjectionCharsForDb(db);
  if (identityChars > FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS) {
    throw new FieldGuessCandidateIdentityBudgetError(identityChars);
  }

  const mandatoryChars = fieldGuessCandidateMandatoryProjectionCharsForDb(db);
  if (mandatoryChars > FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS) {
    throw new FieldGuessCandidateMandatoryBudgetError(mandatoryChars);
  }
}
