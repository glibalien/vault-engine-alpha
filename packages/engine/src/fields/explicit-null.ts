import { createFieldMap } from './field-map.js';
import type Database from 'better-sqlite3';

export interface ExplicitNullOverlay {
  fields: Record<string, unknown>;
  explicitNullFields: Set<string>;
}

/**
 * Apply persisted explicit-null state to an existing node before validation.
 *
 * Fields touched by this request clear their old marker, and fields it authors as
 * null gain one. Every resulting marker then overlays the value map as `null`,
 * including defensive dual-row states in which a value row and marker both exist. Keeping this policy in one pure seam
 * makes preview, validation, and commit agree about marker precedence.
 */
export function overlayExplicitNullFields(
  fields: Readonly<Record<string, unknown>>,
  persistedMarkers: Iterable<string>,
  touchedFields: Iterable<string> = [],
  authoredNullFields: Iterable<string> = [],
): ExplicitNullOverlay {
  const explicitNullFields = new Set(persistedMarkers);
  for (const field of touchedFields) explicitNullFields.delete(field);
  // A tool write may state a null itself (settings notes): it becomes a marker like
  // one parsed from a file.
  for (const field of authoredNullFields) explicitNullFields.add(field);

  const overlaidFields = createFieldMap(fields);
  for (const field of explicitNullFields) overlaidFields[field] = null;

  return { fields: overlaidFields, explicitNullFields };
}

export function explicitNullKeys(fields: ReadonlyMap<string, unknown>): string[] {
  return [...fields]
    .filter(([, value]) => value === null)
    .map(([field]) => field)
    .sort();
}

export function readExplicitNullFields(db: Database.Database, nodeId: string): Set<string> {
  const rows = db.prepare(
    'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
  ).all(nodeId) as Array<{ field_name: string }>;
  return new Set(rows.map(row => row.field_name));
}

export function replaceExplicitNullFields(
  db: Database.Database,
  nodeId: string,
  fields: Iterable<string>,
): void {
  db.prepare('DELETE FROM node_explicit_null_fields WHERE node_id = ?').run(nodeId);
  const insert = db.prepare(
    'INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)',
  );
  for (const field of [...new Set(fields)].sort()) {
    insert.run(nodeId, field);
  }
}

export function clearExplicitNullField(
  db: Database.Database,
  nodeId: string,
  field: string,
): void {
  db.prepare(
    'DELETE FROM node_explicit_null_fields WHERE node_id = ? AND field_name = ?',
  ).run(nodeId, field);
}

export function renameExplicitNullField(
  db: Database.Database,
  oldName: string,
  newName: string,
): number {
  return db.prepare(
    'UPDATE node_explicit_null_fields SET field_name = ? WHERE field_name = ?',
  ).run(newName, oldName).changes;
}

export function restoreExplicitNullFields(
  db: Database.Database,
  nodeId: string,
  fields: Iterable<string> | null,
): void {
  replaceExplicitNullFields(db, nodeId, fields ?? []);
}
