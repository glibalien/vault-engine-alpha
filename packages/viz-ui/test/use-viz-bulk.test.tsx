// @vitest-environment jsdom
/**
 * use-viz-bulk.test.tsx
 *
 * TDD tests for the useVizBulk hook — selection + batch-mutate orchestration.
 * Tests are written BEFORE the implementation; they must be RED initially.
 *
 * Mutation-safety invariants pinned by these tests:
 *  BULK-INV-1: dry-run BEFORE commit — runDry → batchMutate(dry_run:true) → decideBulkDry →
 *              pending or failed. NEVER commit without the dry-run+decide.
 *  BULK-INV-2: decideBulkDry "confirm" → set pending (NOT committed). Commit only in confirm().
 *  BULK-INV-3: decideBulkDry "failed" → set failed, do NOT commit.
 *  BULK-INV-4: buildBulkOps carries expected_version from each row's version on every op.
 *  BULK-INV-5: confirm() → batchMutate(dry_run:false) → parse BatchResult[] → outcome{applied,stale}
 *              → onAfterCommit → clear().
 *  BULK-INV-6: busy GUARDS re-entry: early return in runDry and confirm when busy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";

// Pure helpers — exported for direct unit testing (will be RED until implemented)
import {
  reduceBulk,
  parseDryDecision,
  parseCommitOutcome,
  useVizBulk,
  type BulkReducerState,
  type BulkAction,
} from "../src/use-viz-bulk.js";

import type { VizRow } from "../src/viz-spec.js";
import type { Client } from "@vault/query-core";
import type { BatchResult, BatchDryRunData, BatchCommitData } from "@vault/query-core";

// ============================================================================
// Helpers
// ============================================================================

function makeRow(overrides: Partial<VizRow & { version: number }> = {}): VizRow & { version: number } {
  return {
    id: "node-1",
    title: "My Node",
    file_path: "notes/my-node.md",
    types: ["task"],
    fields: { status: "open" },
    version: 5,
    ...overrides,
  };
}

function makeRows(count: number): Array<VizRow & { version: number }> {
  return Array.from({ length: count }, (_, i) => makeRow({ id: `node-${i + 1}`, version: i + 1 }));
}

function okEnvelope<T>(data: T) {
  return { ok: true as const, data, warnings: [] };
}

function failEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    ok: false as const,
    error: { code, message, details },
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }>,
  };
}

function makeDryRunOk(wouldApplyCount: number): BatchDryRunData {
  return {
    dry_run: true,
    would_apply: Array.from({ length: wouldApplyCount }, (_, i) => ({
      op: "update",
      node_id: `node-${i + 1}`,
    })),
  };
}

function makeDryRunFailed(failedAt: number): BatchDryRunData {
  return {
    dry_run: true,
    would_apply: [],
    failed_at: failedAt,
    message: "Validation failed at op " + failedAt,
  };
}

function makeCommitResults(count: number, staleCount = 0): BatchCommitData {
  const results: BatchResult[] = Array.from({ length: count - staleCount }, (_, i) => ({
    op: "update",
    op_index: i,
    status: "applied" as const,
    node_id: `node-${i + 1}`,
    new_version: (i + 1) * 10,
  }));
  for (let i = count - staleCount; i < count; i++) {
    results.push({
      op: "update",
      op_index: i,
      status: "stale" as const,
      node_id: `node-${i + 1}`,
    });
  }
  return { applied: true, results };
}

function makeMockClient(overrides: Partial<Client> = {}): Client {
  const base: Client = {
    queryNodes: vi.fn(),
    describeSchema: vi.fn(),
    describeGlobalField: vi.fn(),
    listFieldValues: vi.fn(),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    getNode: vi.fn(),
    createNode: vi.fn(),
    deleteNode: vi.fn(),
    listTypes: vi.fn(),
    batchMutate: vi.fn(),
  };
  return { ...base, ...overrides };
}

function makeInitialReducerState(): BulkReducerState {
  return {
    selected: new Set<string>(),
    plan: null,
    picking: null,
    pending: null,
    failed: null,
    busy: false,
    outcome: null,
  };
}

// ============================================================================
// PURE REDUCER TESTS
// ============================================================================

describe("reduceBulk (pure reducer)", () => {
  it("TOGGLE_ROW selects an unselected row", () => {
    const state = makeInitialReducerState();
    const next = reduceBulk(state, { type: "TOGGLE_ROW", id: "node-1" });
    expect(next.selected.has("node-1")).toBe(true);
    expect(next.selected.size).toBe(1);
  });

  it("TOGGLE_ROW deselects an already-selected row", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      selected: new Set(["node-1"]),
    };
    const next = reduceBulk(state, { type: "TOGGLE_ROW", id: "node-1" });
    expect(next.selected.has("node-1")).toBe(false);
    expect(next.selected.size).toBe(0);
  });

  it("TOGGLE_ROW is pure — does not mutate input", () => {
    const state = makeInitialReducerState();
    reduceBulk(state, { type: "TOGGLE_ROW", id: "node-1" });
    expect(state.selected.size).toBe(0);
  });

  it("SELECT_ALL adds all given ids", () => {
    const state = makeInitialReducerState();
    const next = reduceBulk(state, { type: "SELECT_ALL", ids: ["a", "b", "c"] });
    expect(next.selected.size).toBe(3);
    expect(next.selected.has("b")).toBe(true);
  });

  it("CLEAR_SELECTION removes all ids", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      selected: new Set(["a", "b"]),
    };
    const next = reduceBulk(state, { type: "CLEAR_SELECTION" });
    expect(next.selected.size).toBe(0);
  });

  it("CLEAR_SELECTION also clears plan, picking, pending, failed (but not outcome)", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      selected: new Set(["a"]),
      plan: { kind: "setField", field: "status", value: "done" },
      picking: "value",
      pending: { wouldApply: 1, warnings: [] },
      failed: { nodeId: null, message: "oops" },
      outcome: { applied: 1, stale: 0 },
    };
    const next = reduceBulk(state, { type: "CLEAR_SELECTION" });
    expect(next.plan).toBeNull();
    expect(next.picking).toBeNull();
    expect(next.pending).toBeNull();
    expect(next.failed).toBeNull();
    // outcome is preserved so the UI can display post-commit results after selection clears
    expect(next.outcome).toEqual({ applied: 1, stale: 0 });
  });

  it("PICK sets picking mode", () => {
    const state = makeInitialReducerState();
    const next = reduceBulk(state, { type: "PICK", mode: "addType" });
    expect(next.picking).toBe("addType");
  });

  it("SET_PLAN_FIELD sets plan kind to setField and advances picking to value", () => {
    const state: BulkReducerState = { ...makeInitialReducerState(), picking: "field" };
    const next = reduceBulk(state, { type: "SET_PLAN_FIELD", field: "status" });
    expect(next.plan).toEqual({ kind: "setField", field: "status", value: null });
    expect(next.picking).toBe("value");
  });

  it("SET_PLAN_VALUE finalizes the setField plan and sets picking to null", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      plan: { kind: "setField", field: "status", value: null },
      picking: "value",
    };
    const next = reduceBulk(state, { type: "SET_PLAN_VALUE", value: "done" });
    expect(next.plan).toEqual({ kind: "setField", field: "status", value: "done" });
    expect(next.picking).toBeNull();
  });

  it("SET_PLAN_TYPE sets addType plan", () => {
    const state: BulkReducerState = { ...makeInitialReducerState(), picking: "addType" };
    const next = reduceBulk(state, { type: "SET_PLAN_TYPE", planKind: "addType", typeName: "project" });
    expect(next.plan).toEqual({ kind: "addType", type: "project" });
    expect(next.picking).toBeNull();
  });

  it("SET_PLAN_TYPE sets removeType plan", () => {
    const state: BulkReducerState = { ...makeInitialReducerState(), picking: "removeType" };
    const next = reduceBulk(state, { type: "SET_PLAN_TYPE", planKind: "removeType", typeName: "project" });
    expect(next.plan).toEqual({ kind: "removeType", type: "project" });
    expect(next.picking).toBeNull();
  });

  it("SET_BUSY sets busy flag", () => {
    const state = makeInitialReducerState();
    const next = reduceBulk(state, { type: "SET_BUSY", busy: true });
    expect(next.busy).toBe(true);
  });

  it("SET_PENDING sets pending, clears failed (BULK-INV-2)", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      failed: { nodeId: null, message: "old fail" },
    };
    const next = reduceBulk(state, {
      type: "SET_PENDING",
      pending: { wouldApply: 3, warnings: [] },
    });
    expect(next.pending).toEqual({ wouldApply: 3, warnings: [] });
    expect(next.failed).toBeNull();
  });

  it("SET_FAILED sets failed, clears pending (BULK-INV-3)", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      pending: { wouldApply: 2, warnings: [] },
    };
    const next = reduceBulk(state, {
      type: "SET_FAILED",
      failed: { nodeId: "node-1", message: "BATCH_FAILED" },
    });
    expect(next.failed).toEqual({ nodeId: "node-1", message: "BATCH_FAILED" });
    expect(next.pending).toBeNull();
  });

  it("SET_OUTCOME sets outcome, clears pending and failed", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      pending: { wouldApply: 2, warnings: [] },
      failed: null,
    };
    const next = reduceBulk(state, {
      type: "SET_OUTCOME",
      outcome: { applied: 2, stale: 0 },
    });
    expect(next.outcome).toEqual({ applied: 2, stale: 0 });
    expect(next.pending).toBeNull();
    expect(next.failed).toBeNull();
  });

  it("CANCEL clears pending, failed, plan, picking (but keeps selection)", () => {
    const state: BulkReducerState = {
      ...makeInitialReducerState(),
      selected: new Set(["node-1"]),
      plan: { kind: "setField", field: "status", value: "done" },
      picking: "value",
      pending: { wouldApply: 1, warnings: [] },
      failed: { nodeId: null, message: "oops" },
    };
    const next = reduceBulk(state, { type: "CANCEL" });
    expect(next.plan).toBeNull();
    expect(next.picking).toBeNull();
    expect(next.pending).toBeNull();
    expect(next.failed).toBeNull();
    // selection preserved
    expect(next.selected.has("node-1")).toBe(true);
  });
});

// ============================================================================
// parseDryDecision (pure helper)
// ============================================================================

describe("parseDryDecision (pure helper)", () => {
  it("returns confirm decision for a successful dry-run envelope", () => {
    const env = okEnvelope(makeDryRunOk(3));
    const decision = parseDryDecision(env, []);
    expect(decision).toEqual({ kind: "confirm", wouldApply: 3, warnings: [] });
  });

  it("returns failed decision when failed_at is set (BULK-INV-3)", () => {
    const env = okEnvelope(makeDryRunFailed(1));
    const ops = [
      { op: "update" as const, params: { node_id: "node-1", expected_version: 5 } },
      { op: "update" as const, params: { node_id: "node-2", expected_version: 6 } },
    ];
    const decision = parseDryDecision(env, ops);
    expect(decision.kind).toBe("failed");
    if (decision.kind === "failed") {
      expect(decision.nodeId).toBe("node-2");
    }
  });

  it("returns failed decision for error envelope (BATCH_FAILED) (BULK-INV-3)", () => {
    const env = failEnvelope("BATCH_FAILED", "Batch failed.", { failed_at: 0 });
    const ops = [
      { op: "update" as const, params: { node_id: "node-1", expected_version: 5 } },
    ];
    const decision = parseDryDecision(env, ops);
    expect(decision.kind).toBe("failed");
    if (decision.kind === "failed") {
      expect(decision.message).toContain("Batch failed");
    }
  });
});

// ============================================================================
// parseCommitOutcome (pure helper)
// ============================================================================

describe("parseCommitOutcome (pure helper)", () => {
  it("counts applied and stale correctly (BULK-INV-5)", () => {
    const results: BatchResult[] = [
      { op: "update", op_index: 0, status: "applied", node_id: "n1", new_version: 10 },
      { op: "update", op_index: 1, status: "applied", node_id: "n2", new_version: 11 },
      { op: "update", op_index: 2, status: "stale", node_id: "n3" },
    ];
    const outcome = parseCommitOutcome(results);
    expect(outcome).toEqual({ applied: 2, stale: 1 });
  });

  it("handles all applied, zero stale", () => {
    const results: BatchResult[] = [
      { op: "update", op_index: 0, status: "applied", node_id: "n1", new_version: 1 },
    ];
    expect(parseCommitOutcome(results)).toEqual({ applied: 1, stale: 0 });
  });

  it("handles all stale, zero applied", () => {
    const results: BatchResult[] = [
      { op: "update", op_index: 0, status: "stale", node_id: "n1" },
    ];
    expect(parseCommitOutcome(results)).toEqual({ applied: 0, stale: 1 });
  });

  it("handles empty results", () => {
    expect(parseCommitOutcome([])).toEqual({ applied: 0, stale: 0 });
  });
});

// ============================================================================
// RTL HOOK TESTS
// ============================================================================

interface ProbeProps {
  client: Client;
  rows: Array<VizRow & { version: number }>;
  onAfterCommit?: () => void;
}

function Probe({ client, rows, onAfterCommit }: ProbeProps) {
  const api = useVizBulk(client, rows, onAfterCommit);

  const selectedStr = [...api.selected].sort().join(",") || "none";
  const selectedCountStr = String(api.selectedCount);
  const allSelectedStr = api.allSelected(rows) ? "all" : "partial";
  const pickingStr = api.picking ?? "none";
  const pendingStr = api.pending
    ? `pending:${api.pending.wouldApply}${api.pending.skippedNoVersion != null ? `,skipped:${api.pending.skippedNoVersion}` : ""}`
    : "none";
  const failedStr = api.failed ? `failed:${api.failed.message}` : "none";
  const busyStr = api.busy ? "busy" : "idle";
  const outcomeStr = api.outcome
    ? `applied:${api.outcome.applied},stale:${api.outcome.stale}`
    : "none";
  const planStr = api.plan
    ? JSON.stringify(api.plan)
    : "none";

  return (
    <div>
      <span data-testid="selected">{selectedStr}</span>
      <span data-testid="selectedCount">{selectedCountStr}</span>
      <span data-testid="allSelected">{allSelectedStr}</span>
      <span data-testid="picking">{pickingStr}</span>
      <span data-testid="pending">{pendingStr}</span>
      <span data-testid="failed">{failedStr}</span>
      <span data-testid="busy">{busyStr}</span>
      <span data-testid="outcome">{outcomeStr}</span>
      <span data-testid="plan">{planStr}</span>

      <button data-testid="btn-toggle-1" onClick={() => api.toggleRow("node-1")}>toggle-1</button>
      <button data-testid="btn-toggle-2" onClick={() => api.toggleRow("node-2")}>toggle-2</button>
      <button data-testid="btn-toggle-all" onClick={() => api.toggleAll(rows)}>toggle-all</button>
      <button data-testid="btn-clear" onClick={() => api.clear()}>clear</button>
      <button data-testid="btn-pick-field" onClick={() => api.pick("setField")}>pick-field</button>
      <button data-testid="btn-pick-addType" onClick={() => api.pick("addType")}>pick-addType</button>
      <button data-testid="btn-pick-removeType" onClick={() => api.pick("removeType")}>pick-removeType</button>
      <button data-testid="btn-set-field" onClick={() => api.setPlanField("status")}>set-field</button>
      <button data-testid="btn-set-value" onClick={() => api.setPlanValue("done")}>set-value</button>
      <button data-testid="btn-set-type" onClick={() => api.setPlanType("project")}>set-type</button>
      <button data-testid="btn-run-dry" onClick={() => void api.runDry()}>run-dry</button>
      <button data-testid="btn-confirm" onClick={() => void api.confirm()}>confirm</button>
      <button data-testid="btn-cancel" onClick={() => api.cancel()}>cancel</button>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ============================================================================
// Selection API
// ============================================================================

describe("selection — toggleRow / toggleAll / clear / isSelected / allSelected", () => {
  it("toggleRow selects a row", () => {
    const rows = makeRows(2);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    expect(screen.getByTestId("selected").textContent).toBe("node-1");
    expect(screen.getByTestId("selectedCount").textContent).toBe("1");
    expect(screen.getByTestId("allSelected").textContent).toBe("partial");
  });

  it("toggleRow deselects an already-selected row", () => {
    const rows = makeRows(2);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("toggleAll selects all rows when none/partial selected", () => {
    const rows = makeRows(2);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-toggle-all").click(); });
    expect(screen.getByTestId("selected").textContent).toBe("node-1,node-2");
    expect(screen.getByTestId("allSelected").textContent).toBe("all");
  });

  it("toggleAll deselects all rows when all are selected", () => {
    const rows = makeRows(2);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-toggle-all").click(); }); // select all
    act(() => { screen.getByTestId("btn-toggle-all").click(); }); // deselect all
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("clear deselects everything and resets bulk state", () => {
    const rows = makeRows(2);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    expect(screen.getByTestId("selected").textContent).toBe("node-1");
    act(() => { screen.getByTestId("btn-clear").click(); });
    expect(screen.getByTestId("selected").textContent).toBe("none");
    expect(screen.getByTestId("selectedCount").textContent).toBe("0");
  });
});

// ============================================================================
// Plan building
// ============================================================================

describe("plan building — setField / addType / removeType", () => {
  it("pick('setField') → picking=field", () => {
    const rows = makeRows(1);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    expect(screen.getByTestId("picking").textContent).toBe("field");
  });

  it("setPlanField → picking=value, plan has field", () => {
    const rows = makeRows(1);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    expect(screen.getByTestId("picking").textContent).toBe("value");
    expect(screen.getByTestId("plan").textContent).toContain('"field":"status"');
  });

  it("setPlanValue finalizes plan (picking=null)", () => {
    const rows = makeRows(1);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });
    expect(screen.getByTestId("picking").textContent).toBe("none");
    expect(screen.getByTestId("plan").textContent).toContain('"value":"done"');
  });

  it("pick('addType') → picking=addType; setPlanType → plan={kind:addType}", () => {
    const rows = makeRows(1);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-pick-addType").click(); });
    expect(screen.getByTestId("picking").textContent).toBe("addType");
    act(() => { screen.getByTestId("btn-set-type").click(); });
    expect(screen.getByTestId("picking").textContent).toBe("none");
    expect(screen.getByTestId("plan").textContent).toContain('"kind":"addType"');
    expect(screen.getByTestId("plan").textContent).toContain('"type":"project"');
  });

  it("pick('removeType') → picking=removeType; setPlanType → plan={kind:removeType}", () => {
    const rows = makeRows(1);
    render(<Probe client={makeMockClient()} rows={rows} />);
    act(() => { screen.getByTestId("btn-pick-removeType").click(); });
    expect(screen.getByTestId("picking").textContent).toBe("removeType");
    act(() => { screen.getByTestId("btn-set-type").click(); });
    expect(screen.getByTestId("plan").textContent).toContain('"kind":"removeType"');
  });
});

// ============================================================================
// runDry — BULK-INV-1, BULK-INV-2, BULK-INV-4
// ============================================================================

describe("runDry — setField plan (BULK-INV-1, BULK-INV-2, BULK-INV-4)", () => {
  it("calls batchMutate(dry_run:true) with ops carrying expected_version from each row", async () => {
    const rows = [
      makeRow({ id: "node-1", version: 5 }),
      makeRow({ id: "node-2", version: 8 }),
    ];

    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunOk(2)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    // Select both rows
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-toggle-2").click(); });

    // Build a setField plan
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });  // sets "status"
    act(() => { screen.getByTestId("btn-set-value").click(); });  // sets "done"

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    // BULK-INV-1: batchMutate was called with dry_run:true
    expect(batchMutate).toHaveBeenCalledOnce();
    const call = batchMutate.mock.calls[0]?.[0];
    expect(call).toMatchObject({ dry_run: true });

    // BULK-INV-4: ops carry expected_version
    expect(call.operations).toHaveLength(2);
    expect(call.operations[0]).toMatchObject({
      op: "update",
      params: { node_id: "node-1", expected_version: 5, set_fields: { status: "done" } },
    });
    expect(call.operations[1]).toMatchObject({
      op: "update",
      params: { node_id: "node-2", expected_version: 8, set_fields: { status: "done" } },
    });
  });

  it("sets pending (NOT committed) on confirm decision (BULK-INV-2)", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];
    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    // BULK-INV-2: pending set, outcome NOT set (not committed)
    expect(screen.getByTestId("pending").textContent).toBe("pending:1");
    expect(screen.getByTestId("outcome").textContent).toBe("none");
    // Only one batchMutate call (the dry run), NOT two
    expect(batchMutate).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// runDry — BATCH_FAILED → failed, no commit (BULK-INV-3)
// ============================================================================

describe("runDry — BATCH_FAILED → failed (BULK-INV-3)", () => {
  it("sets failed when dry-run envelope returns ok:false (BATCH_FAILED)", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];
    const batchMutate = vi.fn().mockResolvedValueOnce(
      failEnvelope("BATCH_FAILED", "Batch validation error.", { failed_at: 0 })
    );
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    // BULK-INV-3: failed set, pending NOT set, outcome NOT set
    expect(screen.getByTestId("failed").textContent).toContain("failed:");
    expect(screen.getByTestId("pending").textContent).toBe("none");
    expect(screen.getByTestId("outcome").textContent).toBe("none");
    // Only dry-run was called, no commit
    expect(batchMutate).toHaveBeenCalledOnce();
  });

  it("sets failed when dry-run data has failed_at field", async () => {
    const rows = [
      makeRow({ id: "node-1", version: 5 }),
      makeRow({ id: "node-2", version: 6 }),
    ];
    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunFailed(1)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-toggle-2").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    expect(screen.getByTestId("failed").textContent).toContain("failed:");
    expect(screen.getByTestId("pending").textContent).toBe("none");
    expect(batchMutate).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Fix 1 — version-less row partitioning
// ============================================================================

describe("Fix 1 — version-less rows are partitioned out (not sent with expected_version:0)", () => {
  it("version-less row is NOT sent to batchMutate; versioned row IS sent; skippedNoVersion surfaced in pending", async () => {
    // Mixed selection: one versioned row + one version-less row.
    const rows = [
      makeRow({ id: "node-1", version: 5 }),
      // version-less: child/expand row that lacks a version
      { id: "node-2", title: "Child", file_path: "notes/child.md", types: [], fields: {} } as VizRow & { version: number },
    ];

    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    // Select both rows
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-toggle-2").click(); });

    // Build a setField plan
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });  // "status"
    act(() => { screen.getByTestId("btn-set-value").click(); });  // "done"

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    // Only 1 op sent — the versioned node-1 (NOT node-2 with expected_version:0)
    expect(batchMutate).toHaveBeenCalledOnce();
    const call = batchMutate.mock.calls[0]?.[0];
    expect(call.operations).toHaveLength(1);
    expect(call.operations[0]).toMatchObject({
      op: "update",
      params: { node_id: "node-1", expected_version: 5 },
    });
    // node-2 must not appear with expected_version:0
    const nodeIds = (call.operations as Array<{ params: { node_id: string } }>).map((o) => o.params.node_id);
    expect(nodeIds).not.toContain("node-2");

    // pending surfaced with skippedNoVersion=1
    expect(screen.getByTestId("pending").textContent).toBe("pending:1,skipped:1");
  });

  it("all-version-less selection sets failed instead of sending empty batch", async () => {
    const rows = [
      { id: "node-1", title: "Orphan", file_path: "notes/orphan.md", types: [], fields: {} } as VizRow & { version: number },
    ];

    const batchMutate = vi.fn();
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    // batchMutate must NOT be called (no versioned rows to send)
    expect(batchMutate).not.toHaveBeenCalled();

    // failed surfaced, pending remains none
    expect(screen.getByTestId("failed").textContent).toContain("failed:");
    expect(screen.getByTestId("pending").textContent).toBe("none");
  });
});

// ============================================================================
// confirm() — BULK-INV-5
// ============================================================================

describe("confirm() — commit, parse outcome, onAfterCommit, clear (BULK-INV-5)", () => {
  async function setupPendingState(rows: Array<VizRow & { version: number }>, batchMutateMock: ReturnType<typeof vi.fn>) {
    const client = makeMockClient({ batchMutate: batchMutateMock });
    const afterCommit = vi.fn();
    render(<Probe client={client} rows={rows} onAfterCommit={afterCommit} />);

    // Select all rows
    for (const row of rows) {
      const id = row.id.replace("node-", "");
      const btn = screen.getByTestId(`btn-toggle-${id}`);
      act(() => { btn.click(); });
    }

    // Build plan
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    // Run dry
    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    expect(screen.getByTestId("pending").textContent).not.toBe("none");
    return afterCommit;
  }

  it("calls batchMutate(dry_run:false) on confirm (BULK-INV-5)", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];
    const batchMutate = vi.fn()
      .mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)))         // dry-run
      .mockResolvedValueOnce(okEnvelope(makeCommitResults(1)));    // commit

    await setupPendingState(rows, batchMutate);

    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    expect(batchMutate).toHaveBeenCalledTimes(2);
    const commitCall = batchMutate.mock.calls[1]?.[0];
    expect(commitCall).toMatchObject({ dry_run: false });
  });

  it("parses BatchResult[] into outcome {applied, stale} (BULK-INV-5)", async () => {
    const rows = [
      makeRow({ id: "node-1", version: 5 }),
      makeRow({ id: "node-2", version: 6 }),
    ];
    const batchMutate = vi.fn()
      .mockResolvedValueOnce(okEnvelope(makeDryRunOk(2)))
      .mockResolvedValueOnce(okEnvelope(makeCommitResults(2, 1)));  // 1 applied, 1 stale

    await setupPendingState(rows, batchMutate);
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    expect(screen.getByTestId("outcome").textContent).toBe("applied:1,stale:1");
  });

  it("calls onAfterCommit after successful commit (BULK-INV-5)", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];
    const batchMutate = vi.fn()
      .mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)))
      .mockResolvedValueOnce(okEnvelope(makeCommitResults(1)));

    const afterCommit = await setupPendingState(rows, batchMutate);

    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    expect(afterCommit).toHaveBeenCalledOnce();
  });

  it("clears selection after confirm (BULK-INV-5)", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];
    const batchMutate = vi.fn()
      .mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)))
      .mockResolvedValueOnce(okEnvelope(makeCommitResults(1)));

    await setupPendingState(rows, batchMutate);

    // Selection should be set before confirm
    expect(screen.getByTestId("selected").textContent).toBe("node-1");

    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Selection cleared after confirm
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });
});

// ============================================================================
// addType / removeType ops — BULK-INV-4
// ============================================================================

describe("addType plan builds correct ops (BULK-INV-4)", () => {
  it("addType plan generates add_types ops with expected_version", async () => {
    const rows = [makeRow({ id: "node-1", version: 7 })];
    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-addType").click(); });
    act(() => { screen.getByTestId("btn-set-type").click(); }); // type="project"

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    const call = batchMutate.mock.calls[0]?.[0];
    expect(call.operations[0]).toMatchObject({
      op: "update",
      params: { node_id: "node-1", expected_version: 7, add_types: ["project"] },
    });
  });

  it("removeType plan generates remove_types ops with expected_version", async () => {
    const rows = [makeRow({ id: "node-1", version: 3 })];
    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-removeType").click(); });
    act(() => { screen.getByTestId("btn-set-type").click(); }); // type="project"

    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    const call = batchMutate.mock.calls[0]?.[0];
    expect(call.operations[0]).toMatchObject({
      op: "update",
      params: { node_id: "node-1", expected_version: 3, remove_types: ["project"] },
    });
  });
});

// ============================================================================
// busy guards — BULK-INV-6
// ============================================================================

describe("busy guards — BULK-INV-6", () => {
  it("second runDry while first is in-flight does NOT fire a second batchMutate", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];

    let resolveDry!: (v: unknown) => void;
    const dryPromise = new Promise((res) => { resolveDry = res; });

    const batchMutate = vi.fn().mockReturnValueOnce(dryPromise);
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);
    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    // First runDry (hangs)
    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    // Second runDry while busy — should be ignored (BULK-INV-6)
    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    expect(batchMutate).toHaveBeenCalledTimes(1);

    // Resolve to clean up
    await act(async () => { resolveDry(okEnvelope(makeDryRunOk(1))); });
  });

  it("double confirm while busy does NOT trigger a second commit (BULK-INV-6)", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];

    let resolveCommit!: (v: unknown) => void;
    const commitPromise = new Promise((res) => { resolveCommit = res; });

    const batchMutate = vi.fn()
      .mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)))  // dry-run
      .mockReturnValueOnce(commitPromise);                  // commit hangs

    const client = makeMockClient({ batchMutate });
    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });

    // runDry → pending
    await act(async () => { screen.getByTestId("btn-run-dry").click(); });
    expect(screen.getByTestId("pending").textContent).not.toBe("none");

    // First confirm (hangs)
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Second confirm while busy — should be no-op (BULK-INV-6)
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Only 1 dry-run + 1 commit = 2 total, no third call
    expect(batchMutate).toHaveBeenCalledTimes(2);

    // Resolve
    await act(async () => { resolveCommit(okEnvelope(makeCommitResults(1))); });
  });
});

// ============================================================================
// cancel()
// ============================================================================

describe("cancel()", () => {
  it("clears pending, failed, plan, picking — keeps selection", async () => {
    const rows = [makeRow({ id: "node-1", version: 5 })];
    const batchMutate = vi.fn().mockResolvedValueOnce(okEnvelope(makeDryRunOk(1)));
    const client = makeMockClient({ batchMutate });

    render(<Probe client={client} rows={rows} />);

    act(() => { screen.getByTestId("btn-toggle-1").click(); });
    act(() => { screen.getByTestId("btn-pick-field").click(); });
    act(() => { screen.getByTestId("btn-set-field").click(); });
    act(() => { screen.getByTestId("btn-set-value").click(); });
    await act(async () => { screen.getByTestId("btn-run-dry").click(); });

    expect(screen.getByTestId("pending").textContent).not.toBe("none");

    act(() => { screen.getByTestId("btn-cancel").click(); });

    expect(screen.getByTestId("pending").textContent).toBe("none");
    expect(screen.getByTestId("plan").textContent).toBe("none");
    expect(screen.getByTestId("picking").textContent).toBe("none");
    // Selection preserved
    expect(screen.getByTestId("selected").textContent).toBe("node-1");
  });
});
