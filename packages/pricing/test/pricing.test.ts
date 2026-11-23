import { describe, it, expect } from 'vitest';
import {
  pricingForExact, pricingFor, estimateCostUsd, estimateCostUsdWith, resolvePricing, audioPricingFor, audioCostUsd,
  addUsage, ZERO_USAGE, isProviderPricedModel,
} from '../src/index.js';

describe('pricingFor', () => {
  it('resolves exact ids including the new rows', () => {
    expect(pricingFor('accounts/fireworks/models/deepseek-v4-pro')).toEqual(
      { input: 1.74, output: 3.48, cacheWrite: 1.74, cacheRead: 0.145 },
    );
    expect(pricingFor('gemini-2.5-flash')).toEqual(
      { input: 0.3, output: 2.5, cacheWrite: 0.3, cacheRead: 0.03 },
    );
  });

  it('prices minimax-m3 at the Fireworks serverless list rates (0.30/1.20, cached 0.06)', () => {
    expect(pricingFor('accounts/fireworks/models/minimax-m3')).toEqual(
      { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.06 },
    );
  });

  it('prices claude-opus-4-8 at the launch list rates (5/25, cache 0.5/6.25)', () => {
    expect(pricingFor('claude-opus-4-8')).toEqual(
      { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    );
    expect(pricingFor('claude-opus-4-8-fastmode')).toEqual(pricingFor('claude-opus-4-8'));
  });

  it('prices gpt-oss-120b (conversation-title model)', () => {
    expect(pricingFor('accounts/fireworks/models/gpt-oss-120b')).toEqual(
      { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.015 },
    );
  });

  it('falls back by model family', () => {
    expect(pricingFor('deepseek-v4-pro')).toEqual(pricingFor('accounts/fireworks/models/deepseek-v4-pro'));
    expect(pricingFor('claude-sonnet-4-6-20260101')).toEqual(pricingFor('claude-sonnet-4-6'));
    expect(pricingFor('gemini-2.5-flash-latest')).toEqual(pricingFor('gemini-2.5-flash'));
  });

  it('returns null for unknown models', () => {
    expect(pricingFor('totally-unknown')).toBeNull();
    expect(estimateCostUsd('totally-unknown', ZERO_USAGE)).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('prices all four buckets', () => {
    const cost = estimateCostUsd('claude-sonnet-4-6', {
      input: 100_000, output: 10_000, cacheWrite: 20_000, cacheRead: 500_000,
    });
    // (100k*3 + 10k*15 + 20k*3.75 + 500k*0.3) / 1M = 0.675
    expect(cost).toBeCloseTo(0.675, 10);
  });

  it('prices deepseek-v4-pro', () => {
    const cost = estimateCostUsd('accounts/fireworks/models/deepseek-v4-pro', {
      input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0,
    });
    expect(cost).toBeCloseTo(5.22, 10);
  });
});

describe('resolvePricing', () => {
  it('prefers entry pricing and fills cache-rate gaps with the input rate', () => {
    expect(resolvePricing('anthropic/claude-sonnet-5', { input: 2, output: 10 }))
      .toEqual({ input: 2, output: 10, cacheWrite: 2, cacheRead: 2 });
  });
  it('keeps explicit cache rates', () => {
    expect(resolvePricing('x', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }))
      .toEqual({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
  });
  it('falls back to the static table, then null', () => {
    expect(resolvePricing('accounts/fireworks/models/qwen3p7-plus')).toEqual(pricingFor('accounts/fireworks/models/qwen3p7-plus'));
    expect(resolvePricing('totally/unknown')).toBeNull();
  });
});

describe('estimateCostUsdWith', () => {
  it('prices all four buckets from an already-resolved ModelPricing (matches estimateCostUsd)', () => {
    const pricing = pricingFor('claude-sonnet-4-6')!;
    const usage = { input: 100_000, output: 10_000, cacheWrite: 20_000, cacheRead: 500_000 };
    expect(estimateCostUsdWith(pricing, usage)).toBeCloseTo(0.675, 10);
    expect(estimateCostUsdWith(pricing, usage)).toEqual(estimateCostUsd('claude-sonnet-4-6', usage));
  });
});

describe('audio pricing', () => {
  it('prices nova-3 per minute (matched by substring)', () => {
    expect(audioPricingFor('nova-3')).toBe(0.0043);
    expect(audioPricingFor('deepgram-nova-3')).toBe(0.0043);
    expect(audioCostUsd('nova-3', 600)).toBeCloseTo(0.043, 10);
  });

  it('returns null for unknown audio models', () => {
    expect(audioPricingFor('whisper-1')).toBeNull();
    expect(audioCostUsd('whisper-1', 60)).toBeNull();
  });
});

describe('addUsage', () => {
  it('sums bucket-wise', () => {
    expect(addUsage(
      { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
      { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
    )).toEqual({ input: 11, output: 22, cacheWrite: 33, cacheRead: 44 });
  });
});

describe('pricingForExact', () => {
  it('resolves only catalogued IDs without family or prototype matches', () => {
    expect(pricingForExact('accounts/fireworks/models/gpt-oss-120b')).toEqual(pricingFor('accounts/fireworks/models/gpt-oss-120b'));
    expect(pricingForExact('accounts/fireworks/models/deepseek-unknown')).toBeNull();
    expect(pricingForExact('accounts/fireworks/models/qwen3p8-2p4t-a95b')).toBeNull();
    expect(pricingForExact('toString')).toBeNull();
  });
});

describe('isProviderPricedModel', () => {
  it("is true only for OpenRouter's Auto Router, which has no rate row (#340)", () => {
    expect(isProviderPricedModel('openrouter/auto')).toBe(true);
    expect(pricingFor('openrouter/auto')).toBeNull();
    expect(isProviderPricedModel('deepseek/deepseek-v4.1-flash')).toBe(false);
    expect(isProviderPricedModel('toString')).toBe(false);
  });
});

describe('OpenAI rows', () => {
  it('prices GPT-6.1 Terra, GPT-6 Luna and GPT-5.6 at their standard-context list rates, by exact id only, with cache writes at 1.25x input', () => {
    expect(pricingForExact('gpt-6.1-terra')).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.05 });
    expect(pricingForExact('gpt-6-luna')).toEqual({ input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 });
    expect(pricingForExact('gpt-5.6-luna')).toEqual({ input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 });
    expect(pricingForExact('gpt-5.6-terra')).toEqual({ input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 });
    expect(pricingFor('gpt-5.6-luna-2026-11-01')).toBeNull();
    expect(pricingFor('openai/gpt-5.6-luna')).toBeNull();
  });
});
