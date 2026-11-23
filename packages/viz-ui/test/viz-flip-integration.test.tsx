// @vitest-environment jsdom
/**
 * viz-flip-integration.test.tsx
 *
 * Integration gate for Inc 6 "wiring flip" at the VizCard level:
 *   1. A synthesized auto-card spec (display_fields:[]) rendered collapsed
 *      → starts COLLAPSED; after expanding (click chevron) → a `table` with
 *      schema-derived default columns appears, and the live query's include_fields
 *      carried those columns (captured via the useVizData mock).
 *   2. A present-viz-style spec (display_fields populated) → starts EXPANDED;
 *      columns exactly as specified (no default override).
 *   3. Opt-in pin: NOT pinned by default (aria-pressed="false"); activating the pin
 *      affordance fires onPin exactly once; pinned=true shows the pinned state.
 *
 * The collapse-state wrapper (chat's InlineVizCard) is modelled by a thin local
 * CollapsibleViz; the wrapper's own prop-forwarding is covered in chat's
 * inline-viz-card test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { Envelope, Schema, TypeSummary } from "@vault/query-core";
import type { Client } from "@vault/query-core";
import type { VizSpec } from "../src/viz-spec.js";

// ─── Module-level mocks ───────────────────────────────────────────────────────

// Capture every spec passed to useVizData so we can assert the effective include_fields.
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

/** Schema with scalar + excluded fields. */
const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    { name: "title",   type: "string",    required: false, default_value: null, ui: { widget: "text" } },
    { name: "status",  type: "enum",      required: false, default_value: null, enum_values: ["open", "done"], ui: { widget: "enum" } },
    { name: "due",     type: "date",      required: false, default_value: null, ui: { widget: "date" } },
    { name: "done",    type: "boolean",   required: false, default_value: null, ui: { widget: "bool" } },
    { name: "project", type: "reference", required: false, default_value: null, ui: { widget: "link" } },
    { name: "tags",    type: "list",      required: false, default_value: null, ui: { widget: "tags" } },
    { name: "notes",   type: "string",    required: false, default_value: null, ui: { widget: "textarea" } },
    { name: "body",    type: "string",    required: false, default_value: null, ui: { widget: "text" } },
  ],
};

const AUTO_CARD_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks",
  query: { types: ["task"], limit: 50 },
  display_fields: [],
};

const PRESENT_VIZ_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks (filtered)",
  query: { types: ["task"], limit: 50 },
  display_fields: ["status", "due"],
};

function makeMockClient(schema = TASK_SCHEMA): Client {
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

async function flushSchema() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("viz-flip-integration — auto-card collapsed + expand + default columns", () => {
  it("auto-card (display_fields:[], collapsed) starts collapsed — no table body or toolbar", async () => {
    render(
      <CollapsibleViz spec={AUTO_CARD_SPEC} collapsed={true} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );
    await act(async () => { await Promise.resolve(); });

    expect(document.querySelector(".viz")).toBeTruthy();
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelector(".viz-toolbar")).toBeNull();
  });

  it("expanding the auto-card shows a table with schema-derived default columns", async () => {
    render(
      <CollapsibleViz spec={AUTO_CARD_SPEC} collapsed={true} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );

    await flushSchema();

    const chevBtn = document.querySelector(".viz-chev") as HTMLElement;
    expect(chevBtn).toBeTruthy();
    await act(async () => { fireEvent.click(chevBtn); });

    await waitFor(() => {
      expect(document.querySelector(".viz-toolbar")).toBeTruthy();
    }, { timeout: 3000 });

    await waitFor(() => {
      const ths = Array.from(document.querySelectorAll("thead th")).map(
        (th) => th.textContent?.trim().toLowerCase().replace(/[^a-z]/g, "") ?? "",
      );
      expect(ths).toContain("title");
      expect(ths).toContain("status");
      expect(ths).toContain("due");
      expect(ths).toContain("done");
      expect(ths).not.toContain("project");
      expect(ths).not.toContain("tags");
    }, { timeout: 3000 });
  });

  it("after expanding, the live query's include_fields carried the schema-derived default columns", async () => {
    render(
      <CollapsibleViz spec={AUTO_CARD_SPEC} collapsed={true} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );

    await flushSchema();

    const chevBtn = document.querySelector(".viz-chev") as HTMLElement;
    await act(async () => { fireEvent.click(chevBtn); });

    await waitFor(() => {
      const callWithDefaults = _useVizDataCalls.find((c) => {
        const args = vizQueryArgs(c.spec);
        return args.include_fields.includes("title");
      });
      expect(callWithDefaults).toBeDefined();
      const include = vizQueryArgs(callWithDefaults!.spec).include_fields;
      expect(include).toContain("title");
      expect(include).toContain("status");
      expect(include).toContain("due");
      expect(include).toContain("done");
      expect(include).not.toContain("project");
      expect(include).not.toContain("tags");
      expect(include).not.toContain("notes");
      expect(include).not.toContain("body");
    }, { timeout: 3000 });
  });
});

describe("viz-flip-integration — present-viz card starts expanded", () => {
  it("present-viz card (display_fields populated, not collapsed) starts expanded with specified columns", async () => {
    render(
      <CollapsibleViz spec={PRESENT_VIZ_SPEC} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );

    await flushSchema();

    await waitFor(() => {
      expect(document.querySelector(".viz-toolbar")).toBeTruthy();
    }, { timeout: 3000 });
  });

  it("present-viz card uses only the specified display_fields — no default override", async () => {
    render(
      <CollapsibleViz spec={PRESENT_VIZ_SPEC} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );

    await act(async () => { await Promise.resolve(); });

    expect(_useVizDataCalls.length).toBeGreaterThan(0);
    const firstCall = _useVizDataCalls[0]!;
    const include = vizQueryArgs(firstCall.spec).include_fields;
    expect(include).toContain("status");
    expect(include).toContain("due");
    expect(include).not.toContain("title");
    expect(include).not.toContain("done");

    await flushSchema();
    for (const c of _useVizDataCalls) {
      const inc = vizQueryArgs(c.spec).include_fields;
      expect(inc).toContain("status");
      expect(inc).toContain("due");
      expect(inc).not.toContain("title");
      expect(inc).not.toContain("done");
    }
  });
});

describe("viz-flip-integration — opt-in pin on auto-card", () => {
  it("auto-card renders NOT pinned by default (pinned=false → aria-pressed='false', text='pin')", async () => {
    render(
      <CollapsibleViz spec={AUTO_CARD_SPEC} collapsed={true} pinned={false} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );
    await act(async () => { await Promise.resolve(); });

    const pinBtn = document.querySelector(".viz-btn") as HTMLElement;
    expect(pinBtn).toBeTruthy();
    expect(pinBtn.getAttribute("aria-pressed")).toBe("false");
    expect(pinBtn.textContent?.toLowerCase()).toContain("pin");
    expect(pinBtn.textContent?.toLowerCase()).not.toContain("pinned");
  });

  it("activating the pin affordance fires onPin exactly once", async () => {
    const onPin = vi.fn();
    render(
      <CollapsibleViz spec={AUTO_CARD_SPEC} collapsed={true} pinned={false} onPin={onPin} />,
      { wrapper: withClient(_mockClient) },
    );
    await act(async () => { await Promise.resolve(); });

    const pinBtn = document.querySelector(".viz-btn") as HTMLElement;
    expect(pinBtn).toBeTruthy();
    expect(onPin).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(pinBtn); });

    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("pinned=true renders pin button as aria-pressed='true' with 'pinned' label", async () => {
    render(
      <CollapsibleViz spec={AUTO_CARD_SPEC} collapsed={true} pinned={true} onPin={vi.fn()} />,
      { wrapper: withClient(_mockClient) },
    );
    await act(async () => { await Promise.resolve(); });

    const pinBtn = document.querySelector(".viz-btn") as HTMLElement;
    expect(pinBtn).toBeTruthy();
    expect(pinBtn.getAttribute("aria-pressed")).toBe("true");
    expect(pinBtn.textContent?.toLowerCase()).toContain("pinned");
  });
});
