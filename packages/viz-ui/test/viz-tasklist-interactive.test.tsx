// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { VizTaskList } from '../src/VizTaskList.js';
import type { VizRow } from '../src/viz-spec.js';

afterEach(() => cleanup());

it('clicking the checkbox toggles status via onToggle', () => {
  const onToggle = vi.fn();
  const rows: VizRow[] = [{ id: 'n1', title: 'A', file_path: 'notes/a.md', types: [], fields: { status: 'open' }, version: 1 }];
  const { getByRole } = render(<VizTaskList rows={rows} displayFields={['status']} onToggle={onToggle} />);
  fireEvent.click(getByRole('button', { name: /toggle/i }));
  expect(onToggle).toHaveBeenCalledWith('n1', 'status', 'done');
});

it('clicking a done checkbox calls onToggle with open', () => {
  const onToggle = vi.fn();
  const rows: VizRow[] = [{ id: 'n2', title: 'B', file_path: 'notes/b.md', types: [], fields: { status: 'done' }, version: 1 }];
  const { getByRole } = render(<VizTaskList rows={rows} displayFields={['status']} onToggle={onToggle} />);
  fireEvent.click(getByRole('button', { name: /toggle/i }));
  expect(onToggle).toHaveBeenCalledWith('n2', 'status', 'open');
});

it('renders a read-only div cbox when onToggle is absent', () => {
  const rows: VizRow[] = [{ id: 'n1', title: 'A', file_path: 'notes/a.md', types: [], fields: { status: 'open' }, version: 1 }];
  const { container } = render(<VizTaskList rows={rows} displayFields={['status']} />);
  expect(container.querySelector('button[aria-label]')).toBeNull();
  expect(container.querySelector('.cbox')).not.toBeNull();
});
