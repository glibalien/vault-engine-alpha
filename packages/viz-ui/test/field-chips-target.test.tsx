// @vitest-environment jsdom
/**
 * field-chips-target.test.tsx
 *
 * TDD tests for the link-chip identity target picker in FieldChips.
 *
 * Coverage:
 *  TC-1: link chip shows a "pick target" affordance alongside any/set/empty
 *  TC-2: clicking the affordance renders ReferenceAutocomplete (with requireCandidate)
 *  TC-3: picking a node calls onSetChip(field, { exists: null, target: { id, title } })
 *  TC-4: a chip arriving with target.title set shows the target title
 *  TC-5: a chip arriving with target: { id, title: null } hydrates the title via queryNodes
 *  TC-6: clearing the target returns to any/set/empty mode
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";

import type { Schema, SchemaField, FilterChip } from "@vault/query-core";
import { FieldChips } from "../src/FieldChips.js";

import { withClient } from "./_render-viz.js";

// ---- Mock client injected via VizClientProvider ----

const mockQueryNodes = vi.fn();

const mockClient = {
  queryNodes: mockQueryNodes,
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

// ---- Fixtures ----

const PROJECT_FIELD: SchemaField = {
  name: "project",
  type: "reference",
  required: false,
  default_value: null,
  ui: null,
};

const LINK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [PROJECT_FIELD],
};

function okQueryNodes(id: string, title: string) {
  return {
    ok: true as const,
    data: {
      nodes: [{ id, title, types: [], file_path: `${id}.md`, version: 1, field_count: 0 }],
      total: 1,
    },
    warnings: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockQueryNodes.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- TC-1: link chip shows a "pick target" affordance ----

describe("TC-1: link chip shows pick-target affordance", () => {
  it("renders a 'pick…' button alongside any/set/empty when no target is set", () => {
    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );
    expect(screen.getByRole("button", { name: "any" })).toBeDefined();
    expect(screen.getByRole("button", { name: "set" })).toBeDefined();
    expect(screen.getByRole("button", { name: "empty" })).toBeDefined();
    expect(screen.getByRole("button", { name: /pick/i })).toBeDefined();
  });
});

// ---- TC-2: clicking pick… opens ReferenceAutocomplete ----

describe("TC-2: clicking pick… opens ReferenceAutocomplete (requireCandidate)", () => {
  it("opens the autocomplete when pick… is clicked", async () => {
    // ReferenceAutocomplete fires search("") on mount
    mockQueryNodes.mockResolvedValue({ ok: true, data: { nodes: [], total: 0 }, warnings: [] });

    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    fireEvent.click(screen.getByRole("button", { name: /pick/i }));

    // The autocomplete input should be visible
    expect(screen.getByRole("textbox")).toBeDefined();

    // Advance timers to let the mount search fire + settle
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("autocomplete is opened with requireCandidate (no keep-unresolved row)", async () => {
    mockQueryNodes.mockResolvedValue({ ok: true, data: { nodes: [], total: 0 }, warnings: [] });

    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    fireEvent.click(screen.getByRole("button", { name: /pick/i }));

    const input = screen.getByRole("textbox");
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Type something non-matching; keep-unresolved row must NOT appear
    await act(async () => {
      fireEvent.change(input, { target: { value: "something" } });
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i)).toBeNull();
  });
});

// ---- TC-3: picking a node calls onSetChip with target ----

describe("TC-3: picking a node calls onSetChip(field, { exists: null, target: { id, title } })", () => {
  it("fires onSetChip with the picked node's id and title", async () => {
    const onSetChip = vi.fn();

    // mount search returns a candidate
    mockQueryNodes.mockResolvedValue({
      ok: true,
      data: {
        nodes: [{ id: "node-1", title: "My Project", types: ["project"], file_path: "node-1.md", version: 1, field_count: 0 }],
        total: 1,
      },
      warnings: [],
    });

    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: null } }];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    fireEvent.click(screen.getByRole("button", { name: /pick/i }));

    // Wait for candidates to load
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The candidate "My Project" should be visible
    expect(screen.getByText("My Project")).toBeDefined();

    // Click the candidate
    act(() => {
      fireEvent.mouseDown(screen.getByText("My Project"));
    });

    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("project", {
      exists: null,
      target: { id: "node-1", title: "My Project" },
    });
  });
});

// ---- TC-4: chip with target.title shows the title ----

describe("TC-4: chip with target shows target title", () => {
  it("shows the target title and a clear button when target is set with title", () => {
    const chips: FilterChip[] = [
      { field: "project", state: { exists: null, target: { id: "node-1", title: "My Project" } } },
    ];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    expect(screen.getByText("My Project")).toBeDefined();
    expect(screen.getByRole("button", { name: /clear target/i })).toBeDefined();
  });

  it("does NOT show the any/set/empty buttons when a target is set", () => {
    const chips: FilterChip[] = [
      { field: "project", state: { exists: null, target: { id: "node-1", title: "My Project" } } },
    ];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    expect(screen.queryByRole("button", { name: "any" })).toBeNull();
    expect(screen.queryByRole("button", { name: "set" })).toBeNull();
    expect(screen.queryByRole("button", { name: "empty" })).toBeNull();
  });
});

// ---- TC-5: chip with target: { id, title: null } hydrates title ----

describe("TC-5: chip with target.title === null hydrates the title via queryNodes", () => {
  it("calls queryNodes with node_ids and displays the hydrated title", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes("node-1", "Hydrated Title"));

    const chips: FilterChip[] = [
      { field: "project", state: { exists: null, target: { id: "node-1", title: null } } },
    ];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={vi.fn()}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    // Initially may show loading/id
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockQueryNodes).toHaveBeenCalledWith(
      expect.objectContaining({ node_ids: ["node-1"], limit: 1 }),
    );
    expect(screen.getByText("Hydrated Title")).toBeDefined();
  });
});

// ---- TC-6: clearing the target returns to any/set/empty ----

describe("TC-6: clearing the target returns to any/set/empty mode", () => {
  it("clicking 'clear target' calls onSetChip with { exists: null, target: null }", () => {
    const onSetChip = vi.fn();
    const chips: FilterChip[] = [
      { field: "project", state: { exists: null, target: { id: "node-1", title: "My Project" } } },
    ];
    render(
      <FieldChips
        schema={LINK_SCHEMA}
        chips={chips}
        addableFields={[]}
        fragments={[]}
        onAddChip={vi.fn()}
        onSetChip={onSetChip}
        onRemoveChip={vi.fn()}
        onRemoveFragment={vi.fn()}
      />,
      { wrapper: withClient(mockClient) },
    );

    fireEvent.click(screen.getByRole("button", { name: /clear target/i }));

    expect(onSetChip).toHaveBeenCalledOnce();
    expect(onSetChip).toHaveBeenCalledWith("project", { exists: null, target: null });
  });
});
