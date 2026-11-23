import { useState, useRef, useEffect } from "react";
import { useDismissOnOutside } from "./use-dismiss-on-outside.js";
import type { Schema, SchemaField, FilterChip, CallerFragment } from "@vault/query-core";
import { widgetForField, summarizeFragment } from "@vault/query-core";
import { ReferenceAutocomplete } from "./ReferenceAutocomplete.js";
import { useVizClient } from "./viz-client-context.js";

// ---- prop types ----

/** A filter "+ filter" offers that isn't one of the type's fields (title contains, a link count). */
export interface FilterAddOption {
  key: string;
  label: string;
  /** Hover text explaining the filter. */
  hint?: string;
}

export interface FieldChipsProps {
  /** The view's type schema; null on a view with no type, which has no field chips. */
  schema: Schema | null;
  chips: FilterChip[];
  addableFields: SchemaField[];
  fragments: CallerFragment[];
  onAddChip: (fieldName: string) => void;
  onSetChip: (fieldName: string, state: Record<string, unknown>) => void;
  onRemoveChip: (fieldName: string) => void;
  onRemoveFragment: (id: number) => void;
  /** Listed in "+ filter" ahead of the type's fields (#617). */
  extraAddOptions?: FilterAddOption[];
  onAddExtra?: (key: string) => void;
}

// ---- per-widget editors ----

function EnumEditor({
  field,
  chip,
  onSet,
}: {
  field: SchemaField;
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  const sel = Array.isArray(chip.state.one_of) ? (chip.state.one_of as string[]) : [];
  const values = field.enum_values ?? [];

  function toggle(v: string) {
    const next = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v];
    onSet({ one_of: next });
  }

  return (
    <span className="fchip-editor fchip-enum">
      {values.map((v) => (
        <button
          key={v}
          className="fchip-enum-opt"
          data-on={sel.includes(v) ? "true" : "false"}
          onClick={() => toggle(v)}
        >
          {v}
        </button>
      ))}
    </span>
  );
}

function NumberEditor({
  chip,
  onSet,
}: {
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  const min = chip.state.min == null ? "" : String(chip.state.min);
  const max = chip.state.max == null ? "" : String(chip.state.max);

  return (
    <span className="fchip-editor">
      <input
        type="number"
        placeholder="min"
        value={min}
        onChange={(e) => onSet({ min: e.target.value, max })}
      />
      <span className="fop">–</span>
      <input
        type="number"
        placeholder="max"
        value={max}
        onChange={(e) => onSet({ min, max: e.target.value })}
      />
    </span>
  );
}

function DateEditor({
  chip,
  onSet,
}: {
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  const gte = chip.state.gte == null ? "" : String(chip.state.gte);
  const lte = chip.state.lte == null ? "" : String(chip.state.lte);

  return (
    <span className="fchip-editor">
      <input
        type="date"
        aria-label="from"
        value={gte}
        onChange={(e) => onSet({ gte: e.target.value, lte })}
      />
      <span className="fop">→</span>
      <input
        type="date"
        aria-label="to"
        value={lte}
        onChange={(e) => onSet({ gte, lte: e.target.value })}
      />
    </span>
  );
}

function BoolEditor({
  chip,
  onSet,
}: {
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  const eq = chip.state.eq;
  const opts: Array<[string, boolean | null]> = [
    ["any", null],
    ["true", true],
    ["false", false],
  ];

  return (
    <span className="fchip-editor seg">
      {opts.map(([lbl, val]) => (
        <button
          key={lbl}
          data-on={eq === val ? "true" : "false"}
          onClick={() => onSet({ eq: val })}
        >
          {lbl}
        </button>
      ))}
    </span>
  );
}

function LinkEditor({
  field,
  chip,
  onSet,
}: {
  field: SchemaField;
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  const rawTarget = chip.state.target as { id: string; title: string | null } | null | undefined;
  const hasTarget = rawTarget != null && typeof rawTarget.id === "string";

  // Async hydration: when target.title is null, fetch it via queryNodes
  const [hydratedTitle, setHydratedTitle] = useState<string | null>(null);
  const client = useVizClient();

  useEffect(() => {
    if (!hasTarget || rawTarget!.title != null) {
      setHydratedTitle(null);
      return;
    }
    let cancelled = false;
    client.queryNodes({ node_ids: [rawTarget!.id], limit: 1 }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data.nodes.length > 0) {
        setHydratedTitle(res.data.nodes[0]!.title);
      }
    }).catch(() => {/* ignore */});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget ? rawTarget!.id : null, hasTarget ? rawTarget!.title : null]);

  const [pickerOpen, setPickerOpen] = useState(false);

  // --- Target mode: show the resolved title + clear button ---
  if (hasTarget) {
    const displayTitle = rawTarget!.title ?? hydratedTitle ?? rawTarget!.id;
    return (
      <span className="fchip-editor fchip-target">
        <span className="fchip-target-title">{displayTitle}</span>
        <button
          className="fchip-target-clear"
          aria-label="clear target"
          onClick={() => onSet({ exists: null, target: null })}
        >
          ×
        </button>
      </span>
    );
  }

  // --- Picker mode: autocomplete open ---
  if (pickerOpen) {
    return (
      <span className="fchip-editor fchip-pick-open">
        <ReferenceAutocomplete
          field={field}
          requireCandidate
          onPick={(result) => {
            setPickerOpen(false);
            // requireCandidate guarantees the candidate branch — unresolved refs are filtered upstream
            if (result.kind === "candidate") {
              onSet({ exists: null, target: { id: result.candidate.id, title: result.candidate.title } });
            }
          }}
          onCancel={() => setPickerOpen(false)}
        />
      </span>
    );
  }

  // --- Default mode: any/set/empty + pick affordance ---
  const exists = chip.state.exists;
  const opts: Array<[string, boolean | null]> = [
    ["any", null],
    ["set", true],
    ["empty", false],
  ];

  return (
    <span className="fchip-editor seg">
      {opts.map(([lbl, val]) => (
        <button
          key={lbl}
          data-on={exists === val ? "true" : "false"}
          onClick={() => onSet({ exists: val, target: null })}
        >
          {lbl}
        </button>
      ))}
      <button
        className="fchip-pick"
        aria-label="pick target"
        onClick={() => setPickerOpen(true)}
      >
        pick…
      </button>
    </span>
  );
}

function TextEditor({
  chip,
  onSet,
}: {
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  // tags widget uses "value" key, text widget uses "contains"
  const isTagsKey = "value" in chip.state;
  const key = isTagsKey ? "value" : "contains";
  const val = chip.state[key] == null ? "" : String(chip.state[key]);

  return (
    <span className="fchip-editor">
      <span className="fop">{isTagsKey ? "has" : "contains"}</span>
      <input
        type="text"
        placeholder="…"
        value={val}
        onChange={(e) => onSet({ [key]: e.target.value })}
      />
    </span>
  );
}

// ---- pick the right editor ----

function ChipEditor({
  field,
  chip,
  onSet,
}: {
  field: SchemaField;
  chip: FilterChip;
  onSet: (state: Record<string, unknown>) => void;
}) {
  const widget = widgetForField(field);

  switch (widget) {
    case "enum":
      return <EnumEditor field={field} chip={chip} onSet={onSet} />;
    case "number":
      return <NumberEditor chip={chip} onSet={onSet} />;
    case "date":
      return <DateEditor chip={chip} onSet={onSet} />;
    case "bool":
      return <BoolEditor chip={chip} onSet={onSet} />;
    case "link":
      return <LinkEditor field={field} chip={chip} onSet={onSet} />;
    case "tags":
    case "text":
    case "textarea":
    default:
      return <TextEditor chip={chip} onSet={onSet} />;
  }
}

// ---- main component ----

/**
 * FieldChips — presentational strip of per-field filter chip editors.
 *
 * Renders:
 *  - one chip per FilterChip in `chips` (label + per-widget editor + remove ×)
 *  - an "+ filter" affordance listing extraAddOptions, then addableFields
 *  - dashed caller-fragment chips with their summarized label + remove ×
 *
 * Does NO query-building — the parent hook owns recompose.
 * All mutations flow through callbacks: onAddChip / onSetChip / onRemoveChip /
 * onRemoveFragment / onAddExtra.
 */
export function FieldChips({
  schema,
  chips,
  addableFields,
  fragments,
  onAddChip,
  onSetChip,
  onRemoveChip,
  onRemoveFragment,
  extraAddOptions = [],
  onAddExtra,
}: FieldChipsProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuWrapRef = useRef<HTMLSpanElement>(null);
  useDismissOnOutside(addMenuWrapRef, addMenuOpen, () => setAddMenuOpen(false));

  function handlePickField(fieldName: string) {
    setAddMenuOpen(false);
    onAddChip(fieldName);
  }

  function handlePickExtra(key: string) {
    setAddMenuOpen(false);
    onAddExtra?.(key);
  }

  return (
    <div className="field-chips">
      {/* Active field chips */}
      {chips.map((chip) => {
        const field = schema?.fields.find((f) => f.name === chip.field);
        if (!field) return null;
        return (
          <span key={chip.field} className="fchip">
            <span className="fname">{chip.field}</span>
            <ChipEditor
              field={field}
              chip={chip}
              onSet={(state) => onSetChip(chip.field, state)}
            />
            <button
              className="x"
              aria-label={`remove ${chip.field} chip`}
              onClick={() => onRemoveChip(chip.field)}
            >
              ×
            </button>
          </span>
        );
      })}

      {/* + filter affordance */}
      {extraAddOptions.length + addableFields.length > 0 && (
        <span className="fchip-add-wrap" ref={addMenuWrapRef}>
          <button
            className="fchip-add-btn"
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            + filter
          </button>
          {addMenuOpen && (
            <div className="fchip-add-menu" role="menu">
              {extraAddOptions.map((o) => (
                <button
                  key={`extra:${o.key}`}
                  role="menuitem"
                  title={o.hint}
                  onClick={() => handlePickExtra(o.key)}
                >
                  {o.label}
                </button>
              ))}
              {extraAddOptions.length > 0 && addableFields.length > 0 && (
                <div className="fchip-add-sep" role="separator" />
              )}
              {addableFields.map((f) => (
                <button
                  key={f.name}
                  role="menuitem"
                  onClick={() => handlePickField(f.name)}
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </span>
      )}

      {/* Caller-fragment chips */}
      {fragments.map((frag) => {
        const { label, tooltip } = summarizeFragment(frag);
        return (
          <span key={frag.id} className="fchip fchip-caller" title={tooltip}>
            <span className="flabel">{label}</span>
            <button
              className="x"
              aria-label={`remove filter ${label}`}
              onClick={() => onRemoveFragment(frag.id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
