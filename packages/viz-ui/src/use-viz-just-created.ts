/**
 * useVizJustCreated — keep just-created rows visible on a filtered viz card.
 *
 * A node created in a filtered card may not match the active filter, so the
 * post-create refetch (or the 30s poll) would drop it. This hook pins created
 * rows into the displayed set until the query identity changes (a deliberate
 * re-filter), surviving refetches and polls. mergeJustCreated merges the pins
 * with the live query rows (query wins on id collision) and reports which
 * pinned rows are out-of-filter (for the "just added" cue).
 */
import { useCallback, useState } from "react";
import type { VizRow } from "./viz-spec.js";

export function useVizJustCreated(queryKey: string): {
  pinnedRows: VizRow[];
  add: (row: VizRow) => void;
} {
  const [pinnedRows, setPinnedRows] = useState<VizRow[]>([]);
  // Reset-state-on-prop-change pattern: clear pins synchronously when the query
  // identity changes, without an extra render/flash.
  const [prevKey, setPrevKey] = useState(queryKey);
  if (queryKey !== prevKey) {
    setPrevKey(queryKey);
    setPinnedRows([]);
  }

  const add = useCallback((row: VizRow) => {
    setPinnedRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]));
  }, []);

  return { pinnedRows, add };
}

export function mergeJustCreated(
  queryRows: VizRow[],
  pinnedRows: VizRow[],
): { rows: VizRow[]; justAddedIds: Set<string> } {
  const queryIds = new Set(queryRows.map((r) => r.id));
  const extras = pinnedRows.filter((r) => !queryIds.has(r.id));
  return { rows: [...queryRows, ...extras], justAddedIds: new Set(extras.map((r) => r.id)) };
}
