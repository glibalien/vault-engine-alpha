import { describe, it, expect } from 'vitest';
import { orderBoards } from '../src/order.js';

const b = (id: string, created_at?: number, updated_at = 0) => ({ id, name: id, updated_at, card_count: 1, ...(created_at !== undefined ? { created_at } : {}) });

describe('orderBoards', () => {
  it('orders oldest-created first regardless of update recency', () => {
    expect(orderBoards([b('new', 30, 99), b('old', 10, 1), b('mid', 20, 50)]).map((s) => s.id)).toEqual(['old', 'mid', 'new']);
  });
  it('keeps the given order for undated boards, after dated ones', () => {
    expect(orderBoards([b('x'), b('dated', 5), b('y')]).map((s) => s.id)).toEqual(['dated', 'x', 'y']);
  });
  it('does not mutate its input', () => {
    const input = [b('b', 2), b('a', 1)];
    orderBoards(input);
    expect(input.map((s) => s.id)).toEqual(['b', 'a']);
  });
});
