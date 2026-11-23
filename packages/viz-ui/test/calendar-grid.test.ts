import { describe, expect, it } from 'vitest';
import type { Schema } from '@vault/query-core';
import {
  calendarFieldOptions, calendarItems, calendarZone, hiddenPerDay, layoutWeek, monthMatrix, parseDayKey,
  type CalendarItem,
} from '../src/calendar-grid';
import type { VizRow } from '../src/viz-spec';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

describe('parseDayKey (#574: days in the configured time zone)', () => {
  it('takes a date as written, in any zone', () => {
    for (const zone of [NY, TOKYO, 'UTC']) expect(parseDayKey('2026-06-15', zone)).toBe('2026-06-15');
  });

  it('takes a date and time without a zone (how the Engine stores a time) as written: an evening stays on its day', () => {
    for (const zone of [NY, TOKYO, 'UTC']) {
      expect(parseDayKey('2026-06-15T21:00', zone)).toBe('2026-06-15');
      expect(parseDayKey('2026-06-15 23:59:59', zone)).toBe('2026-06-15');
    }
  });

  it('takes an instant with a zone on the day it falls in the configured zone', () => {
    // 21:00 in New York is 01:00 UTC the next day: still the 15th in New York.
    expect(parseDayKey('2026-06-15T21:00:00-04:00', NY)).toBe('2026-06-15');
    expect(parseDayKey('2026-06-16T01:00:00.000Z', NY)).toBe('2026-06-15');
    expect(parseDayKey('2026-06-16T01:00:00Z', 'UTC')).toBe('2026-06-16');
    expect(parseDayKey('2026-06-15T20:00:00Z', TOKYO)).toBe('2026-06-16');
  });

  it('takes epoch milliseconds in the configured zone', () => {
    const ms = Date.UTC(2026, 5, 16, 1, 0);
    expect(parseDayKey(ms, NY)).toBe('2026-06-15');
    expect(parseDayKey(ms, 'UTC')).toBe('2026-06-16');
  });

  it('returns null for nothing, garbage and days that do not exist', () => {
    for (const v of [null, undefined, '', 'soon', '2026-02-30', '2026-13-01']) expect(parseDayKey(v, NY)).toBeNull();
  });
});

describe('calendarZone', () => {
  const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  it('takes the configured zone when it is a zone', () => {
    expect(calendarZone(TOKYO)).toBe(TOKYO);
    expect(calendarZone(` ${NY} `)).toBe(NY);
  });
  it('falls back to the viewer\'s zone when none or an unknown one is configured', () => {
    expect(calendarZone(null)).toBe(viewer);
    expect(calendarZone('')).toBe(viewer);
    expect(calendarZone('Not/AZone')).toBe(viewer);
  });
});

const row = (id: string, fields: Record<string, unknown>): VizRow => ({ id, title: id, file_path: `${id}.md`, types: ['trip'], fields });

describe('calendarItems', () => {
  it('covers start to end, the start day only without an end or with an end before the start, and counts undated rows', () => {
    const rows = [
      row('trip', { start: '2026-06-14', end: '2026-06-16' }),
      row('call', { start: '2026-06-15' }),
      row('typo', { start: '2026-06-20', end: '2026-06-18' }),
      row('none', { end: '2026-06-18' }),
    ];
    const { items, undated } = calendarItems(rows, 'start', 'end', 'UTC');
    expect(items.map((i) => [i.row.id, i.start, i.end])).toEqual([
      ['trip', '2026-06-14', '2026-06-16'],
      ['call', '2026-06-15', '2026-06-15'],
      ['typo', '2026-06-20', '2026-06-20'],
    ]);
    expect(undated).toBe(1);
  });

  it('ignores end values when the view has no end field', () => {
    const { items } = calendarItems([row('trip', { start: '2026-06-14', end: '2026-06-16' })], 'start', null, 'UTC');
    expect(items[0]).toMatchObject({ start: '2026-06-14', end: '2026-06-14' });
  });
});

describe('layoutWeek', () => {
  // June 2026 starts on a Monday: its second week row is Sun 7 … Sat 13.
  const week = monthMatrix(2026, 5)[1]!;
  const item = (id: string, start: string, end = start): CalendarItem => ({ row: row(id, {}), start, end });

  it('puts one-day items in lanes in row order', () => {
    const bars = layoutWeek(week, [item('a', '2026-06-09'), item('b', '2026-06-09'), item('c', '2026-06-10')]);
    expect(bars.map((b) => [b.item.row.id, b.lane, b.col, b.span])).toEqual([['a', 0, 2, 1], ['b', 1, 2, 1], ['c', 0, 3, 1]]);
  });

  it('draws a span as one bar over its days, the longer first, and packs the next item into a free lane', () => {
    const bars = layoutWeek(week, [item('call', '2026-06-08'), item('trip', '2026-06-08', '2026-06-10'), item('later', '2026-06-11')]);
    expect(bars.map((b) => [b.item.row.id, b.lane, b.col, b.span])).toEqual([['trip', 0, 1, 3], ['call', 1, 1, 1], ['later', 0, 4, 1]]);
  });

  it('cuts a span at the week\'s edges and says it continues', () => {
    const [bar] = layoutWeek(week, [item('trip', '2026-06-05', '2026-06-20')]);
    expect(bar).toMatchObject({ col: 0, span: 7, continuesBefore: true, continuesAfter: true });
    const [end] = layoutWeek(week, [item('trip', '2026-06-05', '2026-06-08')]);
    expect(end).toMatchObject({ col: 0, span: 2, continuesBefore: true, continuesAfter: false });
  });

  it('leaves out items outside the week', () => {
    expect(layoutWeek(week, [item('before', '2026-06-01', '2026-06-06'), item('after', '2026-06-14')])).toEqual([]);
  });

  it('counts each day\'s bars below the shown lanes: spans count on every day they cover', () => {
    const items = [item('trip', '2026-06-08', '2026-06-10'), item('a', '2026-06-09'), item('b', '2026-06-09'), item('c', '2026-06-09')];
    const bars = layoutWeek(week, items);
    expect(hiddenPerDay(bars, 3)).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(hiddenPerDay(bars, 1)).toEqual([0, 0, 3, 0, 0, 0, 0]);
  });
});

describe('calendarFieldOptions', () => {
  const schema = (name: string, fields: Array<[string, string]>): Schema =>
    ({ name, display_name: null, fields: fields.map(([n, type]) => ({ name: n, type, required: false, default_value: null, ui: null })) } as unknown as Schema);
  const schemas = new Map<string, Schema>([
    ['trip', schema('trip', [['start', 'date'], ['title', 'string'], ['end', 'date']])],
    ['task', schema('task', [['due', 'date'], ['scheduled', 'date'], ['status', 'enum']])],
  ]);

  it('lists the date fields of the view\'s types, in schema order', () => {
    expect(calendarFieldOptions(['trip'], schemas, [])).toEqual(['start', 'end']);
    expect(calendarFieldOptions(['task', 'trip'], schemas, [])).toEqual(['due', 'scheduled', 'start', 'end']);
  });

  it('lists every loaded schema\'s date fields when the view names no type', () => {
    expect(calendarFieldOptions([], schemas, [])).toEqual(['start', 'end', 'due', 'scheduled']);
  });

  it('adds the fields in use that are not among them, once', () => {
    expect(calendarFieldOptions(['trip'], schemas, ['due', 'start', null, undefined, ''])).toEqual(['start', 'end', 'due']);
    expect(calendarFieldOptions(['unknown'], schemas, ['date'])).toEqual(['date']);
  });
});
