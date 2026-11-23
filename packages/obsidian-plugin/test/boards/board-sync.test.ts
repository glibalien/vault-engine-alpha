import { describe, expect, it, vi } from 'vitest';
import type { BoardCard } from '@vault/board-core';
import { BoardSync, type BoardPaneSync, type CardsChange } from '../../src/boards/board-sync.js';

const card = (card_id: string, order: number): BoardCard => ({ card_id, spec: {}, layout: { order } });
const append = (id: string): CardsChange => (cards) => [...cards, card(id, cards.length)];

function pane(boardId: string | null, cards: BoardCard[] = []) {
  const p = {
    cards,
    shownBoardId: () => boardId,
    applyChange: vi.fn(async (_boardId: string, change: CardsChange) => { p.cards = change(p.cards); return true; }),
  };
  return p satisfies BoardPaneSync;
}

describe('BoardSync', () => {
  it('has the pane showing the board make the change, and leaves other panes alone', async () => {
    const sync = new BoardSync();
    const shown = pane('b1', [card('c1', 0)]);
    const other = pane('b2');
    sync.register(shown);
    sync.register(other);
    const direct = vi.fn(async () => {});
    expect(await sync.change('b1', append('pinned'), direct)).toBe('pane');
    expect(shown.cards.map((c) => c.card_id)).toEqual(['c1', 'pinned']);
    expect(other.applyChange).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it('writes directly when no pane shows the board, including after a pane unregisters', async () => {
    const sync = new BoardSync();
    const unregister = sync.register(pane('b1'));
    unregister();
    const direct = vi.fn(async () => {});
    const change = append('pinned');
    expect(await sync.change('b1', change, direct)).toBe('direct');
    expect(direct).toHaveBeenCalledWith(change);
  });

  it('runs changes to the same board one at a time, and to different boards independently', async () => {
    const sync = new BoardSync();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = sync.change('b1', append('x'), async () => { events.push('first:start'); await new Promise<void>((r) => { releaseFirst = r; }); events.push('first:end'); });
    const second = sync.change('b1', append('y'), async () => { events.push('second'); });
    const other = sync.change('b2', append('z'), async () => { events.push('other'); });
    await other;
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['first:start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('writes directly when the pane has moved on to another board by the time it would apply', async () => {
    const sync = new BoardSync();
    const moved = pane('b1');
    moved.applyChange.mockResolvedValueOnce(false);
    sync.register(moved);
    const direct = vi.fn(async () => {});
    expect(await sync.change('b1', append('x'), direct)).toBe('direct');
    expect(moved.applyChange).toHaveBeenCalledWith('b1', expect.any(Function));
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("reports a pane's failed save, and a failure doesn't block the next change", async () => {
    const sync = new BoardSync();
    const failing = pane('b1');
    failing.applyChange.mockRejectedValueOnce(new Error('save failed'));
    sync.register(failing);
    await expect(sync.change('b1', append('x'), async () => {})).rejects.toThrow('save failed');
    await expect(sync.change('b1', append('y'), async () => {})).resolves.toBe('pane');
  });
});
