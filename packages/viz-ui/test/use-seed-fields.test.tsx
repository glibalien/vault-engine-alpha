// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { waitFor, act } from "@testing-library/react";
import type { Schema, Client, FilterChip } from "@vault/query-core";
import { useSeedFields } from "../src/use-seed-fields.js";
import { renderVizHook } from "./_render-viz.js";

const SCHEMA: Schema = {
  name: "task",
  display_name: "Task",
  fields: [
    { name: "project", type: "reference", required: false, default_value: null, ui: null },
    { name: "status", type: "enum", required: false, default_value: null, enum_values: ["open", "done"], ui: null },
  ],
};

function makeClient(over: Partial<Client> = {}): Client {
  return {
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
    ...over,
  } as unknown as Client;
}

function nodesEnv(id: string, title: string) {
  return { ok: true as const, data: { nodes: [{ id, title, types: [], file_path: `${id}.md`, version: 1, field_count: 0 }], total: 1 }, warnings: [] };
}

describe("useSeedFields", () => {
  it("seeds an enum filter immediately and resolves a reference (link) filter's title from its id", async () => {
    const queryNodes = vi.fn(async () => nodesEnv("p1", "My Project"));
    const client = makeClient({ queryNodes });
    // The link chip has only the id (as rebuilt from a saved board query); title is null.
    const chips: FilterChip[] = [
      { field: "project", state: { exists: null, target: { id: "p1", title: null } } },
      { field: "status", state: { one_of: ["open"] } },
    ];

    const { result } = renderVizHook(() => useSeedFields(SCHEMA, chips, []), client);

    // Enum seeds synchronously; the reference needs the async title resolve.
    expect(result.current.status).toBe("open");

    await waitFor(() => expect(result.current.project).toBe("My Project"));
    expect(queryNodes).toHaveBeenCalledWith(expect.objectContaining({ node_ids: ["p1"] }));
  });

  it("does not seed a reference filter that is a presence (exists) filter", async () => {
    const queryNodes = vi.fn();
    const client = makeClient({ queryNodes });
    const chips: FilterChip[] = [{ field: "project", state: { exists: true, target: null } }];

    const { result } = renderVizHook(() => useSeedFields(SCHEMA, chips, []), client);
    await act(async () => { await Promise.resolve(); });

    expect(result.current.project).toBeUndefined();
    expect(queryNodes).not.toHaveBeenCalled();
  });
});
