import { describe, expect, it } from 'vitest';
import { isStale } from '../src/staleness.js';
import type { Config } from '../src/config.js';

const cfg = {
  staleProjectDays: 14,
  staleSkipStatuses: ['backlog', 'done', 'dropped'],
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
} as Config;

const now = new Date('2026-06-07T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

describe('isStale', () => {
  it('is true when older than the threshold and status is active', () => {
    expect(isStale(daysAgo(20), 'open', cfg, now)).toBe(true);
  });

  it('is false at or under the threshold', () => {
    expect(isStale(daysAgo(14), 'open', cfg, now)).toBe(false); // exactly 14 days is not > 14
    expect(isStale(daysAgo(3), 'open', cfg, now)).toBe(false);
  });

  it('is false for terminal/backlog statuses even when old', () => {
    expect(isStale(daysAgo(99), 'backlog', cfg, now)).toBe(false);
    expect(isStale(daysAgo(99), 'done', cfg, now)).toBe(false);
    expect(isStale(daysAgo(99), 'dropped', cfg, now)).toBe(false);
  });

  it('is false (exempt) when curatedAt is null/undefined/unparseable', () => {
    expect(isStale(null, 'open', cfg, now)).toBe(false);
    expect(isStale(undefined, 'open', cfg, now)).toBe(false);
    expect(isStale('not-a-date', 'open', cfg, now)).toBe(false);
  });

  it('treats a null status as active (eligible)', () => {
    expect(isStale(daysAgo(20), null, cfg, now)).toBe(true);
  });
});
