// @vitest-environment jsdom
/**
 * viz-filter-integration.test.tsx
 *
 * Integration test: VizCardView (editable) wires useVizQuery + TypeLockChip +
 * FilterStrip + FieldChips. Stubs /api/mcp-rpc (describe-schema + query-nodes)
 * so no real network calls occur.
 *
 * Asserts:
 *   1. type-lock chip renders when editable
 *   2. filter strip renders when editable
 *   3. field chips render after schema arrives (with locked type + schema)
 *   4. firing a chip edit (enum toggle) calls onSpecChange with a spec whose
 *      query.fields reflects the edit AND whose other parts are preserved
 *   5. strip change calls onSpecChange with updated sort_order, types preserved
 *   6. read-only render (no onSpecChange) shows NO filter UI
 *   7. collapsed card shows no filter UI (persistence boundary)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { Schema, Envelope, TypeSummary } from "@vault/query-core";
import type { VizSpec } from "../src/viz-spec.js";

// --- Mock useVizData so the card doesn't attempt real query-nodes calls ---
vi.mock("../src/use-viz-data.js", () => {
  return {
    useVizData: vi.fn(() => ({
      rows: [],
      total: 0,
      loading: false,
      error: null,
      refresh: vi.fn(),
    })),
  };
});

// --- Mock useVizRefFields so the card doesn't attempt real API calls ---
vi.mock("../src/use-viz-refs.js", () => {
  return {
    useVizRefFields: vi.fn(() => new Set<string>()),
  };
});

import { _resetCachesForTest } from "../src/use-viz-schema.js";
import { VizCardView } from "../src/VizCard.js";
import { withClient } from "./_render-viz.js";

// ---- shared schema fixture ----

const STATUS_FIELD = {
  name: "status",
  type: "enum" as const,
  required: false,
  default_value: null,
  enum_values: ["open", "done"],
  ui: null,
};

const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [STATUS_FIELD],
};

function okEnvelope<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

// ---- shared spec fixture ----

const EDITABLE_SPEC: VizSpec = {
  kind: "table",
  title: "My Tasks",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

// ---- shared mock client ----

const mockClient = {
  describeSchema: vi.fn<[string], Promise<Envelope<Schema>>>(),
  listTypes: vi.fn<[], Promise<Envelope<TypeSummary[]>>>(),
  queryNodes: vi.fn(),
  describeGlobalField: vi.fn(),
  listFieldValues: vi.fn(),
  updateNode: vi.fn(),
  renameNode: vi.fn(),
  getNode: vi.fn(),
  createNode: vi.fn(),
  deleteNode: vi.fn(),
  batchMutate: vi.fn(),
};

beforeEach(() => {
  mockClient.describeSchema.mockReset();
  mockClient.listTypes.mockReset();
  // Default: schema always returns TASK_SCHEMA; can be overridden per test
  mockClient.describeSchema.mockResolvedValue(okEnvelope(TASK_SCHEMA));
  mockClient.listTypes.mockResolvedValue(
    okEnvelope([{ type: "task", count: 5, has_schema: true, claim_count: null }]),
  );
  _resetCachesForTest();
});

afterEach(() => {
  cleanup();
});

// ---- helpers ----

/** Minimal required props for VizCardView. */
function makeBaseProps(onSpecChange?: (next: VizSpec) => void) {
  return {
    spec: EDITABLE_SPEC,
    kind: "table" as const,
    rows: [],
    total: 0,
    loading: false,
    error: null,
    onKind: vi.fn(),
    onRefresh: vi.fn(),
    onSpecChange,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("viz-filter-integration — read-only (no onSpecChange)", () => {
  it("uses plain-language loading and live-result labels", () => {
    render(<VizCardView {...makeBaseProps()} loading />, { wrapper: withClient(mockClient) });
    expect(screen.getByText("Loading vault items…")).toBeDefined();
    expect(screen.getByText("Live")).toBeDefined();
    expect(screen.getByText("0 results")).toBeDefined();
    expect(screen.queryByText(/query-nodes/)).toBeNull();
  });

  it("read-only toolbar keeps Layout + Results but no Sort/Filter/Properties/Search", () => {
    render(<VizCardView {...makeBaseProps()} />, { wrapper: withClient(mockClient) });
    expect(screen.getByRole("button", { name: /^layout: table$/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^sort$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^filter/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^search$/i })).toBeNull();
  });

  it("shows NO filter UI when onSpecChange is absent", () => {
    render(<VizCardView {...makeBaseProps()} />, { wrapper: withClient(mockClient) });
    // None of the filter UI elements should be present
    expect(screen.queryByRole("button", { name: /type lock/i })).toBeNull();
    expect(screen.queryByLabelText("title-contains")).toBeNull();
    expect(screen.queryByLabelText("hybrid-search")).toBeNull();
  });
});

describe("viz-filter-integration — editable card (with onSpecChange)", () => {
  it("renders the type-lock chip inside the Filter popover", () => {
    const onSpecChange = vi.fn();
    render(<VizCardView {...makeBaseProps(onSpecChange)} />, { wrapper: withClient(mockClient) });
    // Closed by default, like Bases; the badge counts the type lock.
    expect(screen.queryByRole("button", { name: /type lock/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^filter/i }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeDefined();
    expect(screen.getByRole("button", { name: /type lock/i })).toBeDefined();
  });

  it("title-contains lives in Filter, hybrid search behind Search, limit behind Results", () => {
    const onSpecChange = vi.fn();
    render(<VizCardView {...makeBaseProps(onSpecChange)} />, { wrapper: withClient(mockClient) });
    expect(screen.queryByLabelText("title-contains")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    // Added from "+ filter" (#617), not shown until then.
    expect(screen.queryByLabelText("title-contains")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "title contains" }));
    expect(screen.getByLabelText("title-contains")).toBeDefined();

    expect(screen.queryByLabelText("hybrid-search")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(screen.getByLabelText("hybrid-search")).toBeDefined();

    expect(screen.queryByLabelText("limit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /results/i }));
    expect(screen.getByLabelText("limit")).toBeDefined();
    expect(screen.queryByLabelText("sort-by")).toBeNull();
  });

  it("renders FieldChips (+ filter) in the Filter popover once schema arrives", async () => {
    const onSpecChange = vi.fn();
    render(<VizCardView {...makeBaseProps(onSpecChange)} />, { wrapper: withClient(mockClient) });
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /\+ filter/i })).toBeDefined();
    });
  });

  it("chip add + enum toggle → onSpecChange with query.fields + preserved strip/types", async () => {
    const onSpecChange = vi.fn();
    render(<VizCardView {...makeBaseProps(onSpecChange)} />, { wrapper: withClient(mockClient) });
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));

    // Wait for "+" filter to appear (schema loaded)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /\+ filter/i })).toBeDefined();
    });

    // Open the add-filter menu and pick "status"
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "status" })).toBeDefined();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "status" }));

    // Wait for the chip to appear
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "open" })).toBeDefined();
    });

    // Toggle the "open" enum value so the filter becomes non-empty
    onSpecChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "open" }));

    // onSpecChange should have been called with a non-empty fields filter
    await waitFor(() => {
      expect(onSpecChange).toHaveBeenCalled();
    });

    const emittedSpec = onSpecChange.mock.calls[onSpecChange.mock.calls.length - 1][0] as VizSpec;

    // Strip and types must be preserved
    expect(emittedSpec.query["types"]).toEqual(["task"]);
    expect(emittedSpec.query["sort_by"]).toBe("title");
    expect(emittedSpec.query["limit"]).toBe(50);

    // fields must contain the status filter
    const fields = emittedSpec.query["fields"] as Record<string, unknown> | undefined;
    expect(fields).toBeDefined();
    expect(fields).toHaveProperty("status");
    expect((fields!["status"] as Record<string, unknown>)["one_of"]).toEqual(["open"]);
  });

  it("Sort popover → onSpecChange called with updated sort_order, types preserved", async () => {
    const onSpecChange = vi.fn();
    render(<VizCardView {...makeBaseProps(onSpecChange)} />, { wrapper: withClient(mockClient) });

    fireEvent.click(screen.getByRole("button", { name: "Sort: Title A–Z" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));

    expect(onSpecChange).toHaveBeenCalled();
    const emitted = onSpecChange.mock.calls[0][0] as VizSpec;
    expect(emitted.query["sort_order"]).toBe("asc");
    expect(emitted.query["sort_by"]).toBe("file_mtime");
    expect(emitted.query["types"]).toEqual(["task"]);
  });

  it("persistence boundary: collapsed card shows no filter UI", () => {
    const onSpecChange = vi.fn();
    render(
      <VizCardView
        {...makeBaseProps(onSpecChange)}
        collapsed={true}
        onToggleCollapse={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Collapsed card: toolbar + body suppressed by !collapsed guard
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /^filter/i })).toBeNull();
  });
});
