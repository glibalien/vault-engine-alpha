/**
 * Widget inference + helpers over describe-schema responses.
 *
 * The inference table is canonical — bundles MUST agree. See spec
 * docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md.
 */
import type { FieldType, Schema, SchemaField, WidgetValue } from "./types.js";

export function inferWidget(fieldType: FieldType, listItemType?: FieldType): WidgetValue {
  switch (fieldType) {
    case "string": return "text";
    case "enum": return "enum";
    case "number": return "number";
    case "date": return "date";
    case "boolean": return "bool";
    case "reference": return "link";
    case "list":
      if (listItemType === "reference") return "link";
      // string / enum / number / date / boolean → tags
      return "tags";
  }
}

export function widgetForField(field: SchemaField): WidgetValue {
  return field.ui?.widget ?? inferWidget(field.type, field.list_item_type);
}

/** True for fields whose values name other nodes — single references AND
 *  lists of references (task.project). A single reference gets the one-value
 *  typeahead editor; a list gets the table's list editor, which adds or removes
 *  one member at a time (update-node `reference_edit`). */
export function isReferenceField(field: SchemaField): boolean {
  return field.type === "reference" || isReferenceListField(field);
}

/** True for a list of references. A one-value write replaces the whole list, so a
 *  path that writes one value must not run on rows that may hold several (#285). */
export function isReferenceListField(field: SchemaField): boolean {
  return field.type === "list" && field.list_item_type === "reference";
}

export function claimedFields(schema: Schema): SchemaField[] {
  return schema.fields;
}

export function filterableFields(schema: Schema): SchemaField[] {
  return schema.fields.filter(f => widgetForField(f) !== "textarea");
}
