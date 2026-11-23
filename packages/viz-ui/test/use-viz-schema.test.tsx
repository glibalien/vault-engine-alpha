// @vitest-environment jsdom
/**
 * use-viz-schema.test.tsx
 *
 * TDD tests for useVizSchema + useVizTypes hooks.
 * Mocks makeVizQueryClient so no real fetch occurs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, useEffect } from "react";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import type { Schema, TypeSummary, Envelope } from "@vault/query-core";

import { useVizSchema, useVizTypes, useVizTypeCounts, _resetCachesForTest } from "../src/use-viz-schema.js";
import { withClient } from "./_render-viz.js";

// ---------- helpers ----------

const TASK_SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    {
      name: "status",
      type: "enum",
      required: false,
      default_value: null,
      enum_values: ["todo", "done"],
      ui: null,
    },
  ],
};

function okEnvelope<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] };
}

function failEnvelope(code: string, message: string): Envelope<never> {
  return { ok: false, error: { code, message }, warnings: [] };
}

// ---------- probe components ----------

function SchemaProbe({ type }: { type: string | null }) {
  const schema = useVizSchema(type);
  if (schema === null) return <span data-testid="result">null</span>;
  return <span data-testid="result">{schema.name}</span>;
}

function TypesProbe() {
  const types = useVizTypes();
  return <span data-testid="result">{types.join(",")}</span>;
}

// Mounts BOTH useVizTypes and useVizTypeCounts in one component, the way VizCard does.
function TypesAndCountsProbe() {
  const types = useVizTypes();
  const counts = useVizTypeCounts();
  return (
    <span data-testid="result">
      {types.join(",")}|{Object.entries(counts).map(([t, c]) => `${t}=${c}`).join(",")}
    </span>
  );
}

// ---------- setup ----------

const mockClient = {
  describeSchema: vi.fn<[string], Promise<Envelope<Schema>>>(),
  listTypes: vi.fn<[], Promise<Envelope<TypeSummary[]>>>(),
  queryNodes: vi.fn(),
  describeGlobalField: vi.fn(),
  listFieldValues: vi.fn(),
  updateNode: vi.fn(),
  renameNode: vi.fn(),
  getNode: vi.fn(),
  createNode: vi.fn(),
  deleteNode: vi.fn(),
  batchMutate: vi.fn(),
};

beforeEach(() => {
  mockClient.describeSchema.mockReset();
  mockClient.listTypes.mockReset();
  // clear module-level caches between tests
  _resetCachesForTest();
});

afterEach(() => {
  cleanup();
});

// ---------- useVizSchema tests ----------

describe("useVizSchema", () => {
  it("returns null immediately for a null type", () => {
    render(<SchemaProbe type={null} />, { wrapper: withClient(mockClient) });
    expect(screen.getByTestId("result").textContent).toBe("null");
    // no fetch should have been triggered
    expect(mockClient.describeSchema).not.toHaveBeenCalled();
  });

  it("returns null initially then the schema after the effect resolves", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));
    render(<SchemaProbe type="task" />, { wrapper: withClient(mockClient) });
    // initial render: null while loading
    expect(screen.getByTestId("result").textContent).toBe("null");
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe("task")
    );
    expect(mockClient.describeSchema).toHaveBeenCalledWith("task");
  });

  it("caches schema — second mount does not trigger a second fetch", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(okEnvelope(TASK_SCHEMA));

    const { unmount } = render(<SchemaProbe type="task" />, { wrapper: withClient(mockClient) });
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe("task")
    );
    unmount();

    // Second mount — cache should serve it immediately, no second network call
    render(<SchemaProbe type="task" />, { wrapper: withClient(mockClient) });
    // Should already be "task" (synchronous from cache)
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe("task")
    );
    expect(mockClient.describeSchema).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully on !ok envelope — returns null, no throw", async () => {
    mockClient.describeSchema.mockResolvedValueOnce(
      failEnvelope("NOT_FOUND", "schema not found") as unknown as Envelope<Schema>
    );
    render(<SchemaProbe type="missing" />, { wrapper: withClient(mockClient) });
    // stays null — error envelope does not throw
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId("result").textContent).toBe("null");
  });
});

// ---------- useVizTypes tests ----------

describe("useVizTypes", () => {
  it("returns empty array initially", () => {
    mockClient.listTypes.mockResolvedValueOnce(
      okEnvelope([{ type: "task", count: 1, has_schema: true, claim_count: null }])
    );
    render(<TypesProbe />, { wrapper: withClient(mockClient) });
    expect(screen.getByTestId("result").textContent).toBe("");
  });

  it("returns type names after the effect resolves", async () => {
    const summaries: TypeSummary[] = [
      { type: "task", count: 5, has_schema: true, claim_count: null },
      { type: "project", count: 2, has_schema: false, claim_count: null },
    ];
    mockClient.listTypes.mockResolvedValueOnce(okEnvelope(summaries));

    render(<TypesProbe />, { wrapper: withClient(mockClient) });
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).not.toBe("")
    );
    expect(screen.getByTestId("result").textContent).toBe("task,project");
    expect(mockClient.listTypes).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully on !ok envelope — returns empty array, no throw", async () => {
    mockClient.listTypes.mockResolvedValueOnce(
      failEnvelope("INTERNAL", "list-types failed") as unknown as Envelope<TypeSummary[]>
    );
    render(<TypesProbe />, { wrapper: withClient(mockClient) });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId("result").textContent).toBe("");
  });
});

// ---------- useVizTypeCounts tests ----------

describe("useVizTypeCounts", () => {
  it("mounting useVizTypes + useVizTypeCounts together issues listTypes() exactly once", async () => {
    const summaries: TypeSummary[] = [
      { type: "task", count: 342, has_schema: true, claim_count: null },
      { type: "meeting", count: 88, has_schema: false, claim_count: null },
    ];
    mockClient.listTypes.mockResolvedValueOnce(okEnvelope(summaries));

    render(<TypesAndCountsProbe />, { wrapper: withClient(mockClient) });
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toContain("task=342")
    );
    // both hooks share the one in-flight request — no second round-trip
    expect(mockClient.listTypes).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("result").textContent).toBe(
      "task,meeting|task=342,meeting=88"
    );
  });
});
