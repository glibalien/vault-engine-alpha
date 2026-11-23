import type { LinkCountKind, QueryArgs, ServerSortBy } from "@vault/query-core";
import { LINK_COUNT_COLUMN, LINK_COUNT_COLUMNS, LINK_COUNT_KINDS, LINK_COUNT_LABEL, isLinkCountColumn, isServerSortBy, linkCountKindOf, queryUsesLinkCounts, widgetForField } from "@vault/query-core";
import type { Schema } from "@vault/query-core";
import { DEFAULT_VIEW_VOCABULARY, calendarDateFields, namedFields, viewStatusField, type ViewVocabulary } from "./view-vocabulary.js";

export type VizKind = 'table' | 'kanban' | 'list' | 'calendar';
export const VIZ_KINDS: readonly VizKind[] = ['table', 'kanban', 'list', 'calendar'];
export type ColumnWidths = Record<string, number> | { kanban?: Record<string, number>; table?: Record<string, number> };

/** Kinds that are no longer emitted but still exist in persisted data (board `cards_json`,
 *  saved viz fences). Accepted on read forever and normalized to their canonical name —
 *  dropping one would make those cards fail `isVizSpec` and silently vanish. */
const LEGACY_VIZ_KINDS: Readonly<Record<string, VizKind>> = { tasklist: 'list' };

/** Canonical kind for any accepted spelling, or undefined if the kind is unknown. */
export function normalizeVizKind(kind: unknown): VizKind | undefined {
  if (typeof kind !== 'string') return undefined;
  if ((VIZ_KINDS as readonly string[]).includes(kind)) return kind as VizKind;
  return LEGACY_VIZ_KINDS[kind];
}

/** Documented common subset of query-nodes arguments the viz protocol typically uses.
 *  VizSpec.query is typed as the wider QueryArgs to allow the full arg surface
 *  (join_filters, offset, …) to flow through untouched. */
export interface VizQuery extends QueryArgs {
  types?: string[];
  query?: string;
  fields?: Record<string, Record<string, unknown>>;
  path_prefix?: string;
  sort_by?: ServerSortBy;
  sort_order?: 'asc' | 'desc';
  limit?: number;
}

export interface VizSpec {
  kind: VizKind;
  /** Human-readable query label shown in the card header. */
  title: string;
  /** Full query-nodes argument surface. VizQuery documents the common subset; any additional
   *  keys (join_filters, offset, …) are forwarded to the server as-is. */
  query: QueryArgs;
  /** Field names to fetch and display; ingestion keeps each exact name's first occurrence. */
  display_fields: string[];
  /** The field rows are grouped by. Kanban: its columns; absent, the vault map's task status field
   *  (`status`) at render time. Table and List: one section per value (#573); absent, no sections. */
  group_by?: string;
  /** Table and List: the sections folded shut, by group value (`''` for the "—" section of rows
   *  with no value). Saved with the view, and dropped whenever `group_by` changes. */
  collapsed_groups?: string[];
  /** Calendar: the date field nodes are plotted by; falls back to the vault map's due/date/scheduled
   *  fields at render time. */
  date_field?: string;
  /** Calendar: an optional second date field. An item with both dates shows on every day from its
   *  date_field day to this one; without this field, or with an end before the start, its start
   *  day only. */
  end_date_field?: string;
  /** Table row density. Defaults to "cozy" at render time. */
  density?: 'compact' | 'cozy' | 'comfy';
  /** Show a leading row-number column in the table. Defaults to false. */
  show_row_numbers?: boolean;
  /** Show a trailing version column in the table. Defaults to false. */
  show_version?: boolean;
  /** Table: show the Links in / Links out / Unresolved links columns (#611). Absent: shown while
   *  the query sorts or filters by a link count (see showsLinkCounts). */
  show_link_counts?: boolean;
  /** Per-view pixel widths; flat maps are legacy Kanban widths and new writes use kind groups. */
  column_widths?: ColumnWidths;
  /** Table: sort by a column the Engine can't order by, applied on the client to the loaded rows.
   *  It replaces `query.sort_by` as the order shown; the query's sort still picks which rows load
   *  when the result is cut off. A toolbar Sort pick or a Name-header click clears it. Other kinds
   *  ignore it. Absent: rows keep the query's order. */
  column_sort?: ColumnSort;
}

/** A table column sort the client applies: a display field (or `title`, for Name during a search). */
export interface ColumnSort {
  field: string;
  order: 'asc' | 'desc';
}

export interface VizRow {
  id: string;
  title: string;
  file_path: string;
  types: string[];
  fields: Record<string, unknown>;
  /** Node version counter; present when query-nodes returns it (default shape). */
  version?: number;
  /** Link counts; present when the query selected them (vizQueryArgs, for a table showing them). */
  link_counts?: Record<LinkCountKind, number>;
}

/** Structural type guard for a VizSpec. Validates shape only — not the semantics of query.fields filters (the server sanitizes those). */
export function isVizSpec(x: unknown): x is VizSpec {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    normalizeVizKind(s.kind) !== undefined &&
    typeof s.title === 'string' && s.title.trim() !== '' &&
    typeof s.query === 'object' && s.query !== null && !Array.isArray(s.query) &&
    Array.isArray(s.display_fields) && s.display_fields.every((f) => typeof f === 'string') &&
    (s.group_by === undefined || typeof s.group_by === 'string') &&
    (s.date_field === undefined || typeof s.date_field === 'string') &&
    (s.end_date_field === undefined || typeof s.end_date_field === 'string') &&
    (s.column_widths === undefined || (typeof s.column_widths === 'object' && s.column_widths !== null && !Array.isArray(s.column_widths)))
  );
}

/** Normalize accepted specs without mutating persisted input or column-width maps. */
export function normalizeVizSpec(spec: VizSpec): VizSpec {
  const kind = normalizeVizKind(spec.kind) as VizKind;
  const display_fields = [...new Set(spec.display_fields)];
  return kind === spec.kind && display_fields.length === spec.display_fields.length
    ? spec : { ...spec, kind, display_fields };
}

/** Parse a viz codefence body, normalizing legacy kinds and repeated display fields. */
export function parseVizFence(body: string): VizSpec | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isVizSpec(parsed)) return null;
    return normalizeVizSpec(parsed);
  } catch {
    return null;
  }
}

export function serializeVizFence(spec: VizSpec): string {
  return '```viz\n' + JSON.stringify(spec, null, 2) + '\n```';
}

interface CallResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Parse a query-nodes CallToolResult into display rows, or an error message. `ranked` is set when
 *  the rows came back in search relevance order: query-nodes gives each search hit a `score`. A
 *  query with `query` text can still come back unranked, when the Engine has no embedder for a
 *  semantic or hybrid search and falls back to the structured path, which applies `sort_by`. */
export function rowsFromCallResult(result: CallResultLike): { rows: VizRow[]; total: number; ranked?: true } | { error: string } {
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') return { error: 'empty tool result' };
  if (result.isError) return { error: text };
  try {
    const env = JSON.parse(text) as {
      ok?: boolean;
      data?: { nodes?: unknown[]; total?: number };
      error?: { message?: string };
    };
    if (!env.ok) return { error: env.error?.message ?? 'query failed' };
    const nodes = Array.isArray(env.data?.nodes) ? env.data.nodes : [];
    const rows = nodes.map((n) => {
      const node = n as Record<string, unknown>;
      const row: VizRow = {
        id: String(node.id ?? node.file_path ?? ''),
        title: String(node.title ?? ''),
        file_path: String(node.file_path ?? ''),
        types: Array.isArray(node.types) ? node.types.filter((t): t is string => typeof t === 'string') : [],
        fields: (typeof node.fields === 'object' && node.fields !== null ? node.fields : {}) as Record<string, unknown>,
      };
      if (typeof node.version === 'number') row.version = node.version;
      if (LINK_COUNT_COLUMNS.every((col) => typeof node[col] === 'number')) {
        row.link_counts = Object.fromEntries(LINK_COUNT_KINDS.map((kind) => [kind, node[LINK_COUNT_COLUMN[kind]] as number])) as Record<LinkCountKind, number>;
      }
      return row;
    });
    const total = typeof env.data?.total === 'number' ? env.data.total : rows.length;
    const ranked = nodes.some((n) => typeof (n as Record<string, unknown>).score === 'number');
    return ranked ? { rows, total, ranked } : { rows, total };
  } catch {
    return { error: 'non-JSON tool result' };
  }
}

export interface SortOption { key: string; label: string; sort_by: ServerSortBy; sort_order: 'asc' | 'desc'; }
export const SORT_OPTIONS: readonly SortOption[] = [
  { key: 'file_mtime:desc', label: 'Newest first',    sort_by: 'file_mtime', sort_order: 'desc' },
  { key: 'file_mtime:asc',  label: 'Oldest first',     sort_by: 'file_mtime', sort_order: 'asc'  },
  { key: 'indexed_at:desc', label: 'Recently indexed', sort_by: 'indexed_at', sort_order: 'desc' },
  { key: 'title:asc',       label: 'Title A–Z',   sort_by: 'title',      sort_order: 'asc'  },
  { key: 'title:desc',      label: 'Title Z–A',   sort_by: 'title',      sort_order: 'desc' },
  { key: 'inlink_count:asc',  label: 'Fewest links in',  sort_by: 'inlink_count',  sort_order: 'asc'  },
  { key: 'inlink_count:desc', label: 'Most links in',    sort_by: 'inlink_count',  sort_order: 'desc' },
  { key: 'outlink_count:asc', label: 'Fewest links out', sort_by: 'outlink_count', sort_order: 'asc'  },
  { key: 'outlink_count:desc', label: 'Most links out',  sort_by: 'outlink_count', sort_order: 'desc' },
  { key: 'unresolved_link_count:desc', label: 'Most unresolved links', sort_by: 'unresolved_link_count', sort_order: 'desc' },
];
export function sortOptionKey(sort_by: string, sort_order: string): string {
  const key = `${sort_by}:${sort_order}`;
  // Fall back to the first option if the pair is outside SORT_OPTIONS, so the
  // bound <select> never renders blank (engine-constrained today, defensive).
  return SORT_OPTIONS.some((o) => o.key === key) ? key : SORT_OPTIONS[0].key;
}

/** The orders query-nodes can apply to the whole result (`sort_by`). */
export type ServerSortKey = SortOption['sort_by'];

/** A query's server sort, with the defaults query-nodes and the toolbar's strip both use. */
export function serverSortOf(query: QueryArgs): { sort_by: ServerSortKey; sort_order: 'asc' | 'desc' } {
  const by = query['sort_by'];
  return {
    sort_by: isServerSortBy(by) ? by : 'title',
    sort_order: query['sort_order'] === 'desc' ? 'desc' : 'asc',
  };
}

/** True when the query asks for a search, which query-nodes ranks by relevance, ignoring sort_by. */
export function isSearchQuery(query: QueryArgs): boolean {
  return typeof query['query'] === 'string' && query['query'] !== '';
}

/** Whether the view's rows are in relevance order: a search, ranked as far as the last result showed. */
function ranksByRelevance(spec: VizSpec, ranked: boolean | undefined): boolean {
  return isSearchQuery(spec.query) && ranked !== false;
}

/** The table column key of the Name column, which the Engine sorts by (`sort_by: title`). */
export const NAME_SORT_KEY = 'title';

/** Whether a table column's sort runs on the Engine over the whole result: Name and the link counts. */
export function isServerColumn(key: string): boolean {
  return key === NAME_SORT_KEY || isLinkCountColumn(key);
}

/** Whether a table shows the link-count columns: as set, else while its query sorts or filters by one. */
export function showsLinkCounts(spec: VizSpec): boolean {
  return spec.kind === 'table' && (spec.show_link_counts ?? queryUsesLinkCounts(spec.query));
}

/** A table column's name in sort labels: Name, a link count's header, or the field name. */
export function columnLabel(key: string): string {
  if (key === NAME_SORT_KEY) return 'Name';
  return isLinkCountColumn(key) ? LINK_COUNT_LABEL[linkCountKindOf(key)] : key;
}

/** The order a table shows its rows in. The header arrow and the toolbar's Sort both show it. */
export interface TableSort {
  /** `title` (Name), `file_mtime` / `indexed_at` (no column), or a display field. */
  key: string;
  order: 'asc' | 'desc';
  /** True: the client sorted the loaded rows. False: the Engine sorted the whole result. */
  client: boolean;
}

function isColumnSort(x: unknown): x is ColumnSort {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  return typeof c.field === 'string' && c.field !== '' && (c.order === 'asc' || c.order === 'desc');
}

/**
 * A table's one sort. A saved column sort wins while its column is shown; otherwise the query's
 * server sort. Null while a search ranks the rows by relevance and no column sort is set.
 * A malformed or orphaned `column_sort` is ignored rather than rejected, so the view still opens.
 * `ranked` is whether the loaded rows came back in relevance order (`rowsFromCallResult`); without
 * it, any search is assumed ranked.
 */
export function tableSortOf(spec: VizSpec, ranked?: boolean): TableSort | null {
  const col = spec.column_sort;
  if (isColumnSort(col) && (col.field === NAME_SORT_KEY || spec.display_fields.includes(col.field) || (isLinkCountColumn(col.field) && showsLinkCounts(spec)))) {
    return { key: col.field, order: col.order, client: true };
  }
  if (ranksByRelevance(spec, ranked)) return null;
  const { sort_by, sort_order } = serverSortOf(spec.query);
  return { key: sort_by, order: sort_order, client: false };
}

/**
 * The sort a click on a table header asks for. The column already sorting flips direction; another
 * column starts ascending. Name and the link counts sort on the Engine, except while a search ranks
 * the rows (the Engine ignores sort_by then); every other column sorts the loaded rows on the client.
 */
export function nextTableSort(spec: VizSpec, key: string, ranked?: boolean): TableSort {
  const cur = tableSortOf(spec, ranked);
  const order = cur && cur.key === key && cur.order === 'asc' ? 'desc' : 'asc';
  return { key, order, client: !isServerColumn(key) || ranksByRelevance(spec, ranked) };
}

/** The spec without a column sort (a server sort was picked). */
export function withoutColumnSort(spec: VizSpec): VizSpec {
  if (spec.column_sort === undefined) return spec;
  const { column_sort: _dropped, ...rest } = spec;
  return rest;
}

/** Short name of a table's sort, for the toolbar's Sort control. */
export function tableSortLabel(sort: TableSort | null): string {
  if (!sort) return 'Relevance';
  const option = sort.client ? undefined : SORT_OPTIONS.find((o) => o.sort_by === sort.key && o.sort_order === sort.order);
  if (option) return option.label;
  return `${columnLabel(sort.key)} ${sort.order === 'asc' ? '↑' : '↓'}`;
}

/** The query-nodes columns a row is built from (rowsFromCallResult); include_fields adds `fields`. */
const ROW_COLUMNS = ['id', 'file_path', 'title', 'version', 'types'];

/** Field names a calendar tries (in order) when no explicit date_field is chosen, with the vault
 *  map at its defaults. A vault's own names come from calendarDateFields. */
export const CALENDAR_DATE_FALLBACKS = ['due', 'date', 'scheduled'] as const;

const SCALAR_WIDGETS = new Set(['text', 'enum', 'number', 'date', 'bool']);

/** Default table columns when a spec carries no display_fields (Inc 6 synthesized cards):
 *  the schema's scalar fields (excludes reference/list/textarea + a `body` field), capped at 6. */
export function defaultDisplayFields(schema: Schema): string[] {
  return schema.fields
    .filter((f) => f.name !== 'body' && SCALAR_WIDGETS.has(widgetForField(f)))
    .map((f) => f.name)
    .slice(0, 6);
}

/** Derive the card header title.
 *  - If `spec.title` is non-empty, return it (user override).
 *  - Else return `lockedType` if set, or `'Mixed results'` when unlocked. */
export function deriveVizTitle(spec: VizSpec, lockedType: string | null): string {
  if (spec.title.trim() !== '') return spec.title;
  return lockedType ?? 'Mixed results';
}

/** Returns the spec to apply when the locked type changes: clears display_fields so they re-derive,
 *  and any column sort, which named the old type's column. */
/** Table and List: the field their rows are grouped into sections by (#573), or null for none. A
 *  kanban always groups (its columns), so it has no use for this. */
export function sectionField(spec: Pick<VizSpec, 'kind' | 'group_by'>): string | null {
  return (spec.kind === 'table' || spec.kind === 'list') && spec.group_by ? spec.group_by : null;
}

/** The sections folded shut. A value that isn't a list of strings (a hand-edited board) folds nothing. */
export function foldedGroups(spec: Pick<VizSpec, 'collapsed_groups'>): string[] {
  const v = spec.collapsed_groups as unknown;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The spec grouped by `field` (null: no grouping). Any folded sections are dropped: they named the
 *  old field's values. */
export function specWithGroupBy(spec: VizSpec, field: string | null): VizSpec {
  const { group_by: _g, collapsed_groups: _c, ...rest } = spec;
  return field === null ? rest : { ...rest, group_by: field };
}

/** The spec with one section folded or opened. */
export function specWithFoldToggled(spec: VizSpec, value: string): VizSpec {
  const folded = foldedGroups(spec);
  const next = folded.includes(value) ? folded.filter((v) => v !== value) : [...folded, value];
  const { collapsed_groups: _c, ...rest } = spec;
  return next.length > 0 ? { ...rest, collapsed_groups: next } : rest;
}

/** The fields a Table, List or Kanban can group by (#573): the fields of the view's types, in schema
 *  order; for a view with no type, the fields on its loaded rows. The field in use is always listed. */
export function groupByOptions(types: readonly string[], schemas: ReadonlyMap<string, Schema>, rowFields: readonly string[], inUse: string | null): string[] {
  const names = types.length > 0 ? types.flatMap((t) => schemas.get(t)?.fields.map((f) => f.name) ?? []) : rowFields;
  return [...new Set([...names, ...(inUse ? [inUse] : [])])];
}

const ISO_DAY_START = /^\d{4}-\d{2}-\d{2}/;

/** Whether sections by `field` are one per day: it is a date field in the view's types (in any
 *  loaded schema, for a view with no type), or, when no schema names it, every value it holds on
 *  the loaded rows starts with a YYYY-MM-DD day. */
export function groupsByDay(field: string, types: readonly string[], schemas: ReadonlyMap<string, Schema>, rows: readonly VizRow[]): boolean {
  const from = types.length > 0 ? types.map((t) => schemas.get(t)) : [...schemas.values()];
  const defs = from.flatMap((s) => s?.fields.filter((f) => f.name === field) ?? []);
  if (defs.length > 0) return defs.some((f) => f.type === 'date');
  const values = rows.map((r) => r.fields[field]).filter((v) => v !== null && v !== undefined && v !== '');
  return values.length > 0 && values.every((v) => typeof v === 'string' && ISO_DAY_START.test(v));
}

export function specForTypeChange(spec: VizSpec, nextType: string): VizSpec {
  return { ...withoutColumnSort(spec), query: { ...spec.query, types: [nextType] }, display_fields: [] };
}

/**
 * query-nodes arguments for a spec: its query plus the fields the viz displays/groups.
 * The grouping field defaults to the vault map's task status field (matching VizCardView's
 * render-time default), so it is always fetched — otherwise a kanban with group_by omitted would
 * never receive the field it buckets on; when the vault has none, nothing extra is fetched. A list
 * also fetches the task status field its checkbox reads, whatever its `group_by`. The shared
 * vizArgs (@vault/chat-core, src/viz-emit.ts) mirrors this.
 */
export function vizQueryArgs(spec: VizSpec, vocabulary: ViewVocabulary = DEFAULT_VIEW_VOCABULARY): QueryArgs & { include_fields: string[]; limit: number } {
  const dateFields = spec.kind === 'calendar'
    ? [...(spec.date_field ? [spec.date_field] : calendarDateFields(vocabulary)), ...(spec.end_date_field ? [spec.end_date_field] : [])]
    : [];
  const checkbox = spec.kind === 'list' ? namedFields(vocabulary.taskStatusField) : [];
  const include = [...new Set([...spec.display_fields, ...namedFields(viewStatusField(spec, vocabulary)), ...checkbox, ...dateFields])];
  // Link counts come only when selected, so a table showing them names every column it reads.
  const select = showsLinkCounts(spec) ? { select: [...ROW_COLUMNS, ...LINK_COUNT_COLUMNS] } : {};
  return { ...spec.query, ...select, include_fields: include, limit: (spec.query['limit'] as number | undefined) ?? 50 };
}
