// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VizTable } from '../src/VizTable.js';
// rows with 2+ distinct statuses (would previously render the .fchips pill row)
const rows = [
  { id: 'a', title: 'A', fields: { status: 'open' } },
  { id: 'b', title: 'B', fields: { status: 'done' } },
];
test('table does not render the status quick-button row', () => {
  const { container } = render(
    <VizTable rows={rows as any} displayFields={['status']} groupField="status" />,
  );
  // the search box stays… (assert it's the actual input, not just any labeled node)
  expect((screen.getByLabelText('Filter rows') as HTMLElement).tagName).toBe('INPUT');
  // …but the status pill row is gone
  expect(container.querySelector('.fchips')).toBeNull();
});
