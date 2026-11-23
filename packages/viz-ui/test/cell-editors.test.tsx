// @vitest-environment jsdom
/**
 * cell-editors.test.tsx
 *
 * TDD tests for the per-widget inline cell editors.
 * Written BEFORE implementation — must be RED initially.
 *
 * Covers:
 *  - TextCellEditor: renders from initial, Enter→submit, Escape→cancel, Tab→submit, blur→submit
 *  - EnumCellEditor: renders options, click option→submit, Clear row→submit null/"", ArrowDown/Enter, Escape→cancel
 *  - DateCellEditor: renders picker input, Enter→submit, Escape→cancel, toggle to NL mode
 *  - BoolCellEditor: segmented true/false/clear, click→submit
 *  - cellEditorFor: dispatches correct editor per widget
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";

import {
  TextCellEditor,
  EnumCellEditor,
  DateCellEditor,
  BoolCellEditor,
  cellEditorFor,
} from "../src/cell-editors/index.js";

import type { SchemaField } from "@vault/query-core";

afterEach(() => cleanup());

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTextField(overrides: Partial<SchemaField> = {}): SchemaField {
  return {
    name: "summary",
    type: "string",
    required: false,
    default_value: null,
    ui: { widget: "text" },
    ...overrides,
  };
}

function makeNumberField(overrides: Partial<SchemaField> = {}): SchemaField {
  return {
    name: "count",
    type: "number",
    required: false,
    default_value: null,
    ui: { widget: "number" },
    ...overrides,
  };
}

function makeTextareaField(overrides: Partial<SchemaField> = {}): SchemaField {
  return {
    name: "notes",
    type: "string",
    required: false,
    default_value: null,
    ui: { widget: "textarea" },
    ...overrides,
  };
}

function makeEnumField(values: string[] = ["open", "done", "blocked"]): SchemaField {
  return {
    name: "status",
    type: "enum",
    required: false,
    default_value: null,
    enum_values: values,
    ui: { widget: "enum" },
  };
}

function makeDateField(): SchemaField {
  return {
    name: "due",
    type: "date",
    required: false,
    default_value: null,
    ui: { widget: "date" },
  };
}

function makeBoolField(): SchemaField {
  return {
    name: "urgent",
    type: "boolean",
    required: false,
    default_value: null,
    ui: { widget: "bool" },
  };
}

// ── TextCellEditor ────────────────────────────────────────────────────────────

describe("TextCellEditor", () => {
  it("renders an input with the initial value", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("hello");
  });

  it("calls onSubmit with the current value on Enter", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("hello", { via: "enter" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel on Escape", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit on Tab", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="world"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onSubmit).toHaveBeenCalledWith("world");
  });

  it("calls onSubmit on blur", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="blur-val"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledWith("blur-val");
  });

  it("submits updated value after typing", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial="orig"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "updated" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("updated", { via: "enter" });
  });

  it("renders a textarea for textarea widget", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial="multi\nline"
        field={makeTextareaField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox").tagName.toLowerCase()).toBe("textarea");
  });

  it("textarea: Ctrl+Enter submits", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial="text"
        field={makeTextareaField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const ta = screen.getByRole("textbox");
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith("text", { via: "enter" });
  });

  it("textarea: plain Enter does NOT submit", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial="text"
        field={makeTextareaField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const ta = screen.getByRole("textbox");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders number input with number widget", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial={42}
        field={makeNumberField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    // Should still be a textbox role but have num class or inputmode attribute
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("42");
  });

  it("Escape then blur: onCancel called once, onSubmit NOT called", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter then blur: onSubmit called exactly once", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello", { via: "enter" });
  });

  // ── ✓/✗ commit affordance (Obsidian fix) ─────────────────────────────────

  it("renders a commit (✓) button", () => {
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /commit edit/i })).toBeTruthy();
  });

  it("renders a cancel (✗) button", () => {
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /cancel edit/i })).toBeTruthy();
  });

  it("mousedown on ✓ button calls onSubmit with current input value", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new value" } });
    const commitBtn = screen.getByRole("button", { name: /commit edit/i });
    fireEvent.mouseDown(commitBtn);
    expect(onSubmit).toHaveBeenCalledWith("new value");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("mousedown on ✗ button calls onCancel and NOT onSubmit", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const cancelBtn = screen.getByRole("button", { name: /cancel edit/i });
    fireEvent.mouseDown(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("mousedown on ✓ then blur: onSubmit called exactly once (no double-submit)", () => {
    const onSubmit = vi.fn();
    render(
      <TextCellEditor
        initial="hello"
        field={makeTextField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const commitBtn = screen.getByRole("button", { name: /commit edit/i });
    const input = screen.getByRole("textbox");
    fireEvent.mouseDown(commitBtn);
    // Simulate blur that follows after mouseDown on an external element
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Enter keydown also calls stopPropagation (does not bubble)", () => {
    const onSubmit = vi.fn();
    const outerHandler = vi.fn();
    const { container } = render(
      <div onKeyDown={outerHandler}>
        <TextCellEditor
          initial="hello"
          field={makeTextField()}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </div>,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    // Enter should be consumed — outer handler NOT called
    expect(outerHandler).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith("hello", { via: "enter" });
  });

  it("Escape keydown also calls stopPropagation (does not bubble)", () => {
    const onCancel = vi.fn();
    const outerHandler = vi.fn();
    const { container } = render(
      <div onKeyDown={outerHandler}>
        <TextCellEditor
          initial="hello"
          field={makeTextField()}
          onSubmit={vi.fn()}
          onCancel={onCancel}
        />
      </div>,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outerHandler).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("textarea renders commit and cancel buttons", () => {
    render(
      <TextCellEditor
        initial="text"
        field={makeTextareaField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /commit edit/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel edit/i })).toBeTruthy();
  });
});

// ── EnumCellEditor ────────────────────────────────────────────────────────────

describe("EnumCellEditor", () => {
  it("renders all enum values as options", () => {
    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
  });

  it("renders a Clear option", () => {
    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/clear/i)).toBeTruthy();
  });

  it("calls onSubmit with the clicked option", () => {
    const onSubmit = vi.fn();
    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByText("done"));
    expect(onSubmit).toHaveBeenCalledWith("done");
  });

  it("calls onSubmit with null or '' on Clear click", () => {
    const onSubmit = vi.fn();
    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByText(/clear/i));
    // Either null or "" is acceptable for clear
    expect(onSubmit).toHaveBeenCalled();
    const arg = onSubmit.mock.calls[0]?.[0];
    expect(arg === null || arg === "").toBe(true);
  });

  it("calls onCancel on Escape", () => {
    const onCancel = vi.fn();
    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField()}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    // The wrapper is keyboard-navigable; find the container and fire keydown
    const container = screen.getByRole("listbox");
    fireEvent.keyDown(container, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("ArrowDown then Enter submits next option", () => {
    const onSubmit = vi.fn();
    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField(["open", "done", "blocked"])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const container = screen.getByRole("listbox");
    // Initial active is "open" (index 0). ArrowDown → "done" (index 1). Enter → submit "done"
    fireEvent.keyDown(container, { key: "ArrowDown" });
    fireEvent.keyDown(container, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("done", { via: "enter" });
  });
});

// ── DateCellEditor ────────────────────────────────────────────────────────────

describe("DateCellEditor", () => {
  it("renders a date picker input initially", () => {
    render(
      <DateCellEditor
        initial="2026-06-15"
        field={makeDateField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Should have a date input
    const input = document.querySelector("input[type='date']") as HTMLInputElement | null;
    expect(input).toBeTruthy();
  });

  it("pre-fills the date input with the initial value", () => {
    render(
      <DateCellEditor
        initial="2026-06-15"
        field={makeDateField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    expect(input.value).toBe("2026-06-15");
  });

  it("calls onSubmit on Enter", () => {
    const onSubmit = vi.fn();
    render(
      <DateCellEditor
        initial="2026-06-15"
        field={makeDateField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("2026-06-15", { via: "enter" });
  });

  it("calls onCancel on Escape", () => {
    const onCancel = vi.fn();
    render(
      <DateCellEditor
        initial="2026-06-15"
        field={makeDateField()}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows a toggle to natural-language mode", () => {
    render(
      <DateCellEditor
        initial=""
        field={makeDateField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Button or text to switch to NL mode
    expect(screen.getByText(/natural language/i)).toBeTruthy();
  });

  it("toggles to NL text input on toggle click", () => {
    render(
      <DateCellEditor
        initial=""
        field={makeDateField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const toggle = screen.getByText(/natural language/i);
    // Using mouseDown like the engine's vanilla version
    fireEvent.mouseDown(toggle);
    // Should now have a text input with placeholder
    const textInput = document.querySelector("input[type='text']") as HTMLInputElement | null;
    expect(textInput).toBeTruthy();
    expect(textInput?.placeholder?.toLowerCase()).toContain("friday");
  });

  it("submits NL text value on Enter in NL mode", () => {
    const onSubmit = vi.fn();
    render(
      <DateCellEditor
        initial=""
        field={makeDateField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    // Switch to NL mode
    fireEvent.mouseDown(screen.getByText(/natural language/i));
    const textInput = document.querySelector("input[type='text']") as HTMLInputElement;
    fireEvent.change(textInput, { target: { value: "next friday" } });
    fireEvent.keyDown(textInput, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("next friday", { via: "enter" });
  });

  it("picker mode: Escape then blur → onCancel once, onSubmit not called", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <DateCellEditor
        initial="2026-06-15"
        field={makeDateField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("picker mode: Enter then blur → onSubmit called exactly once", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <DateCellEditor
        initial="2026-06-15"
        field={makeDateField()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("2026-06-15", { via: "enter" });
  });
});

// ── BoolCellEditor ────────────────────────────────────────────────────────────

describe("BoolCellEditor", () => {
  it("renders true, false, and clear options", () => {
    render(
      <BoolCellEditor
        initial={true}
        field={makeBoolField()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/true/i)).toBeTruthy();
    expect(screen.getByText(/false/i)).toBeTruthy();
    // Clear option (might be "–", "any", or "clear")
    const clearBtn = screen.queryByText(/clear|any|–/i);
    expect(clearBtn).toBeTruthy();
  });

  it("calls onSubmit(true) when true button is clicked", () => {
    const onSubmit = vi.fn();
    render(
      <BoolCellEditor
        initial={false}
        field={makeBoolField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/^true$/i));
    expect(onSubmit).toHaveBeenCalledWith(true);
  });

  it("calls onSubmit(false) when false button is clicked", () => {
    const onSubmit = vi.fn();
    render(
      <BoolCellEditor
        initial={true}
        field={makeBoolField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/^false$/i));
    expect(onSubmit).toHaveBeenCalledWith(false);
  });

  it("calls onSubmit(null) when clear/any is clicked", () => {
    const onSubmit = vi.fn();
    render(
      <BoolCellEditor
        initial={true}
        field={makeBoolField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const clearBtn = screen.getByText(/clear|any|–/i);
    fireEvent.click(clearBtn);
    expect(onSubmit).toHaveBeenCalled();
    const arg = onSubmit.mock.calls[0]?.[0];
    expect(arg === null || arg === "" || arg === undefined).toBe(true);
  });
});

// ── cellEditorFor dispatch ────────────────────────────────────────────────────

describe("cellEditorFor", () => {
  it("returns TextCellEditor for text widget", () => {
    expect(cellEditorFor("text")).toBe(TextCellEditor);
  });

  it("returns TextCellEditor for number widget", () => {
    expect(cellEditorFor("number")).toBe(TextCellEditor);
  });

  it("returns TextCellEditor for textarea widget", () => {
    expect(cellEditorFor("textarea")).toBe(TextCellEditor);
  });

  it("returns EnumCellEditor for enum widget", () => {
    expect(cellEditorFor("enum")).toBe(EnumCellEditor);
  });

  it("returns DateCellEditor for date widget", () => {
    expect(cellEditorFor("date")).toBe(DateCellEditor);
  });

  it("returns BoolCellEditor for bool widget", () => {
    expect(cellEditorFor("bool")).toBe(BoolCellEditor);
  });

  it("returns TextCellEditor for unknown widget (tags fallback)", () => {
    expect(cellEditorFor("tags")).toBe(TextCellEditor);
  });
});
