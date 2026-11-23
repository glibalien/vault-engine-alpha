import type { VizSpec } from './viz-spec.js';

/** The spec without an end field. */
function withoutEnd(spec: VizSpec): VizSpec {
  if (spec.end_date_field === undefined) return spec;
  const { end_date_field: _dropped, ...rest } = spec;
  return rest;
}

/**
 * CalendarFieldsPanel — a calendar's Date field and End field pickers, in the Layout menu. Picking
 * a date field saves it as `date_field`; an end field saves `end_date_field`, and None removes it.
 * `dateField` is the field the calendar plots by now: the saved one, else the one it fell back to.
 * `options` are the date fields of the view's types (calendarFieldOptions).
 */
export function CalendarFieldsPanel({ spec, onSpecChange, dateField, options }: {
  spec: VizSpec;
  onSpecChange: (next: VizSpec) => void;
  dateField: string | null;
  options: readonly string[];
}) {
  const end = spec.end_date_field ?? '';
  const endOptions = options.filter((f) => f !== dateField || f === end);
  return (
    <>
      <label className="viz-settings-row">
        <span className="viz-settings-label">Date field</span>
        <select
          aria-label="Date field"
          value={dateField ?? ''}
          onChange={(e) => {
            const field = e.target.value;
            if (field === '') return;
            // The start can't also be the end: picking the end field as the date drops the end.
            const next = { ...spec, date_field: field };
            onSpecChange(next.end_date_field === field ? withoutEnd(next) : next);
          }}
        >
          {dateField === null && <option value="" disabled>Choose a field</option>}
          {options.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <label className="viz-settings-row">
        <span className="viz-settings-label">End field</span>
        <select
          aria-label="End field"
          value={end}
          onChange={(e) => {
            const field = e.target.value;
            onSpecChange(field === '' ? withoutEnd(spec) : { ...spec, end_date_field: field });
          }}
        >
          <option value="">None</option>
          {endOptions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      {options.length === 0 && <div className="viz-pop-note">This view’s types have no date fields.</div>}
    </>
  );
}
