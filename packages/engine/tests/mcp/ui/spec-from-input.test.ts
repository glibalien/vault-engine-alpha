import { describe, it, expect } from "vitest";
import { specFromToolInput } from "../../../src/mcp/ui/query-nodes/spec-from-input.js";

describe("specFromToolInput", () => {
  it("returns null for non-object input", () => {
    expect(specFromToolInput(null)).toBeNull();
    expect(specFromToolInput("x")).toBeNull();
    expect(specFromToolInput([1])).toBeNull();
  });

  it("forwards all query args verbatim except presentation keys", () => {
    const spec = specFromToolInput({
      types: ["task"],
      fields: { status: { eq: "open" } },
      join_filters: [{ rel_type: "project", target: { types: ["project"] } }],
      full_text: "urgent",
      search_mode: "hybrid",
      include_fields: ["status", "due"],
      select: ["file_path", "title"],
    })!;
    expect(spec.query).toEqual({
      types: ["task"],
      fields: { status: { eq: "open" } },
      join_filters: [{ rel_type: "project", target: { types: ["project"] } }],
      full_text: "urgent",
      search_mode: "hybrid",
    });
    expect("include_fields" in spec.query).toBe(false);
    expect("select" in spec.query).toBe(false);
  });

  it("drops explicit undefined-valued keys", () => {
    const spec = specFromToolInput({ types: ["task"], full_text: undefined })!;
    expect(spec.query).toEqual({ types: ["task"] });
    expect("full_text" in spec.query).toBe(false);
  });

  it("maps include_fields to display_fields, dropping '*' and capping at 8", () => {
    const spec = specFromToolInput({
      include_fields: ["*", "a", "b", "c", "d", "e", "f", "g", "h", "i"],
    })!;
    expect(spec.display_fields).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("seeds empty display_fields when include_fields is absent (VizCard re-derives)", () => {
    expect(specFromToolInput({ types: ["task"] })!.display_fields).toEqual([]);
  });

  it("clamps limit into [1, 200] when present, leaves it absent otherwise", () => {
    expect(specFromToolInput({ limit: 0 })!.query.limit).toBe(1);
    expect(specFromToolInput({ limit: 5000 })!.query.limit).toBe(200);
    expect(specFromToolInput({ limit: 50 })!.query.limit).toBe(50);
    expect("limit" in specFromToolInput({})!.query).toBe(false);
  });

  it("derives the title from types and search query", () => {
    expect(specFromToolInput({ types: ["task", "project"] })!.title).toBe("task + project");
    expect(specFromToolInput({ types: ["task"], query: " roadmap " })!.title).toBe('task · "roadmap"');
    expect(specFromToolInput({})!.title).toBe("nodes");
  });

  it("falls back to \"nodes\" when types is present but empty", () => {
    expect(specFromToolInput({ types: [] })!.title).toBe("nodes");
  });

  it("suppresses the title suffix for a blank/whitespace-only query but still forwards it verbatim", () => {
    const spec = specFromToolInput({ types: ["task"], query: "   " })!;
    expect(spec.title).toBe("task");
    expect(spec.query.query).toBe("   ");
  });

  it("always seeds kind 'table'", () => {
    expect(specFromToolInput({})!.kind).toBe("table");
  });
});

it('seeds a complete Boolean expression without promoting nested fields',()=>{
 const where={any:[{fields:{status:{eq:'open'}}},{join_filters:[{rel_type:'project',target:{title_eq:'A'}}]}]};
 expect(specFromToolInput({where,include_fields:['status']})?.query).toEqual({where});
});

it('shows the link-count columns when the call selected a count (#611)', () => {
  const spec = specFromToolInput({ link_counts: { incoming: { lte: 1 } }, select: ['title', 'inlink_count'] })!;
  expect(spec.show_link_counts).toBe(true);
  expect(spec.query).toEqual({ link_counts: { incoming: { lte: 1 } } });
  expect(specFromToolInput({ select: ['title'] })).not.toHaveProperty('show_link_counts');
});
