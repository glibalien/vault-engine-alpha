// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VizSettings } from '../src/VizSettings.js';
test('Settings Sort control emits the chosen option', () => {
  const onSortChange = vi.fn();
  render(
    <VizSettings
      spec={{ kind: 'table', query: {}, display_fields: [] } as any}
      onSpecChange={() => {}}
      sortKey="file_mtime:desc"
      onSortChange={onSortChange}
    />,
  );
  fireEvent.click(screen.getByLabelText('Table settings'));
  fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'title:asc' } });
  expect(onSortChange).toHaveBeenCalledWith(expect.objectContaining({ sort_by: 'title', sort_order: 'asc' }));
});
