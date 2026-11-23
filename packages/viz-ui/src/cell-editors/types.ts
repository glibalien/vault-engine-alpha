import type { SchemaField } from "@vault/query-core";

/**
 * CellEditorProps — shared interface implemented by all per-widget cell editors.
 * Single canonical definition; imported by all editor files.
 */
export interface CellEditorProps {
  initial: unknown;
  field: SchemaField;
  schema?: unknown;
  /**
   * The value is final for this cell. `meta.via === "enter"` marks a deliberate
   * Enter keypress, as opposed to a mouse pick, a blur or a Tab — the draft row
   * treats Enter as "make this row" wherever it is pressed, while a pick only
   * stages. Real rows commit either way, so they can ignore `meta`.
   */
  onSubmit: (raw: unknown, meta?: { via?: "enter" }) => void;
  onCancel: () => void;
  /**
   * Stage the value WITHOUT committing it, when the host cell supports staging.
   * Only the draft row does: its cells live in local draft state until the single
   * create goes out. Editors use it for Tab, so Tab-ing through the draft row can
   * never create the node (design Part B: "Tab never creates"). Absent for real
   * rows — there Tab keeps committing, which is long-standing behavior.
   */
  onStage?: (raw: unknown) => void;
}
