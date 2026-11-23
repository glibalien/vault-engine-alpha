/**
 * BulkBar — presentational React component for the bulk-mutate bar.
 *
 * Renders all VizBulkAPI states:
 *  - selection count + Clear
 *  - op pickers (Set field… / Add type… / Remove type…)
 *  - field menu (picking === "field") → calls setPlanField
 *  - value editor (picking === "value") → cellEditorFor(widgetForField)
 *  - type input (picking === "addType" | "removeType") → calls setPlanType
 *  - link pickers (#285): list-of-references field menu (picking === "linkField"), then a
 *    typeahead for an existing note (picking === "linkTarget") → setLinkField / setLinkTarget
 *  - plan summary + Apply button → runDry()
 *  - pending: "N row(s) would change" + skippedNoVersion + warnings + Confirm/Cancel
 *  - failed: failure banner + Dismiss
 *  - outcome: transient "N applied, M skipped (changed elsewhere)" banner
 *  - busy: Working… indicator
 */
import React, { useState, useRef } from "react";
import { isLinkPlan, type VizBulkAPI } from "./use-viz-bulk.js";
import { ReferenceAutocomplete } from "./ReferenceAutocomplete.js";
import type { Schema, SchemaField } from "@vault/query-core";
import { isReferenceListField, widgetForField } from "@vault/query-core";
import { cellEditorFor } from "./cell-editors/index.js";

export interface BulkBarProps {
  bulk: VizBulkAPI;
  schema: Schema | null;
}

// ── Plan label helper (mirrors engine's bulk-bar.ts planLabel) ────────────────

function planLabel(plan: VizBulkAPI["plan"]): string | null {
  if (!plan) return null;
  if (isLinkPlan(plan)) {
    const title = plan.target?.title ?? "…";
    return plan.kind === "addLink" ? `${plan.field} + ${title}` : `${plan.field} − ${title}`;
  }
  if (plan.kind === "setField") {
    const val = plan.value === "" || plan.value == null ? "—" : String(plan.value);
    return `${plan.field} → ${val}`;
  }
  return plan.kind === "addType" ? `+ type ${plan.type}` : `− type ${plan.type}`;
}

// ── TypeInput — controlled input for add/remove-type ─────────────────────────

function TypeInput({ onSubmit, onCancel }: { onSubmit: (type: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const done = useRef(false);

  const submit = (v: string) => {
    if (done.current) return;
    done.current = true;
    onSubmit(v.trim());
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <input
      className="bulk-type-input"
      type="text"
      placeholder="type name…"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim()) submit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={() => {
        if (value.trim()) submit(value);
        else cancel();
      }}
    />
  );
}

// ── BulkBar ───────────────────────────────────────────────────────────────────

export function BulkBar({ bulk, schema }: BulkBarProps) {
  const { selectedCount, plan, picking, pending, failed, outcome, busy } = bulk;

  // ── Busy ──
  if (busy) {
    return (
      <div className="bulk-bar">
        <span className="bulk-count">{selectedCount} selected</span>
        <span className="bulk-busy">Working…</span>
      </div>
    );
  }

  // ── Failed ──
  if (failed) {
    return (
      <div className="bulk-bar">
        <span className="bulk-count">{selectedCount} selected</span>
        <span className="bulk-failed-msg">
          Batch failed — nothing was changed. {failed.message}
        </span>
        <button
          className="bulk-btn"
          onClick={() => bulk.cancel()}
        >
          Dismiss
        </button>
      </div>
    );
  }

  // ── Pending ──
  if (pending) {
    return (
      <div className="bulk-bar">
        <span className="bulk-count">{selectedCount} selected</span>
        {plan && <span className="bulk-summary">{planLabel(plan)}</span>}
        <span className="bulk-would">{pending.wouldApply} row(s) would change</span>
        {pending.unchanged != null && pending.unchanged > 0 && (
          <span className="bulk-skipped">
            {pending.unchanged} {plan?.kind === "removeLink" ? "don't have that link" : "already have that link"}
          </span>
        )}
        {pending.skippedNoVersion != null && pending.skippedNoVersion > 0 && (
          <span className="bulk-skipped">
            {pending.skippedNoVersion} skipped (no version)
          </span>
        )}
        {pending.warnings.map((w, i) => (
          <span key={i} className="bulk-warn">{w.code}: {w.message}</span>
        ))}
        <button
          className="bulk-btn confirm"
          onClick={() => bulk.confirm()}
        >
          ✓ Confirm
        </button>
        <button
          className="bulk-btn"
          onClick={() => bulk.cancel()}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ── Value editor for set-field ──
  const isPickingValue = picking === "value" && plan?.kind === "setField";
  const fieldForValue: SchemaField | undefined = isPickingValue
    ? schema?.fields.find((f) => f.name === (plan as { kind: "setField"; field: string; value: unknown }).field)
    : undefined;

  const linkFields = schema?.fields.filter(isReferenceListField) ?? [];
  const linkField = isLinkPlan(plan) ? linkFields.find((f) => f.name === plan.field) : undefined;

  return (
    <div className="bulk-bar">
      <span className="bulk-count">{selectedCount} selected</span>

      {/* Outcome banner (transient, shown alongside the reset bar) */}
      {outcome && (
        <span className="bulk-outcome">
          {outcome.applied} applied
          {outcome.stale > 0 && (
            <>, {outcome.stale} skipped (changed elsewhere)</>
          )}
          {outcome.unchanged != null && outcome.unchanged > 0 && <>, {outcome.unchanged} unchanged</>}
          {outcome.failed != null && outcome.failed > 0 && <>, {outcome.failed} failed</>}
          {outcome.uncertain != null && outcome.uncertain > 0 && (
            <>, {outcome.uncertain} uncertain (the request failed{outcome.error ? `: ${outcome.error}` : ""})</>
          )}
          {outcome.notAttempted != null && outcome.notAttempted > 0 && <>, {outcome.notAttempted} not attempted</>}
        </span>
      )}

      {/* Op buttons */}
      <button
        className={"bulk-btn" + (plan?.kind === "setField" ? " on" : "")}
        onClick={() => bulk.pick("setField")}
      >
        Set field…
      </button>
      <button
        className={"bulk-btn" + (plan?.kind === "addType" ? " on" : "")}
        onClick={() => bulk.pick("addType")}
      >
        Add type…
      </button>
      <button
        className={"bulk-btn" + (plan?.kind === "removeType" ? " on" : "")}
        onClick={() => bulk.pick("removeType")}
      >
        Remove type…
      </button>
      {/* One link at a time, so no row loses its other links (#285). */}
      {linkFields.length > 0 && (
        <>
          <button
            className={"bulk-btn" + (plan?.kind === "addLink" ? " on" : "")}
            onClick={() => bulk.pick("addLink")}
          >
            Add link…
          </button>
          <button
            className={"bulk-btn" + (plan?.kind === "removeLink" ? " on" : "")}
            onClick={() => bulk.pick("removeLink")}
          >
            Remove link…
          </button>
        </>
      )}

      {/* Field picker menu */}
      {picking === "field" && schema && (
        <div className="cell-popover bulk-menu" role="menu">
          {/* Setting one link would replace each selected row's whole list (#285): lists use Add link / Remove link. */}
          {schema.fields.filter((f) => !isReferenceListField(f)).map((f) => (
            <div
              key={f.name}
              className="opt"
              role="menuitem"
              onClick={() => bulk.setPlanField(f.name)}
              onMouseDown={(e) => { e.preventDefault(); bulk.setPlanField(f.name); }}
            >
              <span>{f.label ?? f.name}</span>
              <span className="meta">{widgetForField(f)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Link field menu: list-of-references fields only */}
      {picking === "linkField" && (
        <div className="cell-popover bulk-menu" role="menu">
          {linkFields.map((f) => (
            <div
              key={f.name}
              className="opt"
              role="menuitem"
              onClick={() => bulk.setLinkField(f.name)}
              onMouseDown={(e) => { e.preventDefault(); bulk.setLinkField(f.name); }}
            >
              <span>{f.label ?? f.name}</span>
              <span className="meta">links</span>
            </div>
          ))}
        </div>
      )}

      {/* Link target: an existing note, since a member edit names it by id */}
      {picking === "linkTarget" && linkField && (
        <span className="bulk-value-slot">
          <ReferenceAutocomplete
            field={linkField}
            requireCandidate
            onPick={(r) => { if (r.kind === "candidate") bulk.setLinkTarget({ id: r.candidate.id, title: r.candidate.title }); }}
            onCancel={() => bulk.cancel()}
          />
        </span>
      )}

      {/* Value editor slot */}
      {isPickingValue && fieldForValue && (
        <span className="bulk-value-slot">
          {(() => {
            const Editor = cellEditorFor(widgetForField(fieldForValue));
            return (
              <Editor
                initial={plan?.kind === "setField" ? plan.value : null}
                field={fieldForValue}
                schema={schema ?? undefined}
                onSubmit={(v) => bulk.setPlanValue(v)}
                onCancel={() => bulk.cancel()}
              />
            );
          })()}
        </span>
      )}

      {/* Type input */}
      {(picking === "addType" || picking === "removeType") && (
        <span className="bulk-type-slot">
          <TypeInput
            onSubmit={(type) => bulk.setPlanType(type)}
            onCancel={() => bulk.cancel()}
          />
        </span>
      )}

      {/* Plan summary + Apply */}
      {plan && !picking && (
        <>
          <span className="bulk-summary">{planLabel(plan)}</span>
          <button
            className="bulk-btn confirm"
            onClick={() => bulk.runDry()}
          >
            Apply…
          </button>
        </>
      )}

      {/* Clear */}
      <button
        className="bulk-btn"
        onClick={() => bulk.clear()}
      >
        Clear selection
      </button>
    </div>
  );
}
