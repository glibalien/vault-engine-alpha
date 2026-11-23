// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { TITLE_FIELD } from "@vault/query-core";
import type { VizCellEditAPI } from "../src/use-viz-cell-edit.js";
import type { VizDraftAPI } from "../src/use-viz-draft.js";
import type { DraftState } from "@vault/query-core";
import type { VizRow } from "../src/viz-spec.js";
import { DRAFT_ROW_ID, draftRowFor, useDraftEditAdapter } from "../src/use-draft-edit-adapter.js";

const REAL_ROW: VizRow = { id: "n1", title: "Real", file_path: "a.md", types: ["task"], fields: { status: "open" }, version: 2 };

function makeBase(overrides: Partial<VizCellEditAPI> = {}): VizCellEditAPI {
  return {
    cellValue: vi.fn(() => "base-value"),
    cellTitle: vi.fn(() => "base-title"),
    editing: null, pending: null, cellError: null,
    isStale: vi.fn(() => true), isFlashing: vi.fn(() => true),
    isEditing: false, busy: false,
    beginEdit: vi.fn(), submitEdit: vi.fn().mockResolvedValue(undefined),
    confirmPending: vi.fn().mockResolvedValue(undefined), cancelEdit: vi.fn(),
    reloadRow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDraftState(o: Partial<DraftState> = {}): DraftState {
  return { title: "", fields: {}, editing: TITLE_FIELD, error: null, pending: null, busy: false, ...o };
}

function makeDraft(state: DraftState | null, o: Partial<VizDraftAPI> = {}): VizDraftAPI {
  return {
    draft: state, isDrafting: state !== null, createdCount: 0,
    start: vi.fn(), editCell: vi.fn(), setField: vi.fn(), setTitle: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined), commitWithTitle: vi.fn().mockResolvedValue(undefined),
    commitWithField: vi.fn().mockResolvedValue(undefined),
    confirmCreate: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), exitEdit: vi.fn(),
    ...o,
  };
}

const setup = (state: DraftState | null, base = makeBase(), draft = makeDraft(state)) => {
  const { result } = renderHook(() => useDraftEditAdapter(base, draft));
  return { api: result.current, base, draft };
};

describe("draftRowFor", () => {
  it("builds a synthetic row from draft state", () => {
    expect(draftRowFor(makeDraftState({ title: "T", fields: { status: "open" } }), "task"))
      .toEqual({ id: DRAFT_ROW_ID, title: "T", file_path: "", types: ["task"], fields: { status: "open" } });
  });
  it("returns null when no draft is open", () => {
    expect(draftRowFor(null, "task")).toBeNull();
  });
});

describe("useDraftEditAdapter — real rows pass through untouched", () => {
  it("delegates every call for a non-draft id", async () => {
    const { api, base } = setup(makeDraftState());
    api.beginEdit("n1", "status");
    await api.submitEdit(REAL_ROW, "status", "done", { via: "enter" });
    await api.reloadRow(REAL_ROW);
    expect(base.beginEdit).toHaveBeenCalledWith("n1", "status");
    // the Enter-intent meta is forwarded verbatim; a real row commits either way
    expect(base.submitEdit).toHaveBeenCalledWith(REAL_ROW, "status", "done", { via: "enter" });
    expect(base.reloadRow).toHaveBeenCalledWith(REAL_ROW);
    expect(api.cellValue(REAL_ROW, "status")).toBe("base-value");
    expect(api.cellTitle(REAL_ROW)).toBe("base-title");
    expect(api.isStale("n1")).toBe(true);
    expect(api.isFlashing("n1", "status")).toBe(true);
  });
});

describe("useDraftEditAdapter — draft row", () => {
  const draftRow = { id: DRAFT_ROW_ID, title: "", file_path: "", types: ["task"], fields: {} } as VizRow;

  it("projects draft.editing as a CellRef on the draft id", () => {
    const { api } = setup(makeDraftState({ editing: "status" }));
    expect(api.editing).toEqual({ id: DRAFT_ROW_ID, field: "status" });
  });

  it("projects draft.pending as a PendingEdit on the title cell", () => {
    const { api } = setup(makeDraftState({ editing: null, title: "T", pending: { reasons: ["Interpreted x."] } }));
    expect(api.pending).toMatchObject({ id: DRAFT_ROW_ID, field: TITLE_FIELD, reasons: ["Interpreted x."] });
  });

  it("projects draft.error as a CellError on its field", () => {
    const { api } = setup(makeDraftState({ error: { field: "context", code: "REQUIRED_MISSING", message: "missing" } }));
    expect(api.cellError).toEqual({ id: DRAFT_ROW_ID, field: "context", code: "REQUIRED_MISSING", message: "missing" });
  });

  it("reads staged values from draft state", () => {
    const { api } = setup(makeDraftState({ title: "T", fields: { status: "open" } }));
    expect(api.cellValue(draftRow, "status")).toBe("open");
    expect(api.cellTitle(draftRow)).toBe("T");
  });

  it("beginEdit opens the draft cell", () => {
    const { api, draft } = setup(makeDraftState());
    api.beginEdit(DRAFT_ROW_ID, "due");
    expect(draft.editCell).toHaveBeenCalledWith("due");
  });

  it("submitting a non-title cell with no title yet stages it and moves to the title", async () => {
    // Nothing can be created without a title, so Enter here must not be a silent
    // no-op: stage the value and put the caret where the row is actually blocked.
    const { api, draft, base } = setup(makeDraftState({ editing: "status" }));
    await api.submitEdit(draftRow, "status", "open", { via: "enter" });
    expect(draft.setField).toHaveBeenCalledWith("status", "open");
    expect(draft.editCell).toHaveBeenCalledWith(TITLE_FIELD);
    expect(draft.commitWithTitle).not.toHaveBeenCalled();
    expect(draft.commitWithField).not.toHaveBeenCalled();
    expect(base.submitEdit).not.toHaveBeenCalled();
  });

  it("Enter in a field cell creates the row once the title is there", async () => {
    // The canonical grid gesture: title → Tab → field → Enter. Tab stages (see
    // stageEdit); Enter is the create trigger wherever it is pressed in the row.
    const { api, draft, base } = setup(makeDraftState({ title: "My Task", editing: "status" }));
    await api.submitEdit(draftRow, "status", "open", { via: "enter" });
    expect(draft.commitWithField).toHaveBeenCalledWith("status", "open");
    expect(base.submitEdit).not.toHaveBeenCalled();
  });

  it("Tab still only stages, even with a title present", async () => {
    const { api, draft } = setup(makeDraftState({ title: "My Task", editing: "status" }));
    api.stageEdit!(draftRow, "status", "open");
    expect(draft.setField).toHaveBeenCalledWith("status", "open");
    expect(draft.commitWithField).not.toHaveBeenCalled();
    expect(draft.commitWithTitle).not.toHaveBeenCalled();
  });

  it("submitting the title creates the row", async () => {
    const { api, draft } = setup(makeDraftState({ editing: TITLE_FIELD }));
    await api.submitEdit(draftRow, TITLE_FIELD, "My Task");
    expect(draft.commitWithTitle).toHaveBeenCalledWith("My Task");
  });

  it("STAGING the title never creates — Tab moves on, Enter is the only create trigger", async () => {
    // Design Part B: "Tab within the draft row → move to the next cell, staging
    // only. Tab never creates." TextCellEditor calls onStage (→ stageEdit) for Tab
    // when the cell can stage; submitEdit is what commits.
    const { api, draft, base } = setup(makeDraftState({ editing: TITLE_FIELD }));
    api.stageEdit!(draftRow, TITLE_FIELD, "Buy milk");
    expect(draft.setTitle).toHaveBeenCalledWith("Buy milk", { advance: false });
    expect(draft.commitWithTitle).not.toHaveBeenCalled();
    expect(draft.commit).not.toHaveBeenCalled();
    expect(draft.cancel).not.toHaveBeenCalled();
    expect(base.submitEdit).not.toHaveBeenCalled();
  });

  it("staging a non-title cell is the same local setField a submit does", () => {
    const { api, draft } = setup(makeDraftState({ editing: "status" }));
    api.stageEdit!(draftRow, "status", "open");
    expect(draft.setField).toHaveBeenCalledWith("status", "open");
  });

  it("submitting a blank title discards the row", async () => {
    const { api, draft } = setup(makeDraftState({ editing: TITLE_FIELD }));
    await api.submitEdit(draftRow, TITLE_FIELD, "   ");
    expect(draft.cancel).toHaveBeenCalled();
    expect(draft.commitWithTitle).not.toHaveBeenCalled();
  });

  it("cancelling the title editor discards the row; cancelling a field editor keeps it", () => {
    const a = setup(makeDraftState({ editing: TITLE_FIELD }));
    a.api.cancelEdit();
    expect(a.draft.cancel).toHaveBeenCalled();

    const b = setup(makeDraftState({ editing: "status" }));
    b.api.cancelEdit();
    expect(b.draft.exitEdit).toHaveBeenCalled();
    expect(b.draft.cancel).not.toHaveBeenCalled();
  });

  it("confirmPending confirms the create", async () => {
    const { api, draft, base } = setup(makeDraftState({ editing: null, pending: { reasons: ["r"] } }));
    await api.confirmPending();
    expect(draft.confirmCreate).toHaveBeenCalled();
    expect(base.confirmPending).not.toHaveBeenCalled();
  });

  it("a row that does not exist yet is never stale or flashing", () => {
    const { api } = setup(makeDraftState());
    expect(api.isStale(DRAFT_ROW_ID)).toBe(false);
    expect(api.isFlashing(DRAFT_ROW_ID, "status")).toBe(false);
  });
});
