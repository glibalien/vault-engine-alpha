import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterStrip, stripField } from "../src/FilterStrip.js";
import { vizOwnedState } from "../src/viz-query.js";
import { initVizQueryState, reduceVizQuery, composeFromState } from "../src/use-viz-query.js";
import type { VizSpec } from "../src/viz-spec.js";
import type { StripState } from "@vault/query-core";

const spec: VizSpec = {
  kind: "table",
  title: "t",
  query: { types: ["task"], sort_by: "title", sort_order: "asc", limit: 50 },
  display_fields: ["status"],
};

const baseStrip: StripState = {
  title_contains: "",
  query: "",
  sort_by: "title",
  sort_order: "asc",
  limit: 50,
};

describe("stripField", () => {
  it("title_contains updates title_contains (not query)", () => {
    const result = stripField(baseStrip, "title_contains", "hello");
    expect(result.title_contains).toBe("hello");
    expect(result.query).toBe("");
  });

  it("query updates query (not title_contains)", () => {
    const result = stripField(baseStrip, "query", "world");
    expect(result.query).toBe("world");
    expect(result.title_contains).toBe("");
  });

  it("sort_by updates sort_by (not sort_order)", () => {
    const result = stripField(baseStrip, "sort_by", "file_mtime");
    expect(result.sort_by).toBe("file_mtime");
    expect(result.sort_order).toBe("asc");
  });

  it("sort_order updates sort_order (not sort_by)", () => {
    const result = stripField(baseStrip, "sort_order", "desc");
    expect(result.sort_order).toBe("desc");
    expect(result.sort_by).toBe("title");
  });

  it("limit parses raw string to a number", () => {
    const result = stripField(baseStrip, "limit", "25");
    expect(result.limit).toBe(25);
    expect(typeof result.limit).toBe("number");
  });

  it("limit falls back to 50 on bad input (NaN guard)", () => {
    const result = stripField(baseStrip, "limit", "abc");
    expect(result.limit).toBe(50);
  });

  it("limit falls back to 50 on empty string", () => {
    const result = stripField(baseStrip, "limit", "");
    expect(result.limit).toBe(50);
  });

  it("other fields are unchanged when one field is updated", () => {
    const strip: StripState = {
      title_contains: "foo",
      query: "bar",
      sort_by: "indexed_at",
      sort_order: "desc",
      limit: 10,
    };
    const result = stripField(strip, "query", "baz");
    expect(result.title_contains).toBe("foo");
    expect(result.sort_by).toBe("indexed_at");
    expect(result.sort_order).toBe("desc");
    expect(result.limit).toBe(10);
  });
});

describe("FilterStrip", () => {
  it("renders the 3 remaining controls (sort moved to VizSettings)", () => {
    const html = renderToStaticMarkup(
      <FilterStrip strip={baseStrip} onStripChange={() => {}} />,
    );
    expect(html).toContain("title-contains");
    expect(html).toContain("hybrid-search");
    expect(html).not.toContain("sort-by");
    expect(html).not.toContain("sort-order");
    expect(html).toContain("limit");
  });

  it("reflects strip limit=50 in the number input", () => {
    const html = renderToStaticMarkup(
      <FilterStrip strip={baseStrip} onStripChange={() => {}} />,
    );
    expect(html).toContain('value="50"');
  });

  it("setStrip via useVizQuery preserves non-strip keys when strip changes", () => {
    // Verify the same round-trip property via the schema-aware state core:
    // when sort_order changes to desc, types is still preserved in the recomposed args.
    const strip = vizOwnedState(spec).strip;
    const nextStrip = { ...strip, sort_order: "desc" as const };
    const state = initVizQueryState(spec.query);
    const next = reduceVizQuery(state, { type: "setStrip", strip: nextStrip });
    const args = composeFromState(next, null);
    expect(args.sort_order).toBe("desc");
    expect(args.types).toEqual(["task"]);
  });

  it("passes an onStripChange mock (integration shape)", () => {
    // Verify the component accepts the prop without throwing during static render
    const onStripChange = vi.fn();
    expect(() =>
      renderToStaticMarkup(
        <FilterStrip strip={baseStrip} onStripChange={onStripChange} />,
      ),
    ).not.toThrow();
    // onStripChange is not called on initial render (controlled component)
    expect(onStripChange).not.toHaveBeenCalled();
  });
});
