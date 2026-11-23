import { describe, it, expect } from 'vitest';
import type { BoardCard } from '@vault/board-core';
import { pushHistory, applyInverse, MAX_HISTORY, type HistoryEntry } from '../../src/boards/history.js';

const card = (id: string, title = id, order = 0): BoardCard =>
  ({ card_id: id, spec: { kind: 'stats', title }, layout: { order } });

describe('pushHistory', () => {
  it('appends and drops the oldest beyond MAX_HISTORY', () => {
    let stack: HistoryEntry[] = [];
    for (let i = 0; i < MAX_HISTORY + 3; i++) {
      stack = pushHistory(stack, { label: 'create', detail: `e${i}`, inverse: [] });
    }
    expect(stack).toHaveLength(MAX_HISTORY);
    expect(stack[0].detail).toBe('e3');
    expect(stack[stack.length - 1].detail).toBe(`e${MAX_HISTORY + 2}`);
  });
});

describe('applyInverse', () => {
  it('remove_card removes; restore_spec restores; reinsert_card re-adds with stored layout', () => {
    const cards = [card('a', 'A', 0), card('b', 'B', 1)];
    expect(applyInverse(cards, [{ op: 'remove_card', cardId: 'a' }]).map((c) => c.card_id)).toEqual(['b']);
    const restored = applyInverse(cards, [{ op: 'restore_spec', cardId: 'b', spec: { kind: 'stats', title: 'OLD' } }]);
    expect((restored[1].spec as { title: string }).title).toBe('OLD');
    const gone = [card('a', 'A', 0)];
    const back = applyInverse(gone, [{ op: 'reinsert_card', card: card('b', 'B', 1) }]);
    expect(back.map((c) => c.card_id)).toEqual(['a', 'b']);
    expect(back[1].layout.order).toBe(1);
  });
  it('stale inverses no-op silently', () => {
    const cards = [card('a')];
    expect(applyInverse(cards, [{ op: 'remove_card', cardId: 'zzz' }])).toEqual(cards);
    expect(applyInverse(cards, [{ op: 'restore_spec', cardId: 'zzz', spec: { kind: 'stats', title: 'x' } }])).toEqual(cards);
    // reinsert of a card that ALREADY exists must not duplicate it
    expect(applyInverse(cards, [{ op: 'reinsert_card', card: card('a') }])).toHaveLength(1);
  });
  it('applies a list in array order (board-op unwind)', () => {
    const cards = [card('a', 'A', 0), card('new', 'N', 1)];
    const out = applyInverse(cards, [
      { op: 'remove_card', cardId: 'new' },
      { op: 'reinsert_card', card: card('victim', 'V', 2) },
    ]);
    expect(out.map((c) => c.card_id)).toEqual(['a', 'victim']);
  });
  it('remove_card renumbers survivors canonically (0..n-1), not just filters', () => {
    const cards = [card('a', 'A', 0), card('b', 'B', 1), card('c', 'C', 2)];
    const out = applyInverse(cards, [{ op: 'remove_card', cardId: 'b' }]);
    expect(out.map((c) => ({ id: c.card_id, order: c.layout.order }))).toEqual([
      { id: 'a', order: 0 },
      { id: 'c', order: 1 },
    ]);
  });
  it('reinsert_card restores the stored position among renumbered survivors', () => {
    const cards = [card('a', 'A', 0), card('c', 'C', 1)];
    const out = applyInverse(cards, [{ op: 'reinsert_card', card: card('b', 'B', 1) }]);
    expect(out.map((c) => ({ id: c.card_id, order: c.layout.order }))).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });
  it('remove-then-inverse round-trips the original sequence and canonical orders (A,B,C → remove B → undo)', () => {
    const cards = [card('a', 'A', 0), card('b', 'B', 1), card('c', 'C', 2)];
    const victim = cards.find((c) => c.card_id === 'b')!; // captured pre-removal, as applyResolvedOps does
    const afterRemove = applyInverse(cards, [{ op: 'remove_card', cardId: 'b' }]);
    const restored = applyInverse(afterRemove, [{ op: 'reinsert_card', card: victim }]);
    expect(restored.map((c) => ({ id: c.card_id, order: c.layout.order }))).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });
});
