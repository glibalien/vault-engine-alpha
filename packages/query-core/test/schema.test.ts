import { describe, it, expect } from "vitest";
import {
  inferWidget,
  widgetForField,
  filterableFields,
  claimedFields,
  isReferenceField,
} from "../src/schema.js";
import type { SchemaField, Schema } from "../src/types.js";

function field(name: string, partial: Partial<SchemaField> & { type: SchemaField["type"] }): SchemaField {
  return {
    name,
    required: false,
    default_value: null,
    ui: null,
    ...partial,
  };
}

describe("inferWidget", () => {
  it("maps every (field_type, list_item_type) combination per the foundation table", () => {
    expect(inferWidget("string")).toBe("text");
    expect(inferWidget("enum")).toBe("enum");
    expect(inferWidget("number")).toBe("number");
    expect(inferWidget("date")).toBe("date");
    expect(inferWidget("boolean")).toBe("bool");
    expect(inferWidget("reference")).toBe("link");
    expect(inferWidget("list", "string")).toBe("tags");
    expect(inferWidget("list", "enum")).toBe("tags");
    expect(inferWidget("list", "reference")).toBe("link");
    expect(inferWidget("list", "number")).toBe("tags");
    expect(inferWidget("list", "date")).toBe("tags");
    expect(inferWidget("list", "boolean")).toBe("tags");
  });
});

describe("widgetForField", () => {
  it("respects an explicit widget override", () => {
    const f = field("notes", { type: "string", ui: { widget: "textarea" } });
    expect(widgetForField(f)).toBe("textarea");
  });

  it("falls back to inferred widget when ui or widget is missing", () => {
    expect(widgetForField(field("status", { type: "enum" }))).toBe("enum");
    expect(widgetForField(field("tags", { type: "list", list_item_type: "string", ui: {} }))).toBe("tags");
  });
});

describe("filterableFields", () => {
  it("excludes textarea fields", () => {
    const schema: Schema = {
      name: "task",
      display_name: null,
      fields: [
        field("status", { type: "enum" }),
        field("notes", { type: "string", ui: { widget: "textarea" } }),
        field("due", { type: "date" }),
      ],
    };
    expect(filterableFields(schema).map(f => f.name)).toEqual(["status", "due"]);
  });
});

describe("isReferenceField", () => {
  it("accepts single references", () => {
    expect(isReferenceField(field("owner", { type: "reference" }))).toBe(true);
  });

  it("accepts lists of references (e.g. task.project) so they get the typeahead editor", () => {
    expect(isReferenceField(field("project", { type: "list", list_item_type: "reference", reference_target: "project" }))).toBe(true);
  });

  it("rejects non-reference fields and non-reference lists", () => {
    expect(isReferenceField(field("status", { type: "enum" }))).toBe(false);
    expect(isReferenceField(field("tags", { type: "list", list_item_type: "string" }))).toBe(false);
  });
});

describe("claimedFields", () => {
  it("returns the schema's fields in declaration order", () => {
    const schema: Schema = {
      name: "task",
      display_name: null,
      fields: [field("status", { type: "enum" }), field("due", { type: "date" })],
    };
    expect(claimedFields(schema).map(f => f.name)).toEqual(["status", "due"]);
  });
});
