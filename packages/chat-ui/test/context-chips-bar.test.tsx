import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { ContextChipsBar, type ContextChips } from '../src/context/ContextChipsBar.js';

const CHIPS: ContextChips = { doc: true, board: true, nodes: [{ id: 'n1', title: 'Alpha', type: 'note' }] };

function setup(over: Record<string, unknown> = {}) {
  const props = {
    docPath: 'Notes/Doc.md', chips: CHIPS, boards: [{ id: 'b1', name: 'Board 1' }],
    activeBoardId: 'b1', adding: false,
    searchNodes: vi.fn(async () => [{ id: 'n2', title: 'Beta', type: 'note' }]),
    onToggleDoc: vi.fn(), onSelectBoard: vi.fn(), onRemoveNode: vi.fn(),
    onAddClick: vi.fn(), onAddPick: vi.fn(), onAddClose: vi.fn(),
    ...over,
  };
  render(<ContextChipsBar {...(props as never)} />);
  return props;
}

describe('ContextChipsBar', () => {
  afterEach(() => cleanup());

  it('renders doc chip, board select, node chips, + add', () => {
    setup();
    // The doc chip shows the doc's NAME (basename, no .md) so it's clear what joins the context.
    expect(screen.getByTitle('toggle document context').textContent).toBe('Doc');
    expect(screen.getByLabelText('board context')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('+ add')).toBeTruthy();
  });
  it('× removes a node chip', () => {
    const p = setup();
    fireEvent.click(screen.getByTitle('remove from context'));
    expect(p.onRemoveNode).toHaveBeenCalledWith('n1');
  });
  it('empty board select value fires onSelectBoard(null)', () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText('board context'), { target: { value: '' } });
    expect(p.onSelectBoard).toHaveBeenCalledWith(null);
  });
  it('board-follow eye renders only when a handler is provided', () => {
    setup();
    expect(screen.queryByLabelText("follow active note's board")).toBeNull();
    setup({ followBoard: true, onToggleFollowBoard: vi.fn() });
    expect(screen.getByLabelText("follow active note's board")).toBeTruthy();
  });
  it('adding=true shows the picker and a pick calls onAddPick', async () => {
    const p = setup({ adding: true });
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    fireEvent.click(screen.getByText('Beta'));
    expect(p.onAddPick).toHaveBeenCalledWith({ id: 'n2', title: 'Beta', type: 'note' });
  });
  it('no docPath → unbound label, no doc chip or board select', () => {
    setup({ docPath: null });
    expect(screen.getByText('unbound conversation')).toBeTruthy();
    expect(screen.queryByTitle('toggle document context')).toBeNull();
    expect(screen.queryByLabelText('board context')).toBeNull();
  });
});
