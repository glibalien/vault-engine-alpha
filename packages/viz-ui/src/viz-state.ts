import { isLinkCountColumn, linkCountKindOf } from '@vault/query-core';
import type { VizRow } from './viz-spec.js';
import type { ViewVocabulary } from './view-vocabulary.js';
import { parseDayKey } from './calendar-grid.js';

/** The status words the views have always known, by meaning, in board order. Cosmetic: they set
 *  the order and colour of those values wherever they appear. */
const KNOWN_STATUS_GROUPS = {
  backlog: ['backlog'],
  active: ['open', 'next', 'in-progress'],
  blocked: ['pending'],
  done: ['done'],
  ignored: ['dropped'],
} as const;

type StatusMeaning = keyof typeof KNOWN_STATUS_GROUPS;
const MEANINGS = Object.keys(KNOWN_STATUS_GROUPS) as StatusMeaning[];

const MEANING_COLOR: Record<StatusMeaning, string> = {
  backlog: '--st-todo', active: '--st-progress', blocked: '--st-blocked', done: '--st-done', ignored: '--st-todo',
};

/** Vault's shared status enum in canonical board order; unknown values sort after, alphabetically. */
export const STATUS_ORDER: string[] = MEANINGS.flatMap((m) => [...KNOWN_STATUS_GROUPS[m]]);

/** Bucket label for a missing/empty group field value. */
export const MISSING_BUCKET = '—';

const STATUS_COLOR: Record<string, string> = {
  backlog: '--st-todo',
  open: '--st-todo',
  next: '--st-progress',
  'in-progress': '--st-progress',
  pending: '--st-blocked',
  done: '--st-done',
  dropped: '--st-todo',
};

/** The order and colour of status values: known values first, in `order`; the rest after, alphabetically. */
export interface StatusScale {
  /** Lower-case status values in board order. */
  readonly order: readonly string[];
  /** Colour variable per lower-case value; an unlisted value takes `--st-todo`. */
  readonly colors: Readonly<Record<string, string>>;
}

/** The scale without a vault map: the known status words alone. */
export const DEFAULT_STATUS_SCALE: StatusScale = { order: STATUS_ORDER, colors: STATUS_COLOR };

/**
 * The scale for a vault's status values (the vault map's task and project status lists). The known
 * status words keep their order and colours. A value of the map that is not one of them goes after
 * the known words of the same meaning (backlog, active, blocked, done, ignored), coloured by meaning,
 * so a vault's own words order sensibly; values in no list still sort after, alphabetically.
 */
export function statusScaleFor(v: Pick<ViewVocabulary,
  'taskBacklogStatuses' | 'taskActiveStatuses' | 'taskBlockedStatuses' | 'taskDoneStatuses' | 'taskIgnoredStatuses'
  | 'projectBacklogStatuses' | 'projectActiveStatuses' | 'projectBlockedStatuses' | 'projectDoneStatuses' | 'projectIgnoredStatuses'>): StatusScale {
  const lists: Record<StatusMeaning, readonly string[]> = {
    backlog: [...v.taskBacklogStatuses, ...v.projectBacklogStatuses],
    active: [...v.taskActiveStatuses, ...v.projectActiveStatuses],
    blocked: [...v.taskBlockedStatuses, ...v.projectBlockedStatuses],
    done: [...v.taskDoneStatuses, ...v.projectDoneStatuses],
    ignored: [...v.taskIgnoredStatuses, ...v.projectIgnoredStatuses],
  };
  const seen = new Set<string>(STATUS_ORDER);
  const order: string[] = [];
  const colors: Record<string, string> = { ...STATUS_COLOR };
  for (const meaning of MEANINGS) {
    order.push(...KNOWN_STATUS_GROUPS[meaning]);
    for (const raw of lists[meaning]) {
      const value = raw.toLowerCase();
      if (seen.has(value)) continue;
      seen.add(value);
      order.push(value);
      colors[value] = MEANING_COLOR[meaning];
    }
  }
  return { order, colors };
}

export function statusColorVar(value: string, scale: StatusScale = DEFAULT_STATUS_SCALE): string {
  return scale.colors[value.toLowerCase()] ?? '--st-todo';
}

/** Whether a value is a known status value (case-insensitive). */
export function isStatus(value: string, scale: StatusScale = DEFAULT_STATUS_SCALE): boolean {
  return scale.order.includes(value.toLowerCase());
}

export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return String(value);
}

function statusRank(value: string, scale: StatusScale): number {
  const i = scale.order.indexOf(value.toLowerCase());
  return i === -1 ? scale.order.length : i;
}

export interface SortState {
  key: string; // 'title' or a field name
  dir: 1 | -1;
}

export function sortRows(rows: readonly VizRow[], sort: SortState, scale: StatusScale = DEFAULT_STATUS_SCALE): VizRow[] {
  if (isLinkCountColumn(sort.key)) {
    // Counts compare as numbers; a row without them (the draft) sorts last either way.
    const kind = linkCountKindOf(sort.key);
    return [...rows].sort((a, b) => {
      const av = a.link_counts?.[kind];
      const bv = b.link_counts?.[kind];
      if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1;
      return av !== bv ? (av - bv) * sort.dir : a.title.toLowerCase().localeCompare(b.title.toLowerCase());
    });
  }
  const val = (r: VizRow): string =>
    (sort.key === 'title' ? r.title : fieldText(r.fields[sort.key])).toLowerCase();
  // When every non-empty value is a known status, sort by board order instead of lexically.
  const statusy = rows.every((r) => { const v = val(r); return v === '' || scale.order.includes(v); })
    && rows.some((r) => val(r) !== '');
  return [...rows].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (statusy && sort.key !== 'title') {
      // Empty/missing values always sort last, independent of direction (mirrors groupRows' MISSING_BUCKET).
      if (av === '' && bv !== '') return 1;
      if (bv === '' && av !== '') return -1;
      const d = statusRank(av, scale) - statusRank(bv, scale);
      if (d !== 0) return d * sort.dir;
    }
    return av < bv ? -sort.dir : av > bv ? sort.dir : 0;
  });
}

export function filterRows(
  rows: readonly VizRow[],
  q: string,
  groupField: string,
  groupValue: string | null,
): VizRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => {
    // Match the raw group value; the missing/empty bucket is the empty string,
    // which is distinct from a literal "—" value (RowGroup.missing / .value === '').
    if (groupValue !== null && fieldText(r.fields[groupField]) !== groupValue) return false;
    if (!needle) return true;
    const hay = [r.title, ...Object.values(r.fields).map(fieldText)].join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

export interface RowGroup {
  /** Raw group value; the empty string for the missing/empty bucket. Unique per group (React key). */
  value: string;
  /** Display label — the raw value, or MISSING_BUCKET ("—") for the missing bucket. */
  label: string;
  /** True for the missing/empty bucket; distinguishes it from a literal "—" value. */
  missing: boolean;
  rows: VizRow[];
}

/**
 * Rows bucketed by one field, in board order: status values in meaning order, then the rest
 * alphabetically, rows with no value last. A field holding several values groups by the values
 * joined. `byDay` (a time zone) groups a date field by the day each value falls on (parseDayKey):
 * any time of day is ignored, and the days sort oldest first. A value that isn't a date keeps
 * its own text.
 */
export function groupRows(rows: readonly VizRow[], groupBy: string, scale: StatusScale = DEFAULT_STATUS_SCALE, byDay?: string): RowGroup[] {
  const map = new Map<string, VizRow[]>();
  for (const r of rows) {
    const raw = r.fields[groupBy];
    // '' when missing/empty — keyed distinctly from a literal "—"
    const v = byDay !== undefined && !Array.isArray(raw) ? (parseDayKey(raw, byDay) ?? fieldText(raw)) : fieldText(raw);
    const bucket = map.get(v);
    if (bucket) bucket.push(r);
    else map.set(v, [r]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === '') return 1; // missing bucket always sorts last
      if (b === '') return -1;
      const d = statusRank(a, scale) - statusRank(b, scale);
      return d !== 0 ? d : a.localeCompare(b);
    })
    .map(([value, groupedRows]) => ({
      value,
      label: value === '' ? MISSING_BUCKET : value,
      missing: value === '',
      rows: groupedRows,
    }));
}
