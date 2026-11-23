import React, { useRef } from "react";
import type { RefCandidate, SchemaField } from "@vault/query-core";
import { ReferenceAutocomplete } from "../ReferenceAutocomplete.js";
import { useDismissOnOutside } from "../use-dismiss-on-outside.js";

export interface ReferenceListCellEditorProps {
  /** The cell's links, as stored. */
  values: readonly string[];
  field: SchemaField;
  /** A change is in flight: further picks and removals are ignored. */
  busy?: boolean;
  onAdd: (candidate: RefCandidate) => void;
  onRemove: (storedValue: string) => void;
  onClose: () => void;
}

/**
 * ReferenceListCellEditor — the table editor for a list-of-references cell (#285).
 *
 * Shows each link as a chip with a remove button, plus a typeahead that adds one
 * more. Each pick or removal is its own one-member write, so editing one link can
 * never drop the others. Only existing notes can be added: a member edit names its
 * target by node id. The editor stays open between changes; Escape or a click
 * outside closes it.
 */
export function ReferenceListCellEditor({ values, field, busy = false, onAdd, onRemove, onClose }: ReferenceListCellEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(ref, true, onClose);

  return (
    <div className="ref-list-editor" ref={ref} aria-busy={busy || undefined}>
      {values.length > 0 && (
        <div className="ref-list-chips">
          {values.map((value, i) => (
            <span className="ref-list-chip" key={`${i}:${value}`}>
              <span className="ref-list-chip-label">{value}</span>
              <button
                type="button"
                className="ref-list-chip-x"
                aria-label={`Remove ${value}`}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!busy) onRemove(value);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Remounted when the list changes, so the box clears after each add. */}
      <ReferenceAutocomplete
        key={values.join("\u0000")}
        field={field}
        requireCandidate
        onPick={(result) => {
          if (result.kind === "candidate" && !busy) onAdd(result.candidate);
        }}
        onCancel={onClose}
      />
    </div>
  );
}
