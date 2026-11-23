import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { ModelPicker } from '../src/composer/ModelPicker.js';

afterEach(() => cleanup());

const ITEMS = [
  { title: 'Qwen 3.7 Plus', provider: 'fireworks', available: true },
  { title: 'DeepSeek v4 Pro', provider: 'fireworks', available: true, unpriced: false },
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', available: false },
  { title: 'custom-x', provider: 'fireworks', available: true, unpriced: true },
];

function setup(over: Record<string, unknown> = {}) {
  const props = {
    items: ITEMS, selected: null, defaultTitle: 'Qwen 3.7 Plus', onSelect: vi.fn(),
    ...over,
  };
  render(<ModelPicker {...(props as never)} />);
  return props;
}

describe('ModelPicker', () => {
  it('chip shows the default title when nothing is selected, the selection otherwise', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Qwen 3.7 Plus' })).toBeTruthy();
    cleanup();
    setup({ selected: 'DeepSeek v4 Pro' });
    expect(screen.getByRole('button', { name: 'DeepSeek v4 Pro' })).toBeTruthy();
  });

  it('opens on click, groups by provider, greys unavailable entries with "key not configured"', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Qwen 3.7 Plus' }));
    expect(document.querySelector('.model-menu')).toBeTruthy();
    expect(screen.getByText('fireworks')).toBeTruthy();
    expect(screen.getByText('anthropic')).toBeTruthy();
    const claudeRow = screen.getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ });
    expect(claudeRow.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('key not configured')).toBeTruthy();
  });

  it('unavailable entries are not selectable; available ones call onSelect(title) and close', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Qwen 3.7 Plus' }));
    const claudeRow = screen.getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ });
    fireEvent.mouseDown(claudeRow);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('.model-menu')).toBeTruthy(); // stays open

    const deepseekRow = screen.getByRole('menuitemradio', { name: /DeepSeek v4 Pro/ });
    fireEvent.mouseDown(deepseekRow);
    expect(props.onSelect).toHaveBeenCalledWith('DeepSeek v4 Pro');
    expect(document.querySelector('.model-menu')).toBeNull();
  });

  it('the Default row calls onSelect(null)', () => {
    const props = setup({ selected: 'DeepSeek v4 Pro' });
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek v4 Pro' }));
    fireEvent.mouseDown(screen.getByRole('menuitemradio', { name: /Default — Qwen 3\.7 Plus/ }));
    expect(props.onSelect).toHaveBeenCalledWith(null);
  });

  it('unpriced entries carry an "unpriced" badge', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Qwen 3.7 Plus' }));
    const customRow = screen.getByRole('menuitemradio', { name: /custom-x/ });
    expect(customRow.textContent).toContain('unpriced');
  });

  it('outside mousedown and Escape close the menu', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Qwen 3.7 Plus' }));
    expect(document.querySelector('.model-menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector('.model-menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Qwen 3.7 Plus' }));
    expect(document.querySelector('.model-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.model-menu')).toBeNull();
  });
});
