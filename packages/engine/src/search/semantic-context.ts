import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { reconstructValue } from '../pipeline/classify-value.js';
import { allocateSemanticFieldNames, createSemanticFieldDictionary } from './semantic-context-fields.js';
import {
  boundDocumentContext,
  CONTEXT_LIMITS,
  renderSemanticContext,
  semanticPriorityFields,
  type EmbeddingDocumentContext,
} from './semantic-context-render.js';
import { getVaultSettings } from '../settings/vault.js';

export {
  boundDocumentContext,
  CONTEXT_LIMITS,
  renderContextLines,
  renderSemanticContext,
  semanticPriorityFields,
} from './semantic-context-render.js';
export type { ContextLines, EmbeddingDocumentContext } from './semantic-context-render.js';
export {
  capContextLines,
  CONTEXT_TOKEN_BUDGET,
  HEADING_TRAIL_TOKEN_BUDGET,
  truncateToTokens,
} from './semantic-context-token-cap.js';

export const SEMANTIC_CONTEXT_VERSION = 'semantic-context-v3';

type NodeIdentityRow = {
  readonly title: string | null;
  readonly file_path: string | null;
  readonly title_bytes: number | null;
  readonly file_path_bytes: number;
};

type TypeRow = {
  readonly schema_type: string | null;
  readonly schema_type_bytes: number;
};

type FieldRow = {
  readonly field_name: string | null;
  readonly field_name_bytes: number;
  readonly value_text: string | null;
  readonly value_number: number | null;
  readonly value_date: string | null;
  readonly value_date_bytes: number | null;
  readonly value_json: string | null;
  readonly value_text_bytes: number | null;
  readonly value_json_bytes: number | null;
};

type LinkRow = {
  readonly target: string | null;
  readonly target_bytes: number;
};

function omissionMarker(bytes: number): string {
  return `[value omitted: ${bytes} bytes]`;
}

function boundedDatabaseString(value: string | null, bytes: number | null): string {
  if (value !== null) return value;
  return bytes === null ? '' : omissionMarker(bytes);
}

function reconstructBoundedField(row: FieldRow): unknown {
  if (row.value_json_bytes !== null && row.value_json_bytes > CONTEXT_LIMITS.rawFieldBytes) {
    return omissionMarker(row.value_json_bytes);
  }
  if (row.value_text_bytes !== null && row.value_text_bytes > CONTEXT_LIMITS.rawFieldBytes) {
    return omissionMarker(row.value_text_bytes);
  }
  if (row.value_date_bytes !== null && row.value_date_bytes > CONTEXT_LIMITS.rawFieldBytes) {
    return omissionMarker(row.value_date_bytes);
  }
  return reconstructValue(row);
}

export function semanticSourceHash(context: EmbeddingDocumentContext, sourceText: string): string {
  return createHash('sha256')
    .update(`${SEMANTIC_CONTEXT_VERSION}\n`)
    .update(renderSemanticContext(boundDocumentContext(context)))
    .update('\n---\n')
    .update(sourceText)
    .digest('hex');
}

export function assembleDocumentContext(
  db: Database.Database,
  nodeId: string,
  extraction?: { readonly ref: string; readonly mediaType?: string },
): EmbeddingDocumentContext | null {
  const node = db.prepare(`
    SELECT CASE WHEN LENGTH(CAST(title AS BLOB)) <= ? THEN title END AS title,
           CASE WHEN LENGTH(CAST(file_path AS BLOB)) <= ? THEN file_path END AS file_path,
           LENGTH(CAST(title AS BLOB)) AS title_bytes,
           LENGTH(CAST(file_path AS BLOB)) AS file_path_bytes
    FROM nodes
    WHERE id = ?
  `).get(CONTEXT_LIMITS.scalarBytes, CONTEXT_LIMITS.scalarBytes, nodeId) as NodeIdentityRow | undefined;
  if (node === undefined) return null;

  const typeRows = db.prepare(`
    SELECT CASE WHEN LENGTH(CAST(schema_type AS BLOB)) <= ? THEN schema_type END AS schema_type,
           LENGTH(CAST(schema_type AS BLOB)) AS schema_type_bytes
    FROM node_types
    WHERE node_id = ?
    ORDER BY sort_order, schema_type
    LIMIT ?
  `).all(CONTEXT_LIMITS.scalarBytes, nodeId, CONTEXT_LIMITS.fields) as readonly TypeRow[];
  const types = typeRows.map(row => boundedDatabaseString(row.schema_type, row.schema_type_bytes));

  const fieldRows = db.prepare(`
    SELECT CASE WHEN LENGTH(CAST(field_name AS BLOB)) <= ? THEN field_name END AS field_name,
           LENGTH(CAST(field_name AS BLOB)) AS field_name_bytes,
           CASE WHEN LENGTH(CAST(value_text AS BLOB)) <= ? THEN value_text END AS value_text,
           value_number,
           CASE WHEN LENGTH(CAST(value_date AS BLOB)) <= ? THEN value_date END AS value_date,
           CASE WHEN LENGTH(CAST(value_json AS BLOB)) <= ? THEN value_json END AS value_json,
           LENGTH(CAST(value_text AS BLOB)) AS value_text_bytes,
           LENGTH(CAST(value_date AS BLOB)) AS value_date_bytes,
           LENGTH(CAST(value_json AS BLOB)) AS value_json_bytes
    FROM node_fields
    WHERE node_id = ?
    ORDER BY field_name
    LIMIT ?
  `).all(
    CONTEXT_LIMITS.scalarBytes,
    CONTEXT_LIMITS.rawFieldBytes,
    CONTEXT_LIMITS.rawFieldBytes,
    CONTEXT_LIMITS.rawFieldBytes,
    nodeId,
    CONTEXT_LIMITS.fields,
  ) as readonly FieldRow[];
  const fields = createSemanticFieldDictionary();
  const fieldEntries = allocateSemanticFieldNames(fieldRows.map(row => ({
    name: row.field_name,
    nameBytes: row.field_name_bytes,
    value: reconstructBoundedField(row),
  })), CONTEXT_LIMITS.scalarBytes);
  for (const entry of fieldEntries) {
    fields[entry.name] = entry.value;
  }

  const linkRows = db.prepare(`
    SELECT CASE WHEN target_bytes <= ? THEN target END AS target, target_bytes
    FROM (
      SELECT DISTINCT target, LENGTH(CAST(target AS BLOB)) AS target_bytes
      FROM relationships
      WHERE source_id = ?
      ORDER BY target
      LIMIT ?
    )
  `).all(CONTEXT_LIMITS.scalarBytes, nodeId, CONTEXT_LIMITS.links) as readonly LinkRow[];
  const links = linkRows.map(row => boundedDatabaseString(row.target, row.target_bytes));
  // The people field the vault map names renders early; the default map adds nothing here.
  const priorityFields = semanticPriorityFields(getVaultSettings(db).peopleField);

  const context: EmbeddingDocumentContext = {
    source: extraction === undefined
      ? { kind: 'node' }
      : {
          kind: 'extraction',
          ref: extraction.ref,
          ...(extraction.mediaType === undefined ? {} : { media_type: extraction.mediaType }),
        },
    title: boundedDatabaseString(node.title, node.title_bytes),
    path: boundedDatabaseString(node.file_path, node.file_path_bytes),
    types,
    fields,
    links,
    ...(priorityFields === undefined ? {} : { priorityFields }),
  };
  const boundedIdentity = boundDocumentContext({ ...context, fields: {} });
  return { ...boundedIdentity, types, fields, links };
}
