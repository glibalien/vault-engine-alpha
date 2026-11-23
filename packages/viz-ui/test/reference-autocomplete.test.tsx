// @vitest-environment jsdom
/**
 * reference-autocomplete.test.tsx
 *
 * TDD tests for ReferenceAutocomplete + useRefSuggest hook.
 * Written BEFORE the implementation — must be RED initially.
 *
 * Coverage:
 *  AC-1: mount → search("") fires immediately (recent candidates load)
 *  AC-2: typing "foo" → suggestArgs(field,"foo").title_contains === "foo" + list updates
 *  AC-3: ArrowDown + Enter → onPick({ kind: "candidate", candidate })
 *  AC-4: non-matching typed input + !requireCandidate → keep-unresolved row visible
 *  AC-5: Enter on keep-unresolved → onPick({ kind: "unresolved", text: input })
 *  AC-6: Escape → onCancel
 *  AC-7: out-of-order: stale slow response does NOT overwrite a newer one
 *  AC-8: requireCandidate=true → no keep-unresolved row shown
 *  AC-9: exact-title match → no keep-unresolved row even without requireCandidate
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";

import { ReferenceAutocomplete } from "../src/ReferenceAutocomplete.js";
import type { PickResult } from "../src/ReferenceAutocomplete.js";
import type { SchemaField, RefCandidate } from "@vault/query-core";

import { withClient } from "./_render-viz.js";

// ---- Mock client ----
// We inject a client via VizClientProvider so we can control queryNodes responses.

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

const TASK_FIELD: SchemaField = {
  name: "project",
  type: "reference",
  required: false,
  default_value: null,
  reference_target: "project",
  ui: null,
};

const UNSCOPED_FIELD: SchemaField = {
  name: "link",
  type: "reference",
  required: false,
  default_value: null,
  ui: null,
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

// Helper: render + advance debounce + wait for async resolution
// Uses real timers but with fake-timer-compatible approach:
// We advance fake timers to fire debounce, then flush microtasks via act.
async function renderAndWaitForMount(
  ui: React.ReactElement,
): Promise<void> {
  render(ui, { wrapper: withClient(mockClient) });
  // Advance debounce (200ms) so the search fires
  await act(async () => {
    vi.advanceTimersByTime(250);
    // Flush the resulting Promise microtasks
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockQueryNodes.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- AC-1: mount → search("") fires, recent candidates load ----

describe("AC-1: mount fires search('') and loads recent candidates", () => {
  it("calls queryNodes with no title_contains on mount (recent mode)", async () => {
    const candidates = [makeCandidate("a", "Alpha"), makeCandidate("b", "Beta")];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates));

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(mockQueryNodes).toHaveBeenCalledOnce();
    // The args should have no title_contains (recent mode), but may have types scoped to reference_target
    const calledArgs = mockQueryNodes.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledArgs).not.toHaveProperty("title_contains");
    expect(calledArgs).toHaveProperty("sort_by", "file_mtime");
    expect(calledArgs).toHaveProperty("sort_order", "desc");

    // Candidates should be rendered in the DOM
    expect(screen.getByText("Alpha")).toBeDefined();
    expect(screen.getByText("Beta")).toBeDefined();
  });

  it("scopes queryNodes to field.reference_target when present", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([]));

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );

    const calledArgs = mockQueryNodes.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledArgs).toHaveProperty("types", ["project"]);
  });

  it("does not scope to types when reference_target is absent", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([]));

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={UNSCOPED_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );

    const calledArgs = mockQueryNodes.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledArgs).not.toHaveProperty("types");
  });
});

// ---- AC-2: typing "foo" → title_contains + list updates ----

describe("AC-2: typing updates suggestArgs and rendered list", () => {
  it("sends title_contains when user types a query", async () => {
    // First call: mount (recent)
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([]));
    // Second call: after typing "foo"
    const fooResults = [makeCandidate("f1", "Foobar"), makeCandidate("f2", "Foolish")];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(fooResults));

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(mockQueryNodes).toHaveBeenCalledTimes(1);

    // Type "foo" into the input
    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "foo" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockQueryNodes).toHaveBeenCalledTimes(2);
    const secondArgs = mockQueryNodes.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(secondArgs).toHaveProperty("title_contains", "foo");
    expect(secondArgs).not.toHaveProperty("sort_by");

    // List must update to show Foobar and Foolish
    expect(screen.getByText("Foobar")).toBeDefined();
    expect(screen.getByText("Foolish")).toBeDefined();
  });
});

// ---- AC-3: ArrowDown + Enter → onPick candidate ----

describe("AC-3: ArrowDown + Enter picks a candidate", () => {
  it("fires onPick({ kind: 'candidate', candidate }) on Enter after ArrowDown", async () => {
    const candidates = [makeCandidate("a", "Alpha", ["project"]), makeCandidate("b", "Beta")];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates));

    const onPick = vi.fn();
    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={onPick} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("Alpha")).toBeDefined();

    const input = screen.getByRole("textbox");
    // ArrowDown to navigate to first candidate, then Enter
    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onPick).toHaveBeenCalledOnce();
    const result = onPick.mock.calls[0]?.[0] as PickResult;
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.title).toBe("Alpha");
    }
  });

  it("clicking a candidate row fires onPick({ kind: 'candidate', candidate })", async () => {
    const candidates = [makeCandidate("a", "Alpha", ["project"])];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates));

    const onPick = vi.fn();
    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={onPick} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("Alpha")).toBeDefined();

    act(() => {
      fireEvent.mouseDown(screen.getByText("Alpha"));
    });

    expect(onPick).toHaveBeenCalledOnce();
    const result = onPick.mock.calls[0]?.[0] as PickResult;
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.id).toBe("a");
      expect(result.candidate.title).toBe("Alpha");
    }
  });
});

// ---- AC-4: non-matching input + !requireCandidate → keep-unresolved row ----

describe("AC-4: keep-unresolved row visibility", () => {
  it("shows keep-unresolved row when input is non-empty and no exact title match", async () => {
    const candidates = [makeCandidate("a", "Alpha")];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates)); // after typing

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "alph" } }); // not exact match for "Alpha"
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should see keep-unresolved row
    const keepRow = screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i);
    expect(keepRow).not.toBeNull();
  });

  it("does NOT show keep-unresolved row when input is empty", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([makeCandidate("a", "Alpha")]));

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("Alpha")).toBeDefined();

    // Input is empty on mount, no keep-unresolved
    const keepRow = screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i);
    expect(keepRow).toBeNull();
  });
});

// ---- AC-5: Enter on keep-unresolved → onPick unresolved ----

describe("AC-5: keep-unresolved Enter fires onPick({ kind: 'unresolved', text })", () => {
  it("clicking keep-unresolved row fires onPick({ kind: 'unresolved', text: input })", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // after typing (no candidates)

    const onPick = vi.fn();
    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={onPick} onCancel={vi.fn()} />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "My New Note" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const keepRow = screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i);
    expect(keepRow).not.toBeNull();

    // Click the keep-unresolved row
    act(() => {
      fireEvent.mouseDown(screen.getByText(/keep.*unresolved|↵ Keep|unresolved link/i));
    });

    expect(onPick).toHaveBeenCalledOnce();
    const result = onPick.mock.calls[0]?.[0] as PickResult;
    expect(result.kind).toBe("unresolved");
    if (result.kind === "unresolved") {
      expect(result.text).toBe("My New Note");
    }
  });

  it("trims leading/trailing whitespace from text submitted as unresolved", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // after typing

    const onPick = vi.fn();
    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={onPick} onCancel={vi.fn()} />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "  My Note  " } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i)).not.toBeNull();

    act(() => {
      fireEvent.mouseDown(screen.getByText(/keep.*unresolved|↵ Keep|unresolved link/i));
    });

    expect(onPick).toHaveBeenCalledOnce();
    const result = onPick.mock.calls[0]?.[0] as PickResult;
    expect(result.kind).toBe("unresolved");
    if (result.kind === "unresolved") {
      // text should be trimmed — spaces stripped from vault payload
      expect(result.text).toBe("My Note");
    }
  });

  it("pressing Enter with no candidates fires onPick unresolved (keep row active)", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // after typing

    const onPick = vi.fn();
    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={onPick} onCancel={vi.fn()} />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Some Unresolved" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i)).not.toBeNull();

    // Press Enter — only the keep row is available
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onPick).toHaveBeenCalledOnce();
    const result = onPick.mock.calls[0]?.[0] as PickResult;
    expect(result.kind).toBe("unresolved");
    if (result.kind === "unresolved") {
      expect(result.text).toBe("Some Unresolved");
    }
  });
});

// ---- AC-6: Escape → onCancel ----

describe("AC-6: Escape fires onCancel", () => {
  it("pressing Escape calls onCancel", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([]));

    const onCancel = vi.fn();
    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={onCancel} />,
    );

    const input = screen.getByRole("textbox");
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// ---- AC-7: out-of-order — stale response does not overwrite newer one ----

describe("AC-7: out-of-order responses — last query wins", () => {
  it("a stale slow response does not overwrite a newer response", async () => {
    // First call (mount, recent): resolves SLOWLY (after second call resolves)
    let resolveFirst!: (v: unknown) => void;
    const firstPromise = new Promise((res) => { resolveFirst = res; });

    // Second call (type "foo"): resolves FAST
    const fastResult = okQueryNodes([makeCandidate("fast", "Fast Result")]);

    mockQueryNodes
      .mockReturnValueOnce(firstPromise) // mount call — hangs
      .mockResolvedValueOnce(fastResult); // type "foo" — fast

    render(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
      { wrapper: withClient(mockClient) },
    );

    // Let mount search fire (but it hangs — first promise not resolved yet)
    act(() => {
      vi.advanceTimersByTime(250);
    });

    // Type "foo" — fires second search (resolves immediately)
    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "foo" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fast result should be visible
    expect(screen.getByText("Fast Result")).toBeDefined();

    // Now resolve the stale first call with DIFFERENT candidates
    const staleResult = okQueryNodes([makeCandidate("stale", "Stale Result")]);
    await act(async () => {
      resolveFirst(staleResult);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Stale result must NOT overwrite the current list
    expect(screen.queryByText("Stale Result")).toBeNull();
    // Fast result must still be visible
    expect(screen.getByText("Fast Result")).toBeDefined();
  });
});

// ---- AC-8: requireCandidate=true → no keep-unresolved ----

describe("AC-8: requireCandidate suppresses keep-unresolved row", () => {
  it("does not show keep-unresolved row when requireCandidate=true", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // after typing

    await renderAndWaitForMount(
      <ReferenceAutocomplete
        field={TASK_FIELD}
        requireCandidate
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "something new" } });
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No keep-unresolved row
    const keepRow = screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i);
    expect(keepRow).toBeNull();
  });
});

// ---- AC-9: exact-title match → no keep-unresolved ----

describe("AC-9: exact-title match suppresses keep-unresolved row", () => {
  it("hides keep-unresolved when input matches a candidate title exactly (case-insensitive)", async () => {
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes([])); // mount
    const candidates = [makeCandidate("a", "Alpha")];
    mockQueryNodes.mockResolvedValueOnce(okQueryNodes(candidates));

    await renderAndWaitForMount(
      <ReferenceAutocomplete field={TASK_FIELD} onPick={vi.fn()} onCancel={vi.fn()} />,
    );

    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Alpha" } }); // exact match
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Alpha")).toBeDefined();

    // No keep-unresolved row when there's an exact title match
    const keepRow = screen.queryByText(/keep.*unresolved|↵ Keep|unresolved link/i);
    expect(keepRow).toBeNull();
  });
});
