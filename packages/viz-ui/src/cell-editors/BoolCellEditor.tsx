import React from "react";
import type { CellEditorProps } from "./types.js";

/**
 * BoolCellEditor — a segmented true/false/clear (null) control.
 * Submits on click. No keyboard navigation needed beyond the click interaction.
 */
export function BoolCellEditor({ initial: _initial, onSubmit }: CellEditorProps) {
  return (
    <div className="cell-bool-seg">
      <button
        className="cell-bool-opt"
        onClick={() => onSubmit(true)}
      >
        true
      </button>
      <button
        className="cell-bool-opt"
        onClick={() => onSubmit(false)}
      >
        false
      </button>
      <button
        className="cell-bool-opt cell-bool-clear"
        onClick={() => onSubmit(null)}
      >
        clear
      </button>
    </div>
  );
}
