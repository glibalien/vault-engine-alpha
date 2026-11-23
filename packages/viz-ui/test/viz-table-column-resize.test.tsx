// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VizTable } from '../src/VizTable.js';
import { VizCardView } from '../src/VizCard.js';
import { VizClientProvider } from '../src/viz-client-context.js';
import { parseVizFence, type VizRow } from '../src/viz-spec.js';
import { parseBoardCardSpec } from '../src/board-card-spec.js';

const rows: VizRow[] = [
  { id: 'n1', title: 'Open task', file_path: 'notes/open.md', types: ['task'], fields: { status: 'open' }, version: 1 },
];

const client = {
  queryNodes: vi.fn(),
  describeSchema: vi.fn(async () => ({ ok: true, data: { name: 'task', display_name: 'Task', fields: [] }, warnings: [] })),
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

afterEach(() => cleanup());

describe('table column resize', () => {
  it.each(['fence', 'board'])('renders one column per field and preserves saved widths across a %s round trip', source => {
    const input = {
      kind: 'table', title: 'Tasks', query: {}, display_fields: ['status', 'due', 'status', 'due'],
      column_widths: { table: { status: 180, due: 240 }, kanban: { open: 310 } },
    };
    const parse = (value: unknown) => source === 'fence' ? parseVizFence(JSON.stringify(value)) : parseBoardCardSpec(value);
    const spec = parse(input);
    if (!spec || spec.kind !== 'table') throw new Error('Expected table spec');
    const onSpecChange = vi.fn();
    const { getByRole, getAllByRole } = render(
      <VizClientProvider client={client as never}>
        <VizCardView
          spec={spec} kind="table" rows={rows} total={1} loading={false} error={null}
          onKind={() => {}} onRefresh={() => {}} onSpecChange={onSpecChange}
        />
      </VizClientProvider>,
    );
    expect(getAllByRole('separator', { name: 'resize status column' })).toHaveLength(1);
    expect(getAllByRole('separator', { name: 'resize due column' })).toHaveLength(1);
    const columns = getByRole('table').querySelectorAll('col');
    expect(columns).toHaveLength(4); // bulk selection, title, status, due
    expect(columns[2]?.style.width).toBe('180px');
    expect(columns[3]?.style.width).toBe('240px');
    fireEvent.keyDown(getByRole('separator', { name: 'resize status column' }), { key: 'ArrowRight' });
    const saved = onSpecChange.mock.calls[0]?.[0];
    expect(saved).toEqual({
      ...input, display_fields: ['status', 'due'],
      column_widths: { table: { status: 190, due: 240 }, kanban: { open: 310 } },
    });
    expect(parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(input.display_fields).toEqual(['status', 'due', 'status', 'due']);
    expect(input.column_widths.table.status).toBe(180);
  });

  it('applies a stored width to the matching table column', () => {
    const { container } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        columnWidths={{ __title__: 260, status: 140 }}
      />,
    );

    const columns = container.querySelectorAll('col');
    expect(columns).toHaveLength(2);
    expect(columns[0]?.style.width).toBe('260px');
    expect(columns[1]?.style.width).toBe('140px');
  });

  it('uses the persisted total when every visible data column has a width', () => {
    const { getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        columnWidths={{ __title__: 260, status: 140 }}
      />,
    );

    const table = getByRole('table');
    expect(table.style.width).toBe('400px');
    expect(table.style.tableLayout).toBe('fixed');
  });

  it('keeps automatic layout until every visible data column has a width', () => {
    const { getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        columnWidths={{ __title__: 260 }}
      />,
    );

    const table = getByRole('table');
    expect(table.style.width).toBe('');
    expect(table.style.tableLayout).toBe('');
  });

  it('preserves space for bulk, row-number, and version columns', () => {
    const bulk = {
      isSelected: vi.fn(() => false), toggleRow: vi.fn(), allSelected: vi.fn(() => false),
      toggleAll: vi.fn(), selectedCount: 0, outcome: null,
    } as never;
    const { getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        editable
        bulk={bulk}
        showRowNumbers
        showVersion
        columnWidths={{ __title__: 260, status: 140 }}
      />,
    );

    expect(getByRole('table').style.width).toBe('548px');
  });

  it('keeps the built-in Title column distinct from a displayed title field', () => {
    const { container } = render(
      <VizTable
        rows={[{ ...rows[0]!, fields: { title: 'Frontmatter title' } }]}
        displayFields={['title']}
        groupField="status"
        columnWidths={{ __title__: 260, title: 140 }}
      />,
    );

    const columns = container.querySelectorAll('col');
    expect(columns).toHaveLength(2);
    expect(columns[0]?.style.width).toBe('260px');
    expect(columns[1]?.style.width).toBe('140px');
  });

  it('commits a dragged header width for its field', () => {
    const onColumnWidthChange = vi.fn();
    const { getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        onColumnWidthChange={onColumnWidthChange}
      />,
    );

    const handle = getByRole('separator', { name: 'resize status column' });
    fireEvent.pointerDown(handle, { clientX: 0 });
    window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 220 }));
    window.dispatchEvent(Object.assign(new Event('pointerup'), { clientX: 220 }));

    expect(onColumnWidthChange).toHaveBeenCalledOnce();
    expect(onColumnWidthChange).toHaveBeenCalledWith('status', 220);
  });

  it('does not commit a resize after the pointer is cancelled', () => {
    const onColumnWidthChange = vi.fn();
    const { getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        onColumnWidthChange={onColumnWidthChange}
      />,
    );

    fireEvent.pointerDown(getByRole('separator', { name: 'resize status column' }), { clientX: 0, pointerId: 1 });
    window.dispatchEvent(Object.assign(new Event('pointercancel'), { clientX: 80, pointerId: 1 }));
    window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 220, pointerId: 1 }));
    window.dispatchEvent(Object.assign(new Event('pointerup'), { clientX: 220, pointerId: 1 }));

    expect(onColumnWidthChange).not.toHaveBeenCalled();
  });

  it('restores the persisted width after a resize is cancelled', () => {
    const onColumnWidthChange = vi.fn();
    const { container, getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        columnWidths={{ __title__: 260, status: 140 }}
        onColumnWidthChange={onColumnWidthChange}
      />,
    );
    const header = getByRole('separator', { name: 'resize status column' }).closest('th')!;
    Object.defineProperty(header, 'offsetWidth', { configurable: true, value: 140 });

    fireEvent.pointerDown(getByRole('separator', { name: 'resize status column' }), { clientX: 0 });
    window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 220 }));
    expect(container.querySelectorAll('col')[1]?.style.width).toBe('360px');
    window.dispatchEvent(Object.assign(new Event('pointercancel'), { clientX: 220 }));

    expect(container.querySelectorAll('col')[1]?.style.width).toBe('140px');
    expect(onColumnWidthChange).not.toHaveBeenCalled();
  });

  it('adjusts a focused header width with the arrow keys', () => {
    const onColumnWidthChange = vi.fn();
    const { getByRole } = render(
      <VizTable
        rows={rows}
        displayFields={['status']}
        groupField="status"
        columnWidths={{ status: 200 }}
        onColumnWidthChange={onColumnWidthChange}
      />,
    );

    fireEvent.keyDown(getByRole('separator', { name: 'resize status column' }), { key: 'ArrowRight' });

    expect(onColumnWidthChange).toHaveBeenCalledWith('status', 210);
  });

  it('keeps legacy Kanban widths out of a table and namespaces the new table width', () => {
    const onSpecChange = vi.fn();
    const { getByRole } = render(
      <VizClientProvider client={client as never}>
        <VizCardView
          spec={{ kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: ['status'], column_widths: { status: 180 } }}
          kind="table"
          rows={rows}
          total={1}
          loading={false}
          error={null}
          onKind={() => {}}
          onRefresh={() => {}}
          onSpecChange={onSpecChange}
        />
      </VizClientProvider>,
    );

    const columns = getByRole('table').querySelectorAll('col');
    expect(columns[columns.length - 1]?.style.width).toBe('');
    const handle = getByRole('separator', { name: 'resize status column' });
    fireEvent.pointerDown(handle, { clientX: 0 });
    window.dispatchEvent(Object.assign(new Event('pointerup'), { clientX: 220 }));

    expect(onSpecChange).toHaveBeenCalledWith({
      kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: ['status'], column_widths: { kanban: { status: 180 }, table: { status: 220 } },
    });
  });
});
