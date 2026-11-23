import { createHash } from 'node:crypto';
import { validateEffectiveFieldValue } from '../validation/validate.js';
import type {
  EffectiveField,
  FieldType,
  ValidationIssue,
} from '../validation/types.js';
import { supportsAiGuessing } from './field-name.js';

const ABSENT = Symbol('field-guess-absent');
const EXPLICIT_NULL = Symbol('field-guess-explicit-null');

export const ABSENT_FIELD_VALUE = ABSENT;
export const EXPLICIT_NULL_FIELD_VALUE = EXPLICIT_NULL;

export type FieldGuessValueState =
  | typeof ABSENT_FIELD_VALUE
  | typeof EXPLICIT_NULL_FIELD_VALUE
  | unknown;

export type FieldGuessEligibility = 'absent' | 'required_empty' | 'invalid';

export interface FieldGuessFieldCandidate {
  field: string;
  description: string | null;
  field_type: FieldType;
  list_item_type: FieldType | null;
  required: boolean;
  enum_values: string[] | null;
  per_type_enum_values?: Array<{ type: string; values: string[] | null }>;
  reference_target: string | null;
  claiming_types: string[];
  eligibility: FieldGuessEligibility;
  validation_issue?: ValidationIssue;
  definition_hash: string;
  /** On an on-demand run's listing, for a field offered as `invalid`: the value now there, as
   *  short text, so a preview can show what a replacement would replace (#644). */
  held_text?: string;
}

export interface FieldGuessNodeCandidate {
  node_id: string;
  title: string;
  file_path: string;
  types: string[];
  version: number;
  content_hash: string | null;
  file_mtime: number | null;
  fields: FieldGuessFieldCandidate[];
}

export interface FieldGuessCandidatePage {
  /** Present on an on-demand run's listing (#644); absent on the nightly one. */
  mode?: 'requested';
  candidates: FieldGuessNodeCandidate[];
  next_cursor: string | null;
}

export interface FieldGuessOrderTuple {
  priority: 1 | 2 | 3;
  file_mtime: number | null;
  node_id: string;
}

function isEmpty(value: unknown): boolean {
  return (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

function detailsRecord(details: unknown): Record<string, unknown> | null {
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? details as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...value]
    : null;
}

function redactedValidationMessage(issue: ValidationIssue): string {
  switch (issue.code) {
    case 'REQUIRED_MISSING':
      return `Required field "${issue.field}" is missing or empty`;
    case 'ENUM_MISMATCH':
      return `Field "${issue.field}" does not satisfy enum constraints`;
    case 'TYPE_MISMATCH':
      return `Field "${issue.field}" does not match its expected type`;
    case 'COERCION_FAILED':
      return `Field "${issue.field}" could not be coerced`;
    case 'LIST_ITEM_COERCION_FAILED':
      return `One or more items in field "${issue.field}" do not match the expected list item type`;
    case 'MERGE_CONFLICT':
      return `Field "${issue.field}" has conflicting effective constraints`;
    case 'INTERNAL_CONSISTENCY':
      return `Field "${issue.field}" could not be validated consistently`;
    case 'TYPE_KEY_FIELD':
      return `Field "${issue.field}" is the key that holds each note's types`;
  }
}

function redactedValidationDetails(issue: ValidationIssue): unknown {
  const details = detailsRecord(issue.details);
  if (details === null) return undefined;

  switch (issue.code) {
    case 'REQUIRED_MISSING': {
      const safe: Record<string, unknown> = {};
      if (typeof details.field_type === 'string') safe.field_type = details.field_type;
      const allowedValues = stringArray(details.allowed_values);
      if (allowedValues !== null) safe.allowed_values = allowedValues;
      if (typeof details.reference_target === 'string') safe.reference_target = details.reference_target;
      return Object.keys(safe).length === 0 ? undefined : safe;
    }
    case 'ENUM_MISMATCH': {
      const safe: Record<string, unknown> = {};
      const allowedValues = stringArray(details.allowed_values);
      if (allowedValues !== null) safe.allowed_values = allowedValues;
      if (typeof details.closest_match === 'string' || details.closest_match === null) {
        safe.closest_match = details.closest_match;
      }
      return Object.keys(safe).length === 0 ? undefined : safe;
    }
    case 'TYPE_MISMATCH': {
      const safe: Record<string, unknown> = {};
      if (typeof details.expected_type === 'string') safe.expected_type = details.expected_type;
      if (typeof details.provided_type === 'string') safe.provided_type = details.provided_type;
      return Object.keys(safe).length === 0 ? undefined : safe;
    }
    case 'LIST_ITEM_COERCION_FAILED': {
      if (!Array.isArray(details.element_errors)) return undefined;
      const elementErrors = details.element_errors.flatMap(error => {
        const entry = detailsRecord(error);
        return entry !== null && Number.isSafeInteger(entry.index)
          ? [{ index: entry.index }]
          : [];
      });
      return elementErrors.length === 0 ? undefined : { element_errors: elementErrors };
    }
    case 'COERCION_FAILED':
    case 'MERGE_CONFLICT':
    case 'INTERNAL_CONSISTENCY':
    case 'TYPE_KEY_FIELD':
      return undefined;
  }
}

function redactFieldGuessValidationIssue(issue: ValidationIssue): ValidationIssue {
  const redacted: ValidationIssue = {
    field: issue.field,
    severity: issue.severity,
    code: issue.code,
    message: redactedValidationMessage(issue),
  };
  const details = redactedValidationDetails(issue);
  if (details !== undefined) redacted.details = details;
  return redacted;
}

/**
 * How an on-demand run that names its fields is judged (#644). `replaceInvalid` also offers a
 * field whose stored value fails validation; without it such a value is left as it is.
 */
export interface RequestedFieldRule {
  replaceInvalid: boolean;
}

/**
 * Whether a model may be offered this field on a note, and why.
 *
 * The nightly sweep (`requested` null) offers only what the owner marked: a field that is
 * AI-guessable, and then only when it is required and missing or empty, or holds a value that
 * fails validation.
 *
 * A requested rule is an on-demand run that names the field. Naming it is the consent, for that
 * run: the field needs no AI-guessable mark and need not be required, so an optional field with
 * nothing in it is offered too (as `absent`). A value that is there but fails validation (a date
 * field holding "TBD") is someone's text: it is offered, to be replaced, only when the run asks
 * with `replaceInvalid`.
 *
 * A stored value that passes validation is never offered, under any rule.
 */
export function classifyFieldGuessEligibility(
  field: EffectiveField,
  state: FieldGuessValueState,
  requested: RequestedFieldRule | null = null,
): FieldGuessEligibility | null {
  if (!supportsAiGuessing(field.field)) return null;
  if (requested === null && !field.resolved_ai_guessable) return null;
  if (state === ABSENT) return field.resolved_required || requested !== null ? 'absent' : null;

  const value = state === EXPLICIT_NULL ? null : state;
  if (value === null || isEmpty(value)) {
    if (field.resolved_required) return 'required_empty';
    if (requested !== null) return 'absent';
  }

  if (validateEffectiveFieldValue(field.field, value, field).ok) return null;
  return requested === null || requested.replaceInvalid ? 'invalid' : null;
}

export function buildFieldGuessFieldCandidate(
  field: EffectiveField,
  state: FieldGuessValueState,
  requested: RequestedFieldRule | null = null,
): FieldGuessFieldCandidate | null {
  const eligibility = classifyFieldGuessEligibility(field, state, requested);
  if (eligibility === null) return null;

  const candidate: FieldGuessFieldCandidate = {
    field: field.field,
    description: field.resolved_description,
    field_type: field.global_field.field_type,
    list_item_type: field.global_field.list_item_type,
    required: field.resolved_required,
    enum_values: field.global_field.enum_values === null
      ? null
      : [...field.global_field.enum_values],
    reference_target: field.global_field.reference_target,
    claiming_types: [...field.claiming_types],
    eligibility,
    definition_hash: definitionHash(field),
  };
  if (field.per_type_enum_values !== undefined) {
    candidate.per_type_enum_values = field.per_type_enum_values.map(entry => ({
      type: entry.type,
      values: entry.values === null ? null : [...entry.values],
    }));
  }
  if (eligibility === 'invalid') {
    const value = state === EXPLICIT_NULL ? null : state;
    const validation = validateEffectiveFieldValue(field.field, value, field);
    if (!validation.ok) {
      candidate.validation_issue = redactFieldGuessValidationIssue(validation.issue);
    }
  }
  return candidate;
}

export function fieldGuessPriority(candidate: FieldGuessFieldCandidate): 1 | 2 | 3 {
  if (candidate.eligibility === 'invalid' || candidate.eligibility === 'required_empty') {
    return 1;
  }
  return candidate.required ? 2 : 3;
}

export function fieldGuessOrderTuple(candidate: FieldGuessNodeCandidate): FieldGuessOrderTuple {
  return {
    priority: Math.min(...candidate.fields.map(fieldGuessPriority)) as 1 | 2 | 3,
    file_mtime: candidate.file_mtime,
    node_id: candidate.node_id,
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareFieldGuessOrderTuples(
  left: FieldGuessOrderTuple,
  right: FieldGuessOrderTuple,
): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.file_mtime === null && right.file_mtime !== null) return 1;
  if (left.file_mtime !== null && right.file_mtime === null) return -1;
  if (left.file_mtime !== null && right.file_mtime !== null && left.file_mtime !== right.file_mtime) {
    return left.file_mtime > right.file_mtime ? -1 : 1;
  }
  return compareText(left.node_id, right.node_id);
}

export function encodeFieldGuessCursor(tuple: FieldGuessOrderTuple): string {
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

export function decodeFieldGuessCursor(cursor: string): FieldGuessOrderTuple {
  if (cursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('cursor must be non-empty base64url JSON');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('cursor must be valid base64url JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cursor tuple must be an object');
  }
  const tuple = parsed as Record<string, unknown>;
  if (tuple.priority !== 1 && tuple.priority !== 2 && tuple.priority !== 3) {
    throw new Error('cursor priority must be 1, 2, or 3');
  }
  if (tuple.file_mtime !== null && (
    typeof tuple.file_mtime !== 'number'
    || !Number.isSafeInteger(tuple.file_mtime)
  )) {
    throw new Error('cursor file_mtime must be a safe integer or null');
  }
  if (typeof tuple.node_id !== 'string' || tuple.node_id.length === 0) {
    throw new Error('cursor node_id must be a non-empty string');
  }
  return {
    priority: tuple.priority,
    file_mtime: tuple.file_mtime,
    node_id: tuple.node_id,
  };
}

export function definitionHash(field: EffectiveField): string {
  const canonical = {
    field: field.field,
    description: field.resolved_description,
    field_type: field.global_field.field_type,
    list_item_type: field.global_field.list_item_type,
    required: field.resolved_required,
    enum_values: field.global_field.enum_values === null
      ? null
      : [...field.global_field.enum_values].sort(),
    per_type_enum_values: field.per_type_enum_values === undefined
      ? null
      : field.per_type_enum_values
          .map(entry => ({
            type: entry.type,
            values: entry.values === null ? null : [...entry.values].sort(),
          }))
          .sort((a, b) => compareText(a.type, b.type)),
    reference_target: field.global_field.reference_target,
    claiming_types: [...field.claiming_types].sort(),
    ai_guessable: field.resolved_ai_guessable,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
