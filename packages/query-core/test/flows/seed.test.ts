import { describe, it, expect } from "vitest";
import { seedFieldsFromFilters } from "../../src/flows/seed.js";
import type { Schema, FilterChip, CallerFragment } from "../../src/types.js";

const schema: Schema = {
  name: "task",
  display_name: null,
  fields: [
    { name: "project", type: "list", required: false, default_value: null, reference_target: "project", list_item_type: "reference", ui: null },
    { name: "status", type: "enum", required: false, default_value: "open", enum_values: ["open", "done", "next"], ui: null },
    { name: "blocked", type: "boolean", required: false, default_value: null, ui: null },
    { name: "estimate", type: "number", required: false, default_value: null, ui: null },
    { name: "labels", type: "list", required: false, default_value: null, list_item_type: "string", ui: null },
  ],
};

const chip = (field: string, state: Record<string, unknown>): FilterChip => ({ field, state });
const frag = (payload: unknown): CallerFragment => ({ id: 0, key: "references", payload, scope: "global" });

describe("seedFieldsFromFilters — link chips", () => {
  it("seeds a reference field with the pinned target's title", () => {
    const chips = [chip("project", { exists: null, target: { id: "p1", title: "AskAcme Phase 2 Rollout" } })];
    expect(seedFieldsFromFilters(schema, chips, [])).toEqual({ project: "AskAcme Phase 2 Rollout" });
  });
  it("skips an exists:false link chip (wants the field empty)", () => {
    expect(seedFieldsFromFilters(schema, [chip("project", { exists: false, target: null })], [])).toEqual({});
  });
  it("skips an exists:true link chip (no specific target)", () => {
    expect(seedFieldsFromFilters(schema, [chip("project", { exists: true, target: null })], [])).toEqual({});
  });
  it("skips a link chip whose target title is not yet hydrated", () => {
    expect(seedFieldsFromFilters(schema, [chip("project", { exists: null, target: { id: "p1", title: null } })], [])).toEqual({});
  });
});

describe("seedFieldsFromFilters — enum / bool chips", () => {
  it("seeds a single-value enum chip", () => {
    expect(seedFieldsFromFilters(schema, [chip("status", { one_of: ["done"] })], [])).toEqual({ status: "done" });
  });
  it("seeds the first value of a multi-value enum chip (still satisfies one_of)", () => {
    expect(seedFieldsFromFilters(schema, [chip("status", { one_of: ["open", "done"] })], [])).toEqual({ status: "open" });
  });
  it("skips an empty enum chip", () => {
    expect(seedFieldsFromFilters(schema, [chip("status", { one_of: [] })], [])).toEqual({});
  });
  it("seeds a bool chip (true and false)", () => {
    expect(seedFieldsFromFilters(schema, [chip("blocked", { eq: true })], [])).toEqual({ blocked: true });
    expect(seedFieldsFromFilters(schema, [chip("blocked", { eq: false })], [])).toEqual({ blocked: false });
  });
  it("skips an unset bool chip and a number chip", () => {
    expect(seedFieldsFromFilters(schema, [chip("blocked", { eq: null })], [])).toEqual({});
    expect(seedFieldsFromFilters(schema, [chip("estimate", { min: "1", max: "5" })], [])).toEqual({});
  });
  it("skips a chip whose field is not on the schema", () => {
    expect(seedFieldsFromFilters(schema, [chip("nope", { one_of: ["x"] })], [])).toEqual({});
  });
});

describe("seedFieldsFromFilters — tags chips", () => {
  it("seeds a tags 'has' chip value as a single-element list", () => {
    expect(seedFieldsFromFilters(schema, [chip("labels", { value: "urgent" })], [])).toEqual({ labels: ["urgent"] });
  });
  it("skips an empty tags chip", () => {
    expect(seedFieldsFromFilters(schema, [chip("labels", { value: "" })], [])).toEqual({});
  });
});

describe("seedFieldsFromFilters — references fragments", () => {
  it("seeds an outgoing references fragment onto its rel_type field", () => {
    expect(seedFieldsFromFilters(schema, [], [frag({ target: "AskAcme Phase 2 Rollout", rel_type: "project" })]))
      .toEqual({ project: "AskAcme Phase 2 Rollout" });
  });
  it("skips an incoming references fragment", () => {
    expect(seedFieldsFromFilters(schema, [], [frag({ target: "X", rel_type: "project", direction: "incoming" })])).toEqual({});
  });
  it("skips a references fragment with an empty target", () => {
    expect(seedFieldsFromFilters(schema, [], [frag({ target: "", rel_type: "project" })])).toEqual({});
  });
  it("skips a references fragment whose rel_type is not a link-widget field", () => {
    expect(seedFieldsFromFilters(schema, [], [frag({ target: "done", rel_type: "status" })])).toEqual({});
  });
  it("skips a references fragment whose rel_type is not on the schema", () => {
    expect(seedFieldsFromFilters(schema, [], [frag({ target: "X", rel_type: "nope" })])).toEqual({});
  });
  it("lets a chip win a conflict with a references fragment on the same field", () => {
    const chips = [chip("project", { exists: null, target: { id: "p1", title: "From Chip" } })];
    const frags = [frag({ target: "From Fragment", rel_type: "project" })];
    expect(seedFieldsFromFilters(schema, chips, frags)).toEqual({ project: "From Chip" });
  });
});
