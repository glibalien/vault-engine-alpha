// @vitest-environment jsdom
/**
 * bulk-bar.test.tsx
 *
 * TDD tests for the BulkBar presentational React component.
 * Written BEFORE implementation — must be RED initially.
 *
 * Covers all VizBulkAPI states:
 *  - "N selected" count + Clear button
 *  - Set field… → field menu → pick → value editor via cellEditorFor
 *  - Apply → bulk.runDry
 *  - pending (incl skippedNoVersion) → Confirm calls bulk.confirm
 *  - failed → banner + Dismiss calls bulk.cancel
 *  - outcome → transient banner
 *  - add-type path
 *  - remove-type path
 *  - busy → Working… state
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { BulkBar } from "../src/BulkBar.js";
import type { VizBulkAPI } from "../src/use-viz-bulk.js";
import type { Schema, Issue } from "@vault/query-core";

afterEach(() => cleanup());

// ── helpers ──────────────────────────────────────────────────────────────────

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
    {
      name: "due",
      type: "date",
      required: false,
      default_value: null,
      ui: { widget: "date" },
    },
    {
      name: "summary",
      type: "string",
      required: false,
      default_value: null,
      ui: { widget: "text" },
    },
  ],
};

/** Build a stub VizBulkAPI with sane defaults; override any prop as needed. */
function makeAPI(overrides: Partial<VizBulkAPI> = {}): VizBulkAPI {
  return {
    selected: new Set(["id1", "id2"]),
    selectedCount: 2,
    isSelected: vi.fn().mockReturnValue(false),
    allSelected: vi.fn().mockReturnValue(false),
    toggleRow: vi.fn(),
    toggleAll: vi.fn(),
    clear: vi.fn(),

    plan: null,
    picking: null,
    pending: null,
    failed: null,
    busy: false,
    outcome: null,

    pick: vi.fn(),
    setPlanField: vi.fn(),
    setPlanValue: vi.fn(),
    setPlanType: vi.fn(),
    setLinkField: vi.fn(),
    setLinkTarget: vi.fn(),

    runDry: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),

    ...overrides,
  };
}

// ── Selection count + Clear ───────────────────────────────────────────────────

describe("BulkBar — selection count + Clear", () => {
  it('renders "N selected" for N > 0', () => {
    const api = makeAPI({ selectedCount: 3 });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/3 selected/)).toBeTruthy();
  });

  it('renders "1 selected" for 1', () => {
    const api = makeAPI({ selected: new Set(["id1"]), selectedCount: 1 });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/1 selected/)).toBeTruthy();
  });

  it("renders a Clear button", () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /clear/i })).toBeTruthy();
  });

  it("Clear button calls bulk.clear()", () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(api.clear).toHaveBeenCalledOnce();
  });
});

// ── Fields a one-value write would damage ────────────────────────────────────

describe("BulkBar — list-of-reference fields (#285)", () => {
  const LINK_SCHEMA: Schema = {
    name: "project",
    display_name: "Project",
    fields: [
      { name: "owner", type: "reference", required: false, default_value: null },
      { name: "company", type: "list", list_item_type: "reference", required: false, default_value: null },
      { name: "tags", type: "list", list_item_type: "string", required: false, default_value: null },
    ],
  };

  it("doesn't offer them, since setting one link would replace every selected row's list", () => {
    render(<BulkBar bulk={makeAPI({ picking: "field" })} schema={LINK_SCHEMA} />);
    const offered = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(offered.some((text) => text?.startsWith("company"))).toBe(false);
  });

  it("still offers single references and lists with a multi-value editor", () => {
    render(<BulkBar bulk={makeAPI({ picking: "field" })} schema={LINK_SCHEMA} />);
    const offered = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(offered.some((text) => text?.startsWith("owner"))).toBe(true);
    expect(offered.some((text) => text?.startsWith("tags"))).toBe(true);
  });
});

// ── Op buttons ────────────────────────────────────────────────────────────────

describe("BulkBar — op buttons", () => {
  it('renders "Set field…" button', () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /set field/i })).toBeTruthy();
  });

  it('"Set field…" calls bulk.pick("setField")', () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /set field/i }));
    expect(api.pick).toHaveBeenCalledWith("setField");
  });

  it('renders "Add type…" button', () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /add type/i })).toBeTruthy();
  });

  it('"Add type…" calls bulk.pick("addType")', () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /add type/i }));
    expect(api.pick).toHaveBeenCalledWith("addType");
  });

  it('renders "Remove type…" button', () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /remove type/i })).toBeTruthy();
  });

  it('"Remove type…" calls bulk.pick("removeType")', () => {
    const api = makeAPI();
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /remove type/i }));
    expect(api.pick).toHaveBeenCalledWith("removeType");
  });
});

// ── Field menu (picking === "field") ─────────────────────────────────────────

describe('BulkBar — picking === "field"', () => {
  it("shows a field menu listing schema fields", () => {
    const api = makeAPI({ picking: "field" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText("status")).toBeTruthy();
    expect(screen.getByText("due")).toBeTruthy();
    expect(screen.getByText("summary")).toBeTruthy();
  });

  it("clicking a field in the menu calls bulk.setPlanField(field.name)", () => {
    const api = makeAPI({ picking: "field" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByText("status"));
    expect(api.setPlanField).toHaveBeenCalledWith("status");
  });

  it("field menu shows widget type as meta", () => {
    const api = makeAPI({ picking: "field" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    // enum widget should be shown as metadata
    expect(screen.getByText("enum")).toBeTruthy();
  });
});

// ── Value editor (picking === "value") ───────────────────────────────────────

describe('BulkBar — picking === "value"', () => {
  it("shows a value editor when picking === 'value' with a setField plan", () => {
    const api = makeAPI({
      picking: "value",
      plan: { kind: "setField", field: "summary", value: null },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    // TextCellEditor renders a textbox for 'summary' (text widget)
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("submitting the value editor calls bulk.setPlanValue with the submitted value", () => {
    const api = makeAPI({
      picking: "value",
      plan: { kind: "setField", field: "summary", value: null },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-value" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.setPlanValue).toHaveBeenCalledWith("my-value");
  });

  it("canceling the value editor calls bulk.cancel", () => {
    const api = makeAPI({
      picking: "value",
      plan: { kind: "setField", field: "summary", value: null },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(api.cancel).toHaveBeenCalled();
  });
});

// ── Apply button → runDry ─────────────────────────────────────────────────────

describe("BulkBar — Apply button", () => {
  it("shows Apply button when a plan is set (not picking)", () => {
    const api = makeAPI({
      plan: { kind: "setField", field: "status", value: "done" },
      picking: null,
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /apply/i })).toBeTruthy();
  });

  it("Apply button calls bulk.runDry()", () => {
    const api = makeAPI({
      plan: { kind: "setField", field: "status", value: "done" },
      picking: null,
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    expect(api.runDry).toHaveBeenCalled();
  });

  it("shows plan summary when plan is set", () => {
    const api = makeAPI({
      plan: { kind: "setField", field: "status", value: "done" },
      picking: null,
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    // Should show something about the plan (e.g. "status → done")
    expect(screen.getByText(/status/)).toBeTruthy();
  });

  it("does NOT show Apply button when no plan is set", () => {
    const api = makeAPI({ plan: null, picking: null });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
  });
});

// ── Pending state ─────────────────────────────────────────────────────────────

describe("BulkBar — pending state", () => {
  it('shows "N row(s) would change"', () => {
    const api = makeAPI({
      pending: { wouldApply: 5, warnings: [] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/5 row\(s\) would change/)).toBeTruthy();
  });

  it("shows skippedNoVersion count when present", () => {
    const api = makeAPI({
      pending: { wouldApply: 3, warnings: [], skippedNoVersion: 2 },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/2 skipped/i)).toBeTruthy();
  });

  it("does NOT show skippedNoVersion when skippedNoVersion is 0 or absent", () => {
    const api = makeAPI({
      pending: { wouldApply: 3, warnings: [] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.queryByText(/skipped/i)).toBeNull();
  });

  it("shows warnings from pending", () => {
    const warning: Issue = { code: "SOME_WARN", message: "Something is off", severity: "warning" };
    const api = makeAPI({
      pending: { wouldApply: 2, warnings: [warning] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/Something is off/)).toBeTruthy();
  });

  it("shows a ✓ Confirm button", () => {
    const api = makeAPI({
      pending: { wouldApply: 3, warnings: [] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
  });

  it("Confirm button calls bulk.confirm()", () => {
    const api = makeAPI({
      pending: { wouldApply: 3, warnings: [] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(api.confirm).toHaveBeenCalled();
  });

  it("shows a Cancel button in pending state", () => {
    const api = makeAPI({
      pending: { wouldApply: 3, warnings: [] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  it("Cancel button calls bulk.cancel()", () => {
    const api = makeAPI({
      pending: { wouldApply: 3, warnings: [] },
      plan: { kind: "setField", field: "status", value: "done" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(api.cancel).toHaveBeenCalled();
  });
});

// ── Failed state ──────────────────────────────────────────────────────────────

describe("BulkBar — failed state", () => {
  it("shows a failure banner with the message", () => {
    const api = makeAPI({
      failed: { nodeId: null, message: "Batch failed catastrophically" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/Batch failed catastrophically/)).toBeTruthy();
  });

  it("shows a Dismiss button", () => {
    const api = makeAPI({
      failed: { nodeId: null, message: "Error" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("Dismiss button calls bulk.cancel()", () => {
    const api = makeAPI({
      failed: { nodeId: null, message: "Error" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(api.cancel).toHaveBeenCalled();
  });

  it("indicates nothing was changed in the failure banner", () => {
    const api = makeAPI({
      failed: { nodeId: null, message: "Something broke" },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    // Should communicate "nothing was changed" / "batch failed"
    expect(screen.getByText(/nothing was changed|batch failed/i)).toBeTruthy();
  });
});

// ── Outcome banner ────────────────────────────────────────────────────────────

describe("BulkBar — outcome banner", () => {
  it("shows N applied in outcome banner", () => {
    const api = makeAPI({ outcome: { applied: 4, stale: 0 } });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/4 applied/i)).toBeTruthy();
  });

  it("shows M skipped (changed elsewhere) when stale > 0", () => {
    const api = makeAPI({ outcome: { applied: 3, stale: 1 } });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/1 skipped/i)).toBeTruthy();
    expect(screen.getByText(/changed elsewhere/i)).toBeTruthy();
  });

  it("does not show stale text when stale === 0", () => {
    const api = makeAPI({ outcome: { applied: 4, stale: 0 } });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
  });
});

// ── Add-type path ─────────────────────────────────────────────────────────────

describe('BulkBar — picking === "addType"', () => {
  it("shows a type input when picking === 'addType'", () => {
    const api = makeAPI({ picking: "addType" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    // Should render an input or menu for entering a type
    const input = screen.getByRole("textbox");
    expect(input).toBeTruthy();
  });

  it("submitting a type calls bulk.setPlanType(type)", () => {
    const api = makeAPI({ picking: "addType" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "project" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.setPlanType).toHaveBeenCalledWith("project");
  });
});

// ── Remove-type path ──────────────────────────────────────────────────────────

describe('BulkBar — picking === "removeType"', () => {
  it("shows a type input when picking === 'removeType'", () => {
    const api = makeAPI({ picking: "removeType" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    const input = screen.getByRole("textbox");
    expect(input).toBeTruthy();
  });

  it("submitting a type calls bulk.setPlanType(type)", () => {
    const api = makeAPI({ picking: "removeType" });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "archive" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.setPlanType).toHaveBeenCalledWith("archive");
  });
});

// ── Busy state ────────────────────────────────────────────────────────────────

describe("BulkBar — busy state", () => {
  it('shows "Working…" or busy indicator when busy', () => {
    const api = makeAPI({ busy: true });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/working/i)).toBeTruthy();
  });

  it("disables action buttons when busy", () => {
    const api = makeAPI({
      busy: true,
      plan: { kind: "setField", field: "status", value: "done" },
      pending: { wouldApply: 2, warnings: [] },
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    // When busy, the bulk bar renders only the "Working…" indicator — no confirm button at all
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });
});

// ── addType plan label ────────────────────────────────────────────────────────

describe("BulkBar — plan label for type ops", () => {
  it("shows plan label for addType plan", () => {
    const api = makeAPI({
      plan: { kind: "addType", type: "project" },
      picking: null,
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/project/)).toBeTruthy();
  });

  it("shows plan label for removeType plan", () => {
    const api = makeAPI({
      plan: { kind: "removeType", type: "archive" },
      picking: null,
    });
    render(<BulkBar bulk={api} schema={TASK_SCHEMA} />);
    expect(screen.getByText(/archive/)).toBeTruthy();
  });
});
