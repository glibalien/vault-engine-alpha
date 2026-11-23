import { describe, expect, it } from 'vitest';
import { computeScore, parseJudgeVerdict } from '../src/eval/extraction.js';

describe('extraction eval scoring', () => {
  it('scores coverage = found/expected and precision = 1 - violations/extracted', () => {
    const s = computeScore(
      { title: 'T', expected: ['fact a', 'fact b'] },
      ['fact a', 'ephemera x', 'fact c'],
      { found: ['fact a'], violations: ['ephemera x'] },
    );
    expect(s.coverage).toBeCloseTo(0.5);
    expect(s.precision).toBeCloseTo(2 / 3);
  });

  it('a fixture with no expected facts and no extraction is a perfect score', () => {
    const s = computeScore({ title: 'T', expected: [] }, [], { found: [], violations: [] });
    expect(s.coverage).toBe(1);
    expect(s.precision).toBe(1);
  });

  it('extracting anything from a nothing-expected fixture costs precision only via violations', () => {
    const s = computeScore({ title: 'T', expected: [] }, ['bogus'], { found: [], violations: ['bogus'] });
    expect(s.coverage).toBe(1);
    expect(s.precision).toBe(0);
  });

  it('parseJudgeVerdict tolerates malformed judge output', () => {
    expect(parseJudgeVerdict(null)).toEqual({ found: [], violations: [] });
    expect(parseJudgeVerdict({ found: ['a', 7], violations: 'x' })).toEqual({ found: ['a'], violations: [] });
  });
});
