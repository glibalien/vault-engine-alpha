// @vitest-environment jsdom
/**
 * viz-empty-cell-editable.test.tsx
 *
 * Regression test: empty editable date cells must be clickable.
 *
 * Root cause: <span class="mono"></span> (empty) collapses to zero height in
 * a real browser; the .cell-inner div had no min-height, making the click target
 * invisible/zero-area. Fixed by rendering a non-breaking space placeholder and
 * adding min-height to .cell-inner in styles.css.
 *
 * jsdom doesn't do layout, so the structural guard is what we assert: the empty
 * mono span must contain a non-breaking space so the cell has content (non-zero
 * layout height) in a real browser. (A click→beginEdit test was dropped — with no
 * layout in jsdom it passed against the pre-fix code too, so it guarded nothing.)
 */
import { expect, test, vi } from 'vitest';
import { render } from '@testing-library/react';
import { VizTable } from '../src/VizTable.js';

function makeEdit(rows: Array<{ id: string; fields: Record<string, unknown> }>) {
  return {
    editing: null as any,
    beginEdit: vi.fn(),
    // Return the actual field value from the row, mirroring real useVizCellEdit behaviour
    cellValue: (row: any, field: string) => row.fields[field] ?? '',
    isFlashing: () => false,
    submitEdit: vi.fn(), cancelEdit: vi.fn(), pending: null, cellError: null,
    cellTitle: (row: any) => row.title,
    isStale: () => false,
    reloadRow: vi.fn(),
    confirmPending: vi.fn(),
  } as any;
}

const schema = { name: 'task', display_name: null, fields: [{ name: 'due', type: 'date' }] } as any;

test('empty editable date cell renders a non-empty placeholder so the click target is visible', () => {
  const rows = [{ id: 'a', title: 'A', fields: { due: '' } }];
  const edit = makeEdit(rows);
  const { container } = render(
    <VizTable rows={rows as any}
      displayFields={['due']} groupField="status" editable schema={schema} edit={edit} />,
  );
  const allInners = container.querySelectorAll('td .cell-inner');
  const dueCell = allInners[1] as HTMLElement | null;
  expect(dueCell).not.toBeNull();
  // The inner span.mono must not be empty — it must contain a non-breaking space
  // so the cell has non-zero layout height in a real browser.
  const mono = dueCell!.querySelector('.mono');
  expect(mono).not.toBeNull();
  expect(mono!.textContent).toBe(' '); // non-breaking space
});

test('non-empty date cell renders unchanged (no visual regression)', () => {
  const rows = [{ id: 'a', title: 'A', fields: { due: '2026-01-15' } }];
  const edit = makeEdit(rows);
  const { container } = render(
    <VizTable rows={rows as any}
      displayFields={['due']} groupField="status" editable schema={schema} edit={edit} />,
  );
  const allInners = container.querySelectorAll('td .cell-inner');
  const dueCell = allInners[1] as HTMLElement | null;
  expect(dueCell).not.toBeNull();
  const mono = dueCell!.querySelector('.mono');
  expect(mono).not.toBeNull();
  // Non-empty value renders as-is (not replaced with nbsp)
  expect(mono!.textContent).toBe('2026-01-15');
});
