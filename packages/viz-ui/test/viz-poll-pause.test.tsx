// @vitest-environment jsdom
/**
 * viz-poll-pause.test.tsx
 *
 * Pins the fix: a single useVizCellEdit instance is shared between VizCard's
 * poll-pause signal and VizCardView's table mutations.
 *
 * Before the fix, VizCard had TWO separate hook instances:
 *   editForPause = useVizCellEdit(makeVizQueryClient())            // instance A
 *   VizCardView's own: edit = useVizCellEdit(makeVizQueryClient(), onRefresh) // instance B
 *
 * The poll read editForPause.isEditing (A) while the table mutated via B,
 * so isEditing was always false on A — the poll was NEVER paused during edits.
 *
 * After the fix, VizCard creates ONE shared instance and passes it down:
 *   - edit.isEditing feeds useVizData's `paused` arg
 *   - the same edit is threaded into VizTable (via VizCardView's `edit` prop)
 *
 * Tests assert:
 *   1. useVizData sees paused=false initially (not editing, not collapsed).
 *   2. useVizData sees paused=true after a cell edit begins via the table.
 *      This proves the SAME edit instance feeds both table and poll.
 *   3. useVizData sees paused=true when collapsed=true (baseline sanity).
 *   4. Beginning a cell edit in VizCard causes the edit's isEditing to flip,
 *      which the captured useVizData calls reflect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { VizSpec, VizRow } from "../src/viz-spec.js";
import type { Client } from "@vault/query-core";
import type { Envelope, Schema, TypeSummary } from "@vault/query-core";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Capture the paused argument each time useVizData is called
const _pausedValues: boolean[] = [];

vi.mock("../src/use-viz-data.js", () => {
  return {
    useVizData: vi.fn((_spec: unknown, paused = false) => {
      _pausedValues.push(paused);
      return {
        rows: _rows,
        total: _rows.length,
        loading: false,
        error: null,
        refresh: vi.fn(),
      };
    }),
  };
});

vi.mock("../src/use-viz-refs.js", () => {
  return { useVizRefFields: vi.fn(() => new Set<string>()) };
});

let _rows: VizRow[] = [];

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { VizCard } from "../src/VizCard.js";
import { _resetCachesForTest } from "../src/use-viz-schema.js";
import { withClient } from "./_render-viz.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_ROW: VizRow = {
  id: "node-poll",
  title: "Poll Test",
  file_path: "test/poll.md",
  types: ["task"],
  fields: { status: "open" },
  version: 1,
};

const TABLE_SPEC: VizSpec = {
  kind: "table",
  title: "Poll pause test",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    {
      name: "status",
      type: "enum" as const,
      required: false,
      default_value: null,
      enum_values: ["open", "done"],
      ui: null,
    },
  ],
};

function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

function makeMockClient(): Client {
  return {
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
      okEnv([{ type: "task", count: 1, has_schema: true, claim_count: null }]),
    ),
    batchMutate: vi.fn(),
  };
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let _mockClient: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  _resetCachesForTest();
  _rows = [{ ...BASE_ROW }];
  _pausedValues.length = 0;
  _mockClient = makeMockClient();
});

afterEach(() => {
  cleanup();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("viz-poll-pause — single shared useVizCellEdit instance", () => {
  it("useVizData receives paused=false initially (not collapsed, not editing)", async () => {
    render(<VizCard spec={TABLE_SPEC} onSpecChange={vi.fn()} />, { wrapper: withClient(_mockClient) });
    await act(async () => { await Promise.resolve(); });

    // First render: not collapsed, not editing → paused=false
    expect(_pausedValues[0]).toBe(false);
  });

  it("useVizData receives paused=true after a cell edit begins via the table", async () => {
    // This test is the core fix invariant:
    //   - VizCard creates ONE shared edit instance
    //   - That instance is passed as `edit` prop to VizCardView → VizTable
    //   - Clicking a cell calls beginEdit on that SAME instance
    //   - VizCard re-renders with edit.isEditing=true → useVizData gets paused=true
    //
    // Before the fix, VizCard.editForPause and VizCardView.edit were DIFFERENT
    // instances: beginEdit updated B, but poll read A → paused never became true.
    const { container } = render(<VizCard spec={TABLE_SPEC} onSpecChange={vi.fn()} />, { wrapper: withClient(_mockClient) });

    // Wait for schema to load (triggers type-lock/schema hooks)
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Reset captured values to isolate the effect of the click
    _pausedValues.length = 0;

    // Click the status cell to begin a cell edit
    const cellInners = container.querySelectorAll("td .cell-inner");
    // Status cell is at index 1 (title at 0)
    const statusCell = cellInners[1] as HTMLElement | null;

    expect(statusCell).not.toBeNull();

    await act(async () => { statusCell!.click(); });
    await act(async () => { await Promise.resolve(); });

    // After beginEdit, the shared edit instance has isEditing=true.
    // VizCard re-renders: useVizData receives (collapsed || edit.isEditing) = true.
    const hasEditingPause = _pausedValues.some((p) => p === true);
    expect(hasEditingPause).toBe(true);
  });

  it("collapsed VizCard: useVizData receives paused=true even without an edit", async () => {
    render(<VizCard spec={TABLE_SPEC} collapsed={true} onToggleCollapse={vi.fn()} />, { wrapper: withClient(_mockClient) });
    await act(async () => { await Promise.resolve(); });

    // collapsed=true → paused=true regardless of editing state
    expect(_pausedValues[0]).toBe(true);
  });

  it("VizCard passes an edit prop to VizCardView (shared instance is threaded down)", async () => {
    // Structural check: VizCard renders a table with .cell-inner elements,
    // which only appear when `editable=true` and `edit` is wired to VizTable.
    // If VizCard forgot to pass `edit` prop and VizCardView defaulted to its
    // own ownEdit, the cells would still render — but the poll-pause would be broken.
    //
    // We verify that VizCard renders table cells AND that beginEdit causes a re-render
    // with paused=true (both require the shared edit instance to be threaded correctly).
    const { container } = render(<VizCard spec={TABLE_SPEC} onSpecChange={vi.fn()} />, { wrapper: withClient(_mockClient) });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // A table with cell-inner elements should be present (table kind + editable)
    const cellInners = container.querySelectorAll("td .cell-inner");
    // At least title and status cells
    expect(cellInners.length).toBeGreaterThanOrEqual(1);

    // Clicking a cell should cause isEditing=true on the edit instance
    _pausedValues.length = 0;
    const statusCell = cellInners[1] as HTMLElement | null;
    expect(statusCell).not.toBeNull();
    await act(async () => { statusCell!.click(); });
    await act(async () => { await Promise.resolve(); });
    // The shared instance's isEditing flipped → useVizData received paused=true
    expect(_pausedValues.some((p) => p === true)).toBe(true);
  });
});
