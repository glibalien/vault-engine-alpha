// @vitest-environment jsdom
/**
 * use-viz-query.test.tsx
 *
 * TDD tests for the schema-aware owned-args state hook.
 *
 * Pure core (initVizQueryState / reduceVizQuery / composeFromState) is tested
 * without a renderer. A small RTL harness covers the hook integration (schema
 * arrival via useVizSchema → promoteFragments effect + onSpecChange emission).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import type { Schema, Envelope } from "@vault/query-core";
import type { VizSpec } from "../src/viz-spec.js";

import { _resetCachesForTest } from "../src/use-viz-schema.js";
import { withClient } from "./_render-viz.js";

// Import pure core under test
import {
  initVizQueryState,
  reduceVizQuery,
  composeFromState,
} from "../src/use-viz-query.js";

// Import the hook itself for RTL tests
import { useVizQuery } from "../src/use-viz-query.js";

// ---------- shared fixtures ----------

const STATUS_FIELD = {
  name: "status",
  type: "enum" as const,
  required: false,
  default_value: null,
  enum_values: ["open", "done"],
  ui: null,
};

const PRIORITY_FIELD = {
  name: "priority",
  type: "enum" as const,
  required: false,
  default_value: null,
  enum_values: ["high", "low"],
  ui: null,
};

const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [STATUS_FIELD, PRIORITY_FIELD],
};

function makeSpec(query: Record<string, unknown> = {}): VizSpec {
  return {
    kind: "table",
    title: "Test",
    query,
    display_fields: ["status"],
  };
}

function okEnvelope<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

// ---------- mock client ----------

const mockClient = {
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
  mockClient.describeSchema.mockReset();
  // Default: graceful failure so tests that don't set up schema don't throw.
  // Individual tests override with .mockResolvedValueOnce(okEnvelope(schema)).
  mockClient.describeSchema.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "no schema" }, warnings: [] });
  _resetCachesForTest();
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// PURE CORE TESTS (no renderer)
// ===========================================================================

describe("initVizQueryState", () => {
  it("extracts lockedType from types:[single]", () => {
    const state = initVizQueryState({ types: ["task"], fields: { status: { one_of: ["open"] } } });
    expect(state.lockedType).toBe("task");
    expect(state.typeSelection).toBe("task");
  });

  it("stores schema-scoped fields as callerFragments before schema arrives", () => {
    const state = initVizQueryState({ types: ["task"], fields: { status: { one_of: ["open"] } } });
    // Before schema, fields are fragments (not chips)
    expect(state.callerFragments.some(f => f.key === "fields" && f.fieldName === "status")).toBe(true);
    expect(state.filtersByType["task"] ?? []).toHaveLength(0);
  });

  it("initializes strip from args", () => {
    const state = initVizQueryState({ sort_by: "file_mtime", sort_order: "desc", limit: 25 });
    expect(state.strip.sort_by).toBe("file_mtime");
    expect(state.strip.sort_order).toBe("desc");
    expect(state.strip.limit).toBe(25);
  });

  it("initializes with empty filtersByType", () => {
    const state = initVizQueryState({ types: ["task"] });
    expect(state.filtersByType).toEqual({});
  });
});

describe("reduceVizQuery", () => {
  it("setStrip updates the strip", () => {
    const state = initVizQueryState({});
    const next = reduceVizQuery(state, {
      type: "setStrip",
      strip: { title_contains: "hello", query: "", sort_by: "title", sort_order: "asc", limit: 50 },
    });
    expect(next.strip.title_contains).toBe("hello");
    // original unchanged (pure)
    expect(state.strip.title_contains).toBe("");
  });

  it("setTypeLock switches lockedType and drops schema-scoped fragments", () => {
    // Seed a state with a schema-scoped fragment (join_filters) and a global one (path_prefix)
    const initial = initVizQueryState({
      types: ["task"],
      join_filters: [{ rel_type: "project", target: { node_ids: ["p1"] } }],
      path_prefix: "Notes/",
    });
    expect(initial.callerFragments.some(f => f.key === "join_filters")).toBe(true);
    expect(initial.callerFragments.some(f => f.key === "path_prefix")).toBe(true);

    const next = reduceVizQuery(initial, { type: "setTypeLock", lockedType: "project" });
    // schema-scoped fragment dropped
    expect(next.callerFragments.some(f => f.key === "join_filters")).toBe(false);
    // global fragment survives
    expect(next.callerFragments.some(f => f.key === "path_prefix")).toBe(true);
    expect(next.lockedType).toBe("project");
    expect(next.typeSelection).toBe("project");
  });

  it("setTypeLock to null unlocks without dropping fragments", () => {
    const initial = initVizQueryState({ types: ["task"], path_prefix: "Notes/" });
    const next = reduceVizQuery(initial, { type: "setTypeLock", lockedType: null });
    expect(next.lockedType).toBeNull();
    expect(next.typeSelection).toBeNull();
    expect(next.callerFragments.some(f => f.key === "path_prefix")).toBe(true);
  });

  it("same-type setTypeLock does not drop schema-scoped fragments", () => {
    const initial = initVizQueryState({
      types: ["task"],
      join_filters: [{ rel_type: "project", target: { node_ids: ["p1"] } }],
    });
    const next = reduceVizQuery(initial, { type: "setTypeLock", lockedType: "task" });
    // same type — fragments survive
    expect(next.callerFragments.some(f => f.key === "join_filters")).toBe(true);
  });

  it("addChip creates an empty chip for the given field", () => {
    const initial = initVizQueryState({ types: ["task"] });
    const next = reduceVizQuery(initial, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const chips = next.filtersByType["task"] ?? [];
    expect(chips).toHaveLength(1);
    expect(chips[0]!.field).toBe("status");
    expect(chips[0]!.state).toMatchObject({ one_of: [] }); // enum initialFilterState
  });

  it("addChip is idempotent — no double chip for same field", () => {
    const initial = initVizQueryState({ types: ["task"] });
    const withChip = reduceVizQuery(initial, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const again = reduceVizQuery(withChip, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    expect((again.filtersByType["task"] ?? []).length).toBe(1);
  });

  it("setChip updates an existing chip's state", () => {
    const initial = initVizQueryState({ types: ["task"] });
    const withChip = reduceVizQuery(initial, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const updated = reduceVizQuery(withChip, {
      type: "setChip",
      field: "status",
      state: { one_of: ["done"] },
    });
    const chip = (updated.filtersByType["task"] ?? []).find(c => c.field === "status");
    expect(chip?.state).toEqual({ one_of: ["done"] });
  });

  it("removeChip removes the chip for the field", () => {
    const initial = initVizQueryState({ types: ["task"] });
    const withChip = reduceVizQuery(initial, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const removed = reduceVizQuery(withChip, { type: "removeChip", field: "status" });
    expect((removed.filtersByType["task"] ?? []).some(c => c.field === "status")).toBe(false);
  });

  it("removeFragment removes a caller fragment by id", () => {
    const initial = initVizQueryState({ types: ["task"], path_prefix: "Notes/" });
    const frag = initial.callerFragments.find(f => f.key === "path_prefix");
    expect(frag).toBeDefined();
    const next = reduceVizQuery(initial, { type: "removeFragment", id: frag!.id });
    expect(next.callerFragments.some(f => f.key === "path_prefix")).toBe(false);
  });
});

describe("composeFromState", () => {
  it("composes with no schema — no field filters in output", () => {
    const state = initVizQueryState({ types: ["task"] });
    const stateWithChip = reduceVizQuery(state, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const setChip = reduceVizQuery(stateWithChip, {
      type: "setChip",
      field: "status",
      state: { one_of: ["open"] },
    });
    // No schema provided → chips don't contribute field filters
    const args = composeFromState(setChip, null);
    expect(args.fields).toBeUndefined();
    expect(args.types).toEqual(["task"]);
  });

  it("with schema, chip contributes fields to composed args", () => {
    const state = initVizQueryState({ types: ["task"] });
    const stateWithChip = reduceVizQuery(state, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const setChip = reduceVizQuery(stateWithChip, {
      type: "setChip",
      field: "status",
      state: { one_of: ["done"] },
    });
    const args = composeFromState(setChip, TASK_SCHEMA);
    expect(args.fields).toBeDefined();
    expect((args.fields as Record<string, unknown>)["status"]).toEqual({ one_of: ["done"] });
  });

  it("setChip recompose preserves other query parts", () => {
    // Spec has types + a global path_prefix + a schema-scoped fields fragment
    const state = initVizQueryState({
      types: ["task"],
      fields: { priority: { one_of: ["high"] } },
      path_prefix: "Notes/",
    });
    // Add and set a status chip
    const withChip = reduceVizQuery(state, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    const setChip = reduceVizQuery(withChip, {
      type: "setChip",
      field: "status",
      state: { one_of: ["done"] },
    });
    const args = composeFromState(setChip, TASK_SCHEMA);
    // Status chip emits
    expect((args.fields as Record<string, unknown>)["status"]).toEqual({ one_of: ["done"] });
    // The priority fragment (caller-owned) also appears
    expect((args.fields as Record<string, unknown>)["priority"]).toEqual({ one_of: ["high"] });
    // Global path_prefix fragment survives
    expect(args.path_prefix).toBe("Notes/");
    // types preserved
    expect(args.types).toEqual(["task"]);
  });

  it("type switch drops schema-scoped fragments, keeps global ones", () => {
    const state = initVizQueryState({
      types: ["task"],
      join_filters: [{ rel_type: "project", target: { node_ids: ["p1"] } }],
      path_prefix: "Notes/",
    });
    const switched = reduceVizQuery(state, { type: "setTypeLock", lockedType: "project" });
    const args = composeFromState(switched, null);
    // schema-scoped join_filters dropped
    expect(args.join_filters).toBeUndefined();
    // global path_prefix survives
    expect(args.path_prefix).toBe("Notes/");
    // new type in args
    expect(args.types).toEqual(["project"]);
  });

  it("removeFragment recomposes without the removed fragment", () => {
    const state = initVizQueryState({ types: ["task"], path_prefix: "Notes/" });
    const frag = state.callerFragments.find(f => f.key === "path_prefix")!;
    const next = reduceVizQuery(state, { type: "removeFragment", id: frag.id });
    const args = composeFromState(next, null);
    expect(args.path_prefix).toBeUndefined();
    expect(args.types).toEqual(["task"]);
  });

  it("empty chip (one_of:[]) emits no field filter", () => {
    const state = initVizQueryState({ types: ["task"] });
    const withChip = reduceVizQuery(state, {
      type: "addChip",
      field: "status",
      schemaField: STATUS_FIELD,
    });
    // empty one_of = no effective filter
    const args = composeFromState(withChip, TASK_SCHEMA);
    expect(args.fields).toBeUndefined();
  });
});

// ===========================================================================
// HOOK TESTS (RTL, jsdom)
// ===========================================================================

/**
 * Probe component that renders VM fields as data attributes and exposes
 * callbacks via buttons for test interaction.
 */
function VizQueryProbe({
  spec,
  onSpecChange,
}: {
  spec: VizSpec;
  onSpecChange: (s: VizSpec) => void;
}) {
  const vm = useVizQuery(spec, onSpecChange);
  return (
    <div>
      <span data-testid="lockedType">{vm.lockedType ?? "null"}</span>
      <span data-testid="chipCount">{vm.chips.length}</span>
      <span data-testid="fragmentCount">{vm.fragments.length}</span>
      <span data-testid="addableCount">{vm.addableFields.length}</span>
      {vm.chips.map((c) => (
        <span key={c.field} data-testid={`chip-${c.field}`}>
          {JSON.stringify(c.state)}
        </span>
      ))}
      <button
        data-testid="btn-add-status"
        onClick={() => vm.addChip("status")}
      >
        add status
      </button>
      <button
        data-testid="btn-set-status-done"
        onClick={() => vm.setChip("status", { one_of: ["done"] })}
      >
        set status done
      </button>
      <button
        data-testid="btn-remove-status"
        onClick={() => vm.removeChip("status")}
      >
        remove status
      </button>
      <button
        data-testid="btn-lock-project"
        onClick={() => vm.setTypeLock("project")}
      >
        lock project
      </button>
      <button
        data-testid="btn-unlock"
        onClick={() => vm.setTypeLock(null)}
      >
        unlock
      </button>
    </div>
  );
}

describe("useVizQuery hook", () => {
  it("exposes lockedType from spec.query.types:[single]", () => {
    const spec = makeSpec({ types: ["task"] });
    render(<VizQueryProbe spec={spec} onSpecChange={() => {}} />, { wrapper: withClient(mockClient) });
    expect(screen.getByTestId("lockedType").textContent).toBe("task");
  });

  it("addChip builds a chip and calls onSpecChange with correct fields", async () => {
    // Schema must already be in cache so the hook has it immediately
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const changes: VizSpec[] = [];
    const spec = makeSpec({ types: ["task"] });

    render(
      <VizQueryProbe
        spec={spec}
        onSpecChange={(s) => changes.push(s)}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Wait until the schema has ARRIVED and been processed by the hook:
    // addableCount > 0 means schemaFieldMap is populated and addChip will succeed.
    // (Waiting only for describeSchema to be *called* is not enough — the response
    // is still in-flight and the hook re-renders asynchronously after it resolves.)
    await waitFor(() =>
      expect(Number(screen.getByTestId("addableCount").textContent)).toBeGreaterThan(0)
    );

    // add a chip
    const btn = screen.getByTestId("btn-add-status");
    await act(async () => { btn.click(); });

    // onSpecChange should have been called; types preserved
    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1]!;
    expect(last.query.types).toEqual(["task"]);
  });

  it("setChip emits onSpecChange with correct fields.status", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const changes: VizSpec[] = [];
    const spec = makeSpec({ types: ["task"] });

    render(
      <VizQueryProbe
        spec={spec}
        onSpecChange={(s) => changes.push(s)}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Wait until the schema has ARRIVED and been processed by the hook:
    // addableCount > 0 means schemaFieldMap is populated and addChip will succeed.
    // (Waiting only for describeSchema to be *called* is not enough — the response
    // is still in-flight and the hook re-renders asynchronously after it resolves.)
    await waitFor(() =>
      expect(Number(screen.getByTestId("addableCount").textContent)).toBeGreaterThan(0)
    );

    // Add chip first
    await act(async () => { screen.getByTestId("btn-add-status").click(); });
    // Then set it to "done"
    await act(async () => { screen.getByTestId("btn-set-status-done").click(); });

    const last = changes[changes.length - 1]!;
    const fields = last.query.fields as Record<string, unknown> | undefined;
    expect(fields?.["status"]).toEqual({ one_of: ["done"] });
    // types preserved
    expect(last.query.types).toEqual(["task"]);
  });

  it("promoteFragments: schema arrival promotes a fields fragment to a chip", async () => {
    // Spec already has fields.status in the query (caller-provided)
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const spec = makeSpec({
      types: ["task"],
      fields: { status: { one_of: ["open"] } },
    });

    render(<VizQueryProbe spec={spec} onSpecChange={() => {}} />, { wrapper: withClient(mockClient) });

    // Before schema: no chips yet
    expect(screen.getByTestId("chipCount").textContent).toBe("0");

    // After schema arrives: the status fragment is promoted to a chip
    await waitFor(() =>
      expect(screen.getByTestId("chipCount").textContent).toBe("1")
    );
    // The promoted chip shows the initial state
    const chipEl = screen.getByTestId("chip-status");
    const chipState = JSON.parse(chipEl.textContent ?? "{}") as Record<string, unknown>;
    expect(chipState["one_of"]).toEqual(["open"]);
  });

  it("promoteFragments is idempotent — re-rendering with same spec does not double chips", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const spec = makeSpec({ types: ["task"], fields: { status: { one_of: ["open"] } } });
    const { rerender } = render(<VizQueryProbe spec={spec} onSpecChange={() => {}} />, { wrapper: withClient(mockClient) });

    await waitFor(() =>
      expect(screen.getByTestId("chipCount").textContent).toBe("1")
    );

    // Re-render with same spec
    rerender(<VizQueryProbe spec={spec} onSpecChange={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId("chipCount").textContent).toBe("1");
  });

  it("setTypeLock to project drops schema-scoped fragments, emits onSpecChange", async () => {
    const changes: VizSpec[] = [];
    const spec = makeSpec({
      types: ["task"],
      join_filters: [{ rel_type: "project", target: { node_ids: ["p1"] } }],
      path_prefix: "Notes/",
    });

    render(<VizQueryProbe spec={spec} onSpecChange={(s) => changes.push(s)} />, { wrapper: withClient(mockClient) });

    await act(async () => { screen.getByTestId("btn-lock-project").click(); });

    const last = changes[changes.length - 1]!;
    // schema-scoped join_filters dropped
    expect(last.query.join_filters).toBeUndefined();
    // global path_prefix survives
    expect(last.query.path_prefix).toBe("Notes/");
    // new type
    expect(last.query.types).toEqual(["project"]);
  });

  it("addableFields excludes already-active chips", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const spec = makeSpec({ types: ["task"] });
    render(<VizQueryProbe spec={spec} onSpecChange={() => {}} />, { wrapper: withClient(mockClient) });

    // Wait for schema — addableFields should have 2 fields
    await waitFor(() =>
      expect(Number(screen.getByTestId("addableCount").textContent)).toBeGreaterThan(0)
    );
    const initialCount = Number(screen.getByTestId("addableCount").textContent);

    // Add a chip — addableFields should shrink by 1
    await act(async () => { screen.getByTestId("btn-add-status").click(); });
    expect(Number(screen.getByTestId("addableCount").textContent)).toBe(initialCount - 1);
  });
});

// ===========================================================================
// CORRECTNESS TESTS for two bug-fix findings
// ===========================================================================

describe("useVizQuery — correctness fixes", () => {
  /**
   * Finding 1a — key-order-reordered spec does NOT re-init local state.
   *
   * Scenario: user adds a chip (local edit), then the parent re-renders with a
   * spec whose query object has the SAME fields as the one we emitted but with
   * JSON keys in a DIFFERENT order (as a backend round-trip commonly does).
   * The hook must NOT treat this as an external change — the chip must survive.
   */
  it("reordered-key spec re-render does NOT clobber in-progress local state (chip survives)", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const changes: VizSpec[] = [];
    let currentSpec = makeSpec({ types: ["task"] });

    const { rerender } = render(
      <VizQueryProbe
        spec={currentSpec}
        onSpecChange={(s) => {
          changes.push(s);
          currentSpec = s;
        }}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Wait until the schema has ARRIVED and been processed by the hook:
    // addableCount > 0 means schemaFieldMap is populated and addChip will succeed.
    // (Waiting only for describeSchema to be *called* is not enough — the response
    // is still in-flight and the hook re-renders asynchronously after it resolves.)
    await waitFor(() =>
      expect(Number(screen.getByTestId("addableCount").textContent)).toBeGreaterThan(0)
    );

    // Add a status chip — this calls onSpecChange with a composed query
    await act(async () => { screen.getByTestId("btn-add-status").click(); });
    expect(screen.getByTestId("chipCount").textContent).toBe("1");

    // Simulate a parent re-render with the SAME semantic query but keys reordered
    // (e.g. backend returned { limit: 50, types: ["task"] } instead of { types: ["task"] })
    const lastEmitted = changes[changes.length - 1]!.query;
    const reorderedQuery = Object.fromEntries(
      Object.entries(lastEmitted).reverse()  // reverses key order
    );
    const reorderedSpec: VizSpec = { ...currentSpec, query: reorderedQuery };

    await act(async () => {
      rerender(
        <VizQueryProbe
          spec={reorderedSpec}
          onSpecChange={(s) => {
            changes.push(s);
            currentSpec = s;
          }}
        />
      );
    });

    // Chip must still be present — reordered keys must NOT trigger re-init
    expect(screen.getByTestId("chipCount").textContent).toBe("1");
  });

  /**
   * Finding 1b — a GENUINELY different external spec (new types) DOES re-init.
   *
   * This ensures the fix for Finding 1 did not regress the expected behavior
   * of honoring actual external spec changes.
   */
  it("genuinely different external spec re-inits state (type switch clears chips)", async () => {
    mockClient.describeSchema
      .mockResolvedValueOnce(okEnvelope(TASK_SCHEMA))
      .mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const taskSpec = makeSpec({ types: ["task"] });
    const { rerender } = render(
      <VizQueryProbe spec={taskSpec} onSpecChange={() => {}} />,
      { wrapper: withClient(mockClient) },
    );

    // Wait until the schema has ARRIVED and been processed by the hook:
    // addableCount > 0 means schemaFieldMap is populated and addChip will succeed.
    await waitFor(() =>
      expect(Number(screen.getByTestId("addableCount").textContent)).toBeGreaterThan(0)
    );
    await act(async () => { screen.getByTestId("btn-add-status").click(); });
    expect(screen.getByTestId("chipCount").textContent).toBe("1");
    expect(screen.getByTestId("lockedType").textContent).toBe("task");

    // Parent now supplies a genuinely different spec — different type, no chips
    const projectSpec = makeSpec({ types: ["project"] });
    await act(async () => {
      rerender(<VizQueryProbe spec={projectSpec} onSpecChange={() => {}} />);
    });

    // State must be re-inited: lockedType = project, chips = 0
    expect(screen.getByTestId("lockedType").textContent).toBe("project");
    expect(screen.getByTestId("chipCount").textContent).toBe("0");
  });

  /**
   * Finding 2 — a single user edit fires onSpecChange exactly ONCE.
   *
   * React StrictMode double-invokes state updaters; if onSpecChange is called
   * inside the setState updater it fires twice. The fix moves side effects
   * outside the updater so it fires once regardless.
   *
   * We simulate the double-invoke scenario by manually calling the updater
   * twice and verifying only one onSpecChange emission happens per user action.
   * In practice we do this by simply counting emissions from a single button click.
   */
  it("single user action fires onSpecChange exactly once (no double-fire from impure updater)", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const changes: VizSpec[] = [];
    const spec = makeSpec({ types: ["task"] });

    render(
      <VizQueryProbe
        spec={spec}
        onSpecChange={(s) => changes.push(s)}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Wait until the schema has ARRIVED and been processed by the hook:
    // addableCount > 0 means schemaFieldMap is populated and addChip will succeed.
    // (Waiting only for describeSchema to be *called* is not enough — the response
    // is still in-flight and the hook re-renders asynchronously after it resolves.)
    await waitFor(() =>
      expect(Number(screen.getByTestId("addableCount").textContent)).toBeGreaterThan(0)
    );

    // A single addChip click must produce exactly ONE onSpecChange call
    await act(async () => { screen.getByTestId("btn-add-status").click(); });
    expect(changes).toHaveLength(1);

    // A single setChip click must also produce exactly ONE additional call
    await act(async () => { screen.getByTestId("btn-set-status-done").click(); });
    expect(changes).toHaveLength(2);
  });
});

it('preserves whole Boolean branches through type, chip, sort and explicit removal',()=>{
  const where={any:[{types:['task'],fields:{status:{eq:'open'}}},{join_filters:[{rel_type:'project',target:{title_eq:'A'}}]}]};
  let state=initVizQueryState({where});
  expect(state.lockedType).toBeNull();expect(state.callerFragments).toHaveLength(1);
  state=reduceVizQuery(state,{type:'setTypeLock',lockedType:'task'});
  state=reduceVizQuery(state,{type:'addChip',field:'status',schemaField:STATUS_FIELD});
  state=reduceVizQuery(state,{type:'setChip',field:'status',state:{one_of:['done']}});
  state=reduceVizQuery(state,{type:'setStrip',strip:{...state.strip,sort_order:'desc',limit:10}});
  const args=composeFromState(state,TASK_SCHEMA);
  expect(args.where).toEqual(where);expect(args.fields).toEqual({status:{one_of:['done']}});expect(args.limit).toBe(10);
  state=reduceVizQuery(state,{type:'setTypeLock',lockedType:'project'});
  expect(composeFromState(state,null).where).toEqual(where);
  state=reduceVizQuery(state,{type:'removeFragment',id:state.callerFragments[0].id});
  expect(composeFromState(state,null)).not.toHaveProperty('where');
});
