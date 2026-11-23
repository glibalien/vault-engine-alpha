// src/undo/global-field-snapshot.ts
//
// Global-field undo snapshots. Captures the global_fields row plus dependent
// schema_field_claims and node_fields rows with explicit shared column lists.

import type Database from 'better-sqlite3';
import { deleteGlobalField } from '../global-fields/crud.js';
import { readFileOrNull } from '../pipeline/file-writer.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { refreshTypedReferences } from '../resolver/typed-refresh.js';
import { extractRawFieldTexts } from '../parser/raw-field-texts.js';

export const GLOBAL_FIELD_COLUMNS = [
  'name',
  'field_type',
  'enum_values',
  'enum_groups',
  'overrides_allowed_enum_groups',
  'reference_target',
  'description',
  'default_value',
  'required',
  'ai_guessable',
  'overrides_allowed_required',
  'overrides_allowed_default_value',
  'overrides_allowed_enum_values',
  'overrides_allowed_ai_guessable',
  'list_item_type',
  'ui_hints',
] as const;

export const SCHEMA_FIELD_CLAIM_COLUMNS = [
  'schema_name',
  'field',
  'label',
  'description',
  'sort_order',
  'required_override',
  'default_value_override',
  'default_value_overridden',
  'enum_values_override',
  'enum_groups_override',
  'ai_guessable_override',
] as const;

export const NODE_FIELD_COLUMNS = [
  'node_id',
  'field_name',
  'value_text',
  'value_number',
  'value_date',
  'value_json',
  'value_raw_text',
  'source',
] as const;

type GlobalFieldRow = Record<(typeof GLOBAL_FIELD_COLUMNS)[number], string | number | null>;
type SchemaFieldClaimRow = Record<(typeof SCHEMA_FIELD_CLAIM_COLUMNS)[number], string | number | null>;
type NodeFieldRow = Record<(typeof NODE_FIELD_COLUMNS)[number], string | number | null>;

interface SnapshotRow {
  operation_id: string;
  field_name: string;
  was_new: number;
  was_deleted: number;
  was_renamed_from: string | null;
  global_field: string | null;
  schema_claims: string;
  node_fields: string;
}

export interface CaptureGlobalFieldOptions {
  was_new?: boolean;
  was_deleted?: boolean;
  was_renamed_from?: string;
}

export interface GlobalFieldRestoreFileAction {
  renderFieldsCatalog: true;
  schemaNames: string[];
  nodeIds: string[];
  /** The fields whose values the restore put back on `nodeIds`: a render of those notes
   * writes them from the database, never as the file shows them (#501). */
  fieldNames?: string[];
}

/**
 * Capture pre-mutation state for one global-field operation.
 *
 * `fieldName` is the operation identity. For rename, pass the new name as
 * `fieldName` and the old name as `was_renamed_from`. A new field records no
 * definition or claims, but does record the values notes already hold under
 * its name (unmanaged fields), so its undo can keep them exactly as they were.
 */
export function captureGlobalFieldSnapshot(
  db: Database.Database,
  operation_id: string,
  fieldName: string,
  opts: CaptureGlobalFieldOptions = {},
): void {
  const wasNew = opts.was_new === true ? 1 : 0;
  const wasDeleted = opts.was_deleted === true ? 1 : 0;
  const sourceFieldName = opts.was_renamed_from ?? fieldName;

  let globalField: GlobalFieldRow | null = null;
  let schemaClaims: SchemaFieldClaimRow[] = [];

  if (wasNew !== 1) {
    globalField = (db.prepare(
      `SELECT ${GLOBAL_FIELD_COLUMNS.join(', ')} FROM global_fields WHERE name = ?`,
    ).get(sourceFieldName) as GlobalFieldRow | undefined) ?? null;
    if (!globalField) return;

    schemaClaims = db.prepare(
      `SELECT ${SCHEMA_FIELD_CLAIM_COLUMNS.join(', ')} FROM schema_field_claims WHERE field = ? ORDER BY schema_name`,
    ).all(sourceFieldName) as SchemaFieldClaimRow[];
  }
  const nodeFields = db.prepare(
    `SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE field_name = ? ORDER BY node_id`,
  ).all(sourceFieldName) as NodeFieldRow[];

  db.prepare(`
    INSERT OR IGNORE INTO undo_global_field_snapshots (
      operation_id, field_name, was_new, was_deleted, was_renamed_from,
      global_field, schema_claims, node_fields
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation_id,
    fieldName,
    wasNew,
    wasDeleted,
    opts.was_renamed_from ?? null,
    globalField ? JSON.stringify(globalField) : null,
    JSON.stringify(schemaClaims),
    JSON.stringify(nodeFields),
  );

  db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(operation_id);
}

/**
 * Restore one global-field snapshot. `vaultPath` lets undoing a creation read
 * a note's file where only the file shows whether a value is a link.
 */
export function restoreGlobalFieldSnapshot(
  db: Database.Database,
  operation_id: string,
  fieldName: string,
  vaultPath?: string,
): GlobalFieldRestoreFileAction | null {
  return db.transaction((): GlobalFieldRestoreFileAction | null => {
    const snap = db.prepare(`
      SELECT operation_id, field_name, was_new, was_deleted, was_renamed_from,
             global_field, schema_claims, node_fields
      FROM undo_global_field_snapshots
      WHERE operation_id = ? AND field_name = ?
    `).get(operation_id, fieldName) as SnapshotRow | undefined;
    if (!snap) return null;

    const schemaClaims = JSON.parse(snap.schema_claims) as SchemaFieldClaimRow[];
    const nodeFields = JSON.parse(snap.node_fields) as NodeFieldRow[];
    const currentSchemaNames = getSchemaNamesForField(db, snap.field_name);
    const schemaNames = unique([...schemaClaims.map(r => String(r.schema_name)), ...currentSchemaNames]);
    // The notes the snapshot recorded. Undo rewrites only these: any other note
    // keeps its value, so its file already holds it, even a value the restored
    // definition would not accept. A rewritten note keeps such values too (#499).
    const nodeIds = unique(nodeFields.map(r => String(r.node_id)));

    if (snap.was_new === 1) {
      // Creating a definition changes no note value, so its undo removes the
      // definition and its claims as delete-global-field does, and each note
      // keeps its value as an unmanaged field (#468). Deletion records link
      // brackets for a bare reference value; a value the note already had
      // before the definition, and still has, keeps its own raw text instead.
      const unchanged = nodeFields.filter(row => currentRowMatches(db, row));
      deleteGlobalField(db, snap.field_name);
      if (unchanged.length > 0) {
        const resetRaw = db.prepare('UPDATE node_fields SET value_raw_text = ? WHERE node_id = ? AND field_name = ?');
        for (const row of unchanged) resetRaw.run(keptRawText(db, row, vaultPath), row.node_id, row.field_name);
        // Re-derive the links from the raw text the notes have again.
        refreshTypedReferences(db, { kind: 'field', names: [snap.field_name] });
      }
      return { renderFieldsCatalog: true, schemaNames, nodeIds: [] };
    }

    // Only the notes the snapshot recorded go back to their recorded values;
    // a value another note gained after the operation stays (#468). Undoing a
    // rename removes the new name's definition, so a value left under it keeps
    // its link as on delete-global-field.
    const restoreName = snap.was_renamed_from ?? snap.field_name;
    if (restoreName !== snap.field_name) deleteGlobalField(db, snap.field_name);
    deleteDefinition(db, restoreName);
    deleteNodeValues(db, unique([snap.field_name, restoreName]), nodeIds);

    const globalField = snap.global_field ? JSON.parse(snap.global_field) as GlobalFieldRow : null;
    if (globalField) insertGlobalField(db, { ...globalField, name: restoreName });
    insertSchemaClaims(db, schemaClaims.map(row => ({ ...row, field: restoreName })));
    insertNodeFields(db, nodeFields.map(row => ({ ...row, field_name: restoreName })));
    refreshTypedReferences(db, { kind: 'field', names: [snap.field_name, restoreName] });

    return { renderFieldsCatalog: true, schemaNames, nodeIds, fieldNames: unique([snap.field_name, restoreName]) };
  })();
}

function deleteDefinition(db: Database.Database, fieldName: string): void {
  db.prepare('DELETE FROM schema_field_claims WHERE field = ?').run(fieldName);
  db.prepare('DELETE FROM global_fields WHERE name = ?').run(fieldName);
}

function deleteNodeValues(db: Database.Database, fieldNames: string[], nodeIds: string[]): void {
  const remove = db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?');
  for (const nodeId of nodeIds) {
    for (const fieldName of fieldNames) remove.run(nodeId, fieldName);
  }
}

/**
 * The raw text an unchanged value keeps once its definition is gone. A bare
 * value has none, but while its field was a reference under policy 2 a render
 * of the note wrote it as a link without recording that (deletion has just
 * recorded brackets for it). Only the note's file tells whether one did, so
 * the value takes the raw text the file shows, read as the watcher reads it
 * (duplicate keys tolerated).
 */
function keptRawText(db: Database.Database, row: NodeFieldRow, vaultPath: string | undefined): string | null {
  const recorded = row.value_raw_text === null ? null : String(row.value_raw_text);
  const current = db.prepare('SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?')
    .get(row.node_id, row.field_name) as { value_raw_text: string | null } | undefined;
  if (recorded !== null || current?.value_raw_text == null || vaultPath === undefined) return recorded;
  const node = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(row.node_id) as { file_path: string } | undefined;
  const content = node ? readFileOrNull(safeVaultPath(vaultPath, node.file_path)) : null;
  if (content === null) return recorded;
  return extractRawFieldTexts(content)[String(row.field_name)] ?? null;
}

/** Whether the note still holds exactly the recorded value for the field. */
function currentRowMatches(db: Database.Database, row: NodeFieldRow): boolean {
  const current = db.prepare(
    `SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE node_id = ? AND field_name = ?`,
  ).get(row.node_id, row.field_name) as NodeFieldRow | undefined;
  return current !== undefined && NODE_FIELD_COLUMNS.every(col => current[col] === row[col]);
}

function insertGlobalField(db: Database.Database, row: GlobalFieldRow): void {
  const placeholders = GLOBAL_FIELD_COLUMNS.map(() => '?').join(', ');
  db.prepare(`
    INSERT INTO global_fields (${GLOBAL_FIELD_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `).run(...GLOBAL_FIELD_COLUMNS.map(col =>
    (col === 'ai_guessable' || col === 'overrides_allowed_ai_guessable' || col === 'overrides_allowed_enum_groups')
      ? row[col] ?? 0
      : row[col] ?? null,
  ));
}

function insertSchemaClaims(db: Database.Database, rows: SchemaFieldClaimRow[]): void {
  const placeholders = SCHEMA_FIELD_CLAIM_COLUMNS.map(() => '?').join(', ');
  const insert = db.prepare(`
    INSERT INTO schema_field_claims (${SCHEMA_FIELD_CLAIM_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `);
  for (const row of rows) insert.run(...SCHEMA_FIELD_CLAIM_COLUMNS.map(col => row[col] ?? null));
}

function insertNodeFields(db: Database.Database, rows: NodeFieldRow[]): void {
  const placeholders = NODE_FIELD_COLUMNS.map(() => '?').join(', ');
  const insert = db.prepare(`
    INSERT INTO node_fields (${NODE_FIELD_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `);
  for (const row of rows) insert.run(...NODE_FIELD_COLUMNS.map(col => row[col]));
}

function getSchemaNamesForField(db: Database.Database, fieldName: string): string[] {
  return (db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ? ORDER BY schema_name')
    .all(fieldName) as Array<{ schema_name: string }>).map(r => r.schema_name);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
