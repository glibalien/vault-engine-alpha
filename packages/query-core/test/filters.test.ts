import { describe, it, expect } from "vitest";
import { initialFilterState, buildFieldFilters, parseFieldFilters, parseJoinFilters, parseFieldFilterOps } from "../src/filters.js";
import type { Schema, SchemaField, FilterChip } from "../src/types.js";

function field(name: string, p: Partial<SchemaField> & { type: SchemaField["type"] }): SchemaField {
  return { name, required: false, default_value: null, ui: null, ...p };
}
const schema: Schema = {
  name: "task", display_name: null,
  fields: [
    field("status", { type: "enum", enum_values: ["open", "done"] }),
    field("due", { type: "date" }),
    field("estimate", { type: "number" }),
    field("done", { type: "boolean" }),
    field("assignee", { type: "reference", reference_target: "person" }),
    field("location", { type: "string" }),
    field("tags", { type: "list", list_item_type: "string" }),
    field("project", { type: "reference", reference_target: "project" }),
  ],
};

describe("initialFilterState", () => {
  it("seeds an empty state per widget", () => {
    expect(initialFilterState(field("s", { type: "enum" }))).toEqual({ one_of: [] });
    expect(initialFilterState(field("b", { type: "boolean" }))).toEqual({ eq: null });
    expect(initialFilterState(field("r", { type: "reference" }))).toEqual({ exists: null, target: null });
    expect(initialFilterState(field("n", { type: "number" }))).toEqual({ min: "", max: "" });
    expect(initialFilterState(field("d", { type: "date" }))).toEqual({ gte: "", lte: "" });
    expect(initialFilterState(field("t", { type: "string" }))).toEqual({ contains: "" });
  });
});

describe("buildFieldFilters", () => {
  const build = (chips: FilterChip[]) => buildFieldFilters(chips, schema);

  it("returns { fields: {}, join_filters: [] } when no chips are active", () => {
    expect(build([])).toEqual({ fields: {}, join_filters: [] });
  });
  it("enum → one_of", () => {
    expect(build([{ field: "status", state: { one_of: ["open"] } }]))
      .toEqual({ fields: { status: { one_of: ["open"] } }, join_filters: [] });
  });
  it("empty enum selection contributes nothing", () => {
    expect(build([{ field: "status", state: { one_of: [] } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("boolean eq true/false, null omitted", () => {
    expect(build([{ field: "done", state: { eq: true } }])).toEqual({ fields: { done: { eq: true } }, join_filters: [] });
    expect(build([{ field: "done", state: { eq: false } }])).toEqual({ fields: { done: { eq: false } }, join_filters: [] });
    expect(build([{ field: "done", state: { eq: null } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("reference exists set/empty, null omitted", () => {
    expect(build([{ field: "assignee", state: { exists: true, target: null } }])).toEqual({ fields: { assignee: { exists: true } }, join_filters: [] });
    expect(build([{ field: "assignee", state: { exists: false, target: null } }])).toEqual({ fields: { assignee: { exists: false } }, join_filters: [] });
    expect(build([{ field: "assignee", state: { exists: null, target: null } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("number min/max → gte/lte; blanks omitted; coerced to numbers", () => {
    expect(build([{ field: "estimate", state: { min: "2", max: "8" } }]))
      .toEqual({ fields: { estimate: { gte: 2, lte: 8 } }, join_filters: [] });
    expect(build([{ field: "estimate", state: { min: "", max: "5" } }]))
      .toEqual({ fields: { estimate: { lte: 5 } }, join_filters: [] });
    expect(build([{ field: "estimate", state: { min: "", max: "" } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("date from/to → gte/lte; blanks omitted", () => {
    expect(build([{ field: "due", state: { gte: "2026-01-01", lte: "" } }]))
      .toEqual({ fields: { due: { gte: "2026-01-01" } }, join_filters: [] });
    expect(build([{ field: "due", state: { gte: "", lte: "" } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("text contains; blank omitted", () => {
    expect(build([{ field: "location", state: { contains: "zoom" } }]))
      .toEqual({ fields: { location: { contains: "zoom" } }, join_filters: [] });
    expect(build([{ field: "location", state: { contains: "" } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("tags includes (single value); blank omitted", () => {
    expect(build([{ field: "tags", state: { value: "urgent" } }]))
      .toEqual({ fields: { tags: { includes: "urgent" } }, join_filters: [] });
    expect(build([{ field: "tags", state: { value: "" } }])).toEqual({ fields: {}, join_filters: [] });
  });
  it("merges multiple active chips", () => {
    expect(build([
      { field: "status", state: { one_of: ["open"] } },
      { field: "done", state: { eq: false } },
    ])).toEqual({ fields: { status: { one_of: ["open"] }, done: { eq: false } }, join_filters: [] });
  });
  it("link chip with a target builds an identity join filter", () => {
    const chips: FilterChip[] = [{ field: "project", state: { exists: null, target: { id: "n1", title: "Vault Engine" } } }];
    expect(buildFieldFilters(chips, schema)).toEqual({
      fields: {},
      join_filters: [{ rel_type: "project", target: { node_ids: ["n1"] } }],
    });
  });
  it("link chip exists and target are mutually exclusive (target wins only when exists is null)", () => {
    const chips: FilterChip[] = [{ field: "project", state: { exists: true, target: null } }];
    expect(buildFieldFilters(chips, schema)).toEqual({
      fields: { project: { exists: true } },
      join_filters: [],
    });
  });
});

describe("parseFieldFilters (incoming args → chips)", () => {
  const parse = (fields: unknown) => parseFieldFilters(fields, schema);

  it("returns [] for missing/empty fields", () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse({})).toEqual([]);
  });
  it("maps an enum eq (the caller's shape) to a one_of chip", () => {
    // Real caller case: { status: { eq: "in-progress" } } on an enum field.
    expect(parse({ status: { eq: "open" } })).toEqual([{ field: "status", state: { one_of: ["open"] } }]);
  });
  it("maps an enum one_of straight through", () => {
    expect(parse({ status: { one_of: ["open", "done"] } })).toEqual([{ field: "status", state: { one_of: ["open", "done"] } }]);
  });
  it("maps boolean eq, reference exists, number/date ranges, text contains, tags includes", () => {
    expect(parse({ done: { eq: true } })).toEqual([{ field: "done", state: { eq: true } }]);
    expect(parse({ assignee: { exists: false } })).toEqual([{ field: "assignee", state: { exists: false, target: null } }]);
    expect(parse({ estimate: { gte: 2, lte: 8 } })).toEqual([{ field: "estimate", state: { min: "2", max: "8" } }]);
    expect(parse({ due: { gte: "2026-01-01" } })).toEqual([{ field: "due", state: { gte: "2026-01-01", lte: "" } }]);
    expect(parse({ location: { contains: "zoom" } })).toEqual([{ field: "location", state: { contains: "zoom" } }]);
    expect(parse({ tags: { includes: "urgent" } })).toEqual([{ field: "tags", state: { value: "urgent" } }]);
  });
  it("ignores fields not in the schema", () => {
    expect(parse({ nonesuch: { eq: "x" } })).toEqual([]);
  });
  it("round-trips through buildFieldFilters for representable filters", () => {
    const chips = parse({ status: { one_of: ["open"] }, done: { eq: false } });
    expect(buildFieldFilters(chips, schema)).toEqual({ fields: { status: { one_of: ["open"] }, done: { eq: false } }, join_filters: [] });
  });
});

describe("parseJoinFilters", () => {
  it("seeds a link chip from a chip-shaped join entry; foreign entries pass through", () => {
    const joins = [
      { rel_type: "project", target: { node_ids: ["n1"] } },               // chip-shaped (link field)
      { rel_type: "status", target: { node_ids: ["n2"] } },                // not a link field → foreign
      { rel_type: "project", target: { node_ids: ["n1", "n2"] } },         // multi-id → foreign
      { rel_type: "project", direction: "incoming", target: { node_ids: ["n3"] } }, // incoming → foreign
      { rel_type: "project", target: { types: ["project"] } },             // pattern join → foreign
    ];
    const { chips, foreign } = parseJoinFilters(joins, schema);
    expect(chips).toEqual([{ field: "project", state: { exists: null, target: { id: "n1", title: null } } }]);
    expect(foreign).toHaveLength(4);
  });

  it("tolerates absent/garbage input", () => {
    expect(parseJoinFilters(undefined, schema)).toEqual({ chips: [], foreign: [] });
    expect(parseJoinFilters("nope", schema)).toEqual({ chips: [], foreign: [] });
  });
});

describe("parseFieldFilterOps", () => {
  it("enum: one_of consumed; other ops left", () => {
    expect(parseFieldFilterOps(field("status", { type: "enum" }), { one_of: ["a"], ne: "b" }))
      .toEqual({ state: { one_of: ["a"] }, consumed: ["one_of"] });
  });
  it("enum: eq fallback maps to one_of", () => {
    expect(parseFieldFilterOps(field("status", { type: "enum" }), { eq: "a" }))
      .toEqual({ state: { one_of: ["a"] }, consumed: ["eq"] });
  });
  it("bool: eq consumed only when boolean", () => {
    expect(parseFieldFilterOps(field("done", { type: "boolean" }), { eq: true }))
      .toEqual({ state: { eq: true }, consumed: ["eq"] });
    expect(parseFieldFilterOps(field("done", { type: "boolean" }), { eq: "yes" })).toBeNull();
  });
  it("link: exists consumed", () => {
    expect(parseFieldFilterOps(field("assignee", { type: "reference" }), { exists: true }))
      .toEqual({ state: { exists: true, target: null }, consumed: ["exists"] });
  });
  it("number: gte/lte → min/max strings; consumes only present ops", () => {
    expect(parseFieldFilterOps(field("estimate", { type: "number" }), { gte: 2 }))
      .toEqual({ state: { min: "2", max: "" }, consumed: ["gte"] });
    expect(parseFieldFilterOps(field("estimate", { type: "number" }), { gte: 2, lte: 8, ne: 5 }))
      .toEqual({ state: { min: "2", max: "8" }, consumed: ["gte", "lte"] });
  });
  it("date: gte/lte passthrough as strings", () => {
    expect(parseFieldFilterOps(field("due", { type: "date" }), { lte: "2026-01-01" }))
      .toEqual({ state: { gte: "", lte: "2026-01-01" }, consumed: ["lte"] });
  });
  it("tags: includes consumed", () => {
    expect(parseFieldFilterOps(field("tags", { type: "list", list_item_type: "string" }), { includes: "x" }))
      .toEqual({ state: { value: "x" }, consumed: ["includes"] });
  });
  it("text: contains, with eq fallback", () => {
    expect(parseFieldFilterOps(field("location", { type: "string" }), { contains: "zoom" }))
      .toEqual({ state: { contains: "zoom" }, consumed: ["contains"] });
    expect(parseFieldFilterOps(field("location", { type: "string" }), { eq: "zoom" }))
      .toEqual({ state: { contains: "zoom" }, consumed: ["eq"] });
  });
  it("returns null when no expressible op is present", () => {
    expect(parseFieldFilterOps(field("location", { type: "string" }), { ne: "x" })).toBeNull();
    expect(parseFieldFilterOps(field("estimate", { type: "number" }), {})).toBeNull();
  });
  it("empty-string gte/lte is NOT chip-expressible (stays a caller fragment)", () => {
    expect(parseFieldFilterOps(field("estimate", { type: "number" }), { gte: "" })).toBeNull();
    expect(parseFieldFilterOps(field("due", { type: "date" }), { gte: "", lte: "" })).toBeNull();
    // mixed: the real op consumes, the empty one is left for the remainder
    expect(parseFieldFilterOps(field("estimate", { type: "number" }), { gte: "", lte: 5 }))
      .toEqual({ state: { min: "", max: "5" }, consumed: ["lte"] });
    expect(parseFieldFilterOps(field("estimate", { type: "number" }), { gte: 0 }))
      .toEqual({ state: { min: "0", max: "" }, consumed: ["gte"] });
  });
});
