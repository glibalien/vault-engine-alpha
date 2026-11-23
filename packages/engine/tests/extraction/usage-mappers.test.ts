import { describe, it, expect } from 'vitest';
import { geminiUsageTokens } from '../../src/extraction/extractors/gemini-vision.js';
import { usageTokenFields } from '../../src/usage/recorder.js';
import { deepgramAudioSeconds } from '../../src/extraction/extractors/deepgram.js';

describe('deepgramAudioSeconds', () => {
  it('returns the billed duration when Deepgram reports one', () => {
    expect(deepgramAudioSeconds({ duration: 123.5 })).toBe(123.5);
  });

  it('returns undefined when the duration is missing, so the event prices as unpriced', () => {
    // `?? 0` here would bill a real transcription as $0 with cost_basis
    // 'computed' — the ledger asserting a falsehood rather than admitting
    // it does not know the duration.
    expect(deepgramAudioSeconds(undefined)).toBeUndefined();
    expect(deepgramAudioSeconds({})).toBeUndefined();
  });

  it('keeps a genuine zero-length result distinguishable from a missing one', () => {
    expect(deepgramAudioSeconds({ duration: 0 })).toBe(0);
  });
});

describe('geminiUsageTokens', () => {
  it('subtracts cached tokens out of the prompt count', () => {
    expect(geminiUsageTokens({ promptTokenCount: 1000, candidatesTokenCount: 200, cachedContentTokenCount: 300 }))
      .toEqual({ inputTokens: 700, outputTokens: 200, cacheReadTokens: 300 });
  });
  it('tolerates missing metadata', () => {
    expect(geminiUsageTokens(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });
});

describe('usageTokenFields', () => {
  it('maps normalized usage onto the recorder token fields', () => {
    expect(usageTokenFields({ input: 500, output: 100, cacheRead: 2000, cacheWrite: 300 }))
      .toEqual({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 300 });
  });
});
