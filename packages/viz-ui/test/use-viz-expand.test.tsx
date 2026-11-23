// @vitest-environment jsdom
/**
 * use-viz-expand.test.tsx
 *
 * TDD tests for useVizSchemas + useVizExpand hooks.
 * Written BEFORE the implementation (Step 1 — expect RED).
 *
 * Covers:
 *  - useVizSchemas: resolves Map<string,Schema> from listTypes + describeSchema; reuses cache
 *  - nodeRowToVizRow: defaults for null title/missing fields
 *  - childDisplayFields / childRefFields: schema-derived helpers
 *  - pairs / hasCaret: expansionPairs wiring + boolean
 *  - toggle expand: queryNodes → group stored; busy:true placeholder before resolve
 *  - toggle same pair again → collapse discards
 *  - caretClick: 1 pair → toggles; >1 pairs → opens menu (no fetch); already open → collapses
 *  - toggle !ok envelope → parent NOT in expanded
 *  - reconcile: vanished parent dropped; survivor re-queried
 *  - unresolvedWarning: CROSS_NODE_FILTER_UNRESOLVED warning → group.unresolvedWarning:true
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, act, renderHook, waitFor } from "@testing-library/react";
import React from "react";

import { _resetCachesForTest, useVizSchemas } from "../src/use-viz-schema.js";
import { withClient } from "./_render-viz.js";
import {
  nodeRowToVizRow,
  childDisplayFields,
  childRefFields,
  useVizExpand,
} from "../src/use-viz-expand.js";

import type { Client } from "@vault/query-core";
import type { Schema, NodeRow, ExpandPair, QueryNodesData } from "@vault/query-core";
import type { Envelope } from "@vault/query-core";
import type { VizRow } from "../src/viz-spec.js";

// ============================================================================
// Helpers / fixtures
// ============================================================================

function okEnvelope<T>(data: T, warnings: Array<{ code: string; message: string; severity: "error" | "warning" }> = []): Envelope<T> {
  return { ok: true, data, warnings };
}

function failEnvelope(code: string, message: string): Envelope<never> {
  return { ok: false as const, error: { code, message }, warnings: [] };
}

/** A schema with a reference field pointing at "task" */
function makeSubtaskSchema(): Schema {
  return {
    name: "subtask",
    display_name: "Sub-task",
    fields: [
      { name: "parent", type: "reference", required: false, default_value: null, reference_target: "task", ui: null },
      { name: "status", type: "enum", required: false, default_value: null, enum_values: ["open", "done"], ui: null },
      { name: "due", type: "date", required: false, default_value: null, ui: null },
      { name: "priority", type: "string", required: false, default_value: null, ui: null },
      { name: "assignee", type: "string", required: false, default_value: null, ui: null },
      { name: "note", type: "string", required: false, default_value: null, ui: null },
    ],
  };
}

function makeTaskSchema(): Schema {
  return {
    name: "task",
    display_name: "Task",
    fields: [
      { name: "status", type: "enum", required: false, default_value: null, enum_values: ["open", "done"], ui: null },
    ],
  };
}

function makeNodeRow(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: "n1",
    file_path: "notes/n1.md",
    title: "Node One",
    types: ["subtask"],
    version: 3,
    field_count: 2,
    fields: { status: "open" },
    ...overrides,
  };
}

/** Minimal mock client */
function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    queryNodes: vi.fn(),
    describeSchema: vi.fn(),
    listTypes: vi.fn(),
    describeGlobalField: vi.fn(),
    listFieldValues: vi.fn(),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    getNode: vi.fn(),
    createNode: vi.fn(),
    deleteNode: vi.fn(),
    batchMutate: vi.fn(),
    ...overrides,
  } as Client;
}

/** Map with task+subtask schemas */
function makeAllSchemas(): Map<string, Schema> {
  return new Map([
    ["task", makeTaskSchema()],
    ["subtask", makeSubtaskSchema()],
  ]);
}

const mockSchemasClient = {
  describeSchema: vi.fn<[string], Promise<Envelope<Schema>>>(),
  listTypes: vi.fn(),
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
  mockSchemasClient.describeSchema.mockReset();
  mockSchemasClient.listTypes.mockReset();
  _resetCachesForTest();
});

afterEach(() => {
  cleanup();
});

// ============================================================================
// useVizSchemas
// ============================================================================

describe("useVizSchemas", () => {
  it("returns empty Map initially then resolves a Map of schemas after all fetches complete", async () => {
    mockSchemasClient.listTypes.mockResolvedValueOnce(
      okEnvelope([
        { type: "task", count: 5, has_schema: true, claim_count: null },
        { type: "note", count: 3, has_schema: true, claim_count: null },
      ])
    );
    mockSchemasClient.describeSchema
      .mockImplementation(async (name: string) => okEnvelope({ name, display_name: name, fields: [] }));

    const { result } = renderHook(() => useVizSchemas(), { wrapper: withClient(mockSchemasClient) });

    // initial render: empty map
    expect(result.current.size).toBe(0);

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.has("task")).toBe(true);
    expect(result.current.has("note")).toBe(true);
  });

  it("reuses schema cache — no re-describeSchema on second renderHook", async () => {
    mockSchemasClient.listTypes.mockResolvedValue(
      okEnvelope([{ type: "task", count: 1, has_schema: true, claim_count: null }])
    );
    mockSchemasClient.describeSchema.mockResolvedValue(okEnvelope(makeTaskSchema()));

    const { result: r1, unmount } = renderHook(() => useVizSchemas(), { wrapper: withClient(mockSchemasClient) });
    await waitFor(() => expect(r1.current.size).toBe(1));
    unmount();

    const { result: r2 } = renderHook(() => useVizSchemas(), { wrapper: withClient(mockSchemasClient) });
    await waitFor(() => expect(r2.current.size).toBe(1));

    // describeSchema called only once across both mounts
    expect(mockSchemasClient.describeSchema).toHaveBeenCalledTimes(1);
  });

  it("degrades to empty Map when listTypes fails", async () => {
    mockSchemasClient.listTypes.mockResolvedValueOnce(
      failEnvelope("INTERNAL", "list-types failed") as unknown as Envelope<unknown>
    );

    const { result } = renderHook(() => useVizSchemas(), { wrapper: withClient(mockSchemasClient) });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(result.current.size).toBe(0);
  });
});

// ============================================================================
// nodeRowToVizRow
// ============================================================================

describe("nodeRowToVizRow", () => {
  it("maps a full NodeRow to VizRow", () => {
    const row = makeNodeRow();
    const viz = nodeRowToVizRow(row);
    expect(viz.id).toBe("n1");
    expect(viz.title).toBe("Node One");
    expect(viz.file_path).toBe("notes/n1.md");
    expect(viz.types).toEqual(["subtask"]);
    expect(viz.fields).toEqual({ status: "open" });
    expect(viz.version).toBe(3);
  });

  it("defaults null title to empty string", () => {
    const row = makeNodeRow({ title: null });
    const viz = nodeRowToVizRow(row);
    expect(viz.title).toBe("");
  });

  it("defaults missing fields to empty object", () => {
    const row = makeNodeRow({ fields: undefined });
    const viz = nodeRowToVizRow(row);
    expect(viz.fields).toEqual({});
  });
});

// ============================================================================
// childDisplayFields / childRefFields
// ============================================================================

describe("childDisplayFields", () => {
  it("returns up to 5 field names from claimedFields", () => {
    const schema = makeSubtaskSchema(); // 6 fields
    const result = childDisplayFields(schema);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe("parent");
    expect(result[4]).toBe("assignee");
  });

  it("returns all fields when fewer than 5", () => {
    const schema = makeTaskSchema(); // 1 field
    expect(childDisplayFields(schema)).toEqual(["status"]);
  });
});

describe("childRefFields", () => {
  it("returns a Set of reference field names", () => {
    const schema = makeSubtaskSchema();
    const refs = childRefFields(schema);
    expect(refs).toBeInstanceOf(Set);
    expect(refs.has("parent")).toBe(true);
    // non-reference fields not included
    expect(refs.has("status")).toBe(false);
  });

  it("returns empty Set when no reference fields", () => {
    const refs = childRefFields(makeTaskSchema());
    expect(refs.size).toBe(0);
  });
});

// ============================================================================
// useVizExpand — pairs / hasCaret
// ============================================================================

describe("useVizExpand pairs/hasCaret", () => {
  it("pairs=[{childType:subtask, viaField:parent}] when subtask.parent refs task; hasCaret true", () => {
    const client = makeClient();
    const allSchemas = makeAllSchemas();
    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    expect(result.current.pairs).toHaveLength(1);
    expect(result.current.pairs[0]).toEqual({ childType: "subtask", viaField: "parent" });
    expect(result.current.hasCaret).toBe(true);
  });

  it("pairs empty + hasCaret false when lockedType is ''", () => {
    const client = makeClient();
    const allSchemas = makeAllSchemas();
    const { result } = renderHook(() => useVizExpand(client, allSchemas, ""));

    expect(result.current.pairs).toHaveLength(0);
    expect(result.current.hasCaret).toBe(false);
  });

  it("pairs empty + hasCaret false when no schema references lockedType", () => {
    const client = makeClient();
    const allSchemas = makeAllSchemas();
    const { result } = renderHook(() => useVizExpand(client, allSchemas, "note"));

    expect(result.current.pairs).toHaveLength(0);
    expect(result.current.hasCaret).toBe(false);
  });
});

// ============================================================================
// useVizExpand — toggle expand
// ============================================================================

describe("useVizExpand toggle", () => {
  it("expand: queryNodes returns 2 child rows → group stored with rows, busy:false", async () => {
    const childRows = [makeNodeRow({ id: "c1" }), makeNodeRow({ id: "c2" })];
    const queryNodes = vi.fn<[unknown], Promise<Envelope<QueryNodesData>>>().mockResolvedValue(
      okEnvelope({ nodes: childRows, total: 2 })
    );
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    await act(async () => {
      await result.current.toggle("p1", pair);
    });

    const group = result.current.expanded.get("p1");
    expect(group).toBeDefined();
    expect(group!.busy).toBe(false);
    expect(group!.rows).toHaveLength(2);
    expect(group!.childType).toBe("subtask");
    expect(group!.viaField).toBe("parent");
    expect(queryNodes).toHaveBeenCalledTimes(1);
  });

  it("busy:true placeholder is set before queryNodes resolves", async () => {
    let resolveFetch!: (v: Envelope<QueryNodesData>) => void;
    const fetchPromise = new Promise<Envelope<QueryNodesData>>((res) => { resolveFetch = res; });
    const queryNodes = vi.fn().mockReturnValue(fetchPromise);
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    // Start toggle but don't await (so placeholder is visible)
    act(() => { void result.current.toggle("p1", pair); });

    // The placeholder should be set synchronously before fetch completes
    await waitFor(() => {
      const group = result.current.expanded.get("p1");
      return group !== undefined && group.busy === true;
    });
    expect(result.current.expanded.get("p1")?.busy).toBe(true);

    // Resolve the fetch
    await act(async () => {
      resolveFetch(okEnvelope({ nodes: [], total: 0 }));
      await fetchPromise;
    });
    expect(result.current.expanded.get("p1")?.busy).toBe(false);
  });

  it("same pair again → collapse discards the group", async () => {
    const queryNodes = vi.fn().mockResolvedValue(okEnvelope({ nodes: [makeNodeRow()], total: 1 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    // Expand
    await act(async () => { await result.current.toggle("p1", pair); });
    expect(result.current.expanded.has("p1")).toBe(true);

    // Collapse (same pair)
    await act(async () => { await result.current.toggle("p1", pair); });
    expect(result.current.expanded.has("p1")).toBe(false);
    // queryNodes only called once (collapse doesn't re-fetch)
    expect(queryNodes).toHaveBeenCalledTimes(1);
  });

  it("!ok envelope → parent NOT in expanded", async () => {
    const queryNodes = vi.fn().mockResolvedValue(
      failEnvelope("QUERY_FAILED", "bad query") as unknown as Envelope<QueryNodesData>
    );
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    await act(async () => { await result.current.toggle("p1", pair); });
    expect(result.current.expanded.has("p1")).toBe(false);
  });

  it("swap path: toggle(p1, pairB) while pairA is open → group switches to pairB", async () => {
    // Use allSchemas with two child types referencing "task"
    const allSchemas = new Map<string, Schema>([
      ["task", makeTaskSchema()],
      ["subtask", makeSubtaskSchema()],
      ["child2", {
        name: "child2",
        display_name: "Child2",
        fields: [
          { name: "task_ref", type: "reference", required: false, default_value: null, reference_target: "task", ui: null },
        ],
      }],
    ]);
    const childRowsA = [makeNodeRow({ id: "a1", types: ["subtask"] })];
    const childRowsB = [makeNodeRow({ id: "b1", types: ["child2"] }), makeNodeRow({ id: "b2", types: ["child2"] })];
    const queryNodes = vi.fn<[unknown], Promise<Envelope<QueryNodesData>>>()
      .mockResolvedValueOnce(okEnvelope({ nodes: childRowsA, total: 1 }))
      .mockResolvedValueOnce(okEnvelope({ nodes: childRowsB, total: 2 }));
    const client = makeClient({ queryNodes });

    const pairA: ExpandPair = { childType: "subtask", viaField: "parent" };
    const pairB: ExpandPair = { childType: "child2", viaField: "task_ref" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    // First expand with pairA
    await act(async () => { await result.current.toggle("p1", pairA); });
    expect(result.current.expanded.get("p1")?.childType).toBe("subtask");

    // Swap to pairB while pairA is open
    await act(async () => { await result.current.toggle("p1", pairB); });

    const group = result.current.expanded.get("p1");
    expect(group).toBeDefined();
    // The group should now reflect pairB's childType
    expect(group!.childType).toBe("child2");
    expect(group!.busy).toBe(false);
    expect(queryNodes).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// useVizExpand — caretClick
// ============================================================================

describe("useVizExpand caretClick", () => {
  it("1 pair → caretClick toggles open (calls toggle)", async () => {
    const queryNodes = vi.fn().mockResolvedValue(okEnvelope({ nodes: [], total: 0 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    await act(async () => { result.current.caretClick("p1"); });

    // After caretClick with 1 pair, the group should be created (even if empty rows)
    await waitFor(() => expect(result.current.expanded.has("p1")).toBe(true));
  });

  it(">1 pairs → caretClick opens menu (expandMenuFor=p1, no fetch)", async () => {
    // Make allSchemas have two schemas that both ref task
    const allSchemas = new Map<string, Schema>([
      ["task", makeTaskSchema()],
      ["subtask", makeSubtaskSchema()],
      ["child2", {
        name: "child2",
        display_name: "Child2",
        fields: [
          { name: "task_ref", type: "reference", required: false, default_value: null, reference_target: "task", ui: null },
        ],
      }],
    ]);
    const queryNodes = vi.fn();
    const client = makeClient({ queryNodes });

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    expect(result.current.pairs).toHaveLength(2);

    act(() => { result.current.caretClick("p1"); });

    expect(result.current.expandMenuFor).toBe("p1");
    // No fetch should have been initiated
    expect(queryNodes).not.toHaveBeenCalled();
  });

  it("already open → caretClick collapses", async () => {
    const queryNodes = vi.fn().mockResolvedValue(okEnvelope({ nodes: [], total: 0 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    // Open
    await act(async () => { result.current.caretClick("p1"); });
    await waitFor(() => expect(result.current.expanded.has("p1")).toBe(true));

    // Close
    await act(async () => { result.current.caretClick("p1"); });
    await waitFor(() => expect(result.current.expanded.has("p1")).toBe(false));
  });
});

// ============================================================================
// useVizExpand — unresolvedWarning
// ============================================================================

describe("useVizExpand unresolvedWarning", () => {
  it("CROSS_NODE_FILTER_UNRESOLVED warning → group.unresolvedWarning:true", async () => {
    const queryNodes = vi.fn().mockResolvedValue(
      okEnvelope({ nodes: [], total: 0 }, [
        { code: "CROSS_NODE_FILTER_UNRESOLVED", message: "unresolved", severity: "warning" as const },
      ])
    );
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    await act(async () => { await result.current.toggle("p1", pair); });

    const group = result.current.expanded.get("p1");
    expect(group).toBeDefined();
    expect(group!.unresolvedWarning).toBe(true);
  });
});

// ============================================================================
// useVizExpand — reconcile
// ============================================================================

describe("useVizExpand reconcile", () => {
  it("p1 open, liveRows lacks p1 → p1 dropped from expanded", async () => {
    const queryNodes = vi.fn().mockResolvedValue(okEnvelope({ nodes: [makeNodeRow()], total: 1 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    // Expand p1
    await act(async () => { await result.current.toggle("p1", pair); });
    expect(result.current.expanded.has("p1")).toBe(true);

    // liveRows does not include p1
    const liveRows: VizRow[] = [
      { id: "p2", title: "P2", file_path: "p2.md", types: ["task"], fields: {} },
    ];

    await act(async () => { await result.current.reconcile(liveRows); });
    expect(result.current.expanded.has("p1")).toBe(false);
  });

  it("p1 present in liveRows → re-queryNodes called, group refreshed", async () => {
    const queryNodes = vi.fn()
      .mockResolvedValueOnce(okEnvelope({ nodes: [makeNodeRow({ id: "c1" })], total: 1 }))
      .mockResolvedValueOnce(okEnvelope({ nodes: [makeNodeRow({ id: "c1" }), makeNodeRow({ id: "c2" })], total: 2 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    // Expand p1
    await act(async () => { await result.current.toggle("p1", pair); });
    expect(result.current.expanded.get("p1")!.rows).toHaveLength(1);

    // liveRows includes p1
    const liveRows: VizRow[] = [
      { id: "p1", title: "P1", file_path: "p1.md", types: ["task"], fields: {} },
    ];

    await act(async () => { await result.current.reconcile(liveRows); });

    expect(queryNodes).toHaveBeenCalledTimes(2);
    expect(result.current.expanded.get("p1")!.rows).toHaveLength(2);
  });

  it("reconcile on empty expanded is a no-op (early return)", async () => {
    const queryNodes = vi.fn();
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    const liveRows: VizRow[] = [
      { id: "p1", title: "P1", file_path: "p1.md", types: ["task"], fields: {} },
    ];

    await act(async () => { await result.current.reconcile(liveRows); });
    expect(queryNodes).not.toHaveBeenCalled();
  });
});

// ============================================================================
// useVizExpand — collapseAll + closeMenu + isOpen
// ============================================================================

describe("useVizExpand misc", () => {
  it("collapseAll clears all expanded groups", async () => {
    const queryNodes = vi.fn().mockResolvedValue(okEnvelope({ nodes: [], total: 0 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    await act(async () => {
      await result.current.toggle("p1", pair);
      await result.current.toggle("p2", pair);
    });
    expect(result.current.expanded.size).toBe(2);

    act(() => { result.current.collapseAll(); });
    expect(result.current.expanded.size).toBe(0);
  });

  it("closeMenu clears expandMenuFor", () => {
    const allSchemas = new Map<string, Schema>([
      ["task", makeTaskSchema()],
      ["subtask", makeSubtaskSchema()],
      ["child2", {
        name: "child2",
        display_name: "Child2",
        fields: [
          { name: "task_ref", type: "reference", required: false, default_value: null, reference_target: "task", ui: null },
        ],
      }],
    ]);
    const client = makeClient();
    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    act(() => { result.current.caretClick("p1"); });
    expect(result.current.expandMenuFor).toBe("p1");

    act(() => { result.current.closeMenu(); });
    expect(result.current.expandMenuFor).toBeNull();
  });

  it("isOpen returns true only for an expanded parent", async () => {
    const queryNodes = vi.fn().mockResolvedValue(okEnvelope({ nodes: [], total: 0 }));
    const client = makeClient({ queryNodes });
    const allSchemas = makeAllSchemas();
    const pair: ExpandPair = { childType: "subtask", viaField: "parent" };

    const { result } = renderHook(() => useVizExpand(client, allSchemas, "task"));

    expect(result.current.isOpen("p1")).toBe(false);

    await act(async () => { await result.current.toggle("p1", pair); });
    expect(result.current.isOpen("p1")).toBe(true);
    expect(result.current.isOpen("p2")).toBe(false);
  });
});
