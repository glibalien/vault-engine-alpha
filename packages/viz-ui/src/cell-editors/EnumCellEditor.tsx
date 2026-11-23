import React, { useEffect, useRef, useState } from "react";
import type { CellEditorProps } from "./types.js";

function enumSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * EnumCellEditor — renders a popover list of the field's enum_values + a Clear row.
 * ArrowUp/Down navigate, Enter→submit selected, Escape→cancel.
 * Clicking an option directly submits it.
 */
export function EnumCellEditor({ initial, field, onSubmit, onCancel }: CellEditorProps) {
  const options = field.enum_values ?? [];
  const currentStr = initial == null ? "" : String(initial);
  const initialIndex = options.indexOf(currentStr);
  const [activeIdx, setActiveIdx] = useState(initialIndex >= 0 ? initialIndex : 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Total navigable rows: enum values + the "Clear value" row at index options.length
  const totalRows = options.length + 1;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(totalRows - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx === options.length) {
        // Clear row selected
        onSubmit(null, { via: "enter" });
      } else {
        const opt = options[activeIdx];
        if (opt != null) onSubmit(opt, { via: "enter" });
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      ref={listRef}
      className="cell-popover"
      role="listbox"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {options.map((opt, i) => (
        <div
          key={opt}
          className="opt"
          role="option"
          aria-selected={i === activeIdx}
          data-active={i === activeIdx ? "true" : "false"}
          onMouseEnter={() => setActiveIdx(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSubmit(opt);
          }}
        >
          <span className="cell-enum" data-v={enumSlug(opt)}>
            {opt}
          </span>
        </div>
      ))}
      <div
        className="new"
        data-active={activeIdx === options.length ? "true" : "false"}
        onMouseEnter={() => setActiveIdx(options.length)}
        onMouseDown={(e) => {
          e.preventDefault();
          onSubmit(null);
        }}
      >
        Clear value
      </div>
    </div>
  );
}
