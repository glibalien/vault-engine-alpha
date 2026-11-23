import { normalizeVizKind, normalizeVizSpec, type VizSpec } from './viz-spec.js';

export interface NodeCardSpec     { kind: 'node';     title: string; node_id: string; expanded?: boolean }
export interface StatsCardSpec    { kind: 'stats';    title: string }
/** The Usage and cost view's range, resolved to dates each time it loads (#281). */
export type SpendRange = 'month' | '30d';
export interface SpendCardSpec    { kind: 'spend';    title: string; range: SpendRange }

/** The board card union: the four query-viz kinds keep their exact phase-1 meaning,
 *  so every persisted card parses unchanged — no migration, cards_json untouched.
 *  The retired Project health and Project evidence views (#281) parse to null like any
 *  unknown kind, so a stray saved card shows as unrecognized rather than vanishing. */
export type BoardCardSpec = VizSpec | NodeCardSpec | StatsCardSpec | SpendCardSpec;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (v: unknown): v is string => typeof v === 'string';

/** Structural VizSpec check for board cards: identical to `isVizSpec`'s shape checks EXCEPT it
 *  drops the non-empty-title rule. Board presets (`TABLE_PRESET`/`KANBAN_PRESET` in board-core)
 *  and already-persisted phase-1 cards legitimately carry `title: ''` — `deriveVizTitle` supplies
 *  a fallback at render time. Kept separate from `isVizSpec` itself, which stays strict for chat
 *  viz fences (`parseVizFence`), where an empty title is a genuine model-output defect. */
function isVizSpecShape(x: unknown): x is VizSpec {
  if (!isObj(x)) return false;
  return (
    normalizeVizKind(x.kind) !== undefined &&
    typeof x.title === 'string' &&
    typeof x.query === 'object' && x.query !== null && !Array.isArray(x.query) &&
    Array.isArray(x.display_fields) && x.display_fields.every((f) => typeof f === 'string') &&
    (x.group_by === undefined || typeof x.group_by === 'string') &&
    (x.date_field === undefined || typeof x.date_field === 'string') &&
    (x.end_date_field === undefined || typeof x.end_date_field === 'string') &&
    (x.column_widths === undefined || (typeof x.column_widths === 'object' && x.column_widths !== null && !Array.isArray(x.column_widths)))
  );
}

/** Structural guard + legacy-kind/display-field normalization. Servers own query semantics.
 *  Unknown kinds → null; the host renders its visible "unrecognized card" state,
 *  never silently dropping the card. */
export function parseBoardCardSpec(x: unknown): BoardCardSpec | null {
  if (!isObj(x)) return null;
  if (normalizeVizKind(x.kind) !== undefined) {
    if (!isVizSpecShape(x)) return null;
    return normalizeVizSpec(x);
  }
  switch (x.kind) {
    case 'node':
      return str(x.title) && str(x.node_id) && (x.expanded === undefined || typeof x.expanded === 'boolean')
        ? (x as unknown as NodeCardSpec) : null;
    case 'stats':
      return str(x.title) ? (x as unknown as StatsCardSpec) : null;
    case 'spend':
      // A card from the old free-text composer carries usage-report `args` instead of a range; it
      // opens as this month's view, since its frozen dates no longer mean anything (#281).
      return str(x.title) ? { kind: 'spend', title: x.title, range: x.range === '30d' ? '30d' : 'month' } : null;
    default:
      return null;
  }
}
