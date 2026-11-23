/**
 * useVizExpand — sub-table expansion hook for the VizTable.
 *
 * Ports the imperative flows/expand.ts orchestration as a React hook,
 * REUSING the pure logic already extracted into query-core:
 *   - expansionPairs(lockedType, schemas): ExpandPair[]
 *   - childQueryArgs(pair, parentId): QueryArgs (EXPAND_LIMIT consumed transitively via childQueryArgs)
 *
 * The imperative toggleExpand / reconcileExpansions are re-implemented
 * here as an immutable reducer (same semantics, React-style).
 *
 * Re-entry guard: a Set<string> of in-flight parentIds prevents concurrent
 * double-expands of the same parent from racing; concurrent expands of
 * DIFFERENT parents both proceed normally.
 */
import { useCallback, useMemo, useReducer, useRef } from "react";
import { expansionPairs, childQueryArgs } from "@vault/query-core";
import { claimedFields, isReferenceField } from "@vault/query-core";
import type { Client } from "@vault/query-core";
import type { ExpandPair, ExpandedGroup, NodeRow, Schema } from "@vault/query-core";
import type { VizRow } from "./viz-spec.js";

// ============================================================================
// Public helpers (exported for direct unit testing)
// ============================================================================

/**
 * Convert a query-core NodeRow to a VizRow, applying defaults for missing fields.
 * title: null → ''; fields: undefined → {}
 */
export function nodeRowToVizRow(n: NodeRow): VizRow {
  return {
    id: n.id,
    title: n.title ?? "",
    file_path: n.file_path,
    types: n.types,
    fields: n.fields ?? {},
    version: n.version,
  };
}

/**
 * The first 5 claimed field names for a child schema — used as default display columns.
 */
export function childDisplayFields(schema: Schema): string[] {
  return claimedFields(schema).map((f) => f.name).slice(0, 5);
}

/**
 * Set of reference field names for a child schema — used to identity ref cells.
 */
export function childRefFields(schema: Schema): Set<string> {
  return new Set(schema.fields.filter(isReferenceField).map((f) => f.name));
}

// ============================================================================
// Public API surface
// ============================================================================

export interface VizExpandAPI {
  expanded: Map<string, ExpandedGroup>;
  pairs: ExpandPair[];
  hasCaret: boolean;
  expandMenuFor: string | null;
  isOpen(parentId: string): boolean;
  caretClick(parentId: string): void;
  toggle(parentId: string, pair: ExpandPair): Promise<void>;
  closeMenu(): void;
  reconcile(liveRows: VizRow[]): Promise<void>;
  collapseAll(): void;
}

// ============================================================================
// Reducer state + actions (exported for direct unit testing)
// ============================================================================

export interface ExpandReducerState {
  expanded: Map<string, ExpandedGroup>;
  expandMenuFor: string | null;
}

export type ExpandAction =
  | { type: "SET_GROUP"; parentId: string; group: ExpandedGroup }
  | { type: "DELETE_GROUP"; parentId: string }
  | { type: "CLEAR" }
  | { type: "OPEN_MENU"; parentId: string }
  | { type: "CLOSE_MENU" };

function initialState(): ExpandReducerState {
  return {
    expanded: new Map(),
    expandMenuFor: null,
  };
}

/**
 * reduceExpand — pure state machine for sub-table expansion.
 * Each action that mutates `expanded` returns a NEW Map to ensure
 * React detects the change via reference equality.
 */
export function reduceExpand(state: ExpandReducerState, action: ExpandAction): ExpandReducerState {
  switch (action.type) {
    case "SET_GROUP": {
      const next = new Map(state.expanded);
      next.set(action.parentId, action.group);
      return { ...state, expanded: next };
    }

    case "DELETE_GROUP": {
      if (!state.expanded.has(action.parentId)) return state;
      const next = new Map(state.expanded);
      next.delete(action.parentId);
      return { ...state, expanded: next };
    }

    case "CLEAR":
      return { ...state, expanded: new Map() };

    case "OPEN_MENU":
      return { ...state, expandMenuFor: action.parentId };

    case "CLOSE_MENU":
      return { ...state, expandMenuFor: null };
  }
}

// ============================================================================
// useVizExpand hook
// ============================================================================

export function useVizExpand(
  client: Client,
  allSchemas: Map<string, Schema>,
  lockedType: string,
): VizExpandAPI {
  const [state, dispatch] = useReducer(reduceExpand, undefined, initialState);

  // Stable ref so async closures see the latest state
  const stateRef = useRef(state);
  stateRef.current = state;

  // Per-parent in-flight guard: prevents same parent from being double-expanded concurrently
  const inFlightRef = useRef(new Set<string>());

  // pairs and hasCaret are pure derivations; memoize on lockedType + allSchemas identity
  const pairs = useMemo<ExpandPair[]>(
    () => (lockedType !== "" ? expansionPairs(lockedType, allSchemas.values()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lockedType, allSchemas],
  );

  const hasCaret = lockedType !== "" && pairs.length > 0;

  // ---- toggle (expand / collapse-same / swap) ----

  const toggle = useCallback(
    async (parentId: string, pair: ExpandPair): Promise<void> => {
      // Re-entry guard: ignore if this parent's fetch is already in flight
      if (inFlightRef.current.has(parentId)) return;

      const current = stateRef.current.expanded.get(parentId);

      // Collapse: same pair → delete and return (collapse discards; re-expand re-queries)
      if (current && current.childType === pair.childType && current.viaField === pair.viaField) {
        dispatch({ type: "DELETE_GROUP", parentId });
        return;
      }

      // Close menu when toggling (a toggle always resolves any open menu)
      dispatch({ type: "CLOSE_MENU" });

      // Set busy placeholder before fetch
      dispatch({
        type: "SET_GROUP",
        parentId,
        group: {
          childType: pair.childType,
          viaField: pair.viaField,
          rows: [],
          total: 0,
          busy: true,
          unresolvedWarning: false,
        },
      });

      inFlightRef.current.add(parentId);
      try {
        const env = await client.queryNodes(childQueryArgs(pair, parentId));
        if (env.ok) {
          dispatch({
            type: "SET_GROUP",
            parentId,
            group: {
              childType: pair.childType,
              viaField: pair.viaField,
              rows: env.data.nodes,
              total: env.data.total,
              busy: false,
              unresolvedWarning: env.warnings.some((w) => w.code === "CROSS_NODE_FILTER_UNRESOLVED"),
            },
          });
        } else {
          dispatch({ type: "DELETE_GROUP", parentId });
        }
      } finally {
        inFlightRef.current.delete(parentId);
      }
    },
    [client],
  );

  // ---- caretClick ----

  const caretClick = useCallback(
    (parentId: string): void => {
      const { expanded } = stateRef.current;
      const current = expanded.get(parentId);

      if (current !== undefined) {
        // Already open → collapse using the currently-open group's pair.
        // Reconstruct the pair from the OPEN group, not pairs[0], so a swapped-open
        // sub-table collapses the pair that's actually showing.
        void toggle(parentId, { childType: current.childType, viaField: current.viaField });
        return;
      }

      if (pairs.length === 1) {
        void toggle(parentId, pairs[0]);
      } else {
        // > 1 pairs → open the type-picker menu (no fetch yet)
        dispatch({ type: "OPEN_MENU", parentId });
      }
    },
    [toggle, pairs],
  );

  // ---- closeMenu ----

  const closeMenu = useCallback((): void => {
    dispatch({ type: "CLOSE_MENU" });
  }, []);

  // ---- collapseAll ----

  const collapseAll = useCallback((): void => {
    dispatch({ type: "CLEAR" });
  }, []);

  // ---- reconcile ----

  const reconcile = useCallback(
    async (liveRows: VizRow[]): Promise<void> => {
      if (stateRef.current.expanded.size === 0) return;

      const liveIds = new Set(liveRows.map((r) => r.id));

      // Drop parents that are no longer in the live result set
      for (const parentId of [...stateRef.current.expanded.keys()]) {
        if (!liveIds.has(parentId)) {
          dispatch({ type: "DELETE_GROUP", parentId });
        }
      }

      // Re-query surviving parents (their children may have changed)
      const survivors = [...stateRef.current.expanded.entries()].filter(([id]) => liveIds.has(id));

      if (survivors.length === 0) return;

      await Promise.all(
        survivors.map(async ([parentId, g]) => {
          const pair: ExpandPair = { childType: g.childType, viaField: g.viaField };
          const env = await client.queryNodes(childQueryArgs(pair, parentId));
          if (env.ok) {
            dispatch({
              type: "SET_GROUP",
              parentId,
              group: {
                childType: pair.childType,
                viaField: pair.viaField,
                rows: env.data.nodes,
                total: env.data.total,
                busy: false,
                unresolvedWarning: env.warnings.some((w) => w.code === "CROSS_NODE_FILTER_UNRESOLVED"),
              },
            });
          } else {
            dispatch({ type: "DELETE_GROUP", parentId });
          }
        }),
      );
    },
    [client],
  );

  // ---- Return API ----

  return {
    expanded: state.expanded,
    pairs,
    hasCaret,
    expandMenuFor: state.expandMenuFor,
    isOpen: (parentId: string) => state.expanded.has(parentId),
    caretClick,
    toggle,
    closeMenu,
    reconcile,
    collapseAll,
  };
}
