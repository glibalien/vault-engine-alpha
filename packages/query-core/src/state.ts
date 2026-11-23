/**
 * UI state factory and type-lock resolution rules.
 *
 * Type-lock resolution (per spec):
 *   1. exactly one effective type → lock to it.
 *   2. else: result rows all share types[0] → lock to it.
 *   3. else: unlocked, surface candidate list (sorted, de-duped).
 */
import type { NodeRow, QueryArgs, UiState } from "./types.js";
import { parseArgs } from "./owned-args.js";

export function createState(args: QueryArgs): UiState {
  const parsed = parseArgs(args);
  return {
    initialArgs: structuredClone(args),
    strip: parsed.strip,
    typeSelection: parsed.typeSelection,
    callerFragments: parsed.fragments,
    lockedType: null,
    schemaCache: new Map(),
    envelope: null,
    visibleColumns: null,
    availableTypes: [],

    filtersByType: {},

    values: {},
    titles: {},
    versions: {},
    staleSet: new Set(),
    staleNodes: {},
    selected: null,
    editing: null,
    pending: null,
    cellError: null,
    flash: new Set(),
    recentOps: [],
    draft: null,
    expanded: new Map(),
    bulkSelected: new Set(),
    bulk: null,

    settings: { density: "cozy", showRowNumbers: true, showVersion: true },
    busy: false,
  };
}

export type TypeLock =
  | { kind: "locked"; type: string }
  | { kind: "unlocked"; candidates: string[] };

/** Type-lock resolution. types = the EFFECTIVE types constraint (explicit
 *  selection or caller multi-types fragment — see owned-args effectiveTypes). */
export function resolveTypeLock(types: string[] | undefined, rows?: NodeRow[]): TypeLock {
  if (Array.isArray(types) && types.length === 1) {
    return { kind: "locked", type: types[0]! };
  }

  if (rows && rows.length > 0) {
    const firstTypes = rows.map(r => r.types[0]).filter((t): t is string => typeof t === "string");
    if (firstTypes.length > 0 && firstTypes.every(t => t === firstTypes[0])) {
      return { kind: "locked", type: firstTypes[0]! };
    }
    const candidates = Array.from(new Set(firstTypes)).sort();
    return { kind: "unlocked", candidates };
  }

  return { kind: "unlocked", candidates: [] };
}

/** Locate a row by node id across the main envelope and any open expansions.
 *  Replaces app.ts's main-only rowFor — sub-table rows edit like main rows. */
export function findRow(state: UiState, id: string): NodeRow | undefined {
  const main = state.envelope?.ok ? state.envelope.data.nodes.find(r => r.id === id) : undefined;
  if (main) return main;
  for (const group of state.expanded.values()) {
    const hit = group.rows.find(r => r.id === id);
    if (hit) return hit;
  }
  return undefined;
}
