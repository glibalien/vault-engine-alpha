import type { VizSpec } from './viz-spec.js';
import { specWithGroupBy } from './viz-spec.js';

/**
 * GroupByPanel — the Layout menu's Group by picker (#573), for Table, List and Kanban. Picking a
 * field saves it as `group_by`; None (Table and List only: a kanban always has columns) removes it.
 * Either way the folded sections are dropped, since they named the old field's values.
 * `field` is the field the view groups by now (a kanban's default included); `options` are the
 * view's fields (groupByOptions).
 */
export function GroupByPanel({ spec, onSpecChange, field, options, allowNone }: {
  spec: VizSpec;
  onSpecChange: (next: VizSpec) => void;
  field: string | null;
  options: readonly string[];
  allowNone: boolean;
}) {
  return (
    <label className="viz-settings-row">
      <span className="viz-settings-label">Group by</span>
      <select
        aria-label="Group by"
        value={field ?? ''}
        onChange={(e) => {
          const next = e.target.value;
          if (next === '' && !allowNone) return;
          onSpecChange(specWithGroupBy(spec, next === '' ? null : next));
        }}
      >
        {allowNone ? <option value="">None</option> : field === null && <option value="" disabled>Choose a field</option>}
        {options.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
    </label>
  );
}
