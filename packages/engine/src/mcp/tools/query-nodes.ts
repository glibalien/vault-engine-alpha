import { createClassificationReadContext } from '../../classification/read.js';
import { ClassificationError } from '../../classification/types.js';
import { assertExpressionBudget, FilterExpressionError, filterLeaves } from '../../filters/expression.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { queryFilterShape, pickQueryFilter } from '../query-filter-input.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { ok, fail, type Issue } from './errors.js';
import { buildNodeQuery } from '../query-builder.js';
import type { FieldFilter, NodeQueryFilter } from '../query-builder.js';
import { projectFieldValues, type FieldRow } from '../../fields/project.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { Embedder } from '../../search/embedder.js';
import { hybridSearchPrepared } from '../../search/search.js';
import { computeJoinWarning } from '../join-warning.js';
import { QUERY_NODES_UI_RESOURCE_URI } from '../ui/query-nodes/register.js';
import { exampleNamesFor, type ExampleNames } from '../example-names.js';
import { LINK_COUNT_COLUMNS, LINK_COUNT_COLUMN_NAMES, ensureLinkCountFunctions, linkCountSql, readLinkCounts, type LinkCountColumn } from '../link-counts.js';

const paramsShape = {
  ...queryFilterShape,
  query: z.string().optional(),
  search_mode: z.enum(['fts', 'semantic', 'hybrid']).default('hybrid'),
  sort_by: z.enum(['title', 'file_mtime', 'indexed_at', 'created_at', ...LINK_COUNT_COLUMN_NAMES]).default('title'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  include_fields: z.array(z.string()).optional(),
  select: z.array(z.string()).optional(),
};

const queryParamsSchema = z.object(paramsShape);
const { $schema: _dialect, ...advertisedQuery } = z.toJSONSchema(queryParamsSchema, {
  io: 'input', target: 'draft-7', reused: 'ref',
});
// Retain legacy field-schema introspection while factoring repeated expression schemas.
const flatFieldAdvertisement = z.toJSONSchema(z.object({ fields: queryFilterShape.fields }), {
  io: 'input', target: 'draft-7',
});
if (advertisedQuery.properties && flatFieldAdvertisement.properties) {
  advertisedQuery.properties.fields = flatFieldAdvertisement.properties.fields;
}
// Keep an object schema for SDK advertisement, but bound raw trees before parsing them.
const queryInputSchema = z.object({}).catchall(z.unknown()).superRefine((raw, ctx) => {
  try {
    assertExpressionBudget([{ filter: pickQueryFilter(raw), profile: 'query', path: 'query' }]);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid expression.' });
    return;
  }
  const parsed = queryParamsSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
  }
}).meta(advertisedQuery);

const SELECTABLE = ['id', 'file_path', 'title', 'version', 'file_mtime', 'indexed_at', 'created_at', 'content_hash', 'types', 'field_count', ...LINK_COUNT_COLUMN_NAMES] as const;

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  version: number;
  file_mtime?: number;
  indexed_at?: number;
  created_at?: number | null;
}

function enrichRows(
  db: Database.Database,
  rows: NodeRow[],
  includeFields: string[] | undefined,
  select: ReadonlySet<string> | null,
): Array<Record<string, unknown>> {
  const want = (col: string) => select === null || select.has(col);
  // Link counts are opt-in: the default row shape (select omitted) leaves them out.
  const countColumns = select === null ? [] : LINK_COUNT_COLUMN_NAMES.filter(col => select.has(col));
  const linkCounts = countColumns.length ? readLinkCounts(db, rows.map(row => row.id)) : undefined;

  // Only prepare the per-row enrichment statements (the N+1) when their columns
  // are actually requested. When select narrows to e.g. ['file_path','title'],
  // these are skipped entirely — no type/field-count queries fire per row.
  const getTypes = want('types')
    ? db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    : undefined;
  const getFieldCount = want('field_count')
    ? db.prepare('SELECT COUNT(*) as count FROM node_fields WHERE node_id = ?')
    : undefined;
  // Opt-in like the link counts: the default row shape leaves it out. The Curator's memory
  // extraction runs (#659) read it to leave out notes the memory sweep has read at this hash.
  const getContentHash = select !== null && select.has('content_hash')
    ? db.prepare('SELECT content_hash FROM nodes WHERE id = ?')
    : undefined;

  // include_fields is INDEPENDENT of select — its behavior is unchanged.
  const wantFields = includeFields && includeFields.length > 0;
  const isWildcard = includeFields?.length === 1 && includeFields[0] === '*';

  const fieldPredicate = wantFields && !isWildcard
    ? ` AND field_name IN (${includeFields!.map(() => '?').join(', ')})` : '';
  const getFields = wantFields
    ? db.prepare(`SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?${fieldPredicate}`)
    : undefined;
  const getNullFields = wantFields
    ? db.prepare(`SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?${fieldPredicate}`)
    : undefined;

  return rows.map(row => {
    const node: Record<string, unknown> = {};
    if (want('id')) node.id = row.id;
    if (want('file_path')) node.file_path = row.file_path;
    if (want('title')) node.title = row.title;
    if (want('version')) node.version = row.version;
    if (want('file_mtime')) node.file_mtime = row.file_mtime;
    if (want('indexed_at')) node.indexed_at = row.indexed_at;
    if (want('created_at')) node.created_at = row.created_at ?? null;
    if (getContentHash) node.content_hash = (getContentHash.get(row.id) as { content_hash: string | null } | undefined)?.content_hash ?? null;
    if (getTypes) node.types = (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    if (getFieldCount) node.field_count = (getFieldCount.get(row.id) as { count: number }).count;
    if (linkCounts) {
      const counts = linkCounts.get(row.id);
      for (const col of countColumns) node[col] = counts?.[LINK_COUNT_COLUMNS[col]] ?? 0;
    }

    if (getFields && getNullFields) {
      const fieldParams = isWildcard ? [row.id] : [row.id, ...includeFields!];
      const fieldRows = getFields.all(...fieldParams) as FieldRow[];
      const markers = getNullFields.all(...fieldParams) as Array<{ field_name: string }>;
      node.fields = projectFieldValues(fieldRows, markers.map(marker => marker.field_name));
    }

    return node;
  });
}



/**
 * Validates that each field filter uses operators compatible with the field's
 * declared global type. Emits non-fatal warnings for common silent-mismatch
 * traps (e.g. `includes` on a scalar, `eq` on a list). Unknown fields are
 * skipped silently — they may be newly added ones not yet in global_fields.
 */
export function checkFieldOperators(
  db: Database.Database,
  fields: Record<string, FieldFilter> | undefined,
): Issue[] {
  if (!fields) return [];
  const names = Object.keys(fields);
  if (names.length === 0) return [];

  const placeholders = names.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT name, field_type FROM global_fields WHERE name IN (${placeholders})`)
    .all(...names) as Array<{ name: string; field_type: string }>;
  const typeMap = new Map(rows.map(r => [r.name, r.field_type]));

  const warnings: Issue[] = [];
  for (const [fieldName, ops] of Object.entries(fields)) {
    const fieldType = typeMap.get(fieldName);
    if (!fieldType) continue;
    for (const op of Object.keys(ops)) {
      const advice = opIncompatibility(op, fieldType);
      if (!advice) continue;
      warnings.push({
        code: 'FIELD_OPERATOR_MISMATCH',
        severity: 'warning',
        message: `Field '${fieldName}' has type '${fieldType}'. ${advice}`,
        field: fieldName,
        details: { field: fieldName, field_type: fieldType, operator: op },
      });
    }
  }
  return warnings;
}

function opIncompatibility(op: string, fieldType: string): string | undefined {
  const isList = fieldType === 'list';
  const isNumericOrDate = fieldType === 'number' || fieldType === 'date';
  if (op === 'includes' && !isList) {
    return `'includes' matches list elements; use 'eq' or 'one_of' on scalar fields.`;
  }
  if ((op === 'eq' || op === 'ne' || op === 'one_of') && isList) {
    return `'${op}' compares scalar values; use 'includes' to match list elements.`;
  }
  if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && !isNumericOrDate) {
    return `Comparison operators ('gt', 'gte', 'lt', 'lte') apply to number/date fields only.`;
  }
  return undefined;
}

/**
 * The query-nodes description. Its examples name the vault's own kinds, fields and statuses
 * from the vault map (placeholders where the map says none). With the default map it reads as
 * it did before the map, except the examples no longer name a `project` link field or a
 * `pending` status, which the map does not designate: a project's tasks are its linked ones.
 */
function queryNodesDescription(n: ExampleNames): string {
  const q = (value: unknown): string => JSON.stringify(value);
  const types = (type: string) => ({ types: [type] });
  const openTasks = { ...types(n.task), fields: { [n.taskStatus]: { eq: n.open } } };
  return 'Search and query nodes across the vault: semantic (vector) search, full-text search, and structured filters on identity, type, fields, references, path, date, and cross-node joins. Use the query param for hybrid ranked results combining FTS and semantic retrieval. Scores use Reciprocal Rank Fusion (RRF) — absolute values are not meaningful, only relative ordering matters. match_sources indicates retrieval method: "fts" (full-text match), "semantic" (vector/embedding match), or both. Returns paginated results. '
    + `Use include_fields to return field values inline (e.g. ${q([n.taskStatus, n.due])} or ["*"] for all). `
    + 'Use select to project only the columns you need — e.g. ["file_path","title"] for a cheap file tree; omitting it returns the full row shape (id, file_path, title, version, types, field_count). Selectable columns: id, file_path, title, version, file_mtime, indexed_at, created_at (when the Engine first indexed the note; also a sort_by), content_hash (only when selected), types, field_count, inlink_count, outlink_count, unresolved_link_count. Link counts (#611) are exact and come only when selected: inlink_count is how many distinct notes link to the node, outlink_count how many distinct notes it links to, unresolved_link_count how many notes it links to that do not exist (attachments and same-note heading links excluded). Each counts body links and reference-field links together, never counts the node itself, and counts a note once however many times it is linked. sort_by takes the same three names; link_counts filters on them ({incoming|outgoing|unresolved: {eq|ne|gt|gte|lt|lte: n}}, optional rel_type to count only some link fields), alone or inside where. When you know the exact title, prefer get-node with title param. For partial title matching, use title_contains; without_title_contains excludes titles containing a text (or any of a list). Both match literally, case-insensitive. For exact title filtering combined with other constraints, use title_eq. Use without_node_ids or without_titles to exclude known keepers from broader filters. Cross-node filtering: join_filters narrows results to nodes linked to a target matching a nested filter; without_joins excludes them. Each filter has optional direction ("outgoing" default, or "incoming"), optional rel_type (string or array for OR), and optional target (nested NodeQueryFilter without its own join_filters). '
    + `Example — open tasks whose linked project is done: ${q({ ...openTasks, join_filters: [{ target: { ...types(n.project), fields: { [n.projectStatus]: { eq: n.projectDone } } } }] })}. `
    + 'Differs from references: references matches by identity (a specific target), join_filters matches by pattern (any node matching the target filter). When a join filter has a target, unresolved edges are invisible to it; a CROSS_NODE_FILTER_UNRESOLVED warning surfaces in the envelope warnings array if such edges existed and could have affected the answer. Use full_text for a literal case-insensitive substring match across title + body (exact phrase, no tokenization or stopword removal) — distinct from the ranked query param; combine the two to literal-filter then rank. full_text_words matches whole words instead: its words in order, in any case, so "Ark" finds "Ark" and "Ark\'s" but not "market".\n\nField operator cheatsheet (use describe-global-field if unsure of a field type):\n- scalar string / enum: eq, ne, one_of, exists\n- number / date: eq, ne, gt, gte, lt, lte, exists (dates are ISO 8601 strings)\n- list of strings / list of refs: includes (element match), exists\n- any field: contains (substring, searches both text and JSON values)\nNote: includes is for list fields only; on scalars it silently returns no rows. eq/ne on list fields likewise won\'t match. For reference fields, prefer the top-level `references:{target,rel_type}` filter over `includes` — it resolves title/path/id variants correctly.\n\nCommon query recipes:'
    + `\n- Open tasks: ${q(openTasks)}`
    + `\n- Tasks with multiple statuses: ${q({ ...types(n.task), fields: { [n.taskStatus]: { one_of: n.statusPair } } })}`
    + `\n- Tasks in project X: ${q({ ...types(n.task), references: { target: 'X' } })}`
    + `\n- Overdue tasks: ${q({ ...types(n.task), fields: { [n.due]: { lt: '2026-04-20' }, [n.taskStatus]: { ne: n.done } } })}`
    + `\n- Tasks with no project: ${q({ ...types(n.task), without_joins: [{ target: types(n.project) }] })}`
    + `\n- Recently modified notes: ${q({ ...types(n.note), modified_since: '2026-04-13' })}`
    + `\n- Notes created since a date (first indexed then): ${q({ created_since: '2026-04-13' })}`
    + `\n- Notes with one or fewer links in and one or fewer out, with their counts: ${q({ link_counts: { incoming: { lte: 1 }, outgoing: { lte: 1 } }, select: ['id', 'title', 'inlink_count', 'outlink_count', 'unresolved_link_count'], sort_by: 'inlink_count' })}`
    + `\n- Notes with one or fewer links in OR out: ${q({ where: { any: [{ link_counts: { incoming: { lte: 1 } } }, { link_counts: { outgoing: { lte: 1 } } }] } })}`;
}

export function registerQueryNodes(
  server: McpServer,
  db: Database.Database,
  _embeddingIndexer?: EmbeddingIndexer,
  embedder?: Embedder,
): void {
  registerAppTool(
    server,
    'query-nodes',
    {
      description: queryNodesDescription(exampleNamesFor(db)),
      inputSchema: queryInputSchema,
      _meta: { ui: { resourceUri: QUERY_NODES_UI_RESOURCE_URI } },
    },
    async (raw) => {
      let params:z.infer<typeof queryParamsSchema>;
      try {
        assertExpressionBudget([{filter:pickQueryFilter(raw),profile:'query',path:'query'}]);
        params=queryParamsSchema.parse(raw);
      } catch(error) {
        if(error instanceof FilterExpressionError) return fail('INVALID_PARAMS',error.message,{details:error.details});
        return fail('INVALID_PARAMS','Invalid query filter shape or operand.');
      }
      const sortBy = params.sort_by ?? 'title';
      const sortOrder = params.sort_order ?? 'asc';
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const query = params.query;
      const searchMode = params.search_mode ?? 'hybrid';
      const includeFields = params.include_fields;

      // Column projection: when select is provided, build an allowlisted set of
      // requested columns; null means "emit the full default row shape".
      // Unknown columns are silently dropped via the allowlist filter.
      const selectSet = params.select && params.select.length
        ? new Set(params.select.filter((c) => (SELECTABLE as readonly string[]).includes(c)))
        : null;

      const hasStructuredFilters = Boolean(
        params.where ||
        params.types?.length ||
        params.node_ids?.length ||
        params.without_node_ids?.length ||
        params.without_types?.length ||
        params.fields ||
        params.without_fields?.length ||
        params.references ||
        params.title_eq ||
        params.title_contains ||
        params.without_titles?.length ||
        params.without_title_contains?.length ||
        params.full_text ||
        params.full_text_words ||
        params.path_prefix ||
        params.without_path_prefix ||
        params.path_dir !== undefined ||
        params.modified_since ||
        params.created_since ||
        params.link_counts ||
        params.join_filters?.length ||
        params.without_joins?.length,
      );

      // Search path: FTS needs no embedder; semantic/hybrid require one.
      // If the mode requires an embedder but none is available, fall through to the structured path.
      const canSearch = !!query && (searchMode === 'fts' || !!embedder);
      const vector = canSearch && searchMode !== 'fts' ? await embedder!.embedQuery(query!) : null;
      try { return db.transaction(() => {
      const classification = createClassificationReadContext(db);
      const dependencies = () => { const values=classification.dependencies(); return values.length ? {classification_dependencies:values} : {}; };
      if (canSearch) {
        let candidateIds: string[] | undefined;

        if (hasStructuredFilters) {
          const filter: NodeQueryFilter = pickQueryFilter(params);

          const { sql, params: sqlParams } = buildNodeQuery(filter, db, classification);
          // Fetch all candidate IDs (no LIMIT — hybrid search applies its own ranking)
          const idSql = sql.replace(
            /^SELECT DISTINCT n\.id, n\.file_path, n\.title, n\.body, n\.version/,
            'SELECT DISTINCT n.id',
          );
          const idRows = db.prepare(idSql).all(...sqlParams) as Array<{ id: string }>;
          candidateIds = idRows.map(r => r.id);
        }

        let ftsInvalid = false;
        const searchHits = hybridSearchPrepared(db, query!, {
          candidateIds,
          limit: limit + offset,
          mode: searchMode,
          onFtsError: () => {
            ftsInvalid = true;
          },
        }, vector);

        // Pagination: slice after ranking
        const pageHits = searchHits.slice(offset, offset + limit);
        const total = searchHits.length;

        // Fetch node rows for the page
        const getNode = db.prepare('SELECT id, file_path, title, version, file_mtime, indexed_at, created_at FROM nodes WHERE id = ?');
        const rows: NodeRow[] = [];
        for (const hit of pageHits) {
          const row = getNode.get(hit.node_id) as NodeRow | undefined;
          if (row) rows.push(row);
        }

        // The hybrid path keys score/match_sources off node.id, so id must be projected
        // even if the caller's select omitted it. (Structured path doesn't need this.)
        const hybridSelectSet = selectSet && !selectSet.has('id') ? new Set([...selectSet, 'id']) : selectSet;
        const enriched = enrichRows(db, rows, includeFields, hybridSelectSet);

        // Merge search metadata onto each node
        const hitMap = new Map(pageHits.map(h => [h.node_id, h]));
        const nodes = enriched.map(node => {
          const hit = hitMap.get(node.id as string);
          if (hit) {
            node.score = hit.score;
            node.match_sources = hit.match_sources;
            if (hit.matched_embed !== undefined) node.matched_embed = hit.matched_embed;
            if (hit.snippet !== undefined) node.snippet = hit.snippet;
          }
          return node;
        });

        const warnings: Issue[] = [];
        warnings.push(...queryWarnings(db,pickQueryFilter(params)));
        if (ftsInvalid) {
          warnings.push({
            code: 'FTS_QUERY_INVALID',
            severity: 'warning',
            message:
              'The full-text (FTS5) portion of the query was skipped because it raised an error ' +
              '(most often invalid FTS5 syntax such as unbalanced quotes or stray operators like ' +
              'AND/OR/NEAR); results reflect the remaining lanes only. For a literal substring ' +
              'match, use the full_text param.',
          });
        }
        return ok({ nodes, total, ...dependencies() }, warnings);
      }

      // Standard structured query path (no query param, or no embedder)
      const filter: NodeQueryFilter = pickQueryFilter(params);

      const { sql, countSql, params: sqlParams } = buildNodeQuery(filter, db, classification);

      // Count query
      const total = (db.prepare(countSql).get(...sqlParams) as { total: number }).total;

      // Data query with ORDER BY / LIMIT / OFFSET. Project n.file_mtime so every
      // NodeRow carries it (needed for select:['file_mtime']); done via string
      // injection here rather than in query-builder.ts, whose SELECT string is
      // depended on by a regex + cast in the hybrid path above.
      const selectSql = sql.replace(
        /^SELECT DISTINCT n\.id, n\.file_path, n\.title, n\.body, n\.version/,
        'SELECT DISTINCT n.id, n.file_path, n.title, n.body, n.version, n.file_mtime, n.indexed_at, n.created_at',
      );
      if (selectSql === sql) {
        throw new Error('query-nodes: failed to inject file_mtime into the data query — the query-builder SELECT changed; update the regex in query-nodes.ts');
      }
      // A link-count sort ties often, so it falls back to title, then id, for stable pages.
      const countKind = (LINK_COUNT_COLUMNS as Record<string, (typeof LINK_COUNT_COLUMNS)[LinkCountColumn] | undefined>)[sortBy];
      if (countKind === 'unresolved') ensureLinkCountFunctions(db);
      const orderSql = countKind
        ? `${linkCountSql(countKind, 'n').sql} ${sortOrder.toUpperCase()}, n.title ASC, n.id ASC`
        : `${sortBy === 'title' ? 'n.title' : sortBy === 'file_mtime' ? 'n.file_mtime' : sortBy === 'created_at' ? 'n.created_at' : 'n.indexed_at'} ${sortOrder.toUpperCase()}`;
      const dataSql = `${selectSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
      const dataParams = [...sqlParams, limit, offset];
      const rows = db.prepare(dataSql).all(...dataParams) as NodeRow[];

      const nodes = enrichRows(db, rows, includeFields, selectSet);

      const warnings: Issue[] = [];
      warnings.push(...queryWarnings(db,pickQueryFilter(params)));
      return ok({ nodes, total, ...dependencies() }, warnings);
      }).deferred(); } catch(error) {
        if (error instanceof ClassificationError) return fail(error.code,error.message,{details:error.details as Record<string,unknown>});
        throw error;
      }
    },
  );
}
function queryWarnings(db: Database.Database, filter: NodeQueryFilter): Issue[] {
  const warnings: Issue[] = [];
  const leaves = [...filterLeaves(filter)];
  const joins = leaves.flatMap(leaf => [...leaf.join_filters ?? [], ...leaf.without_joins ?? []]);
  for (const leaf of leaves)
    warnings.push(...checkFieldOperators(db, leaf.fields));
  for (const join of joins)
    if (join.target)
      for (const leaf of filterLeaves(join.target))
        warnings.push(...checkFieldOperators(db, leaf.fields));
  const warning = computeJoinWarning(db, joins, undefined);
  if (warning)
    warnings.push(warning);
  return [...new Map(warnings.map(w => [JSON.stringify(w), w])).values()];
}
