import type Database from 'better-sqlite3';
import { reconstructValue } from '../pipeline/classify-value.js';
import type { SchemaContext } from '../pipeline/schema-context.js';
import type { FieldGuessMutationGuard } from '../pipeline/types.js';
import { readExplicitNullFields } from '../fields/explicit-null.js';
import { fileHeldValues, isBlank } from './file-held.js';
import { mergeFieldClaims } from '../validation/merge.js';
import {
  ABSENT_FIELD_VALUE,
  EXPLICIT_NULL_FIELD_VALUE,
  buildFieldGuessFieldCandidate,
} from './candidates.js';

export class FieldGuessGuardStaleError extends Error {
  constructor() {
    super('Field guess precondition changed');
    this.name = 'FieldGuessGuardStaleError';
  }
}

export interface VerifiedFieldGuessState {
  currentFields: Record<string, unknown>;
  explicitNullFields: Set<string>;
}

function stale(): never {
  throw new FieldGuessGuardStaleError();
}

function sameReferenceValue(value: unknown, titles: readonly string[], list: boolean): boolean {
  if (list) {
    return Array.isArray(value)
      && value.length === titles.length
      && value.every((entry, index) => entry === titles[index]);
  }
  return titles.length === 1 && value === titles[0];
}

/**
 * For a requested guard, the typed text the note's file holds for the offered fields that the
 * database does not (`file-held.ts`). Empty for the nightly guard, which never offers a field
 * the owner did not mark, and so reads only the database, as before.
 */
export function requestedFileHeld(
  db: Database.Database,
  vaultPath: string,
  filePath: string,
  nodeId: string,
  guard: FieldGuessMutationGuard,
): Map<string, unknown> {
  if (guard.requested !== true) return new Map();
  const rows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null;
  }>;
  // A blank stored value (an empty list the watcher kept) does not rule out typed text in the file.
  const holding = new Set(rows.filter(row => !isBlank(reconstructValue(row))).map(row => row.field_name));
  return fileHeldValues(vaultPath, filePath, guard.offered_fields.map(field => field.field), field => holding.has(field));
}

/** Revalidate every model-offered definition and accepted reference identity.
 * Call only from the transaction that will perform the guarded write.
 * `fileHeld`: see `requestedFileHeld`; such text counts as the field's value. */
export function verifyFieldGuessMutationGuard(
  db: Database.Database,
  nodeId: string,
  types: readonly string[],
  proposedFields: Readonly<Record<string, unknown>>,
  touchedFields: readonly string[],
  guard: FieldGuessMutationGuard,
  schema: SchemaContext,
  fileHeld: ReadonlyMap<string, unknown> = new Map(),
): VerifiedFieldGuessState {
  const merged = mergeFieldClaims([...types], schema.claimsByType, schema.globalFields);
  if (!merged.ok) stale();

  const rows = db.prepare(`
    SELECT field_name, value_text, value_number, value_date, value_json
    FROM node_fields
    WHERE node_id = ?
  `).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
  }>;
  const currentFields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const row of rows) currentFields[row.field_name] = reconstructValue(row);
  const explicitNullFields = readExplicitNullFields(db, nodeId);

  const offered = new Map<string, (typeof guard.offered_fields)[number]>();
  for (const fieldGuard of guard.offered_fields) {
    if (offered.has(fieldGuard.field)) stale();
    offered.set(fieldGuard.field, fieldGuard);
  }
  if (offered.size === 0 || touchedFields.some(field => !offered.has(field))) stale();

  for (const [fieldName, fieldGuard] of offered) {
    const effective = merged.effective_fields.get(fieldName);
    if (effective === undefined) stale();
    // Typed text the file holds stands in place of the empty value, or none, the database has.
    const state = fileHeld.has(fieldName)
      ? fileHeld.get(fieldName)
      : explicitNullFields.has(fieldName)
        ? EXPLICIT_NULL_FIELD_VALUE
        : Object.prototype.hasOwnProperty.call(currentFields, fieldName)
          ? currentFields[fieldName]
          : ABSENT_FIELD_VALUE;
    const candidate = buildFieldGuessFieldCandidate(effective, state,
      guard.requested === true ? { replaceInvalid: guard.replace_invalid === true } : null);
    if (candidate === null || candidate.definition_hash !== fieldGuard.definition_hash) stale();

    const isScalarReference = effective.global_field.field_type === 'reference';
    const isListReference = effective.global_field.field_type === 'list'
      && effective.global_field.list_item_type === 'reference';
    const referenceTargets = fieldGuard.reference_targets ?? [];
    if (!touchedFields.includes(fieldName)) {
      if (referenceTargets.length !== 0) stale();
      continue;
    }
    if (!isScalarReference && !isListReference) {
      if (referenceTargets.length !== 0) stale();
      continue;
    }
    if (referenceTargets.length === 0) stale();
    const requiredType = effective.global_field.reference_target;
    const titles: string[] = [];
    for (const target of referenceTargets) {
      if (target.required_type !== requiredType) stale();
      const exact = db.prepare('SELECT id, title FROM nodes WHERE title = ? COLLATE NOCASE LIMIT 2')
        .all(target.title) as Array<{ id: string; title: string | null }>;
      if (exact.length !== 1 || exact[0]!.id !== target.node_id || exact[0]!.title !== target.title) stale();
      if (requiredType !== null) {
        const typed = db.prepare(
          'SELECT 1 FROM node_types WHERE node_id = ? AND schema_type = ?',
        ).get(target.node_id, requiredType);
        if (typed === undefined) stale();
      }
      titles.push(target.title);
    }
    if (!sameReferenceValue(proposedFields[fieldName], titles, isListReference)) stale();
  }

  return { currentFields, explicitNullFields };
}
