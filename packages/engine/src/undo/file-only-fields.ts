// src/undo/file-only-fields.ts
//
// Field lines only a note's file holds, kept with an undo snapshot (#656).
//
// A value the watcher refuses for its field ("TBD" in a date field) is not stored; the file
// keeps the text (#501). Undo snapshots hold what the database holds, so undoing a write that
// replaced such text used to leave the field empty. The snapshot now also keeps the lines of
// every field the file shows other than as stored, and the restore writes them back where the
// restored state still does not hold them (`pipeline/kept-file-fields.ts` decides).

import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { cleanFieldValue } from '../parser/frontmatter.js';
import type { YamlValue } from '../parser/types.js';
import { typeKey } from '../parser/type-key.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { readFileOrNull } from '../pipeline/file-writer.js';
import { readFileFields, type FileField } from '../pipeline/kept-file-fields.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { settingsNoteDomain } from '../settings/hook.js';

/** One field as a snapshot keeps it: its own lines in the file when they stand alone, and its value as YAML read it. */
export interface FileOnlyFieldText {
  name: string;
  /** Null when the field's lines cannot be cut out (flow-style frontmatter, an indented key). */
  text: string | null;
  /** The value as YAML reads it, links and aliases resolved: what is written back when the lines cannot be. */
  raw: unknown;
}

interface StoredRow {
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

/**
 * The lines of each field a note's file shows other than as stored, as JSON for the snapshot,
 * or null when there are none. Read only while the file is the one the database last read or
 * wrote: an edit the watcher has not read yet is not the note's state. A settings note or an
 * Engine projection is rendered whole from the database and keeps nothing.
 */
export function captureFileOnlyFields(
  db: Database.Database,
  vaultPath: string,
  nodeId: string,
  filePath: string,
  storedRows: readonly StoredRow[],
): string | null {
  if (settingsNoteDomain(filePath) !== null) return null;
  const stored = new Map(storedRows.map(row => [row.field_name, reconstructValue(row)]));
  if (stored.has('vault_engine_projection')) return null;
  const content = readFileOrNull(safeVaultPath(vaultPath, filePath));
  if (content === null) return null;
  const indexed = db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(nodeId) as { content_hash: string | null } | undefined;
  if (indexed?.content_hash == null || indexed.content_hash !== sha256(content)) return null;

  const key = typeKey();
  const texts: FileOnlyFieldText[] = [];
  for (const field of readFileFields(content)) {
    if (field.name === key || field.value === null || field.value === undefined) continue;
    if (stored.has(field.name) && isDeepStrictEqual(stored.get(field.name), field.value)) continue;
    texts.push({ name: field.name, text: field.text, raw: field.raw });
  }
  return texts.length === 0 ? null : JSON.stringify(texts);
}

/** Save the captured lines on a snapshot row this call inserted. */
export function saveFileOnlyFields(db: Database.Database, operationId: string, nodeId: string, json: string | null): void {
  if (json === null) return;
  db.prepare('UPDATE undo_snapshots SET file_only_fields = ? WHERE operation_id = ? AND node_id = ?').run(json, operationId, nodeId);
}

/**
 * The fields a snapshot keeps, each read as the file would read it: from its own lines when
 * they read alone as the value they were taken with, else from the value (an alias whose
 * anchor is on another line, flow-style frontmatter), which the renderer writes out itself.
 */
export function snapshotFileOnlyFields(json: string | null | undefined): FileField[] {
  if (json === null || json === undefined) return [];
  let items: unknown;
  try {
    items = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const fields: FileField[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof (item as FileOnlyFieldText).name !== 'string') continue;
    const { name, text } = item as FileOnlyFieldText;
    // A snapshot from before the value was kept has lines only.
    const hasRaw = Object.prototype.hasOwnProperty.call(item, 'raw');
    const raw = (item as FileOnlyFieldText).raw;
    const fromText = typeof text === 'string'
      ? readFileFields(`---\n${text}\n---\n`).find(field => field.name === name && (!hasRaw || isDeepStrictEqual(field.raw, raw)))
      : undefined;
    if (fromText !== undefined) fields.push(fromText);
    else if (hasRaw && raw !== null && raw !== undefined) fields.push({ name, raw, value: cleanFieldValue(raw as YamlValue), text: null });
  }
  return fields;
}
