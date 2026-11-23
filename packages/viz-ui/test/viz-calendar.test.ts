// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VizCalendar } from '../src/VizCalendar';
import type { VizRow } from '../src/viz-spec';

afterEach(cleanup);

const row = (id: string, due: string): VizRow => ({ id, title: id, file_path: id, types: ['task'], fields: { due } });
const trip = (id: string, start: string, end?: string): VizRow =>
  ({ id, title: id, file_path: id, types: ['trip'], fields: end === undefined ? { start } : { start, end } });

/** June 2026: the grid's weeks start Sun May 31, Jun 7, Jun 14, Jun 21, Jun 28, Jul 5. */
const JUNE = { initialYear: 2026, initialMonth0: 5, onOpenPreview: () => {} };

/** Each item button's week row (0-5), first column (1-7), days spanned and classes. */
function bars(container: HTMLElement) {
  return [...container.querySelectorAll('.cal-week')].flatMap((week, w) =>
    [...week.querySelectorAll<HTMLButtonElement>('button.cal-ev')].map((b) => {
      const [col, span] = b.style.gridColumn.split(' / span ').map(Number);
      return { title: b.textContent, week: w, col, span, lane: Number(b.style.gridRow) - 2, cls: b.className };
    }));
}

describe('VizCalendar', () => {
  it('renders a 7-column month grid with weekday headers', () => {
    const html = renderToStaticMarkup(createElement(VizCalendar, { rows: [], dateField: 'due', ...JUNE }));
    expect(html).toContain('Sun');
    expect(html).toContain('Sat');
    expect(html).toContain('June 2026');
  });
  it('renders events on their day as preview buttons', () => {
    const html = renderToStaticMarkup(createElement(VizCalendar, { rows: [row('Plan X', '2026-06-15')], dateField: 'due', ...JUNE }));
    expect(html).toMatch(/<button[^>]*class="cal-ev"[^>]*>Plan X<\/button>/);
  });
  it('shows an undated footer count', () => {
    const r: VizRow = { id: 'u', title: 'u', file_path: 'u', types: ['task'], fields: {} };
    const html = renderToStaticMarkup(createElement(VizCalendar, { rows: [r], dateField: 'due', ...JUNE }));
    expect(html).toContain('1 undated');
  });
  it('renders an empty state when no date field resolves', () => {
    const html = renderToStaticMarkup(createElement(VizCalendar, { rows: [], dateField: null, ...JUNE }));
    expect(html).toContain('No date field');
  });
});

describe('VizCalendar: the field it plots by (#574)', () => {
  it('names the field next to the month', () => {
    render(createElement(VizCalendar, { rows: [], dateField: 'due', ...JUNE }));
    expect(screen.getByText('by due')).toBeDefined();
  });
  it('names the end field too when the view has one', () => {
    render(createElement(VizCalendar, { rows: [], dateField: 'start', endField: 'end', ...JUNE }));
    expect(screen.getByText('by start → end')).toBeDefined();
  });
  it('points an editable view\'s empty state to the Layout menu\'s picker, and not a read-only one\'s', () => {
    render(createElement(VizCalendar, { rows: [], dateField: null, canPickField: true, ...JUNE }));
    expect(screen.getByText('No date field — pick one under Layout › Date field.')).toBeDefined();
    cleanup();
    render(createElement(VizCalendar, { rows: [], dateField: null, ...JUNE }));
    expect(screen.getByText('No date field.')).toBeDefined();
    expect(screen.queryByText(/viz builder/)).toBeNull();
  });
});

describe('VizCalendar: items with a start and an end (#574)', () => {
  it('draws an item with both dates as one bar across its days', () => {
    const { container } = render(createElement(VizCalendar, { rows: [trip('Trip', '2026-06-15', '2026-06-17')], dateField: 'start', endField: 'end', ...JUNE }));
    expect(bars(container)).toEqual([{ title: 'Trip', week: 2, col: 2, span: 3, lane: 0, cls: 'cal-ev' }]);
  });

  it('continues a bar on the next week row, squared off where it goes on', () => {
    const { container } = render(createElement(VizCalendar, { rows: [trip('Trip', '2026-06-18', '2026-06-23')], dateField: 'start', endField: 'end', ...JUNE }));
    expect(bars(container)).toEqual([
      { title: 'Trip', week: 2, col: 5, span: 3, lane: 0, cls: 'cal-ev cont-after' },
      { title: 'Trip', week: 3, col: 1, span: 3, lane: 0, cls: 'cal-ev cont-before' },
    ]);
  });

  it('shows an item whose end is before its start, or without an end, on its start day only', () => {
    const rows = [trip('Typo', '2026-06-18', '2026-06-16'), trip('Open', '2026-06-10')];
    const { container } = render(createElement(VizCalendar, { rows, dateField: 'start', endField: 'end', ...JUNE }));
    expect(bars(container).map((b) => [b.title, b.week, b.col, b.span])).toEqual([['Open', 1, 4, 1], ['Typo', 2, 5, 1]]);
  });

  it('plots by the start day only when the view names no end field', () => {
    const { container } = render(createElement(VizCalendar, { rows: [trip('Trip', '2026-06-15', '2026-06-17')], dateField: 'start', ...JUNE }));
    expect(bars(container).map((b) => b.span)).toEqual([1]);
  });

  it('shows at most 3 items a day, then "+N more", counting spans on each day they cover', () => {
    const rows = [
      trip('Trip', '2026-06-15', '2026-06-17'),
      trip('A', '2026-06-16'), trip('B', '2026-06-16'), trip('C', '2026-06-16'),
    ];
    const { container } = render(createElement(VizCalendar, { rows, dateField: 'start', endField: 'end', ...JUNE }));
    expect(bars(container).map((b) => b.title)).toEqual(['Trip', 'A', 'B']);
    const more = [...container.querySelectorAll<HTMLElement>('.cal-more')];
    expect(more.map((m) => [m.textContent, m.style.gridColumn])).toEqual([['+1 more', '3']]);
  });

  it('opens the item\'s preview from any of its bars', () => {
    const onOpenPreview = vi.fn();
    render(createElement(VizCalendar, { rows: [trip('Trip', '2026-06-18', '2026-06-23')], dateField: 'start', endField: 'end', ...JUNE, onOpenPreview }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Trip' })[1]!);
    expect(onOpenPreview).toHaveBeenCalledWith({ nodeId: 'Trip' });
  });
});

describe('VizCalendar: days in the configured time zone (#574)', () => {
  it('keeps an evening time written without a zone on its own day', () => {
    const { container } = render(createElement(VizCalendar, { rows: [row('Dinner', '2026-06-15T21:00')], dateField: 'due', timeZone: 'America/New_York', ...JUNE }));
    expect(bars(container).map((b) => [b.week, b.col])).toEqual([[2, 2]]);
  });
  it('puts an instant on the day it falls in the configured zone', () => {
    const r = [row('Dinner', '2026-06-16T01:00:00Z')];
    const ny = render(createElement(VizCalendar, { rows: r, dateField: 'due', timeZone: 'America/New_York', ...JUNE }));
    expect(bars(ny.container).map((b) => [b.week, b.col])).toEqual([[2, 2]]);
    cleanup();
    const utc = render(createElement(VizCalendar, { rows: r, dateField: 'due', timeZone: 'UTC', ...JUNE }));
    expect(bars(utc.container).map((b) => [b.week, b.col])).toEqual([[2, 3]]);
  });
});

describe('VizCalendar: the month it opens on follows the zone (#574 review)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('moves to the zone\'s current month when the zone arrives after mount, until the user navigates', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T01:00:00Z')); // June 30, 21:00 in New York
    const props = { rows: [], dateField: 'due', onOpenPreview: () => {} };
    const { rerender, container } = render(createElement(VizCalendar, { ...props, timeZone: 'UTC' }));
    const month = () => container.querySelector('.cal-month')!.textContent;
    expect(month()).toBe('July 2026');
    rerender(createElement(VizCalendar, { ...props, timeZone: 'America/New_York' }));
    expect(month()).toBe('June 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(month()).toBe('August 2026');
    // A month the user moved to stays put when the zone changes again.
    rerender(createElement(VizCalendar, { ...props, timeZone: 'UTC' }));
    expect(month()).toBe('August 2026');
  });
});
