import { describe, it, expect } from 'vitest';
import { pickFollowConversation } from '../src/follow.js';

const c = (id: string, updated_at: string, archived = 0) => ({ id, title: id, created_at: '0', updated_at, archived });

describe('pickFollowConversation', () => {
  it('returns null for an empty list', () => {
    expect(pickFollowConversation([])).toBeNull();
  });
  it('returns null when all are archived', () => {
    expect(pickFollowConversation([c('a', '2', 1)])).toBeNull();
  });
  it('picks the most-recent active', () => {
    expect(pickFollowConversation([c('a', '2026-01-01'), c('b', '2026-02-01'), c('z', '2026-03-01', 1)])).toBe('b');
  });
});
