import { describe, it, expect } from 'vitest';
import { pickFollowBoard } from '../src/follow.js';
import type { BoardSummary } from '../src/types.js';

const b = (id: string, updated_at: number): BoardSummary => ({ id, name: id, updated_at, card_count: 0 });

describe('pickFollowBoard', () => {
  it('returns null for an empty list', () => {
    expect(pickFollowBoard([])).toBeNull();
  });
  it('returns the only board', () => {
    expect(pickFollowBoard([b('a', 1000)])).toBe('a');
  });
  it('picks the most-recently-updated board regardless of input order', () => {
    expect(pickFollowBoard([b('a', 1000), b('c', 3000), b('b', 2000)])).toBe('c');
  });
});
