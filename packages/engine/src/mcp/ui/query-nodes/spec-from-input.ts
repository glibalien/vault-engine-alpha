/**
 * Seed a table VizSpec from the host-pushed query-nodes tool-call arguments.
 *
 * Structural mirror of @vault/viz-ui's VizSpec (same established pattern as
 * @vault/chat-core src/viz-emit.ts) — deliberately dependency-free so it
 * typechecks under the engine's node-side tsconfig via the test import chain.
 *
 * Unlike chat-core's synthesizeVizSpec (which allowlists keys because its
 * input is LLM free text), this forwards ALL args verbatim except the two
 * presentation keys the card owns: include_fields (→ display_fields; re-added
 * by vizQueryArgs on every card query) and select (a column projection that
 * would strip the fields payload the table renders from). The input here is
 * the zod-validated engine call — dropping real filter keys would change the
 * result set versus the call the model made.
 */
const PRESENTATION_KEYS = new Set(["include_fields", "select"]);
const MAX_DISPLAY_FIELDS = 8;
const MAX_LIMIT = 200;

export interface SeededVizSpec {
  kind: "table";
  title: string;
  query: Record<string, unknown>;
  display_fields: string[];
  /** Set when the call selected a link count (#611): the card shows the link-count columns. */
  show_link_counts?: true;
}

const LINK_COUNT_COLUMNS = new Set(["inlink_count", "outlink_count", "unresolved_link_count"]);

function deriveSeedTitle(query: Record<string, unknown>): string {
  const types = Array.isArray(query.types)
    ? query.types.filter((t): t is string => typeof t === "string")
    : [];
  const base = types.length ? types.join(" + ") : "nodes";
  const q = typeof query.query === "string" && query.query.trim() ? ` · "${query.query.trim()}"` : "";
  return base + q;
}

export function specFromToolInput(input: unknown): SeededVizSpec | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || PRESENTATION_KEYS.has(key)) continue;
    query[key] = value;
  }
  if (typeof query.limit === "number") query.limit = Math.min(Math.max(1, query.limit), MAX_LIMIT);
  const inc = (input as Record<string, unknown>).include_fields;
  const display = Array.isArray(inc)
    ? inc.filter((f): f is string => typeof f === "string" && f !== "*").slice(0, MAX_DISPLAY_FIELDS)
    : [];
  const select = (input as Record<string, unknown>).select;
  const selectsLinkCounts = Array.isArray(select) && select.some((col) => LINK_COUNT_COLUMNS.has(col as string));
  return {
    kind: "table", title: deriveSeedTitle(query), query, display_fields: display,
    ...(selectsLinkCounts ? { show_link_counts: true as const } : {}),
  };
}
