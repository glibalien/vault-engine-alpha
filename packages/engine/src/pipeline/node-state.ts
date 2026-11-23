// src/pipeline/node-state.ts
//
// A node's stored state, loaded for re-rendering through the write pipeline
// (schema propagation and link repair).

import type Database from 'better-sqlite3';
import { createFieldMap } from '../fields/field-map.js';
import { reconstructValue } from './classify-value.js';
import { rawTextFitsValue } from './carried-raw-text.js';
import { readExplicitNullFields } from '../fields/explicit-null.js';

export interface LoadedNodeState {
  file_path: string;
  title: string;
  body: string;
  types: string[];
  currentFields: Record<string, unknown>;
  explicitNullFields: Set<string>;
  rawFieldTexts: Record<string, string>;
}

/**
 * Load a node's mutable state from DB for re-rendering.
 * Returns null if the node no longer exists.
 */
export function loadNodeState(db: Database.Database, nodeId: string): LoadedNodeState | null {
  const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as
    | { file_path: string; title: string; body: string }
    | undefined;
  if (!nodeRow) return null;

  // Declared order: the first type routes directories and leads field order.
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type').all(nodeId) as Array<{ schema_type: string }>)
    .map(r => r.schema_type);

  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
    value_raw_text: string | null;
  }>;

  const currentFields = createFieldMap<unknown>();
  const rawFieldTexts = createFieldMap<string>();
  for (const row of fieldRows) {
    currentFields[row.field_name] = reconstructValue(row);
    // A raw text left from an earlier value would render that value again (#668).
    if (row.value_raw_text && rawTextFitsValue(currentFields[row.field_name], row.value_raw_text)) {
      rawFieldTexts[row.field_name] = row.value_raw_text;
    }
  }

  return {
    file_path: nodeRow.file_path,
    title: nodeRow.title,
    body: nodeRow.body,
    types,
    currentFields,
    explicitNullFields: readExplicitNullFields(db, nodeId),
    rawFieldTexts,
  };
}
