import type { ContextProvider, ContextProviderInput, ContextSection } from './types.js';
import { parseEnvelope } from '../tools.js';
import { deriveVizTitle, vizArgs, type VizSpec } from '../viz-emit.js';

const BOARD_ROWS_PER_VIEW = 12;
const BOARD_CHAR_CAP = 15000;   // ~4k tokens total across views
const NODE_CHAR_CAP = 3000;     // ~800 tokens per node
const QUERY_PART_CAP = 200;     // one query argument (a long join_filters) in a view's query line

function capHead(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}\n…truncated ${s.length - cap} chars…`;
}
function capInline(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}
function fmtVal(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
/** A filter value in a query line: strings quoted, lists bracketed, objects as compact JSON. */
function fmtArg(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}]`;
  return JSON.stringify(v);
}

/** A saved board card's spec: a query view (the four viz kinds), or a one-note, overview or spend view. */
type CardSpec = { kind: string; title?: string; [key: string]: unknown };

function isQueryView(spec: CardSpec): spec is CardSpec & VizSpec {
  return typeof spec.query === 'object' && spec.query !== null && !Array.isArray(spec.query);
}

/** The view as the user sees it: its title, else a label derived from its query (preset views save an empty title). */
function queryViewTitle(spec: VizSpec): string {
  return spec.title?.trim() || deriveVizTitle(spec.query);
}

/**
 * The view's saved query-nodes arguments on one line, so the model can tell which notes the view
 * leaves out on purpose. The limit shown is the one the view runs with (vizArgs' default when unset).
 */
function describeViewQuery(query: Record<string, unknown>, limit: number): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || key === 'limit' || (key === 'sort_order' && query.sort_by !== undefined)) continue;
    if (key === 'types' && Array.isArray(value)) { parts.push(`types=${fmtArg(value)}`); continue; }
    if (key === 'query' && typeof value === 'string') { parts.push(`search ${fmtArg(value)}`); continue; }
    if (key === 'sort_by') { parts.push(`sort ${String(value)}${query.sort_order ? ` ${String(query.sort_order)}` : ''}`); continue; }
    if (key === 'fields' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [field, filter] of Object.entries(value as Record<string, unknown>)) {
        if (typeof filter === 'object' && filter !== null && !Array.isArray(filter)) {
          for (const [op, operand] of Object.entries(filter as Record<string, unknown>)) {
            if (operand !== undefined) parts.push(capInline(`${field} ${op} ${fmtArg(operand)}`, QUERY_PART_CAP));
          }
        } else {
          parts.push(capInline(`${field} = ${fmtArg(filter)}`, QUERY_PART_CAP));
        }
      }
      continue;
    }
    parts.push(capInline(`${key}=${fmtArg(value)}`, QUERY_PART_CAP));
  }
  parts.push(`limit ${limit}`);
  return parts.join(' · ');
}

/** One row: the note's title and id, then each display field's value from query-nodes' `fields`. */
function describeRow(row: Record<string, unknown>, displayFields: string[]): string {
  const fields = (typeof row.fields === 'object' && row.fields !== null ? row.fields : {}) as Record<string, unknown>;
  const name = `${typeof row.title === 'string' && row.title ? row.title : '(untitled)'}${row.id ? ` (id ${String(row.id)})` : ''}`;
  const values = displayFields
    .filter((f) => f !== 'title')
    .map((f) => `${f}: ${fmtVal(Object.prototype.hasOwnProperty.call(fields, f) ? fields[f] : row[f])}`);
  return values.length ? `${name} — ${values.join(', ')}` : name;
}

const OTHER_VIEW_LABEL: Record<string, string> = { node: 'Note', stats: 'Vault overview', spend: 'Usage and cost' };

/** Reference-only active-doc section (chip key 'doc'): injects the doc's
 *  identity — title, path, engine node id — never its content. The model
 *  fetches content via get-node on demand. */
export const docRefProvider: ContextProvider = {
  key: 'doc',
  async build({ manifest, state, estimateTokens }): Promise<ContextSection | null> {
    if (!state.doc || !manifest.docPath) return null;
    const title = manifest.docPath.split('/').pop()?.replace(/\.md$/, '') || manifest.docPath;
    const where = manifest.docId
      ? `${manifest.docPath}, node id ${manifest.docId}`
      : `${manifest.docPath} — engine node id unknown (likely not indexed)`;
    const hint = manifest.docId
      ? 'Fetch its content with get-node when needed.'
      : 'Its content may not be fetchable via get-node.';
    const text = `### Active document — ${title} (${where})\nThe user has this document open. When they say "this" (note/doc/file), they mean this document. ${hint}`;
    return { label: 'doc', text, tokens: estimateTokens(text) };
  },
};

export const boardProvider: ContextProvider = {
  key: 'board',
  async build({ call, manifest, estimateTokens }): Promise<ContextSection | null> {
    if (!manifest.activeBoardId) return null;
    let specs: CardSpec[];
    try {
      const benv = parseEnvelope(await call('get-board', { id: manifest.activeBoardId })) as { data?: { cards?: Array<{ spec?: unknown }> } };
      specs = (benv.data?.cards ?? []).map((c) => c.spec)
        .filter((s): s is CardSpec => !!s && typeof s === 'object' && typeof (s as { kind?: unknown }).kind === 'string');
    } catch { return null; }
    // One engine call per card, fanned out — this runs on every context build, so a
    // sequential loop made board context cost (cards × engine round-trip) per turn.
    // Promise.all preserves card order; a failing view resolves null and is dropped.
    const settled = await Promise.all(specs.map(async (spec): Promise<string | null> => {
      try {
        if (isQueryView(spec)) return await describeQueryView(call, spec);
        return await describeOtherView(call, spec);
      } catch { return null; /* skip a failing view */ }
    }));
    const blocks = settled.filter((b): b is string => b !== null);
    if (!blocks.length) return null;
    const lines: string[] = [`### Board — ${blocks.length} view${blocks.length === 1 ? '' : 's'}`];
    let used = 0, omitted = 0;
    for (const block of blocks) {
      if (used + block.length > BOARD_CHAR_CAP) { omitted++; continue; }
      used += block.length;
      lines.push(block);
    }
    if (omitted) lines.push(`- …${omitted} more view(s) omitted (board over cap)`);
    const text = lines.join('\n');
    return { label: 'board', text, tokens: estimateTokens(text) };
  },
};

async function describeQueryView(call: ContextProviderInput['call'], raw: CardSpec & VizSpec): Promise<string | null> {
  const spec: VizSpec = { ...raw, display_fields: Array.isArray(raw.display_fields) ? raw.display_fields : [] };
  const args = vizArgs(spec);
  const env = parseEnvelope(await call('query-nodes', args)) as { ok?: boolean; data?: { nodes?: Array<Record<string, unknown>>; total?: number } };
  if (!env.ok) return null;
  const rows = env.data?.nodes ?? [];
  const total = env.data?.total ?? rows.length;
  const shown = Math.min(rows.length, BOARD_ROWS_PER_VIEW);
  const grp = spec.group_by ? ` by ${spec.group_by}` : '';
  const fields = spec.display_fields.length ? `; fields: ${spec.display_fields.join(', ')}` : '';
  const more = total > shown ? '; run query-nodes with this query to see the rest' : '';
  const rowsText = rows.slice(0, BOARD_ROWS_PER_VIEW).map((r) => `    ${describeRow(r, spec.display_fields)}`).join('\n');
  return [
    `- ${spec.kind} "${queryViewTitle(spec)}"${grp}${fields}`,
    `  query: ${describeViewQuery(spec.query, args.limit as number)}`,
    `  rows (${shown} of ${total}${more}):${rowsText ? `\n${rowsText}` : ''}`,
  ].join('\n');
}

/** A one-note, overview or spend view has no query rows: one line, so the model knows it is there. */
async function describeOtherView(call: ContextProviderInput['call'], spec: CardSpec): Promise<string> {
  const label = (typeof spec.title === 'string' && spec.title.trim()) || OTHER_VIEW_LABEL[spec.kind] || spec.kind;
  if (spec.kind === 'node' && typeof spec.node_id === 'string') {
    let title: string | null = null;
    try {
      const env = parseEnvelope(await call('query-nodes', { node_ids: [spec.node_id], select: ['id', 'title'], limit: 1 })) as { ok?: boolean; data?: { nodes?: Array<{ title?: unknown }> } };
      const t = env.ok ? env.data?.nodes?.[0]?.title : undefined;
      if (typeof t === 'string' && t) title = t;
    } catch { /* the id alone still names the note */ }
    return `- note view "${label}": ${title ? `${title} ` : ''}(id ${spec.node_id})`;
  }
  if (spec.kind === 'stats') return `- overview view "${label}": vault counts (vault-stats)`;
  if (spec.kind === 'spend') return `- spend view "${label}": usage and cost${typeof spec.range === 'string' ? `, range ${spec.range}` : ''} (usage-report)`;
  return `- ${spec.kind} view "${label}"`;
}

export const nodesProvider: ContextProvider = {
  key: 'nodes',
  async build({ call, state, estimateTokens }): Promise<ContextSection | null> {
    if (!state.nodes.length) return null;
    // One get-node per pinned node, fanned out — sequentially this cost
    // (pinned nodes × engine round-trip) on every turn. Promise.all preserves the
    // pinned order; a failing node resolves null and is dropped, as before.
    const settled = await Promise.all(state.nodes.map(async (id) => {
      try {
        const env = parseEnvelope(await call('get-node', { node_id: id })) as { ok?: boolean; data?: { title?: string; types?: string[]; body?: string } };
        if (!env.ok || !env.data) return null;
        return { title: env.data.title ?? id, types: env.data.types ?? [], excerpt: env.data.body ?? '' };
      } catch { return null; /* skip a failing node */ }
    }));
    const parts = settled.filter((p): p is NonNullable<typeof p> => p !== null);
    if (!parts.length) return null;
    const lines: string[] = [`### Pinned nodes — ${parts.length}`];
    for (const n of parts) {
      const types = n.types.length ? ` [${n.types.join(', ')}]` : '';
      lines.push(`- ${n.title}${types}: ${capHead(n.excerpt, NODE_CHAR_CAP)}`);
    }
    const text = lines.join('\n');
    return { label: 'nodes', text, tokens: estimateTokens(text) };
  },
};
