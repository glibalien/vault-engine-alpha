import { describe, it, expect } from "vitest";
import { suggestArgs, toCandidates } from "../../src/flows/suggest.js";
import type { SchemaField, NodeRow } from "../../src/types.js";

const refField = (target?: string): SchemaField => ({
  name: "project", type: "reference", required: false, default_value: null,
  ...(target ? { reference_target: target } : {}), ui: null,
});

const row = (over: Partial<NodeRow>): NodeRow => ({
  id: "n1", file_path: "Notes/X.md", title: "X", types: ["project"],
  version: 1, field_count: 0, ...over,
});

describe("suggestArgs", () => {
  it("empty query → recent nodes of the reference_target type", () => {
    expect(suggestArgs(refField("project"), "")).toEqual({
      types: ["project"], sort_by: "file_mtime", sort_order: "desc", limit: 10,
    });
  });

  it("non-empty query → title_contains, still type-scoped", () => {
    expect(suggestArgs(refField("project"), "vau")).toEqual({
      types: ["project"], title_contains: "vau", limit: 10,
    });
  });

  it("no reference_target → no types filter (suggest across all nodes)", () => {
    expect(suggestArgs(refField(), "vau")).toEqual({ title_contains: "vau", limit: 10 });
    expect(suggestArgs(refField(), "")).toEqual({
      sort_by: "file_mtime", sort_order: "desc", limit: 10,
    });
  });
});

describe("toCandidates", () => {
  it("maps rows to {id,title,types} and drops null titles", () => {
    expect(toCandidates([
      row({ id: "a", title: "Alpha", types: ["project"] }),
      row({ id: "b", title: null }),
    ])).toEqual([{ id: "a", title: "Alpha", types: ["project"] }]);
  });
});
