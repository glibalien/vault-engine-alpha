/**
 * B5b — bulk row-select → batch edit over batch-mutate.
 * Engine realities (spec §B5b): batch-mutate is ONE transaction — any
 * validation failure rolls back every op (BATCH_FAILED + failed_at); the one
 * tolerated per-op failure is stale (status:"stale" + continue). dry_run
 * defaults FALSE on this tool — always pass it explicitly. Warnings are
 * batch-level (not per-op). No rename path (title never bulk-set).
 */
import type { Client } from "../client.js";
import type {
  BatchCommitData, BatchDryRunData, BatchOp, BatchResult, BulkPlan, Envelope, Issue, UiState,
} from "../types.js";
import { TITLE_FIELD } from "../types.js";

export function buildBulkOps(plan: BulkPlan, rows: Array<{ id: string; version: number }>): BatchOp[] {
  return rows.map(({ id, version }) => {
    const params: BatchOp["params"] = { node_id: id, expected_version: version };
    if (plan.kind === "setField") params.set_fields = { [plan.field]: plan.value };
    else if (plan.kind === "addType") params.add_types = [plan.type];
    else params.remove_types = [plan.type];
    return { op: "update", params };
  });
}

export type BulkDryDecision =
  | { kind: "confirm"; wouldApply: number; warnings: Issue[] }
  | { kind: "failed"; nodeId: string | null; message: string };

export function decideBulkDry(env: Envelope<BatchDryRunData>, ops: BatchOp[] = []): BulkDryDecision {
  if (!env.ok) {
    const at = (env.error.details as { failed_at?: number } | undefined)?.failed_at;
    return { kind: "failed", nodeId: at != null ? ops[at]?.params.node_id ?? null : null, message: env.error.message };
  }
  if (env.data.failed_at != null) {
    return {
      kind: "failed",
      nodeId: ops[env.data.failed_at]?.params.node_id ?? null,
      message: env.data.message ?? "Dry run failed.",
    };
  }
  return { kind: "confirm", wouldApply: env.data.would_apply.length, warnings: env.warnings };
}

/** Per-row outcomes → overlays. Applied rows get version (+ field value for
 *  setField plans) overlays and a flash; stale rows join the stale-bar set. */
export function applyBulkResults(
  state: UiState,
  plan: BulkPlan,
  results: BatchResult[],
): { applied: number; stale: string[] } {
  let applied = 0;
  const stale: string[] = [];
  for (const r of results) {
    if (!r.node_id) continue;
    if (r.status === "applied") {
      applied++;
      if (r.new_version != null) state.versions[r.node_id] = r.new_version;
      if (plan.kind === "setField") {
        (state.values[r.node_id] ??= {})[plan.field] = plan.value;
        state.flash.add(`${r.node_id}:${plan.field}`);
      } else {
        state.flash.add(`${r.node_id}:${TITLE_FIELD}`);
      }
    } else {
      stale.push(r.node_id);
      state.staleSet.add(r.node_id);
      if (r.details?.current_node) state.staleNodes[r.node_id] = r.details.current_node;
    }
  }
  return { applied, stale };
}

/** Inverse ops from pre-apply row state, pinned to the post-apply versions. */
export function buildInverseOps(
  plan: BulkPlan,
  rows: Array<{ id: string; prior: { value?: unknown }; newVersion: number }>,
): BatchOp[] {
  return rows.map(({ id, prior, newVersion }) => {
    const params: BatchOp["params"] = { node_id: id, expected_version: newVersion };
    if (plan.kind === "setField") params.set_fields = { [plan.field]: prior.value ?? null };
    else if (plan.kind === "addType") params.remove_types = [plan.type];
    else params.add_types = [plan.type];
    return { op: "update", params };
  });
}

/** Selection only ever references rows the user can see. */
export function pruneBulkSelection(state: UiState): void {
  if (state.bulkSelected.size === 0) return;
  const live = new Set(state.envelope?.ok ? state.envelope.data.nodes.map(n => n.id) : []);
  state.bulkSelected = new Set([...state.bulkSelected].filter(id => live.has(id)));
}

/** Rows for the current selection with their LIVE versions (overlay wins). */
function selectedRows(state: UiState): Array<{ id: string; version: number }> {
  const rows: Array<{ id: string; version: number }> = [];
  if (!state.envelope?.ok) return rows;
  for (const n of state.envelope.data.nodes) {
    if (state.bulkSelected.has(n.id)) rows.push({ id: n.id, version: state.versions[n.id] ?? n.version });
  }
  return rows;
}

/** Capture each selected row's prior value for the inverse (setField only). */
function priorValues(state: UiState, field: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!state.envelope?.ok) return out;
  for (const n of state.envelope.data.nodes) {
    if (!state.bulkSelected.has(n.id)) continue;
    const overlay = state.values[n.id];
    out.set(n.id, overlay && field in overlay ? overlay[field] : n.fields?.[field] ?? null);
  }
  return out;
}

export async function runBulkDry(state: UiState, client: Client): Promise<void> {
  const b = state.bulk;
  if (!b?.plan || b.busy) return;
  const ops = buildBulkOps(b.plan, selectedRows(state));
  if (ops.length === 0) return;
  b.busy = true;
  const env = await client.batchMutate({ operations: ops, dry_run: true });
  b.busy = false;
  const d = decideBulkDry(env as Envelope<BatchDryRunData>, ops);
  if (d.kind === "confirm") { b.pending = { wouldApply: d.wouldApply, warnings: d.warnings }; b.failed = null; }
  else { b.failed = { nodeId: d.nodeId, message: d.message }; b.pending = null; }
}

export interface BulkCommitOutcome { kind: "done" | "failed" | "noop"; applied?: number; stale?: number; }

export async function runBulkCommit(state: UiState, client: Client): Promise<BulkCommitOutcome> {
  const b = state.bulk;
  if (!b?.plan || !b.pending || b.busy) return { kind: "noop" };
  const plan = b.plan;
  const rows = selectedRows(state);
  const ops = buildBulkOps(plan, rows);
  const prior = plan.kind === "setField" ? priorValues(state, plan.field) : new Map<string, unknown>();
  b.busy = true;
  const env = await client.batchMutate({ operations: ops, dry_run: false });
  b.busy = false;
  if (!env.ok) {
    const at = (env.error.details as { failed_at?: number } | undefined)?.failed_at;
    b.failed = { nodeId: at != null ? ops[at]?.params.node_id ?? null : null, message: env.error.message };
    b.pending = null;
    return { kind: "failed" };
  }
  const results = (env.data as BatchCommitData).results;
  const { applied, stale } = applyBulkResults(state, plan, results);
  // Inverse ops only for rows that actually applied.
  const inverseRows = results
    .filter(r => r.status === "applied" && r.node_id && r.new_version != null)
    .map(r => ({ id: r.node_id!, prior: { value: prior.get(r.node_id!) }, newVersion: r.new_version! }));
  if (inverseRows.length) {
    state.recentOps.push({
      kind: "bulk",
      label: `bulk ${planSummary(plan)} ×${inverseRows.length}`,
      inverse: buildInverseOps(plan, inverseRows),
    });
  }
  state.bulkSelected.clear();
  state.bulk = null;
  return { kind: "done", applied, stale: stale.length };
}

function planSummary(plan: BulkPlan): string {
  return plan.kind === "setField" ? `set ${plan.field}` : plan.kind === "addType" ? `+${plan.type}` : `−${plan.type}`;
}
