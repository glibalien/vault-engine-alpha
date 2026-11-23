// src/pipeline/rejected-values.ts
//
// What a reader of a note's file stores for its fields: each value as validation coerces
// it, a required field's default where the file has none, and for a field validation
// rejects (a value that fails, or a required field the file leaves out or empty) the value
// the database already held for it, or none. The watcher has always done this; the startup
// index does it too (#510, #515). Either logs `value-rejected` for a rejected field, and
// the file keeps what was typed (later Engine writes keep it as well, #501).

import type Database from 'better-sqlite3';
import { createFieldMap } from '../fields/field-map.js';
import type { ValidationResult } from '../validation/types.js';
import { reconstructValue, type FieldColumns } from './classify-value.js';
import { UNRENDERED_FIELDS } from '../fields/unrendered.js';

/** A node's stored row for one field. */
export interface StoredFieldRow extends FieldColumns {
  value_raw_text: string | null;
  source: string;
}

export interface RejectedValue {
  field: string;
  /** The value the file holds for the field. */
  rejected_value: unknown;
  /** The node's stored row for the field, which stays as it is; null when it had none. */
  stored: StoredFieldRow | null;
  /** The stored value, or null when the node had none. */
  retained_value: unknown;
}

/**
 * For each of `fields`, the value the node keeps in place of the value `proposed` gives it:
 * the one stored for the node (`nodeId`), or none for a new node or a field it held no
 * value for.
 */
export function retainStoredValues(
  db: Database.Database,
  nodeId: string | null,
  fields: Iterable<string>,
  proposed: Readonly<Record<string, unknown>>,
): RejectedValue[] {
  const select = nodeId === null ? null : db.prepare(
    'SELECT value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ? AND field_name = ?',
  );
  const values: RejectedValue[] = [];
  for (const field of fields) {
    const row = select?.get(nodeId, field) as StoredFieldRow | undefined;
    values.push({
      field,
      rejected_value: Object.hasOwn(proposed, field) ? proposed[field] : undefined,
      stored: row ?? null,
      retained_value: row === undefined ? null : reconstructValue(row),
    });
  }
  return values;
}

/** What a reader of a note's file stores for its fields. */
export interface FileFieldValues {
  /**
   * By field, the value stored: as validation coerced it (a required field's default
   * included), or the stored value kept in place of a rejected one. A rejected field the
   * node held no value for has none.
   */
  fields: Record<string, unknown>;
  /** The raw link text of each value: the file's for an accepted one, the stored row's for a kept one. */
  rawTexts: Record<string, string>;
  /** Each field validation rejects, with what the node keeps in its place. */
  rejected: RejectedValue[];
  /**
   * The node's stored unrendered fields (#547), kept whatever the file shows: the Engine
   * never writes them to the file, so their absence there is not a removal.
   */
  unrendered: RejectedValue[];
}

/**
 * The node's stored rows for the fields the Engine never writes to the file (#547), each
 * as the value a reader keeps for it. None for a new node.
 */
export function storedUnrenderedValues(db: Database.Database, nodeId: string | null): RejectedValue[] {
  if (nodeId === null) return [];
  const names = [...UNRENDERED_FIELDS];
  const rows = db.prepare(`
    SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source
    FROM node_fields WHERE node_id = ? AND field_name IN (${names.map(() => '?').join(',')})
    ORDER BY field_name
  `).all(nodeId, ...names) as Array<StoredFieldRow & { field_name: string }>;
  return rows.map(({ field_name, ...stored }) => ({
    field: field_name,
    rejected_value: undefined,
    stored,
    retained_value: reconstructValue(stored),
  }));
}

/**
 * The fields a reader stores from a file, given the validation of `proposed` (the file's
 * values) for the note's types. This is the watcher's rule (`executeMutation`, source
 * `watcher`), which the startup index applies too (#510, #515).
 */
export function fileFieldValues(
  db: Database.Database,
  nodeId: string | null,
  validation: ValidationResult,
  proposed: Readonly<Record<string, unknown>>,
  rawFieldTexts?: Readonly<Record<string, string>>,
): FileFieldValues {
  const fields = createFieldMap<unknown>();
  const rawTexts = createFieldMap<string>();
  for (const [fieldName, coerced] of Object.entries(validation.coerced_state)) {
    fields[fieldName] = coerced.value;
    if (rawFieldTexts && Object.hasOwn(rawFieldTexts, fieldName)) rawTexts[fieldName] = rawFieldTexts[fieldName];
  }
  // Every field an error names is rejected, except a merge conflict; a field already in
  // coerced_state (e.g. from conflict recovery) is not.
  const rejectedFields = new Set<string>();
  for (const issue of validation.issues) {
    if (issue.severity === 'error' && issue.code !== 'MERGE_CONFLICT' && issue.field
      && !Object.hasOwn(fields, issue.field)) {
      rejectedFields.add(issue.field);
    }
  }
  const rejected = retainStoredValues(db, nodeId, rejectedFields, proposed);
  for (const value of rejected) {
    if (value.stored === null) continue;
    fields[value.field] = value.retained_value;
    if (value.stored.value_raw_text) rawTexts[value.field] = value.stored.value_raw_text;
  }
  // A stored unrendered field stands whatever the file shows (#547). A file that still
  // carries one, from before the Engine stopped writing it, counts only where the node
  // has no stored value, as in a database rebuilt from the files.
  const unrendered = storedUnrenderedValues(db, nodeId);
  for (const value of unrendered) {
    fields[value.field] = value.retained_value;
    delete rawTexts[value.field];
    if (value.stored?.value_raw_text) rawTexts[value.field] = value.stored.value_raw_text;
  }
  return { fields, rawTexts, rejected, unrendered };
}
