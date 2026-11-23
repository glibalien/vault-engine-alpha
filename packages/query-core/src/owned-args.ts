/**
 * Owned-args — the query-nodes UI's single source of query truth.
 *
 * Every incoming tool arg parses into owned state (parseArgs), every refetch
 * recomposes the query from it (composeArgs). Nothing passes through opaquely:
 * args the UI can't natively edit ride along verbatim as CallerFragments,
 * rendered as removable caller chips. Round-trip invariant (pinned by tests):
 * composeArgs(parseArgs(args)) is semantically identical to the original args,
 * modulo strip defaults materializing and include_fields (refresh overrides).
 *
 * Spec: docs/superpowers/specs/2026-06-12-caller-filter-visibility-design.md
 */
import type {
  CallerFragment, FilterChip, QueryArgs, Schema, StripState,
} from "./types.js";
import { buildFieldFilters, isChipJoin, parseFieldFilterOps } from "./filters.js";
import { isServerSortBy, linkCountsArg, linkCountsLabel, parseLinkCountRules } from "./link-counts.js";

export interface ParsedArgs {
  strip: StripState;
  typeSelection: string | null;
  fragments: CallerFragment[];
}

/** The slice of UiState compose reads — UiState satisfies it structurally. */
export interface ComposeSource {
  strip: StripState;
  typeSelection: string | null;
  callerFragments: CallerFragment[];
  lockedType: string | null;
  filtersByType: Record<string, FilterChip[]>;
  schemaCache: Map<string, Schema>;
}

/** Keys that fragment per array element (each gets its own caller chip). */
const ARRAY_ELEMENT_KEYS = new Set([
  "join_filters", "without_joins", "without_types", "without_titles", "without_fields",
]);
/** Fragments whose names reference the locked type's schema — dropped on a
 *  switch to a DIFFERENT type. Everything else is global and survives. */
const SCHEMA_SCOPED_KEYS = new Set(["join_filters", "without_joins", "fields", "without_fields"]);

function scopeFor(key: string): CallerFragment["scope"] {
  return SCHEMA_SCOPED_KEYS.has(key) ? "schema" : "global";
}

// ---- parse (stage 1: mount/reset, schema-free) ------------------------------

export function parseArgs(args: QueryArgs): ParsedArgs {
  const strip: StripState = { title_contains: "", query: "", sort_by: "title", sort_order: "asc", limit: 50 };
  if (typeof args.title_contains === "string") strip.title_contains = args.title_contains;
  if (typeof args.query === "string") strip.query = args.query;
  if (isServerSortBy(args.sort_by)) strip.sort_by = args.sort_by;
  if (args.sort_order === "asc" || args.sort_order === "desc") strip.sort_order = args.sort_order;
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) strip.limit = args.limit;

  let typeSelection: string | null = null;
  const fragments: CallerFragment[] = [];
  let nextId = 0;
  const push = (key: string, payload: unknown, fieldName?: string): void => {
    fragments.push({
      // structuredClone at both boundaries (here and compose emission) keeps
      // fragments self-contained: callers may mutate their args object, and
      // consumers may mutate composed output, without corrupting owned state.
      id: nextId++, key, payload: structuredClone(payload), scope: scopeFor(key),
      ...(fieldName !== undefined ? { fieldName } : {}),
    });
  };

  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue;
    switch (key) {
      case "title_contains": case "query": case "sort_by": case "sort_order": case "limit":
      case "include_fields": // refresh force-overrides it — carrying it would lie
        break;
      case "offset":
        if (typeof value === "number" && value !== 0) push(key, value);
        break;
      case "types": {
        if (!Array.isArray(value) || value.length === 0) break;
        if (value.length === 1 && typeof value[0] === "string" && value[0] !== "") typeSelection = value[0];
        else push("types", value);
        break;
      }
      case "join_filters": case "without_joins":
      case "without_types": case "without_titles": case "without_fields": {
        if (!Array.isArray(value)) break;
        for (const entry of value) push(key, entry);
        break;
      }
      case "link_counts": {
        // Rules the Filter menu can edit join the strip; anything else stays a caller chip.
        const rules = parseLinkCountRules(value);
        if (rules) strip.link_counts = rules;
        else push(key, value);
        break;
      }
      case "fields": {
        if (typeof value !== "object") break;
        for (const [name, ops] of Object.entries(value as Record<string, unknown>)) push("fields", ops, name);
        break;
      }
      default:
        push(key, value); // node_ids / path_* / scalars / references / unknown future keys
    }
  }
  return { strip, typeSelection, fragments };
}

/** The types constraint the query/lock actually sees: explicit selection wins,
 *  else a caller multi-types fragment, else nothing. */
export function effectiveTypes(
  src: Pick<ComposeSource, "typeSelection" | "callerFragments">,
): string[] | undefined {
  if (src.typeSelection) return [src.typeSelection];
  const frag = src.callerFragments.find(f => f.key === "types");
  return frag ? structuredClone(frag.payload as string[]) : undefined;
}

// ---- compose ----------------------------------------------------------------

export function composeArgs(src: ComposeSource): QueryArgs {
  const args: QueryArgs = {
    sort_by: src.strip.sort_by,
    sort_order: src.strip.sort_order,
    limit: src.strip.limit,
  };
  if (src.strip.title_contains) args.title_contains = src.strip.title_contains;
  if (src.strip.query) args.query = src.strip.query;
  const linkCounts = linkCountsArg(src.strip.link_counts);
  if (linkCounts) args.link_counts = linkCounts;

  const types = effectiveTypes(src);
  if (types) args.types = types;

  // Chip-owned filters — only meaningful under a locked schema.
  const fields: Record<string, Record<string, unknown>> = {};
  const joins: unknown[] = [];
  if (src.lockedType) {
    const schema = src.schemaCache.get(src.lockedType);
    const chips = src.filtersByType[src.lockedType] ?? [];
    if (schema && chips.length) {
      const built = buildFieldFilters(chips, schema);
      Object.assign(fields, built.fields);
      joins.push(...built.join_filters);
    }
  }

  for (const f of src.callerFragments) {
    if (f.key === "types") continue; // handled by effectiveTypes
    const payload = structuredClone(f.payload);
    if (f.key === "fields" && f.fieldName) {
      // Remainder ops merge under the field name; a chip-owned op wins the
      // (by-construction unreachable) collision — deterministic either way.
      fields[f.fieldName] = { ...(payload as Record<string, unknown>), ...(fields[f.fieldName] ?? {}) };
      continue;
    }
    if (f.key === "join_filters") { joins.push(payload); continue; }
    if (ARRAY_ELEMENT_KEYS.has(f.key)) {
      const arr = (args[f.key] as unknown[] | undefined) ?? [];
      arr.push(payload);
      args[f.key] = arr;
      continue;
    }
    args[f.key] = payload; // whole-payload keys (node_ids, scalars, unknown)
  }

  if (Object.keys(fields).length) args.fields = fields;
  if (joins.length) args.join_filters = joins;
  return args;
}

// ---- promote (stage 2: schema arrived) ---------------------------------------

/** Promote chip-expressible fragments into schema chips for the locked type.
 *  Consumes promoted fragments; splits fields fragments into chip + remainder.
 *  existingChipFields blocks promotion onto a field that already has a chip
 *  (the fragment is kept verbatim — no silent loss, no double chip). */
export function promoteFragments(
  fragments: CallerFragment[],
  schema: Schema,
  existingChipFields: ReadonlySet<string>,
): { remaining: CallerFragment[]; added: FilterChip[] } {
  const remaining: CallerFragment[] = [];
  const added: FilterChip[] = [];
  const taken = new Set(existingChipFields);

  for (const f of fragments) {
    if (f.key === "fields" && f.fieldName && !taken.has(f.fieldName)) {
      const field = schema.fields.find(sf => sf.name === f.fieldName);
      const ops = f.payload && typeof f.payload === "object" ? (f.payload as Record<string, unknown>) : null;
      const parsed = field && ops ? parseFieldFilterOps(field, ops) : null;
      if (parsed) {
        added.push({ field: f.fieldName, state: parsed.state });
        taken.add(f.fieldName);
        const leftover: Record<string, unknown> = {};
        for (const [op, v] of Object.entries(ops!)) {
          if (!parsed.consumed.includes(op)) leftover[op] = v;
        }
        if (Object.keys(leftover).length) remaining.push({ ...f, payload: leftover });
        continue;
      }
    }
    if (f.key === "join_filters" && isChipJoin(f.payload, schema)) {
      const e = f.payload as { rel_type: string; target: { node_ids: string[] } };
      if (!taken.has(e.rel_type)) {
        added.push({ field: e.rel_type, state: { exists: null, target: { id: e.target.node_ids[0]!, title: null } } });
        taken.add(e.rel_type);
        continue;
      }
    }
    remaining.push(f);
  }
  return { remaining, added };
}

// ---- summarize (chip labels) --------------------------------------------------

const OP_SYMBOLS: Record<string, string> = {
  eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "~", includes: "has",
};

function compactValue(v: unknown): string {
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return v.length <= 3 ? v.map(compactValue).join(", ") : `${v.length} items`;
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function fieldOpsLabel(name: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return `${name}: ${compactValue(payload)}`;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 1) {
    const [op, v] = entries[0]!;
    if (op === "one_of" && Array.isArray(v)) return `${name} in [${v.map(compactValue).join(", ")}]`;
    if (op === "exists") return v ? `${name} set` : `${name} empty`;
    const sym = OP_SYMBOLS[op];
    if (sym) return `${name} ${sym} ${compactValue(v)}`;
  }
  return `${name}: {…}`;
}

function targetSummary(target: unknown): string {
  if (!target || typeof target !== "object" || Object.keys(target as object).length === 0) return "any";
  const t = target as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof t.title_contains === "string") parts.push(`title ~ "${t.title_contains}"`);
  if (typeof t.title_eq === "string") parts.push(`title = "${t.title_eq}"`);
  if (Array.isArray(t.types)) parts.push(`type ${(t.types as string[]).join("∣")}`);
  if (Array.isArray(t.node_ids)) parts.push(t.node_ids.length === 1 ? "1 node" : `${t.node_ids.length} nodes`);
  if (t.fields && typeof t.fields === "object") {
    for (const [name, ops] of Object.entries(t.fields as Record<string, unknown>)) {
      parts.push(fieldOpsLabel(name, ops));
    }
  }
  const known = new Set(["title_contains", "title_eq", "types", "node_ids", "fields"]);
  for (const [k, v] of Object.entries(t)) {
    if (!known.has(k)) parts.push(`${k}: ${compactValue(v)}`);
  }
  return truncate(parts.join(", "), 40);
}

function joinLabel(payload: unknown, negated: boolean): string {
  const e = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const rel = Array.isArray(e.rel_type) ? (e.rel_type as string[]).join("∣")
    : typeof e.rel_type === "string" ? e.rel_type : "any";
  const dir = e.direction === "incoming" ? "in: " : "";
  return `${negated ? "−join: " : ""}${dir}${rel} → ${targetSummary(e.target)}`;
}

/** Compact chip label + full-JSON tooltip for one fragment. Labels are derived
 *  at render time (never stored) so they can't go stale. */
export function summarizeFragment(f: CallerFragment): { label: string; tooltip: string } {
  const tooltip = JSON.stringify(
    f.fieldName ? { fields: { [f.fieldName]: f.payload } } : { [f.key]: f.payload },
    null, 1,
  );
  let label: string;
  switch (f.key) {
    case "join_filters": label = joinLabel(f.payload, false); break;
    case "without_joins": label = joinLabel(f.payload, true); break;
    case "path_dir": {
      const v = String(f.payload);
      label = `dir: ${v.endsWith("/") ? v : v + "/"}`;
      break;
    }
    case "path_prefix": label = `path: ${String(f.payload)}…`; break;
    case "without_path_prefix": label = `−path: ${String(f.payload)}…`; break;
    case "without_types": label = `−type: ${String(f.payload)}`; break;
    case "without_fields": label = `−field: ${String(f.payload)}`; break;
    case "title_eq": label = `title = "${String(f.payload)}"`; break;
    case "without_titles": label = `−title: "${String(f.payload)}"`; break;
    case "modified_since": label = `since: ${String(f.payload)}`; break;
    case "link_counts": label = linkCountsLabel(f.payload); break;
    case "node_ids": {
      const n = Array.isArray(f.payload) ? f.payload.length : 1;
      label = n === 1 ? "1 pinned node" : `${n} pinned nodes`;
      break;
    }
    case "without_node_ids": {
      const n = Array.isArray(f.payload) ? f.payload.length : 1;
      label = `−${n} node${n === 1 ? "" : "s"}`;
      break;
    }
    case "types": label = `type: ${(f.payload as string[]).join(" ∣ ")}`; break;
    case "offset": label = `offset: ${String(f.payload)}`; break;
    case "references": {
      const r = (f.payload && typeof f.payload === "object" ? f.payload : {}) as Record<string, unknown>;
      label = `ref: ${typeof r.rel_type === "string" ? r.rel_type : "any"} → "${String(r.target ?? "")}"`;
      break;
    }
    case "fields": label = fieldOpsLabel(f.fieldName ?? "?", f.payload); break;
    default: label = `${f.key}: ${truncate(JSON.stringify(f.payload) ?? String(f.payload), 30)}`;
  }
  return { label: truncate(label, 60), tooltip };
}
