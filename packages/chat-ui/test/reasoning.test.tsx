import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Reasoning, hasTextAfter, type ChatUIPart } from '../src/index.js';

const THOUGHT = '**Finding the notes**\n\nSearching the vault for open tasks.';

describe('Reasoning', () => {
  it('is open while live, filling in as it streams, with a working indicator', () => {
    const { container, rerender } = render(<Reasoning text="Searching" live streaming />);
    expect(container.querySelector('.reasoning.live')).not.toBeNull();
    expect(container.querySelector('.rs-head')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.rs-head')?.textContent).toBe('Thinking…');
    expect(container.querySelector('.spin')).not.toBeNull();
    expect(container.querySelector('.rs-body')?.textContent).toBe('Searching');

    rerender(<Reasoning text={THOUGHT} live streaming />);
    expect(container.querySelector('.rs-body strong')?.textContent).toBe('Finding the notes');
    expect(container.querySelector('.rs-body')?.textContent).toContain('Searching the vault for open tasks.');
  });

  it('stays open without the working indicator once its part is finished but no answer has started', () => {
    const { container } = render(<Reasoning text={THOUGHT} live />);
    expect(container.querySelector('.rs-body')).not.toBeNull();
    expect(container.querySelector('.rs-head')?.textContent).toBe('Thinking');
    expect(container.querySelector('.spin')).toBeNull();
  });

  it('shows no working indicator for a stored part left streaming by a stopped turn', () => {
    const { container } = render(<Reasoning text={THOUGHT} streaming />);
    expect(container.querySelector('.rs-head')?.textContent).toBe('Thinking');
    expect(container.querySelector('.spin')).toBeNull();
    expect(container.querySelector('.rs-body')).toBeNull();
  });

  it('collapses to one line once it is no longer live, and the reader can open it', () => {
    const { container, rerender } = render(<Reasoning text={THOUGHT} live streaming />);
    rerender(<Reasoning text={THOUGHT} live={false} />);
    expect(container.querySelector('.reasoning.live')).toBeNull();
    expect(container.querySelector('.rs-head')?.textContent).toBe('Thinking');
    expect(container.querySelector('.rs-head')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.rs-body')).toBeNull();
    expect(container.querySelector('.spin')).toBeNull();

    fireEvent.click(container.querySelector('.rs-head')!);
    expect(container.querySelector('.rs-body')?.textContent).toContain('Searching the vault');
    fireEvent.keyDown(container.querySelector('.rs-head')!, { key: 'Enter' });
    expect(container.querySelector('.rs-body')).toBeNull();
  });

  it('starts collapsed when it was never live (a stored message)', () => {
    const { container } = render(<Reasoning text={THOUGHT} />);
    expect(container.querySelector('.rs-head')?.textContent).toBe('Thinking');
    expect(container.querySelector('.rs-body')).toBeNull();
  });

  it('keeps the reader closing it while live', () => {
    const { container, rerender } = render(<Reasoning text="Searching" live streaming />);
    fireEvent.click(container.querySelector('.rs-head')!);
    expect(container.querySelector('.rs-body')).toBeNull();
    rerender(<Reasoning text="Searching the vault" live streaming />);
    expect(container.querySelector('.rs-body')).toBeNull();
  });

  it('renders nothing for a part with no text, live or not', () => {
    for (const text of [undefined, '', '  \n ']) {
      for (const live of [true, false]) {
        const { container, unmount } = render(<Reasoning text={text} live={live} streaming={live} />);
        expect(container.innerHTML).toBe('');
        unmount();
      }
    }
  });

  it('opens a wikilink in the reasoning through the host preview', () => {
    const onOpenPreview = vi.fn();
    const { container } = render(<Reasoning text="Checking [[Project Alpha]] first." live onOpenPreview={onOpenPreview} />);
    fireEvent.click(container.querySelector('.rs-body .wl-ref')!);
    expect(onOpenPreview).toHaveBeenCalledWith({ title: 'Project Alpha' });
  });
});

describe('hasTextAfter', () => {
  const parts: ChatUIPart[] = [
    { type: 'step-start' },
    { type: 'reasoning', text: 'first' },
    { type: 'text', text: 'Let me look.' },
    { type: 'dynamic-tool' },
    { type: 'reasoning', text: 'second' },
    { type: 'text', text: '  ' },
  ];

  it('is true only when non-blank text follows the part', () => {
    expect(hasTextAfter(parts, 1)).toBe(true);
    expect(hasTextAfter(parts, 4)).toBe(false);
    expect(hasTextAfter(parts, parts.length - 1)).toBe(false);
    expect(hasTextAfter([{ type: 'reasoning', text: 'x' }, { type: 'text' }], 0)).toBe(false);
  });
});
