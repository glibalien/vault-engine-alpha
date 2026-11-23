import React, { useEffect, useRef, useState } from "react";
import type { CellEditorProps } from "./types.js";

function toStr(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

type Mode = "picker" | "nl";

/**
 * DateCellEditor — picker mode (<input type="date">) with a toggle to NL-text mode.
 * Enter→submit (engine accepts fuzzy dates), Escape→cancel.
 *
 * Value-preservation on toggle: switching picker→NL seeds the NL input with the
 * picker's current value; switching NL→picker seeds the picker with the NL text
 * (date inputs silently ignore values that aren't valid YYYY-MM-DD, which is fine —
 * the NL value survives in nlVal and is submitted if the picker value stays empty).
 */
export function DateCellEditor({ initial, field: _field, onSubmit, onCancel }: CellEditorProps) {
  const raw = toStr(initial);
  const withTime = raw.includes("T");
  const pickerValue = raw ? raw.slice(0, withTime ? 16 : 10) : "";

  const [mode, setMode] = useState<Mode>("picker");
  const [pickerVal, setPickerVal] = useState(pickerValue);
  const [nlVal, setNlVal] = useState("");
  const pickerRef = useRef<HTMLInputElement>(null);
  const nlRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  // Autofocus whichever input is active
  useEffect(() => {
    if (mode === "picker") {
      pickerRef.current?.focus();
    } else {
      nlRef.current?.focus();
    }
  }, [mode]);

  const submit = (v: string, via?: "enter") => {
    if (done.current) return;
    done.current = true;
    // Only pass meta when there is intent to report — every pre-existing
    // caller (blur, ✓, Tab-on-a-real-row) keeps its exact one-argument shape.
    if (via) onSubmit(v, { via }); else onSubmit(v);
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const handlePickerKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); submit(pickerVal, "enter"); }
  };

  const handleNlKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); submit(nlVal, "enter"); }
  };

  const toggleMode = (e: React.MouseEvent) => {
    e.preventDefault();
    setMode((m) => {
      if (m === "picker") {
        // picker → NL: carry picker value into NL input so it's not lost
        setNlVal((prev) => prev || pickerVal);
        return "nl";
      } else {
        // NL → picker: carry NL text into picker; date inputs silently ignore
        // non-YYYY-MM-DD values, but nlVal is still preserved in state for blur fallback
        setPickerVal((prev) => prev || nlVal);
        return "picker";
      }
    });
  };

  return (
    <span className="cell-edit-wrap">
      <span className="cell-edit-date-input">
        {mode === "picker" ? (
          <input
            ref={pickerRef}
            className="cell-input"
            type={withTime ? "datetime-local" : "date"}
            value={pickerVal}
            onChange={(e) => setPickerVal(e.target.value)}
            onKeyDown={handlePickerKey}
            onBlur={() => submit(pickerVal)}
          />
        ) : (
          <input
            ref={nlRef}
            className="cell-input"
            type="text"
            placeholder="e.g. next friday"
            value={nlVal}
            onChange={(e) => setNlVal(e.target.value)}
            onKeyDown={handleNlKey}
            onBlur={() => submit(nlVal)}
          />
        )}
      </span>
      <div className="cell-popover">
        <div className="opt" onMouseDown={toggleMode}>
          {mode === "nl" ? "◷ Use date picker" : "✎ Type natural language"}
        </div>
      </div>
    </span>
  );
}
