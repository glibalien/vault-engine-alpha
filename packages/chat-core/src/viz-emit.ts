import { dynamicTool, jsonSchema, type Tool } from 'ai';
import { parseEnvelope, type EngineCall } from './tools.js';
import { DEFAULT_VAULT_NAMES, vizExampleNames, type VizVaultNames } from './viz-vocab.js';

/** Structural viz spec carried by data-viz parts (mirror of the web VizSpec). */
export interface VizSpec {
  kind: string;
  title: string;
  query: Record<string, unknown>;
  display_fields: string[];
  /** Kanban: its column field. Table and list: one section per value (#573); absent, none. */
  group_by?: string;
  date_field?: string;
  /** Calendar: a second date field; an item with both dates shows on every day from start to end. */
  end_date_field?: string;
  /** Table: show the link-count columns (#611); set when the synthesized call selected a count. */
  show_link_counts?: boolean;
}

const LINK_COUNT_COLUMNS = ['inlink_count', 'outlink_count', 'unresolved_link_count'];

export const VIZ_KINDS = ['table', 'kanban', 'list', 'calendar'] as const;
const QUERY_KEYS = [
  'types', 'query', 'fields', 'path_prefix', 'path_dir', 'sort_by', 'sort_order', 'limit', 'offset',
  'title_contains', 'title_eq', 'join_filters', 'without_joins', 'without_types', 'without_titles',
  'without_fields', 'without_node_ids', 'without_path_prefix', 'references', 'node_ids', 'modified_since',
  'link_counts',
] as const;
const MAX_DISPLAY_FIELDS = 8;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SORT_BY_VALUES = ['title', 'file_mtime', 'indexed_at', 'inlink_count', 'outlink_count', 'unresolved_link_count'] as const;
const SORT_ORDER_VALUES = ['asc', 'desc'] as const;

/** Strip unknown query-nodes keys and clamp limit — the query-shaping half of
 *  sanitizeVizInput, shared with the board-plan interpreter's add_from_query. */
export function sanitizeQueryArgs(input: unknown): { query: Record<string, unknown> } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: 'query must be an object' };
  const query: Record<string, unknown> = {};
  for (const key of QUERY_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (v !== undefined) query[key] = v;
  }
  if (query.sort_by !== undefined && !SORT_BY_VALUES.includes(query.sort_by as (typeof SORT_BY_VALUES)[number])) {
    return { error: `sort_by must be one of ${SORT_BY_VALUES.join(', ')}` };
  }
  if (query.sort_order !== undefined && !SORT_ORDER_VALUES.includes(query.sort_order as (typeof SORT_ORDER_VALUES)[number])) {
    return { error: `sort_order must be one of ${SORT_ORDER_VALUES.join(', ')}` };
  }
  if (typeof query.limit === 'number') query.limit = Math.min(Math.max(1, query.limit), MAX_LIMIT);
  return { query };
}

/** Validate + normalize present-viz input: strip unknown query keys, cap fields/limit. */
export function sanitizeVizInput(input: unknown): { spec: VizSpec; pin: boolean } | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'input must be an object' };
  const i = input as Record<string, unknown>;
  if (!VIZ_KINDS.includes(i.kind as (typeof VIZ_KINDS)[number])) return { error: `kind must be one of ${VIZ_KINDS.join(', ')}` };
  if (typeof i.title !== 'string' || i.title.trim() === '') return { error: 'title is required' };
  const q = sanitizeQueryArgs(i.query);
  if ('error' in q) return q;
  if (!Array.isArray(i.display_fields) || !i.display_fields.every((f) => typeof f === 'string')) {
    return { error: 'display_fields must be a string array' };
  }
  return {
    spec: {
      kind: i.kind as string,
      title: i.title.trim(),
      query: q.query,
      display_fields: [...new Set(i.display_fields as string[])].slice(0, MAX_DISPLAY_FIELDS),
      ...(typeof i.group_by === 'string' ? { group_by: i.group_by } : {}),
      ...(typeof i.date_field === 'string' ? { date_field: i.date_field } : {}),
      ...(typeof i.end_date_field === 'string' ? { end_date_field: i.end_date_field } : {}),
    },
    pin: i.pin === true,
  };
}

export function deriveVizTitle(query: Record<string, unknown>): string {
  const types = Array.isArray(query.types) ? query.types.filter((t): t is string => typeof t === 'string') : [];
  const base = types.length ? types.join(' + ') : 'nodes';
  const q = typeof query.query === 'string' && query.query.trim() ? ` · "${query.query.trim()}"` : '';
  return base + q;
}

/** Synthesize a normalized `table` VizSpec from a query-nodes call's input args (Inc 6 wiring flip). */
export function synthesizeVizSpec(input: unknown): VizSpec | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const i = input as Record<string, unknown>;
  const query: Record<string, unknown> = {};
  for (const key of QUERY_KEYS) {
    const v = i[key];
    if (v !== undefined) query[key] = v;
  }
  if (typeof query.limit === 'number') query.limit = Math.min(Math.max(1, query.limit), MAX_LIMIT);
  const inc = i.include_fields;
  const display = Array.isArray(inc)
    ? [...new Set(inc.filter((f): f is string => typeof f === 'string' && f !== '*'))].slice(0, MAX_DISPLAY_FIELDS)
    : [];
  // select itself is dropped (the card picks its own columns), but a count it asked for stays shown.
  const selectsLinkCounts = Array.isArray(i.select) && i.select.some((col) => LINK_COUNT_COLUMNS.includes(col as string));
  return {
    kind: 'table', title: deriveVizTitle(query), query, display_fields: display,
    ...(selectsLinkCounts ? { show_link_counts: true } : {}),
  };
}

export function vizArgs(spec: VizSpec, vault: VizVaultNames = DEFAULT_VAULT_NAMES): Record<string, unknown> {
  // Mirror of viz-ui's vizQueryArgs: the grouping field defaults to the vault map's task status
  // field and is always fetched (nothing when the vault has none), and a list also fetches the task
  // status field its checkbox reads, so the verified query and the client's live query agree.
  const group = spec.group_by ?? vault.taskStatusField;
  const checkbox = spec.kind === 'list' ? vault.taskStatusField : null;
  const include = [...new Set([...spec.display_fields, group, checkbox].filter((f): f is string => f !== null))];
  return { ...spec.query, include_fields: include, limit: (spec.query.limit as number | undefined) ?? DEFAULT_LIMIT };
}

export const PRESENT_VIZ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'query', 'display_fields'],
  properties: {
    kind: { type: 'string', enum: [...VIZ_KINDS], description: 'How to render: table (sortable columns), kanban (grouped board), list (checkbox list), calendar (month grid by date field).' },
    title: { type: 'string', description: 'Short human query label shown on the card, e.g. \'tasks · project = "Vault Engine" · status != done\'.' },
    query: {
      type: 'object',
      additionalProperties: true,
      description: 'query-nodes arguments: types, fields (operator filters), query (hybrid search), path_prefix, path_dir, sort_by, sort_order, limit, offset, title_contains, title_eq, and other query-nodes args (join_filters, without_*, references, node_ids, modified_since, link_counts). A table that sorts or filters by a link count shows the Links in / Links out / Unresolved links columns.',
      properties: {
        types: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        fields: { type: 'object' },
        path_prefix: { type: 'string' },
        path_dir: { type: 'string' },
        sort_by: { type: 'string', enum: [...SORT_BY_VALUES] },
        sort_order: { type: 'string', enum: [...SORT_ORDER_VALUES] },
        limit: { type: 'number' },
        offset: { type: 'number' },
        title_contains: { type: 'string' },
        title_eq: { type: 'string' },
        join_filters: { type: 'array', items: { type: 'object' } },
        without_joins: { type: 'array', items: { type: 'string' } },
        without_types: { type: 'array', items: { type: 'string' } },
        without_titles: { type: 'array', items: { type: 'string' } },
        without_fields: { type: 'array', items: { type: 'string' } },
        without_node_ids: { type: 'array', items: { type: 'string' } },
        without_path_prefix: { type: 'string' },
        references: { type: 'array', items: { type: 'string' } },
        node_ids: { type: 'array', items: { type: 'string' } },
        modified_since: { type: 'string' },
      },
    },
    display_fields: { type: 'array', items: { type: 'string' }, description: 'Fields to show (max 8), e.g. ["status","due","project"].' },
    group_by: { type: 'string', description: 'The field rows are grouped by. Kanban: its columns (default "status"). Table or list: one section per value; omit it for no sections.' },
    date_field: { type: 'string', description: 'Calendar date field to plot by (e.g. "due"). Required when kind is "calendar".' },
    end_date_field: { type: 'string', description: 'Calendar only, optional: the date field where each item ends. An item with both dates shows on every day from its date_field date to this one.' },
    pin: { type: 'boolean', description: 'Pin the card to the canvas immediately. Only when the user explicitly asked to pin.' },
  },
} as const;

/**
 * The present-viz input schema with its examples built from the vault map's names (`vault`).
 * Absent, the schema above: its examples are the map's defaults. An example whose name the vault
 * has none of is left neutral.
 */
export function presentVizSchema(vault?: VizVaultNames): typeof PRESENT_VIZ_SCHEMA {
  if (!vault) return PRESENT_VIZ_SCHEMA;
  const n = vizExampleNames(vault);
  const title = n.tasks !== null && n.status !== null
    ? `'${n.tasks} · project = "Vault Engine" · ${n.status} != ${n.done}'`
    : `'<type> · <field> != <value>'`;
  const fields = JSON.stringify([n.status, n.due, 'project'].filter((f) => f !== null));
  const p = PRESENT_VIZ_SCHEMA.properties;
  return {
    ...PRESENT_VIZ_SCHEMA,
    properties: {
      ...p,
      title: { ...p.title, description: `Short human query label shown on the card, e.g. ${title}.` },
      display_fields: { ...p.display_fields, description: `Fields to show (max 8), e.g. ${fields}.` },
      group_by: { ...p.group_by, description: `The field rows are grouped by. Kanban: its columns${n.status !== null ? ` (default ${JSON.stringify(n.status)})` : ''}. Table or list: one section per value; omit it for no sections.` },
      date_field: { ...p.date_field, description: `Calendar date field to plot by${n.date !== null ? ` (e.g. ${JSON.stringify(n.date)})` : ''}. Required when kind is "calendar".` },
    },
  } as unknown as typeof PRESENT_VIZ_SCHEMA;
}

export interface VizDataPart {
  type: 'data-viz';
  id: string;
  data: { toolCallId: string; spec: VizSpec; collapsed?: boolean };
}

/** Write data-viz parts for successful present-viz results; the host supplies the pin side-effect. */
export function emitVizParts(
  writer: { write(part: VizDataPart): void },
  toolResults: Array<{ toolCallId: string; toolName: string; input: unknown; output: unknown }>,
  pinViz: (toolCallId: string, spec: VizSpec) => void,
): void {
  for (const tr of toolResults) {
    if (tr.toolName !== 'present-viz') continue;
    if (!(typeof tr.output === 'object' && tr.output !== null && (tr.output as { ok?: unknown }).ok === true)) continue;
    const v = sanitizeVizInput(tr.input);
    if ('error' in v) continue;
    writer.write({ type: 'data-viz', id: tr.toolCallId, data: { toolCallId: tr.toolCallId, spec: v.spec } });
    pinViz(tr.toolCallId, v.spec);
  }
}

/** Emit a collapsed `table` viz card for each successful query-nodes result. Opt-in pin (NOT auto-pinned). */
export function emitSynthesizedVizParts(
  writer: { write(part: VizDataPart): void },
  toolResults: Array<{ toolCallId: string; toolName: string; input: unknown; output: unknown }>,
): void {
  for (const tr of toolResults) {
    if (tr.toolName !== 'query-nodes') continue;
    if (!(typeof tr.output === 'object' && tr.output !== null && (tr.output as { ok?: unknown }).ok === true)) continue;
    const spec = synthesizeVizSpec(tr.input);
    if (!spec) continue;
    writer.write({ type: 'data-viz', id: tr.toolCallId, data: { toolCallId: tr.toolCallId, spec, collapsed: true } });
  }
}

/**
 * Local tool: validate a viz spec, run its query once to verify it resolves,
 * and return a count summary. `vault` (the vault map's names) shapes the schema's examples and the
 * default grouping field; absent, today's names. The host streams the card to the client; the
 * client re-resolves the query live, so rows are never frozen into the chat.
 */
export function createPresentVizTool(call: EngineCall, vault?: VizVaultNames): Tool {
  return dynamicTool({
    description:
      'Present a live visualization card (table, kanban board, or task list) of vault nodes to the user. ' +
      'Use whenever the user asks to see, list, board, or visualize tasks/projects/nodes — instead of a markdown table. ' +
      'The card resolves its query live and the user can switch render kinds, sort, filter, and pin it to their canvas.',
    inputSchema: jsonSchema(presentVizSchema(vault) as Parameters<typeof jsonSchema>[0]),
    execute: async (input) => {
      const started = Date.now();
      const v = sanitizeVizInput(input);
      if ('error' in v) {
        return { ok: false, error: { code: 'INVALID_VIZ_SPEC', message: v.error }, warnings: [], _ms: Date.now() - started };
      }
      try {
        const result = await call('query-nodes', vizArgs(v.spec, vault));
        const env = parseEnvelope(result) as {
          ok?: boolean;
          data?: { nodes?: Array<{ title?: string }>; total?: number };
          error?: unknown;
          warnings?: unknown[];
        };
        if (!env.ok) return { ...env, _ms: Date.now() - started };
        const nodes = env.data?.nodes ?? [];
        return {
          ok: true,
          data: {
            presented: v.spec.kind,
            count: env.data?.total ?? nodes.length,
            sample: nodes.slice(0, 5).map((n) => n.title ?? ''),
            pinned: v.pin,
          },
          warnings: env.warnings ?? [],
          _ms: Date.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: 'TOOL_CALL_FAILED', message: err instanceof Error ? err.message : String(err) },
          warnings: [],
          _ms: Date.now() - started,
        };
      }
    },
  });
}
