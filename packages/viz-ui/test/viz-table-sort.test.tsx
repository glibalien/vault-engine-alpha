// @vitest-environment jsdom
/**
 * One sort per table view (#393): the header arrow, the toolbar's Sort and the saved spec agree.
 * Drives the real VizCard (useVizQuery, toolbar, table) with useVizData stubbed to fixed rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { VizRow, VizSpec } from '../src/viz-spec.js';

const data = vi.hoisted(() => ({ rows: [] as VizRow[], total: 0, ranked: false }));
vi.mock('../src/use-viz-data.js', () => ({
  useVizData: vi.fn(() => ({ rows: data.rows, total: data.total, ranked: data.ranked, loading: false, error: null, refresh: vi.fn() })),
}));
vi.mock('../src/use-viz-refs.js', () => ({ useVizRefFields: vi.fn(() => new Set<string>()) }));

import { VizCard } from '../src/VizCard.js';
import { VizClientProvider } from '../src/viz-client-context.js';
import { _resetCachesForTest } from '../src/use-viz-schema.js';

const SCHEMA = {
  name: 'task', display_name: 'Task',
  fields: [{ name: 'status', type: 'enum', required: false, default_value: null, enum_values: ['open', 'done'], ui: null }],
};
const client = {
  queryNodes: vi.fn(),
  describeSchema: vi.fn(async () => ({ ok: true, data: SCHEMA, warnings: [] })),
  describeGlobalField: vi.fn(),
  listFieldValues: vi.fn(),
  updateNode: vi.fn(),
  renameNode: vi.fn(),
  getNode: vi.fn(),
  createNode: vi.fn(),
  deleteNode: vi.fn(),
  batchMutate: vi.fn(),
  listTypes: vi.fn(async () => ({ ok: true, data: [], warnings: [] })),
};

const row = (id: string, title: string, status: string): VizRow =>
  ({ id, title, file_path: `${id}.md`, types: ['task'], fields: { status }, version: 1 });
// The order query-nodes returned: newest first, deliberately not alphabetical.
const NEWEST_FIRST = [row('n1', 'Charlie', 'done'), row('n2', 'Alpha', 'open'), row('n3', 'Bravo', 'done')];

const NEWEST: VizSpec = {
  kind: 'table', title: 'Tasks',
  query: { types: ['task'], sort_by: 'file_mtime', sort_order: 'desc', limit: 50 },
  display_fields: ['status'],
};

/** A host that saves every spec change, like a board, and reports each save. */
function Host({ initial, onSave }: { initial: VizSpec; onSave: (s: VizSpec) => void }) {
  const [spec, setSpec] = useState(initial);
  return <VizCard spec={spec} onSpecChange={(next) => { onSave(next); setSpec(next); }} />;
}

function renderHost(initial: VizSpec) {
  const saves: VizSpec[] = [];
  render(
    <VizClientProvider client={client as never}>
      <Host initial={initial} onSave={(s) => saves.push(s)} />
    </VizClientProvider>,
  );
  return { saves, last: () => saves[saves.length - 1]! };
}

const titles = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').find((c) => c.className === 'c-title')?.textContent);
const header = (label: string) => screen.getAllByRole('columnheader').find((th) => th.querySelector('.vth-label')?.textContent === label)!;
const arrowOn = () => screen.getAllByRole('columnheader')
  .filter((th) => th.querySelector('.sortar'))
  .map((th) => `${th.querySelector('.vth-label')?.textContent} ${th.querySelector('.sortar')?.getAttribute('aria-label')}`);
const sortButton = () => screen.getByRole('button', { name: /^Sort: / });
const sortText = () => sortButton().textContent?.trim();

beforeEach(() => {
  data.rows = NEWEST_FIRST;
  data.total = 3;
  data.ranked = false;
  _resetCachesForTest();
});
afterEach(() => cleanup());

describe('table sort (#393)', () => {
  it('shows rows in the order the query returned them: no hidden title sort', () => {
    renderHost(NEWEST);
    expect(titles()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(sortText()).toBe('Newest first');
    expect(arrowOn()).toEqual([]); // modified time has no column
  });

  it('clicking Name sorts on the Engine and saves it; clicking again flips it', () => {
    const { saves, last } = renderHost(NEWEST);
    fireEvent.click(header('Name'));
    expect(last().query).toMatchObject({ sort_by: 'title', sort_order: 'asc', types: ['task'] });
    expect(last().column_sort).toBeUndefined();
    expect(sortText()).toBe('Title A–Z');
    expect(arrowOn()).toEqual(['Name sorted ascending']);
    // Server order: the table doesn't re-sort, the next query returns the new order.
    expect(titles()).toEqual(['Charlie', 'Alpha', 'Bravo']);

    fireEvent.click(header('Name'));
    expect(last().query).toMatchObject({ sort_by: 'title', sort_order: 'desc' });
    expect(sortText()).toBe('Title Z–A');
    expect(arrowOn()).toEqual(['Name sorted descending']);
    expect(saves).toHaveLength(2);
  });

  it('clicking another column sorts the loaded rows, saves a column sort, and the toolbar names it', () => {
    const { last } = renderHost(NEWEST);
    fireEvent.click(header('status'));
    expect(last().column_sort).toEqual({ field: 'status', order: 'asc' });
    expect(last().query).toEqual(NEWEST.query); // which rows load is unchanged
    expect(titles()).toEqual(['Alpha', 'Charlie', 'Bravo']); // open before done (board order)
    expect(arrowOn()).toEqual(['status sorted ascending']);
    expect(sortText()).toBe('status ↑');

    fireEvent.click(header('status'));
    expect(last().column_sort).toEqual({ field: 'status', order: 'desc' });
    expect(titles()).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(sortText()).toBe('status ↓');
  });

  it('a saved column sort reopens as it was, and the toolbar checks it instead of a server order', () => {
    renderHost({ ...NEWEST, column_sort: { field: 'status', order: 'asc' } });
    expect(titles()).toEqual(['Alpha', 'Charlie', 'Bravo']);
    fireEvent.click(sortButton());
    const checked = screen.getAllByRole('menuitemradio').filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked.map((b) => b.textContent)).toEqual(['status ↑']);
  });

  it('the column sort item in the toolbar flips its direction', () => {
    const { last } = renderHost({ ...NEWEST, column_sort: { field: 'status', order: 'asc' } });
    fireEvent.click(sortButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'status ↑' }));
    expect(last().column_sort).toEqual({ field: 'status', order: 'desc' });
  });

  it('picking a toolbar sort replaces a column sort and moves the header arrow', () => {
    const { last } = renderHost({ ...NEWEST, column_sort: { field: 'status', order: 'asc' } });
    fireEvent.click(sortButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Title Z–A' }));
    expect(last().column_sort).toBeUndefined();
    expect(last().query).toMatchObject({ sort_by: 'title', sort_order: 'desc', types: ['task'] });
    expect(arrowOn()).toEqual(['Name sorted descending']);
    expect(titles()).toEqual(['Charlie', 'Alpha', 'Bravo']); // back to the query's order
    expect(sortText()).toBe('Title Z–A');
  });

  it('notes that a column sort covers only the loaded rows when the limit cut the result off', () => {
    data.total = 40;
    renderHost({ ...NEWEST, column_sort: { field: 'status', order: 'asc' } });
    expect(screen.getByRole('note').textContent).toBe('Sorted by status within the 3 loaded rows, not all 40.');
  });

  it('no note for a server sort, or for a column sort over every row', () => {
    data.total = 40;
    renderHost(NEWEST);
    expect(screen.queryByRole('note')).toBeNull();
    cleanup();
    data.total = 3;
    renderHost({ ...NEWEST, column_sort: { field: 'status', order: 'asc' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('during a search the rows keep relevance order and Name sorts the loaded rows', () => {
    data.ranked = true;
    const { last } = renderHost({ ...NEWEST, query: { ...NEWEST.query, query: 'budget' } });
    expect(sortText()).toBe('Relevance');
    expect(arrowOn()).toEqual([]);
    expect(titles()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    fireEvent.click(header('Name'));
    expect(last().column_sort).toEqual({ field: 'title', order: 'asc' });
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('a search the Engine could not rank keeps the server sort, and Name still sorts on the Engine', () => {
    data.ranked = false; // no embedder: query-nodes fell back to the structured path and applied sort_by
    const { last } = renderHost({ ...NEWEST, query: { ...NEWEST.query, query: 'budget' } });
    expect(sortText()).toBe('Newest first');
    fireEvent.click(header('Name'));
    expect(last().query).toMatchObject({ sort_by: 'title', sort_order: 'asc', query: 'budget' });
    expect(last().column_sort).toBeUndefined();
  });

  it('other layouts keep the plain toolbar Sort', () => {
    renderHost({ ...NEWEST, kind: 'kanban', column_sort: { field: 'status', order: 'asc' } });
    const button = screen.getByRole('button', { name: 'Sort' });
    fireEvent.click(button);
    const checked = screen.getAllByRole('menuitemradio').filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked.map((b) => b.textContent)).toEqual(['Newest first']);
  });

  it('a read-only card keeps its own local header sort', () => {
    render(
      <VizClientProvider client={client as never}>
        <VizCard spec={NEWEST} />
      </VizClientProvider>,
    );
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    fireEvent.click(header('status'));
    expect(titles()).toEqual(['Alpha', 'Charlie', 'Bravo']);
  });
});
