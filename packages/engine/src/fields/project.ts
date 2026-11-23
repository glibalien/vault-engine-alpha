import { createFieldMap } from './field-map.js';

export interface FieldRow {
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
  source: string;
}

export interface FieldDetail {
  value: unknown;
  type: string;
  source: string;
}

export function resolveFieldValue(row: FieldRow): unknown {
  if (row.value_json !== null) return JSON.parse(row.value_json);
  if (row.value_number !== null) return row.value_number;
  if (row.value_date !== null) return row.value_date;
  return row.value_text;
}

/** Project stored values for reads; null markers own their keys even in dual-row states. */
export function projectFieldValues(rows: FieldRow[], explicitNullFields: Iterable<string>): Record<string, unknown> {
  const markers = new Set(explicitNullFields);
  const fields = createFieldMap<unknown>();
  for (const row of rows) {
    if (!markers.has(row.field_name)) fields[row.field_name] = resolveFieldValue(row);
  }
  for (const field of markers) fields[field] = null;
  return fields;
}

/** The get-node wire format includes storage type and source alongside each value. */
export function projectFieldDetails(rows: FieldRow[], explicitNullFields: Iterable<string>): Record<string, FieldDetail> {
  const markers = new Set(explicitNullFields);
  const fields = createFieldMap<FieldDetail>();
  for (const row of rows) {
    if (markers.has(row.field_name)) continue;
    const type = row.value_json !== null ? 'json'
      : row.value_number !== null ? 'number'
      : row.value_date !== null ? 'date'
      : 'text';
    fields[row.field_name] = { value: resolveFieldValue(row), type, source: row.source };
  }
  for (const field of markers) fields[field] = { value: null, type: 'null', source: 'frontmatter' };
  return fields;
}
