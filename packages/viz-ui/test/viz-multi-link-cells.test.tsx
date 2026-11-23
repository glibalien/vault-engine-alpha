// @vitest-environment jsdom
/**
 * #285: a field holding several references must read as several links. On a real
 * row the table edits such a cell one link at a time; a row whose edit API has no
 * member editor must not open the one-value editor on it (it would replace the
 * whole list and drop the other links).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { RefValue } from '../src/RefValue.js';
import { VizTable } from '../src/VizTable.js';
import { useVizCellEdit } from '../src/use-viz-cell-edit.js';
import { withClient } from './_render-viz.js';

describe('RefValue', () => {
  test('two references render as two links with a separator between them', () => {
    const onOpenPreview = vi.fn();
    const { container } = render(<div><RefValue raw={['Company A', 'Company B']} isRef onOpenPreview={onOpenPreview} /></div>);
    const links = [...container.querySelectorAll('button.viz-ref')].map((b) => b.textContent);
    expect(links).toEqual(['Company A', 'Company B']);
    expect(container.textContent).toBe('Company A, Company B');
    fireEvent.click(container.querySelectorAll('button.viz-ref')[1]!);
    expect(onOpenPreview).toHaveBeenCalledWith({ title: 'Company B' });
  });

  test('a single reference renders one link and no separator', () => {
    const { container } = render(<div><RefValue raw={['Company A']} isRef onOpenPreview={vi.fn()} /></div>);
    expect(container.querySelectorAll('button.viz-ref')).toHaveLength(1);
    expect(container.querySelector('.viz-ref-sep')).toBeNull();
    expect(container.textContent).toBe('Company A');
  });
});

function makeEdit() {
  return {
    editing: null as any,
    beginEdit: vi.fn(),
    cellValue: (row: any, field: string) => row.fields[field] ?? '',
    isFlashing: () => false,
    submitEdit: vi.fn(), cancelEdit: vi.fn(), pending: null, cellError: null,
    cellTitle: (row: any) => row.title,
    isStale: () => false,
    reloadRow: vi.fn(),
    confirmPending: vi.fn(),
  } as any;
}

const schema = {
  name: 'project', display_name: null,
  fields: [
    { name: 'company', type: 'list', list_item_type: 'reference' },
    { name: 'owner', type: 'reference' },
  ],
} as any;

function renderTable(fields: Record<string, unknown>, displayFields: string[]) {
  const rows = [{ id: 'p1', title: 'Project', fields }];
  const edit = makeEdit();
  const utils = render(
    <VizTable rows={rows as any} displayFields={displayFields} groupField="status" editable
      schema={schema} edit={edit} refFields={new Set(['company', 'owner'])} onOpenPreview={vi.fn()} />,
  );
  // Cell 0 is the title; field cells follow in displayFields order.
  const cell = (i: number) => utils.container.querySelectorAll('td .cell-inner')[i + 1] as HTMLElement;
  return { ...utils, edit, cell };
}

describe('VizTable list-of-reference cells without a member editor', () => {
  test('a cell holding several links shows them all and does not open the editor', () => {
    const { edit, cell } = renderTable({ company: ['Company A', 'Company B'] }, ['company']);
    const company = cell(0);
    expect([...company.querySelectorAll('button.viz-ref')].map((b) => b.textContent)).toEqual(['Company A', 'Company B']);
    expect(company.title).toMatch(/several links/i);
    fireEvent.click(company);
    expect(edit.beginEdit).not.toHaveBeenCalled();
  });

  test('a cell holding one link keeps the editor', () => {
    const { edit, cell } = renderTable({ company: ['Company A'] }, ['company']);
    expect(cell(0).title).toBe('');
    fireEvent.click(cell(0));
    expect(edit.beginEdit).toHaveBeenCalledWith('p1', 'company');
  });

  test('an empty list-of-reference cell keeps the editor', () => {
    const { edit, cell } = renderTable({ company: [] }, ['company']);
    fireEvent.click(cell(0));
    expect(edit.beginEdit).toHaveBeenCalledWith('p1', 'company');
  });

  test('a single-reference field keeps the editor', () => {
    const { edit, cell } = renderTable({ owner: 'Person A' }, ['owner']);
    fireEvent.click(cell(0));
    expect(edit.beginEdit).toHaveBeenCalledWith('p1', 'owner');
  });

  test('Tab into a cell holding several links does not open the editor; Tab into the next one does', () => {
    const { edit, container } = renderTable({ company: ['Company A', 'Company B'], owner: 'Person A' }, ['company', 'owner']);
    const tds = container.querySelectorAll('td[data-cell-key]');
    const titleCell = [...tds].find((td) => td.getAttribute('data-cell-key') === '0:0')!;
    const companyCell = [...tds].find((td) => td.getAttribute('data-cell-key') === '0:1')!;
    fireEvent.keyDown(titleCell, { key: 'Tab' });
    expect(edit.beginEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(companyCell, { key: 'Tab' });
    expect(edit.beginEdit).toHaveBeenCalledWith('p1', 'owner');
  });
});

// ─── #285 part two: the list editor on real rows ─────────────────────────────

describe('VizTable list-of-reference cells with the member editor', () => {
  const listSchema = {
    name: 'project', display_name: null,
    fields: [
      { name: 'company', type: 'list', list_item_type: 'reference', reference_target: 'company' },
      { name: 'owner', type: 'reference', reference_target: 'person' },
    ],
  } as any;

  const candidates = [
    { id: 'c1', title: 'Company A' }, { id: 'c2', title: 'Company B' }, { id: 'c3', title: 'Company C' },
  ];

  function makeClient(overrides: Record<string, unknown> = {}) {
    return {
      queryNodes: vi.fn().mockResolvedValue({
        ok: true, warnings: [],
        data: { nodes: candidates.map((c) => ({ ...c, types: ['company'], file_path: `${c.title}.md`, version: 1, field_count: 0 })), total: 3 },
      }),
      updateNode: vi.fn(),
      getNode: vi.fn(),
      editReferenceMember: vi.fn(),
      ...overrides,
    } as any;
  }

  function Harness({ client, fields }: { client: any; fields: Record<string, unknown> }) {
    const edit = useVizCellEdit(client);
    const rows = [{ id: 'p1', title: 'Project', file_path: 'Project.md', types: ['project'], fields, version: 7 }];
    return (
      <VizTable rows={rows as any} displayFields={['company', 'owner']} groupField="status" editable
        schema={listSchema} edit={edit} refFields={new Set(['company', 'owner'])} onOpenPreview={vi.fn()} />
    );
  }

  async function settle() {
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
  }

  async function setup(fields: Record<string, unknown>, client = makeClient()) {
    const utils = render(<Harness client={client} fields={fields} />, { wrapper: withClient(client) });
    const cell = (i: number) => utils.container.querySelectorAll('td .cell-inner')[i + 1] as HTMLElement;
    return { ...utils, client, cell };
  }

  const chips = (el: HTMLElement) => [...el.querySelectorAll('.ref-list-chip-label')].map((c) => c.textContent);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  test('clicking a cell holding several links opens the list editor with a chip for each', async () => {
    const { cell } = await setup({ company: ['Company A', 'Company B'] });
    expect(cell(0).title).toBe('');
    fireEvent.click(cell(0));
    await settle();
    expect(chips(cell(0))).toEqual(['Company A', 'Company B']);
    expect(cell(0).querySelector('.ref-autocomplete-input')).not.toBeNull();
    // Only existing notes can be added: no keep-unresolved row.
    fireEvent.change(cell(0).querySelector('.ref-autocomplete-input')!, { target: { value: 'Nobody' } });
    await settle();
    expect(cell(0).querySelector('.ref-autocomplete-keep')).toBeNull();
  });

  test('adding a third link to a two-link cell keeps all three', async () => {
    const client = makeClient({
      editReferenceMember: vi.fn().mockResolvedValue({
        ok: true, warnings: [],
        data: {
          node_id: 'p1', version: 8, content_hash: 'h2',
          coerced_state: { company: { field: 'company', value: ['Company A', 'Company B', 'Company C'], source: 'provided', changed: true } },
          reference_edit: { changed: true, outcome: 'added' },
        },
      }),
    });
    const { cell } = await setup({ company: ['Company A', 'Company B'] }, client);
    fireEvent.click(cell(0));
    await settle();
    const opt = [...cell(0).querySelectorAll('.ref-autocomplete-opt')].find((o) => o.textContent?.includes('Company C'))!;
    await act(async () => { fireEvent.mouseDown(opt); });
    await settle();

    expect(client.editReferenceMember).toHaveBeenCalledWith({
      node_id: 'p1', expected_version: 7,
      reference_edit: { field: 'company', action: 'add', target: { node_id: 'c3' } },
    });
    expect(client.updateNode).not.toHaveBeenCalled();
    expect(chips(cell(0))).toEqual(['Company A', 'Company B', 'Company C']);

    // Escape closes the editor; the cell shows all three links.
    fireEvent.keyDown(cell(0).querySelector('.ref-autocomplete-input')!, { key: 'Escape' });
    expect([...cell(0).querySelectorAll('button.viz-ref')].map((b) => b.textContent)).toEqual(['Company A', 'Company B', 'Company C']);
  });

  test('removing one link keeps the others', async () => {
    const client = makeClient({
      getNode: vi.fn().mockResolvedValue({ ok: true, warnings: [], data: { id: 'p1', version: 7, metadata: { content_hash: 'h1' }, fields: {}, types: ['project'], title: 'Project', file_path: 'Project.md', body: '' } }),
      editReferenceMember: vi.fn().mockResolvedValue({
        ok: true, warnings: [],
        data: {
          node_id: 'p1', version: 8, content_hash: 'h2',
          coerced_state: { company: { field: 'company', value: ['Company B'], source: 'provided', changed: true } },
          reference_edit: { changed: true, outcome: 'removed' },
        },
      }),
    });
    const { cell, getByLabelText } = await setup({ company: ['Company A', 'Company B'] }, client);
    fireEvent.click(cell(0));
    await settle();
    await act(async () => { fireEvent.click(getByLabelText('Remove Company A')); });

    expect(client.editReferenceMember).toHaveBeenCalledWith({
      node_id: 'p1', expected_version: 7, expected_content_hash: 'h1',
      reference_edit: { field: 'company', action: 'remove', target: { stored_value: 'Company A' } },
    });
    expect(chips(cell(0))).toEqual(['Company B']);
  });

  test('an empty list cell opens the list editor too', async () => {
    const { cell } = await setup({ company: [] });
    fireEvent.click(cell(0));
    await settle();
    expect(cell(0).querySelector('.ref-list-editor')).not.toBeNull();
    expect(chips(cell(0))).toEqual([]);
  });

  test('a single-reference field keeps the one-value editor', async () => {
    const { cell } = await setup({ owner: 'Person A' });
    fireEvent.click(cell(1));
    await settle();
    expect(cell(1).querySelector('.ref-list-editor')).toBeNull();
    expect(cell(1).querySelector('.ref-autocomplete-input')).not.toBeNull();
  });

  test('Tab into a cell holding several links opens the list editor', async () => {
    const { container, cell } = await setup({ company: ['Company A', 'Company B'] });
    const titleCell = container.querySelector('td[data-cell-key="0:0"]')!;
    fireEvent.keyDown(titleCell, { key: 'Tab' });
    await settle();
    expect(chips(cell(0))).toEqual(['Company A', 'Company B']);
  });

  test('a click outside closes the list editor', async () => {
    const { cell } = await setup({ company: ['Company A', 'Company B'] });
    fireEvent.click(cell(0));
    await settle();
    expect(cell(0).querySelector('.ref-list-editor')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(cell(0).querySelector('.ref-list-editor')).toBeNull();
  });
});
