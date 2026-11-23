// @vitest-environment jsdom
/**
 * use-viz-cell-edit.test.tsx
 *
 * TDD tests for the useVizCellEdit hook — mutation orchestration core.
 * Tests are written BEFORE the implementation; they must be RED initially.
 *
 * Safety invariants pinned by these tests (explicit checklist):
 *  INV-1: dry-run BEFORE commit — clean edit goes updateNode(dry_run:true) then updateNode(dry_run:false)
 *  INV-2: promote holds in pending, does NOT commit until confirmPending()
 *  INV-3: inline-error sets cellError + editor stays open (does not commit)
 *  INV-4: STALE adds to staleSet + captures current_node; reloadRow clears stale; never overwrite stale node
 *  INV-5: every mutation sends expected_version; missing version → getNode first; still absent → cellError + ABORT
 *  INV-6: title (TITLE_FIELD) uses renameNode (no dry-run); empty/whitespace → cellError pre-flight
 *  INV-7: on commit success: overlay values/titles/versions, add to flash, schedule 900ms clear, call onAfterCommit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";

// Import pure reducers + hook from the new module (will be RED until implemented)
import {
  applyCommit,
  applyStale,
  applyTitleCommit,
  useVizCellEdit,
  type VizCellEditOverlay,
} from "../src/use-viz-cell-edit.js";

import type {
  PendingEdit,
  CellError,
  CellRef,
  CurrentNode,
  UpdateDryRunData,
  UpdateCommitData,
  RenameData,
} from "@vault/query-core";
import { TITLE_FIELD } from "@vault/query-core";
import type { VizRow } from "../src/viz-spec.js";
import type { Client } from "@vault/query-core";

// ============================================================================
// Helpers
// ============================================================================

function makeRow(overrides: Partial<VizRow> = {}): VizRow {
  return {
    id: "node-1",
    title: "My Node",
    file_path: "notes/my-node.md",
    types: ["task"],
    fields: { status: "open", count: 42 },
    version: 7,
    ...overrides,
  };
}

function makeOverlay(overrides: Partial<VizCellEditOverlay> = {}): VizCellEditOverlay {
  return {
    values: {},
    titles: {},
    versions: {},
    staleSet: new Set(),
    staleNodes: {},
    flash: new Set(),
    editing: null,
    pending: null,
    cellError: null,
    busy: false,
    ...overrides,
  };
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

function makeDryRunData(field: string, raw: unknown, coercedValue?: unknown): UpdateDryRunData {
  const effectiveCoerced = coercedValue ?? raw;
  return {
    dry_run: true,
    preview: {
      node_id: "node-1",
      file_path: "notes/my-node.md",
      title: "My Node",
      types: ["task"],
      coerced_state: {
        [field]: {
          field,
          value: effectiveCoerced,
          original: raw,
          source: "provided" as const,
          changed: effectiveCoerced !== raw,
          coercion_code: effectiveCoerced !== raw ? "STRING_TO_DATE" : undefined,
        },
      },
      fixable: [],
      orphan_fields: [],
    },
  };
}

function makeCommitData(field: string, value: unknown, version = 8): UpdateCommitData {
  return {
    node_id: "node-1",
    file_path: "notes/my-node.md",
    title: "My Node",
    types: ["task"],
    coerced_state: {
      [field]: {
        field,
        value,
        source: "provided" as const,
        changed: true,
      },
    },
    orphan_fields: [],
    version,
  };
}

function makeRenameData(newTitle: string, version = 8): RenameData {
  return {
    node_id: "node-1",
    file_path: `notes/${newTitle}.md`,
    title: newTitle,
    references_updated: 0,
    version,
  };
}

function makeCurrentNode(overrides: Partial<CurrentNode> = {}): CurrentNode {
  return {
    id: "node-1",
    file_path: "notes/my-node.md",
    title: "Refreshed Node",
    types: ["task"],
    fields: { status: "done", count: 99 },
    body: null,
    version: 10,
    ...overrides,
  };
}

// ============================================================================
// Minimal mock client builder
// ============================================================================

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

// ============================================================================
// PURE REDUCER TESTS (no renderer needed)
// ============================================================================

describe("applyCommit (pure reducer)", () => {
  it("overlays value, bumps version, adds flash key", () => {
    const state = makeOverlay();
    const next = applyCommit(state, "node-1", "status", "done", 8);
    // values overlay
    expect(next.values["node-1"]?.["status"]).toBe("done");
    // version bumped
    expect(next.versions["node-1"]).toBe(8);
    // flash key added
    expect(next.flash.has("node-1:status")).toBe(true);
    // editing + pending + cellError cleared
    expect(next.editing).toBeNull();
    expect(next.pending).toBeNull();
    expect(next.cellError).toBeNull();
  });

  it("is pure — does not mutate input state", () => {
    const state = makeOverlay();
    applyCommit(state, "node-1", "status", "done", 8);
    expect(state.values).toEqual({});
    expect(state.flash.size).toBe(0);
  });

  it("merges with existing values for the same node", () => {
    const state = makeOverlay({ values: { "node-1": { count: 5 } } });
    const next = applyCommit(state, "node-1", "status", "done", 8);
    expect(next.values["node-1"]?.["count"]).toBe(5);
    expect(next.values["node-1"]?.["status"]).toBe("done");
  });
});

describe("applyTitleCommit (pure reducer)", () => {
  it("overlays title, bumps version, adds flash key for TITLE_FIELD", () => {
    const state = makeOverlay();
    const next = applyTitleCommit(state, "node-1", "New Title", 9);
    expect(next.titles["node-1"]).toBe("New Title");
    expect(next.versions["node-1"]).toBe(9);
    expect(next.flash.has(`node-1:${TITLE_FIELD}`)).toBe(true);
    expect(next.editing).toBeNull();
    expect(next.pending).toBeNull();
    expect(next.cellError).toBeNull();
  });

  it("is pure — does not mutate input state", () => {
    const state = makeOverlay();
    applyTitleCommit(state, "node-1", "New Title", 9);
    expect(state.titles).toEqual({});
  });
});

describe("applyStale (pure reducer)", () => {
  it("adds id to staleSet, captures current_node in staleNodes, clears editing + pending + cellError", () => {
    const editing: CellRef = { id: "node-1", field: "status" };
    const pending: PendingEdit = {
      id: "node-1", field: "status", value: "done", version: 7,
      warnings: [], reasons: ["coercion"],
    };
    const current = makeCurrentNode();
    const state = makeOverlay({ editing, pending });
    const next = applyStale(state, "node-1", current);
    expect(next.staleSet.has("node-1")).toBe(true);
    expect(next.staleNodes["node-1"]).toBe(current);
    expect(next.editing).toBeNull();
    expect(next.pending).toBeNull();
    expect(next.cellError).toBeNull();
  });

  it("works when current_node is undefined (staleSet still set)", () => {
    const state = makeOverlay();
    const next = applyStale(state, "node-1", undefined);
    expect(next.staleSet.has("node-1")).toBe(true);
    expect(next.staleNodes["node-1"]).toBeUndefined();
  });

  it("is pure — does not mutate input state", () => {
    const state = makeOverlay();
    applyStale(state, "node-1", undefined);
    expect(state.staleSet.size).toBe(0);
  });
});

// ============================================================================
// RTL HOOK TESTS
// ============================================================================

/**
 * Minimal probe component for the hook. All API surface is surfaced via data-testid
 * spans and button elements so tests can inspect and trigger without coupling to JSX.
 */
interface ProbeProps {
  client: Client;
  onAfterCommit?: () => void;
  row: VizRow;
}

function Probe({ client, onAfterCommit, row }: ProbeProps) {
  const api = useVizCellEdit(client, onAfterCommit);

  const cellVal = String(api.cellValue(row, "status") ?? "(null)");
  const cellTitle = api.cellTitle(row);
  const editingStr = api.editing ? `${api.editing.id}:${api.editing.field}` : "none";
  const errorStr = api.cellError ? `${api.cellError.code}:${api.cellError.message}` : "none";
  const pendingStr = api.pending ? `pending:${String(api.pending.value)}` : "none";
  const staleStr = api.isStale("node-1") ? "stale" : "fresh";
  const flashStr = api.isFlashing("node-1", "status") ? "flashing" : "not";
  const isEditingStr = api.isEditing ? "editing" : "idle";
  const busyStr = api.busy ? "busy" : "idle";

  return (
    <div>
      <span data-testid="cellVal">{cellVal}</span>
      <span data-testid="cellTitle">{cellTitle}</span>
      <span data-testid="editing">{editingStr}</span>
      <span data-testid="error">{errorStr}</span>
      <span data-testid="pending">{pendingStr}</span>
      <span data-testid="stale">{staleStr}</span>
      <span data-testid="flash">{flashStr}</span>
      <span data-testid="isEditing">{isEditingStr}</span>
      <span data-testid="busy">{busyStr}</span>

      <button data-testid="btn-begin" onClick={() => api.beginEdit(row.id, "status")}>begin</button>
      <button data-testid="btn-submit-status" onClick={() => void api.submitEdit(row, "status", "done")}>submit</button>
      <button data-testid="btn-submit-title" onClick={() => void api.submitEdit(row, TITLE_FIELD, "New Title")}>submit-title</button>
      <button data-testid="btn-submit-empty-title" onClick={() => void api.submitEdit(row, TITLE_FIELD, "  ")}>submit-empty-title</button>
      <button data-testid="btn-confirm" onClick={() => void api.confirmPending()}>confirm</button>
      <button data-testid="btn-cancel" onClick={() => api.cancelEdit()}>cancel</button>
      <button data-testid="btn-reload" onClick={() => void api.reloadRow(row)}>reload</button>
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
// INV-1: clean edit → dry-run first, then commit; overlay + flash applied
// ============================================================================
describe("submitEdit — clean field edit (INV-1, INV-7)", () => {
  it("calls updateNode(dry_run:true) then updateNode(dry_run:false) with expected_version", async () => {
    const row = makeRow();
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));

    const updateNode = vi.fn()
      .mockResolvedValueOnce(dryRunEnv)   // dry-run
      .mockResolvedValueOnce(commitEnv);  // commit

    const client = makeMockClient({ updateNode });
    const afterCommit = vi.fn();

    render(<Probe client={client} onAfterCommit={afterCommit} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // INV-1: two calls to updateNode
    expect(updateNode).toHaveBeenCalledTimes(2);
    // First call must be dry_run: true
    expect(updateNode.mock.calls[0]?.[0]).toMatchObject({
      node_id: "node-1",
      set_fields: { status: "done" },
      expected_version: 7,
      dry_run: true,
    });
    // Second call must be dry_run: false
    expect(updateNode.mock.calls[1]?.[0]).toMatchObject({
      node_id: "node-1",
      expected_version: 7,
      dry_run: false,
    });
  });

  it("overlays the committed value, bumps version, flashes the cell (INV-7)", async () => {
    const row = makeRow();
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));

    const client = makeMockClient({
      updateNode: vi.fn()
        .mockResolvedValueOnce(dryRunEnv)
        .mockResolvedValueOnce(commitEnv),
    });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // Value overlay applied
    expect(screen.getByTestId("cellVal").textContent).toBe("done");
    // Flash active
    expect(screen.getByTestId("flash").textContent).toBe("flashing");
    // editing cleared
    expect(screen.getByTestId("editing").textContent).toBe("none");
  });

  it("flash clears after 900ms (INV-7)", async () => {
    const row = makeRow();
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));

    const client = makeMockClient({
      updateNode: vi.fn()
        .mockResolvedValueOnce(dryRunEnv)
        .mockResolvedValueOnce(commitEnv),
    });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    expect(screen.getByTestId("flash").textContent).toBe("flashing");

    // Advance 900ms — flash should clear
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByTestId("flash").textContent).toBe("not");
  });

  it("calls onAfterCommit after successful commit (INV-7)", async () => {
    const row = makeRow();
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));

    const afterCommit = vi.fn();
    const client = makeMockClient({
      updateNode: vi.fn()
        .mockResolvedValueOnce(dryRunEnv)
        .mockResolvedValueOnce(commitEnv),
    });

    render(<Probe client={client} onAfterCommit={afterCommit} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    expect(afterCommit).toHaveBeenCalledOnce();
  });

  it("cellValue returns overlay value over row.fields value", async () => {
    // After commit, overlay value should take precedence over original row value
    const row = makeRow({ fields: { status: "open" } });
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));

    const client = makeMockClient({
      updateNode: vi.fn()
        .mockResolvedValueOnce(dryRunEnv)
        .mockResolvedValueOnce(commitEnv),
    });

    render(<Probe client={client} row={row} />);
    // Initially shows original
    expect(screen.getByTestId("cellVal").textContent).toBe("open");

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    // After commit, shows overlay
    expect(screen.getByTestId("cellVal").textContent).toBe("done");
  });
});

// ============================================================================
// INV-2: surprising coercion → pending, confirmPending commits
// ============================================================================
describe("submitEdit — surprising coercion (promote) (INV-2)", () => {
  it("sets pending with coerced value, does NOT commit yet", async () => {
    const row = makeRow({ fields: { status: "next friday" } });
    // Coercion: "next friday" → "2026-06-27" (value differs from raw)
    const dryRunEnv = okEnvelope(makeDryRunData("status", "next friday", "2026-06-27"));

    const updateNode = vi.fn().mockResolvedValueOnce(dryRunEnv);
    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // Only dry-run call — no commit call yet (INV-2)
    expect(updateNode).toHaveBeenCalledTimes(1);
    expect(updateNode.mock.calls[0]?.[0]).toMatchObject({ dry_run: true });

    // Pending is set with the coerced value
    expect(screen.getByTestId("pending").textContent).toBe("pending:2026-06-27");
    // editing cleared when promote happens
    expect(screen.getByTestId("editing").textContent).toBe("none");
  });

  it("confirmPending commits and clears pending", async () => {
    const row = makeRow({ fields: { status: "next friday" } });
    const dryRunEnv = okEnvelope(makeDryRunData("status", "next friday", "2026-06-27"));
    const commitEnv = okEnvelope(makeCommitData("status", "2026-06-27", 8));

    const updateNode = vi.fn()
      .mockResolvedValueOnce(dryRunEnv)   // dry-run
      .mockResolvedValueOnce(commitEnv);  // confirmPending commit

    const client = makeMockClient({ updateNode });
    const afterCommit = vi.fn();

    render(<Probe client={client} onAfterCommit={afterCommit} row={row} />);

    // Trigger promote
    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    expect(screen.getByTestId("pending").textContent).toBe("pending:2026-06-27");

    // Confirm
    await act(async () => {
      screen.getByTestId("btn-confirm").click();
    });

    // Total calls: 1 dry-run + 1 commit
    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(updateNode.mock.calls[1]?.[0]).toMatchObject({ dry_run: false, set_fields: { status: "2026-06-27" } });

    // Pending cleared
    expect(screen.getByTestId("pending").textContent).toBe("none");
    // Value overlaid
    expect(screen.getByTestId("cellVal").textContent).toBe("2026-06-27");
    // onAfterCommit called
    expect(afterCommit).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// INV-3: inline-error → cellError set, editor stays open
// ============================================================================
describe("submitEdit — validation error (inline-error) (INV-3)", () => {
  it("sets cellError and keeps editing open, does NOT commit", async () => {
    const row = makeRow();
    // Engine returns ok:true with an error-severity warning on the edited field
    const validationEnv = {
      ok: true as const,
      data: {
        dry_run: true as const,
        preview: {
          node_id: "node-1",
          file_path: "notes/my-node.md",
          title: "My Node",
          types: ["task"],
          coerced_state: {},
          fixable: [{ field: "status", suggestion: null, allowed_values: ["open", "done", "next"] }],
          orphan_fields: [],
        },
      },
      warnings: [],
    };

    const updateNode = vi.fn().mockResolvedValueOnce(validationEnv);
    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    // Begin edit first so editing is open
    await act(async () => { screen.getByTestId("btn-begin").click(); });
    expect(screen.getByTestId("editing").textContent).toBe("node-1:status");

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // Only dry-run call, no commit (INV-3)
    expect(updateNode).toHaveBeenCalledTimes(1);
    // cellError set
    expect(screen.getByTestId("error").textContent).not.toBe("none");
    // Error includes relevant info
    expect(screen.getByTestId("error").textContent).toContain("VALIDATION_FAILED");
  });
});

// ============================================================================
// INV-4: STALE_NODE → isStale, reloadRow patches and clears
// ============================================================================
describe("submitEdit — STALE_NODE response (INV-4)", () => {
  it("adds node to staleSet and captures current_node", async () => {
    const row = makeRow();
    const currentNode = makeCurrentNode();
    const staleEnv = failEnvelope("STALE_NODE", "Version conflict.", {
      current_version: 9,
      expected_version: 7,
      current_node: currentNode as unknown as Record<string, unknown>,
    });
    // Dry-run returns STALE
    const updateNode = vi.fn().mockResolvedValueOnce(staleEnv);
    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // isStale = true (INV-4)
    expect(screen.getByTestId("stale").textContent).toBe("stale");
    // editing cleared
    expect(screen.getByTestId("editing").textContent).toBe("none");
  });

  it("STALE on commit (dry_run:false) also marks stale", async () => {
    const row = makeRow();
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const currentNode = makeCurrentNode();
    const staleEnv = failEnvelope("STALE_NODE", "Version conflict on commit.", {
      current_version: 9,
      expected_version: 7,
      current_node: currentNode as unknown as Record<string, unknown>,
    });

    const updateNode = vi.fn()
      .mockResolvedValueOnce(dryRunEnv)   // dry-run: ok
      .mockResolvedValueOnce(staleEnv);   // commit: STALE

    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    expect(screen.getByTestId("stale").textContent).toBe("stale");
  });

  it("reloadRow patches overlay values/titles/versions and clears stale (INV-4)", async () => {
    const row = makeRow();
    const currentNode = makeCurrentNode({ title: "Refreshed Node", fields: { status: "done" }, version: 10 });
    const staleEnv = failEnvelope("STALE_NODE", "Version conflict.", {
      current_version: 10,
      expected_version: 7,
      current_node: currentNode as unknown as Record<string, unknown>,
    });

    const updateNode = vi.fn().mockResolvedValueOnce(staleEnv);
    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    expect(screen.getByTestId("stale").textContent).toBe("stale");

    // Reload — uses staleNodes[id] directly (no getNode needed since stale had current_node)
    await act(async () => {
      screen.getByTestId("btn-reload").click();
    });

    expect(screen.getByTestId("stale").textContent).toBe("fresh");
    expect(screen.getByTestId("cellTitle").textContent).toBe("Refreshed Node");
  });

  it("reloadRow falls back to getNode when no captured current_node", async () => {
    const row = makeRow();
    // Stale without current_node in details
    const staleEnv = failEnvelope("STALE_NODE", "Version conflict.", {
      current_version: 10,
      expected_version: 7,
    });
    const fetchedNode = makeCurrentNode({ title: "Fetched Node", version: 10 });

    const updateNode = vi.fn().mockResolvedValueOnce(staleEnv);
    const getNode = vi.fn().mockResolvedValueOnce(okEnvelope(fetchedNode));
    const client = makeMockClient({ updateNode, getNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    expect(screen.getByTestId("stale").textContent).toBe("stale");

    await act(async () => {
      screen.getByTestId("btn-reload").click();
    });

    expect(getNode).toHaveBeenCalledWith({ node_id: "node-1" });
    expect(screen.getByTestId("stale").textContent).toBe("fresh");
    expect(screen.getByTestId("cellTitle").textContent).toBe("Fetched Node");
  });
});

// ============================================================================
// INV-5: missing version → getNode first; still absent → cellError + ABORT
// ============================================================================
describe("submitEdit — missing version (INV-5)", () => {
  it("fetches version via getNode when row.version is undefined", async () => {
    // Row with no version
    const row = makeRow({ version: undefined });
    const fetchedNode = makeCurrentNode({ version: 5 });
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 6));

    const getNode = vi.fn().mockResolvedValueOnce(okEnvelope(fetchedNode));
    const updateNode = vi.fn()
      .mockResolvedValueOnce(dryRunEnv)
      .mockResolvedValueOnce(commitEnv);

    const client = makeMockClient({ updateNode, getNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // getNode was called to obtain version (INV-5)
    expect(getNode).toHaveBeenCalledWith({ node_id: "node-1" });
    // Then dry-run with the fetched version
    expect(updateNode.mock.calls[0]?.[0]).toMatchObject({ expected_version: 5, dry_run: true });
    // Then commit
    expect(updateNode.mock.calls[1]?.[0]).toMatchObject({ dry_run: false });
  });

  it("sets cellError and aborts when version is absent even after getNode", async () => {
    const row = makeRow({ version: undefined });
    // getNode returns a node without a version (pathological)
    const nodeNoVersion = { ...makeCurrentNode(), version: undefined as unknown as number };
    const getNode = vi.fn().mockResolvedValueOnce(okEnvelope(nodeNoVersion));
    const updateNode = vi.fn();
    const client = makeMockClient({ updateNode, getNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    // No updateNode call (INV-5 abort)
    expect(updateNode).not.toHaveBeenCalled();
    // cellError set
    expect(screen.getByTestId("error").textContent).not.toBe("none");
  });

  it("sets cellError and aborts when getNode itself fails", async () => {
    const row = makeRow({ version: undefined });
    const getNode = vi.fn().mockResolvedValueOnce(failEnvelope("NOT_FOUND", "Node not found."));
    const updateNode = vi.fn();
    const client = makeMockClient({ updateNode, getNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    expect(updateNode).not.toHaveBeenCalled();
    expect(screen.getByTestId("error").textContent).not.toBe("none");
  });
});

// ============================================================================
// INV-6: title → renameNode (no dry-run); empty → cellError pre-flight
// ============================================================================
describe("submitEdit — title edits (TITLE_FIELD) (INV-6)", () => {
  it("uses renameNode (no dry-run) for title edits", async () => {
    const row = makeRow();
    const renameEnv = okEnvelope(makeRenameData("New Title", 8));

    const renameNode = vi.fn().mockResolvedValueOnce(renameEnv);
    const updateNode = vi.fn();
    const client = makeMockClient({ renameNode, updateNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // renameNode called, NOT updateNode (INV-6)
    expect(renameNode).toHaveBeenCalledOnce();
    expect(updateNode).not.toHaveBeenCalled();
    expect(renameNode).toHaveBeenCalledWith({
      node_id: "node-1",
      new_title: "New Title",
      expected_version: 7,
    });
  });

  it("overlays the new title and flashes after rename", async () => {
    const row = makeRow();
    const renameEnv = okEnvelope(makeRenameData("New Title", 8));

    const client = makeMockClient({ renameNode: vi.fn().mockResolvedValueOnce(renameEnv) });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // Title overlay applied
    expect(screen.getByTestId("cellTitle").textContent).toBe("New Title");
    // Flash on TITLE_FIELD (probe reads isFlashing for "status" field, not title —
    // but we can check the title is different as a secondary check that commit happened)
  });

  it("sets cellError for empty title WITHOUT calling renameNode (INV-6 pre-flight)", async () => {
    const row = makeRow();
    const renameNode = vi.fn();
    const client = makeMockClient({ renameNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-empty-title").click();
    });

    // No renameNode call (INV-6 pre-flight abort)
    expect(renameNode).not.toHaveBeenCalled();
    // cellError set
    expect(screen.getByTestId("error").textContent).not.toBe("none");
    expect(screen.getByTestId("error").textContent).toContain("REQUIRED_MISSING");
  });
});

// ============================================================================
// beginEdit, cancelEdit, isEditing
// ============================================================================
describe("beginEdit / cancelEdit", () => {
  it("beginEdit sets editing", () => {
    const row = makeRow();
    const client = makeMockClient();
    render(<Probe client={client} row={row} />);

    act(() => { screen.getByTestId("btn-begin").click(); });
    expect(screen.getByTestId("editing").textContent).toBe("node-1:status");
    expect(screen.getByTestId("isEditing").textContent).toBe("editing");
  });

  it("cancelEdit clears editing, pending, and cellError", async () => {
    const row = makeRow({ fields: { status: "next friday" } });
    // Trigger a promote to set pending
    const dryRunEnv = okEnvelope(makeDryRunData("status", "next friday", "2026-06-27"));
    const client = makeMockClient({ updateNode: vi.fn().mockResolvedValueOnce(dryRunEnv) });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    expect(screen.getByTestId("pending").textContent).not.toBe("none");

    act(() => { screen.getByTestId("btn-cancel").click(); });
    expect(screen.getByTestId("pending").textContent).toBe("none");
    expect(screen.getByTestId("editing").textContent).toBe("none");
    expect(screen.getByTestId("error").textContent).toBe("none");
    expect(screen.getByTestId("isEditing").textContent).toBe("idle");
  });

  it("isEditing is true when pending is set (INV-2 poll-pause signal)", async () => {
    const row = makeRow({ fields: { status: "next friday" } });
    const dryRunEnv = okEnvelope(makeDryRunData("status", "next friday", "2026-06-27"));
    const client = makeMockClient({ updateNode: vi.fn().mockResolvedValueOnce(dryRunEnv) });

    render(<Probe client={client} row={row} />);
    expect(screen.getByTestId("isEditing").textContent).toBe("idle");

    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    // Promote → pending set → isEditing = true
    expect(screen.getByTestId("isEditing").textContent).toBe("editing");
  });
});

// ============================================================================
// cellValue / cellTitle overlay access
// ============================================================================
describe("cellValue / cellTitle (overlay read)", () => {
  it("cellValue returns row.fields value when no overlay", () => {
    const row = makeRow({ fields: { status: "open" } });
    const client = makeMockClient();
    render(<Probe client={client} row={row} />);
    expect(screen.getByTestId("cellVal").textContent).toBe("open");
  });

  it("cellTitle returns row.title when no overlay", () => {
    const row = makeRow({ title: "Original Title" });
    const client = makeMockClient();
    render(<Probe client={client} row={row} />);
    expect(screen.getByTestId("cellTitle").textContent).toBe("Original Title");
  });
});

// ============================================================================
// Fix 1: re-entry guard — double submit / double confirm while busy
// ============================================================================
describe("re-entry guard (Fix 1)", () => {
  it("second submitEdit while first is in-flight does NOT fire a second dry-run", async () => {
    const row = makeRow();
    let resolveDry: (v: unknown) => void;
    const dryRunPromise = new Promise((res) => { resolveDry = res; });

    // First dry-run hangs until we resolve manually
    const updateNode = vi.fn().mockReturnValueOnce(dryRunPromise);
    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    // Kick off first submit (will hang at dry-run)
    const btn = screen.getByTestId("btn-submit-status");
    await act(async () => { btn.click(); });

    // While first is in-flight, trigger second submit
    await act(async () => { btn.click(); });

    // Only one dry-run call should have been made
    expect(updateNode).toHaveBeenCalledTimes(1);

    // Resolve the hanging dry-run to let the first submit finish
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));
    updateNode.mockResolvedValueOnce(commitEnv);
    await act(async () => { resolveDry!(dryRunEnv); });
  });

  it("double confirmPending while busy does NOT trigger a second commit", async () => {
    const row = makeRow({ fields: { status: "next friday" } });
    const dryRunEnv = okEnvelope(makeDryRunData("status", "next friday", "2026-06-27"));

    let resolveCommit: (v: unknown) => void;
    const commitPromise = new Promise((res) => { resolveCommit = res; });

    const updateNode = vi.fn()
      .mockResolvedValueOnce(dryRunEnv)    // dry-run → promote
      .mockReturnValueOnce(commitPromise); // first confirm commit hangs
    const client = makeMockClient({ updateNode });

    render(<Probe client={client} row={row} />);

    // Trigger promote
    await act(async () => { screen.getByTestId("btn-submit-status").click(); });
    expect(screen.getByTestId("pending").textContent).toBe("pending:2026-06-27");

    // First confirm — hangs
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Second confirm while busy — should be a no-op
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Only 2 total calls (1 dry-run + 1 commit); no third call
    expect(updateNode).toHaveBeenCalledTimes(2);

    // Resolve to clean up
    const commitEnv = okEnvelope(makeCommitData("status", "2026-06-27", 8));
    await act(async () => { resolveCommit!(commitEnv); });
  });
});

// ============================================================================
// INV-6 (optimistic title rename): show immediately, background commit, rollback on fail
// ============================================================================
describe("submitEdit — optimistic title rename (INV-6 optimistic)", () => {
  it("cellTitle shows new title immediately (before renameNode resolves)", async () => {
    const row = makeRow({ title: "Original" });
    // renameNode is a deferred promise — never resolves during this test
    let resolveRename: (v: unknown) => void;
    const renamePromise = new Promise((res) => { resolveRename = res; });
    const renameNode = vi.fn().mockReturnValueOnce(renamePromise);
    const client = makeMockClient({ renameNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // Title must show immediately — BEFORE the rename promise resolves
    expect(screen.getByTestId("cellTitle").textContent).toBe("New Title");
    // Editor closed (editing = none)
    expect(screen.getByTestId("editing").textContent).toBe("none");

    // Resolve to clean up
    const renameEnv = okEnvelope(makeRenameData("New Title", 8));
    await act(async () => { resolveRename!(renameEnv); });
  });

  it("busy is released before renameNode resolves — second title submit is NOT blocked", async () => {
    const row = makeRow({ title: "Original" });

    let resolveRename1: (v: unknown) => void;
    const renamePromise1 = new Promise((res) => { resolveRename1 = res; });
    const renameNode = vi.fn()
      .mockReturnValueOnce(renamePromise1)
      .mockResolvedValueOnce(okEnvelope(makeRenameData("Even Newer", 9)));

    const client = makeMockClient({ renameNode });

    render(<Probe client={client} row={row} />);

    // First rename — background hangs
    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });
    // Second rename — should NOT be blocked by the first
    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // Both renames must have been called (guard was released after first optimistic apply)
    expect(renameNode).toHaveBeenCalledTimes(2);

    // Clean up
    await act(async () => { resolveRename1!(okEnvelope(makeRenameData("New Title", 8))); });
  });

  it("isEditing is false immediately after submit (guard released)", async () => {
    const row = makeRow({ title: "Original" });
    let resolveRename: (v: unknown) => void;
    const renamePromise = new Promise((res) => { resolveRename = res; });
    const renameNode = vi.fn().mockReturnValueOnce(renamePromise);
    const client = makeMockClient({ renameNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // isEditing must be false (editing = null) immediately after submit
    expect(screen.getByTestId("isEditing").textContent).toBe("idle");

    // Clean up
    await act(async () => { resolveRename!(okEnvelope(makeRenameData("New Title", 8))); });
  });

  it("rolls back title and sets cellError when renameNode fails", async () => {
    const row = makeRow({ title: "Original" });
    const renameNode = vi.fn().mockResolvedValueOnce(
      failEnvelope("CONFLICT", "Version conflict."),
    );
    const client = makeMockClient({ renameNode });

    render(<Probe client={client} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // After failure resolves, title must roll back to the original
    expect(screen.getByTestId("cellTitle").textContent).toBe("Original");
    // cellError must be set
    expect(screen.getByTestId("error").textContent).not.toBe("none");
    expect(screen.getByTestId("error").textContent).toContain("CONFLICT");
  });

  it("reconciles to server version on success", async () => {
    // After a successful rename, the version overlay must be the server's version (9)
    const row = makeRow({ title: "Original", version: 7 });
    const renameNode = vi.fn().mockResolvedValueOnce(
      okEnvelope(makeRenameData("New Title", 9)),
    );
    const updateNode = vi.fn()
      .mockResolvedValueOnce(okEnvelope(makeDryRunData("status", "done")))
      .mockResolvedValueOnce(okEnvelope(makeCommitData("status", "done", 10)));
    const client = makeMockClient({ renameNode, updateNode });

    render(<Probe client={client} row={row} />);

    // Rename
    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    // After the rename resolves, fire a field edit — it should use version 9 (server-reconciled)
    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });

    expect(updateNode.mock.calls[0]?.[0]).toMatchObject({ expected_version: 9 });
  });

  it("calls onAfterCommit after a successful background rename", async () => {
    const row = makeRow({ title: "Original" });
    const afterCommit = vi.fn();
    const renameNode = vi.fn().mockResolvedValueOnce(
      okEnvelope(makeRenameData("New Title", 8)),
    );
    const client = makeMockClient({ renameNode });

    render(<Probe client={client} onAfterCommit={afterCommit} row={row} />);

    await act(async () => {
      screen.getByTestId("btn-submit-title").click();
    });

    expect(afterCommit).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Fix 2: flash timer cleanup on unmount
// ============================================================================
describe("flash timer cleanup on unmount (Fix 2)", () => {
  it("unmounting before 900ms clears pending flash timer — no post-unmount dispatch error", async () => {
    const row = makeRow();
    const dryRunEnv = okEnvelope(makeDryRunData("status", "done"));
    const commitEnv = okEnvelope(makeCommitData("status", "done", 8));

    const client = makeMockClient({
      updateNode: vi.fn()
        .mockResolvedValueOnce(dryRunEnv)
        .mockResolvedValueOnce(commitEnv),
    });

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = render(<Probe client={client} row={row} />);

    // Trigger commit (schedules 900ms flash timer)
    await act(async () => {
      screen.getByTestId("btn-submit-status").click();
    });
    expect(screen.getByTestId("flash").textContent).toBe("flashing");

    // Unmount before 900ms fires
    act(() => { unmount(); });

    // clearTimeout should have been called for the pending flash timer
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Advancing past 900ms should produce no error (no post-unmount dispatch)
    await act(async () => { vi.advanceTimersByTime(1000); });

    clearTimeoutSpy.mockRestore();
  });
});
