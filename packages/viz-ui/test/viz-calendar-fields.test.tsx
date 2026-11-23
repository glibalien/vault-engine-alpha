// @vitest-environment jsdom
/**
 * #574: a calendar's Layout menu has Date field and End field pickers listing the date fields of
 * the view's types, and saves the choice on the view. The calendar takes days in the host's
 * configured time zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Envelope, Schema, TypeSummary } from '@vault/query-core';
import type { VizRow, VizSpec } from '../src/viz-spec.js';

vi.mock('../src/use-viz-data.js', () => ({
  useVizData: vi.fn(() => ({ rows: [], total: 0, loading: false, error: null, refresh: vi.fn() })),
}));
vi.mock('../src/use-viz-refs.js', () => ({ useVizRefFields: vi.fn(() => new Set<string>()) }));

import { _resetCachesForTest } from '../src/use-viz-schema.js';
import { VizCardView } from '../src/VizCard.js';
import { VizClientProvider } from '../src/viz-client-context.js';

const field = (name: string, type: string) => ({ name, type, required: false, default_value: null, ui: null });
const SCHEMAS: Record<string, Schema> = {
  trip: { name: 'trip', display_name: 'Trip', fields: [field('start', 'date'), field('place', 'string'), field('end', 'date')] } as unknown as Schema,
  task: { name: 'task', display_name: 'Task', fields: [field('due', 'date'), field('status', 'enum')] } as unknown as Schema,
};
const ok = <T,>(data: T): Envelope<T> => ({ ok: true, data, warnings: [] });

const client = {
  describeSchema: vi.fn(async (type: string) => ok(SCHEMAS[type]!)),
  listTypes: vi.fn(async () => ok<TypeSummary[]>([
    { type: 'trip', count: 3, has_schema: true, claim_count: null },
    { type: 'task', count: 5, has_schema: true, claim_count: null },
  ])),
  queryNodes: vi.fn(), describeGlobalField: vi.fn(), listFieldValues: vi.fn(), updateNode: vi.fn(), renameNode: vi.fn(),
  getNode: vi.fn(), createNode: vi.fn(), deleteNode: vi.fn(), batchMutate: vi.fn(),
};

beforeEach(() => { _resetCachesForTest(); });
afterEach(cleanup);

const SPEC: VizSpec = { kind: 'calendar', title: 'Trips', query: { types: ['trip'] }, display_fields: [] };
const trip = (id: string, fields: Record<string, unknown>): VizRow => ({ id, title: id, file_path: `${id}.md`, types: ['trip'], fields });

function renderCard(spec: VizSpec, opts: { onSpecChange?: (next: VizSpec) => void; rows?: VizRow[]; timeZone?: string } = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client, timeZone: opts.timeZone }, children);
  return render(
    <VizCardView spec={spec} kind="calendar" rows={opts.rows ?? []} total={0} loading={false} error={null}
      onKind={vi.fn()} onRefresh={vi.fn()} onSpecChange={opts.onSpecChange} />,
    { wrapper },
  );
}

const openLayout = () => fireEvent.click(screen.getByRole('button', { name: 'Layout: Calendar' }));
const options = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.value);

describe('calendar Layout menu: Date field and End field (#574)', () => {
  it('lists the date fields of the view\'s types and saves the picked one as date_field', async () => {
    const onSpecChange = vi.fn();
    renderCard(SPEC, { onSpecChange });
    openLayout();
    const date = screen.getByRole('combobox', { name: 'Date field' });
    await waitFor(() => expect(options(date)).toEqual(['', 'start', 'end']));
    fireEvent.change(date, { target: { value: 'start' } });
    expect(onSpecChange).toHaveBeenCalledWith({ ...SPEC, date_field: 'start' });
  });

  it('saves an end field, and None removes it', async () => {
    const onSpecChange = vi.fn();
    const spec = { ...SPEC, date_field: 'start', end_date_field: 'end' };
    renderCard(spec, { onSpecChange });
    openLayout();
    const end = screen.getByRole('combobox', { name: 'End field' }) as HTMLSelectElement;
    await waitFor(() => expect(options(end)).toEqual(['', 'end']));
    expect(end.value).toBe('end');
    fireEvent.change(end, { target: { value: '' } });
    expect(onSpecChange).toHaveBeenLastCalledWith({ ...SPEC, date_field: 'start' });
  });

  it('drops the end field when it is picked as the date field', async () => {
    const onSpecChange = vi.fn();
    renderCard({ ...SPEC, date_field: 'start', end_date_field: 'end' }, { onSpecChange });
    openLayout();
    const date = screen.getByRole('combobox', { name: 'Date field' });
    await waitFor(() => expect(options(date)).toEqual(['start', 'end']));
    fireEvent.change(date, { target: { value: 'end' } });
    expect(onSpecChange).toHaveBeenCalledWith({ ...SPEC, date_field: 'end' });
  });

  it('shows the field today\'s fallback found when the view saves none, and keeps it in the list', async () => {
    renderCard({ ...SPEC, query: { types: ['task'] } }, { onSpecChange: vi.fn(), rows: [trip('Call', { date: '2026-06-15' })] });
    expect(screen.getByText('by date')).toBeDefined();
    openLayout();
    const date = screen.getByRole('combobox', { name: 'Date field' }) as HTMLSelectElement;
    expect(date.value).toBe('date');
    await waitFor(() => expect(options(date)).toEqual(['due', 'date']));
  });

  it('points the empty state to the picker', () => {
    renderCard(SPEC, { onSpecChange: vi.fn() });
    expect(screen.getByText('No date field — pick one under Layout › Date field.')).toBeDefined();
  });

  it('has no pickers on a read-only card, whose empty state names no picker', () => {
    renderCard(SPEC);
    openLayout();
    expect(screen.queryByRole('combobox', { name: 'Date field' })).toBeNull();
    expect(screen.getByText('No date field.')).toBeDefined();
  });

  it('keeps the menu open on switching to Calendar, as for Table, so a field can be picked next', () => {
    const onKind = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client }, children);
    render(
      <VizCardView spec={{ ...SPEC, kind: 'kanban' }} kind="kanban" rows={[]} total={0} loading={false} error={null}
        onKind={onKind} onRefresh={vi.fn()} onSpecChange={vi.fn()} />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout: Kanban' }));
    const menu = screen.getByRole('menu', { name: 'Layout' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Calendar' }));
    expect(onKind).toHaveBeenCalledWith('calendar');
    expect(screen.getByRole('menu', { name: 'Layout' })).toBeDefined();
  });
});

describe('calendar time zone from the host (#574)', () => {
  it('takes days in the zone the host passes', () => {
    const rows = [trip('Dinner', { start: '2026-06-16T01:00:00Z' })];
    const spec = { ...SPEC, date_field: 'start' };
    const { container } = renderCard(spec, { rows, timeZone: 'America/New_York' });
    // Navigate to June 2026 from whatever month today is.
    const month = () => container.querySelector('.cal-month')!.textContent!;
    const target = 2026 * 12 + 5;
    const [name, year] = month().split(' ');
    const now = Number(year) * 12 + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(name!);
    const step = screen.getByRole('button', { name: target < now ? 'Previous month' : 'Next month' });
    for (let i = 0; i < Math.abs(target - now); i++) fireEvent.click(step);
    expect(month()).toBe('June 2026');
    const bar = screen.getByRole('button', { name: 'Dinner' });
    // Monday 15 June in New York (01:00 UTC on the 16th).
    expect(bar.style.gridColumn).toBe('2 / span 1');
  });
});
