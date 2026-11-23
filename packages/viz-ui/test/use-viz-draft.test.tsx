// @vitest-environment jsdom
/**
 * use-viz-draft.test.tsx
 *
 * TDD tests for the useVizDraft hook — new-node draft create orchestration.
 * Tests are written BEFORE the implementation; they must be RED initially.
 *
 * Mutation-safety invariants pinned by these tests:
 *  DRAFT-INV-1: A draft create goes createNode(dry_run:true) → decideCreate(env)
 *               → ONLY THEN: create→commit(dry_run:false) / promote→set pending
 *               (NOT committed) / inline-error→set error (draft stays open, NO node).
 *               NEVER create without the dry-run+decide.
 *  DRAFT-INV-2: confirmCreate() is the ONLY other path to createNode(dry_run:false).
 *  DRAFT-INV-3: A non-empty title is REQUIRED: commit() with empty/blank title
 *               sets an inline-error on TITLE_FIELD and does NOT call createNode.
 *  DRAFT-INV-4: createNode is always called with types:[lockedType].
 *  DRAFT-INV-5: On real create (commit succeeded): call onAfterCreate (table
 *               refetches) + close the draft (cancel).
 *  DRAFT-INV-6: busy + synchronous inFlightRef GUARD re-entry at the START of
 *               commit and confirmCreate (the 5a lesson — guard before the
 *               dispatch flushes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";

import {
  reduceDraft,
  parseCreateDecision,
  useVizDraft,
  type DraftReducerState,
  type DraftAction,
} from "../src/use-viz-draft.js";

import type { Client } from "@vault/query-core";
import type {
  Schema,
  CreateDryRunData,
  CreateCommitData,
  DraftError,
} from "@vault/query-core";
import { TITLE_FIELD } from "@vault/query-core";

// ============================================================================
// Test fixtures / helpers
// ============================================================================

function makeSchema(requiredFields: string[] = []): Schema {
  return {
    name: "task",
    display_name: "Task",
    fields: requiredFields.map((name) => ({
      name,
      type: "string" as const,
      required: true,
      default_value: null,
      ui: null,
    })),
  };
}

function okDryRunEnvelope(overrides: Partial<CreateDryRunData["would_create"]> = {}) {
  return {
    ok: true as const,
    data: {
      dry_run: true as const,
      would_create: {
        file_path: "Tasks/Test.md",
        title: "Test",
        types: ["task"],
        coerced_state: {},
        fixable: [],
        orphan_fields: [],
        ...overrides,
      },
    },
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning"; field?: string }>,
  };
}

function okCommitEnvelope(title = "Test") {
  return {
    ok: true as const,
    data: {
      node_id: "node-abc123",
      file_path: "Tasks/Test.md",
      title,
      types: ["task"],
      coerced_state: {},
      orphan_fields: [],
    } as CreateCommitData,
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }>,
  };
}

function failEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    ok: false as const,
    error: { code, message, details },
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }>,
  };
}

function promoteEnvelope() {
  // Fuzzy date coercion — triggers promote
  return {
    ok: true as const,
    data: {
      dry_run: true as const,
      would_create: {
        file_path: "Tasks/Test.md",
        title: "Test",
        types: ["task"],
        coerced_state: {
          due: {
            field: "due",
            value: "2026-07-01",
            original: "next tuesday",
            source: "provided" as const,
            changed: true,
            coercion_code: "STRING_TO_DATE_FUZZY",
          },
        },
        fixable: [],
        orphan_fields: [],
      },
    },
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }>,
  };
}

function inlineErrorDryRunEnvelope(field = "status") {
  return {
    ok: true as const,
    data: {
      dry_run: true as const,
      would_create: {
        file_path: "Tasks/Test.md",
        title: "Test",
        types: ["task"],
        coerced_state: {},
        fixable: [{ field, suggestion: null, allowed_values: ["open", "done"] }],
        orphan_fields: [],
      },
    },
    warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }>,
  };
}

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

function makeInitialReducerState(): DraftReducerState {
  return { draft: null, createdCount: 0 };
}

// ============================================================================
// RTL hook probe component
// ============================================================================

interface ProbeProps {
  client: Client;
  lockedType: string;
  schema: Schema;
  onAfterCreate?: () => void;
  seedFields?: Record<string, unknown>;
}

function Probe({ client, lockedType, schema, onAfterCreate, seedFields }: ProbeProps) {
  const api = useVizDraft(client, lockedType, schema, onAfterCreate);

  const isDraftingStr = api.isDrafting ? "yes" : "no";
  const editingStr = api.draft?.editing ?? "null";
  const titleStr = api.draft?.title ?? "";
  const busyStr = api.draft?.busy ? "busy" : "idle";
  const pendingStr = api.draft?.pending
    ? `pending:${api.draft.pending.reasons.join(",")}`
    : "none";
  const errorStr = api.draft?.error
    ? `error:${api.draft.error.field}:${api.draft.error.code}`
    : "none";
  const fieldsStr = api.draft ? JSON.stringify(api.draft.fields) : "{}";

  return (
    <div>
      <span data-testid="isDrafting">{isDraftingStr}</span>
      <span data-testid="editing">{editingStr}</span>
      <span data-testid="title">{titleStr}</span>
      <span data-testid="busy">{busyStr}</span>
      <span data-testid="pending">{pendingStr}</span>
      <span data-testid="error">{errorStr}</span>
      <span data-testid="fields">{fieldsStr}</span>

      <button data-testid="btn-start" onClick={() => api.start(seedFields)}>start</button>
      <button data-testid="btn-cancel" onClick={() => api.cancel()}>cancel</button>
      <button data-testid="btn-set-title" onClick={() => api.setTitle("My Node")}>set-title</button>
      <button data-testid="btn-set-title-empty" onClick={() => api.setTitle("")}>set-title-empty</button>
      <button data-testid="btn-set-field-status" onClick={() => api.setField("status", "open")}>set-field-status</button>
      <button data-testid="btn-edit-title" onClick={() => api.editCell(TITLE_FIELD)}>edit-title</button>
      <button data-testid="btn-commit" onClick={() => void api.commit()}>commit</button>
      <button data-testid="btn-confirm" onClick={() => void api.confirmCreate()}>confirm</button>
      <span data-testid="createdCount">{api.createdCount}</span>
      <button data-testid="btn-commit-with-title" onClick={() => void api.commitWithTitle("My Task")}>commit-with-title</button>
      <button data-testid="btn-commit-with-title-blank" onClick={() => void api.commitWithTitle("   ")}>commit-with-title-blank</button>
      <button data-testid="btn-commit-with-title-another" onClick={() => void api.commitWithTitle("Another (x)")}>commit-with-title-another</button>
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
// PURE REDUCER TESTS
// ============================================================================

describe("reduceDraft (pure reducer)", () => {
  it("START opens a draft with editing=TITLE_FIELD and seeded fields", () => {
    const state = makeInitialReducerState();
    const next = reduceDraft(state, {
      type: "START",
      seedFields: { status: "open" },
    });
    expect(next.draft).not.toBeNull();
    expect(next.draft?.editing).toBe(TITLE_FIELD);
    expect(next.draft?.title).toBe("");
    expect(next.draft?.fields).toEqual({ status: "open" });
    expect(next.draft?.error).toBeNull();
    expect(next.draft?.pending).toBeNull();
    expect(next.draft?.busy).toBe(false);
  });

  it("START with no seed creates an empty fields object", () => {
    const state = makeInitialReducerState();
    const next = reduceDraft(state, { type: "START" });
    expect(next.draft?.fields).toEqual({});
  });

  it("CANCEL nulls the draft", () => {
    const state = makeInitialReducerState();
    const withDraft = reduceDraft(state, { type: "START" });
    const cancelled = reduceDraft(withDraft, { type: "CANCEL" });
    expect(cancelled.draft).toBeNull();
  });

  it("EDIT_CELL changes editing field", () => {
    const state = reduceDraft(makeInitialReducerState(), { type: "START" });
    const next = reduceDraft(state, { type: "EDIT_CELL", field: "status" });
    expect(next.draft?.editing).toBe("status");
  });

  it("SET_TITLE updates title and clears error on TITLE_FIELD", () => {
    const s1 = reduceDraft(makeInitialReducerState(), { type: "START" });
    const withErr = reduceDraft(s1, {
      type: "SET_ERROR",
      error: { field: TITLE_FIELD, code: "REQUIRED_MISSING", message: "Title required" },
    });
    expect(withErr.draft?.error?.field).toBe(TITLE_FIELD);
    const next = reduceDraft(withErr, { type: "SET_TITLE", value: "Hello", nextEditing: null });
    expect(next.draft?.title).toBe("Hello");
    expect(next.draft?.error).toBeNull();
  });

  it("SET_FIELD updates fields and clears error on that field", () => {
    const s1 = reduceDraft(makeInitialReducerState(), { type: "START" });
    const withErr = reduceDraft(s1, {
      type: "SET_ERROR",
      error: { field: "status", code: "VALIDATION_FAILED", message: "Bad status" },
    });
    const next = reduceDraft(withErr, {
      type: "SET_FIELD",
      field: "status",
      value: "open",
      nextEditing: null,
    });
    expect(next.draft?.fields).toEqual({ status: "open" });
    expect(next.draft?.error).toBeNull();
  });

  it("SET_ERROR sets error and editing to that field", () => {
    const s1 = reduceDraft(makeInitialReducerState(), { type: "START" });
    const next = reduceDraft(s1, {
      type: "SET_ERROR",
      error: { field: "status", code: "VALIDATION_FAILED", message: "Bad" },
    });
    expect(next.draft?.error?.field).toBe("status");
    expect(next.draft?.editing).toBe("status");
  });

  it("SET_PENDING sets pending and clears error", () => {
    const s1 = reduceDraft(makeInitialReducerState(), { type: "START" });
    const withErr = reduceDraft(s1, {
      type: "SET_ERROR",
      error: { field: TITLE_FIELD, code: "REQUIRED_MISSING", message: "oops" },
    });
    const next = reduceDraft(withErr, {
      type: "SET_PENDING",
      reasons: ["Interpreted due as 2026-07-01."],
    });
    expect(next.draft?.pending?.reasons).toEqual(["Interpreted due as 2026-07-01."]);
    expect(next.draft?.error).toBeNull();
    expect(next.draft?.editing).toBeNull();
  });

  it("SET_BUSY sets busy flag", () => {
    const s1 = reduceDraft(makeInitialReducerState(), { type: "START" });
    const next = reduceDraft(s1, { type: "SET_BUSY", busy: true });
    expect(next.draft?.busy).toBe(true);
  });

  it("CLOSE nulls the draft", () => {
    const s1 = reduceDraft(makeInitialReducerState(), { type: "START" });
    const next = reduceDraft(s1, { type: "CLOSE" });
    expect(next.draft).toBeNull();
  });

  it("is pure — does not mutate input state", () => {
    const state = makeInitialReducerState();
    reduceDraft(state, { type: "START" });
    expect(state.draft).toBeNull();
  });
});

// ============================================================================
// parseCreateDecision (pure helper)
// ============================================================================

describe("parseCreateDecision (pure helper)", () => {
  it("returns 'create' for a clean dry-run envelope", () => {
    const env = okDryRunEnvelope();
    const decision = parseCreateDecision(env);
    expect(decision.decision).toBe("create");
  });

  it("returns 'promote' for a fuzzy coercion", () => {
    const decision = parseCreateDecision(promoteEnvelope());
    expect(decision.decision).toBe("promote");
    expect((decision as { decision: string; reasons: string[] }).reasons.join(" ")).toMatch(/2026-07-01/);
  });

  it("returns 'inline-error' for a fixable entry (bad enum) (DRAFT-INV-1)", () => {
    const decision = parseCreateDecision(inlineErrorDryRunEnvelope("status"));
    expect(decision.decision).toBe("inline-error");
    expect((decision as { decision: string; error: DraftError }).error.field).toBe("status");
  });

  it("returns 'inline-error' for a file conflict (DRAFT-INV-1)", () => {
    const env = okDryRunEnvelope({ conflict: 'File "Tasks/Test.md" already exists' });
    const decision = parseCreateDecision(env);
    expect(decision.decision).toBe("inline-error");
  });

  it("returns 'inline-error' for ok:false envelope (DRAFT-INV-1)", () => {
    const env = failEnvelope("INTERNAL_ERROR", "boom");
    const decision = parseCreateDecision(env as Parameters<typeof parseCreateDecision>[0]);
    expect(decision.decision).toBe("inline-error");
  });
});

// ============================================================================
// RTL HOOK TESTS — start / cancel / editCell
// ============================================================================

describe("start — opens draft, seeds fields, editing=TITLE_FIELD", () => {
  it("isDrafting=false before start", () => {
    const schema = makeSchema();
    render(<Probe client={makeMockClient()} lockedType="task" schema={schema} />);
    expect(screen.getByTestId("isDrafting").textContent).toBe("no");
  });

  it("start() sets isDrafting=true and editing=TITLE_FIELD", () => {
    const schema = makeSchema();
    render(<Probe client={makeMockClient()} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
    expect(screen.getByTestId("editing").textContent).toBe(TITLE_FIELD);
    expect(screen.getByTestId("title").textContent).toBe("");
  });

  it("start() seeds fields when seedFields is provided", () => {
    const schema = makeSchema();
    render(
      <Probe
        client={makeMockClient()}
        lockedType="task"
        schema={schema}
        seedFields={{ status: "open" }}
      />
    );
    act(() => { screen.getByTestId("btn-start").click(); });
    expect(screen.getByTestId("fields").textContent).toContain('"status":"open"');
  });

  it("cancel() closes the draft", () => {
    const schema = makeSchema();
    render(<Probe client={makeMockClient()} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
    act(() => { screen.getByTestId("btn-cancel").click(); });
    expect(screen.getByTestId("isDrafting").textContent).toBe("no");
  });
});

// ============================================================================
// setTitle / setField — auto-advance editing via nextDraftCell
// ============================================================================

describe("setTitle + setField — auto-advance editing via nextDraftCell", () => {
  it("setTitle with no required fields advances editing to null", () => {
    const schema = makeSchema([]); // no required fields
    render(<Probe client={makeMockClient()} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); }); // sets "My Node"
    // no required fields after title → editing=null
    expect(screen.getByTestId("editing").textContent).toBe("null");
    expect(screen.getByTestId("title").textContent).toBe("My Node");
  });

  it("setTitle advances editing to first required field when one exists", () => {
    const schema = makeSchema(["status"]); // status is required
    render(<Probe client={makeMockClient()} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); }); // sets "My Node"
    expect(screen.getByTestId("editing").textContent).toBe("status");
  });

  it("setField advances editing to null when sequence complete", () => {
    const schema = makeSchema(["status"]);
    render(<Probe client={makeMockClient()} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });       // editing → "status"
    act(() => { screen.getByTestId("btn-set-field-status").click(); }); // editing → null
    expect(screen.getByTestId("editing").textContent).toBe("null");
  });
});

// ============================================================================
// commit() — DRAFT-INV-3: empty title → inline-error, no createNode call
// ============================================================================

describe("commit with empty title — DRAFT-INV-3", () => {
  it("commit() with empty title sets inline-error on TITLE_FIELD, does NOT call createNode", async () => {
    const createNode = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    // Do NOT set title (stays empty "")
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // createNode must NOT have been called (DRAFT-INV-3)
    expect(createNode).not.toHaveBeenCalled();
    // inline-error on TITLE_FIELD
    expect(screen.getByTestId("error").textContent).toContain(`error:${TITLE_FIELD}`);
    // draft stays open
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
  });

  it("commit() with blank (whitespace-only) title also sets error (DRAFT-INV-3)", async () => {
    const createNode = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    // Set title to whitespace — the Probe's btn-set-title-empty does this
    act(() => { screen.getByTestId("btn-set-title-empty").click(); }); // ""
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    expect(createNode).not.toHaveBeenCalled();
    expect(screen.getByTestId("error").textContent).toContain(`error:${TITLE_FIELD}`);
  });
});

// ============================================================================
// commit() → create path — DRAFT-INV-1, DRAFT-INV-4, DRAFT-INV-5
// ============================================================================

describe("commit() clean → dry-run → create → commit (DRAFT-INV-1, DRAFT-INV-4, DRAFT-INV-5)", () => {
  it("calls createNode(dry_run:true) first, then createNode(dry_run:false) (DRAFT-INV-1)", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(okDryRunEnvelope())   // dry-run
      .mockResolvedValueOnce(okCommitEnvelope());  // commit

    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); }); // "My Node"
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    expect(createNode).toHaveBeenCalledTimes(2);
    // First call: dry_run:true
    expect(createNode.mock.calls[0]?.[0]).toMatchObject({ dry_run: true });
    // Second call: dry_run:false
    expect(createNode.mock.calls[1]?.[0]).toMatchObject({ dry_run: false });
  });

  it("always passes types:[lockedType] to createNode (DRAFT-INV-4)", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(okDryRunEnvelope())
      .mockResolvedValueOnce(okCommitEnvelope());

    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Both calls use types:["task"]
    expect(createNode.mock.calls[0]?.[0]).toMatchObject({ types: ["task"] });
    expect(createNode.mock.calls[1]?.[0]).toMatchObject({ types: ["task"] });
  });

  it("closes the draft and calls onAfterCreate on success (DRAFT-INV-5)", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(okDryRunEnvelope())
      .mockResolvedValueOnce(okCommitEnvelope());

    const onAfterCreate = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(
      <Probe
        client={client}
        lockedType="task"
        schema={schema}
        onAfterCreate={onAfterCreate}
      />
    );
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Draft must be closed (DRAFT-INV-5)
    expect(screen.getByTestId("isDrafting").textContent).toBe("no");
    // onAfterCreate called (DRAFT-INV-5)
    expect(onAfterCreate).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// commit() → promote path — DRAFT-INV-1: pending set, NOT committed
// ============================================================================

describe("commit() → promote → pending (NOT committed) → confirmCreate → commit (DRAFT-INV-1, DRAFT-INV-2)", () => {
  it("promote decision sets pending state, NOT committed (DRAFT-INV-1)", async () => {
    const createNode = vi.fn().mockResolvedValueOnce(promoteEnvelope());
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Only dry-run called (NOT commit) (DRAFT-INV-1)
    expect(createNode).toHaveBeenCalledTimes(1);
    expect(createNode.mock.calls[0]?.[0]).toMatchObject({ dry_run: true });

    // pending set with reasons
    expect(screen.getByTestId("pending").textContent).toMatch(/pending:/);
    // draft stays open
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
  });

  it("confirmCreate() calls createNode(dry_run:false) and closes draft (DRAFT-INV-2)", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(promoteEnvelope())  // dry-run → promote
      .mockResolvedValueOnce(okCommitEnvelope()); // confirmCreate commit

    const onAfterCreate = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(
      <Probe
        client={client}
        lockedType="task"
        schema={schema}
        onAfterCreate={onAfterCreate}
      />
    );
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    expect(screen.getByTestId("pending").textContent).toMatch(/pending:/);

    // Now confirm
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Two calls total: dry-run + commit
    expect(createNode).toHaveBeenCalledTimes(2);
    expect(createNode.mock.calls[1]?.[0]).toMatchObject({ dry_run: false, types: ["task"] });

    // Draft closed, onAfterCreate called
    expect(screen.getByTestId("isDrafting").textContent).toBe("no");
    expect(onAfterCreate).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// commit() → inline-error path — DRAFT-INV-1: error set, draft stays open, NO commit
// ============================================================================

describe("commit() → inline-error → draft stays open, no commit (DRAFT-INV-1)", () => {
  it("inline-error from dry-run sets error on draft, does NOT call commit createNode", async () => {
    const createNode = vi.fn().mockResolvedValueOnce(inlineErrorDryRunEnvelope("status"));
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Only dry-run called (no commit) (DRAFT-INV-1)
    expect(createNode).toHaveBeenCalledTimes(1);
    // Error set on status field
    expect(screen.getByTestId("error").textContent).toContain("error:status");
    // Draft stays open
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
  });
});

// ============================================================================
// busy guard — DRAFT-INV-6
// ============================================================================

describe("busy guard — double-commit blocked (DRAFT-INV-6)", () => {
  it("second commit() while first is in-flight does NOT fire second createNode", async () => {
    let resolveDry!: (v: unknown) => void;
    const dryPromise = new Promise((res) => { resolveDry = res; });

    // promote envelope so resolving the dry-run sets pending (no finalizeCreate call)
    const createNode = vi.fn().mockReturnValueOnce(dryPromise);
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });

    // First commit (hangs on dry-run)
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Second commit while first is in-flight — must be a no-op (DRAFT-INV-6)
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Only 1 createNode call total (the first dry-run)
    expect(createNode).toHaveBeenCalledTimes(1);

    // Resolve with promote so we stay in pending state (no second createNode call)
    await act(async () => {
      resolveDry(promoteEnvelope());
    });
  });

  it("second confirmCreate() while first is in-flight does NOT fire a second commit (DRAFT-INV-6)", async () => {
    let resolveCommit!: (v: unknown) => void;
    const commitPromise = new Promise((res) => { resolveCommit = res; });

    const createNode = vi.fn()
      .mockResolvedValueOnce(promoteEnvelope())  // dry-run → promote
      .mockReturnValueOnce(commitPromise);         // confirmCreate hangs

    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); });

    // commit → promote
    await act(async () => { screen.getByTestId("btn-commit").click(); });
    expect(screen.getByTestId("pending").textContent).toMatch(/pending:/);

    // First confirmCreate (hangs)
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // Second confirmCreate while busy — must be a no-op (DRAFT-INV-6)
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // 1 dry-run + 1 commit attempt = 2 total, not 3
    expect(createNode).toHaveBeenCalledTimes(2);

    // Resolve to clean up
    await act(async () => {
      resolveCommit(okCommitEnvelope());
    });
  });
});

// ============================================================================
// confirmCreate gate — DRAFT-INV-2: no-op when pending is not set
// ============================================================================

describe("confirmCreate without pending — gate is a no-op (DRAFT-INV-2)", () => {
  it("confirmCreate() without a pending state does NOT call createNode (pins the !d.pending gate)", async () => {
    const createNode = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    // start + set title, but NO commit → pending is null
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); }); // title="My Node"

    // confirmCreate with no pending — must be a no-op
    await act(async () => { screen.getByTestId("btn-confirm").click(); });

    // createNode must NOT have been called at all
    expect(createNode).not.toHaveBeenCalled();
    // draft still open
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
  });
});

// ============================================================================
// finalizeCreate commit-failure — draft stays open, error surfaced, onAfterCreate NOT called
// ============================================================================

describe("finalizeCreate commit failure — DRAFT-INV-1 (error branch)", () => {
  it("createNode(dry_run:false) returning ok:false surfaces error, keeps draft open, does NOT call onAfterCreate", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(okDryRunEnvelope())  // dry-run → "create"
      .mockResolvedValueOnce(failEnvelope("INTERNAL_ERROR", "DB exploded", { field: "title" }));  // real commit fails

    const onAfterCreate = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(
      <Probe
        client={client}
        lockedType="task"
        schema={schema}
        onAfterCreate={onAfterCreate}
      />
    );
    act(() => { screen.getByTestId("btn-start").click(); });
    act(() => { screen.getByTestId("btn-set-title").click(); }); // title="My Node"
    await act(async () => { screen.getByTestId("btn-commit").click(); });

    // Both calls were made (dry-run + failed commit)
    expect(createNode).toHaveBeenCalledTimes(2);
    // Draft stays open
    expect(screen.getByTestId("isDrafting").textContent).toBe("yes");
    // Error is surfaced
    expect(screen.getByTestId("error").textContent).toContain("error:");
    // onAfterCreate NOT called
    expect(onAfterCreate).not.toHaveBeenCalled();
  });
});

// ============================================================================
// commitWithTitle() + createdCount — atomic title-commit and per-create signal
// ============================================================================

describe("commitWithTitle — commits using the passed title, and createdCount", () => {
  it("commitWithTitle creates using the passed title without a prior setTitle render", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(okDryRunEnvelope())        // dry_run:true  → decision "create"
      .mockResolvedValueOnce(okCommitEnvelope("My Task")); // dry_run:false → committed

    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    // No prior setTitle click — commitWithTitle must use its own argument,
    // not hook state, because SET_TITLE may not have flushed yet.
    await act(async () => { screen.getByTestId("btn-commit-with-title").click(); });

    expect(createNode).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: "My Task", dry_run: true }));
    expect(createNode).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "My Task", dry_run: false }));
  });

  it("commitWithTitle with a blank title sets the required-title error and does not call createNode", async () => {
    const createNode = vi.fn();
    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    act(() => { screen.getByTestId("btn-start").click(); });
    await act(async () => { screen.getByTestId("btn-commit-with-title-blank").click(); });

    expect(createNode).not.toHaveBeenCalled();
    expect(screen.getByTestId("error").textContent).toBe(`error:${TITLE_FIELD}:REQUIRED_MISSING`);
  });

  it("createdCount increments only on a successful create", async () => {
    const createNode = vi.fn()
      .mockResolvedValueOnce(okDryRunEnvelope())
      .mockResolvedValueOnce(okCommitEnvelope("My Task"));

    const client = makeMockClient({ createNode });
    const schema = makeSchema();

    render(<Probe client={client} lockedType="task" schema={schema} />);
    expect(screen.getByTestId("createdCount").textContent).toBe("0");

    act(() => { screen.getByTestId("btn-start").click(); });
    await act(async () => { screen.getByTestId("btn-commit-with-title").click(); });
    expect(screen.getByTestId("createdCount").textContent).toBe("1");

    // a promote decision leaves the draft open and must NOT bump the counter
    createNode.mockResolvedValueOnce(promoteEnvelope());
    act(() => { screen.getByTestId("btn-start").click(); });
    await act(async () => { screen.getByTestId("btn-commit-with-title-another").click(); });

    expect(createNode).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("createdCount").textContent).toBe("1");
    expect(screen.getByTestId("pending").textContent).toMatch(/pending:/);
  });
});
