// @vitest-environment jsdom
/**
 * viz-bulk-integration.test.tsx
 *
 * Integration test: VizCardView (editable, table kind) wires useVizBulk
 * into VizTable — checkbox column, BulkBar, dry-run → confirm flow, gating.
 *
 * Asserts:
 *   1. Editable table renders a checkbox column (header + per-row checkboxes).
 *   2. Select 2 rows → BulkBar shows "2 selected" (SAME bulk instance shared).
 *   3. Set field status=done → Apply → "N would change" → Confirm →
 *      batchMutate(dry_run:false) fired with both rows' expected_version.
 *   4. Outcome banner shows applied count; selection cleared; refetch fires.
 *   5. Non-table kind / collapsed / no-onSpecChange → NO checkbox column.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";
import type { Schema, Envelope, TypeSummary, BatchDryRunData, BatchCommitData } from "@vault/query-core";
import type { VizSpec, VizRow } from "../src/viz-spec.js";
import type { Client } from "@vault/query-core";

// ─── Module-level mocks ───────────────────────────────────────────────────────

vi.mock("../src/use-viz-data.js", () => {
  return {
    useVizData: vi.fn(() => ({
      rows: _rows,
      total: _rows.length,
      loading: false,
      error: null,
      refresh: _refresh,
    })),
  };
});

vi.mock("../src/use-viz-refs.js", () => {
  return { useVizRefFields: vi.fn(() => new Set<string>()) };
});

// Module-scope mutable state shared with mocks
let _rows: VizRow[] = [];
let _refresh = vi.fn();

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { _resetCachesForTest } from "../src/use-viz-schema.js";
import { VizCardView } from "../src/VizCard.js";
import { withClient } from "./_render-viz.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STATUS_FIELD = {
  name: "status",
  type: "enum" as const,
  required: false,
  default_value: null,
  enum_values: ["open", "done"],
  ui: { widget: "enum" as const },
};

const TASK_SCHEMA: Schema = { name: "task", display_name: "Task", fields: [STATUS_FIELD] };

function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

const ROW_A: VizRow = {
  id: "node-aaa",
  title: "Task A",
  file_path: "tasks/task-a.md",
  types: ["task"],
  fields: { status: "open" },
  version: 3,
};

const ROW_B: VizRow = {
  id: "node-bbb",
  title: "Task B",
  file_path: "tasks/task-b.md",
  types: ["task"],
  fields: { status: "open" },
  version: 7,
};

const TABLE_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

function makeDryRunEnv(wouldApply: number): Envelope<BatchDryRunData> {
  const rows = _rows.slice(0, wouldApply);
  return okEnv({
    dry_run: true as const,
    would_apply: rows.map((r) => ({ op: "update_node", node_id: r.id })),
  });
}

function makeCommitEnv(applied: number): Envelope<BatchCommitData> {
  const rows = _rows.slice(0, applied);
  return okEnv({
    applied: true as const,
    results: rows.map((r, i) => ({
      op: "update_node",
      op_index: i,
      node_id: r.id,
      status: "applied" as const,
      new_version: (r.version ?? 1) + 1,
    })),
  });
}

function makeMockClient(overrides: Partial<Client> = {}): Client {
  const base: Client = {
    queryNodes: vi.fn(),
    describeSchema: vi.fn<[string], Promise<Envelope<Schema>>>().mockResolvedValue(okEnv(TASK_SCHEMA)),
    describeGlobalField: vi.fn(),
    listFieldValues: vi.fn(),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    getNode: vi.fn(),
    createNode: vi.fn(),
    deleteNode: vi.fn(),
    listTypes: vi.fn<[], Promise<Envelope<TypeSummary[]>>>().mockResolvedValue(
      okEnv([{ type: "task", count: 2, has_schema: true, claim_count: null }]),
    ),
    batchMutate: vi.fn(),
  };
  return { ...base, ...overrides };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let mockClient: Client;

beforeEach(() => {
  _resetCachesForTest();
  _rows = [{ ...ROW_A }, { ...ROW_B }];
  _refresh = vi.fn();
  mockClient = makeMockClient();
});

afterEach(() => {
  cleanup();
});

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderEditable(overrides: Partial<Parameters<typeof VizCardView>[0]> = {}) {
  const onSpecChange = vi.fn();
  return render(
    <VizCardView
      spec={TABLE_SPEC}
      kind="table"
      rows={_rows}
      total={_rows.length}
      loading={false}
      error={null}
      onKind={vi.fn()}
      onRefresh={_refresh}
      onSpecChange={onSpecChange}
      {...overrides}
    />,
    { wrapper: withClient(mockClient) },
  );
}

/** Wait for schema to load (the toolbar's Properties button appears). */
async function waitForSchema() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^properties$/i })).not.toBeNull();
  }, { timeout: 2000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("viz-bulk-integration — checkbox column gating", () => {
  it("shows checkbox column header in editable table", async () => {
    renderEditable();
    await waitForSchema();
    // Header row should have a checkbox
    const headerCheckboxes = document.querySelectorAll("thead input[type='checkbox']");
    expect(headerCheckboxes.length).toBeGreaterThan(0);
  });

  it("shows per-row checkboxes in editable table", async () => {
    renderEditable();
    await waitForSchema();
    // Each data row should have a checkbox
    const bodyCheckboxes = document.querySelectorAll("tbody input[type='checkbox']");
    expect(bodyCheckboxes.length).toBe(2);
  });

  it("does NOT show checkboxes when read-only (no onSpecChange)", () => {
    renderEditable({ onSpecChange: undefined });
    const checkboxes = document.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBe(0);
  });

  it("does NOT show checkboxes when collapsed", () => {
    renderEditable({ collapsed: true });
    const checkboxes = document.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBe(0);
  });

  it("does NOT show checkboxes when non-table kind", async () => {
    renderEditable({ kind: "kanban" });
    const checkboxes = document.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBe(0);
  });
});

describe("viz-bulk-integration — selection → BulkBar shows N selected", () => {
  it("selecting 2 rows shows BulkBar with '2 selected'", async () => {
    renderEditable();
    await waitForSchema();

    // No BulkBar before selection
    expect(screen.queryByText(/selected/)).toBeNull();

    // Select row A
    const checkboxes = document.querySelectorAll("tbody input[type='checkbox']");
    await act(async () => { fireEvent.click(checkboxes[0]!); });
    await act(async () => { fireEvent.click(checkboxes[1]!); });

    // BulkBar must now show "2 selected"
    await waitFor(() => {
      expect(screen.queryByText(/2 selected/)).not.toBeNull();
    });
  });

  it("selecting all via header checkbox selects all rows", async () => {
    renderEditable();
    await waitForSchema();

    const headerCheckbox = document.querySelector("thead input[type='checkbox']") as HTMLInputElement;
    await act(async () => { fireEvent.click(headerCheckbox); });

    await waitFor(() => {
      expect(screen.queryByText(/2 selected/)).not.toBeNull();
    });
  });
});

describe("viz-bulk-integration — full flow: select → dry-run → confirm → outcome", () => {
  it("confirm fires batchMutate(dry_run:false) with both rows' expected_version and shows outcome", async () => {
    // batchMutate: first call = dry run, second = commit
    vi.mocked(mockClient.batchMutate)
      .mockResolvedValueOnce(makeDryRunEnv(2) as Envelope<BatchDryRunData | BatchCommitData>)
      .mockResolvedValueOnce(makeCommitEnv(2) as Envelope<BatchDryRunData | BatchCommitData>);

    renderEditable();
    await waitForSchema();

    // Step 1: Select both rows via header checkbox → BulkBar shows "2 selected"
    const headerCheckbox = document.querySelector("thead input[type='checkbox']") as HTMLInputElement;
    await act(async () => { fireEvent.click(headerCheckbox); });
    await waitFor(() => { expect(screen.queryByText(/2 selected/)).not.toBeNull(); });

    // Step 2: "Set field…" → open field picker
    const setFieldBtn = screen.getByRole("button", { name: /set field/i });
    await act(async () => { fireEvent.click(setFieldBtn); });
    await act(async () => { await Promise.resolve(); });

    // Step 3: Pick "status" from field menu (via mouseDown on the first menuitem)
    await waitFor(() => {
      expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const firstMenuItem = document.querySelector('[role="menuitem"]') as HTMLElement;
    expect(firstMenuItem).not.toBeNull();
    await act(async () => { fireEvent.mouseDown(firstMenuItem!); });
    await act(async () => { await Promise.resolve(); });

    // Step 4: Value picker — enum listbox appears (status field is enum)
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeNull();
    }, { timeout: 2000 });

    // Click "done" option via mouseDown (EnumCellEditor uses onMouseDown)
    const doneOption = screen.queryByRole("option", { name: /done/i })
      ?? Array.from(document.querySelectorAll('[role="option"]')).find(
          (el) => el.textContent?.trim() === "done",
        ) as HTMLElement | undefined;
    expect(doneOption).not.toBeNull();
    await act(async () => { fireEvent.mouseDown(doneOption!); });
    await act(async () => { await Promise.resolve(); });

    // Step 5: Plan is set → "Apply…" button visible
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /apply/i })).not.toBeNull();
    }, { timeout: 2000 });

    // Step 6: Apply → dry run
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /apply/i })); });

    await waitFor(() => {
      expect(screen.queryByText(/would change/i)).not.toBeNull();
    }, { timeout: 2000 });

    // Verify dry-run batchMutate args: both rows with their expected_version
    expect(mockClient.batchMutate).toHaveBeenCalledTimes(1);
    const [dryRunCall] = vi.mocked(mockClient.batchMutate).mock.calls;
    expect(dryRunCall![0]).toMatchObject({ dry_run: true });
    const ops = (dryRunCall![0] as { operations: Array<{ params: { node_id: string; expected_version: number } }> }).operations;
    expect(ops.length).toBe(2);
    const nodeAOp = ops.find((op) => op.params.node_id === "node-aaa");
    const nodeBOp = ops.find((op) => op.params.node_id === "node-bbb");
    expect(nodeAOp?.params.expected_version).toBe(3);
    expect(nodeBOp?.params.expected_version).toBe(7);

    // Step 7: Confirm → commit
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /confirm/i })); });

    await waitFor(() => {
      expect(vi.mocked(mockClient.batchMutate)).toHaveBeenCalledTimes(2);
    }, { timeout: 2000 });

    const [, commitCall] = vi.mocked(mockClient.batchMutate).mock.calls;
    expect(commitCall![0]).toMatchObject({ dry_run: false });

    // Step 8: Outcome banner appears, selection clears, refetch fires
    await waitFor(() => {
      expect(screen.queryByText(/applied/i)).not.toBeNull();
    }, { timeout: 2000 });

    await waitFor(() => {
      expect(screen.queryByText(/2 selected/)).toBeNull();
    }, { timeout: 2000 });

    expect(_refresh).toHaveBeenCalled();
  });
});
