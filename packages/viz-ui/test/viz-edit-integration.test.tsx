// @vitest-environment jsdom
/**
 * viz-edit-integration.test.tsx
 *
 * Integration test: VizCardView (editable, table kind) wires useVizCellEdit
 * into VizTable — editing cells, smart-confirm, stale reload, and gating.
 *
 * Asserts:
 *   1. Click a status (enum) cell → editor opens.
 *   2. CLEAN edit: pick a value → updateNode dry_run:true then dry_run:false;
 *      cell shows new value; no PromotePill visible.
 *   3. SURPRISING edit (promote): PromotePill appears; NO commit until Confirm.
 *      After Confirm → commit fires.
 *   4. STALE response → StaleReloadBar appears; Reload clears it.
 *   5. Non-table kind / collapsed / read-only → NO editors (editable-gated).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import type { Schema, Envelope, TypeSummary, UpdateDryRunData, UpdateCommitData } from "@vault/query-core";
import type { VizSpec, VizRow } from "../src/viz-spec.js";
import type { Client } from "@vault/query-core";

// ─── Mock module-level singletons ────────────────────────────────────────────

vi.mock("../src/use-viz-data.js", () => {
  return {
    useVizData: vi.fn(() => ({
      rows: _rows,
      total: _rows.length,
      loading: false,
      error: null,
      refresh: vi.fn(),
    })),
  };
});

vi.mock("../src/use-viz-refs.js", () => {
  return { useVizRefFields: vi.fn(() => new Set<string>()) };
});

// rows is module-scoped so the mock closure captures it
let _rows: VizRow[] = [];

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
  enum_values: ["open", "in-progress", "done"],
  ui: null,
};

const TASK_SCHEMA: Schema = { name: "task", display_name: "Task", fields: [STATUS_FIELD] };

function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

function failEnv(code: string, message: string, details?: Record<string, unknown>) {
  return {
    ok: false as const,
    error: { code, message, details },
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }>,
  };
}

const BASE_ROW: VizRow = {
  id: "node-abc",
  title: "Test Task",
  file_path: "tasks/test-task.md",
  types: ["task"],
  fields: { status: "open" },
  version: 5,
};

const TABLE_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

function dryRunData(field: string, raw: unknown, coerced?: unknown): UpdateDryRunData {
  const eff = coerced ?? raw;
  return {
    dry_run: true,
    preview: {
      node_id: "node-abc",
      file_path: "tasks/test-task.md",
      title: "Test Task",
      types: ["task"],
      coerced_state: {
        [field]: {
          field,
          value: eff,
          original: raw,
          source: "provided" as const,
          changed: eff !== raw,
          ...(eff !== raw ? { coercion_code: "STRING_COERCE" } : {}),
        },
      },
      fixable: [],
      orphan_fields: [],
    },
  };
}

function commitData(field: string, value: unknown, version = 6): UpdateCommitData {
  return {
    node_id: "node-abc",
    file_path: "tasks/test-task.md",
    title: "Test Task",
    types: ["task"],
    coerced_state: { [field]: { field, value, source: "provided" as const, changed: true } },
    orphan_fields: [],
    version,
  };
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
      okEnv([{ type: "task", count: 3, has_schema: true, claim_count: null }]),
    ),
    batchMutate: vi.fn(),
  };
  return { ...base, ...overrides };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

/** Wait until schema has loaded (detectable by the toolbar's Properties button). */
async function waitForSchema() {
  // Flush microtasks to allow async schema fetch to resolve
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^properties$/i })).not.toBeNull();
  }, { timeout: 2000 });
}

/** Open the enum editor by clicking the status cell after schema loads. */
async function openStatusEditor() {
  await waitForSchema();
  // The status column is the second td in a row (first is title)
  // Find a .cell-inner that contains the status value text
  const allInners = document.querySelectorAll("td .cell-inner");
  // Status cell is at index 1 (title at 0)
  const statusInner = allInners[1] as HTMLElement | null;
  expect(statusInner).not.toBeNull();
  await act(async () => { fireEvent.click(statusInner!); });
  await act(async () => { await Promise.resolve(); });
  // The listbox appears synchronously after beginEdit triggers a re-render.
  // Assert directly rather than using waitFor (which may flush effects that close the editor).
  expect(screen.queryByRole("listbox")).not.toBeNull();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _mockClient: Client;

beforeEach(() => {
  _resetCachesForTest();
  _rows = [{ ...BASE_ROW }];
  _mockClient = makeMockClient();
});

afterEach(() => {
  cleanup();
});

// ─── Render helper ────────────────────────────────────────────────────────────

function renderEditable(overrides: Partial<Parameters<typeof VizCardView>[0]> = {}, client?: Client) {
  return render(
    <VizCardView
      spec={TABLE_SPEC}
      kind="table"
      rows={_rows}
      total={_rows.length}
      loading={false}
      error={null}
      onKind={vi.fn()}
      onRefresh={vi.fn()}
      onSpecChange={vi.fn()}
      {...overrides}
    />,
    { wrapper: withClient(client ?? _mockClient) },
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("viz-edit-integration — editable table", () => {
  it("clicking a status cell opens the enum editor", async () => {
    cleanup();
    _resetCachesForTest();
    renderEditable();

    // openStatusEditor: waits for schema, clicks status cell, asserts listbox appears
    await openStatusEditor();
  });

  it("CLEAN edit: commits via dry_run:true then dry_run:false; cell shows new value", async () => {
    const updateNode = vi.fn()
      .mockResolvedValueOnce(okEnv(dryRunData("status", "done")))
      .mockResolvedValueOnce(okEnv(commitData("status", "done", 6)));

    const client = makeMockClient({ updateNode });
    cleanup();
    _resetCachesForTest();
    renderEditable({}, client);

    await openStatusEditor();

    // Pick "done" from the enum listbox
    const doneOpt = screen.getAllByRole("option").find((el) => el.textContent?.trim() === "done");
    expect(doneOpt).toBeDefined();
    await act(async () => { fireEvent.mouseDown(doneOpt!); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // INV-1: dry_run:true first
    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(updateNode.mock.calls[0]![0]).toMatchObject({
      node_id: "node-abc",
      set_fields: { status: "done" },
      expected_version: 5,
      dry_run: true,
    });
    // then dry_run:false
    expect(updateNode.mock.calls[1]![0]).toMatchObject({ node_id: "node-abc", dry_run: false });

    // Editor closed, no PromotePill
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("region", { name: /confirm edit/i })).toBeNull();

    // Cell shows new value via overlay
    await waitFor(() => {
      const cellInners = document.querySelectorAll("td .cell-inner");
      const hasDone = Array.from(cellInners).some((c) => c.textContent?.includes("done"));
      expect(hasDone).toBe(true);
    });
  });

  it("SURPRISING edit (promote): PromotePill appears, NO commit until Confirm", async () => {
    // Coercion: raw "DONE" → coerced "done" → value changed → promote
    const updateNode = vi.fn()
      .mockResolvedValueOnce(okEnv(dryRunData("status", "DONE", "done")))
      .mockResolvedValueOnce(okEnv(commitData("status", "done", 6)));

    const client = makeMockClient({ updateNode });
    cleanup();
    _resetCachesForTest();
    renderEditable({}, client);

    await openStatusEditor();

    // Pick any option (we're simulating a value that gets coerced)
    const doneOpt = screen.getAllByRole("option").find((el) => el.textContent?.trim() === "done");
    await act(async () => { fireEvent.mouseDown(doneOpt!); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // PromotePill should be visible (the promote path was taken, not commit)
    // Use direct assertion instead of waitFor to avoid act-flushing closing the pill.
    const promotePill = screen.queryByRole("region", { name: /confirm edit/i });
    expect(promotePill).not.toBeNull();

    // At this point, only dry-run should have fired (INV-2: no commit until Confirm)
    const callsBeforeConfirm = updateNode.mock.calls.length;
    expect(callsBeforeConfirm).toBe(1);

    // Click Confirm
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    await act(async () => { fireEvent.click(confirmBtn); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Commit fired
    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(updateNode.mock.calls[1]![0]).toMatchObject({ dry_run: false });

    // PromotePill gone
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /confirm edit/i })).toBeNull();
    });
  });

  it("STALE response: StaleReloadBar appears; Reload clears it", async () => {
    const staleEnv = failEnv("STALE_NODE", "Version conflict.", {
      current_version: 9,
      expected_version: 5,
      current_node: {
        id: "node-abc",
        file_path: "tasks/test-task.md",
        title: "Test Task",
        types: ["task"],
        fields: { status: "done" },
        body: null,
        version: 9,
      },
    });

    const updateNode = vi.fn().mockResolvedValueOnce(staleEnv);
    const client = makeMockClient({ updateNode });
    cleanup();
    _resetCachesForTest();
    renderEditable({}, client);

    await openStatusEditor();

    const doneOpt = screen.getAllByRole("option").find((el) => el.textContent?.trim() === "done");
    await act(async () => { fireEvent.mouseDown(doneOpt!); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // StaleReloadBar should appear
    await waitFor(() => {
      expect(document.querySelector(".stale-reload-bar")).not.toBeNull();
    });

    // Click Reload
    const reloadBtn = screen.getByRole("button", { name: /reload/i });
    await act(async () => { fireEvent.click(reloadBtn); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // StaleReloadBar gone after reload
    await waitFor(() => {
      expect(document.querySelector(".stale-reload-bar")).toBeNull();
    });
  });
});

describe("viz-edit-integration — editable-gating", () => {
  it("kanban kind: table body not rendered, no editors", () => {
    renderEditable({ kind: "kanban" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("collapsed card: body not rendered, no editors", () => {
    renderEditable({ collapsed: true, onToggleCollapse: vi.fn() });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("read-only (no onSpecChange): click cells → no editor opens", async () => {
    _rows = [{ ...BASE_ROW }];
    render(
      <VizCardView
        spec={TABLE_SPEC}
        kind="table"
        rows={_rows}
        total={1}
        loading={false}
        error={null}
        onKind={vi.fn()}
        onRefresh={vi.fn()}
        // no onSpecChange → editable=false
      />,
      { wrapper: withClient(_mockClient) },
    );

    // In read-only mode the status cell renders the raw value without .cell-inner
    // Clicking it does nothing (no beginEdit wired)
    const td = document.querySelector("td");
    if (td) fireEvent.click(td);

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
