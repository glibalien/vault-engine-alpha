// @vitest-environment jsdom
/**
 * The draft row must be a row: same cells, same order, same affordances.
 * Asserted by comparing the draft <tr> against a REAL <tr> from the same table —
 * a restatement of the expected columns would not catch renderer drift.
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
import type { VizExpandAPI } from "../src/use-viz-expand.js";
import type { VizRow } from "../src/viz-spec.js";

afterEach(() => cleanup());

const SCHEMA: Schema = {
  name: "task", display_name: "Task",
  fields: [
    { name: "status", type: "enum", required: true, default_value: "open", enum_values: ["open", "done"], ui: null },
    { name: "priority", type: "enum", required: false, default_value: "normal", enum_values: ["low", "normal"], ui: null },
    { name: "context", type: "list", required: true, default_value: null, enum_values: ["work", "personal"], list_item_type: "enum", ui: null },
    { name: "due", type: "date", required: false, default_value: null, ui: null },
  ],
};
// Deliberately NOT the schema's field order, and omitting `context`.
const COLUMNS = ["status", "due", "priority"];
const ROW: VizRow = { id: "n1", title: "Real row", file_path: "a.md", types: ["task"], fields: { status: "open" }, version: 1 };

function makeEdit(): VizCellEditAPI {
  return {
    cellValue: (row, f) => row.fields[f], cellTitle: (row) => row.title,
    editing: null, pending: null, cellError: null,
    isStale: () => false, isFlashing: () => false, isEditing: false, busy: false,
    beginEdit: vi.fn(), submitEdit: vi.fn().mockResolvedValue(undefined),
    confirmPending: vi.fn().mockResolvedValue(undefined), cancelEdit: vi.fn(),
    reloadRow: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDraft(open: boolean, o: Partial<VizDraftAPI> = {}): VizDraftAPI {
  return {
    draft: open ? { title: "", fields: {}, editing: TITLE_FIELD, error: null, pending: null, busy: false } : null,
    isDrafting: open, createdCount: 0,
    start: vi.fn(), editCell: vi.fn(), setField: vi.fn(), setTitle: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined), commitWithTitle: vi.fn().mockResolvedValue(undefined),
    commitWithField: vi.fn().mockResolvedValue(undefined),
    confirmCreate: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), exitEdit: vi.fn(),
    ...o,
  };
}

const renderTable = (draft: VizDraftAPI, extra: Record<string, unknown> = {}) =>
  render(
    <VizTable
      rows={[ROW]} displayFields={COLUMNS} groupField="status"
      editable schema={SCHEMA} edit={makeEdit()} draft={draft} lockedType="task"
      {...extra}
    />,
  );

/** Structural fingerprint of a row: one entry per <td>. */
const shape = (tr: Element) =>
  [...tr.querySelectorAll(":scope > td")].map((td) => ({
    cls: td.className, field: (td as HTMLElement).dataset.field ?? null,
  }));

/** Stub expand API with hasCaret:true — turns on the leading caret column. */
function makeExpandAPI(overrides: Partial<VizExpandAPI> = {}): VizExpandAPI {
  return {
    expanded: new Map(),
    pairs: [{ childType: "subtask", viaField: "parent" }],
    hasCaret: true,
    expandMenuFor: null,
    isOpen: vi.fn(() => false),
    caretClick: vi.fn(),
    toggle: vi.fn().mockResolvedValue(undefined),
    closeMenu: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    collapseAll: vi.fn(),
    ...overrides,
  };
}

describe("the draft row is a row", () => {
  it("has the same cell shape as a real row", () => {
    renderTable(makeDraft(true));
    const [realRow, draftRow] = [...document.querySelectorAll(".vtable tbody tr")];
    expect(shape(draftRow!)).toEqual(shape(realRow!));
  });

  it("has one cell per header column, in header order", () => {
    renderTable(makeDraft(true));
    const headers = [...document.querySelectorAll(".vtable thead th")].length;
    const draftRow = document.querySelector("tr.draft-row")!;
    expect(draftRow.querySelectorAll(":scope > td").length).toBe(headers);
  });

  it("carries no Create/Cancel buttons and no extras row", () => {
    renderTable(makeDraft(true));
    expect(document.querySelector(".draft-create-btn")).toBeNull();
    expect(document.querySelector(".draft-cancel-btn")).toBeNull();
    expect(document.querySelector(".draft-extra-row")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Create task/i);
  });

  it("renders empty cells as empty — no 'set X' or 'required' placeholders", () => {
    renderTable(makeDraft(true));
    const draftRow = document.querySelector("tr.draft-row")!;
    expect(draftRow.textContent).not.toMatch(/set (status|due|priority)/i);
    expect(draftRow.textContent).not.toMatch(/required/i);
  });

  it("opens a cell editor on click, like any other row", () => {
    const draft = makeDraft(true);
    renderTable(draft);
    const cell = document.querySelector('tr.draft-row td[data-field="due"] .cell-inner')!;
    fireEvent.click(cell);
    expect(draft.editCell).toHaveBeenCalledWith("due");
  });

  it("shows the collapsed + New row only when no draft is open", () => {
    renderTable(makeDraft(false));
    expect(document.querySelector(".draft-add-row")).not.toBeNull();
    cleanup();
    renderTable(makeDraft(true));
    expect(document.querySelector(".draft-add-row")).toBeNull();
  });

  it("does not offer bulk selection for a row that does not exist yet", () => {
    const bulk = {
      isSelected: vi.fn(() => false), toggleRow: vi.fn(), allSelected: vi.fn(() => false),
      toggleAll: vi.fn(), selectedCount: 0, outcome: null,
    } as unknown as Parameters<typeof VizTable>[0]["bulk"];
    renderTable(makeDraft(true), { bulk });
    const draftRow = document.querySelector("tr.draft-row")!;
    expect(draftRow.querySelector(".c-bulk-check input")).toBeNull();
    expect(draftRow.querySelector(".c-bulk-check")).not.toBeNull(); // the cell still holds the column
  });

  it("has the same cell shape as a real row with every optional column slot on (caret + row number + bulk + version)", () => {
    // Every leading/trailing alignment column at once: the caret column
    // (`{showCaret && isDraft && <td className="caret-col" />}`) is the one line in
    // this refactor whose sole job is alignment, and no other case here turns it on.
    const bulk = {
      isSelected: vi.fn(() => false), toggleRow: vi.fn(), allSelected: vi.fn(() => false),
      toggleAll: vi.fn(), selectedCount: 0, outcome: null,
    } as unknown as Parameters<typeof VizTable>[0]["bulk"];
    renderTable(makeDraft(true), {
      expand: makeExpandAPI(),
      bulk,
      showRowNumbers: true,
      showVersion: true,
    });
    const [realRow, draftRow] = [...document.querySelectorAll(".vtable tbody tr")];
    expect(shape(draftRow!)).toEqual(shape(realRow!));
    // Sanity: confirm the caret column actually rendered for both rows, so this
    // case can't silently pass by having showCaret evaluate to false.
    expect(document.querySelectorAll(".vtable thead th.caret-col")).toHaveLength(1);
    expect(realRow!.querySelector(":scope > td.caret-col")).not.toBeNull();
    expect(draftRow!.querySelector(":scope > td.caret-col")).not.toBeNull();
  });
});

describe("blocked strip — an error on a field with no column", () => {
  const blocked = (field: string) => makeDraft(true, {
    draft: { title: "T", fields: {}, editing: field, error: { field, code: "REQUIRED_MISSING", message: `Required field "${field}" is missing` }, pending: null, busy: false },
  });

  it("is absent until a create is rejected", () => {
    renderTable(makeDraft(true));
    expect(document.querySelector(".draft-blocked-row")).toBeNull();
  });

  it("stays absent while merely EDITING a non-column field with no rejection yet (keyed off error, not editing)", () => {
    // The happy-path autoadvance (setField -> nextDraftCell) lands `editing` on
    // the first unfilled required-without-default field — here that's `context`,
    // a non-column field — with NO error. A strip keyed off `editing` instead of
    // `error` would pop open here; that is exactly the always-on jank this task
    // exists to avoid, and it would fire on every keystroke sequence, not just
    // on rejection.
    renderTable(makeDraft(true, {
      draft: { title: "T", fields: {}, editing: "context", error: null, pending: null, busy: false },
    }));
    expect(document.querySelector(".draft-blocked-row")).toBeNull();
  });

  it("appears for a rejected non-column field, with its editor and message", () => {
    renderTable(blocked("context"));           // `context` is in SCHEMA but not in COLUMNS
    const strip = document.querySelector(".draft-blocked-row")!;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toMatch(/Required field "context" is missing/);
    expect(strip.querySelector('[data-field="context"] .cell-input, [data-field="context"] button')).not.toBeNull();
  });

  it("supplying the blocked field retries the create — the strip is not a dead end", () => {
    // The strip only exists because a create was REJECTED over this field. Staging
    // the value and stopping would clear the error, drop the strip, and leave a row
    // that looks committed with no node behind it — the silent no-op this whole
    // design removes. commitWithField stages and re-runs the create in one step
    // (the SET_FIELD dispatch has not flushed when the create snapshots fields).
    const draft = blocked("context");          // editing === error.field -> editor branch renders
    renderTable(draft);
    const input = document.querySelector('.draft-blocked-row [data-field="context"] .cell-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(draft.commitWithField).toHaveBeenCalledWith("context", "work");
    expect(draft.commit).not.toHaveBeenCalled();
    expect(draft.commitWithTitle).not.toHaveBeenCalled();
  });

  it("retries on a mouse pick too — in the strip, supplying the value IS the intent", () => {
    // Unlike a field cell in the row (where a pick must not create, or the streak
    // would yank the user out of the row they are filling), the strip has one
    // purpose: unblock the create the user already asked for.
    const draft = blocked("context");
    renderTable(draft);
    const input = document.querySelector('.draft-blocked-row [data-field="context"] .cell-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "work" } });
    fireEvent.blur(input);
    expect(draft.commitWithField).toHaveBeenCalledWith("context", "work");
  });

  it("wires the strip's editor Escape/cancel to exitEdit, never to discarding the whole draft", () => {
    const draft = blocked("context");
    renderTable(draft);
    const input = document.querySelector('.draft-blocked-row [data-field="context"] .cell-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(draft.exitEdit).toHaveBeenCalled();
    expect(draft.cancel).not.toHaveBeenCalled();
    expect(draft.setField).not.toHaveBeenCalled();
  });

  it("renders the 'set field' button when not currently editing it, wired to editCell", () => {
    const draft = makeDraft(true, {
      draft: {
        title: "T", fields: {}, editing: null,
        error: { field: "context", code: "REQUIRED_MISSING", message: `Required field "context" is missing` },
        pending: null, busy: false,
      },
    });
    renderTable(draft);
    const strip = document.querySelector(".draft-blocked-row")!;
    expect(strip).not.toBeNull();
    // Not editing this field -> the editor must NOT render, only the button.
    expect(strip.querySelector('[data-field="context"] .cell-input')).toBeNull();
    const btn = strip.querySelector('[data-field="context"] button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(draft.editCell).toHaveBeenCalledWith("context");
  });

  it("offers no 'set field' button when the rejected field has no schema entry", () => {
    // The engine can reject over a field the schema does not describe (an orphan /
    // renamed field). There is no widget to open for it, so the button would call
    // editCell and re-render this same branch — a control that visibly does nothing.
    // The message still names the field that blocked the create.
    const draft = makeDraft(true, {
      draft: {
        title: "T", fields: {}, editing: null,
        error: { field: "ghost", code: "VALUE_INVALID", message: `Unknown field "ghost"` },
        pending: null, busy: false,
      },
    });
    renderTable(draft);
    const strip = document.querySelector(".draft-blocked-row")!;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toMatch(/Unknown field "ghost"/);
    expect(strip.textContent).toMatch(/ghost/);            // still labelled
    expect(strip.querySelector("button")).toBeNull();      // but no dead control
  });

  it("does NOT appear when the rejected field has a column of its own", () => {
    renderTable(blocked("status"));            // `status` IS a column — the error renders in that cell
    expect(document.querySelector(".draft-blocked-row")).toBeNull();
    // Scoped to the draft row: the shared ROW fixture also has a "status"
    // column (value "open"), and an unscoped selector would match it first.
    expect(document.querySelector('tr.draft-row td[data-field="status"]')!.textContent).toMatch(/missing/i);
  });

  it("spans the table without changing its column count", () => {
    renderTable(blocked("context"));
    const cell = document.querySelector(".draft-blocked-row > td") as HTMLTableCellElement;
    const headers = [...document.querySelectorAll(".vtable thead th")].length;
    expect(cell.colSpan).toBe(headers);
    expect(cell.querySelector(".draft-blocked-inner")).not.toBeNull();  // flex lives on the div, never the td
  });
});
