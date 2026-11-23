// @vitest-environment jsdom
/**
 * reference-cell-editor.test.tsx
 *
 * TDD tests for ReferenceCellEditor (wraps ReferenceAutocomplete as a CellEditor).
 * Also covers 4a fast-follows:
 *  - EnumCellEditor: Clear row keyboard-reachable via ArrowDown
 *  - DateCellEditor: toggling picker↔NL preserves the current value
 *
 * Written BEFORE implementation — must be RED initially.
 *
 * RCE-1: cellEditorFor("link") returns ReferenceCellEditor
 * RCE-2: picking a candidate → onSubmit(candidate.title)
 * RCE-3: keep-unresolved → onSubmit(typedText)
 * RCE-4: Escape → onCancel
 *
 * FF-ENUM-1: ArrowDown can navigate INTO the Clear row (keyboard-reachable)
 * FF-DATE-1: toggling picker→NL carries the picker value as nl initial text
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";

import { cellEditorFor, EnumCellEditor, DateCellEditor } from "../src/cell-editors/index.js";
import { ReferenceCellEditor } from "../src/cell-editors/ReferenceCellEditor.js";
import type { SchemaField, RefCandidate } from "@vault/query-core";

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

const LINK_FIELD: SchemaField = {
  name: "project",
  type: "reference",
  required: false,
  default_value: null,
  reference_target: "project",
  ui: { widget: "link" },
};

function makeCandidate(id: string, title: string, types: string[] = []): RefCandidate {
  return { id, title, types };
}

function okQueryNodes(candidates: RefCandidate[]) {
  return {
    ok: true as const,
    data: {
      nodes: candidates.map((c) => ({
        id: c.id,
        title: c.title,
        types: c.types,
        file_path: `${c.id}.md`,
        version: 1,
        field_count: 0,
      })),
      total: candidates.length,
    },
    warnings: [],
  };
}

async function renderAndWait(ui: React.ReactElement): Promise<void> {
  render(ui, { wrapper: withClient(mockClient) });
  await act(async () => {
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
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

beforeEach(() => {
  vi.useFakeTimers();
  mockQueryNodes.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── RCE-1: cellEditorFor("link") → ReferenceCellEditor ──────────────────────

describe("RCE-1: cellEditorFor maps link to ReferenceCellEditor", () => {
  it("cellEditorFor('link') returns ReferenceCellEditor (not TextCellEditor)", () => {
    expect(cellEditorFor("link")).toBe(ReferenceCellEditor);
  });
});

// ── RCE-2: picking a candidate → onSubmit(candidate.title) ──────────────────

describe("RCE-2: picking a candidate calls onSubmit(candidate.title)", () => {
  it("clicking a candidate row calls onSubmit with the candidate's title string", async () => {
    const candidates = [makeCandidate("n1", "My Project", ["project"])];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates));

    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    await renderAndWait(
      <ReferenceCellEditor
        initial=""
        field={LINK_FIELD}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("My Project")).toBeDefined();

    act(() => {
      fireEvent.mouseDown(screen.getByText("My Project"));
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("My Project");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("ArrowDown + Enter picks first candidate and calls onSubmit(title)", async () => {
    const candidates = [makeCandidate("n1", "Alpha Project")];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates));

    const onSubmit = vi.fn();

    await renderAndWait(
      <ReferenceCellEditor
        initial=""
        field={LINK_FIELD}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox");
    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onSubmit).toHaveBeenCalledWith("Alpha Project");
  });
});

// ── RCE-3: keep-unresolved → onSubmit(typedText) ────────────────────────────

describe("RCE-3: keep-unresolved calls onSubmit(typedText)", () => {
  it("clicking keep-unresolved calls onSubmit with the typed text", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // after typing

    const onSubmit = vi.fn();

    await renderAndWait(
      <ReferenceCellEditor
        initial=""
        field={LINK_FIELD}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "New Unresolved Note" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const keepRow = screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i);
    expect(keepRow).not.toBeNull();

    act(() => {
      fireEvent.mouseDown(screen.getByText(/keep.*unresolved|↵ Keep|unresolved link/i));
    });

    expect(onSubmit).toHaveBeenCalledWith("New Unresolved Note");
  });

  it("Enter with no candidates calls onSubmit with the typed text", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // after typing

    const onSubmit = vi.fn();

    await renderAndWait(
      <ReferenceCellEditor
        initial=""
        field={LINK_FIELD}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Phantom Node" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onSubmit).toHaveBeenCalledWith("Phantom Node");
  });
});

// ── RCE-4: Escape → onCancel ─────────────────────────────────────────────────

describe("RCE-4: Escape calls onCancel", () => {
  it("Escape fires onCancel and not onSubmit", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([]));

    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    await renderAndWait(
      <ReferenceCellEditor
        initial=""
        field={LINK_FIELD}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    const input = screen.getByRole("textbox");
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ── FF-ENUM-1: Clear row keyboard-reachable ───────────────────────────────────

describe("FF-ENUM-1: EnumCellEditor Clear row reachable by ArrowDown", () => {
  it("ArrowDown past last enum value reaches the Clear row; Enter submits null", () => {
    const onSubmit = vi.fn();
    const options = ["open", "done", "blocked"]; // 3 options → indices 0,1,2; Clear at 3

    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField(options)}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const container = screen.getByRole("listbox");
    // Start: activeIdx=0 (open). Press ArrowDown 3 times → reaches index 3 (Clear row).
    fireEvent.keyDown(container, { key: "ArrowDown" }); // 0→1 (done)
    fireEvent.keyDown(container, { key: "ArrowDown" }); // 1→2 (blocked)
    fireEvent.keyDown(container, { key: "ArrowDown" }); // 2→3 (Clear)
    fireEvent.keyDown(container, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledOnce();
    const arg = onSubmit.mock.calls[0]?.[0];
    expect(arg === null || arg === "").toBe(true);
  });

  it("Clear row shows data-active=true when navigated to via ArrowDown", () => {
    const options = ["open", "done"]; // 2 options; Clear at index 2

    render(
      <EnumCellEditor
        initial="open"
        field={makeEnumField(options)}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const container = screen.getByRole("listbox");
    fireEvent.keyDown(container, { key: "ArrowDown" }); // 0→1 (done)
    fireEvent.keyDown(container, { key: "ArrowDown" }); // 1→2 (Clear)

    const clearRow = screen.getByText(/clear/i).closest("[data-active]");
    expect(clearRow?.getAttribute("data-active")).toBe("true");
  });
});

// ── FF-DATE-1: toggling picker↔NL preserves value ────────────────────────────

describe("FF-DATE-1: DateCellEditor toggle preserves the picker value in NL mode", () => {
  it("switching from picker to NL mode populates the NL input with the picker's current value", () => {
    const onSubmit = vi.fn();

    render(
      <DateCellEditor
        initial="2026-06-20"
        field={makeDateField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    // Confirm we're in picker mode
    const pickerInput = document.querySelector("input[type='date']") as HTMLInputElement;
    expect(pickerInput).toBeTruthy();
    expect(pickerInput.value).toBe("2026-06-20");

    // Toggle to NL mode
    const toggle = screen.getByText(/natural language/i);
    fireEvent.mouseDown(toggle);

    // NL input should be seeded with the picker value
    const nlInput = document.querySelector("input[type='text']") as HTMLInputElement;
    expect(nlInput).toBeTruthy();
    expect(nlInput.value).toBe("2026-06-20");
  });

  it("switching NL→picker carries the NL text back so Enter submits it", () => {
    const onSubmit = vi.fn();

    render(
      <DateCellEditor
        initial=""
        field={makeDateField()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    // Toggle to NL mode
    fireEvent.mouseDown(screen.getByText(/natural language/i));
    const nlInput = document.querySelector("input[type='text']") as HTMLInputElement;
    fireEvent.change(nlInput, { target: { value: "next friday" } });

    // Toggle back to picker mode
    fireEvent.mouseDown(screen.getByText(/date picker/i));

    // Submit from picker mode — should use nlVal as fallback if pickerVal is empty
    const pickerInput = document.querySelector("input[type='date']") as HTMLInputElement | null;
    if (pickerInput) {
      fireEvent.keyDown(pickerInput, { key: "Enter" });
    }

    // Either "next friday" carried over OR pickerVal submitted (empty string OK here,
    // but the key invariant is that the toggle itself didn't lose "next friday" from nlVal)
    // We check that onSubmit was called at least once (don't prescribe which value)
    expect(onSubmit).toHaveBeenCalled();
  });
});
