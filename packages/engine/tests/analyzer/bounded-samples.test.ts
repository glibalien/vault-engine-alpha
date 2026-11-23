import { describe, expect, it } from 'vitest';
import {
  BoundedFirstSamples,
  BoundedLexicographicStringSamples,
} from '../../src/analyzer/bounded-samples.js';

describe('bounded Analyzer samples', () => {
  it('retains only the first ten distinct values and keys under a large stream', () => {
    const samples = new BoundedFirstSamples<string>(10);

    for (let index = 0; index < 20_000; index++) {
      samples.add(`key-${index}`, `value-${index}`);
    }

    expect(samples.retainedKeyCount).toBe(10);
    expect(samples.values()).toEqual(
      Array.from({ length: 10 }, (_, index) => `value-${index}`),
    );
    expect(samples.truncated).toBe(true);
  });

  it('replaces larger retained values when smaller strings arrive late', () => {
    const samples = new BoundedLexicographicStringSamples(10);

    for (let index = 999; index >= 0; index--) {
      samples.add(`value-${String(index).padStart(3, '0')}`);
    }

    expect(samples.retainedSampleCount).toBe(10);
    expect(samples.values()).toEqual(
      Array.from({ length: 10 }, (_, index) => `value-${String(index).padStart(3, '0')}`),
    );
  });
});
