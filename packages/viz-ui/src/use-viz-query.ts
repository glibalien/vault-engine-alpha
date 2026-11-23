/**
 * use-viz-query.ts
 *
 * Schema-aware owned-args state hook for the viz filter UI.
 *
 * Architecture (mirrors engine's query-nodes/app.ts orchestration):
 *   1. parseArgs(spec.query) → owned state (strip + typeSelection + callerFragments)
 *   2. useVizSchema(lockedType) → schema arrives asynchronously
 *   3. promoteFragments effect: when schema arrives, promote expressible fragments
 *      to chips (idempotent; one-way: promoted fragments are consumed)
 *   4. Every setter: reduceVizQuery(state, action) → next state →
 *      onSpecChange(vizWithQuery(spec, composeFromState(next, schema)))
 *
 * The pure core (initVizQueryState / reduceVizQuery / composeFromState) is
 * exported for unit testing without a renderer.
 */
import { useState, useEffect, useRef } from "react";
import {
  parseArgs,
  composeArgs,
  promoteFragments,
  filterableFields,
  initialFilterState,
  type ComposeSource,
  type CallerFragment,
  type FilterChip,
  type StripState,
  type Schema,
  type SchemaField,
  type QueryArgs,
} from "@vault/query-core";
import { useVizSchema } from "./use-viz-schema.js";
import { vizWithQuery } from "./viz-query.js";
import { withoutColumnSort, type ServerSortKey, type VizSpec } from "./viz-spec.js";

// ===========================================================================
// Pure state types
// ===========================================================================

export interface VizQueryState {
  strip: StripState;
  typeSelection: string | null;
  lockedType: string | null;
  callerFragments: CallerFragment[];
  filtersByType: Record<string, FilterChip[]>;
}

// ===========================================================================
// Actions
// ===========================================================================

export type VizQueryAction =
  | { type: "setStrip"; strip: StripState }
  | { type: "setTypeLock"; lockedType: string | null }
  | { type: "addChip"; field: string; schemaField: SchemaField }
  | { type: "setChip"; field: string; state: Record<string, unknown> }
  | { type: "removeChip"; field: string }
  | { type: "removeFragment"; id: number }
  | { type: "promoteChips"; added: FilterChip[]; remaining: CallerFragment[] };

// ===========================================================================
// Pure core
// ===========================================================================

/**
 * Initialize VizQueryState from raw query args.
 * This is the stage-1 parse: strip + typeSelection + callerFragments.
 * filtersByType starts empty; chips are added via promoteFragments (stage 2)
 * or user interaction.
 */
export function initVizQueryState(args: QueryArgs): VizQueryState {
  const parsed = parseArgs(args);
  return {
    strip: parsed.strip,
    typeSelection: parsed.typeSelection,
    lockedType: parsed.typeSelection,  // initially same as typeSelection
    callerFragments: parsed.fragments,
    filtersByType: {},
  };
}

/**
 * Pure reducer for VizQueryState.
 * All mutations return a new state object (no mutation in place).
 */
export function reduceVizQuery(state: VizQueryState, action: VizQueryAction): VizQueryState {
  switch (action.type) {
    case "setStrip":
      return { ...state, strip: action.strip };

    case "setTypeLock": {
      const newType = action.lockedType;
      let callerFragments = state.callerFragments;

      if (newType !== null && newType !== state.lockedType) {
        // Switching to a DIFFERENT type: drop schema-scoped fragments.
        // Their field/rel_type names belong to the old type's schema.
        callerFragments = state.callerFragments.filter(f => f.scope !== "schema");
      }
      // The explicit lock supersedes the caller's types fragment — drop it.
      callerFragments = callerFragments.filter(f => f.key !== "types");

      return {
        ...state,
        typeSelection: newType,
        lockedType: newType,
        callerFragments,
      };
    }

    case "addChip": {
      const type = state.lockedType;
      if (!type) return state;
      const existing = state.filtersByType[type] ?? [];
      if (existing.some(c => c.field === action.field)) return state;  // idempotent
      return {
        ...state,
        filtersByType: {
          ...state.filtersByType,
          [type]: [...existing, { field: action.field, state: initialFilterState(action.schemaField) }],
        },
      };
    }

    case "setChip": {
      const type = state.lockedType;
      if (!type) return state;
      const existing = state.filtersByType[type] ?? [];
      return {
        ...state,
        filtersByType: {
          ...state.filtersByType,
          [type]: existing.map(c =>
            c.field === action.field ? { ...c, state: action.state } : c
          ),
        },
      };
    }

    case "removeChip": {
      const type = state.lockedType;
      if (!type) return state;
      const existing = state.filtersByType[type] ?? [];
      return {
        ...state,
        filtersByType: {
          ...state.filtersByType,
          [type]: existing.filter(c => c.field !== action.field),
        },
      };
    }

    case "removeFragment":
      return {
        ...state,
        callerFragments: state.callerFragments.filter(f => f.id !== action.id),
      };

    case "promoteChips": {
      const type = state.lockedType;
      if (!type) return state;
      const existing = state.filtersByType[type] ?? [];
      return {
        ...state,
        callerFragments: action.remaining,
        filtersByType: {
          ...state.filtersByType,
          [type]: [...existing, ...action.added],
        },
      };
    }
  }
}

/**
 * Build a ComposeSource from the current state + an optional schema for
 * the lockedType (needed for buildFieldFilters to emit chip operators).
 * Then call composeArgs to produce the full QueryArgs.
 */
export function composeFromState(state: VizQueryState, schemaForLockedType: Schema | null): QueryArgs {
  const schemaCache = new Map<string, Schema>();
  if (state.lockedType && schemaForLockedType) {
    schemaCache.set(state.lockedType, schemaForLockedType);
  }

  const src: ComposeSource = {
    strip: state.strip,
    typeSelection: state.typeSelection,
    callerFragments: state.callerFragments,
    lockedType: state.lockedType,
    filtersByType: state.filtersByType,
    schemaCache,
  };

  return composeArgs(src);
}

// ===========================================================================
// VM (returned by the hook)
// ===========================================================================

export interface VizQueryVM {
  strip: StripState;
  lockedType: string | null;
  chips: FilterChip[];
  fragments: CallerFragment[];
  setStrip(next: StripState): void;
  /** Set the view's server sort. It is the view's one sort, so it clears any table column sort. */
  setSort(sort_by: ServerSortKey, sort_order: "asc" | "desc"): void;
  setTypeLock(type: string | null): void;
  addChip(field: string): void;
  setChip(field: string, state: Record<string, unknown>): void;
  removeChip(field: string): void;
  removeFragment(id: number): void;
  addableFields: string[];
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Canonical JSON stringify with recursively sorted object keys.
 * Used to compare query objects independent of key insertion order, which
 * can differ when a value round-trips through a backend or Object.entries
 * reversal in tests.
 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>).sort();
    const pairs = sorted.map(
      k => JSON.stringify(k) + ":" + canonicalStringify((value as Record<string, unknown>)[k])
    );
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

// ===========================================================================
// Hook
// ===========================================================================

/**
 * Schema-aware owned-args state hook.
 *
 * Holds owned query state derived from spec.query (via parseArgs).
 * When useVizSchema(lockedType) resolves, runs promoteFragments once to
 * convert expressible fragments → chips (idempotent).
 * Every setter recomposes the full query and emits onSpecChange.
 */
export function useVizQuery(
  spec: VizSpec,
  onSpecChange: (next: VizSpec) => void,
): VizQueryVM {
  // Initialize from spec.query on mount (or spec change — see re-init logic below)
  const [queryState, setQueryState] = useState<VizQueryState>(() =>
    initVizQueryState(spec.query)
  );

  // Mirror the current queryState in a ref so dispatch can read the latest value
  // without a stale closure. Updated every render (before dispatch can be called).
  const queryStateRef = useRef<VizQueryState>(queryState);
  queryStateRef.current = queryState;

  // lastEmittedRef holds the CANONICAL serialization of the query we last emitted
  // via onSpecChange. When the spec prop arrives with the same canonical form we
  // emitted, we know it's our own echo and skip re-init.
  const lastEmittedRef = useRef<string>(canonicalStringify(spec.query));

  // Re-initialize state when spec.query changes from the outside (not from our
  // own onSpecChange calls). Detection uses canonical stringify so that
  // key-reordering by a backend round-trip is NOT treated as an external change.
  useEffect(() => {
    const incoming = canonicalStringify(spec.query);
    if (incoming !== lastEmittedRef.current) {
      // Genuinely different from what we last emitted → external change → re-init
      lastEmittedRef.current = incoming;
      setQueryState(initVizQueryState(spec.query));
      promotedForRef.current = null; // reset promote guard
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.query]);

  // Fetch schema for the locked type
  const schema = useVizSchema(queryState.lockedType);

  // Keep a ref to the latest schema so dispatch always uses the freshest value
  // (avoids stale-closure issues when a state update triggers a re-render before
  // the schema ref is updated).
  const schemaRef = useRef<Schema | null>(null);
  schemaRef.current = schema;

  // Guard against double-promotion: track which (type, schema) pair we've
  // already promoted. Key = "<type>@<fieldNames>" — stable for a given schema.
  const promotedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!schema || !queryState.lockedType) return;
    const key = `${queryState.lockedType}@${schema.fields.map(f => f.name).join(",")}`;
    if (promotedForRef.current === key) return;
    promotedForRef.current = key;

    const existing = queryState.filtersByType[queryState.lockedType] ?? [];
    const existingFields = new Set(existing.map(c => c.field));
    const { remaining, added } = promoteFragments(
      queryState.callerFragments,
      schema,
      existingFields,
    );
    if (added.length === 0) return;

    setQueryState(prev =>
      reduceVizQuery(prev, { type: "promoteChips", added, remaining })
    );
  }, [schema, queryState.lockedType]);
  // We deliberately omit queryState.callerFragments from deps to make promotion
  // run only when the schema arrives, not on every fragment change.
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // Helper: compute next state, emit onSpecChange, update local state.
  // Uses queryStateRef/schemaRef so dispatch always sees the latest values even
  // inside React's batched state updates (avoids stale-closure issues).
  //
  // IMPORTANT (Finding 2 fix): all side effects (onSpecChange, ref mutations)
  // are performed OUTSIDE and AFTER setQueryState. React StrictMode
  // double-invokes setState updaters to detect impurity; performing effects
  // inside the updater would double-fire onSpecChange and corrupt bookkeeping.
  // `finish` adjusts the emitted spec beyond its query (setSort drops a column sort) in the
  // same onSpecChange, so the host never sees a half-applied change.
  const dispatch = (action: VizQueryAction, finish?: (next: VizSpec) => VizSpec): void => {
    // Compute next state via the pure reducer using the ref mirror (not stale closure)
    const next = reduceVizQuery(queryStateRef.current, action);
    // Compose and emit BEFORE setQueryState so lastEmittedRef is updated before
    // any effect triggered by the state change can observe the prop.
    const composed = composeFromState(next, schemaRef.current);
    lastEmittedRef.current = canonicalStringify(composed);
    const nextSpec = vizWithQuery(spec, composed);
    onSpecChange(finish ? finish(nextSpec) : nextSpec);
    // Pure state update — no side effects inside the updater.
    setQueryState(next);
  };

  const chips = queryState.filtersByType[queryState.lockedType ?? ""] ?? [];

  // addableFields = filterableFields(schema) minus fields that already have chips
  const activeFields = new Set(chips.map(c => c.field));
  const addableFields = schema
    ? filterableFields(schema)
        .map(f => f.name)
        .filter(name => !activeFields.has(name))
    : [];

  // Find schema field for addChip (must know initialFilterState)
  const schemaFieldMap = schema
    ? new Map(schema.fields.map(f => [f.name, f]))
    : new Map<string, SchemaField>();

  return {
    strip: queryState.strip,
    lockedType: queryState.lockedType,
    chips,
    fragments: queryState.callerFragments,
    addableFields,

    setStrip(next: StripState): void {
      dispatch({ type: "setStrip", strip: next });
    },

    setSort(sort_by: ServerSortKey, sort_order: "asc" | "desc"): void {
      dispatch({ type: "setStrip", strip: { ...queryStateRef.current.strip, sort_by, sort_order } }, withoutColumnSort);
    },

    setTypeLock(type: string | null): void {
      dispatch({ type: "setTypeLock", lockedType: type });
    },

    addChip(field: string): void {
      const schemaField = schemaFieldMap.get(field);
      if (!schemaField) return;
      dispatch({ type: "addChip", field, schemaField });
    },

    setChip(field: string, state: Record<string, unknown>): void {
      dispatch({ type: "setChip", field, state });
    },

    removeChip(field: string): void {
      dispatch({ type: "removeChip", field });
    },

    removeFragment(id: number): void {
      dispatch({ type: "removeFragment", id });
    },
  };
}
