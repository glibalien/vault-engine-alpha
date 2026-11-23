import { describe, it, expect, vi } from "vitest";
import { requiredDraftCells, draftSequence, nextDraftCell, startDraft, commitDraft } from "../../src/flows/create.js";
import type { Schema, DraftState, UiState } from "../../src/types.js";

const schema: Schema = {
  name: "task",
  display_name: null,
  fields: [
    { name: "status", type: "enum", required: true, default_value: "open", enum_values: ["open", "done"], ui: null },
    { name: "priority", type: "enum", required: true, default_value: null, enum_values: ["low", "high"], ui: null },
    { name: "due", type: "date", required: false, default_value: null, ui: null },
    { name: "project", type: "reference", required: true, default_value: null, reference_target: "project", ui: null },
  ],
};

function draft(over: Partial<DraftState> = {}): DraftState {
  return { title: "", fields: {}, editing: "__title__", error: null, pending: null, busy: false, ...over };
}

describe("requiredDraftCells", () => {
  it("returns only required fields that lack a default", () => {
    expect(requiredDraftCells(schema)).toEqual(["priority", "project"]);
  });
});

describe("draftSequence", () => {
  it("puts the title first, then required-without-default fields in schema order", () => {
    expect(draftSequence(schema)).toEqual(["__title__", "priority", "project"]);
  });
});

describe("nextDraftCell", () => {
  it("advances title → first unfilled required field", () => {
    expect(nextDraftCell(schema, draft({ title: "X" }), "__title__")).toBe("priority");
  });

  it("skips a required field that is already filled", () => {
    expect(nextDraftCell(schema, draft({ title: "X", fields: { priority: "high" } }), "__title__")).toBe("project");
  });

  it("returns null when the guided sequence is complete", () => {
    expect(nextDraftCell(schema, draft({ title: "X", fields: { priority: "high", project: "P" } }), "project")).toBeNull();
  });
});

describe("startDraft", () => {
  it("abandons an in-progress normal-cell edit/pending/error when opening a draft", () => {
    const state = {
      lockedType: "task",
      recentOps: [],
      editing: { id: "n1", field: "status" },
      pending: { id: "n1", field: "status", value: "x", version: 1, warnings: [], reasons: [] },
      cellError: { id: "n1", field: "status", code: "X", message: "y" },
      draft: null,
    } as unknown as UiState;
    startDraft(state);
    expect(state.editing).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.cellError).toBeNull();
    expect(state.draft).not.toBeNull();
    expect(state.draft!.editing).toBe("__title__");
  });

  it("seeds draft fields from active reference + single-value enum filters for the locked type", () => {
    const state = {
      lockedType: "task",
      schemaCache: new Map([["task", schema]]),
      filtersByType: {
        task: [
          { field: "project", state: { exists: null, target: { id: "p1", title: "AskAcme Phase 2 Rollout" } } },
          { field: "status", state: { one_of: ["done"] } },
        ],
      },
      callerFragments: [],
      recentOps: [],
      editing: null,
      pending: null,
      cellError: null,
      draft: null,
    } as unknown as UiState;

    startDraft(state);

    expect(state.draft!.fields).toEqual({ project: "AskAcme Phase 2 Rollout", status: "done" });
    expect(state.draft!.editing).toBe("__title__");
  });
});

describe("commitDraft double-submit guard", () => {
  it("ignores a second commit while the first create is still in flight", async () => {
    let resolveDry: (v: unknown) => void = () => {};
    const createNode = vi.fn().mockImplementation(() => new Promise((r) => { resolveDry = r; }));
    const client = { createNode } as unknown as import("../../src/client.js").Client;

    const state = {
      lockedType: "task",
      recentOps: [],
      draft: { title: "My Task", fields: {}, editing: null, error: null, pending: null, busy: false } as DraftState,
    } as unknown as UiState;

    const p1 = commitDraft(state, client);            // sets busy=true, awaits createNode
    const r2 = await commitDraft(state, client);       // busy → immediate stay, no second call
    expect(r2).toEqual({ kind: "stay" });
    expect(createNode).toHaveBeenCalledTimes(1);

    // Resolve the dry-run as a PROMOTE (surprising coercion) so commitDraft returns
    // "stay" without a second createNode call, making the test deterministic.
    resolveDry({ ok: true, data: { dry_run: true, would_create: { file_path: "Tasks/My Task.md", title: "My Task", types: ["task"], coerced_state: { due: { field: "due", value: "2026-06-12", source: "provided", changed: true, original: "next friday", coercion_code: "STRING_TO_DATE_FUZZY" } }, fixable: [], orphan_fields: [] } }, warnings: [] });
    const r1 = await p1;
    expect(r1).toEqual({ kind: "stay" });
    expect(createNode).toHaveBeenCalledTimes(1);   // still only one call total
    expect(state.draft?.busy).toBe(false);          // busy reset by the finally
  });
});
