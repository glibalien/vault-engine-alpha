// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TypeLockChip } from '../src/TypeLockChip.js';
test('dropdown shows per-type counts as a suffix', () => {
  render(
    <TypeLockChip
      lockedType={null}
      availableTypes={['task', 'meeting']}
      counts={{ task: 342, meeting: 88 }}
      onPick={() => {}}
      onUnlock={() => {}}
    />,
  );
  fireEvent.click(screen.getByLabelText('type lock'));
  // Role-scoped to the menu radio items (not any text node) so a sibling type like
  // "task-manager" couldn't accidentally satisfy the substring match.
  expect(screen.getByRole('menuitemradio', { name: /task/ }).textContent).toContain('342');
  expect(screen.getByRole('menuitemradio', { name: /meeting/ }).textContent).toContain('88');
});
