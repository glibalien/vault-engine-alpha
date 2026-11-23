import { describe, expect, it } from 'vitest';
import {
  nextTableSort, serverSortOf, specForTypeChange, tableSortLabel, tableSortOf, withoutColumnSort,
  type VizSpec,
} from '../src/viz-spec.js';
import { parseBoardCardSpec } from '../src/board-card-spec.js';
import { vizWithDisplayFields } from '../src/viz-query.js';

const base: VizSpec = { kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: ['status', 'due'] };

describe('tableSortOf — one sort per table view (#393)', () => {
  it('a view with no sort shows the query order: the Engine default, title ascending', () => {
    expect(tableSortOf(base)).toEqual({ key: 'title', order: 'asc', client: false });
  });

  it("reads the query's server sort", () => {
    expect(tableSortOf({ ...base, query: { sort_by: 'file_mtime', sort_order: 'desc' } }))
      .toEqual({ key: 'file_mtime', order: 'desc', client: false });
  });

  it('a saved column sort on a shown column wins over the server sort', () => {
    const spec: VizSpec = { ...base, query: { sort_by: 'file_mtime', sort_order: 'desc' }, column_sort: { field: 'status', order: 'desc' } };
    expect(tableSortOf(spec)).toEqual({ key: 'status', order: 'desc', client: true });
  });

  it('ignores a column sort on a column the view no longer shows, or a malformed one', () => {
    expect(tableSortOf({ ...base, column_sort: { field: 'priority', order: 'asc' } })?.client).toBe(false);
    expect(tableSortOf({ ...base, column_sort: { field: 'status', order: 'up' } as never })?.client).toBe(false);
    expect(tableSortOf({ ...base, column_sort: 'status' as never })?.client).toBe(false);
  });

  it('a search ranks by relevance (query-nodes ignores sort_by), so there is no server sort', () => {
    expect(tableSortOf({ ...base, query: { query: 'budget', sort_by: 'title' } })).toBeNull();
    expect(tableSortOf({ ...base, query: { query: 'budget', sort_by: 'title' } }, true)).toBeNull();
    expect(tableSortOf({ ...base, query: { query: 'budget' }, column_sort: { field: 'title', order: 'asc' } }))
      .toEqual({ key: 'title', order: 'asc', client: true });
  });

  it('a search the Engine could not rank (no embedder) keeps the server sort', () => {
    expect(tableSortOf({ ...base, query: { query: 'budget', sort_by: 'title', sort_order: 'desc' } }, false))
      .toEqual({ key: 'title', order: 'desc', client: false });
  });
});

describe('nextTableSort — a header click', () => {
  it('Name sorts on the Engine; clicking the sorted column flips its direction', () => {
    expect(nextTableSort({ ...base, query: { sort_by: 'file_mtime', sort_order: 'desc' } }, 'title'))
      .toEqual({ key: 'title', order: 'asc', client: false });
    expect(nextTableSort(base, 'title')).toEqual({ key: 'title', order: 'desc', client: false });
    expect(nextTableSort({ ...base, query: { sort_by: 'title', sort_order: 'desc' } }, 'title'))
      .toEqual({ key: 'title', order: 'asc', client: false });
  });

  it('any other column sorts the loaded rows on the client, ascending first', () => {
    expect(nextTableSort(base, 'status')).toEqual({ key: 'status', order: 'asc', client: true });
    const sorted: VizSpec = { ...base, column_sort: { field: 'status', order: 'asc' } };
    expect(nextTableSort(sorted, 'status')).toEqual({ key: 'status', order: 'desc', client: true });
    expect(nextTableSort(sorted, 'due')).toEqual({ key: 'due', order: 'asc', client: true });
    expect(nextTableSort(sorted, 'title')).toEqual({ key: 'title', order: 'asc', client: false });
  });

  it('during a ranked search Name sorts the loaded rows too; unranked, it still sorts on the Engine', () => {
    expect(nextTableSort({ ...base, query: { query: 'budget' } }, 'title')).toEqual({ key: 'title', order: 'asc', client: true });
    expect(nextTableSort({ ...base, query: { query: 'budget' } }, 'title', true)).toEqual({ key: 'title', order: 'asc', client: true });
    expect(nextTableSort({ ...base, query: { query: 'budget' } }, 'title', false)).toEqual({ key: 'title', order: 'desc', client: false });
  });
});

describe('labels and cleanup', () => {
  it('names server sorts like the toolbar options and column sorts by column', () => {
    expect(tableSortLabel({ key: 'file_mtime', order: 'desc', client: false })).toBe('Newest first');
    expect(tableSortLabel({ key: 'title', order: 'asc', client: false })).toBe('Title A–Z');
    expect(tableSortLabel({ key: 'indexed_at', order: 'asc', client: false })).toBe('indexed_at ↑');
    expect(tableSortLabel({ key: 'status', order: 'desc', client: true })).toBe('status ↓');
    expect(tableSortLabel({ key: 'title', order: 'asc', client: true })).toBe('Name ↑');
    expect(tableSortLabel(null)).toBe('Relevance');
  });

  it('serverSortOf uses the query-nodes defaults', () => {
    expect(serverSortOf({})).toEqual({ sort_by: 'title', sort_order: 'asc' });
    expect(serverSortOf({ sort_by: 'bogus', sort_order: 'desc' })).toEqual({ sort_by: 'title', sort_order: 'desc' });
  });

  it('withoutColumnSort drops only the column sort and keeps the same object when there is none', () => {
    expect(withoutColumnSort(base)).toBe(base);
    expect(withoutColumnSort({ ...base, column_sort: { field: 'status', order: 'asc' } })).toEqual(base);
  });

  it('removing the sorted column drops its sort; other column changes keep it', () => {
    const sorted: VizSpec = { ...base, column_sort: { field: 'status', order: 'asc' } };
    expect(vizWithDisplayFields(sorted, ['due'])).toEqual({ ...base, display_fields: ['due'] });
    expect(vizWithDisplayFields(sorted, ['status'])).toEqual({ ...sorted, display_fields: ['status'] });
  });

  it('a sort on a shown link-count column survives a properties change (#611)', () => {
    const counted: VizSpec = { ...base, show_link_counts: true, column_sort: { field: 'inlink_count', order: 'asc' } };
    expect(vizWithDisplayFields(counted, ['due'])).toEqual({ ...counted, display_fields: ['due'] });
    const hidden: VizSpec = { ...counted, show_link_counts: false };
    expect(vizWithDisplayFields(hidden, ['due']).column_sort).toBeUndefined();
  });

  it('a type switch drops the column sort with the columns', () => {
    const next = specForTypeChange({ ...base, column_sort: { field: 'status', order: 'asc' } }, 'project');
    expect(next.column_sort).toBeUndefined();
    expect(next.display_fields).toEqual([]);
  });

  it('a saved board card keeps its column sort, and one without it still parses', () => {
    const sorted = { ...base, column_sort: { field: 'status', order: 'desc' } };
    expect(parseBoardCardSpec(JSON.parse(JSON.stringify(sorted)))).toEqual(sorted);
    expect(parseBoardCardSpec(base)).toEqual(base);
  });
});
