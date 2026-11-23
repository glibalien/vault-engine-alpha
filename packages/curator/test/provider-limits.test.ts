import { describe, expect, it, vi } from 'vitest';
import type { ModelPricing } from '@vault/pricing';
import { DailyBudget, budgetGate, budgetRefusalDetail, dailyBudgetPolicy, isBudgetRefusal, withDailyBudget, type DailyBudgetPolicy } from '../src/budget.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';
import { createCallDiagnostics } from '../src/llm/diagnostics.js';
import {
  ProviderLimits, ProviderSpendLimitError, nextResetAt, openRouterKeyReader, providerKeyReaders,
  type ProviderKeyStatus,
} from '../src/provider-limits.js';

const KEY_LIMIT_403 = () => Object.assign(new Error('403 Key limit exceeded (daily limit).'), {
  status: 403, error: { message: 'Key limit exceeded (daily limit). $3.00 of $3.00 used' },
});

/** A fail-closed call's projected failure: no provider text, only the scalar HTTP status. */
const failClosed = (status: number) => new StructuredCallFailure('structured call failed', undefined,
  'provider_transport_failed', { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [],
    failure: { attempt: 0, kind: 'http', status } });

function limits(status: ProviderKeyStatus | (() => Promise<ProviderKeyStatus>) | null, at = '2026-11-04T10:50:00Z') {
  let now = new Date(at);
  const read = vi.fn(typeof status === 'function' ? status : async () => {
    if (status === null) throw new Error('HTTP 500');
    return status;
  });
  const warn = vi.fn();
  const l = new ProviderLimits(status === undefined ? {} : { openrouter: read }, () => now, 5 * 60_000, warn);
  return { l, read, warn, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('nextResetAt', () => {
  it('resets at midnight UTC; weeks run Monday to Sunday', () => {
    const at = new Date('2026-11-04T10:50:00Z'); // a Wednesday
    expect(nextResetAt('daily', at).toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(nextResetAt('weekly', at).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(nextResetAt('weekly', new Date('2026-11-09T00:00:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(nextResetAt('weekly', new Date('2026-11-08T23:00:00Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(nextResetAt('monthly', new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('openRouterKeyReader', () => {
  it('reads the calling key\'s limit, what remains and its period', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: { limit: 3, limit_remaining: 0.25, limit_reset: 'daily', usage_daily: 2.75 } })));
    const status = await openRouterKeyReader('sk-test', 'https://openrouter.ai/api/v1/', fetchFn as unknown as typeof fetch)();
    expect(status).toEqual({ limitUsd: 3, remainingUsd: 0.25, reset: 'daily' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('reports no limit as nulls, and throws on an HTTP error or a body without data', async () => {
    const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await openRouterKeyReader('k', 'https://x', reply({ data: { limit: null, limit_remaining: null, limit_reset: null } }))())
      .toEqual({ limitUsd: null, remainingUsd: null, reset: null });
    await expect(openRouterKeyReader('k', 'https://x', reply({}, 401))()).rejects.toThrow('HTTP 401');
    await expect(openRouterKeyReader('k', 'https://x', reply({ nope: 1 }))()).rejects.toThrow('no data');
  });

  it('is configured only when an OpenRouter key is set', () => {
    expect(providerKeyReaders({ keys: {}, baseURLs: {} })).toEqual({});
    expect(Object.keys(providerKeyReaders({ keys: { openrouter: 'k', fireworks: 'f' }, baseURLs: {} }))).toEqual(['openrouter']);
  });
});

describe('ProviderLimits.classify', () => {
  it('recognizes a key-limit 403 by its wording, stops the provider until the period resets', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 0, reset: 'daily' });
    const refusal = await l.classify('openrouter', KEY_LIMIT_403());
    expect(refusal).toBeInstanceOf(ProviderSpendLimitError);
    expect(isBudgetRefusal(refusal)).toBe(true);
    expect(refusal?.resetsAt).toBe('2026-11-05T00:00:00.000Z');
    expect(refusal?.message).toBe('OpenRouter refused calls: key spend limit or credit reached ($3.00 daily limit); '
      + 'resets 2026-11-05T00:00:00.000Z');
    await expect(l.admit('openrouter', 0.01)).rejects.toBeInstanceOf(ProviderSpendLimitError);
  });

  it('takes the reset time from the provider\'s wording when it gives one', async () => {
    const { l } = limits(null);
    const error = Object.assign(new Error('403'), { status: 403,
      error: { message: 'Key limit exceeded. $1.07 of $1.00 used; resets 2026-11-06T00:00:00.000Z.' } });
    expect((await l.classify('openrouter', error))?.resetsAt).toBe('2026-11-06T00:00:00.000Z');
  });

  it('counts a bare 403 only when the key shows nothing left (a 403 can also be moderation)', async () => {
    const spent = limits({ limitUsd: 3, remainingUsd: 0, reset: 'daily' });
    expect(await spent.l.classify('openrouter', failClosed(403))).toBeInstanceOf(ProviderSpendLimitError);
    expect(spent.read).toHaveBeenCalledTimes(1);
    const left = limits({ limitUsd: 3, remainingUsd: 1.5, reset: 'daily' });
    expect(await left.l.classify('openrouter', failClosed(403))).toBeNull();
    const unknown = limits(null);
    expect(await unknown.l.classify('openrouter', failClosed(403))).toBeNull();
  });

  it('treats a 402 and the other providers\' credit wording as a spend limit', async () => {
    const { l } = limits(null);
    expect(await l.classify('openrouter', Object.assign(new Error('402 Insufficient credits'), { status: 402 }))).not.toBeNull();
    const noReader = new ProviderLimits({}, () => new Date('2026-11-04T10:00:00Z'), 60_000, () => {});
    const anthropic = await noReader.classify('anthropic', Object.assign(new Error('400 Your credit balance is too low'), { status: 400 }));
    // Nothing says when it resets and no read can clear it, so the stop lasts an hour.
    expect(anthropic?.resetsAt).toBe('2026-11-04T11:00:00.000Z');
    expect(await noReader.classify('openai', Object.assign(new Error('429 insufficient_quota'), { status: 429 }))).not.toBeNull();
  });

  it('recognizes a quota code kept in a fail-closed call\'s diagnostics', async () => {
    const noReader = new ProviderLimits({}, () => new Date('2026-11-04T10:00:00Z'), 60_000, () => {});
    const projected = new StructuredCallFailure('structured call failed', undefined, 'provider_transport_failed',
      { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [], failure: { attempt: 0, kind: 'http', status: 429, code: 'insufficient_quota' } });
    expect(await noReader.classify('openai', projected)).toBeInstanceOf(ProviderSpendLimitError);
    const raw = Object.assign(new Error('429 You exceeded your request rate'), { status: 429, code: 'insufficient_quota' });
    expect(await noReader.classify('openai', raw)).toBeInstanceOf(ProviderSpendLimitError);
    const throttled = new StructuredCallFailure('structured call failed', undefined, 'provider_transport_failed',
      { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [], failure: { attempt: 0, kind: 'http', status: 429, code: 'rate_limit_exceeded' } });
    expect(await noReader.classify('openai', throttled)).toBeNull();
  });

  it('bounds a stop with no reset time even when status reads keep failing', async () => {
    const { l, advance } = limits(null); // every read fails
    const refusal = await l.classify('openrouter', Object.assign(new Error('402 Insufficient credits'), { status: 402 }));
    expect(refusal?.resetsAt).toBe('2026-11-04T11:50:00.000Z');
    expect(refusal?.message).toMatch(/; retried after 2026-11-04T11:50:00\.000Z$/);
    await expect(l.admit('openrouter', 0)).rejects.toBeInstanceOf(ProviderSpendLimitError);
    advance(60 * 60_000);
    await expect(l.admit('openrouter', 0)).resolves.toBe(0);
  });

  it('ignores ordinary failures', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 2, reset: 'daily' });
    for (const error of [Object.assign(new Error('400 bad schema'), { status: 400 }), Object.assign(new Error('429 slow down'), { status: 429 }),
      Object.assign(new Error('500'), { status: 500 }), new Error('socket hang up'), failClosed(500), null]) {
      expect(await l.classify('openrouter', error)).toBeNull();
    }
    expect(await l.classify(null, KEY_LIMIT_403())).toBeNull();
    await expect(l.admit('openrouter', 0.01)).resolves.toBe(0.01);
  });
});

describe('ProviderLimits stops', () => {
  it('clears at the reset time', async () => {
    const { l, advance } = limits(null);
    await l.classify('openrouter', KEY_LIMIT_403());
    await expect(l.admit('openrouter', 0)).rejects.toThrow('resets 2026-11-05T00:00:00.000Z');
    advance(14 * 3_600_000); // past midnight UTC
    await expect(l.admit('openrouter', 0)).resolves.toBe(0);
  });

  it('clears early when a later read shows money left (the owner raised the limit)', async () => {
    let status: ProviderKeyStatus = { limitUsd: 3, remainingUsd: 0, reset: 'daily' };
    const { l, advance, read } = limits(async () => status);
    await l.classify('openrouter', failClosed(403));
    await expect(l.admit('openrouter', 0.01)).rejects.toBeInstanceOf(ProviderSpendLimitError);
    status = { limitUsd: 10, remainingUsd: 7, reset: 'daily' };
    await expect(l.admit('openrouter', 0.01)).rejects.toBeInstanceOf(ProviderSpendLimitError); // cached read
    advance(5 * 60_000);
    await expect(l.admit('openrouter', 0.01)).resolves.toBe(0.01);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('ProviderLimits remaining allowance', () => {
  it('admits a call only if its worst case fits what remains, counting calls since the read', async () => {
    const { l, advance, read } = limits({ limitUsd: 3, remainingUsd: 0.1, reset: 'daily' });
    const held = await l.admit('openrouter', 0.06);
    // In flight: $0.06 of $0.10; another $0.06 doesn't fit.
    await expect(l.admit('openrouter', 0.06)).rejects.toThrow(
      'OpenRouter key limit: $0.04 left of $3.00 daily; this call could cost up to $0.0600; resets 2026-11-05T00:00:00.000Z');
    l.settle('openrouter', held, 0.02);
    await expect(l.admit('openrouter', 0.06)).resolves.toBe(0.06); // $0.08 left after the $0.02 call
    expect(read).toHaveBeenCalledTimes(1);
    advance(5 * 60_000);
    await l.admit('openrouter', 0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads again once the key\'s period resets, even inside the cache time', async () => {
    let status: ProviderKeyStatus = { limitUsd: 3, remainingUsd: 0, reset: 'daily' };
    const { l, advance, read } = limits(async () => status, '2026-11-04T23:59:30Z');
    expect(await l.spentDetail(['openrouter'])).toBe('OpenRouter key limit spent; resets 2026-11-05T00:00:00.000Z');
    status = { limitUsd: 3, remainingUsd: 3, reset: 'daily' };
    advance(31_000); // 00:00:01, 31 s after the reading
    expect(await l.spentDetail(['openrouter'])).toBeNull();
    await expect(l.admit('openrouter', 0.5)).resolves.toBe(0.5);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('flags an OpenAI-SDK-shaped key-limit error in call diagnostics, and nothing else', () => {
    const flag = (error: unknown) => {
      const d = createCallDiagnostics(true, true);
      d.start(); d.failure(error);
      return d.snapshot()?.failure?.spendLimit;
    };
    expect(flag(Object.assign(new Error('403 Provider returned error'), { status: 403,
      error: { message: 'Key limit exceeded (daily limit). Manage it at the keys page.' } }))).toBe(true);
    expect(flag(Object.assign(new Error('429'), { status: 429, error: { code: 'insufficient_quota', message: 'quota' } }))).toBe(true);
    expect(flag(Object.assign(new Error('403 flagged for moderation'), { status: 403 }))).toBeUndefined();
    expect(flag(new Error('Key limit exceeded but no status'))).toBeUndefined();
  });

  it('recognizes a redacted OpenAI-compatible key-limit refusal from the adapter\'s flag', async () => {
    const noReader = new ProviderLimits({}, () => new Date('2026-11-04T10:00:00Z'), 60_000, () => {});
    const flagged = new StructuredCallFailure('structured call failed', undefined, 'provider_transport_failed',
      { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [], failure: { attempt: 0, kind: 'http', status: 403, spendLimit: true } });
    expect(await noReader.classify('openrouter', flagged)).toBeInstanceOf(ProviderSpendLimitError);
  });

  it('admits calls when the status read fails, and reads again after the cache time', async () => {
    const { l, read, warn, advance } = limits(null);
    await expect(l.admit('openrouter', 5)).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith('OpenRouter key status unavailable: HTTP 500');
    await l.admit('openrouter', 5);
    expect(read).toHaveBeenCalledTimes(1);
    advance(5 * 60_000);
    await l.admit('openrouter', 5);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('places no limit on a key without one, or a provider it cannot read', async () => {
    const { l } = limits({ limitUsd: null, remainingUsd: null, reset: null });
    await expect(l.admit('openrouter', 100)).resolves.toBe(0);
    await expect(l.admit('fireworks', 100)).resolves.toBe(0);
    await expect(l.admit(null, 100)).resolves.toBe(0);
  });

  it('says when the wiki providers are spent, and reports each limit for status', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 0, reset: 'daily' });
    expect(await l.spentDetail(['openrouter'])).toBe('OpenRouter key limit spent; resets 2026-11-05T00:00:00.000Z');
    expect(await l.spentDetail(['fireworks'])).toBeNull();
    expect(await l.report(['openrouter', 'fireworks'])).toEqual([{ provider: 'openrouter', limit_usd: 3, remaining_usd: 0,
      reset: 'daily', resets_at: '2026-11-05T00:00:00.000Z', stopped: null }]);
    await l.classify('openrouter', KEY_LIMIT_403());
    expect(await l.spentDetail(['openrouter'])).toMatch(/^OpenRouter refused calls: key spend limit or credit reached/);
  });
});

describe('withDailyBudget with provider limits', () => {
  const PRICE: ModelPricing = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 };
  const policy = (capUsd: number | null): DailyBudgetPolicy => ({ capUsd, tz: 'UTC', pricing: () => PRICE,
    provider: model => model.includes('/') ? 'openrouter' : null, wikiProviders: ['openrouter'] });
  const request = (patch: Partial<StructuredCallRequest> = {}): StructuredCallRequest => ({
    model: 'qwen/model', maxTokens: 1_000, system: 's', user: 'u', toolName: 't', toolDescription: 'd', schema: {}, ...patch,
  });
  const USAGE = { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 };

  it('turns a key-limit refusal into a budget refusal and refuses later calls before dispatch', async () => {
    // The last read still showed money left; the provider's refusal is what stops it.
    const { l } = limits({ limitUsd: 3, remainingUsd: 2, reset: 'daily' });
    const inner = { structuredCall: vi.fn(async () => { throw KEY_LIMIT_403(); }) } as unknown as LlmClient;
    const llm = withDailyBudget(inner, new DailyBudget(async () => 0, undefined, undefined, l), policy(12));
    const first = await llm.structuredCall(request()).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ProviderSpendLimitError);
    expect((first as Error).cause).toMatchObject({ status: 403 });
    await expect(llm.structuredCall(request())).rejects.toBeInstanceOf(ProviderSpendLimitError);
    expect(inner.structuredCall).toHaveBeenCalledTimes(1);
    // A model on another provider is unaffected.
    await expect(llm.structuredCall(request({ model: 'claude-local' }))).rejects.toMatchObject({ status: 403 });
    expect(inner.structuredCall).toHaveBeenCalledTimes(2);
  });

  it('applies the key limit even with no Curator cap, and releases the cap hold when the key refuses', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 0.001, reset: 'daily' });
    const inner = { structuredCall: vi.fn(async () => ({ output: {}, usage: USAGE })) } as unknown as LlmClient;
    const uncapped = withDailyBudget(inner, new DailyBudget(async () => 0, undefined, undefined, l), policy(null));
    await expect(uncapped.structuredCall(request())).rejects.toThrow(/OpenRouter key limit: \$0\.00 left of \$3\.00 daily/);
    const budget = new DailyBudget(async () => 0, undefined, undefined, l);
    const capped = withDailyBudget(inner, budget, policy(12));
    await expect(capped.structuredCall(request())).rejects.toBeInstanceOf(ProviderSpendLimitError);
    expect(budget.reservedUsd).toBe(0);
    expect(inner.structuredCall).not.toHaveBeenCalled();
  });

  it('counts each settled call against the key until the next read', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 0.025, reset: 'daily' });
    const inner = { structuredCall: vi.fn(async () => ({ output: {}, usage: USAGE })) } as unknown as LlmClient;
    const llm = withDailyBudget(inner, new DailyBudget(async () => 0, undefined, undefined, l), policy(12));
    // Worst case ~$0.0105 per call; each settles at $0.006, so a fourth no longer fits ($0.007 left).
    await llm.structuredCall(request());
    await llm.structuredCall(request());
    await llm.structuredCall(request());
    await expect(llm.structuredCall(request())).rejects.toBeInstanceOf(ProviderSpendLimitError);
    expect(inner.structuredCall).toHaveBeenCalledTimes(3);
  });

  it('passes other failures through unchanged', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 2, reset: 'daily' });
    const rejection = Object.assign(new Error('400 bad schema'), { status: 400 });
    const inner = { structuredCall: vi.fn(async () => { throw rejection; }) } as unknown as LlmClient;
    const llm = withDailyBudget(inner, new DailyBudget(async () => 0, undefined, undefined, l), policy(12));
    await expect(llm.structuredCall(request())).rejects.toBe(rejection);
  });

  it('keeps billed usage on a usage-bearing failure it reclassifies', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 2, reset: 'daily' });
    const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
    const failure = new StructuredCallFailure('structured call failed', usage, 'provider_transport_failed',
      { version: 1, adapterAttempts: 2, sdkAttempts: 2, responses: [], failure: { attempt: 1, kind: 'http', status: 402 } });
    const inner = { structuredCall: vi.fn(async () => { throw failure; }) } as unknown as LlmClient;
    const llm = withDailyBudget(inner, new DailyBudget(async () => 0, undefined, undefined, l), policy(12));
    const error = await llm.structuredCall(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect(error).toMatchObject({ usage, reason: 'provider_transport_failed' });
    expect(isBudgetRefusal(error)).toBe(true);
    expect(budgetRefusalDetail(error)).toMatch(/^OpenRouter refused calls: key spend limit or credit reached/);
  });

  it('checks the provider a bound configuration calls, not the run\'s current route', async () => {
    const { l } = limits({ limitUsd: 3, remainingUsd: 2, reset: 'daily' });
    await l.classify('openrouter', KEY_LIMIT_403()); // OpenRouter is stopped
    const inner = { structuredCall: vi.fn(async () => ({ output: {}, usage: USAGE })),
      configurationFor: () => ({ provider: 'fireworks' as const, reasoningEffort: null }) } as unknown as LlmClient;
    const llm = withDailyBudget(inner, new DailyBudget(async () => 0, undefined, undefined, l), policy(12));
    await expect(llm.structuredCall(request())).resolves.toMatchObject({ usage: USAGE });
  });

  it('builds the provider route and wiki providers from the run config', async () => {
    const p = dailyBudgetPolicy({ dailyBudgetCents: 300, curatorTz: 'UTC', modelPricing: {},
      modelProviders: { 'qwen/a': 'openrouter', 'accounts/fireworks/models/b': 'fireworks' },
      model: 'qwen/a', wikiPlanningModel: null, wikiPageModel: 'accounts/fireworks/models/b', wikiHomeModel: undefined });
    expect(p.provider?.('qwen/a')).toBe('openrouter');
    expect(p.provider?.('unknown/model')).toBeNull();
    expect(p.wikiProviders).toEqual(['openrouter', 'fireworks']);
    const { l } = limits({ limitUsd: 3, remainingUsd: 0, reset: 'daily' });
    const gate = budgetGate(new DailyBudget(async () => 0, undefined, undefined, l), p);
    expect(await gate.providerSpent?.()).toBe('OpenRouter key limit spent; resets 2026-11-05T00:00:00.000Z');
    expect(await gate.remainingUsd()).toBe(3);
    // Only each stage's effective model counts: with every stage overridden, `model` is unused.
    expect(dailyBudgetPolicy({ dailyBudgetCents: 300, curatorTz: 'UTC', modelPricing: {},
      modelProviders: { 'qwen/a': 'openrouter', 'accounts/fireworks/models/b': 'fireworks' }, model: 'qwen/a',
      wikiPlanningModel: 'accounts/fireworks/models/b', wikiPageModel: 'accounts/fireworks/models/b',
      wikiHomeModel: 'accounts/fireworks/models/b' }).wikiProviders).toEqual(['fireworks']);
  });
});
