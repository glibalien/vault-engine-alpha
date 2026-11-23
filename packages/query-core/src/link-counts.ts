/**
 * Link counts (#611) on the client side: the query-nodes `sort_by` values and columns for them,
 * and the part of a `link_counts` filter the view's Filter menu can edit.
 *
 * The Engine counts distinct linked notes, body links and reference fields together, and never a
 * note's links to itself. `unresolved` counts the notes a node links to that don't exist.
 */
import type { QueryArgs } from "./types.js";

export type LinkCountKind = "incoming" | "outgoing" | "unresolved";
export const LINK_COUNT_KINDS: readonly LinkCountKind[] = ["incoming", "outgoing", "unresolved"];

/** The query-nodes column (and `sort_by` value) for each kind. */
export const LINK_COUNT_COLUMN: Readonly<Record<LinkCountKind, LinkCountColumn>> = {
  incoming: "inlink_count",
  outgoing: "outlink_count",
  unresolved: "unresolved_link_count",
};
export type LinkCountColumn = "inlink_count" | "outlink_count" | "unresolved_link_count";
export const LINK_COUNT_COLUMNS: readonly LinkCountColumn[] = ["inlink_count", "outlink_count", "unresolved_link_count"];

/** Column headers and filter-row names, in plain words. */
export const LINK_COUNT_LABEL: Readonly<Record<LinkCountKind, string>> = {
  incoming: "Links in",
  outgoing: "Links out",
  unresolved: "Unresolved links",
};
/** What each count means, for a header's tooltip. */
export const LINK_COUNT_HINT: Readonly<Record<LinkCountKind, string>> = {
  incoming: "How many notes link to this note",
  outgoing: "How many notes this note links to",
  unresolved: "How many notes this note links to that don't exist yet",
};

export function isLinkCountColumn(value: unknown): value is LinkCountColumn {
  return typeof value === "string" && (LINK_COUNT_COLUMNS as readonly string[]).includes(value);
}

export function linkCountKindOf(column: LinkCountColumn): LinkCountKind {
  return LINK_COUNT_KINDS.find((kind) => LINK_COUNT_COLUMN[kind] === column)!;
}

/** Every order query-nodes can apply to a whole result. */
export type ServerSortBy = "title" | "file_mtime" | "indexed_at" | LinkCountColumn;
export const SERVER_SORT_BYS: readonly ServerSortBy[] = ["title", "file_mtime", "indexed_at", ...LINK_COUNT_COLUMNS];
export function isServerSortBy(value: unknown): value is ServerSortBy {
  return typeof value === "string" && (SERVER_SORT_BYS as readonly string[]).includes(value);
}

/** The comparisons the Filter menu offers, one per count. */
export type LinkCountOp = "lte" | "eq" | "gte";
export const LINK_COUNT_OPS: readonly LinkCountOp[] = ["lte", "eq", "gte"];
export const LINK_COUNT_OP_SYMBOL: Readonly<Record<LinkCountOp, string>> = { lte: "≤", eq: "=", gte: "≥" };
export interface LinkCountRule { op: LinkCountOp; value: number }
export type LinkCountRules = Partial<Record<LinkCountKind, LinkCountRule>>;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The rules a `link_counts` arg holds when the Filter menu can edit all of it: at most one of
 * ≤ = ≥ per count, and no rel_type. Null for anything else, which the view keeps as a caller chip.
 */
export function parseLinkCountRules(value: unknown): LinkCountRules | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rules: LinkCountRules = {};
  for (const [key, predicate] of Object.entries(value as Record<string, unknown>)) {
    if (!(LINK_COUNT_KINDS as readonly string[]).includes(key)) return null;
    if (typeof predicate !== "object" || predicate === null || Array.isArray(predicate)) return null;
    const entries = Object.entries(predicate as Record<string, unknown>);
    if (entries.length !== 1) return null;
    const [op, operand] = entries[0]!;
    if (!(LINK_COUNT_OPS as readonly string[]).includes(op) || !isCount(operand)) return null;
    rules[key as LinkCountKind] = { op: op as LinkCountOp, value: operand };
  }
  return Object.keys(rules).length ? rules : null;
}

/** The `link_counts` arg for some rules, or undefined when none is set. */
export function linkCountsArg(rules: LinkCountRules | undefined): QueryArgs | undefined {
  if (!rules) return undefined;
  const arg: QueryArgs = {};
  for (const kind of LINK_COUNT_KINDS) {
    const rule = rules[kind];
    if (rule && isCount(rule.value)) arg[kind] = { [rule.op]: rule.value };
  }
  return Object.keys(arg).length ? arg : undefined;
}

/** The rules with one count's rule set (or cleared with undefined); undefined when none is left. */
export function withLinkCountRule(rules: LinkCountRules | undefined, kind: LinkCountKind, rule: LinkCountRule | undefined): LinkCountRules | undefined {
  const next: LinkCountRules = { ...rules };
  if (rule) next[kind] = rule;
  else delete next[kind];
  return Object.keys(next).length ? next : undefined;
}

/** How many rules are set, for the Filter button's badge. */
export function linkCountRuleCount(rules: LinkCountRules | undefined): number {
  return rules ? LINK_COUNT_KINDS.filter((kind) => rules[kind] !== undefined).length : 0;
}

const OP_SYMBOLS: Record<string, string> = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" };

/** A caller chip's label for a `link_counts` arg the Filter menu can't edit. */
export function linkCountsLabel(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "links: {…}";
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const kind of LINK_COUNT_KINDS) {
    const predicate = p[kind];
    if (typeof predicate !== "object" || predicate === null) continue;
    for (const [op, value] of Object.entries(predicate as Record<string, unknown>)) {
      parts.push(`${LINK_COUNT_LABEL[kind].toLowerCase()} ${OP_SYMBOLS[op] ?? op} ${String(value)}`);
    }
  }
  const rel = Array.isArray(p.rel_type) ? p.rel_type.join("∣") : typeof p.rel_type === "string" ? p.rel_type : null;
  if (rel) parts.push(`via ${rel}`);
  return parts.length ? parts.join(", ") : "links: {…}";
}

/** Whether a `where` expression (all/any groups of filter leaves) filters by a link count anywhere. */
function expressionUsesLinkCounts(expression: unknown, depth: number): boolean {
  // The Engine caps expression depth at 4; the bound here only guards against malformed input.
  if (depth > 8 || typeof expression !== "object" || expression === null || Array.isArray(expression)) return false;
  const node = expression as Record<string, unknown>;
  for (const group of ["all", "any"] as const) {
    if (Array.isArray(node[group])) return (node[group] as unknown[]).some((child) => expressionUsesLinkCounts(child, depth + 1));
  }
  return node.link_counts !== undefined && node.link_counts !== null;
}

/** True when a query sorts or filters by a link count, at its top level or inside `where`, so a
 *  table should show the counts. */
export function queryUsesLinkCounts(query: QueryArgs): boolean {
  return isLinkCountColumn(query.sort_by)
    || (query.link_counts !== undefined && query.link_counts !== null)
    || expressionUsesLinkCounts(query.where, 0);
}
