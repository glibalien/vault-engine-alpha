/**
 * Refresh flow — compose the query from owned state (owned-args), re-fetch
 * query-nodes, update the state envelope, return success/failure for the
 * caller (app.ts) to decide whether to re-render.
 *
 * Augments args with include_fields: ["*"] so the table can render field
 * values inline. query-nodes omits the per-row `fields` map otherwise.
 */
import type { Client } from "../client.js";
import type { QueryArgs, UiState } from "../types.js";
import { composeArgs } from "../owned-args.js";
import { pruneBulkSelection } from "./bulk.js";

export async function refresh(state: UiState, client: Client): Promise<void> {
  // Force include_fields: ["*"] — the schema-driven table needs every field
  // value inline regardless of what the caller passed. Override (don't merge).
  const args: QueryArgs = { ...composeArgs(state), include_fields: ["*"] };
  const env = await client.queryNodes(args);
  state.envelope = env;

  // On a SUCCESSFUL refetch the fresh rows are authoritative, so the per-id
  // live overlays (committed values/titles/versions) and stale markers that
  // were shadowing them are now wrong: keeping them would make the table send
  // an outdated expected_version on the next edit → spurious STALE_NODE, which
  // is exactly the failure a manual Refresh is supposed to recover from.
  // Clear them (and the transient edit pointers a refetch invalidates) so the
  // table renders straight from the fresh envelope. recentOps (undo history) is
  // intentionally cross-refetch and is left untouched. On a FAILED refetch we
  // keep existing state so the user doesn't lose their in-flight context.
  if (env.ok) {
    state.values = {};
    state.versions = {};
    state.titles = {};
    state.staleSet = new Set();
    state.staleNodes = {};
    state.flash = new Set();

    state.selected = null;
    state.editing = null;
    state.pending = null;
    state.cellError = null;
    // Any requery (type-lock change, filter apply, manual refresh) abandons an
    // in-progress draft — the locked schema / column model may have changed.
    state.draft = null;

    // Prune bulkSelected to ids still present in the fresh envelope.
    // (bulkSelected is PRUNED, not cleared — surviving selections remain.)
    pruneBulkSelection(state);
    // A refetch invalidates any open dry-run result — clear pending/failed
    // but leave the plan so the user can re-apply without re-picking the op.
    if (state.bulk) state.bulk = { ...state.bulk, pending: null, failed: null, busy: false };
  }
}
