// @vitest-environment jsdom
/**
 * viz-link-counts.test.tsx — #611: a table can show, sort by and filter on each note's link counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CallerFragment } from '@vault/query-core';
import {
  nextTableSort, rowsFromCallResult, showsLinkCounts, tableSortLabel, tableSortOf, vizQueryArgs,
  type VizRow, type VizSpec,
} from '../src/viz-spec.js';
import { sortRows } from '../src/viz-state.js';
import { VizTable } from '../src/VizTable.js';
import { VizSettings } from '../src/VizSettings.js';
import { VizToolbar, activeFilterCount, type VizToolbarQuery } from '../src/VizToolbar.js';
import type { VizQueryVM } from '../src/use-viz-query.js';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SPEC: VizSpec = { kind: 'table', title: 'Notes', query: { types: ['note'] }, display_fields: [] };
const COUNT_SELECT = ['id', 'file_path', 'title', 'version', 'types', 'inlink_count', 'outlink_count', 'unresolved_link_count'];

function row(title: string, incoming: number, outgoing: number, unresolved = 0): VizRow {
  return { id: title, title, file_path: `${title}.md`, types: ['note'], fields: {}, link_counts: { incoming, outgoing, unresolved } };
}

describe('spec helpers', () => {
  it('reads the counts query-nodes returns', () => {
    const text = JSON.stringify({ ok: true, data: { total: 1, nodes: [
      { id: 'a', title: 'Alpha', file_path: 'Alpha.md', types: ['note'], inlink_count: 2, outlink_count: 0, unresolved_link_count: 1 },
      { id: 'b', title: 'Beta', file_path: 'Beta.md', types: ['note'] },
    ] } });
    const result = rowsFromCallResult({ content: [{ type: 'text', text }] });
    if ('error' in result) throw new Error(result.error);
    expect(result.rows[0]!.link_counts).toEqual({ incoming: 2, outgoing: 0, unresolved: 1 });
    expect(result.rows[1]!.link_counts).toBeUndefined();
  });

  it('shows the counts when asked, or while the query sorts or filters by one', () => {
    expect(showsLinkCounts(SPEC)).toBe(false);
    expect(showsLinkCounts({ ...SPEC, show_link_counts: true })).toBe(true);
    expect(showsLinkCounts({ ...SPEC, query: { sort_by: 'inlink_count' } })).toBe(true);
    expect(showsLinkCounts({ ...SPEC, query: { link_counts: { incoming: { lte: 1 } } } })).toBe(true);
    expect(showsLinkCounts({ ...SPEC, query: { where: { any: [{ link_counts: { incoming: { lte: 1 } } }, { link_counts: { outgoing: { lte: 1 } } }] } } })).toBe(true);
    expect(showsLinkCounts({ ...SPEC, show_link_counts: false, query: { sort_by: 'inlink_count' } })).toBe(false);
    expect(showsLinkCounts({ ...SPEC, kind: 'kanban', show_link_counts: true })).toBe(false);
  });

  it('selects the counts only for a table showing them', () => {
    expect(vizQueryArgs(SPEC)).not.toHaveProperty('select');
    expect(vizQueryArgs({ ...SPEC, show_link_counts: true }).select).toEqual(COUNT_SELECT);
  });

  it('sorts a link-count column on the Engine, or on the loaded rows during a search', () => {
    const shown = { ...SPEC, show_link_counts: true };
    expect(nextTableSort(shown, 'inlink_count')).toEqual({ key: 'inlink_count', order: 'asc', client: false });
    expect(nextTableSort({ ...shown, query: { sort_by: 'inlink_count', sort_order: 'asc' } }, 'inlink_count'))
      .toEqual({ key: 'inlink_count', order: 'desc', client: false });
    expect(nextTableSort({ ...shown, query: { query: 'plans' } }, 'outlink_count', true).client).toBe(true);
  });

  it('keeps a saved link-count column sort only while the columns show', () => {
    const sorted: VizSpec = { ...SPEC, show_link_counts: true, column_sort: { field: 'outlink_count', order: 'desc' } };
    expect(tableSortOf(sorted)).toEqual({ key: 'outlink_count', order: 'desc', client: true });
    expect(tableSortOf({ ...sorted, show_link_counts: false })).toEqual({ key: 'title', order: 'asc', client: false });
  });

  it('names link-count sorts in plain words', () => {
    expect(tableSortLabel({ key: 'inlink_count', order: 'asc', client: false })).toBe('Fewest links in');
    expect(tableSortLabel({ key: 'unresolved_link_count', order: 'asc', client: false })).toBe('Unresolved links ↑');
    expect(tableSortLabel({ key: 'outlink_count', order: 'desc', client: true })).toBe('Links out ↓');
  });

  it('sorts loaded rows by a count as a number, ties by title', () => {
    const rows = [row('Gamma', 10, 0), row('Alpha', 9, 0), row('Beta', 10, 0)];
    expect(sortRows(rows, { key: 'inlink_count', dir: 1 }).map((r) => r.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(sortRows(rows, { key: 'inlink_count', dir: -1 }).map((r) => r.title)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });
});

describe('VizTable link-count columns', () => {
  const rows = [row('Alpha', 2, 1, 3), row('Beta', 0, 0)];

  it('renders the three columns only when asked', () => {
    const { container, rerender } = render(<VizTable rows={rows} displayFields={[]} groupField="" />);
    expect(container.querySelectorAll('th.c-link-count')).toHaveLength(0);
    rerender(<VizTable rows={rows} displayFields={[]} groupField="" showLinkCounts />);
    const headers = [...container.querySelectorAll('th.c-link-count')].map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Links in', 'Links out', 'Unresolved links']);
    const alpha = [...container.querySelectorAll('tbody tr')][0]!;
    expect([...alpha.querySelectorAll('td.c-link-count')].map((td) => td.textContent)).toEqual(['2', '1', '3']);
  });

  it('asks the host to sort by a clicked count, and shows its arrow for an Engine sort', () => {
    const onSort = vi.fn();
    const { container } = render(
      <VizTable rows={rows} displayFields={[]} groupField="" showLinkCounts onSort={onSort} sort={{ key: 'outlink_count', order: 'desc', client: false }} />,
    );
    fireEvent.click(screen.getByText('Links in'));
    expect(onSort).toHaveBeenCalledWith('inlink_count');
    const outHeader = [...container.querySelectorAll('th.c-link-count')][1]!;
    expect(within(outHeader as HTMLElement).getByLabelText('sorted descending')).toBeDefined();
  });
});

describe('Layout: Link counts toggle', () => {
  it('turns the columns on and off', () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={SPEC} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }));
    const box = screen.getByRole('checkbox', { name: 'Link counts' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onSpecChange).toHaveBeenCalledWith({ ...SPEC, show_link_counts: true });
  });

  it('reads as on while the view sorts by a count', () => {
    render(<VizSettings spec={{ ...SPEC, query: { sort_by: 'inlink_count' } }} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }));
    expect((screen.getByRole('checkbox', { name: 'Link counts' }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('Filter: link-count rows', () => {
  function makeQuery(strip: Record<string, unknown> = {}, fragments: CallerFragment[] = []): VizToolbarQuery {
    const vm = {
      strip: { limit: 50, query: '', title_contains: '', sort_by: 'title', sort_order: 'asc', ...strip },
      lockedType: null,
      chips: [],
      fragments,
      setStrip: vi.fn(),
      setTypeLock: vi.fn(),
      setSort: vi.fn(),
      removeFragment: vi.fn(),
    } as unknown as VizQueryVM;
    return { spec: SPEC, onSpecChange: vi.fn(), vm, schema: null, availableTypes: ['note'], addableSchemaFields: [] };
  }
  function openFilter(query: VizToolbarQuery) {
    render(<VizToolbar kind="table" onKind={vi.fn()} shown={2} total={2} loading={false} onRefresh={vi.fn()} query={query} />);
    fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
  }

  it('sets a comparison, starting "≤ 1"', () => {
    const query = makeQuery();
    openFilter(query);
    fireEvent.click(screen.getByRole('button', { name: /\+ filter/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'links in' }));
    fireEvent.change(screen.getByLabelText('links in comparison'), { target: { value: 'lte' } });
    expect(query.vm.setStrip).toHaveBeenCalledWith(expect.objectContaining({ link_counts: { incoming: { op: 'lte', value: 1 } } }));
  });

  it('edits the count and clears the rule with "any"', () => {
    const query = makeQuery({ link_counts: { outgoing: { op: 'gte', value: 1 } } });
    openFilter(query);
    fireEvent.change(screen.getByLabelText('links out count'), { target: { value: '3' } });
    expect(query.vm.setStrip).toHaveBeenLastCalledWith(expect.objectContaining({ link_counts: { outgoing: { op: 'gte', value: 3 } } }));
    fireEvent.change(screen.getByLabelText('links out comparison'), { target: { value: '' } });
    expect(query.vm.setStrip).toHaveBeenLastCalledWith(expect.objectContaining({ link_counts: undefined }));
  });

  it('counts each rule on the Filter badge', () => {
    const query = makeQuery({ link_counts: { incoming: { op: 'lte', value: 1 }, unresolved: { op: 'gte', value: 1 } } });
    expect(activeFilterCount(query.vm)).toBe(2);
  });

  it('shows a filter the rows cannot edit as a removable chip instead', () => {
    const fragment: CallerFragment = { id: 7, key: 'link_counts', payload: { rel_type: 'project', incoming: { lte: 1 } }, scope: 'global' };
    const query = makeQuery({}, [fragment]);
    openFilter(query);
    expect(screen.queryByLabelText('links in comparison')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'remove filter links in ≤ 1, via project' }));
    expect(query.vm.removeFragment).toHaveBeenCalledWith(7);
  });
});
