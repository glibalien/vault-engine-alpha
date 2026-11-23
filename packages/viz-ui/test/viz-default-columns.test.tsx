// @vitest-environment jsdom
/**
 * viz-default-columns.test.tsx
 *
 * TDD tests for:
 *  1. VizCard effectiveSpec — when display_fields:[] + schema has scalar fields,
 *     useVizData receives an effectiveSpec whose include_fields has default columns
 *     (proving effectiveSpec, not spec, is threaded through).
 *  2. VizCard with display_fields already set — unchanged (effectiveSpec === spec).
 *  3. Collapsed prop — VizCard renders header-only (no table/toolbar) when collapsed.
 *     (InlineVizCard's collapse-state wrapper lives in chat and is covered there; the
 *      collapsed RENDERING is a VizCard concern, exercised here via a thin wrapper.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Envelope, Schema, TypeSummary } from "@vault/query-core";
import type { Client } from "@vault/query-core";
import type { VizSpec } from "../src/viz-spec.js";

// ─── Module-level mocks ───────────────────────────────────────────────────────

// Capture every spec passed to useVizData so we can assert effectiveSpec
const _useVizDataCalls: Array<{ spec: VizSpec; paused: boolean }> = [];

vi.mock("../src/use-viz-data.js", () => {
  return {
    useVizData: vi.fn((spec: VizSpec, paused = false) => {
      _useVizDataCalls.push({ spec, paused });
      return { rows: [], total: 0, loading: false, error: null, refresh: vi.fn() };
    }),
  };
});

vi.mock("../src/use-viz-refs.js", () => {
  return { useVizRefFields: vi.fn(() => new Set<string>()) };
});

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { VizCard } from "../src/VizCard.js";
import { _resetCachesForTest } from "../src/use-viz-schema.js";
import { vizQueryArgs } from "../src/viz-spec.js";
import { withClient } from "./_render-viz.js";

// ─── A thin stateful collapse wrapper (mirrors chat's InlineVizCard) ───────────

function CollapsibleViz({
  spec, pinned, onPin, collapsed: initial,
}: { spec: VizSpec; pinned: boolean; onPin: () => void; collapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initial ?? false);
  return (
    <VizCard
      spec={spec}
      pinned={pinned}
      onPin={onPin}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
    />
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

/** A schema with scalar fields + excluded types (link, tags, textarea) + a body-named text field. */
const SCALAR_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    { name: "title",   type: "string",  required: false, default_value: null, ui: { widget: "text" } },
    { name: "status",  type: "enum",    required: false, default_value: null, enum_values: ["open", "done"], ui: { widget: "enum" } },
    { name: "due",     type: "date",    required: false, default_value: null, ui: { widget: "date" } },
    { name: "done",    type: "boolean", required: false, default_value: null, ui: { widget: "bool" } },
    { name: "project", type: "reference", required: false, default_value: null, ui: { widget: "link" } },
    { name: "tags",    type: "list",    required: false, default_value: null, ui: { widget: "tags" } },
    { name: "notes",   type: "string",  required: false, default_value: null, ui: { widget: "textarea" } },
    { name: "body",    type: "string",  required: false, default_value: null, ui: { widget: "text" } },
  ],
};

// Spec with display_fields:[] — synthesized card (Inc 6 query-nodes auto-card)
const EMPTY_DF_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks",
  query: { types: ["task"], limit: 50 },
  display_fields: [],
};

// Spec with display_fields already set — present-viz card (must be unchanged)
const PRESENT_VIZ_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks (preset)",
  query: { types: ["task"], limit: 50 },
  display_fields: ["status"],
};

function makeMockClient(schema = SCALAR_SCHEMA): Client {
  return {
    queryNodes: vi.fn(),
    describeSchema: vi.fn<[string], Promise<Envelope<Schema>>>().mockResolvedValue(okEnv(schema)),
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

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _mockClient: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  _resetCachesForTest();
  _useVizDataCalls.length = 0;
  _mockClient = makeMockClient();
});

afterEach(() => {
  cleanup();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Flush enough microtasks for schema to load. */
async function flushSchema() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VizCard effectiveSpec — display_fields:[] + schema has scalar fields", () => {
  it("useVizData receives a spec whose include_fields contains the default scalar columns after schema loads", async () => {
    render(<VizCard spec={EMPTY_DF_SPEC} />, { wrapper: withClient(_mockClient) });
    await flushSchema();

    // After schema loads, VizCard re-renders with effectiveSpec carrying default columns.
    // useVizData is called with the new effectiveSpec — we find the call whose include_fields has 'title'.
    await waitFor(() => {
      const callWithDefaults = _useVizDataCalls.find((c) => {
        const args = vizQueryArgs(c.spec);
        return args.include_fields.includes("title");
      });
      expect(callWithDefaults).toBeDefined();
      const include = vizQueryArgs(callWithDefaults!.spec).include_fields;
      // Default fields: title, status, due, done (excludes project/tags/notes/body)
      expect(include).toContain("title");
      expect(include).toContain("status");
      expect(include).toContain("due");
      expect(include).toContain("done");
      // Excluded: project (link), tags (tags), notes (textarea), body (name=body)
      expect(include).not.toContain("project");
      expect(include).not.toContain("tags");
      expect(include).not.toContain("notes");
      expect(include).not.toContain("body");
    }, { timeout: 3000 });
  });

  it("after schema loads VizCardView renders the default column headers in the table", async () => {
    render(<VizCard spec={EMPTY_DF_SPEC} onSpecChange={vi.fn()} />, { wrapper: withClient(_mockClient) });
    await flushSchema();

    // After schema loads and effectiveSpec is computed, VizCardView receives default display_fields.
    // VizTable renders <thead> with those field names as column headers.
    // Headers may include sort indicators (e.g. "title↑"), so normalise to alpha-only.
    await waitFor(() => {
      const ths = document.querySelectorAll("thead th");
      const thTexts = Array.from(ths).map(
        (th) => th.textContent?.trim().toLowerCase().replace(/[^a-z]/g, "") ?? "",
      );
      // ALL default scalar field columns must appear
      expect(thTexts).toContain("name");
      expect(thTexts).toContain("status");
      expect(thTexts).toContain("due");
      expect(thTexts).toContain("done");
      // Excluded fields must be absent
      expect(thTexts).not.toContain("project");
      expect(thTexts).not.toContain("tags");
    }, { timeout: 3000 });
  });
});

describe("VizCard effectiveSpec — display_fields already set (present-viz, unchanged)", () => {
  it("a spec with display_fields:['status'] passes only status columns to useVizData", async () => {
    render(<VizCard spec={PRESENT_VIZ_SPEC} />, { wrapper: withClient(_mockClient) });
    await act(async () => { await Promise.resolve(); });

    // The first useVizData call should have display_fields matching the spec's
    expect(_useVizDataCalls.length).toBeGreaterThan(0);
    const firstCall = _useVizDataCalls[0]!;
    const include = vizQueryArgs(firstCall.spec).include_fields;
    // Only 'status' (+ group-by 'status') — no schema-derived defaults
    expect(include).toContain("status");
    // Should NOT contain default columns that weren't in the spec
    expect(include).not.toContain("title");
    expect(include).not.toContain("due");

    // After schema loads, effectiveSpec remains unchanged (display_fields non-empty)
    await flushSchema();
    // All calls should have only 'status' in the spec's display_fields (not the schema defaults)
    const allHaveOnlyStatus = _useVizDataCalls.every((c) => {
      const df = c.spec.display_fields;
      return df.includes("status") && !df.includes("title") && !df.includes("due");
    });
    expect(allHaveOnlyStatus).toBe(true);
  });
});

describe("VizCard collapsed prop (collapse-state wrapper rendering)", () => {
  it("renders collapsed (table body absent) when collapsed=true is passed", async () => {
    render(
      <CollapsibleViz spec={PRESENT_VIZ_SPEC} pinned={false} onPin={vi.fn()} collapsed={true} />,
      { wrapper: withClient(_mockClient) },
    );
    await act(async () => { await Promise.resolve(); });

    // When collapsed, VizCardView renders only the header — no table, no toolbar
    const viz = document.querySelector(".viz");
    expect(viz).toBeTruthy();
    const table = document.querySelector("table");
    expect(table).toBeNull();
    // the toolbar is inside {!collapsed && ...} so it should also be absent
    const foot = document.querySelector(".viz-toolbar");
    expect(foot).toBeNull();
  });

  it("renders expanded (toolbar visible) when collapsed prop is absent (default)", async () => {
    render(
      <CollapsibleViz spec={PRESENT_VIZ_SPEC} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );

    await flushSchema();

    await waitFor(() => {
      const viz = document.querySelector(".viz");
      expect(viz).toBeTruthy();
      // the toolbar is only rendered when !collapsed
      const foot = document.querySelector(".viz-toolbar");
      expect(foot).toBeTruthy();
    }, { timeout: 3000 });
  });
});
