/**
 * B4 — sub-table expansion via query-nodes join_filters (NOT get-node expand:
 * expand's rows carry no version/file_path, which editing needs).
 * Discovery is schema-driven: a (childType, viaField) pair exists when
 * childType claims a reference / list-of-reference field whose advisory
 * reference_target names the locked type. Depth 1; collapse discards.
 */
import type { Client } from "../client.js";
import type { ExpandPair, ExpandedGroup, QueryArgs, Schema, UiState } from "../types.js";

export const EXPAND_LIMIT = 25;

export function expansionPairs(lockedType: string, schemas: Iterable<Schema>): ExpandPair[] {
  const pairs: ExpandPair[] = [];
  for (const s of schemas) {
    for (const f of s.fields) {
      const isRef = f.type === "reference" || (f.type === "list" && f.list_item_type === "reference");
      if (isRef && f.reference_target === lockedType) pairs.push({ childType: s.name, viaField: f.name });
    }
  }
  return pairs.sort((a, b) =>
    a.childType.localeCompare(b.childType) || a.viaField.localeCompare(b.viaField));
}

export function childQueryArgs(pair: ExpandPair, parentId: string): QueryArgs {
  return {
    types: [pair.childType],
    join_filters: [{ rel_type: pair.viaField, target: { node_ids: [parentId] } }],
    include_fields: ["*"],
    sort_by: "file_mtime",
    sort_order: "desc",
    limit: EXPAND_LIMIT,
  };
}

async function fetchGroup(client: Client, pair: ExpandPair, parentId: string): Promise<ExpandedGroup | null> {
  const env = await client.queryNodes(childQueryArgs(pair, parentId));
  if (!env.ok) return null;
  return {
    childType: pair.childType,
    viaField: pair.viaField,
    rows: env.data.nodes,
    total: env.data.total,
    busy: false,
    unresolvedWarning: env.warnings.some(w => w.code === "CROSS_NODE_FILTER_UNRESOLVED"),
  };
}

/** Expand, collapse (same pair), or swap (different pair) a parent's sub-table. */
export async function toggleExpand(state: UiState, client: Client, parentId: string, pair: ExpandPair): Promise<void> {
  const current = state.expanded.get(parentId);
  if (current && current.childType === pair.childType && current.viaField === pair.viaField) {
    state.expanded.delete(parentId); // collapse discards; re-expand re-queries (always-fresh)
    return;
  }
  state.expanded.set(parentId, {
    childType: pair.childType, viaField: pair.viaField,
    rows: [], total: 0, busy: true, unresolvedWarning: false,
  });
  const group = await fetchGroup(client, pair, parentId);
  if (group) state.expanded.set(parentId, group);
  else state.expanded.delete(parentId);
}

export function collapseAll(state: UiState): void {
  state.expanded.clear();
}

/** After an authoritative refetch: drop expansions whose parent vanished from
 *  the result set, re-query the survivors (their children may have changed). */
export async function reconcileExpansions(state: UiState, client: Client): Promise<void> {
  if (state.expanded.size === 0) return;
  const liveIds = new Set(state.envelope?.ok ? state.envelope.data.nodes.map(r => r.id) : []);
  const entries = [...state.expanded.entries()];
  for (const [parentId] of entries) {
    if (!liveIds.has(parentId)) state.expanded.delete(parentId);
  }
  await Promise.all(
    [...state.expanded.entries()].map(async ([parentId, g]) => {
      const group = await fetchGroup(client, { childType: g.childType, viaField: g.viaField }, parentId);
      if (group) state.expanded.set(parentId, group);
      else state.expanded.delete(parentId);
    }),
  );
}
