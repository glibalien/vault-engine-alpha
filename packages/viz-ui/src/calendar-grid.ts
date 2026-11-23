import type { Schema } from '@vault/query-core';
import type { VizRow } from './viz-spec.js';
import { CALENDAR_DATE_FALLBACKS } from './viz-spec.js';

export interface DayCell {
  day: number;
  iso: string; // YYYY-MM-DD
  inMonth: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const isoOf = (y: number, m0: number, d: number): string => `${y}-${pad(m0 + 1)}-${pad(d)}`;

/** A 6×7 grid (weeks × days, Sunday-first) covering month0 of year, padded with adjacent-month days. */
export function monthMatrix(year: number, month0: number): DayCell[][] {
  const first = new Date(Date.UTC(year, month0, 1));
  const startDow = first.getUTCDay(); // 0=Sun
  const gridStart = new Date(Date.UTC(year, month0, 1 - startDow));
  const weeks: DayCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(gridStart);
      cur.setUTCDate(gridStart.getUTCDate() + w * 7 + d);
      const y = cur.getUTCFullYear(), m0 = cur.getUTCMonth(), day = cur.getUTCDate();
      week.push({ day, iso: isoOf(y, m0, day), inMonth: m0 === month0 && y === year });
    }
    weeks.push(week);
  }
  return weeks;
}

/** The field a calendar plots by: explicit date_field, else the first present fallback (the vault
 *  map's due/date/scheduled fields, calendarDateFields), else null. */
export function resolveDateField(spec: { date_field?: string }, sampleFields: string[], fallbacks: readonly string[] = CALENDAR_DATE_FALLBACKS): string | null {
  if (spec.date_field) return spec.date_field;
  return fallbacks.find((f) => sampleFields.includes(f)) ?? null;
}

/**
 * The date fields a calendar's Date field and End field pickers offer: every `date` field of the
 * view's types' schemas (of every loaded schema when the view names no type), in schema order,
 * then each field in use that is not among them, so the pickers always show what the view plots.
 */
export function calendarFieldOptions(types: readonly string[], schemas: ReadonlyMap<string, Schema>, inUse: ReadonlyArray<string | null | undefined>): string[] {
  const from = types.length > 0 ? types.map((t) => schemas.get(t)) : [...schemas.values()];
  const names = from.flatMap((s) => (s?.fields ?? []).filter((f) => f.type === 'date').map((f) => f.name));
  return [...new Set([...names, ...inUse.filter((f): f is string => typeof f === 'string' && f !== '')])];
}

/** The viewer's own time zone; UTC when the runtime reports none. */
function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The zone a calendar's days are taken in: the configured one (Curator's `tz`) when it is set and
 *  valid, else the viewer's. */
export function calendarZone(configured?: string | null): string {
  const tz = configured?.trim();
  if (tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { /* not a zone: the viewer's */ }
  }
  return viewerZone();
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The YYYY-MM-DD day an instant falls on in `zone`. */
export function dayKeyInZone(instant: Date, zone: string): string {
  let fmt = dayFormats.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
    dayFormats.set(zone, fmt);
  }
  const parts = fmt.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return isoOf(get('year'), get('month') - 1, get('day'));
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(.*)$/;
const WALL_TIME = /^[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const ZONED_TIME = /^[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Normalize a field value to the YYYY-MM-DD day it falls on; null if unparseable.
 * - A date (`2026-06-15`) or a date and time without a zone (`2026-06-15T21:00`, how the Engine
 *   stores a time) is that day as written: no zone moves it.
 * - An instant (epoch ms, or an ISO time with `Z` or an offset) is the day it falls on in `zone`.
 * - Anything else the runtime parses is the day it falls on for the viewer, who it was read for.
 */
export function parseDayKey(value: unknown, zone: string = viewerZone()): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : dayKeyInZone(d, zone);
  }
  const s = String(value).trim();
  const m = ISO_DAY.exec(s);
  if (m) {
    const [, y, mo, da, rest] = m;
    const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da)));
    // No such day (2026-02-30): the runtime would roll it into the next month.
    if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(da)) return null;
    if (rest === '' || WALL_TIME.test(rest)) return `${y}-${mo}-${da}`;
    if (ZONED_TIME.test(rest)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : dayKeyInZone(d, zone);
    }
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
}

/** One row on the calendar: the days it covers, first and last (the same day for a one-day item). */
export interface CalendarItem {
  row: VizRow;
  start: string;
  end: string;
}

/**
 * The rows a calendar plots, with their days, and how many have no start day. An item covers
 * every day from its start to its end; one without an end field, without an end value, or with an
 * end before its start covers its start day only.
 */
export function calendarItems(rows: VizRow[], dateField: string, endField: string | null | undefined, zone: string): { items: CalendarItem[]; undated: number } {
  const items: CalendarItem[] = [];
  let undated = 0;
  for (const row of rows) {
    const start = parseDayKey(row.fields[dateField], zone);
    if (start === null) { undated++; continue; }
    const end = endField ? parseDayKey(row.fields[endField], zone) : null;
    items.push({ row, start, end: end !== null && end > start ? end : start });
  }
  return { items, undated };
}

/** One item's bar in one week row. */
export interface WeekBar {
  item: CalendarItem;
  /** 0 is the top lane. */
  lane: number;
  /** First day column, 0 (Sunday) to 6. */
  col: number;
  /** Days the bar covers in this week, 1 to 7. */
  span: number;
  /** The item started before this week. */
  continuesBefore: boolean;
  /** The item ends after this week. */
  continuesAfter: boolean;
}

/**
 * Lay out one week row: each item that covers a day of it becomes a bar over its days, in the top
 * lane free on all of them. Items are placed by first day, then the longer first, then in row order.
 */
export function layoutWeek(week: DayCell[], items: CalendarItem[]): WeekBar[] {
  const first = week[0]!.iso;
  const last = week[week.length - 1]!.iso;
  const col = (iso: string) => week.findIndex((c) => c.iso === iso);
  const placed = items
    .filter((it) => it.start <= last && it.end >= first)
    .map((item, order) => {
      const from = col(item.start < first ? first : item.start);
      const to = col(item.end > last ? last : item.end);
      return { item, order, col: from, span: to - from + 1 };
    })
    .sort((a, b) => a.col - b.col || b.span - a.span || a.order - b.order);
  const lanes: boolean[][] = [];
  return placed.map(({ item, col: c, span }) => {
    let lane = 0;
    while (lanes[lane]?.slice(c, c + span).some(Boolean)) lane++;
    const used = (lanes[lane] ??= Array<boolean>(week.length).fill(false));
    used.fill(true, c, c + span);
    return { item, lane, col: c, span, continuesBefore: item.start < first, continuesAfter: item.end > last };
  });
}

/** For each day of a week, how many of its bars sit below the first `shownLanes` lanes. */
export function hiddenPerDay(bars: WeekBar[], shownLanes: number, days = 7): number[] {
  const hidden = Array<number>(days).fill(0);
  for (const b of bars) {
    if (b.lane < shownLanes) continue;
    for (let d = b.col; d < b.col + b.span; d++) hidden[d]!++;
  }
  return hidden;
}
