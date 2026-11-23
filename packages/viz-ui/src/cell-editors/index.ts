/**
 * Per-widget inline cell editors for the viz table.
 *
 * Each editor: ({ initial, field, schema?, onSubmit, onCancel })
 * where onSubmit(raw: unknown) / onCancel().
 *
 * cellEditorFor(widget) dispatches to the correct editor component.
 */
export { TextCellEditor } from "./TextCellEditor.js";
export { EnumCellEditor } from "./EnumCellEditor.js";
export { DateCellEditor } from "./DateCellEditor.js";
export { BoolCellEditor } from "./BoolCellEditor.js";
export { ReferenceCellEditor } from "./ReferenceCellEditor.js";
export { ReferenceListCellEditor } from "./ReferenceListCellEditor.js";
export type { ReferenceListCellEditorProps } from "./ReferenceListCellEditor.js";
// CellEditorProps: canonical definition in types.ts; re-exported here for convenience.
export type { CellEditorProps } from "./types.js";

import { TextCellEditor } from "./TextCellEditor.js";
import { EnumCellEditor } from "./EnumCellEditor.js";
import { DateCellEditor } from "./DateCellEditor.js";
import { BoolCellEditor } from "./BoolCellEditor.js";
import { ReferenceCellEditor } from "./ReferenceCellEditor.js";
import type { WidgetValue } from "@vault/query-core";
import type { CellEditorProps } from "./types.js";
import type { ComponentType } from "react";

/**
 * Returns the editor component for a given widget value.
 */
export function cellEditorFor(widget: WidgetValue | string): ComponentType<CellEditorProps> {
  switch (widget) {
    case "enum":
      return EnumCellEditor;
    case "date":
      return DateCellEditor;
    case "bool":
      return BoolCellEditor;
    case "link":
      return ReferenceCellEditor;
    case "text":
    case "number":
    case "textarea":
    case "tags":
    default:
      return TextCellEditor;
  }
}
