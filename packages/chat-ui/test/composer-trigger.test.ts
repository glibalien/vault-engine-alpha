import { describe, expect, it } from 'vitest';
import { composerTrigger, nextActive } from '../src/composer/composer-trigger.js';

describe('composerTrigger', () => {
  it('detects @ at index 0', () => {
    expect(composerTrigger('@que', 4)).toEqual({ sigil: '@', from: 0, to: 4, query: 'que' });
  });
  it("'>' is no longer a trigger sigil", () => {
    expect(composerTrigger('>query', 6)).toBeNull();
    expect(composerTrigger('see >tool', 9)).toBeNull();
  });
  it('does not trigger mid-word (emails)', () => {
    expect(composerTrigger('a@b', 3)).toBeNull();
  });
  it('no longer treats # or / as sigils', () => {
    expect(composerTrigger('#task', 5)).toBeNull();
    expect(composerTrigger('/viz', 4)).toBeNull();
  });
  it('query stops at whitespace', () => {
    expect(composerTrigger('@foo bar', 8)).toBeNull();
  });
});

describe('nextActive', () => {
  it('wraps both directions', () => {
    expect(nextActive(0, 3, -1)).toBe(2);
    expect(nextActive(2, 3, 1)).toBe(0);
  });
  it('handles empty lists', () => {
    expect(nextActive(0, 0, 1)).toBe(0);
  });
});
