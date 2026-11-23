// @vitest-environment jsdom
/**
 * FieldChips.test.tsx
 *
 * TDD tests for the FieldChips presentational component.
 * Tests: enum chip renders options and toggling calls onSetChip;
 * number chip min/max inputs call onSetChip; bool chip segmented control calls
 * onSetChip; "+ filter" lists addable fields and picking calls onAddChip;
 * caller fragment chip renders summarized label and remove calls onRemoveFragment;
 * chip remove × calls onRemoveChip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Schema, SchemaField, FilterChip, CallerFragment } from "@vault/query-core";
import { FieldChips } from "../src/FieldChips.js";
import { withClient } from "./_render-viz.js";

// Minimal mock client for link-chip renders (only queryNodes is used by LinkEditor)
const _linkMockClient = {
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

// ---- shared fixtures ----

const STATUS_FIELD: SchemaField = {
  name: "status",
  type: "enum",
  required: false,
  default_value: null,
  enum_values: ["open", "in-progress", "done"],
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

const SCORE_FIELD: SchemaField = {
  name: "score",
  type: "number",
  required: false,
  default_value: null,
  ui: null,
};

const ACTIVE_FIELD: SchemaField = {
  name: "active",
  type: "boolean",
  required: false,
  default_value: null,
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
  fields: [STATUS_FIELD, PRIORITY_FIELD, SCORE_FIELD, ACTIVE_FIELD, DUE_FIELD],
};

afterEach(() => cleanup());

// ---- enum chip ----

describe("FieldChips — enum chip", () => {
  it("renders the field name and all enum options", () => {
    const chips: FilterChip[] = [{ field: "status", state: { one_of: [] } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    expect(screen.getByText("status")).toBeDefined();
    expect(screen.getByRole("button", { name: "open" })).toBeDefined();
    expect(screen.getByRole("button", { name: "in-progress" })).toBeDefined();
    expect(screen.getByRole("button", { name: "done" })).toBeDefined();
  });

  it("toggling an unselected value calls onSetChip with it in one_of", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "status", state: { one_of: [] } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("status", { one_of: ["open"] });
  });

  it("toggling a selected value removes it from one_of", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "status", state: { one_of: ["open", "done"] } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(onSetChip).toHaveBeenCalledWith("status", { one_of: ["done"] });
  });

  // #395: a long enum list ran past the Filter popover's right edge. jsdom has no layout, so this
  // guards the hook the wrap rules key on and the rules themselves.
  it("renders its values in the wrapping .fchip-enum editor, which styles.css lets wrap inside the chip", () => {
    const chips: FilterChip[] = [{ field: "status", state: { one_of: [] } }];
    const { container } = render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    const editor = container.querySelector(".fchip > .fchip-editor.fchip-enum");
    expect(editor?.querySelectorAll(".fchip-enum-opt")).toHaveLength(3);

    const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8");
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".fchip")).toMatch(/flex-wrap: wrap;[^}]*max-width: 100%;/);
    expect(rule(".fchip-editor.fchip-enum")).toMatch(/flex: 1 1 0;\s*flex-wrap: wrap;/);
  });
});

// ---- number chip ----

describe("FieldChips — number chip", () => {
  it("renders min and max inputs", () => {
    const chips: FilterChip[] = [{ field: "score", state: { min: "", max: "" } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText("min")).toBeDefined();
    expect(screen.getByPlaceholderText("max")).toBeDefined();
  });

  it("changing min input calls onSetChip with {min, max}", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "score", state: { min: "", max: "" } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("min"), { target: { value: "5" } });
    expect(onSetChip).toHaveBeenCalledWith("score", { min: "5", max: "" });
  });

  it("changing max input calls onSetChip with {min, max}", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "score", state: { min: "3", max: "" } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("max"), { target: { value: "10" } });
    expect(onSetChip).toHaveBeenCalledWith("score", { min: "3", max: "10" });
  });
});

// ---- bool chip ----

describe("FieldChips — bool chip", () => {
  it("renders any/true/false segmented buttons", () => {
    const chips: FilterChip[] = [{ field: "active", state: { eq: null } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "any" })).toBeDefined();
    expect(screen.getByRole("button", { name: "true" })).toBeDefined();
    expect(screen.getByRole("button", { name: "false" })).toBeDefined();
  });

  it("clicking 'true' calls onSetChip with {eq: true}", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "active", state: { eq: null } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "true" }));
    expect(onSetChip).toHaveBeenCalledWith("active", { eq: true });
  });

  it("clicking 'false' calls onSetChip with {eq: false}", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "active", state: { eq: null } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "false" }));
    expect(onSetChip).toHaveBeenCalledWith("active", { eq: false });
  });

  it("clicking 'any' calls onSetChip with {eq: null}", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "active", state: { eq: true } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "any" }));
    expect(onSetChip).toHaveBeenCalledWith("active", { eq: null });
  });
});

// ---- add-filter button ----

describe("FieldChips — add-filter button", () => {
  it("renders '+ filter' button", () => {
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[STATUS_FIELD, SCORE_FIELD]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /\+ filter/i })).toBeDefined();
  });

  it("clicking '+ filter' opens a menu listing addable fields", () => {
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[STATUS_FIELD, SCORE_FIELD]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    expect(screen.getByRole("menuitem", { name: "status" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "score" })).toBeDefined();
  });

  it("picking a field from the menu calls onAddChip(field.name) and closes menu", () => {
    const onAddChip = vi.fn();
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[STATUS_FIELD, SCORE_FIELD]}
        fragments={[]}
        onAddChip={onAddChip}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "status" }));
    expect(onAddChip).toHaveBeenCalledOnce();
    expect(onAddChip).toHaveBeenCalledWith("status");
    // Menu should be closed now
    expect(screen.queryByRole("menuitem", { name: "status" })).toBeNull();
  });

  it("menu is closed by default", () => {
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[STATUS_FIELD]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    expect(screen.queryByRole("menuitem", { name: "status" })).toBeNull();
  });

  it("does not render '+ filter' button when addableFields is empty", () => {
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /\+ filter/i })).toBeNull();
  });

  it("lists extra options first, then a separator and the fields; picking one calls onAddExtra", () => {
    const onAddExtra = vi.fn();
    const onAddChip = vi.fn();
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[STATUS_FIELD]}
        fragments={[]}
        onAddChip={onAddChip}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
        extraAddOptions={[{ key: "title", label: "title contains" }, { key: "incoming", label: "links in", hint: "How many notes link here" }]}
        onAddExtra={onAddExtra}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["title contains", "links in", "status"]);
    expect(screen.getByRole("separator")).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "links in" }).getAttribute("title")).toBe("How many notes link here");
    fireEvent.click(screen.getByRole("menuitem", { name: "title contains" }));
    expect(onAddExtra).toHaveBeenCalledWith("title");
    expect(onAddChip).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders '+ filter' with only extra options when there is no schema", () => {
    render(
      <FieldChips
        schema={null}
        chips={[]}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
        extraAddOptions={[{ key: "title", label: "title contains" }]}
        onAddExtra={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["title contains"]);
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("clicking outside the open add-filter menu closes it", () => {
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[STATUS_FIELD, SCORE_FIELD]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    // Open the menu
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    expect(screen.getByRole("menuitem", { name: "status" })).toBeDefined();

    // Click outside — document.body is outside the add-wrap span
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menuitem", { name: "status" })).toBeNull();
  });
});

// ---- chip remove (×) ----

describe("FieldChips — chip remove", () => {
  it("clicking × on a chip calls onRemoveChip(field)", () => {
    const onRemoveChip = vi.fn();
    const chips: FilterChip[] = [{ field: "status", state: { one_of: [] } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={onRemoveChip}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "remove status chip" }));
    expect(onRemoveChip).toHaveBeenCalledOnce();
    expect(onRemoveChip).toHaveBeenCalledWith("status");
  });
});

// ---- caller fragment chips ----

describe("FieldChips — caller fragment chips", () => {
  const fragment: CallerFragment = {
    id: 42,
    key: "path_prefix",
    payload: "Notes/",
    scope: "global",
  };

  it("renders caller fragment chip with summarized label", () => {
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[]}
        fragments={[fragment]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    // summarizeFragment for path_prefix produces "path: Notes/…"
    expect(screen.getByText(/path: Notes\//)).toBeDefined();
  });

  it("clicking × on a fragment chip calls onRemoveFragment(id)", () => {
    const onRemoveFragment = vi.fn();
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={[]}
        addableFields={[]}
        fragments={[fragment]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={onRemoveFragment}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    expect(onRemoveFragment).toHaveBeenCalledOnce();
    expect(onRemoveFragment).toHaveBeenCalledWith(42);
  });
});

// ---- date chip ----

describe("FieldChips — date chip", () => {
  it("renders from and to date inputs", () => {
    const chips: FilterChip[] = [{ field: "due", state: { gte: "", lte: "" } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    // date inputs carry aria-label; use getByLabelText (role "textbox" doesn't apply to type="date")
    expect(screen.getByLabelText("from")).toBeDefined();
    expect(screen.getByLabelText("to")).toBeDefined();
  });

  it("changing the from input calls onSetChip with { gte: value, lte: current }", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "due", state: { gte: "", lte: "2026-12-31" } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("from"), { target: { value: "2026-01-01" } });
    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("due", { gte: "2026-01-01", lte: "2026-12-31" });
  });

  it("changing the to input calls onSetChip with { gte: current, lte: value }", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "due", state: { gte: "2026-01-01", lte: "" } }];
    render(
      <FieldChips
        schema={TASK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "2026-06-30" } });
    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("due", { gte: "2026-01-01", lte: "2026-06-30" });
  });
});

// ---- link chip ----

const PROJECT_FIELD: SchemaField = {
  name: "project",
  type: "reference",
  required: false,
  default_value: null,
  ui: null,
};

const SCHEMA_WITH_LINK: Schema = {
  name: "task",
  display_name: "Task",
  fields: [...TASK_SCHEMA.fields, PROJECT_FIELD],
};

describe("FieldChips — link chip", () => {
  it("renders any/set/empty segmented buttons", () => {
    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={SCHEMA_WITH_LINK}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(_linkMockClient) },
    );
    expect(screen.getByRole("button", { name: "any" })).toBeDefined();
    expect(screen.getByRole("button", { name: "set" })).toBeDefined();
    expect(screen.getByRole("button", { name: "empty" })).toBeDefined();
  });

  it("clicking 'set' calls onSetChip with { exists: true, target: null }", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={SCHEMA_WITH_LINK}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(_linkMockClient) },
    );
    fireEvent.click(screen.getByRole("button", { name: "set" }));
    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("project", { exists: true, target: null });
  });

  it("clicking 'empty' calls onSetChip with { exists: false, target: null }", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={SCHEMA_WITH_LINK}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(_linkMockClient) },
    );
    fireEvent.click(screen.getByRole("button", { name: "empty" }));
    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("project", { exists: false, target: null });
  });

  it("clicking 'any' calls onSetChip with { exists: null, target: null }", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [{ field: "project", state: { exists: true, target: null } }];
    render(
      <FieldChips
        schema={SCHEMA_WITH_LINK}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(_linkMockClient) },
    );
    fireEvent.click(screen.getByRole("button", { name: "any" }));
    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("project", { exists: null, target: null });
  });
});
