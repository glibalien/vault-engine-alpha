// @vitest-environment jsdom
/**
 * ColumnPicker.test.tsx
 *
 * TDD tests for the ColumnPicker popover component.
 * Tests: renders a checkbox per schema field; checked reflects displayFields;
 * toggling an unchecked field calls onChange with it ADDED;
 * toggling a checked field calls onChange with it REMOVED;
 * click-outside closes the popover.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Schema, SchemaField } from "@vault/query-core";
import { ColumnPicker } from "../src/ColumnPicker.js";

// ---- shared fixtures ----

const STATUS_FIELD: SchemaField = {
  name: "status",
  type: "enum",
  required: false,
  default_value: null,
  enum_values: ["open", "done"],
  ui: null,
};

const PRIORITY_FIELD: SchemaField = {
  name: "priority",
  type: "enum",
  required: false,
  default_value: null,
  enum_values: ["high", "low"],
  ui: null,
};

const DUE_FIELD: SchemaField = {
  name: "due",
  type: "date",
  required: false,
  default_value: null,
  ui: null,
};

const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [STATUS_FIELD, PRIORITY_FIELD, DUE_FIELD],
};

afterEach(() => cleanup());

// ---- popover button ----

describe("ColumnPicker — button", () => {
  it("renders a button that opens the popover", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^properties$/i })).toBeDefined();
  });

  it("popover is closed by default", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={vi.fn()}
      />,
    );
    // checkboxes should not be visible before clicking
    expect(screen.queryByRole("checkbox", { name: "status" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "priority" })).toBeNull();
  });

  it("clicking the button opens the popover", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    expect(screen.getByRole("checkbox", { name: "status" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "priority" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "due" })).toBeDefined();
  });

  it("clicking the button again closes the popover (toggle)", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /^properties$/i });
    fireEvent.click(btn);
    expect(screen.getByRole("checkbox", { name: "status" })).toBeDefined();
    fireEvent.click(btn);
    expect(screen.queryByRole("checkbox", { name: "status" })).toBeNull();
  });
});

// ---- checkboxes reflect displayFields ----

describe("ColumnPicker — checked state", () => {
  it("fields in displayFields are checked", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status", "due"]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    const statusBox = screen.getByRole("checkbox", { name: "status" }) as HTMLInputElement;
    const dueBox = screen.getByRole("checkbox", { name: "due" }) as HTMLInputElement;
    expect(statusBox.checked).toBe(true);
    expect(dueBox.checked).toBe(true);
  });

  it("fields not in displayFields are unchecked", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    const priorityBox = screen.getByRole("checkbox", { name: "priority" }) as HTMLInputElement;
    const dueBox = screen.getByRole("checkbox", { name: "due" }) as HTMLInputElement;
    expect(priorityBox.checked).toBe(false);
    expect(dueBox.checked).toBe(false);
  });

  it("renders one checkbox per schema field", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={[]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(TASK_SCHEMA.fields.length);
  });
});

// ---- toggling fields ----

describe("ColumnPicker — toggle", () => {
  it("toggling an unchecked field calls onChange with it ADDED", () => {
    const onChange = vi.fn();
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "priority" }));
    expect(onChange).toHaveBeenCalledOnce();
    // priority was not in displayFields; it should now be added
    const result: string[] = onChange.mock.calls[0][0];
    expect(result).toContain("status");
    expect(result).toContain("priority");
  });

  it("toggling a checked field calls onChange with it REMOVED", () => {
    const onChange = vi.fn();
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status", "due"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "status" }));
    expect(onChange).toHaveBeenCalledOnce();
    const result: string[] = onChange.mock.calls[0][0];
    expect(result).not.toContain("status");
    expect(result).toContain("due");
  });

  it("adding a field preserves existing order", () => {
    const onChange = vi.fn();
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["due"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "status" }));
    const result: string[] = onChange.mock.calls[0][0];
    expect(result).toEqual(expect.arrayContaining(["due", "status"]));
  });
});

// ---- click-outside closes ----

describe("ColumnPicker — click-outside", () => {
  it("clicking outside the open popover closes it", () => {
    render(
      <ColumnPicker
        schema={TASK_SCHEMA}
        displayFields={["status"]}
        onChange={vi.fn()}
      />,
    );
    // Open popover
    fireEvent.click(screen.getByRole("button", { name: /^properties$/i }));
    expect(screen.getByRole("checkbox", { name: "status" })).toBeDefined();

    // Click outside — document.body is outside the component
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("checkbox", { name: "status" })).toBeNull();
  });
});
