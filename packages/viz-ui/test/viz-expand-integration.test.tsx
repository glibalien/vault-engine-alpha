// @vitest-environment jsdom
/**
 * viz-expand-integration.test.tsx
 *
 * Integration test: VizCardView (editable, table kind) wires useVizExpand
 * into VizTable — caret column appears, clicking opens sub-table with child
 * rows, child cell edits fire dry-run → commit with parent refetch, and
 * reconcile closes sub-tables when parents vanish from the result set.
 *
 * Asserts:
 *   1. Editable table with locked type + expansion pair → .row-caret on each row.
 *   2. Click caret → .sub-table-row opens; queryNodes called with join_filters.
 *   3. Edit child cell → update-node(dry_run:true) then update-node(dry_run:false)
 *      with child id + expected_version; parent refetch fires.
 *   4. Refetch drops parent → sub-table closes (reconcile).
 *   5. Non-table / collapsed / read-only (no onSpecChange) → NO .row-caret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";
import type {
  Schema,
  Envelope,
  TypeSummary,
  UpdateDryRunData,
  UpdateCommitData,
  QueryNodesData,
} from "@vault/query-core";
import type { VizSpec, VizRow } from "../src/viz-spec.js";
import type { Client } from "@vault/query-core";
import type { NodeRow } from "@vault/query-core";

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

/** The parent (locked) schema. */
const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    {
      name: "status",
      type: "enum",
      required: false,
      default_value: null,
      enum_values: ["todo", "done"],
      ui: { widget: "enum" },
    },
  ],
};

/**
 * Child schema — the `parent` reference field targets "task",
 * so expansionPairs("task", schemas) yields exactly one pair:
 *   { childType: "subtask", viaField: "parent" }
 */
const CHILD_SCHEMA: Schema = {
  name: "subtask",
  display_name: "Subtask",
  fields: [
    {
      name: "parent",
      type: "reference",
      required: false,
      default_value: null,
      reference_target: "task",
      ui: null,
    },
  ],
};

function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

const PARENT_ROW: VizRow = {
  id: "node-parent-1",
  title: "Task One",
  file_path: "tasks/task-one.md",
  types: ["task"],
  fields: { status: "todo" },
  version: 1,
};

const CHILD_NODE_ROW: NodeRow = {
  id: "node-child-1",
  title: "Subtask One",
  file_path: "tasks/subtask-one.md",
  types: ["subtask"],
  version: 2,
  field_count: 1,
  fields: { parent: "node-parent-1" },
};

const TABLE_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

function makeUpdateDryRunEnv(nodeId: string): Envelope<UpdateDryRunData> {
  return okEnv({
    dry_run: true as const,
    preview: {
      node_id: nodeId,
      file_path: "tasks/subtask-one.md",
      title: "Subtask One",
      types: ["subtask"],
      coerced_state: {
        parent: {
          field: "parent",
          value: "node-parent-updated",
          source: "provided" as const,
          changed: true,
        },
      },
      fixable: [],
      orphan_fields: [],
    },
  });
}

function makeUpdateCommitEnv(nodeId: string): Envelope<UpdateCommitData> {
  return okEnv({
    node_id: nodeId,
    file_path: "tasks/subtask-one.md",
    title: "Subtask One",
    types: ["subtask"],
    coerced_state: {},
    orphan_fields: [],
    version: 3,
  });
}

/**
 * Build a mock client where:
 * - listTypes returns both "task" and "subtask"
 * - describeSchema returns the right schema per type
 * - queryNodes: no join_filters → parent table rows; with join_filters → child rows
 */
function makeMockClient(overrides: Partial<Client> = {}): Client {
  const base: Client = {
    summarizeNodes: vi.fn(),
    readRollups: vi.fn(),
    traverseNodes: vi.fn(),
    queryNodes: vi.fn((args: Record<string, unknown>) => {
      // If called with join_filters, return child rows
      if (args["join_filters"] !== undefined) {
        return Promise.resolve(
          okEnv<QueryNodesData>({ nodes: [CHILD_NODE_ROW], total: 1 }),
        );
      }
      // Otherwise return parent rows
      return Promise.resolve(
        okEnv<QueryNodesData>({
          nodes: [{ id: PARENT_ROW.id, title: PARENT_ROW.title, file_path: PARENT_ROW.file_path, types: PARENT_ROW.types, version: PARENT_ROW.version, field_count: 1, fields: PARENT_ROW.fields }],
          total: 1,
        }),
      );
    }),
    describeSchema: vi.fn((typeName: string) => {
      if (typeName === "subtask") return Promise.resolve(okEnv(CHILD_SCHEMA));
      return Promise.resolve(okEnv(TASK_SCHEMA));
    }),
    describeGlobalField: vi.fn(),
    listFieldValues: vi.fn(),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    getNode: vi.fn(),
    createNode: vi.fn(),
    deleteNode: vi.fn(),
    listTypes: vi.fn<[], Promise<Envelope<TypeSummary[]>>>().mockResolvedValue(
      okEnv([
        { type: "task", count: 1, has_schema: true, claim_count: null },
        { type: "subtask", count: 1, has_schema: true, claim_count: null },
      ]),
    ),
    batchMutate: vi.fn(),
  };
  return { ...base, ...overrides };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let mockClient: Client;

beforeEach(() => {
  _resetCachesForTest();
  _rows = [{ ...PARENT_ROW }];
  _refresh = vi.fn();
  mockClient = makeMockClient();
});

afterEach(() => {
  cleanup();
});

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderEditable(
  overrides: Partial<Parameters<typeof VizCardView>[0]> = {},
  client?: Client,
) {
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
    { wrapper: withClient(client ?? mockClient) },
  );
}

/**
 * Wait for both schemas to load (useVizSchemas needs listTypes + describeSchema for
 * both "task" and "subtask" to resolve so expansionPairs() finds the pair).
 * We wait for the .row-caret to appear as the signal.
 */
async function waitForCaret() {
  // Flush schema fetch microtasks
  for (let i = 0; i < 6; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  await waitFor(() => {
    expect(document.querySelector(".row-caret")).not.toBeNull();
  }, { timeout: 3000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("viz-expand-integration — caret gating", () => {
  it("editable table with locked type + expansion pair shows .row-caret on each row", async () => {
    renderEditable();
    await waitForCaret();
    // Every data row should have a caret
    const carets = document.querySelectorAll(".row-caret");
    expect(carets.length).toBeGreaterThan(0);
  });

  it("does NOT show .row-caret when kind is not table", async () => {
    renderEditable({ kind: "kanban" });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".row-caret")).toBeNull();
  });

  it("does NOT show .row-caret when collapsed", async () => {
    renderEditable({ collapsed: true });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".row-caret")).toBeNull();
  });

  it("does NOT show .row-caret when read-only (no onSpecChange)", async () => {
    renderEditable({ onSpecChange: undefined });
    // Flush a few ticks — even if schemas load, no caret without editable gate
    for (let i = 0; i < 4; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(document.querySelector(".row-caret")).toBeNull();
  });
});

describe("viz-expand-integration — click caret opens sub-table", () => {
  it("click caret → .sub-table-row appears; queryNodes called with join_filters", async () => {
    renderEditable();
    await waitForCaret();

    const caret = document.querySelector(".row-caret") as HTMLElement;
    await act(async () => { fireEvent.click(caret); });

    // Wait for the sub-table row to appear
    await waitFor(() => {
      expect(document.querySelector(".sub-table-row")).not.toBeNull();
    }, { timeout: 3000 });

    // queryNodes must have been called with join_filters pointing at parent
    const calls = vi.mocked(mockClient.queryNodes).mock.calls;
    const joinCall = calls.find((c) => {
      const args = c[0] as Record<string, unknown>;
      return Array.isArray(args["join_filters"]);
    });
    expect(joinCall).toBeDefined();
    const joinArgs = joinCall![0] as Record<string, unknown>;
    const joinFilters = joinArgs["join_filters"] as Array<{ rel_type: string; target: { node_ids: string[] } }>;
    expect(joinFilters[0]!.target.node_ids).toContain(PARENT_ROW.id);
  });
});

describe("viz-expand-integration — child cell edit mutation path", () => {
  /**
   * A child schema that has an editable status enum field (plus the parent ref).
   * The sub-table's childDisplayFields will include "status" so there is a cell to click.
   */
  const CHILD_SCHEMA_EDITABLE: Schema = {
    name: "subtask",
    display_name: "Subtask",
    fields: [
      {
        name: "parent",
        type: "reference",
        required: false,
        default_value: null,
        reference_target: "task",
        ui: null,
      },
      {
        name: "status",
        type: "enum",
        required: false,
        default_value: null,
        enum_values: ["todo", "done"],
        ui: { widget: "enum" },
      },
    ],
  };

  const CHILD_NODE_WITH_STATUS: NodeRow = {
    id: "node-child-1",
    title: "Subtask One",
    file_path: "tasks/subtask-one.md",
    types: ["subtask"],
    version: 2,
    field_count: 2,
    fields: { parent: "node-parent-1", status: "todo" },
  };

  let editableClient: Client;

  beforeEach(() => {
    editableClient = makeMockClient({
      describeSchema: vi.fn((typeName: string) => {
        if (typeName === "subtask") return Promise.resolve(okEnv(CHILD_SCHEMA_EDITABLE));
        return Promise.resolve(okEnv(TASK_SCHEMA));
      }),
      queryNodes: vi.fn((args: Record<string, unknown>) => {
        if (args["join_filters"] !== undefined) {
          return Promise.resolve(
            okEnv<QueryNodesData>({ nodes: [CHILD_NODE_WITH_STATUS], total: 1 }),
          );
        }
        return Promise.resolve(
          okEnv<QueryNodesData>({
            nodes: [{ id: PARENT_ROW.id, title: PARENT_ROW.title, file_path: PARENT_ROW.file_path, types: PARENT_ROW.types, version: PARENT_ROW.version, field_count: 1, fields: PARENT_ROW.fields }],
            total: 1,
          }),
        );
      }),
      updateNode: vi.fn()
        .mockResolvedValueOnce(makeUpdateDryRunEnv("node-child-1"))
        .mockResolvedValueOnce(makeUpdateCommitEnv("node-child-1")),
    });
  });

  it("edit child cell → updateNode(dry_run:true) then updateNode(dry_run:false) with child id+version; parent refetch fires", async () => {
    renderEditable({}, editableClient);
    await waitForCaret();

    // Open the sub-table
    const caret = document.querySelector(".row-caret") as HTMLElement;
    await act(async () => { fireEvent.click(caret); });

    await waitFor(() => {
      expect(document.querySelector(".sub-table-row")).not.toBeNull();
    }, { timeout: 3000 });

    // Find the child status cell inside the sub-table and click to begin edit
    const subTableRow = document.querySelector(".sub-table-row") as HTMLElement;
    expect(subTableRow).not.toBeNull();

    // The child's status enum cell renders a .cell-inner; click it to open the editor
    const childCellInners = subTableRow.querySelectorAll(".cell-inner");
    // First .cell-inner in sub-table is the title cell; status is the next one
    // Find status cell by looking for cells that contain "todo" text (the initial value)
    let statusCellInner: HTMLElement | null = null;
    for (const el of childCellInners) {
      if (el.textContent?.includes("todo")) {
        statusCellInner = el as HTMLElement;
        break;
      }
    }
    expect(statusCellInner).not.toBeNull();

    await act(async () => { fireEvent.click(statusCellInner!); });
    await act(async () => { await Promise.resolve(); });

    // The enum editor (listbox) should appear
    await waitFor(() => {
      expect(document.querySelector("[role='listbox']")).not.toBeNull();
    }, { timeout: 2000 });

    // Pick "done" from the enum options
    const doneOpt = screen.getAllByRole("option").find((el) => el.textContent?.trim() === "done");
    expect(doneOpt).toBeDefined();
    await act(async () => { fireEvent.mouseDown(doneOpt!); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // INV: updateNode called exactly twice
    await waitFor(() => {
      expect(vi.mocked(editableClient.updateNode)).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });

    const calls = vi.mocked(editableClient.updateNode).mock.calls;

    // First call: dry_run:true on the CHILD node with its version
    expect(calls[0]![0]).toMatchObject({
      node_id: "node-child-1",
      dry_run: true,
      expected_version: CHILD_NODE_WITH_STATUS.version,
    });

    // Second call: dry_run:false (commit) on the CHILD node with expected_version
    expect(calls[1]![0]).toMatchObject({
      node_id: "node-child-1",
      dry_run: false,
      expected_version: CHILD_NODE_WITH_STATUS.version,
    });

    // Parent refetch fires after commit (queryNodes call count increments)
    // _refresh is the mock passed as onRefresh; it should be called after commit
    await waitFor(() => {
      expect(_refresh).toHaveBeenCalled();
    }, { timeout: 3000 });
  });
});

describe("viz-expand-integration — reconcile closes sub-table when parent drops", () => {
  it("refetch that drops the parent from rows → sub-table closes", async () => {
    // We need to control rows updates, so re-import useVizData mock
    const { useVizData } = await import("../src/use-viz-data.js");
    const mockUseVizData = vi.mocked(useVizData);

    // Start with parent row present
    let currentRows = [{ ...PARENT_ROW }];
    mockUseVizData.mockImplementation(() => ({
      rows: currentRows,
      total: currentRows.length,
      loading: false,
      error: null,
      refresh: _refresh,
    }));

    const { rerender } = render(
      <VizCardView
        spec={TABLE_SPEC}
        kind="table"
        rows={currentRows}
        total={currentRows.length}
        loading={false}
        error={null}
        onKind={vi.fn()}
        onRefresh={_refresh}
        onSpecChange={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Wait for caret to appear
    for (let i = 0; i < 6; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    await waitFor(() => {
      expect(document.querySelector(".row-caret")).not.toBeNull();
    }, { timeout: 3000 });

    // Click caret to open sub-table
    const caret = document.querySelector(".row-caret") as HTMLElement;
    await act(async () => { fireEvent.click(caret); });

    await waitFor(() => {
      expect(document.querySelector(".sub-table-row")).not.toBeNull();
    }, { timeout: 3000 });

    // Now simulate a refetch that drops the parent from the result set
    currentRows = [];
    mockUseVizData.mockImplementation(() => ({
      rows: currentRows,
      total: 0,
      loading: false,
      error: null,
      refresh: _refresh,
    }));

    // Rerender with empty rows — reconcile effect fires on rows change
    await act(async () => {
      rerender(
        <VizCardView
          spec={TABLE_SPEC}
          kind="table"
          rows={currentRows}
          total={0}
          loading={false}
          error={null}
          onKind={vi.fn()}
          onRefresh={_refresh}
          onSpecChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    // Sub-table should be gone
    await waitFor(() => {
      expect(document.querySelector(".sub-table-row")).toBeNull();
    }, { timeout: 3000 });
  });
});
