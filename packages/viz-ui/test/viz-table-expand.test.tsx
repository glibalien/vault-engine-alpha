// @vitest-environment jsdom
/**
 * viz-table-expand.test.tsx
 *
 * TDD tests for VizTable caret column + depth-1 sub-table recursion.
 * Written BEFORE implementation — must be RED initially.
 *
 * Covers:
 *  - variant='main' + hasCaret ⇒ .caret-col header + .row-caret per row
 *  - hasCaret:false ⇒ NO caret column
 *  - caret click → caretClick(id)
 *  - expandMenuFor===id + 2 pairs ⇒ .expand-menu with 2 options; option click → toggle(id, pair)
 *  - isOpen(id) + group with 2 child rows + allSchemas has child schema ⇒ .sub-table-row with nested table
 *  - group.busy ⇒ .sub-loading "Loading…"; child schema missing ⇒ "No schema for …"
 *  - group.total > rows.length ⇒ .sub-more "showing 2 of 7"
 *  - nested (variant='sub') table: NO .vfilter, NO .caret-col, NO [data-cell-key]
 *  - child field cell click → edit.beginEdit(childId, field) (child editable via shared hook)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

import { VizTable } from "../src/VizTable.js";
import type { VizRow } from "../src/viz-spec.js";
import type { VizExpandAPI } from "../src/use-viz-expand.js";
import type { VizCellEditAPI } from "../src/use-viz-cell-edit.js";
import type { Schema, ExpandPair, ExpandedGroup, NodeRow } from "@vault/query-core";

afterEach(() => cleanup());

// ── Schema fixtures ────────────────────────────────────────────────────────────

const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    {
      name: "status",
      type: "enum",
      required: false,
      default_value: null,
      enum_values: ["open", "done"],
      ui: { widget: "enum" },
    },
  ],
};

const SUBTASK_SCHEMA: Schema = {
  name: "subtask",
  display_name: "Subtask",
  fields: [
    {
      name: "priority",
      type: "enum",
      required: false,
      default_value: null,
      enum_values: ["low", "high"],
      ui: { widget: "enum" },
    },
  ],
};

// ── Row fixtures ───────────────────────────────────────────────────────────────

const PARENT_ROW: VizRow = {
  id: "parent-1",
  title: "Parent Task",
  file_path: "tasks/parent-1.md",
  types: ["task"],
  fields: { status: "open" },
  version: 1,
};

const CHILD_ROW_1: NodeRow = {
  id: "child-1",
  title: "Child One",
  file_path: "subtasks/child-1.md",
  types: ["subtask"],
  fields: { priority: "low" },
  version: 1,
};

const CHILD_ROW_2: NodeRow = {
  id: "child-2",
  title: "Child Two",
  file_path: "subtasks/child-2.md",
  types: ["subtask"],
  fields: { priority: "high" },
  version: 1,
};

// ── Stub builder ──────────────────────────────────────────────────────────────

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

/** Stub edit API with vi.fn() methods. */
function makeEditAPI(): VizCellEditAPI {
  return {
    editing: null,
    pending: null,
    cellError: null,
    beginEdit: vi.fn(),
    submitEdit: vi.fn().mockResolvedValue(undefined),
    cancelEdit: vi.fn(),
    confirmPending: vi.fn().mockResolvedValue(undefined),
    reloadRow: vi.fn().mockResolvedValue(undefined),
    cellValue: vi.fn((row, _field) => (row.fields as Record<string, unknown>)[_field]),
    cellTitle: vi.fn((row) => row.title),
    isFlashing: vi.fn(() => false),
    isStale: vi.fn(() => false),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VizTable caret column — hasCaret: true", () => {
  it("renders a .caret-col header when variant='main' and expand.hasCaret", () => {
    const expand = makeExpandAPI();
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const caretTh = document.querySelector("th.caret-col");
    expect(caretTh).toBeTruthy();
  });

  it("renders a .row-caret button per row when variant='main' and expand.hasCaret", () => {
    const expand = makeExpandAPI();
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const caretBtns = document.querySelectorAll("button.row-caret");
    expect(caretBtns.length).toBe(1);
  });

  it("caret button is leftmost column (before title)", () => {
    const expand = makeExpandAPI();
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    // First th in thead should be caret-col
    const firstTh = document.querySelector("thead tr th");
    expect(firstTh?.className).toContain("caret-col");
  });
});

describe("VizTable caret column — hasCaret: false", () => {
  it("renders NO .caret-col when hasCaret is false", () => {
    const expand = makeExpandAPI({ hasCaret: false, pairs: [] });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const caretTh = document.querySelector("th.caret-col");
    expect(caretTh).toBeNull();
  });

  it("renders NO .caret-col when expand is not passed", () => {
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        schema={TASK_SCHEMA}
      />,
    );
    expect(document.querySelector("th.caret-col")).toBeNull();
    expect(document.querySelector(".row-caret")).toBeNull();
  });
});

describe("VizTable caret click", () => {
  it("calls expand.caretClick(id) when caret button is clicked", () => {
    const expand = makeExpandAPI();
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const btn = document.querySelector("button.row-caret") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(expand.caretClick).toHaveBeenCalledWith("parent-1");
  });

  it("caret button has aria-label='expand' when closed", () => {
    const expand = makeExpandAPI({ isOpen: vi.fn(() => false) });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const btn = document.querySelector("button.row-caret") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("expand");
  });

  it("caret button has .open class and aria-label='collapse' when isOpen returns true", () => {
    const expand = makeExpandAPI({
      isOpen: vi.fn(() => true),
      expanded: new Map([["parent-1", {
        childType: "subtask",
        viaField: "parent",
        rows: [],
        total: 0,
        busy: true,
        unresolvedWarning: false,
      } as ExpandedGroup]]),
    });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const btn = document.querySelector("button.row-caret") as HTMLButtonElement;
    expect(btn.className).toContain("open");
    expect(btn.getAttribute("aria-label")).toBe("collapse");
  });
});

describe("VizTable expand menu", () => {
  const TWO_PAIRS: ExpandPair[] = [
    { childType: "subtask", viaField: "parent" },
    { childType: "note", viaField: "ref" },
  ];

  it("renders .expand-menu with 2 options when expandMenuFor===id and pairs.length>1", () => {
    const expand = makeExpandAPI({
      pairs: TWO_PAIRS,
      expandMenuFor: "parent-1",
    });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const menu = document.querySelector(".expand-menu");
    expect(menu).toBeTruthy();
    const opts = menu!.querySelectorAll(".opt");
    expect(opts.length).toBe(2);
    expect(opts[0]!.textContent).toContain("subtask");
    expect(opts[1]!.textContent).toContain("note");
  });

  it("option click calls expand.toggle(id, pair)", () => {
    const expand = makeExpandAPI({
      pairs: TWO_PAIRS,
      expandMenuFor: "parent-1",
    });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    const opts = document.querySelectorAll(".expand-menu .opt");
    fireEvent.click(opts[0]!);
    expect(expand.toggle).toHaveBeenCalledWith("parent-1", TWO_PAIRS[0]);
  });

  it("does NOT render .expand-menu when expandMenuFor does not match row id", () => {
    const expand = makeExpandAPI({
      pairs: TWO_PAIRS,
      expandMenuFor: "other-id",
    });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    expect(document.querySelector(".expand-menu")).toBeNull();
  });

  it("outside-click on document.body calls expand.closeMenu", () => {
    const expand = makeExpandAPI({
      pairs: TWO_PAIRS,
      expandMenuFor: "parent-1",
    });
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        schema={TASK_SCHEMA}
      />,
    );
    // Menu is open — dispatching pointerdown on document.body (outside the caret-col td)
    fireEvent.pointerDown(document.body);
    expect(expand.closeMenu).toHaveBeenCalledTimes(1);
  });
});

describe("VizTable sub-table row — 2 child rows", () => {
  function makeGroup(overrides: Partial<ExpandedGroup> = {}): ExpandedGroup {
    return {
      childType: "subtask",
      viaField: "parent",
      rows: [CHILD_ROW_1, CHILD_ROW_2],
      total: 2,
      busy: false,
      unresolvedWarning: false,
      ...overrides,
    };
  }

  it("renders a .sub-table-row when isOpen returns true and group has rows", () => {
    const group = makeGroup();
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    expect(document.querySelector(".sub-table-row")).toBeTruthy();
  });

  it("renders nested table with both child titles", () => {
    const group = makeGroup();
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    expect(screen.getByText("Child One")).toBeTruthy();
    expect(screen.getByText("Child Two")).toBeTruthy();
  });

  it("renders .sub-loading 'Loading…' when group.busy is true", () => {
    const group = makeGroup({ busy: true });
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    const loading = document.querySelector(".sub-loading");
    expect(loading).toBeTruthy();
    expect(loading!.textContent).toBe("Loading…");
  });

  it("renders 'No schema for …' when child schema is missing", () => {
    const group = makeGroup({ busy: false });
    const expanded = new Map([["parent-1", group]]);
    // allSchemas is empty — no schema for "subtask"
    const allSchemas = new Map<string, Schema>();
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    const loading = document.querySelector(".sub-loading");
    expect(loading).toBeTruthy();
    expect(loading!.textContent).toContain("No schema for subtask");
  });

  it("renders .sub-more 'showing 2 of 7' when total > rows.length", () => {
    const group = makeGroup({ total: 7 });
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    const more = document.querySelector(".sub-more");
    expect(more).toBeTruthy();
    expect(more!.textContent).toBe("showing 2 of 7");
  });

  it("renders .sub-empty 'No linked rows.' when group.rows is empty and not busy", () => {
    const group = makeGroup({ rows: [], total: 0 });
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    expect(document.querySelector(".sub-empty")?.textContent).toBe("No linked rows.");
  });

  it("renders .sub-hint when group.unresolvedWarning is true", () => {
    const group = makeGroup({ unresolvedWarning: true });
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
      />,
    );
    expect(document.querySelector(".sub-hint")).toBeTruthy();
  });
});

describe("VizTable nested (variant='sub') table invariants", () => {
  function renderWithOpenGroup(edit?: VizCellEditAPI) {
    const group: ExpandedGroup = {
      childType: "subtask",
      viaField: "parent",
      rows: [CHILD_ROW_1, CHILD_ROW_2],
      total: 2,
      busy: false,
      unresolvedWarning: false,
    };
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    return render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
        editable={!!edit}
        edit={edit}
      />,
    );
  }

  it("nested sub table renders NO .vfilter (search + chips hidden)", () => {
    renderWithOpenGroup();
    // There should be exactly 1 .vfilter (the outer parent table's filter bar)
    // The nested sub table should NOT add a second .vfilter
    const vfilters = document.querySelectorAll(".vfilter");
    // Outer has one; sub should have none
    expect(vfilters.length).toBe(1);
  });

  it("nested sub table renders NO .caret-col (no double-nesting)", () => {
    renderWithOpenGroup();
    // sub-table-row contains the inner table; check no caret-col inside sub-table-row
    const subRow = document.querySelector(".sub-table-row");
    expect(subRow).toBeTruthy();
    const innerCaretCol = subRow!.querySelector(".caret-col");
    expect(innerCaretCol).toBeNull();
  });

  it("nested sub table cells carry NO [data-cell-key] attribute", () => {
    const edit = makeEditAPI();
    renderWithOpenGroup(edit);
    // Find the sub-table-row and check no data-cell-key inside it
    const subRow = document.querySelector(".sub-table-row");
    expect(subRow).toBeTruthy();
    const cellKeyCells = subRow!.querySelectorAll("[data-cell-key]");
    expect(cellKeyCells.length).toBe(0);
  });
});

describe("VizTable child cell editing (click-only, no nav)", () => {
  it("child field cell click calls edit.beginEdit(childId, field)", () => {
    const edit = makeEditAPI();
    const group: ExpandedGroup = {
      childType: "subtask",
      viaField: "parent",
      rows: [CHILD_ROW_1],
      total: 1,
      busy: false,
      unresolvedWarning: false,
    };
    const expanded = new Map([["parent-1", group]]);
    const allSchemas = new Map([["subtask", SUBTASK_SCHEMA]]);
    const expand = makeExpandAPI({ isOpen: vi.fn(() => true), expanded });

    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        expand={expand}
        allSchemas={allSchemas}
        schema={TASK_SCHEMA}
        editable
        edit={edit}
      />,
    );

    // The child row's title cell should be clickable; find it in the sub-table-row
    const subRow = document.querySelector(".sub-table-row");
    expect(subRow).toBeTruthy();
    // Click on the child title "Child One"
    const childTitle = screen.getByText("Child One");
    fireEvent.click(childTitle.closest(".cell-inner") ?? childTitle);
    expect(edit.beginEdit).toHaveBeenCalledWith("child-1", "__title__");
  });
});

describe("VizTable navEnabled safety rule", () => {
  it("parent main cells carry data-cell-key when editable", () => {
    const edit = makeEditAPI();
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        schema={TASK_SCHEMA}
        editable
        edit={edit}
      />,
    );
    const keyCells = document.querySelectorAll("[data-cell-key]");
    // 2 cols (title + status) × 1 row = 2
    expect(keyCells.length).toBe(2);
  });

  it("read-only table carries NO data-cell-key", () => {
    render(
      <VizTable
        rows={[PARENT_ROW]}
        displayFields={["status"]}
        groupField="status"
        schema={TASK_SCHEMA}
      />,
    );
    expect(document.querySelectorAll("[data-cell-key]").length).toBe(0);
  });
});
