import React, { useEffect, useRef, useState } from "react";
import { widgetForField } from "@vault/query-core";
import type { CellEditorProps } from "./types.js";

export type { CellEditorProps } from "./types.js";

function toStr(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/**
 * TextCellEditor — handles text / number / textarea widgets.
 * Controlled <input> or <textarea>; Enter→submit, Escape→cancel, Tab→submit, blur→submit.
 * Tab→STAGE instead when the host cell can stage (`onStage`, i.e. the draft row),
 * so Tab-ing out of the draft's title moves on without creating the node.
 * Also renders ✓/✗ buttons for environments where keydown is unreliable (e.g. Obsidian).
 * Autofocuses + selects-all on mount.
 */
export function TextCellEditor({ initial, field, onSubmit, onCancel, onStage }: CellEditorProps) {
  const widget = widgetForField(field);
  const isArea = widget === "textarea";
  const isNumber = widget === "number";

  const [value, setValue] = useState(() => toStr(initial));
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

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

  // Tab in a staging cell (the draft row): hand the value over WITHOUT committing.
  // `done` is set because this editor is finished — the keydown then bubbles to the
  // <td>, whose Tab handler opens the next cell and unmounts us. Leaving `done`
  // false would let a blur-on-unmount submit, i.e. create the node after all.
  const stage = (v: string) => {
    if (done.current || !onStage) return;
    done.current = true;
    onStage(v);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && !isArea) {
      e.preventDefault();
      e.stopPropagation();
      submit(value, "enter");
    } else if (e.key === "Enter" && isArea && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      submit(value, "enter");
    } else if (e.key === "Tab") {
      // Deliberately NOT stopPropagation: the <td>'s Tab handler moves to the next
      // cell. Staging cells (the draft row) must not commit here — that would create
      // the node mid-navigation and drop everything typed into later cells.
      e.preventDefault();
      if (onStage) stage(value);
      else submit(value);
    }
  };

  const handleBlur = () => {
    submit(value);
  };

  const handleCommitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); // keep focus on input so blur doesn't fire before done.current is set
    submit(value);
  };

  const handleCancelMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    cancel();
  };

  const commonProps = {
    className: `cell-input${isArea ? " area" : ""}${isNumber ? " num" : ""}`,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(e.target.value),
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
  };

  const commitBtn = (
    <button
      type="button"
      className="cell-commit"
      aria-label="commit edit"
      onMouseDown={handleCommitMouseDown}
    >
      ✓
    </button>
  );

  const cancelBtn = (
    <button
      type="button"
      className="cell-cancel"
      aria-label="cancel edit"
      onMouseDown={handleCancelMouseDown}
    >
      ✗
    </button>
  );

  if (isArea) {
    return (
      <span className="cell-edit-wrap cell-edit-wrap--area">
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          {...commonProps}
        />
        <span className="cell-edit-actions">
          {commitBtn}
          {cancelBtn}
        </span>
      </span>
    );
  }

  return (
    <span className="cell-edit-wrap">
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        type="text"
        inputMode={isNumber ? "decimal" : undefined}
        {...commonProps}
      />
      {commitBtn}
      {cancelBtn}
    </span>
  );
}
