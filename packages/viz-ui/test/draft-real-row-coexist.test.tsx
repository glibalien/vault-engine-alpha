// @vitest-environment jsdom
/**
 * The draft row and the real rows above it hold SEPARATE edit state.
 *
 * `VizCellEditAPI` has one `editing` / `pending` / `cellError` for the whole table,
 * so if the table is wrapped in the draft adapter, an open draft cell answers for
 * every row: `edit.editing` becomes unreachable and NO real row can open an editor
 * until the draft closes (and a draft error hides a real row's). VizTable therefore
 * picks the API per row — draft id → adapter, everything else → the raw edit API.
 *
 * These tests keep a real row and the draft live AT THE SAME TIME, which is what
 * the per-task suites never did.
 *
 * They also pin the other half of the rule: only ONE editor is ever open. Two would
 * both grab Enter, and a create landing while a real editor is open unmounts it
 * mid-keystroke (the pre-React flows/create.ts cleared cell-edit state on startDraft
 * for the same reason).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import type { Schema } from "@vault/query-core";
import { TITLE_FIELD } from "@vault/query-core";
import { VizTable } from "../src/VizTable.js";
import { DRAFT_ROW_ID } from "../src/use-draft-edit-adapter.js";
import type { VizDraftAPI } from "../src/use-viz-draft.js";
import type { VizCellEditAPI } from "../src/use-viz-cell-edit.js";
import type { VizRow } from "../src/viz-spec.js";

afterEach(() => cleanup());

const SCHEMA: Schema = {
  name: "task", display_name: "Task",
  fields: [
    { name: "note", type: "string", required: false, default_value: null, ui: null },
    { name: "status", type: "enum", required: true, default_value: "open", enum_values: ["open", "done"], ui: null },
  ],
};
const COLUMNS = ["note", "status"];
const ROW: VizRow = { id: "n1", title: "Real row", file_path: "a.md", types: ["task"], fields: { note: "hi" }, version: 1 };

function makeEdit(o: Partial<VizCellEditAPI> = {}): VizCellEditAPI {
  return {
    cellValue: (row, f) => row.fields[f], cellTitle: (row) => row.title,
    editing: null, pending: null, cellError: null,
    isStale: () => false, isFlashing: () => false, isEditing: false, busy: false,
    beginEdit: vi.fn(), submitEdit: vi.fn().mockResolvedValue(undefined),
    confirmPending: vi.fn().mockResolvedValue(undefined), cancelEdit: vi.fn(),
    reloadRow: vi.fn().mockResolvedValue(undefined),
    ...o,
  };
}

function makeDraft(o: Partial<VizDraftAPI> = {}): VizDraftAPI {
  return {
    draft: { title: "", fields: {}, editing: TITLE_FIELD, error: null, pending: null, busy: false },
    isDrafting: true, createdCount: 0,
    start: vi.fn(), editCell: vi.fn(), setField: vi.fn(), setTitle: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined), commitWithTitle: vi.fn().mockResolvedValue(undefined),
    confirmCreate: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), exitEdit: vi.fn(),
    ...o,
  };
}

const renderTable = (edit: VizCellEditAPI, draft: VizDraftAPI) =>
  render(
    <VizTable
      rows={[ROW]} displayFields={COLUMNS} groupField="status"
      editable schema={SCHEMA} edit={edit} draft={draft} lockedType="task"
    />,
  );

const realRowSel = (inner: string) => `.vtable tbody tr:not(.draft-row) ${inner}`;

describe("an open draft does not disable the rows above it", () => {
  it("a real row's editor renders while the draft holds an open cell", () => {
    // Draft open on `status`; the real row is editing `note`. Before the per-row
    // projection the adapter answered `{id:"__draft__", field:"status"}` for BOTH,
    // so the real row's editor never rendered.
    renderTable(
      makeEdit({ editing: { id: "n1", field: "note" } }),
      makeDraft({ draft: { title: "", fields: {}, editing: "status", error: null, pending: null, busy: false } }),
    );
    expect(document.querySelector(realRowSel('td[data-field="note"] .cell-input'))).not.toBeNull();
    // ...and the draft's own editor is still there: neither masks the other.
    expect(document.querySelector('tr.draft-row td[data-field="status"] [role="listbox"]')).not.toBeNull();
  });

  it("a real row's title editor renders while the draft's title editor is open", () => {
    renderTable(
      makeEdit({ editing: { id: "n1", field: TITLE_FIELD } }),
      makeDraft(),
    );
    expect(document.querySelector(realRowSel("td.c-title .cell-input"))).not.toBeNull();
    expect(document.querySelector("tr.draft-row td.c-title .cell-input")).not.toBeNull();
  });

  it("a real row's cellError renders while the draft carries an error of its own", () => {
    renderTable(
      makeEdit({
        editing: { id: "n1", field: "note" },
        cellError: { id: "n1", field: "note", code: "VALUE_INVALID", message: "real row rejected" },
      }),
      makeDraft({
        draft: {
          title: "T", fields: {}, editing: "status",
          error: { field: "status", code: "REQUIRED_MISSING", message: "draft rejected" },
          pending: null, busy: false,
        },
      }),
    );
    // The real row's own reason, in its own cell — not the draft's.
    const realNote = document.querySelector(realRowSel('td[data-field="note"]'))!;
    expect(realNote.textContent).toMatch(/real row rejected/);
    expect(realNote.textContent).not.toMatch(/draft rejected/);
    // The draft still shows its own.
    expect(document.querySelector('tr.draft-row td[data-field="status"]')!.textContent)
      .toMatch(/draft rejected/);
  });

  it("a real row's promote pill renders while the draft carries an error", () => {
    renderTable(
      makeEdit({
        pending: { id: "n1", field: "note", value: "x", version: 1, warnings: [], reasons: ["Interpreted x."] },
      }),
      makeDraft({
        draft: {
          title: "T", fields: {}, editing: "status",
          error: { field: "status", code: "REQUIRED_MISSING", message: "draft rejected" },
          pending: null, busy: false,
        },
      }),
    );
    expect(document.querySelector(realRowSel('td[data-field="note"]'))!.textContent)
      .toMatch(/Interpreted x\./);
  });

  it("the draft's promote pill stays on the draft row and does not leak onto a real row", () => {
    renderTable(
      makeEdit(),
      makeDraft({
        draft: { title: "T", fields: {}, editing: null, pending: { reasons: ["Draft coercion."] }, error: null, busy: false },
      }),
    );
    expect(document.querySelector("tr.draft-row td.c-title")!.textContent).toMatch(/Draft coercion\./);
    expect(document.querySelector(realRowSel("td.c-title"))!.textContent).not.toMatch(/Draft coercion\./);
  });
});

describe("only one editor is open at a time", () => {
  it("clicking a real row's cell exits the draft's editor (keeping the draft)", () => {
    const edit = makeEdit();
    const draft = makeDraft({ draft: { title: "staged", fields: {}, editing: "status", error: null, pending: null, busy: false } });
    renderTable(edit, draft);

    fireEvent.click(document.querySelector(realRowSel('td[data-field="note"] .cell-inner'))!);

    expect(draft.exitEdit).toHaveBeenCalled();      // draft editor closed…
    expect(draft.cancel).not.toHaveBeenCalled();    // …but the staged draft survives
    expect(edit.beginEdit).toHaveBeenCalledWith("n1", "note");
  });

  it("clicking a draft cell cancels whatever the real rows had open", () => {
    const edit = makeEdit({ editing: { id: "n1", field: "note" } });
    const draft = makeDraft({ draft: { title: "", fields: {}, editing: null, error: null, pending: null, busy: false } });
    renderTable(edit, draft);

    fireEvent.click(document.querySelector('tr.draft-row td[data-field="status"] .cell-inner')!);

    expect(edit.cancelEdit).toHaveBeenCalled();
    expect(draft.editCell).toHaveBeenCalledWith("status");
  });

  it("leaves a real row's pending promote alone — a pill is not an editor", () => {
    // The one-editor rule exists because two open editors both grab Enter. A
    // PromotePill has no autofocus and no Enter handler, so it never competes —
    // and it is one click from Confirm. Cancelling it would silently drop the
    // user's edit, which is exactly the class of surprise this branch removes.
    const edit = makeEdit({
      editing: null,
      pending: { id: "n1", field: "note", value: "x", version: 1, warnings: [], reasons: ["Interpreted x."] },
    });
    const draft = makeDraft({ draft: { title: "", fields: {}, editing: null, error: null, pending: null, busy: false } });
    renderTable(edit, draft);

    fireEvent.click(document.querySelector('tr.draft-row td[data-field="status"] .cell-inner')!);

    expect(edit.cancelEdit).not.toHaveBeenCalled();
    expect(draft.editCell).toHaveBeenCalledWith("status");
  });

  it("leaves a real row's pending promote alone when the streak reopens a draft", () => {
    const edit = makeEdit({
      editing: null,
      pending: { id: "n1", field: "note", value: "x", version: 1, warnings: [], reasons: ["Interpreted x."] },
    });
    const draft = makeDraft({ createdCount: 0, draft: { title: "", fields: {}, editing: null, error: null, pending: null, busy: false } });
    const { rerender } = renderTable(edit, draft);

    // a create lands → the streak opens the next row
    const next = { ...draft, createdCount: 1 };
    rerender(
      <VizTable
        rows={[ROW]} displayFields={COLUMNS} groupField="status"
        editable schema={SCHEMA} edit={edit} draft={next} lockedType="task"
      />,
    );

    expect(next.start).toHaveBeenCalled();
    expect(edit.cancelEdit).not.toHaveBeenCalled();
  });

  it("does not churn state when there is nothing to close", () => {
    const edit = makeEdit();                        // no real-row editor open
    const draft = makeDraft({ draft: { title: "", fields: {}, editing: null, error: null, pending: null, busy: false } });
    renderTable(edit, draft);

    fireEvent.click(document.querySelector('tr.draft-row td[data-field="status"] .cell-inner')!);
    expect(edit.cancelEdit).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector(realRowSel('td[data-field="note"] .cell-inner'))!);
    expect(draft.exitEdit).not.toHaveBeenCalled();
  });

  it("the streak's reopened draft closes a real-row editor first", () => {
    // A create can land after the user has already clicked into a real row (blur
    // committed the title, the click opened a real editor, then the create resolved).
    // The reopened draft autofocuses its title, so the real editor must go — or the
    // user's next keystrokes land in a row that is about to unmount.
    const edit = makeEdit({ editing: { id: "n1", field: "note" } });
    const draft = makeDraft({ draft: null, isDrafting: false, createdCount: 0 });
    const { rerender } = renderTable(edit, draft);

    const after = makeDraft({ ...draft, draft: null, isDrafting: false, createdCount: 1 });
    rerender(
      <VizTable
        rows={[ROW]} displayFields={COLUMNS} groupField="status"
        editable schema={SCHEMA} edit={edit} draft={after} lockedType="task"
      />,
    );

    expect(after.start).toHaveBeenCalled();         // streak reopened
    expect(edit.cancelEdit).toHaveBeenCalled();     // …after closing the real editor
  });
});

describe("Tab across the boundary", () => {
  it("Tab in a REAL row's cell still commits it (unchanged, long-standing)", () => {
    // The draft's Tab stages instead of committing; that distinction comes from the
    // draft API (stageEdit), not from TextCellEditor, so real rows keep committing.
    const edit = makeEdit({ editing: { id: "n1", field: "note" } });
    renderTable(edit, makeDraft());
    const input = document.querySelector(realRowSel('td[data-field="note"] .cell-input'))!;
    fireEvent.keyDown(input, { key: "Tab" });
    expect(edit.submitEdit).toHaveBeenCalledWith(ROW, "note", "hi", undefined);  // Tab carries no Enter intent
  });


  it("Tab out of the last real cell opens the draft's title and cancels the real edit", () => {
    const edit = makeEdit({ editing: { id: "n1", field: "status" } });
    const draft = makeDraft({ draft: { title: "", fields: {}, editing: null, error: null, pending: null, busy: false } });
    renderTable(edit, draft);

    // Real row is index 0, last column (status) is col 2 → wraps to row 1 col 0,
    // which is the draft row's title.
    const cell = document.querySelector('[data-cell-key="0:2"]')!;
    fireEvent.keyDown(cell, { key: "Tab" });

    expect(draft.editCell).toHaveBeenCalledWith(TITLE_FIELD);
    expect(edit.cancelEdit).toHaveBeenCalled();
    expect(edit.beginEdit).not.toHaveBeenCalledWith(DRAFT_ROW_ID, TITLE_FIELD);
  });
});
