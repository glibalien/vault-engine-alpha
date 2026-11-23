import React from "react";
import { ReferenceAutocomplete } from "../ReferenceAutocomplete.js";
import type { PickResult } from "../ReferenceAutocomplete.js";
import type { CellEditorProps } from "./types.js";

/**
 * ReferenceCellEditor — wraps ReferenceAutocomplete as a standard CellEditor.
 *
 * onPick(candidate) → onSubmit(candidate.title)
 * onPick(unresolved) → onSubmit(text)
 * Escape → onCancel
 *
 * The picked title string flows through the existing useVizCellEdit.submitEdit →
 * update-node path. The engine coerces the title string to a reference link.
 * NO new commit path is introduced here.
 */
export function ReferenceCellEditor({ initial, field, onSubmit, onCancel }: CellEditorProps) {
  const handlePick = (result: PickResult) => {
    if (result.kind === "candidate") {
      onSubmit(result.candidate.title);
    } else {
      onSubmit(result.text);
    }
  };

  const initialStr = initial == null ? "" : String(initial);

  return (
    <ReferenceAutocomplete
      field={field}
      initial={initialStr}
      onPick={handlePick}
      onCancel={onCancel}
    />
  );
}
