// src/validation/validate.ts

import { createFieldMap } from '../fields/field-map.js';
import type {
  GlobalFieldDefinition,
  FieldClaim,
  CoercedValue,
  ValidationIssue,
  ValidationResult,
  ValidationIssueCode,
  RequiredMissingDetails,
  EffectiveField,
} from './types.js';
import { mergeFieldClaims } from './merge.js';
import { coerceValue, closestMatches } from './coerce.js';
import type { CoercionFailure } from './coerce.js';
import { resolveDefaultValue, type FileContext } from './resolve-default.js';
import { typeKeyFieldIssue } from './type-key-field.js';

function buildRequiredMissingDetails(gf: GlobalFieldDefinition): RequiredMissingDetails {
  const details: RequiredMissingDetails = { field_type: gf.field_type };
  if (gf.enum_values) details.allowed_values = gf.enum_values;
  if (gf.default_value !== null) details.default_value = gf.default_value;
  if (gf.reference_target) details.reference_target = gf.reference_target;
  return details;
}

export interface ValidateOptions {
  fileCtx?: FileContext | null;
  /** Skip default population for missing fields (normalizer path — defaults are creation-only). */
  skipDefaults?: boolean;
}

export type EffectiveFieldValueValidation =
  | { ok: true; coerced: CoercedValue }
  | { ok: false; issue: ValidationIssue };

/**
 * Validate one present value against an already-merged effective field.
 * Candidate discovery uses this same seam as full mutation validation so its
 * invalid reason cannot drift from the Engine's ordinary field issue.
 */
export function validateEffectiveFieldValue(
  fieldName: string,
  value: unknown,
  field: EffectiveField,
  fileCtx: FileContext | null = null,
): EffectiveFieldValueValidation {
  const resolvedValue = resolveDefaultValue(value, fileCtx);
  const tokenResolved = resolvedValue !== value;

  if (field.per_type_enum_values) {
    let lastFailure: CoercionFailure | null = null;

    for (const perType of field.per_type_enum_values) {
      const result = coerceValue(resolvedValue, field.global_field.field_type, {
        enum_values: perType.values ?? undefined,
        list_item_type: field.global_field.list_item_type ?? undefined,
      });
      if (result.ok) {
        const coerced: CoercedValue = {
          field: fieldName,
          value: result.value,
          source: 'provided',
          changed: result.changed || tokenResolved,
        };
        if (result.changed || tokenResolved) {
          coerced.original = value;
          const code = tokenResolved ? 'DATE_TOKEN_RESOLVED' : result.code;
          if (code) coerced.coercion_code = code;
        }
        return { ok: true, coerced };
      }
      lastFailure = result as CoercionFailure;
    }

    const allValues = new Set<string>();
    for (const perType of field.per_type_enum_values) {
      if (perType.values) perType.values.forEach(enumValue => allValues.add(enumValue));
    }
    const allowedValues = Array.from(allValues);
    const matches = closestMatches(String(value), allowedValues);
    return {
      ok: false,
      issue: {
        field: fieldName,
        severity: 'error',
        code: 'ENUM_MISMATCH',
        message: lastFailure?.reason ?? `"${String(value)}" is not a valid enum value`,
        details: {
          provided: value,
          allowed_values: allowedValues,
          closest_match: matches[0] ?? null,
        },
      },
    };
  }

  const result = coerceValue(resolvedValue, field.global_field.field_type, {
    enum_values: field.global_field.enum_values ?? undefined,
    list_item_type: field.global_field.list_item_type ?? undefined,
  });

  if (result.ok) {
    const coerced: CoercedValue = {
      field: fieldName,
      value: result.value,
      source: 'provided',
      changed: result.changed || tokenResolved,
    };
    if (result.changed || tokenResolved) {
      coerced.original = value;
      const code = tokenResolved ? 'DATE_TOKEN_RESOLVED' : result.code;
      if (code) coerced.coercion_code = code;
    }
    return { ok: true, coerced };
  }

  const failure = result as CoercionFailure;
  let code: ValidationIssueCode;
  if (failure.to_type === 'enum' || failure.closest_matches) {
    code = 'ENUM_MISMATCH';
  } else if (failure.element_errors) {
    code = 'LIST_ITEM_COERCION_FAILED';
  } else {
    code = 'TYPE_MISMATCH';
  }

  let details: unknown;
  if (code === 'ENUM_MISMATCH') {
    details = {
      provided: value,
      allowed_values: field.global_field.enum_values ?? [],
      closest_match: failure.closest_matches?.[0] ?? null,
    };
  } else if (code === 'TYPE_MISMATCH') {
    details = {
      expected_type: field.global_field.field_type,
      provided_type: failure.from_type,
      coercion_failed_reason: failure.reason,
    };
  } else if (failure.element_errors) {
    details = { element_errors: failure.element_errors };
  }

  return {
    ok: false,
    issue: {
      field: fieldName,
      severity: 'error',
      code,
      message: failure.reason,
      details,
    },
  };
}

export function validateProposedState(
  proposedFields: Record<string, unknown>,
  types: string[],
  claimsByType: Map<string, FieldClaim[]>,
  globalFields: Map<string, GlobalFieldDefinition>,
  fileCtxOrOpts?: FileContext | null | ValidateOptions,
): ValidationResult {
  const opts: ValidateOptions = fileCtxOrOpts !== null && fileCtxOrOpts !== undefined && 'skipDefaults' in fileCtxOrOpts
    ? fileCtxOrOpts as ValidateOptions
    : { fileCtx: fileCtxOrOpts as FileContext | null | undefined };
  const fileCtx = opts.fileCtx;
  const skipDefaults = opts.skipDefaults ?? false;
  const issues: ValidationIssue[] = [];
  const coerced_state = createFieldMap<CoercedValue>();
  const orphan_fields: string[] = [];

  // ── Step 1: Run the merge ──────────────────────────────────────────
  const mergeResult = mergeFieldClaims(types, claimsByType, globalFields);
  if (!mergeResult.ok) throw new Error('Unexpected merge failure');  // merge always returns ok: true
  const effectiveFields = mergeResult.effective_fields;

  // ── Step 2: Check required fields and defaults ─────────────────────
  for (const [fieldName, ef] of effectiveFields) {
    const provided = Object.hasOwn(proposedFields, fieldName);
    const value = provided ? proposedFields[fieldName] : undefined;

    if (provided && value === null) {
      // Null is deletion intent
      if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" cannot be null`,
          details: buildRequiredMissingDetails(ef.global_field),
        });
      }
      // Null excludes from coerced_state regardless
      continue;
    }

    if (!provided) {
      if (!skipDefaults && ef.resolved_required && ef.resolved_default_value !== null) {
        const resolved = resolveDefaultValue(ef.resolved_default_value, fileCtx ?? null);
        coerced_state[fieldName] = {
          field: fieldName,
          value: resolved,
          source: 'defaulted',
          changed: false,
        };
      } else if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" is missing`,
          details: buildRequiredMissingDetails(ef.global_field),
        });
      }
      // Non-required fields without a value: absent is fine, default is just metadata
      continue;
    }

    // ── Step 3: Validate and coerce provided fields ──────────────────
    const fieldValidation = validateEffectiveFieldValue(fieldName, value, ef, fileCtx ?? null);
    if (fieldValidation.ok) {
      coerced_state[fieldName] = fieldValidation.coerced;
    } else {
      issues.push(fieldValidation.issue);
    }
  }

  // ── Step 4: Handle orphan fields ───────────────────────────────────
  // The type key (`types` unless VAULT_TYPE_KEY names another) holds the note's types, and
  // the renderer writes them under it: a field of that name would be written over them, so
  // it is never a field (#445, #480). Tools refuse it first, naming their own parameters.
  const typeKeyIssue = typeKeyFieldIssue(proposedFields, 'any');
  if (typeKeyIssue !== null) issues.push(typeKeyIssue);
  for (const fieldName of Object.keys(proposedFields)) {
    if (effectiveFields.has(fieldName)) continue;
    if (typeKeyIssue !== null && fieldName === typeKeyIssue.field) continue;

    orphan_fields.push(fieldName);
    coerced_state[fieldName] = {
      field: fieldName,
      value: proposedFields[fieldName],
      source: 'orphan',
      changed: false,
    };
  }

  // ── Step 5: Return result ──────────────────────────────────────────
  const valid = issues.filter(i => i.severity === 'error').length === 0;

  return {
    valid,
    effective_fields: effectiveFields,
    coerced_state,
    issues,
    orphan_fields,
  };
}

/**
 * Fields whose value failed validation: an error names the field, the proposed
 * state holds a value for it, and no coerced value stands in for it. A field
 * named like the type key is not one: it is never a field.
 */
export function rejectedValueFields(
  result: ValidationResult,
  proposedFields: Record<string, unknown>,
): string[] {
  const fields = new Set<string>();
  for (const issue of result.issues) {
    if (issue.severity !== 'error' || issue.code === 'TYPE_KEY_FIELD') continue;
    if (Object.hasOwn(result.coerced_state, issue.field)) continue;
    const value = Object.hasOwn(proposedFields, issue.field) ? proposedFields[issue.field] : undefined;
    if (value !== null && value !== undefined) fields.add(issue.field);
  }
  return [...fields];
}

/**
 * Extract the list of fields that were populated with defaults during validation,
 * along with their resolved default_source ('global' or 'claim'). Pure function
 * over a ValidationResult — no DB access.
 */
export function defaultedFieldsFrom(result: ValidationResult): Array<{
  field: string;
  default_value: unknown;
  default_source: 'global' | 'claim';
}> {
  const out: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }> = [];
  for (const cv of Object.values(result.coerced_state)) {
    if (cv.source !== 'defaulted') continue;
    const ef = result.effective_fields.get(cv.field);
    out.push({
      field: cv.field,
      default_value: cv.value,
      default_source: ef?.default_source ?? 'global',
    });
  }
  return out;
}
