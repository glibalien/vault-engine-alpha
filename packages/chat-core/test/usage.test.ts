import { describe, it, expect } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { usageEventArgs, callBilling, combineBilling } from '../src/usage.js';

/** ai@7 replaced the flat `cachedInputTokens` with nested token details. */
function usage(u: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  noCacheTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}): LanguageModelUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
    inputTokenDetails: {
      noCacheTokens: u.noCacheTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
    },
    outputTokenDetails: {},
  } as unknown as LanguageModelUsage;
}

describe('usageEventArgs', () => {
  it('prefers the SDK-reported non-cached input count over subtracting ourselves', () => {
    expect(usageEventArgs({
      model: 'accounts/fireworks/models/qwen3p7-plus',
      provider: 'fireworks',
      service: 'chat-web',
      totalUsage: usage({ inputTokens: 10_000, outputTokens: 500, noCacheTokens: 6_000, cacheReadTokens: 4_000 }),
      conversationId: 'conv-1',
      latencyMs: 1234.6,
    })).toEqual({
      provider: 'fireworks',
      service: 'chat-web',
      purpose: 'conversation',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      input_tokens: 6_000,
      output_tokens: 500,
      cache_read_tokens: 4_000,
      conversation_id: 'conv-1',
      latency_ms: 1235,
    });
  });

  it('falls back to inputTokens - cacheRead when the SDK omits noCacheTokens', () => {
    expect(usageEventArgs({
      model: 'm', provider: 'fireworks', service: 'chat-web',
      totalUsage: usage({ inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 4_000 }),
    })).toMatchObject({ input_tokens: 6_000, cache_read_tokens: 4_000 });
  });

  it('reports cache WRITE tokens, which the pre-ai@7 usage shape could not express', () => {
    // The ledger has always had a cache_write_tokens column and @vault/pricing
    // prices cacheWrite separately; v5's flat usage had no field for it, so
    // every cache-write token was billed at the plain input rate.
    expect(usageEventArgs({
      model: 'claude-sonnet-4-6', provider: 'anthropic', service: 'chat-plugin',
      totalUsage: usage({ inputTokens: 9_000, outputTokens: 100, noCacheTokens: 1_000, cacheReadTokens: 5_000, cacheWriteTokens: 3_000 }),
    })).toMatchObject({
      input_tokens: 1_000,
      cache_read_tokens: 5_000,
      cache_write_tokens: 3_000,
    });
  });

  it('omits cache_write_tokens entirely when the provider did not report it', () => {
    // Absent must stay absent (the recorder writes NULL), not become a reported
    // 0 — "not measured" and "measured as zero" are different facts.
    const args = usageEventArgs({
      model: 'm', provider: 'fireworks', service: 'chat-web',
      totalUsage: usage({ inputTokens: 100, outputTokens: 10 }),
    });
    expect(args).not.toHaveProperty('cache_write_tokens');
  });

  it('maps an anthropic turn, carrying the anthropic provider label through', () => {
    expect(usageEventArgs({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      service: 'chat-web',
      totalUsage: usage({ inputTokens: 1_000, outputTokens: 200 }),
    })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('returns null when the provider reported no usage (aborted stream)', () => {
    expect(usageEventArgs({
      model: 'm', provider: 'fireworks', service: 'chat-plugin',
      totalUsage: usage({}),
    })).toBeNull();
  });

  it('omits optional attribution when absent', () => {
    const args = usageEventArgs({
      model: 'm', provider: 'fireworks', service: 'chat-plugin',
      totalUsage: usage({ inputTokens: 10, outputTokens: 1 }),
    });
    expect(args).not.toBeNull();
    expect(args).not.toHaveProperty('conversation_id');
    expect(args).not.toHaveProperty('latency_ms');
  });

  it("carries an explicit purpose through (title-generation)", () => {
    expect(usageEventArgs({
      model: 'accounts/fireworks/models/gpt-oss-120b',
      provider: 'fireworks',
      service: 'chat-web',
      purpose: 'title-generation',
      totalUsage: usage({ inputTokens: 300, outputTokens: 12 }),
      conversationId: 'conv-1',
    })).toMatchObject({ purpose: 'title-generation', model: 'accounts/fireworks/models/gpt-oss-120b' });
  });

  it('passes the viz-interpret purpose through', () => {
    const args = usageEventArgs({
      model: 'm', provider: 'fireworks', service: 'chat-plugin', purpose: 'viz-interpret',
      totalUsage: usage({ inputTokens: 10, outputTokens: 5 }),
    });
    expect(args?.purpose).toBe('viz-interpret');
  });
});

describe('OpenRouter billing (#330)', () => {
  const meta = (cost: unknown) => ({ openrouter: { usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost } } });

  it("reads OpenRouter's reported charge and the response id from one call", () => {
    expect(callBilling({ providerMetadata: meta(0.0123), response: { id: 'gen-1' } }))
      .toEqual({ providerCostUsd: 0.0123, requestId: 'gen-1' });
    expect(callBilling({ providerMetadata: meta(0), response: { id: 'gen-0' } })).toEqual({ providerCostUsd: 0, requestId: 'gen-0' });
  });

  it('reports nothing it was not given, never a zero', () => {
    expect(callBilling({})).toEqual({});
    expect(callBilling({ providerMetadata: { anthropic: {} }, response: { id: '' } })).toEqual({});
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '0.1', null]) {
      expect(callBilling({ providerMetadata: meta(bad) })).toEqual({});
    }
  });

  it('sums a multi-call charge only when every call reported one, and keeps an id only for one call', () => {
    expect(combineBilling([{ providerCostUsd: 0.01, requestId: 'a' }, { providerCostUsd: 0.02, requestId: 'b' }]))
      .toEqual({ providerCostUsd: 0.03 });
    expect(combineBilling([{ providerCostUsd: 0.01, requestId: 'a' }, { requestId: 'b' }])).toEqual({});
    expect(combineBilling([{ providerCostUsd: 0.01, requestId: 'a' }])).toEqual({ providerCostUsd: 0.01, requestId: 'a' });
    expect(combineBilling([])).toEqual({});
  });

  it('sends the charge and id to record-usage, and leaves them out when absent', () => {
    const base = { model: 'qwen/qwen3.7-plus', provider: 'openrouter' as const, service: 'chat-plugin' as const,
      totalUsage: usage({ inputTokens: 10, outputTokens: 5 }) };
    expect(usageEventArgs({ ...base, billing: { providerCostUsd: 0.004, requestId: 'gen-9' } }))
      .toMatchObject({ provider_cost_usd: 0.004, request_id: 'gen-9', input_tokens: 10, output_tokens: 5 });
    const plain = usageEventArgs({ ...base, billing: {} })!;
    expect(plain).not.toHaveProperty('provider_cost_usd');
    expect(plain).not.toHaveProperty('request_id');
  });
});

describe('Routed model (#340)', () => {
  it("reads the response's model from a call, and nothing when it is missing or empty", () => {
    expect(callBilling({ response: { id: 'gen-1', modelId: 'deepseek/deepseek-v4.1-flash' } }))
      .toEqual({ requestId: 'gen-1', reportedModel: 'deepseek/deepseek-v4.1-flash' });
    expect(callBilling({ response: { modelId: '' } })).toEqual({});
    expect(callBilling({ response: { modelId: 7 } })).toEqual({});
  });

  it('keeps a combined model only when every call named the same one', () => {
    expect(combineBilling([{ reportedModel: 'a/x' }, { reportedModel: 'a/x' }])).toEqual({ reportedModel: 'a/x' });
    expect(combineBilling([{ reportedModel: 'a/x' }, { reportedModel: 'b/y' }])).toEqual({});
    expect(combineBilling([{ reportedModel: 'a/x' }, {}])).toEqual({});
  });

  it('sends reported_model to record-usage, and leaves it out when absent', () => {
    const base = { model: 'openrouter/auto', provider: 'openrouter' as const, service: 'chat-plugin' as const,
      totalUsage: usage({ inputTokens: 10, outputTokens: 5 }) };
    expect(usageEventArgs({ ...base, billing: { reportedModel: 'z-ai/glm-5.2' } })).toMatchObject({ model: 'openrouter/auto', reported_model: 'z-ai/glm-5.2' });
    expect(usageEventArgs({ ...base, billing: {} })).not.toHaveProperty('reported_model');
  });
});
