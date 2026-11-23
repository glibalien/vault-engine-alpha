import { useRef, useState } from "react";
import { useDismissOnOutside } from "./use-dismiss-on-outside.js";
import type { VizSpec, SortOption } from "./viz-spec.js";
import { SORT_OPTIONS, showsLinkCounts } from "./viz-spec.js";

type Density = "compact" | "cozy" | "comfy";
const DENSITIES: Density[] = ["compact", "cozy", "comfy"];

/**
 * VizSettingsPanel — the table display options, without a trigger: density
 * (compact / cozy / comfy), row-numbers and version-column toggles, plus a Sort
 * dropdown when onSortChange is provided. Each change calls onSpecChange with the
 * updated spec (immutable); Sort calls onSortChange (sort lives in the query strip).
 * Rendered inside the Bases-style Layout menu and by the standalone VizSettings popover.
 */
export function VizSettingsPanel({
  spec,
  onSpecChange,
  sortKey,
  onSortChange,
}: {
  spec: VizSpec;
  onSpecChange: (next: VizSpec) => void;
  sortKey?: string;
  onSortChange?: (opt: SortOption) => void;
}) {
  const density: Density = spec.density ?? "cozy";
  return (
    <>
      <div className="viz-settings-row">
        <span className="viz-settings-label">Row density</span>
        <div className="viz-density-seg">
          {DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              className={`viz-density-opt${density === d ? " on" : ""}`}
              aria-pressed={density === d}
              onClick={() => onSpecChange({ ...spec, density: d })}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <label className="viz-settings-row viz-settings-check">
        <input
          type="checkbox"
          aria-label="Row numbers"
          checked={spec.show_row_numbers ?? false}
          onChange={(e) => onSpecChange({ ...spec, show_row_numbers: e.target.checked })}
        />
        Row numbers
      </label>
      <label className="viz-settings-row viz-settings-check">
        <input
          type="checkbox"
          aria-label="Version"
          checked={spec.show_version ?? false}
          onChange={(e) => onSpecChange({ ...spec, show_version: e.target.checked })}
        />
        Version
      </label>
      <label className="viz-settings-row viz-settings-check" title="How many notes link to each note, how many it links to, and how many it links to that don't exist yet">
        <input
          type="checkbox"
          aria-label="Link counts"
          checked={showsLinkCounts(spec)}
          onChange={(e) => onSpecChange({ ...spec, show_link_counts: e.target.checked })}
        />
        Link counts
      </label>
      {onSortChange !== undefined && (
        <label className="viz-settings-row">
          <span className="viz-settings-label">Sort</span>
          <select
            aria-label="Sort"
            value={sortKey ?? 'file_mtime:desc'}
            onChange={(e) => {
              const opt = SORT_OPTIONS.find((o) => o.key === e.target.value);
              if (opt) onSortChange(opt);
            }}
          >
            {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/**
 * VizSettings — a popover button wrapping VizSettingsPanel.
 * Uses useDismissOnOutside to close on outside click.
 */
export function VizSettings({
  spec,
  onSpecChange,
  sortKey,
  onSortChange,
}: {
  spec: VizSpec;
  onSpecChange: (next: VizSpec) => void;
  sortKey?: string;
  onSortChange?: (opt: SortOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismissOnOutside(wrapRef, open, () => setOpen(false));

  return (
    <div className="viz-settings-wrap" ref={wrapRef}>
      <button
        type="button"
        className="viz-settings-btn"
        aria-label="Table settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        settings
      </button>
      {open && (
        <div className="viz-settings-menu" role="dialog" aria-label="Table settings">
          <VizSettingsPanel spec={spec} onSpecChange={onSpecChange} sortKey={sortKey} onSortChange={onSortChange} />
        </div>
      )}
    </div>
  );
}
