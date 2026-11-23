// @vitest-environment jsdom
/**
 * viz-draft-integration.test.tsx
 *
 * Integration test: VizCardView (editable, table kind) wires useVizDraft
 * into VizTable — the draft row appears, opens on click, seeds from filter
 * chips, fires dry-run → commit, then reopens fresh after success (streak).
 * Also verifies poll-pause gating and field-editor Escape behaviour.
 *
 * The draft row renders through VizTable's own row loop (no separate
 * DraftRow component) — same cells as a real row, wrapped by
 * useDraftEditAdapter. There is no standalone "✓ Create" button: typing
 * the title into the title cell's `.cell-input` and pressing Enter commits
 * the draft directly (submitEdit → commitWithTitle), same as renaming a
 * real row's title commits that row.
 *
 * Asserts:
 *   1. Editable table shows "+ New task" affordance at the bottom.
 *   2. Clicking "+ New task" opens the draft row (title cell editor appears).
 *   3. Typing a title + Enter in the title cell fires createNode(dry_run:true)
 *      then createNode(dry_run:false).
 *   4. After successful create: onRefresh fires and a fresh, empty draft row
 *      reopens (streak) — it does NOT collapse back to "+ New".
 *   5. A status=todo filter chip seeds the draft with status:"todo".
 *   6. Non-table kind / collapsed / no-onSpecChange → no "+ New" row.
 *   7. Field-editor Escape closes the cell editor but keeps draft open.
 *   8. Airtable add-row flow (Task 4): title commit creates + streak reopen,
 *      staged field values ride along in the single create call, and an
 *      empty-title Enter / Escape both end the streak without creating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";
import type {
  Schema,
  Envelope,
  TypeSummary,
  CreateDryRunData,
  CreateCommitData,
} from "@vault/query-core";
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
  enum_values: ["todo", "done"],
  ui: { widget: "enum" as const },
};

const TASK_SCHEMA: Schema = { name: "task", display_name: "Task", fields: [STATUS_FIELD] };

/** A field the card does NOT show as a column — the shape that made "Create" a
 *  silent dead button in production (task.context on the Project Alpha Onboarding board). */
const CONTEXT_FIELD = {
  name: "context",
  type: "string" as const,
  required: true,
  default_value: null,
  ui: { widget: "text" as const },
};

const SCHEMA_WITH_HIDDEN_REQUIRED: Schema = {
  name: "task", display_name: "Task", fields: [STATUS_FIELD, CONTEXT_FIELD],
};

/** dry-run that rejects over `context` — the engine's REQUIRED_MISSING shape. */
function makeRejectingDryRunEnv(): Envelope<CreateDryRunData> {
  return {
    ok: true,
    data: {
      dry_run: true as const,
      would_create: {
        file_path: "tasks/new-task.md", title: "My Task", types: ["task"],
        coerced_state: {}, fixable: [], orphan_fields: [],
      },
    },
    warnings: [{
      code: "REQUIRED_MISSING",
      message: 'Required field "context" is missing',
      severity: "error",
      field: "context",
    }],
  } as Envelope<CreateDryRunData>;
}

function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

const ROW_A: VizRow = {
  id: "node-aaa",
  title: "Task A",
  file_path: "tasks/task-a.md",
  types: ["task"],
  fields: { status: "todo" },
  version: 3,
};

const TABLE_SPEC: VizSpec = {
  kind: "table",
  title: "Tasks",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

/**
 * A spec with a status=todo filter chip pre-applied.
 * The `fields.status.one_of` key serializes as a filter chip after
 * parseArgs() + promoteFragments() runs in use-viz-query.
 */
const TABLE_SPEC_WITH_CHIP: VizSpec = {
  kind: "table",
  title: "Todo tasks",
  query: {
    types: ["task"],
    sort_by: "title",
    sort_order: "asc",
    limit: 50,
    fields: { status: { one_of: ["todo"] } },
  },
  display_fields: ["status"],
};

function makeCreateDryRunEnv(): Envelope<CreateDryRunData> {
  return okEnv({
    dry_run: true as const,
    would_create: {
      file_path: "tasks/new-task.md",
      title: "My Task",
      types: ["task"],
      coerced_state: {},
      fixable: [],
      orphan_fields: [],
    },
  });
}

function makeCreateCommitEnv(): Envelope<CreateCommitData> {
  return okEnv({
    node_id: "node-new-123",
    file_path: "tasks/new-task.md",
    title: "My Task",
    types: ["task"],
    coerced_state: {},
    orphan_fields: [],
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
      okEnv([{ type: "task", count: 1, has_schema: true, claim_count: null }]),
    ),
    batchMutate: vi.fn(),
  };
  return { ...base, ...overrides };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let mockClient: Client;

beforeEach(() => {
  _resetCachesForTest();
  _rows = [{ ...ROW_A }];
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

describe("viz-draft-integration — + New row gating", () => {
  it("editable table shows '+ New task' affordance", async () => {
    renderEditable();
    await waitForSchema();
    expect(screen.queryByText(/\+ New task/i)).not.toBeNull();
  });

  it("does NOT show '+ New' row when kind is not table", async () => {
    renderEditable({ kind: "kanban" });
    // For non-table we don't need schema, but let's check immediately
    expect(screen.queryByText(/\+ New/i)).toBeNull();
  });

  it("does NOT show '+ New' row when collapsed", async () => {
    renderEditable({ collapsed: true });
    expect(screen.queryByText(/\+ New/i)).toBeNull();
  });

  it("does NOT show '+ New' row when no onSpecChange (read-only)", async () => {
    renderEditable({ onSpecChange: undefined });
    expect(screen.queryByText(/\+ New/i)).toBeNull();
  });
});

describe("viz-draft-integration — click + New opens draft", () => {
  it("clicking '+ New task' opens the draft row with title input", async () => {
    renderEditable();
    await waitForSchema();

    const addRow = screen.getByText(/\+ New task/i).closest("tr")!;
    await act(async () => { fireEvent.click(addRow); });

    await waitFor(() => {
      // The draft row's title cell is a normal cell: it opens its own text
      // editor (same `.cell-input` a real row's title editor uses).
      const input = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement | null;
      expect(input).not.toBeNull();
    }, { timeout: 2000 });
  });
});

describe("viz-draft-integration — full create flow (dry-run → commit)", () => {
  it("type title + Enter fires createNode(dry_run:true) then createNode(dry_run:false)", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as Envelope<CreateDryRunData | CreateCommitData>)
      .mockResolvedValueOnce(makeCreateCommitEnv() as Envelope<CreateDryRunData | CreateCommitData>);

    renderEditable();
    await waitForSchema();

    // Open draft
    const addRow = screen.getByText(/\+ New task/i).closest("tr")!;
    await act(async () => { fireEvent.click(addRow); });

    await waitFor(() => {
      expect(document.querySelector("tr.draft-row td.c-title .cell-input")).not.toBeNull();
    });

    // Type a title and commit with Enter — there is no separate "Create" button;
    // submitting the title cell IS the create (submitEdit → commitWithTitle).
    const titleInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "My Task" } });
      fireEvent.keyDown(titleInput, { key: "Enter" });
    });

    // Wait for both createNode calls
    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode)).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });

    const [firstCall, secondCall] = vi.mocked(mockClient.createNode).mock.calls;
    expect(firstCall![0]).toMatchObject({ dry_run: true, title: "My Task", types: ["task"] });
    expect(secondCall![0]).toMatchObject({ dry_run: false, title: "My Task", types: ["task"] });
  });

  it("after successful create, onRefresh fires and a fresh draft row opens (streak)", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as Envelope<CreateDryRunData | CreateCommitData>)
      .mockResolvedValueOnce(makeCreateCommitEnv() as Envelope<CreateDryRunData | CreateCommitData>);

    renderEditable();
    await waitForSchema();

    // Open draft
    const addRow = screen.getByText(/\+ New task/i).closest("tr")!;
    await act(async () => { fireEvent.click(addRow); });

    await waitFor(() => {
      expect(document.querySelector("tr.draft-row td.c-title .cell-input")).not.toBeNull();
    });

    const titleInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "My Task" } });
      fireEvent.keyDown(titleInput, { key: "Enter" });
    });

    // onRefresh called + the committed draft is replaced by a fresh, empty one
    // (Task 4 streak: a successful create reopens a blank draft row rather than
    // closing back to the collapsed "+ New" affordance).
    await waitFor(() => {
      expect(_refresh).toHaveBeenCalled();
    }, { timeout: 3000 });

    await waitFor(() => {
      const input = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.value).toBe("");
    }, { timeout: 3000 });
  });
});

describe("viz-draft-integration — seed from filter chip", () => {
  it("status=todo filter chip seeds draft with status:todo pre-filled", async () => {
    renderEditable({ spec: TABLE_SPEC_WITH_CHIP });

    // For TABLE_SPEC_WITH_CHIP the only field (status) gets promoted to a chip,
    // so addableFields becomes empty and the "+ filter" button never appears.
    // Instead wait for schema by checking that DraftRow renders (lockedType+schema available).
    // We flush enough microtasks for describeSchema + promoteFragments to run.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Wait for "+ New task" to appear (DraftRow requires lockedType+schema)
    await waitFor(() => {
      expect(screen.queryByText(/\+ New task/i)).not.toBeNull();
    }, { timeout: 3000 });

    // Open draft
    const addRow = screen.getByText(/\+ New task/i).closest("tr")!;
    await act(async () => { fireEvent.click(addRow); });

    await waitFor(() => {
      expect(document.querySelector("tr.draft-row td.c-title .cell-input")).not.toBeNull();
    });

    // The status field cell should show "todo" as a pre-filled value
    // (seedFieldsFromFilters seeds the status field from the chip's one_of:[todo]) —
    // rendered by the SAME renderFieldCell a real row's status cell uses.
    await waitFor(() => {
      const statusCell = document.querySelector('tr.draft-row td[data-field="status"]');
      expect(statusCell?.textContent?.trim()).toBe("todo");
    }, { timeout: 3000 });
  });
});

describe("viz-draft-integration — field-editor Escape keeps draft open", () => {
  it("Escape in a field cell editor closes the editor but keeps draft open", async () => {
    renderEditable();
    await waitForSchema();

    // Open draft — the title cell auto-opens its editor (draft.editing===TITLE_FIELD).
    const addRow = screen.getByText(/\+ New task/i).closest("tr")!;
    await act(async () => { fireEvent.click(addRow); });

    await waitFor(() => {
      expect(document.querySelector("tr.draft-row td.c-title .cell-input")).not.toBeNull();
    });

    // Click the status field cell directly — this moves editing from the title
    // to "status" (draft.editCell) WITHOUT submitting the title (no create fires).
    const statusCellInner = document.querySelector(
      'tr.draft-row td[data-field="status"] .cell-inner',
    ) as HTMLElement;
    expect(statusCellInner).not.toBeNull();
    await act(async () => { fireEvent.click(statusCellInner); });

    // Field cell editor should now be open (status is an enum → a listbox popover)
    await waitFor(() => {
      expect(document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')).not.toBeNull();
    }, { timeout: 2000 });

    // Press Escape inside the field editor → onCancel → cellEdit.cancelEdit(), which
    // (since draft.editing==="status", not TITLE_FIELD/null) calls draft.exitEdit() —
    // closing just this field's editor, NOT the whole draft (that would be the bug).
    const listbox = document.querySelector(
      'tr.draft-row td[data-field="status"] [role="listbox"]',
    ) as HTMLElement;
    await act(async () => { fireEvent.keyDown(listbox, { key: "Escape" }); });

    // Draft should still be open (draft-row exists), but the field editor is closed.
    await waitFor(() => {
      expect(document.querySelector("tr.draft-row")).not.toBeNull();
      expect(document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')).toBeNull();
    }, { timeout: 2000 });

    // The draft never committed — no create call fired.
    expect(mockClient.createNode).not.toHaveBeenCalled();
  });
});

describe("viz-draft-integration — Airtable add-row flow", () => {
  it("typing a title + Enter creates the node and opens a fresh row below", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as never)
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);
    renderEditable();
    await waitForSchema();

    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });
    const input = document.querySelector("tr.draft-row .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "My Task" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode).mock.calls.map(([a]) => a.dry_run)).toEqual([true, false]);
    });
    // streak: a new empty draft row is open, focused on its title
    await waitFor(() => {
      const next = document.querySelector("tr.draft-row .cell-input") as HTMLInputElement | null;
      expect(next).not.toBeNull();
      expect(next!.value).toBe("");
    });
  });

  it("staged cell values ride along in the single create call", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as never)
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);
    renderEditable();
    await waitForSchema();
    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    // edit a field cell BEFORE the row has a title. `status` is an enum field
    // (see STATUS_FIELD) — its editor is EnumCellEditor, a listbox of options
    // selected via mouseDown (not a `.cell-input` text box); same interaction
    // pattern used for this field elsewhere, e.g. viz-bulk-integration.test.tsx.
    await act(async () => { fireEvent.click(document.querySelector('tr.draft-row td[data-field="status"] .cell-inner')!); });
    await waitFor(() => {
      expect(document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')).not.toBeNull();
    });
    const doneOption = Array.from(
      document.querySelectorAll('tr.draft-row td[data-field="status"] [role="option"]'),
    ).find((el) => el.textContent?.trim() === "done") as HTMLElement | undefined;
    expect(doneOption).not.toBeUndefined();
    await act(async () => { fireEvent.mouseDown(doneOption!); });
    expect(mockClient.updateNode).not.toHaveBeenCalled();   // staged, not written

    await act(async () => { fireEvent.click(document.querySelector('tr.draft-row td.c-title .cell-inner')!); });
    const titleEditor = document.querySelector("tr.draft-row .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleEditor, { target: { value: "Staged Task" } });
      fireEvent.keyDown(titleEditor, { key: "Enter" });
    });

    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode).mock.calls[0]![0])
        .toMatchObject({ title: "Staged Task", fields: expect.objectContaining({ status: "done" }), dry_run: true });
    });
  });

  it("streak reopen re-seeds from the active filter chip (status=todo), not a bare start()", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as never)
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);
    renderEditable({ spec: TABLE_SPEC_WITH_CHIP });

    // TABLE_SPEC_WITH_CHIP promotes status to a chip, so "+ filter" never
    // appears — wait for "+ New task" instead, same as the seed-from-filter-
    // chip test above.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => {
      expect(screen.queryByText(/\+ New task/i)).not.toBeNull();
    }, { timeout: 3000 });

    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    // Sanity: the FIRST draft (opened via the "+ New" click site) is seeded —
    // this much is already covered by the "seed from filter chip" describe
    // block above.
    await waitFor(() => {
      const statusCell = document.querySelector('tr.draft-row td[data-field="status"]');
      expect(statusCell?.textContent?.trim()).toBe("todo");
    });

    const titleInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "My Task" } });
      fireEvent.keyDown(titleInput, { key: "Enter" });
    });

    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode).mock.calls.map(([a]) => a.dry_run)).toEqual([true, false]);
    });

    // The point of this test: the REOPENED draft (streak call site, VizTable's
    // own useEffect — a different call site than the "+ New" click handler)
    // must carry the seed too. A regression to `draft.start()` (no seedFields
    // argument) would leave this row's status cell empty instead of "todo".
    await waitFor(() => {
      const titleCellInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement | null;
      expect(titleCellInput).not.toBeNull();
      expect(titleCellInput!.value).toBe("");
      const statusCell = document.querySelector('tr.draft-row td[data-field="status"]');
      expect(statusCell?.textContent?.trim()).toBe("todo");
    });
  });

  // The canonical Airtable gesture: title, Tab, fill a cell, come back, Enter.
  // Tab used to submit the title cell (TextCellEditor treats Tab as a commit) AND
  // bubble to the <td>'s Tab nav, so the node was created on the FIRST Tab carrying
  // only the title — everything typed afterwards was staged into a draft that had
  // already closed, and was silently dropped. Design Part B: "Tab never creates."
  it("Tab in the draft title stages the title and moves on WITHOUT creating", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as never)
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);
    renderEditable();
    await waitForSchema();
    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    const titleInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "Buy milk" } });
      fireEvent.keyDown(titleInput, { key: "Tab" });
    });

    // Nothing was created — not even a dry-run.
    expect(mockClient.createNode).not.toHaveBeenCalled();
    // The draft is still open and Tab moved to the next column's editor.
    expect(document.querySelector("tr.draft-row")).not.toBeNull();
    await waitFor(() => {
      expect(document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')).not.toBeNull();
    });

    // Fill that cell, then come back to the title: the staged title is still there.
    const doneOption = Array.from(
      document.querySelectorAll('tr.draft-row td[data-field="status"] [role="option"]'),
    ).find((el) => el.textContent?.trim() === "done") as HTMLElement;
    // A MOUSE pick only stages — choosing a status must not yank the user into the
    // next row mid-entry. Still nothing created.
    await act(async () => { fireEvent.mouseDown(doneOption); });
    expect(mockClient.createNode).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(document.querySelector("tr.draft-row td.c-title .cell-inner")!); });
    const backToTitle = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    expect(backToTitle.value).toBe("Buy milk");

    // Enter creates — once, carrying BOTH the title and the value typed after the Tab.
    await act(async () => { fireEvent.keyDown(backToTitle, { key: "Enter" }); });
    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode).mock.calls.map(([a]) => a.dry_run)).toEqual([true, false]);
    });
    for (const [args] of vi.mocked(mockClient.createNode).mock.calls) {
      expect(args).toMatchObject({ title: "Buy milk", fields: { status: "done" } });
    }
  });

  // The gesture the grid actually invites: name it, Tab across, Enter where you are.
  // Before this, that last Enter staged and nothing happened — the row sat there
  // looking finished with no node behind it.
  it("Enter in a FIELD cell creates the row, carrying the values Tab staged", async () => {
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeCreateDryRunEnv() as never)
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);
    renderEditable();
    await waitForSchema();
    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    const titleInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "Buy milk" } });
      fireEvent.keyDown(titleInput, { key: "Tab" });          // stages, moves on
    });
    expect(mockClient.createNode).not.toHaveBeenCalled();

    // Enter in the status cell's editor — keyboard, not a mouse pick.
    await waitFor(() => {
      expect(document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')).not.toBeNull();
    });
    const listbox = document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')!;
    await act(async () => { fireEvent.keyDown(listbox, { key: "Enter" }); });

    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode).mock.calls.map(([a]) => a.dry_run)).toEqual([true, false]);
    });
    for (const [args] of vi.mocked(mockClient.createNode).mock.calls) {
      expect(args).toMatchObject({ title: "Buy milk" });
    }
    // and the streak opens the next row
    await waitFor(() => {
      const next = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement | null;
      expect(next?.value).toBe("");
    });
  });

  // The production bug, end to end: a create rejected over a field the card has no
  // column for. Before the rescue strip it was invisible; before this commit the
  // strip collected the value and then just sat there, leaving a row that looked
  // committed with no node behind it.
  it("a create rejected over a hidden field recovers: fill the strip, the row is created", async () => {
    mockClient = makeMockClient({
      describeSchema: vi.fn<[string], Promise<Envelope<Schema>>>().mockResolvedValue(okEnv(SCHEMA_WITH_HIDDEN_REQUIRED)),
    });
    vi.mocked(mockClient.createNode)
      .mockResolvedValueOnce(makeRejectingDryRunEnv() as never)   // 1st attempt: rejected
      .mockResolvedValueOnce(makeCreateDryRunEnv() as never)      // retry dry-run: clean
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);     // retry commit
    renderEditable();
    await waitForSchema();
    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    const titleInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "My Task" } });
      fireEvent.keyDown(titleInput, { key: "Enter" });
    });

    // Rejected: nothing created, and the error is VISIBLE with a way to fix it.
    await waitFor(() => {
      expect(document.querySelector(".draft-blocked-row")).not.toBeNull();
    });
    expect(document.querySelector(".draft-blocked-row")!.textContent).toMatch(/context/);
    expect(vi.mocked(mockClient.createNode).mock.calls.map(([a]) => a.dry_run)).toEqual([true]);

    // Supplying the value retries the create — no second trip to the title.
    const stripInput = document.querySelector('.draft-blocked-row [data-field="context"] .cell-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(stripInput, { target: { value: "work" } });
      fireEvent.keyDown(stripInput, { key: "Enter" });
    });

    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode).mock.calls.map(([a]) => a.dry_run)).toEqual([true, true, false]);
    });
    // the retry carried BOTH the title and the field the strip collected
    const commitArgs = vi.mocked(mockClient.createNode).mock.calls.at(-1)![0];
    expect(commitArgs).toMatchObject({ title: "My Task", fields: { context: "work" }, dry_run: false });
    // and the strip is gone
    await waitFor(() => expect(document.querySelector(".draft-blocked-row")).toBeNull());
  });

  it("Enter on an empty title ends the streak, and Escape discards the row", async () => {
    renderEditable();
    await waitForSchema();
    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    const input = document.querySelector("tr.draft-row .cell-input") as HTMLInputElement;
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(document.querySelector("tr.draft-row")).toBeNull());
    expect(mockClient.createNode).not.toHaveBeenCalled();
    expect(document.querySelector(".draft-add-row")).not.toBeNull();

    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });
    const again = document.querySelector("tr.draft-row .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(again, { target: { value: "abandoned" } });
      fireEvent.keyDown(again, { key: "Escape" });
    });
    await waitFor(() => expect(document.querySelector("tr.draft-row")).toBeNull());
    expect(mockClient.createNode).not.toHaveBeenCalled();
  });

  // DRAFT-INV-6 at the UI level (streak makes rapid serial Enter-presses the normal
  // case): commitWithTitle guards on busy/inFlightRef BEFORE its SET_TITLE dispatch,
  // so a second title submit fired while the first create's dry-run is still in
  // flight changes NOTHING — not the server calls, and not the displayed title.
  // (Until 2026-07-25 the dispatch ran first, so the row briefly showed a title that
  // was never going to be created; that flash is what this test now forbids.)
  // A manually-resolved createNode mock forces the window where the first dry-run is
  // still pending when the second submit fires.
  it("rapid second title submit while the first create is in flight: only one commit reaches the server", async () => {
    let resolveDryRun!: (env: Envelope<CreateDryRunData>) => void;
    const pendingDryRun = new Promise<Envelope<CreateDryRunData>>((resolve) => {
      resolveDryRun = resolve;
    });
    vi.mocked(mockClient.createNode)
      .mockImplementationOnce(() => pendingDryRun as never)
      .mockResolvedValueOnce(makeCreateCommitEnv() as never);

    renderEditable();
    await waitForSchema();
    await act(async () => { fireEvent.click(screen.getByText(/\+ New task/i).closest("tr")!); });

    // First submit: "First" — its dry-run createNode call is now in flight
    // (pendingDryRun is not yet resolved), so useVizDraft's busy flag is true
    // and inFlightRef is set, but nothing has committed yet.
    const firstInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(firstInput, { target: { value: "First" } });
      fireEvent.keyDown(firstInput, { key: "Enter" });
    });
    expect(vi.mocked(mockClient.createNode)).toHaveBeenCalledTimes(1);

    // The accepted first submit dispatched SET_TITLE with editing:null (see
    // use-viz-draft.ts SET_TITLE), so the title cell no longer shows an editor —
    // it renders the (busy) draft's plain title text. Reopen it by clicking the
    // title cell again — busy does not block beginEdit/EDIT_CELL — and submit a
    // second value before the first create resolves.
    await act(async () => {
      fireEvent.click(document.querySelector('tr.draft-row td.c-title .cell-inner')!);
    });
    const secondInput = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement;
    expect(secondInput).not.toBeNull();
    await act(async () => {
      fireEvent.change(secondInput, { target: { value: "Second" } });
      fireEvent.keyDown(secondInput, { key: "Enter" });
    });

    // Still only the one (pending) dry-run call — commitTitle's busy guard
    // dropped the second commit attempt before it could call createNode again.
    expect(vi.mocked(mockClient.createNode)).toHaveBeenCalledTimes(1);

    // The dropped submit left the draft untouched: no SET_TITLE landed, so the
    // row never repaints as "Second" — a title that will never be created (the
    // in-flight create is for "First", and its outcome is what the draft is about
    // to act on). The title editor is simply still open, exactly as it was.
    const titleCell = document.querySelector('tr.draft-row td.c-title .cell-inner');
    expect(titleCell?.textContent).not.toContain("Second");
    expect(document.querySelector("tr.draft-row td.c-title .cell-input")).not.toBeNull();

    // Resolve the first (and only) create. finalizeCreate closed over "First"
    // as its argument at the moment commitTitle("First") was first invoked —
    // that value does not depend on any later SET_TITLE dispatch — so the
    // commit call that goes out uses "First", the title the user saw.
    await act(async () => {
      resolveDryRun(makeCreateDryRunEnv());
      await pendingDryRun;
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(vi.mocked(mockClient.createNode)).toHaveBeenCalledTimes(2);
    });
    const [, secondCall] = vi.mocked(mockClient.createNode).mock.calls;
    expect(secondCall![0]).toMatchObject({ dry_run: false, title: "First" });

    // Streak then reopens a fresh, empty draft — the dropped "Second" is not
    // carried over into it either.
    await waitFor(() => {
      const input = document.querySelector("tr.draft-row td.c-title .cell-input") as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.value).toBe("");
    });

    // Exactly one commit (dry_run:false) call ever reached the server — no
    // double create.
    expect(
      vi.mocked(mockClient.createNode).mock.calls.filter(([a]) => a.dry_run === false).length,
    ).toBe(1);
  });
});
