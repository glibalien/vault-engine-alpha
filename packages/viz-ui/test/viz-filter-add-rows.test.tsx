// @vitest-environment jsdom
/**
 * viz-filter-add-rows.test.tsx — #617: the Filter popover's title and link-count rows are added
 * from "+ filter" like field filters, instead of showing on every view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CallerFragment, Schema, SchemaField, StripState } from '@vault/query-core';
import type { VizSpec } from '../src/viz-spec.js';
import { VizToolbar, type VizToolbarQuery } from '../src/VizToolbar.js';
import type { VizQueryVM } from '../src/use-viz-query.js';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SPEC: VizSpec = { kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: [] };
const STATUS: SchemaField = { name: 'status', type: 'enum', required: false, default_value: null, enum_values: ['open', 'done'], ui: null };
const TASK_SCHEMA: Schema = { name: 'task', display_name: 'Task', fields: [STATUS] };
const ROW_CONTROLS = ['title-contains', 'links in comparison', 'links out comparison', 'unresolved comparison'];

/** A toolbar over a live strip, so edits show up in the rows the way they do in a real view. */
function Harness({ initial = {}, fragments = [], schema = null, addable = [], onStrip }: {
  initial?: Partial<StripState>;
  fragments?: CallerFragment[];
  schema?: Schema | null;
  addable?: SchemaField[];
  onStrip?: (strip: StripState) => void;
}) {
  const [strip, setStrip] = useState<StripState>({ limit: 50, query: '', title_contains: '', sort_by: 'title', sort_order: 'asc', ...initial });
  const vm = {
    strip,
    lockedType: schema ? schema.name : null,
    chips: [],
    fragments,
    addableFields: addable.map((f) => f.name),
    setStrip: (next: StripState) => { onStrip?.(next); setStrip(next); },
    setSort: vi.fn(),
    setTypeLock: vi.fn(),
    addChip: vi.fn(),
    setChip: vi.fn(),
    removeChip: vi.fn(),
    removeFragment: vi.fn(),
  } as VizQueryVM;
  const query: VizToolbarQuery = { spec: SPEC, onSpecChange: vi.fn(), vm, schema, availableTypes: ['task'], addableSchemaFields: addable };
  return <VizToolbar kind="table" onKind={vi.fn()} shown={0} total={0} loading={false} onRefresh={vi.fn()} query={query} />;
}

const filterButton = () => screen.getByRole('button', { name: /^filter/i });
const openFilter = () => fireEvent.click(filterButton());
const openAddMenu = () => fireEvent.click(screen.getByRole('button', { name: /\+ filter/i }));
const menuNames = () => screen.getAllByRole('menuitem').map((b) => b.textContent);
function pick(name: string) {
  openAddMenu();
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

describe('Filter popover rows (#617)', () => {
  it('starts with only the type picker and + filter', () => {
    render(<Harness schema={TASK_SCHEMA} addable={[STATUS]} />);
    openFilter();
    for (const label of ROW_CONTROLS) expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.getByRole('button', { name: /\+ filter/i })).toBeDefined();
  });

  it('lists title contains and the three link counts ahead of the type\'s fields', () => {
    render(<Harness schema={TASK_SCHEMA} addable={[STATUS]} />);
    openFilter();
    openAddMenu();
    expect(menuNames()).toEqual(['title contains', 'links in', 'links out', 'unresolved links', 'status']);
    expect(screen.getByRole('separator')).toBeDefined();
  });

  it('offers the four on a view with no type', () => {
    render(<Harness schema={null} />);
    openFilter();
    openAddMenu();
    expect(menuNames()).toEqual(['title contains', 'links in', 'links out', 'unresolved links']);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('adds title contains with its input focused, and stops offering it', () => {
    render(<Harness schema={TASK_SCHEMA} addable={[STATUS]} />);
    openFilter();
    pick('title contains');
    const input = screen.getByLabelText('title-contains');
    expect(document.activeElement).toBe(input);
    openAddMenu();
    expect(menuNames()).not.toContain('title contains');
  });

  it('adds a link count with its comparison focused', () => {
    render(<Harness />);
    openFilter();
    pick('links out');
    expect(document.activeElement).toBe(screen.getByLabelText('links out comparison'));
    expect(screen.queryByLabelText('links in comparison')).toBeNull();
  });

  it('× removes the row, clears its filter, and returns the option to the list', () => {
    const onStrip = vi.fn();
    render(<Harness onStrip={onStrip} />);
    openFilter();
    pick('title contains');
    fireEvent.change(screen.getByLabelText('title-contains'), { target: { value: 'plan' } });
    pick('unresolved links');
    fireEvent.change(screen.getByLabelText('unresolved comparison'), { target: { value: 'gte' } });

    fireEvent.click(screen.getByRole('button', { name: 'remove title contains filter' }));
    expect(onStrip).toHaveBeenLastCalledWith(expect.objectContaining({ title_contains: '' }));
    expect(screen.queryByLabelText('title-contains')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'remove unresolved filter' }));
    expect(onStrip).toHaveBeenLastCalledWith(expect.objectContaining({ link_counts: undefined }));
    expect(screen.queryByLabelText('unresolved comparison')).toBeNull();

    openAddMenu();
    expect(menuNames()).toEqual(['title contains', 'links in', 'links out', 'unresolved links']);
  });

  it('removing a row that was never set changes nothing on the view', () => {
    const onStrip = vi.fn();
    render(<Harness onStrip={onStrip} />);
    openFilter();
    pick('links in');
    fireEvent.click(screen.getByRole('button', { name: 'remove links in filter' }));
    expect(screen.queryByLabelText('links in comparison')).toBeNull();
    expect(onStrip).not.toHaveBeenCalled();
  });

  it('shows the rows of filters already set (a saved view, or one an AI caller set)', () => {
    render(<Harness initial={{ title_contains: 'plan', link_counts: { unresolved: { op: 'gte', value: 1 } } }} />);
    openFilter();
    expect((screen.getByLabelText('title-contains') as HTMLInputElement).value).toBe('plan');
    expect((screen.getByLabelText('unresolved comparison') as HTMLSelectElement).value).toBe('gte');
    expect(screen.queryByLabelText('links in comparison')).toBeNull();
    expect(screen.queryByLabelText('links out comparison')).toBeNull();
    // Nothing takes focus on its own when the popover opens.
    expect(document.activeElement).not.toBe(screen.getByLabelText('title-contains'));
    expect(document.activeElement).not.toBe(screen.getByLabelText('unresolved comparison'));
    openAddMenu();
    expect(menuNames()).toEqual(['links in', 'links out']);
  });

  it('keeps a set row on screen while its value is cleared by hand', () => {
    render(<Harness initial={{ title_contains: 'plan', link_counts: { incoming: { op: 'lte', value: 1 } } }} />);
    openFilter();
    fireEvent.change(screen.getByLabelText('title-contains'), { target: { value: '' } });
    expect(screen.getByLabelText('title-contains')).toBeDefined();
    fireEvent.change(screen.getByLabelText('links in comparison'), { target: { value: '' } });
    expect(screen.getByLabelText('links in comparison')).toBeDefined();
  });

  it('keeps an added row when the popover closes and reopens', () => {
    render(<Harness />);
    openFilter();
    pick('links in');
    openFilter(); // close
    expect(screen.queryByLabelText('links in comparison')).toBeNull();
    openFilter();
    expect(screen.getByLabelText('links in comparison')).toBeDefined();
    expect(document.activeElement).not.toBe(screen.getByLabelText('links in comparison'));
  });

  it('a link-count filter the rows can\'t show stays a chip, and the link rows aren\'t offered', () => {
    const fragment: CallerFragment = { id: 7, key: 'link_counts', payload: { rel_type: 'project', incoming: { lte: 1 } }, scope: 'global' };
    render(<Harness fragments={[fragment]} />);
    openFilter();
    expect(screen.getByRole('button', { name: 'remove filter links in ≤ 1, via project' })).toBeDefined();
    openAddMenu();
    expect(menuNames()).toEqual(['title contains']);
  });
});
