// @vitest-environment jsdom
/**
 * #573: Table and List rows grouped into sections by the view's group_by, picked from the Layout
 * menu (Table, List and Kanban). A date field gives one section per day; folded sections are
 * saved on the view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Envelope, Schema, TypeSummary } from '@vault/query-core';
import type { VizKind, VizRow, VizSpec } from '../src/viz-spec.js';
import { foldedGroups, groupByOptions, groupsByDay, sectionField, specWithFoldToggled, specWithGroupBy } from '../src/viz-spec.js';
import { groupRows } from '../src/viz-state.js';

vi.mock('../src/use-viz-data.js', () => ({
  useVizData: vi.fn(() => ({ rows: [], total: 0, loading: false, error: null, refresh: vi.fn() })),
}));
vi.mock('../src/use-viz-refs.js', () => ({ useVizRefFields: vi.fn(() => new Set<string>()) }));

import { _resetCachesForTest } from '../src/use-viz-schema.js';
import { VizCardView } from '../src/VizCard.js';
import { VizClientProvider } from '../src/viz-client-context.js';

const field = (name: string, type: string) => ({ name, type, required: false, default_value: null, ui: null });
const TASK: Schema = { name: 'task', display_name: 'Task', fields: [field('status', 'enum'), field('project', 'reference'), field('due', 'date')] } as unknown as Schema;
const SCHEMAS = new Map<string, Schema>([['task', TASK]]);
const ok = <T,>(data: T): Envelope<T> => ({ ok: true, data, warnings: [] });

const client = {
  describeSchema: vi.fn(async () => ok(TASK)),
  listTypes: vi.fn(async () => ok<TypeSummary[]>([{ type: 'task', count: 5, has_schema: true, claim_count: null }])),
  queryNodes: vi.fn(), describeGlobalField: vi.fn(), listFieldValues: vi.fn(), updateNode: vi.fn(), renameNode: vi.fn(),
  getNode: vi.fn(), createNode: vi.fn(), deleteNode: vi.fn(), batchMutate: vi.fn(),
};

beforeEach(() => {
  _resetCachesForTest();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const task = (id: string, fields: Record<string, unknown>): VizRow => ({ id, title: id, file_path: `${id}.md`, types: ['task'], fields });
const ROWS: VizRow[] = [
  task('Alpha', { status: 'done', project: 'Northwind', due: '2026-11-17' }),
  task('Bravo', { status: 'open', project: 'Acme', due: '2026-11-16T09:00' }),
  task('Charlie', { status: 'open', due: '2026-11-16' }),
  task('Delta', { status: 'next', project: 'Acme' }),
];
const SPEC: VizSpec = { kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: ['status'] };

function renderCard(spec: VizSpec, opts: { onSpecChange?: (next: VizSpec) => void; rows?: VizRow[]; kind?: VizKind } = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client, timeZone: 'America/New_York' }, children);
  return render(
    <VizCardView spec={spec} kind={opts.kind ?? spec.kind} rows={opts.rows ?? ROWS} total={ROWS.length} loading={false} error={null}
      onKind={vi.fn()} onRefresh={vi.fn()} onSpecChange={opts.onSpecChange} />,
    { wrapper },
  );
}

const sectionNames = () => [...document.querySelectorAll('.vsection-head')].map((h) => [
  h.querySelector('.vsection-label')!.textContent, h.querySelector('.vsection-count')!.textContent,
]);
const rowTitles = (container: HTMLElement) => [...container.querySelectorAll('tbody tr:not(.vsection-row) td.c-title')].map((td) => td.textContent);
const optionValues = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.value);

describe('spec helpers', () => {
  it('only tables and lists with a group_by have sections', () => {
    expect(sectionField({ kind: 'table', group_by: 'status' })).toBe('status');
    expect(sectionField({ kind: 'list', group_by: 'project' })).toBe('project');
    expect(sectionField({ kind: 'table' })).toBeNull();
    expect(sectionField({ kind: 'kanban', group_by: 'status' })).toBeNull();
    expect(sectionField({ kind: 'calendar', group_by: 'status' })).toBeNull();
  });

  it('picking a group field (or None) drops the folded sections', () => {
    const spec: VizSpec = { ...SPEC, group_by: 'status', collapsed_groups: ['done'] };
    expect(specWithGroupBy(spec, 'project')).toEqual({ ...SPEC, group_by: 'project' });
    expect(specWithGroupBy(spec, null)).toEqual(SPEC);
  });

  it('folds and opens a section, leaving no empty list behind', () => {
    const spec: VizSpec = { ...SPEC, group_by: 'status' };
    const folded = specWithFoldToggled(spec, 'done');
    expect(folded.collapsed_groups).toEqual(['done']);
    expect(specWithFoldToggled(specWithFoldToggled(folded, ''), 'done').collapsed_groups).toEqual(['']);
    expect(specWithFoldToggled(folded, 'done')).toEqual(spec);
  });

  it('reads a malformed collapsed_groups as nothing folded', () => {
    expect(foldedGroups({ collapsed_groups: 'done' as unknown as string[] })).toEqual([]);
    expect(foldedGroups({ collapsed_groups: ['done', 3 as unknown as string] })).toEqual(['done']);
  });

  it("offers the view's type's fields, or the loaded rows' fields without a type", () => {
    expect(groupByOptions(['task'], SCHEMAS, [], null)).toEqual(['status', 'project', 'due']);
    expect(groupByOptions(['task'], SCHEMAS, [], 'area')).toEqual(['status', 'project', 'due', 'area']);
    expect(groupByOptions([], SCHEMAS, ['status', 'owner'], null)).toEqual(['status', 'owner']);
  });

  it('groups by day for a date field, or a field no schema names whose values are days', () => {
    expect(groupsByDay('due', ['task'], SCHEMAS, [])).toBe(true);
    expect(groupsByDay('status', ['task'], SCHEMAS, ROWS)).toBe(false);
    const rows = [task('a', { when: '2026-11-16T10:00' }), task('b', { when: '' }), task('c', { when: '2026-11-18' })];
    expect(groupsByDay('when', ['task'], SCHEMAS, rows)).toBe(true);
    expect(groupsByDay('when', ['task'], SCHEMAS, [...rows, task('d', { when: 'soon' })])).toBe(false);
    expect(groupsByDay('when', ['task'], SCHEMAS, [task('e', {})])).toBe(false);
  });
});

describe('groupRows by day', () => {
  it('puts every time on one day together, oldest day first, no date last', () => {
    const rows = [
      task('a', { due: '2026-11-17' }),
      task('b', { due: '2026-11-16T21:00' }),
      task('c', {}),
      task('d', { due: '2026-11-16' }),
      task('e', { due: '2026-11-17T03:30:00Z' }), // 22:30 on the 16th in New York
    ];
    const groups = groupRows(rows, 'due', undefined, 'America/New_York');
    expect(groups.map((g) => [g.value, g.rows.map((r) => r.id)])).toEqual([
      ['2026-11-16', ['b', 'd', 'e']],
      ['2026-11-17', ['a']],
      ['', ['c']],
    ]);
    expect(groups[2]!.label).toBe('—');
  });

  it('keeps the joined text without a time zone, as kanban does', () => {
    const groups = groupRows([task('a', { due: '2026-11-16T09:00' }), task('b', { due: '2026-11-16' })], 'due');
    expect(groups.map((g) => g.value)).toEqual(['2026-11-16', '2026-11-16T09:00']);
  });
});

describe('table sections', () => {
  it('a table without group_by stays one run of rows', () => {
    const { container } = renderCard(SPEC);
    expect(container.querySelector('.vsection-head')).toBeNull();
    expect(rowTitles(container)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('shows one section per value in status order, with its count, and rows in order within', () => {
    const { container } = renderCard({ ...SPEC, group_by: 'status' });
    expect(sectionNames()).toEqual([['open', '2'], ['next', '1'], ['done', '1']]);
    expect(rowTitles(container)).toEqual(['Bravo', 'Charlie', 'Delta', 'Alpha']);
  });

  it('puts rows with no value in a last "—" section', () => {
    renderCard({ ...SPEC, group_by: 'project' });
    expect(sectionNames()).toEqual([['Acme', '2'], ['Northwind', '1'], ['—', '1']]);
  });

  it('groups a date field by day', async () => {
    renderCard({ ...SPEC, group_by: 'due' });
    await waitFor(() => expect(sectionNames()).toEqual([['2026-11-16', '2'], ['2026-11-17', '1'], ['—', '1']]));
  });

  it('folding a section saves it on the view and hides its rows', () => {
    const onSpecChange = vi.fn();
    const { container, rerender } = renderCard({ ...SPEC, group_by: 'status' }, { onSpecChange });
    fireEvent.click(screen.getByRole('button', { name: 'open section' }));
    expect(onSpecChange).toHaveBeenLastCalledWith({ ...SPEC, group_by: 'status', collapsed_groups: ['open'] });

    const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client }, children);
    rerender(wrapper({ children: (
      <VizCardView spec={{ ...SPEC, group_by: 'status', collapsed_groups: ['open'] }} kind="table" rows={ROWS} total={4} loading={false} error={null}
        onKind={vi.fn()} onRefresh={vi.fn()} onSpecChange={onSpecChange} />
    ) }));
    expect(screen.getByRole('button', { name: 'open section' }).getAttribute('aria-expanded')).toBe('false');
    expect(sectionNames()).toEqual([['open', '2'], ['next', '1'], ['done', '1']]);
    expect(rowTitles(container)).toEqual(['Delta', 'Alpha']);
  });

  it('folds and reopens the "—" section when it is the only one folded', () => {
    const spec: VizSpec = { ...SPEC, group_by: 'project' };
    const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client }, children);
    const view = (s: VizSpec) => wrapper({ children: (
      <VizCardView spec={s} kind="table" rows={ROWS} total={4} loading={false} error={null}
        onKind={vi.fn()} onRefresh={vi.fn()} onSpecChange={vi.fn()} />
    ) });
    const { container, rerender } = render(view(spec));
    expect(rowTitles(container)).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
    rerender(view({ ...spec, collapsed_groups: [''] }));
    expect(rowTitles(container)).toEqual(['Bravo', 'Delta', 'Alpha']);
    rerender(view(spec));
    expect(rowTitles(container)).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
  });

  it('a view that cannot be saved folds the "—" section too', () => {
    const { container } = renderCard({ ...SPEC, group_by: 'project' });
    fireEvent.click(screen.getByRole('button', { name: '— section' }));
    expect(rowTitles(container)).toEqual(['Bravo', 'Delta', 'Alpha']);
    fireEvent.click(screen.getByRole('button', { name: '— section' }));
    expect(rowTitles(container)).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
  });

  it('a view that cannot be saved folds sections while it stays open', () => {
    const { container } = renderCard({ ...SPEC, group_by: 'status' });
    fireEvent.click(screen.getByRole('button', { name: 'done section' }));
    expect(rowTitles(container)).toEqual(['Bravo', 'Charlie', 'Delta']);
    fireEvent.click(container.querySelector('.vsection-head.folded')!);
    expect(rowTitles(container)).toEqual(['Bravo', 'Charlie', 'Delta', 'Alpha']);
  });

  it('numbers rows across sections, unchanged by a fold', () => {
    const spec: VizSpec = { ...SPEC, group_by: 'status', show_row_numbers: true, collapsed_groups: ['open'] };
    const { container } = renderCard(spec, { onSpecChange: vi.fn() });
    expect([...container.querySelectorAll('td.c-rownum')].map((td) => td.textContent)).toEqual(['3', '4']);
  });

  it('select-all takes only the rows on screen', async () => {
    const onSpecChange = vi.fn();
    const { container } = renderCard({ ...SPEC, group_by: 'status', collapsed_groups: ['open'] }, { onSpecChange });
    fireEvent.click(screen.getByRole('checkbox', { name: 'select all' }));
    const ticked = [...container.querySelectorAll<HTMLInputElement>('td.c-bulk-check input')].filter((b) => b.checked);
    expect(ticked).toHaveLength(2);
    expect(screen.getByText(/2 selected/)).toBeDefined();
  });

  it('Tab order runs over the rows on screen, section by section', () => {
    const { container } = renderCard({ ...SPEC, group_by: 'status', collapsed_groups: ['next'] }, { onSpecChange: vi.fn() });
    const keys = [...container.querySelectorAll('td.c-title')].map((td) => [td.getAttribute('data-cell-key'), td.textContent]);
    expect(keys).toEqual([['0:0', 'Bravo'], ['1:0', 'Charlie'], ['2:0', 'Alpha']]);
  });

  it('a column sort orders the rows within each section', () => {
    const rows = [
      task('Echo', { status: 'open', project: 'Zeta' }),
      task('Foxtrot', { status: 'done', project: 'Beta' }),
      task('Golf', { status: 'open', project: 'Alpha' }),
    ];
    const spec: VizSpec = { ...SPEC, display_fields: ['status', 'project'], group_by: 'status', column_sort: { field: 'project', order: 'asc' } };
    const { container } = renderCard(spec, { onSpecChange: vi.fn(), rows });
    expect(rowTitles(container)).toEqual(['Golf', 'Echo', 'Foxtrot']);
  });
});

describe('sections over a cut-off result', () => {
  const card = (spec: VizSpec, total: number, onSpecChange?: (next: VizSpec) => void) => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client }, children);
    return render(
      <VizCardView spec={spec} kind={spec.kind} rows={ROWS} total={total} loading={false} error={null}
        onKind={vi.fn()} onRefresh={vi.fn()} onSpecChange={onSpecChange} />,
      { wrapper },
    );
  };
  const note = () => screen.queryByRole('note')?.textContent ?? null;

  it('says the sections cover only the loaded rows', () => {
    card({ ...SPEC, group_by: 'status' }, 200);
    expect(note()).toBe('Grouped within the 4 loaded rows, not all 200.');
  });

  it('says so on a list, and on a view that cannot be saved', () => {
    card({ ...SPEC, kind: 'list', group_by: 'status' }, 9);
    expect(note()).toBe('Grouped within the 4 loaded rows, not all 9.');
  });

  it('names a column sort in the same line', () => {
    card({ ...SPEC, display_fields: ['status', 'project'], group_by: 'status', column_sort: { field: 'project', order: 'asc' } }, 200, vi.fn());
    expect(note()).toBe('Sorted by project and grouped within the 4 loaded rows, not all 200.');
  });

  it('says nothing when every row loaded, or without sections, or on a kanban', () => {
    card({ ...SPEC, group_by: 'status' }, 4);
    expect(note()).toBeNull();
    cleanup();
    card(SPEC, 200);
    expect(note()).toBeNull();
    cleanup();
    card({ ...SPEC, kind: 'kanban', group_by: 'status' }, 200);
    expect(note()).toBeNull();
  });
});

describe('list sections', () => {
  it('groups the list by its group_by, and folds a section', () => {
    const { container } = renderCard({ ...SPEC, kind: 'list', group_by: 'project' });
    expect(sectionNames()).toEqual([['Acme', '2'], ['Northwind', '1'], ['—', '1']]);
    fireEvent.click(screen.getByRole('button', { name: 'Acme section' }));
    expect([...container.querySelectorAll('.vtask .ttext')].map((t) => t.textContent)).toEqual(['Alpha', 'Charlie']);
  });

  it('a list without group_by has no sections', () => {
    const { container } = renderCard({ ...SPEC, kind: 'list' });
    expect(container.querySelector('.vsection-head')).toBeNull();
    expect(container.querySelectorAll('.vtask')).toHaveLength(4);
  });
});

describe('Layout menu: Group by', () => {
  it('a table offers None and its type\'s fields, and saves the pick as group_by', async () => {
    const onSpecChange = vi.fn();
    renderCard({ ...SPEC, group_by: 'status', collapsed_groups: ['done'] }, { onSpecChange });
    fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' }));
    const select = screen.getByRole('combobox', { name: 'Group by' }) as HTMLSelectElement;
    await waitFor(() => expect(optionValues(select)).toEqual(['', 'status', 'project', 'due']));
    expect(select.value).toBe('status');
    fireEvent.change(select, { target: { value: 'project' } });
    expect(onSpecChange).toHaveBeenLastCalledWith({ ...SPEC, group_by: 'project' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onSpecChange).toHaveBeenLastCalledWith(SPEC);
  });

  it('a list offers None too, and a table without group_by reads None', () => {
    renderCard({ ...SPEC, kind: 'list' }, { onSpecChange: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Layout: List' }));
    const select = screen.getByRole('combobox', { name: 'Group by' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: 'None' })).toBeDefined();
  });

  it('a kanban has no None and shows its default column field', async () => {
    renderCard({ ...SPEC, kind: 'kanban' }, { onSpecChange: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Layout: Kanban' }));
    const select = screen.getByRole('combobox', { name: 'Group by' }) as HTMLSelectElement;
    await waitFor(() => expect(optionValues(select)).toEqual(['status', 'project', 'due']));
    expect(select.value).toBe('status');
  });

  it('a calendar has no Group by, and a read-only view no Layout settings', () => {
    renderCard({ ...SPEC, kind: 'calendar' }, { onSpecChange: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Layout: Calendar' }));
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();
    cleanup();
    renderCard({ ...SPEC, group_by: 'status' });
    fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' }));
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();
  });

  it('the menu stays open after switching to List or Kanban, to reach Group by', () => {
    const onKind = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client }, children);
    render(
      <VizCardView spec={SPEC} kind="table" rows={ROWS} total={4} loading={false} error={null}
        onKind={onKind} onRefresh={vi.fn()} onSpecChange={vi.fn()} />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /List/ }));
    expect(onKind).toHaveBeenCalledWith('list');
    expect(screen.getByRole('menu', { name: 'Layout' })).toBeDefined();
  });
});
