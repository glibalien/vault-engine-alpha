import {
  FIELD_GUESS_REASON_MAX_CHARS,
  type FieldGuessFieldCandidate,
  type FieldGuessFieldType,
  type SanitizedFieldGuessDecision,
  type SanitizedFieldGuessOutput,
} from './types.js';

const DECISION_KEYS = new Set(['field', 'action', 'value', 'reason']);
const REQUIRED_DECISION_KEYS = ['field', 'action', 'reason'] as const;
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const MALFORMED_ROOT_ERROR = 'Malformed field guess output envelope.';
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function rootDecisionArray(raw: unknown): unknown[] {
  let decisions: unknown;
  try {
    if (isPlainRecord(raw)) {
      const rootKeys = Reflect.ownKeys(raw);
      if (rootKeys.length === 1 && rootKeys[0] === 'decisions') {
        decisions = ownDataValue(raw, 'decisions');
      }
    }
  } catch {
    // Reflection on a hostile object is still a malformed, redacted envelope.
  }
  if (!Array.isArray(decisions)) throw new Error(MALFORMED_ROOT_ERROR);
  return decisions;
}

function boundedReason(value: string): string {
  return Array.from(value.trim()).slice(0, FIELD_GUESS_REASON_MAX_CHARS).join('');
}

export function parseGuessValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function emptyReplacement(value: unknown): boolean {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

function canonicalEnum(value: unknown, allowed: readonly string[]): string | null {
  if (value === null || typeof value === 'object') return null;
  const text = String(value).trim();
  for (const allowedValue of allowed) {
    if (allowedValue === text || allowedValue.toLowerCase() === text.toLowerCase()) return allowedValue;
  }
  return null;
}

function enumSets(field: FieldGuessFieldCandidate): readonly (readonly string[])[] {
  if (field.per_type_enum_values !== undefined) {
    return field.per_type_enum_values.flatMap(entry => entry.values === null ? [] : [entry.values]);
  }
  return field.enum_values === null ? [] : [field.enum_values];
}

function canonicalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = DATE_ONLY_RE.exec(text) ?? DATE_TIME_RE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) return null;

  if (match.length > 4) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
    const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
    if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  }
  return text;
}

function canonicalReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (!text.startsWith('[[') || !text.endsWith(']]')) return text;
  const inner = text.slice(2, -2);
  const target = (inner.includes('|') ? inner.split('|')[0] : inner)?.trim() ?? '';
  return target === '' ? null : target;
}

function canonicalScalar(
  value: unknown,
  type: Exclude<FieldGuessFieldType, 'list'>,
  field: FieldGuessFieldCandidate,
  enumValues?: readonly string[],
): unknown | typeof INVALID {
  if (Array.isArray(value) || value === null || value === undefined) return INVALID;
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return String(value);
      return INVALID;
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
      if (typeof value !== 'string' || value.trim() === '') return INVALID;
      const number = Number(value.trim());
      return Number.isFinite(number) ? number : INVALID;
    }
    case 'date': {
      const date = canonicalDate(value);
      return date === null ? INVALID : date;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value !== 'string') return INVALID;
      if (['true', 'yes'].includes(value.trim().toLowerCase())) return true;
      if (['false', 'no'].includes(value.trim().toLowerCase())) return false;
      return INVALID;
    case 'reference': {
      const reference = canonicalReference(value);
      return reference === null ? INVALID : reference;
    }
    case 'enum': {
      const allowed = enumValues ?? field.enum_values ?? [];
      const canonical = canonicalEnum(value, allowed);
      return canonical === null ? INVALID : canonical;
    }
  }
}

const INVALID = Symbol('invalid-field-guess-value');

function canonicalValue(value: unknown, field: FieldGuessFieldCandidate): unknown | typeof INVALID {
  if (emptyReplacement(value)) return INVALID;
  if (field.field_type !== 'list') {
    if (field.field_type === 'enum' && field.per_type_enum_values !== undefined) {
      for (const allowed of enumSets(field)) {
        const canonical = canonicalScalar(value, 'enum', field, allowed);
        if (canonical !== INVALID) return canonical;
      }
      return INVALID;
    }
    return canonicalScalar(value, field.field_type, field);
  }

  if (!Array.isArray(value) || value.length === 0 || field.list_item_type === null || field.list_item_type === 'list') {
    return INVALID;
  }
  if (field.list_item_type === 'enum' && field.per_type_enum_values !== undefined) {
    for (const allowed of enumSets(field)) {
      const canonical = value.map(item => canonicalScalar(item, 'enum', field, allowed));
      if (canonical.every(item => item !== INVALID)) return canonical;
    }
    return INVALID;
  }
  const canonical = value.map(item => canonicalScalar(
    item,
    field.list_item_type as Exclude<FieldGuessFieldType, 'list'>,
    field,
  ));
  return canonical.every(item => item !== INVALID) ? canonical : INVALID;
}

function rejected(field: string, reason: string, error: string): SanitizedFieldGuessDecision {
  return { field, kind: 'rejected_value', reason: boundedReason(reason), error };
}

function omission(field: string): SanitizedFieldGuessDecision {
  return { field, kind: 'abstained', reason: 'Model omitted this offered field.' };
}

export function sanitizeFieldGuessOutput(
  raw: unknown,
  offered: readonly FieldGuessFieldCandidate[],
): SanitizedFieldGuessOutput {
  const decisions = rootDecisionArray(raw);
  const offeredNames = new Set(offered.map(field => field.field));
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const decision of decisions) {
    if (!isObjectRecord(decision)) continue;
    const fieldName = ownDataValue(decision, 'field');
    if (typeof fieldName !== 'string' || !offeredNames.has(fieldName)) continue;
    const entries = grouped.get(fieldName) ?? [];
    entries.push(decision);
    grouped.set(fieldName, entries);
  }

  const byField = new Map<string, SanitizedFieldGuessDecision>();
  const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of offered) {
    if (RESERVED_FIELD_NAMES.has(field.field)) {
      byField.set(field.field, rejected(
        field.field,
        'Reserved field name cannot be mutated.',
        'reserved field name',
      ));
      continue;
    }
    const matches = grouped.get(field.field) ?? [];
    if (matches.length === 0) {
      byField.set(field.field, omission(field.field));
      continue;
    }
    if (matches.length > 1) {
      byField.set(field.field, rejected(
        field.field,
        'Duplicate model decisions were rejected.',
        'duplicate decision',
      ));
      continue;
    }

    const decision = matches[0];
    if (decision === undefined) {
      byField.set(field.field, omission(field.field));
      continue;
    }
    const decisionKeys = Reflect.ownKeys(decision);
    const action = ownDataValue(decision, 'action');
    const reasonValue = ownDataValue(decision, 'reason');
    if (!isPlainRecord(decision)
      || REQUIRED_DECISION_KEYS.some(key => !Object.hasOwn(decision, key))
      || decisionKeys.some(key => typeof key !== 'string' || !DECISION_KEYS.has(key))
      || (action !== 'set' && action !== 'abstain')
      || typeof reasonValue !== 'string'
      || boundedReason(reasonValue) === '') {
      byField.set(field.field, rejected(
        field.field,
        typeof reasonValue === 'string' ? reasonValue : 'Malformed model decision.',
        'malformed decision',
      ));
      continue;
    }

    const reason = boundedReason(reasonValue);
    if (action === 'abstain') {
      byField.set(field.field, { field: field.field, kind: 'abstained', reason });
      continue;
    }
    const decisionValue = ownDataValue(decision, 'value');
    if (!Object.hasOwn(decision, 'value') || typeof decisionValue !== 'string') {
      byField.set(field.field, rejected(field.field, reason, 'set decision value must be a string'));
      continue;
    }

    // Prefer a legal scalar enum's raw text before JSON coercion. Enum values
    // are strings and may themselves look like any JSON value (including null,
    // an object, or an array). If the raw text is not legal, retain the normal
    // parsed path so JSON-quoted enum strings continue to work.
    const rawEnumValue = field.field_type === 'enum'
      ? canonicalValue(decisionValue, field)
      : INVALID;

    // Unrestricted scalar strings are already in their final wire shape, so
    // preserve their text verbatim even when it resembles JSON. Scalar
    // references are exact node titles, so JSON primitives such as "2026",
    // "true", or "null" must also remain text. Structured reference JSON
    // remains invalid; lists and non-string scalars retain JSON coercion.
    const parsedDecisionValue = field.field_type === 'string'
      ? decisionValue
      : parseGuessValue(decisionValue);
    const parsedValue = field.field_type === 'reference'
      && (parsedDecisionValue === null || typeof parsedDecisionValue !== 'object')
      ? decisionValue
      : parsedDecisionValue;
    const value = rawEnumValue === INVALID
      ? canonicalValue(parsedValue, field)
      : rawEnumValue;
    if (value === INVALID || emptyReplacement(value)) {
      byField.set(field.field, rejected(field.field, reason, 'value does not satisfy offered field constraints'));
      continue;
    }
    const accepted: SanitizedFieldGuessDecision = {
      field: field.field,
      kind: 'accepted',
      value,
      reason,
    };
    byField.set(field.field, accepted);
    patch[field.field] = value;
  }

  return { byField, patch };
}
