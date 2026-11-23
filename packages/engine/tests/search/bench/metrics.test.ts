import { describe, it, expect } from 'vitest';
import { rankOf, reciprocalRank, mean, mrr, hitAtK, recallAtK } from '../../../src/search/bench/metrics.js';

describe('bench metrics', () => {
  it('rankOf returns 1-based rank or null', () => {
    expect(rankOf(['a', 'b', 'c'], 'a')).toBe(1);
    expect(rankOf(['a', 'b', 'c'], 'c')).toBe(3);
    expect(rankOf(['a', 'b'], 'z')).toBeNull();
  });

  it('reciprocalRank handles null as 0', () => {
    expect(reciprocalRank(1)).toBe(1);
    expect(reciprocalRank(2)).toBe(0.5);
    expect(reciprocalRank(null)).toBe(0);
  });

  it('mean of empty is 0', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });

  it('mrr averages reciprocal ranks', () => {
    expect(mrr([1, 2, null])).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
  });

  it('hitAtK is fraction of ranks within k', () => {
    expect(hitAtK([1, 2, 5, null], 3)).toBe(0.5); // ranks 1 and 2 are <=3
    expect(hitAtK([], 3)).toBe(0);
  });

  it('recallAtK is fraction of expected found in top k', () => {
    expect(recallAtK(['a', 'b', 'c', 'd'], ['a', 'c'], 2)).toBe(0.5); // only 'a' in top 2
    expect(recallAtK(['a', 'b', 'c', 'd'], ['a', 'b'], 2)).toBe(1);
    expect(recallAtK(['a'], [], 2)).toBe(0);
  });
});
