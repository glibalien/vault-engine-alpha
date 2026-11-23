import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { Composer } from '../src/composer/Composer.js';

afterEach(() => cleanup());

const NODES = [{ id: 'n1', title: 'Project X', type: 'project' }];

function setup(over: Record<string, unknown> = {}) {
  const props = {
    disabled: false, streaming: false, capped: false,
    searchNodes: vi.fn(async () => NODES),
    onSend: vi.fn(), onStop: vi.fn(), onAddNodeChip: vi.fn(),
    ...over,
  };
  render(<Composer {...(props as never)} />);
  const ta = screen.getByPlaceholderText('Ask the vault…') as HTMLTextAreaElement;
  return { props, ta };
}

describe('Composer', () => {
  it('@ opens the node menu and a pick inserts a wikilink + fires onAddNodeChip', async () => {
    const { props, ta } = setup();
    fireEvent.change(ta, { target: { value: '@pro', selectionStart: 4 } });
    await waitFor(() => expect(screen.getByText('Project X')).toBeTruthy());
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('[[Project X]] ');
    expect(props.onAddNodeChip).toHaveBeenCalledWith(NODES[0]);
    expect(props.onSend).not.toHaveBeenCalled(); // Enter picked, did not send
  });

  it('Enter sends, Shift+Enter does not', () => {
    const { props, ta } = setup();
    fireEvent.change(ta, { target: { value: 'hello', selectionStart: 5 } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledWith('hello');
  });

  it('ArrowDown/ArrowUp move the active row', async () => {
    const nodes = [
      { id: 'n1', title: 'Project X', type: 'project' },
      { id: 'n2', title: 'Project Y', type: 'project' },
    ];
    const { ta } = setup({ searchNodes: vi.fn(async () => nodes) });
    fireEvent.change(ta, { target: { value: '@', selectionStart: 1 } });
    await waitFor(() => expect(screen.getByText('Project X')).toBeTruthy());
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    const active = document.querySelector('.composer-item[data-active="true"]');
    expect(active?.textContent).toContain('Project Y');
  });

  it('no .model-chip renders without the modelPicker prop', () => {
    setup();
    expect(document.querySelector('.model-chip')).toBeNull();
  });

  it('with the modelPicker prop, the chip appears in .crow and clicking it opens .model-menu', () => {
    const modelPicker = {
      items: [{ title: 'Qwen 3.7 Plus', provider: 'fireworks', available: true }],
      selected: null,
      defaultTitle: 'Qwen 3.7 Plus',
      onSelect: vi.fn(),
    };
    setup({ modelPicker });
    const chip = document.querySelector('.crow .model-chip') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(document.querySelector('.model-menu')).toBeTruthy();
  });
});
