// @vitest-environment jsdom
/**
 * rtl-smoke.test.tsx
 *
 * Confirms @testing-library/react + jsdom are wired correctly.
 * Renders a trivial interactive component, fires a click, asserts the DOM updates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <span data-testid="count">{count}</span>
      <button onClick={() => setCount((n) => n + 1)}>increment</button>
    </div>
  );
}

describe('RTL smoke test', () => {
  afterEach(() => cleanup());

  it('renders a component and updates on click', () => {
    render(<Counter />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'increment' }));
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('supports multiple clicks', () => {
    render(<Counter />);
    fireEvent.click(screen.getByRole('button', { name: 'increment' }));
    fireEvent.click(screen.getByRole('button', { name: 'increment' }));
    expect(screen.getByTestId('count').textContent).toBe('2');
  });
});
