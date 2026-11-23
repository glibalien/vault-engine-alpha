import { useRef, useState } from "react";
import type { Schema } from "@vault/query-core";
import { useDismissOnOutside } from "./use-dismiss-on-outside.js";
import { Icon } from "./icon.js";

/**
 * ColumnPicker — a popover button for selecting which schema fields appear as
 * columns/meta in the viz view.
 *
 * Renders a Bases-style "Properties" toolbar button. When open, shows one checkbox per schema
 * field. A field is checked when it appears in `displayFields`. Toggling a field
 * calls `onChange` with the updated list (added or removed immutably).
 *
 * Uses `useDismissOnOutside` to close the popover on outside click.
 */
export function ColumnPicker({
  schema,
  displayFields,
  onChange,
  open: openProp,
  onOpenChange,
}: {
  schema: Schema;
  displayFields: string[];
  onChange: (next: string[]) => void;
  /** Controlled open state (the toolbar opens it from its ⋯ menu). Omit for self-managed. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismissOnOutside(wrapRef, open, () => setOpen(false));

  function handleToggle(fieldName: string) {
    const checked = displayFields.includes(fieldName);
    const next = checked
      ? displayFields.filter((f) => f !== fieldName)
      : [...displayFields, fieldName];
    onChange(next);
  }

  return (
    <div className="col-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className="viz-tb-btn col-picker-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Properties"
        onClick={() => setOpen(!open)}
      >
        <Icon name="b-properties" />
        <span className="viz-tb-label">Properties</span>
      </button>
      {open && (
        <div className="col-picker-menu viz-pop" role="dialog" aria-label="Properties">
          {schema.fields.map((field) => {
            const checked = displayFields.includes(field.name);
            return (
              <label key={field.name} className="col-picker-row">
                <input
                  type="checkbox"
                  aria-label={field.name}
                  checked={checked}
                  onChange={() => handleToggle(field.name)}
                />
                {field.name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
