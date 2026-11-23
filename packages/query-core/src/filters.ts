/**
 * Filter-chip state model. Maps widget-shaped chip state onto the REAL
 * query-nodes field operators (one_of / exists / includes / gte / lte / eq /
 * contains). See src/mcp/query-builder.ts for the operator vocabulary.
 */
import type { FilterChip, LinkTarget, Schema, SchemaField } from "./types.js";
import { widgetForField } from "./schema.js";

export function initialFilterState(field: SchemaField): Record<string, unknown> {
  switch (widgetForField(field)) {
    case "enum": return { one_of: [] };
    case "bool": return { eq: null };
    case "link": return { exists: null, target: null };
    case "number": return { min: "", max: "" };
    case "date": return { gte: "", lte: "" };
    case "tags": return { value: "" };
    default: return { contains: "" }; // text
  }
}

function num(v: unknown): number | undefined {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** One field's filter-operator object parsed into chip state, plus which ops
 *  the chip consumed. The un-consumed remainder is the caller's business
 *  (query-nodes owned-args carries it as a fragment). Null = nothing here is
 *  chip-expressible. parseFieldFilters delegates to this — keep in sync with
 *  initialFilterState's per-widget state keys. */
export interface ParsedFieldFilter { state: Record<string, unknown>; consumed: string[]; }

export function parseFieldFilterOps(
  field: SchemaField,
  ops: Record<string, unknown>,
): ParsedFieldFilter | null {
  switch (widgetForField(field)) {
    case "enum":
      if (Array.isArray(ops.one_of)) return { state: { one_of: ops.one_of }, consumed: ["one_of"] };
      if ("eq" in ops) return { state: { one_of: [ops.eq] }, consumed: ["eq"] };
      return null;
    case "bool":
      if (typeof ops.eq === "boolean") return { state: { eq: ops.eq }, consumed: ["eq"] };
      return null;
    case "link":
      if (typeof ops.exists === "boolean") return { state: { exists: ops.exists, target: null }, consumed: ["exists"] };
      return null;
    case "number": {
      const consumed = ["gte", "lte"].filter(k => ops[k] != null && String(ops[k]) !== "");
      if (!consumed.length) return null;
      return {
        state: { min: ops.gte == null ? "" : String(ops.gte), max: ops.lte == null ? "" : String(ops.lte) },
        consumed,
      };
    }
    case "date": {
      const consumed = ["gte", "lte"].filter(k => ops[k] != null && String(ops[k]) !== "");
      if (!consumed.length) return null;
      return {
        state: { gte: ops.gte == null ? "" : String(ops.gte), lte: ops.lte == null ? "" : String(ops.lte) },
        consumed,
      };
    }
    case "tags":
      if (ops.includes != null) return { state: { value: String(ops.includes) }, consumed: ["includes"] };
      return null;
    default: // text / textarea
      if (ops.contains != null) return { state: { contains: String(ops.contains) }, consumed: ["contains"] };
      if (ops.eq != null) return { state: { contains: String(ops.eq) }, consumed: ["eq"] };
      return null;
  }
}

/**
 * Inverse of buildFieldFilters: turn an incoming query-nodes `fields` arg (as a
 * tool caller passes it) back into display chips, so the strip reflects a filter
 * the caller already applied. Maps the engine operators onto our widget chip
 * state. Operators a chip can't represent are dropped (the row data still
 * reflects them; they just aren't surfaced as an editable chip).
 */
export function parseFieldFilters(fields: unknown, schema: Schema): FilterChip[] {
  if (!fields || typeof fields !== "object") return [];
  const chips: FilterChip[] = [];
  for (const [name, raw] of Object.entries(fields as Record<string, unknown>)) {
    const field = schema.fields.find(f => f.name === name);
    if (!field || !raw || typeof raw !== "object") continue;
    const parsed = parseFieldFilterOps(field, raw as Record<string, unknown>);
    if (parsed) chips.push({ field: name, state: parsed.state });
  }
  return chips;
}

export interface BuiltFilters {
  fields: Record<string, Record<string, unknown>>;
  join_filters: Array<Record<string, unknown>>;
}

export function buildFieldFilters(chips: FilterChip[], schema: Schema): BuiltFilters {
  const fields: Record<string, Record<string, unknown>> = {};
  const join_filters: Array<Record<string, unknown>> = [];
  for (const chip of chips) {
    const field = schema.fields.find(f => f.name === chip.field);
    if (!field) continue;
    const st = chip.state;
    const w = widgetForField(field);
    let filter: Record<string, unknown> | null = null;

    if (w === "enum") {
      const vals = Array.isArray(st.one_of) ? st.one_of : [];
      if (vals.length) filter = { one_of: vals };
    } else if (w === "bool") {
      if (st.eq === true || st.eq === false) filter = { eq: st.eq };
    } else if (w === "link") {
      const target = st.target as LinkTarget | null | undefined;
      if (st.exists === true || st.exists === false) filter = { exists: st.exists };
      else if (target && typeof target.id === "string") {
        join_filters.push({ rel_type: chip.field, target: { node_ids: [target.id] } });
      }
    } else if (w === "number") {
      const gte = num(st.min), lte = num(st.max);
      const f: Record<string, unknown> = {};
      if (gte !== undefined) f.gte = gte;
      if (lte !== undefined) f.lte = lte;
      if (Object.keys(f).length) filter = f;
    } else if (w === "date") {
      const f: Record<string, unknown> = {};
      if (st.gte) f.gte = st.gte;
      if (st.lte) f.lte = st.lte;
      if (Object.keys(f).length) filter = f;
    } else if (w === "tags") {
      if (st.value) filter = { includes: st.value };
    } else { // text / textarea (textarea isn't added as a chip, but be safe)
      if (st.contains) filter = { contains: st.contains };
    }

    if (filter) fields[chip.field] = filter;
  }
  return { fields, join_filters };
}

/** A join entry the link chips OWN: outgoing, single node_id, rel_type names a
 *  link-widget field on this schema, and the target has no other constraints.
 *  Everything else is "foreign" and passes through untouched on rebuilds. */
export function isChipJoin(entry: unknown, schema: Schema): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.rel_type !== "string") return false;
  if (e.direction !== undefined && e.direction !== "outgoing") return false;
  const field = schema.fields.find(f => f.name === e.rel_type);
  if (!field || widgetForField(field) !== "link") return false;
  const t = e.target;
  if (!t || typeof t !== "object") return false;
  const tk = Object.keys(t as Record<string, unknown>);
  const ids = (t as Record<string, unknown>).node_ids;
  return tk.length === 1 && Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string";
}

export function parseJoinFilters(
  joins: unknown,
  schema: Schema,
): { chips: FilterChip[]; foreign: unknown[] } {
  if (!Array.isArray(joins)) return { chips: [], foreign: [] };
  const chips: FilterChip[] = [];
  const foreign: unknown[] = [];
  for (const entry of joins) {
    if (!isChipJoin(entry, schema)) { foreign.push(entry); continue; }
    const e = entry as { rel_type: string; target: { node_ids: string[] } };
    chips.push({ field: e.rel_type, state: { exists: null, target: { id: e.target.node_ids[0]!, title: null } } });
  }
  return { chips, foreign };
}
