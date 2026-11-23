import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ABSENT_FIELD_VALUE,
  EXPLICIT_NULL_FIELD_VALUE,
  buildFieldGuessFieldCandidate,
  decodeFieldGuessCursor,
  encodeFieldGuessCursor,
  fieldGuessOrderTuple,
  fieldGuessPriority,
  type FieldGuessCandidatePage,
  type FieldGuessFieldCandidate,
  type FieldGuessNodeCandidate,
  type FieldGuessOrderTuple,
  type FieldGuessValueState,
  type RequestedFieldRule,
} from '../../field-guess/candidates.js';
import { fileHeldValues, heldValueText, isBlank } from '../../field-guess/file-held.js';
import { getMeta } from '../../db/meta.js';
import { notSuiteNoteSql } from '../../notes/suite-notes.js';
import { getVaultSettings } from '../../settings/vault.js';
import { resolveFieldValue, type FieldRow } from '../field-value.js';
import {
  loadAllSchemaContext,
  type SchemaContext,
} from '../../pipeline/schema-context.js';
import { EXPLICIT_NULL_BACKFILL_META_KEY } from '../../sync/explicit-null-backfill.js';
import { mergeFieldClaims } from '../../validation/merge.js';
import type { EffectiveFieldSet } from '../../validation/types.js';
import { assertFieldGuessCandidateIdentityBudget } from '../../field-guess/candidate-contract.js';
import { fail, ok, type Issue } from './errors.js';
import { buildNodeQuery, type NodeQueryFilter } from '../query-builder.js';
import { queryLeafFilterSchema } from '../query-filter-input.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** Most fields one on-demand run may name. */
export const MAX_REQUESTED_FIELDS = 20;

/**
 * The notes an on-demand run covers: query-nodes' flat filters, validated by its own schema, so
 * a malformed predicate is refused here as it is there. (`exists: "false"`, a string, would
 * otherwise select the notes that have the field: the opposite scope, for a paid run that writes.)
 * No joins and no `where`. Group predicates are refused: they need the read tools' classification
 * context, which a write's scope does not have.
 */
const GROUP_PREDICATES = ['in_group', 'is_unclassified'];
const requestedQuerySchema = queryLeafFilterSchema.refine(
  query => Object.values(query.fields ?? {}).every(predicate =>
    predicate === null || typeof predicate !== 'object' || !GROUP_PREDICATES.some(name => name in predicate)),
  'Group predicates (in_group, is_unclassified) are not taken in a run\'s scope',
);

const paramsShape = {
  limit: z.number().optional().describe('Maximum nodes to return; defaults to 100 and may not exceed 200'),
  cursor: z.string().optional().describe('Opaque keyset cursor from a previous page'),
  requested: z.strictObject({
    fields: z.array(z.string().min(1)).min(1).max(MAX_REQUESTED_FIELDS)
      .describe('The fields to fill. Each must be claimed by some type.'),
    query: requestedQuerySchema.optional()
      .describe('Which notes: query-nodes filters (types means the note has all of them). Omit for every note.'),
    replace_invalid: z.boolean().optional()
      .describe('Also offer a named field whose stored value fails validation, to be replaced. Off by default: such a value is left as it is.'),
  }).optional().describe('An on-demand run that names its fields (#644). Notes are offered those fields where they hold no value, whether or not the field is required or marked AI-guessable. Without it, the nightly rule applies.'),
};

/** What an on-demand run asks for. */
export interface RequestedFieldGuess {
  fields: readonly string[];
  query?: NodeQueryFilter;
  /** Also offer a named field whose stored value fails validation. */
  replaceInvalid?: boolean;
}

/** A scope the query builder refuses. */
export class RequestedQueryError extends Error {
  constructor(message: string) {
    super(`query: ${message}`);
    this.name = 'RequestedQueryError';
  }
}

/** A named field no type claims, so no note could ever be offered it. */
export class RequestedFieldsError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`No type claims ${fields.map(field => `"${field}"`).join(', ')}. Name fields a schema claims (describe-schema lists them).`);
    this.name = 'RequestedFieldsError';
  }
}

interface NodeRow {
  id: string;
  title: string | null;
  file_path: string;
  version: number;
  content_hash: string | null;
  file_mtime: number | null;
}

interface NodeBatchEntry {
  row: NodeRow;
  types: string[];
  values: Map<string, unknown>;
  explicitNulls: Set<string>;
}

interface NodeOrderPosition {
  file_mtime: number | null;
  node_id: string;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function fieldState(
  values: ReadonlyMap<string, unknown>,
  explicitNulls: ReadonlySet<string>,
  field: string,
  /** Typed text the note's file holds that the database does not; a requested run reads it as the value. */
  fileHeld?: ReadonlyMap<string, unknown>,
): FieldGuessValueState {
  // Read only for a field the database holds nothing, or an empty value, for: it stands in its place.
  if (fileHeld?.has(field)) return fileHeld.get(field);
  if (explicitNulls.has(field)) return EXPLICIT_NULL_FIELD_VALUE;
  if (values.has(field)) return values.get(field);
  return ABSENT_FIELD_VALUE;
}

function candidateFields(
  schemaContext: SchemaContext,
  effectiveFieldCache: Map<string, EffectiveFieldSet>,
  types: string[],
  values: ReadonlyMap<string, unknown>,
  explicitNulls: ReadonlySet<string>,
  /** An on-demand run's named fields: only these are offered, by its rule. */
  requested?: { fields: ReadonlySet<string>; rule: RequestedFieldRule },
  fileHeld?: ReadonlyMap<string, unknown>,
): FieldGuessFieldCandidate[] {
  const cacheKey = JSON.stringify(types);
  let effectiveFields = effectiveFieldCache.get(cacheKey);
  if (effectiveFields === undefined) {
    const merged = mergeFieldClaims(
      types,
      schemaContext.claimsByType,
      schemaContext.globalFields,
    );
    if (!merged.ok) throw new Error('Unexpected effective field merge failure');
    effectiveFields = merged.effective_fields;
    effectiveFieldCache.set(cacheKey, effectiveFields);
  }
  if (effectiveFields.size === 0) return [];

  return [...effectiveFields.values()]
    .filter(field => requested === undefined || requested.fields.has(field.field))
    .map(field => {
      const state = fieldState(values, explicitNulls, field.field, fileHeld);
      const candidate = buildFieldGuessFieldCandidate(field, state, requested?.rule ?? null);
      // What a replacement would replace, for the run's preview. The nightly listing stays value-free.
      if (candidate !== null && requested !== undefined && candidate.eligibility === 'invalid'
        && state !== ABSENT_FIELD_VALUE && state !== EXPLICIT_NULL_FIELD_VALUE) {
        candidate.held_text = heldValueText(state);
      }
      return { field, candidate };
    })
    .filter((entry): entry is typeof entry & { candidate: FieldGuessFieldCandidate } => entry.candidate !== null)
    .sort((left, right) =>
      fieldGuessPriority(left.candidate) - fieldGuessPriority(right.candidate)
      || left.field.resolved_order - right.field.resolved_order
      || compareText(left.field.field, right.field.field))
    .map(entry => entry.candidate);
}

function loadNodeBatch(
  db: Database.Database,
  wikiType: string | null,
  after: NodeOrderPosition | null,
  limit: number,
  /** Only notes this query selects (an on-demand run's scope). */
  scope?: { idSql: string; params: readonly unknown[] },
): NodeBatchEntry[] {
  const params: unknown[] = [];
  // The suite's own notes (the Curator Journal, the memory note) and wiki pages are never
  // candidates: their fields are the suite's to write, not a model's to guess (#600).
  const conditions = [notSuiteNoteSql('nodes')];
  if (wikiType !== null) {
    conditions.push('NOT EXISTS (SELECT 1 FROM node_types wt WHERE wt.node_id = nodes.id AND wt.schema_type = ?)');
    params.push(wikiType);
  }
  if (scope !== undefined) {
    conditions.push(`nodes.id IN (${scope.idSql})`);
    params.push(...scope.params);
  }
  if (after !== null) {
    if (after.file_mtime === null) {
      conditions.push('(file_mtime IS NULL AND id > ?)');
      params.push(after.node_id);
    } else {
      conditions.push(`(
        file_mtime IS NULL
        OR file_mtime < ?
        OR (file_mtime = ? AND id > ?)
      )`);
      params.push(after.file_mtime, after.file_mtime, after.node_id);
    }
  }
  params.push(limit);
  const rows = db.prepare(`
    SELECT id, title, file_path, version, content_hash, file_mtime
    FROM nodes
    WHERE ${conditions.join(' AND ')}
    ORDER BY file_mtime IS NULL, file_mtime DESC, id ASC
    LIMIT ?
  `).all(...params) as NodeRow[];
  if (rows.length === 0) return [];

  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const typesByNode = new Map(ids.map(id => [id, [] as string[]]));
  const typeRows = db.prepare(`
    SELECT node_id, schema_type
    FROM node_types
    WHERE node_id IN (${placeholders})
    ORDER BY node_id, sort_order, schema_type
  `).all(...ids) as Array<{ node_id: string; schema_type: string }>;
  for (const typeRow of typeRows) typesByNode.get(typeRow.node_id)?.push(typeRow.schema_type);

  const valuesByNode = new Map(ids.map(id => [id, new Map<string, unknown>()]));
  const fieldRows = db.prepare(`
    SELECT node_id, field_name, value_text, value_number, value_date, value_json, source
    FROM node_fields
    WHERE node_id IN (${placeholders})
    ORDER BY node_id, field_name
  `).all(...ids) as Array<FieldRow & { node_id: string }>;
  for (const fieldRow of fieldRows) {
    valuesByNode.get(fieldRow.node_id)?.set(fieldRow.field_name, resolveFieldValue(fieldRow));
  }

  const explicitNullsByNode = new Map(ids.map(id => [id, new Set<string>()]));
  const explicitNullRows = db.prepare(`
    SELECT node_id, field_name
    FROM node_explicit_null_fields
    WHERE node_id IN (${placeholders})
    ORDER BY node_id, field_name
  `).all(...ids) as Array<{ node_id: string; field_name: string }>;
  for (const explicitNullRow of explicitNullRows) {
    explicitNullsByNode.get(explicitNullRow.node_id)?.add(explicitNullRow.field_name);
  }

  return rows.map(row => ({
    row,
    types: typesByNode.get(row.id) ?? [],
    values: valuesByNode.get(row.id) ?? new Map(),
    explicitNulls: explicitNullsByNode.get(row.id) ?? new Set(),
  }));
}

function buildNodeCandidate(
  entry: NodeBatchEntry,
  schemaContext: SchemaContext,
  effectiveFieldCache: Map<string, EffectiveFieldSet>,
  requested?: { fields: ReadonlySet<string>; rule: RequestedFieldRule },
  vaultPath?: string,
): FieldGuessNodeCandidate | null {
  // A requested run reads the file too: typed text the database refused is not an empty field.
  const fileHeld = requested !== undefined && vaultPath !== undefined
    ? fileHeldValues(vaultPath, entry.row.file_path, requested.fields, field => !isBlank(entry.values.get(field)))
    : undefined;
  const fields = candidateFields(
    schemaContext,
    effectiveFieldCache,
    entry.types,
    entry.values,
    entry.explicitNulls,
    requested,
    fileHeld,
  );
  if (fields.length === 0) return null;
  return {
    node_id: entry.row.id,
    title: entry.row.title ?? '',
    file_path: entry.row.file_path,
    types: entry.types,
    version: entry.row.version,
    content_hash: entry.row.content_hash,
    file_mtime: entry.row.file_mtime,
    fields,
  };
}

function scanPriorityLane(
  db: Database.Database,
  schemaContext: SchemaContext,
  wikiType: string | null,
  effectiveFieldCache: Map<string, EffectiveFieldSet>,
  priority: 1 | 2,
  after: NodeOrderPosition | null,
  count: number,
): { candidates: FieldGuessNodeCandidate[]; exhausted: boolean } {
  const candidates: FieldGuessNodeCandidate[] = [];
  const batchSize = Math.min(200, Math.max(32, count * 4));
  let position = after;

  while (candidates.length < count) {
    const batch = loadNodeBatch(db, wikiType, position, batchSize);
    if (batch.length === 0) return { candidates, exhausted: true };
    for (const entry of batch) {
      // A node with no stored values or explicit-null markers can only produce
      // absent candidates, so the urgent lane need not merge/hash its schema.
      if (priority === 1 && entry.values.size === 0 && entry.explicitNulls.size === 0) {
        continue;
      }
      const candidate = buildNodeCandidate(entry, schemaContext, effectiveFieldCache);
      if (candidate !== null && fieldGuessOrderTuple(candidate).priority === priority) {
        candidates.push(candidate);
        if (candidates.length === count) return { candidates, exhausted: false };
      }
    }
    const last = batch[batch.length - 1].row;
    position = { file_mtime: last.file_mtime, node_id: last.id };
    if (batch.length < batchSize) return { candidates, exhausted: true };
  }
  return { candidates, exhausted: false };
}

export function discoverFieldGuessCandidatePage(
  db: Database.Database,
  limit: number,
  cursor: FieldGuessOrderTuple | null,
): FieldGuessCandidatePage {
  assertFieldGuessCandidateIdentityBudget(db);
  if (cursor?.priority === 3) return { candidates: [], next_cursor: null };

  const schemaContext = loadAllSchemaContext(db);
  // Read once per call: wiki pages are never candidates (#600).
  const wikiType = getVaultSettings(db).wikiType;
  const effectiveFieldCache = new Map<string, EffectiveFieldSet>();
  const wanted = limit + 1;
  const candidates: FieldGuessNodeCandidate[] = [];

  if (cursor === null || cursor.priority === 1) {
    const urgent = scanPriorityLane(
      db,
      schemaContext,
      wikiType,
      effectiveFieldCache,
      1,
      cursor === null ? null : cursor,
      wanted,
    );
    candidates.push(...urgent.candidates);
    if (candidates.length < wanted && urgent.exhausted) {
      const requiredAbsent = scanPriorityLane(
        db,
        schemaContext,
        wikiType,
        effectiveFieldCache,
        2,
        null,
        wanted - candidates.length,
      );
      candidates.push(...requiredAbsent.candidates);
    }
  } else {
    const requiredAbsent = scanPriorityLane(
      db,
      schemaContext,
      wikiType,
      effectiveFieldCache,
      2,
      cursor,
      wanted,
    );
    candidates.push(...requiredAbsent.candidates);
  }

  const page = candidates.slice(0, limit);
  return {
    candidates: page,
    next_cursor: candidates.length > limit && page.length > 0
      ? encodeFieldGuessCursor(fieldGuessOrderTuple(page[page.length - 1]))
      : null,
  };
}

/**
 * One page of an on-demand run's candidates (#644): the notes its query selects that hold no
 * value in at least one named field, or with `replaceInvalid` a value that fails validation.
 * Text typed into a note's file that the database refused for its type (`file-held.ts`) is
 * such a value, not an empty field.
 * Each offered field says which (`absent` or `invalid`). Newest first, as the nightly listing
 * orders a lane, with the same cursor. The suite's own notes and wiki pages are never offered.
 */
export function discoverRequestedFieldGuessPage(
  db: Database.Database,
  limit: number,
  cursor: FieldGuessOrderTuple | null,
  request: RequestedFieldGuess,
  /** The vault's folder, to read what each note's file holds; without it only the database is read. */
  vaultPath?: string,
): FieldGuessCandidatePage {
  const schemaContext = loadAllSchemaContext(db);
  const claimed = new Set<string>();
  for (const claims of schemaContext.claimsByType.values()) for (const claim of claims) claimed.add(claim.field);
  const unclaimed = request.fields.filter(field => !claimed.has(field) || !schemaContext.globalFields.has(field));
  if (unclaimed.length > 0) throw new RequestedFieldsError(unclaimed);

  const requested = { fields: new Set(request.fields), rule: { replaceInvalid: request.replaceInvalid === true } };
  const wikiType = getVaultSettings(db).wikiType;
  let scope: ReturnType<typeof buildNodeQuery>;
  try {
    scope = buildNodeQuery(request.query ?? {}, db);
  } catch (error) {
    throw new RequestedQueryError(error instanceof Error ? error.message : String(error));
  }
  const effectiveFieldCache = new Map<string, EffectiveFieldSet>();
  const wanted = limit + 1;
  const batchSize = Math.min(200, Math.max(32, wanted * 2));
  const candidates: FieldGuessNodeCandidate[] = [];
  let position: NodeOrderPosition | null = cursor === null ? null : { file_mtime: cursor.file_mtime, node_id: cursor.node_id };

  scan: for (;;) {
    const batch = loadNodeBatch(db, wikiType, position, batchSize, scope);
    for (const entry of batch) {
      const candidate = buildNodeCandidate(entry, schemaContext, effectiveFieldCache, requested, vaultPath);
      if (candidate === null) continue;
      candidates.push(candidate);
      if (candidates.length === wanted) break scan;
    }
    if (batch.length < batchSize) break;
    const last = batch[batch.length - 1]!.row;
    position = { file_mtime: last.file_mtime, node_id: last.id };
  }

  const page = candidates.slice(0, limit);
  const lastOnPage = page[page.length - 1];
  return {
    // The caller checks this mark: an Engine from before #644 ignores `requested` and answers
    // with the nightly listing, which a run must never mistake for its own scope.
    mode: 'requested',
    candidates: page,
    next_cursor: candidates.length > limit && lastOnPage !== undefined
      // The priority is unused here: a requested listing is one lane.
      ? encodeFieldGuessCursor({ priority: 1, file_mtime: lastOnPage.file_mtime, node_id: lastOnPage.node_id })
      : null,
  };
}

export function registerListFieldGuessCandidates(
  server: McpServer,
  db: Database.Database,
  vaultPath?: string,
): void {
  server.tool(
    'list-field-guess-candidates',
    'Lists body-free nodes and effective schema fields eligible for AI field inference. This tool is read-only; use the returned cursor for keyset pagination. With requested, it lists the notes of an on-demand run instead: those a query selects that lack a value in the named fields.',
    paramsShape,
    async (params) => {
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return fail('INVALID_PARAMS', `limit must be an integer from 1 through ${MAX_LIMIT}`);
      }

      let cursor: FieldGuessOrderTuple | null = null;
      if (params.cursor !== undefined) {
        try {
          cursor = decodeFieldGuessCursor(params.cursor);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return fail('INVALID_PARAMS', `Invalid cursor: ${message}`);
        }
      }

      if (getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY) !== 'complete') {
        const warnings: Issue[] = [{
          code: 'FIELD_PRESENCE_BACKFILL_PENDING',
          severity: 'warning',
          message: 'Explicit-null field presence backfill is not complete; candidate discovery is temporarily unavailable.',
        }];
        return ok({ candidates: [], next_cursor: null }, warnings);
      }

      try {
        if (params.requested !== undefined) {
          return ok(discoverRequestedFieldGuessPage(db, limit, cursor, {
            fields: params.requested.fields,
            ...(params.requested.query === undefined ? {} : { query: params.requested.query as NodeQueryFilter }),
            ...(params.requested.replace_invalid === true ? { replaceInvalid: true } : {}),
          }, vaultPath));
        }
        return ok(discoverFieldGuessCandidatePage(db, limit, cursor));
      } catch (error) {
        if (error instanceof RequestedFieldsError) {
          return fail('INVALID_PARAMS', error.message, { details: { fields: [...error.fields] } });
        }
        if (error instanceof RequestedQueryError) return fail('INVALID_PARAMS', error.message);
        return fail(
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : 'Field-guess candidate discovery failed',
        );
      }
    },
  );
}
