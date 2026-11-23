// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { VizKanban, clampColWidth } from '../src/VizKanban.js';
import type { VizRow } from '../src/viz-spec.js';

afterEach(() => cleanup());

const rows: VizRow[] = [
  { id: 'n1', title: 'A', file_path: 'notes/a.md', types: [], fields: { status: 'open' }, version: 1 },
  { id: 'n2', title: 'B', file_path: 'notes/b.md', types: [], fields: { status: 'done' }, version: 1 },
];

it('dragging a card to a column calls onSetStatus with the target column value', () => {
  const onSetStatus = vi.fn();
  const { getByText, container } = render(
    <VizKanban rows={rows} groupBy="status" displayFields={['status']} onSetStatus={onSetStatus} />,
  );
  const card = getByText('A').closest('[draggable="true"]') as HTMLElement;
  const dt = { setData: vi.fn(), getData: vi.fn(() => 'n1') } as any;
  fireEvent.dragStart(card, { dataTransfer: dt });
  // find the 'done' column dropzone and drop onto it
  const doneCol = Array.from(container.querySelectorAll('.kcol')).find((c) => c.textContent?.includes('done')) as HTMLElement;
  fireEvent.dragOver(doneCol, { dataTransfer: dt });
  fireEvent.drop(doneCol, { dataTransfer: dt });
  expect(onSetStatus).toHaveBeenCalledWith('n1', 'status', 'done');
});

it('is read-only (no draggable cards) when onSetStatus is absent', () => {
  const { container } = render(<VizKanban rows={rows} groupBy="status" displayFields={['status']} />);
  expect(container.querySelector('[draggable="true"]')).toBeNull();
});

describe('grouped by a list field (#285)', () => {
  const listRows: VizRow[] = [
    { id: 'n1', title: 'A', file_path: 'notes/a.md', types: [], fields: { company: ['Acme', 'Globex'] }, version: 1 },
    { id: 'n2', title: 'B', file_path: 'notes/b.md', types: [], fields: { company: ['Initech'] }, version: 1 },
    { id: 'n3', title: 'C', file_path: 'notes/c.md', types: [], fields: {}, version: 1 },
  ];

  it('makes no card draggable and ignores a drop, since a drop would replace the whole list', () => {
    const onSetStatus = vi.fn();
    const { getByText, container } = render(
      <VizKanban rows={listRows} groupBy="company" displayFields={[]} onSetStatus={onSetStatus} />,
    );
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    const dt = { setData: vi.fn(), getData: vi.fn(() => 'n3') } as any;
    const col = getByText('Initech').closest('.kcol') as HTMLElement;
    fireEvent.drop(col, { dataTransfer: dt });
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it('says why on each card', () => {
    const { getByText } = render(
      <VizKanban rows={listRows} groupBy="company" displayFields={[]} onSetStatus={vi.fn()} />,
    );
    expect(getByText('A').closest('.kcard')?.getAttribute('title')).toMatch(/Edit them in the note/);
  });

  it('adds no hint on a board that was read-only anyway', () => {
    const { getByText } = render(<VizKanban rows={listRows} groupBy="company" displayFields={[]} />);
    expect(getByText('A').closest('.kcard')?.getAttribute('title')).toBeNull();
  });
});

describe('clampColWidth', () => {
  it('clamps to the [90, 520] range and rounds', () => {
    expect(clampColWidth(10)).toBe(90);
    expect(clampColWidth(9999)).toBe(520);
    expect(clampColWidth(200.6)).toBe(201);
  });
});

describe('kanban column resize (b10)', () => {
  it('applies a persisted column width as an inline style', () => {
    const { container } = render(
      <VizKanban rows={rows} groupBy="status" displayFields={['status']} columnWidths={{ open: 200 }} />,
    );
    const openCol = Array.from(container.querySelectorAll('.kcol')).find((c) => c.textContent?.includes('open')) as HTMLElement;
    expect(openCol.style.width).toBe('200px');
    // 'done' has no persisted width → falls back to the CSS default (no inline width).
    const doneCol = Array.from(container.querySelectorAll('.kcol')).find((c) => c.textContent?.includes('done')) as HTMLElement;
    expect(doneCol.style.width).toBe('');
  });

  it('renders resize handles only when onColumnWidthChange is provided', () => {
    const ro = render(<VizKanban rows={rows} groupBy="status" displayFields={['status']} />);
    expect(ro.container.querySelector('.kcol-resize')).toBeNull();

    const rw = render(<VizKanban rows={rows} groupBy="status" displayFields={['status']} onColumnWidthChange={() => {}} />);
    expect(rw.container.querySelectorAll('.kcol-resize').length).toBe(2);
  });

  it('dragging a resize handle commits a clamped width for that column', () => {
    const onColumnWidthChange = vi.fn();
    const { container } = render(
      <VizKanban rows={rows} groupBy="status" displayFields={['status']} onColumnWidthChange={onColumnWidthChange} />,
    );
    const openCol = Array.from(container.querySelectorAll('.kcol')).find((c) => c.textContent?.includes('open')) as HTMLElement;
    const handle = openCol.querySelector('.kcol-resize') as HTMLElement;

    // jsdom has no layout, so offsetWidth is 0; a +220px drag clamps within range.
    fireEvent.pointerDown(handle, { clientX: 0 });
    window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 220 }));
    window.dispatchEvent(Object.assign(new Event('pointerup'), { clientX: 220 }));

    expect(onColumnWidthChange).toHaveBeenCalledTimes(1);
    expect(onColumnWidthChange).toHaveBeenCalledWith('open', 220);
  });
});
