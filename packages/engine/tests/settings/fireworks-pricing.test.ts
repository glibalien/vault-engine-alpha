import { afterEach, describe, expect, it, vi } from 'vitest';
import { FireworksPricingResolver, parseFireworksPricing } from '../../src/settings/fireworks-pricing.js';

const MODEL = 'accounts/fireworks/models/qwen3p8-max';
import { ratePage } from '../helpers/fireworks-pricing.js';
const price = { input: 2, output: 6, cacheRead: 0.25 };
afterEach(() => vi.useRealTimers());

describe('parseFireworksPricing', () => {
  it('reads the exact model’s explicitly labelled per-million rates', () => {
    expect(parseFireworksPricing(ratePage(), MODEL)).toEqual(price);
    expect(parseFireworksPricing(ratePage(MODEL, '$0 / $0', '1M Tokens', 'input/output'), MODEL))
      .toEqual({ input: 0, output: 0 });
  });
  it('rejects alias transitions, ambiguous identities, and duplicate rate cards', () => {
    expect(parseFireworksPricing(ratePage(), 'accounts/fireworks/models/qwen3p8-2p4t-a95b')).toBeNull();
    expect(parseFireworksPricing(ratePage() + ratePage(), MODEL)).toBeNull();
    expect(parseFireworksPricing(ratePage() + '<span>model path:</span><span>accounts/fireworks/models/other</span>', MODEL)).toBeNull();
  });
  it.each([
    ['$2 / $0.25 / $6', '1K Tokens', 'input/cached input/output'],
    ['$2 / $0.25 / $6', '1M Tokens', 'output/cached input/input'],
    ['$-2 / $0.25 / $6', '1M Tokens', 'input/cached input/output'],
    ['$2 / NaN / $6', '1M Tokens', 'input/cached input/output'],
    ['$2 / $0.25 / $6 / $8', '1M Tokens', 'input/cached input/output'],
  ])('rejects unsupported or malformed rates %s %s %s', (rates, units, labels) => {
    expect(parseFireworksPricing(ratePage(MODEL, rates, units, labels), MODEL)).toBeNull();
  });
  it('does not read rate cards from scripts or comments', () => {
    expect(parseFireworksPricing(`<script>${ratePage()}</script><!-- ${ratePage()} -->`, MODEL)).toBeNull();
  });
});

describe('FireworksPricingResolver', () => {
  it('deduplicates in-flight and cached reads; fresh lookups revalidate', async () => {
    const fetchImpl = vi.fn(async () => new Response(ratePage()));
    const resolver = new FireworksPricingResolver(fetchImpl);
    expect(await Promise.all([resolver.resolve(MODEL), resolver.resolve(MODEL)])).toEqual([price, price]);
    expect(await resolver.resolve(MODEL)).toEqual(price);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockImplementation(async () => new Response(ratePage(MODEL, '$3 / $0.5 / $9')));
    expect(await resolver.resolve(MODEL, true)).toEqual({ input: 3, output: 9, cacheRead: 0.5 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]).toEqual([
      'https://fireworks.ai/models/fireworks/qwen3p8-max',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    ]);
  });
  it('waits for an old in-flight discovery before fetching fresh addition pricing', async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockImplementation(async () => new Response(ratePage(MODEL, '$3 / $0.5 / $9')));
    const resolver = new FireworksPricingResolver(fetchImpl);
    const discovery = resolver.resolve(MODEL);
    const addition = resolver.resolve(MODEL, true);
    release(new Response(ratePage()));
    expect(await discovery).toEqual(price);
    expect(await addition).toEqual({ input: 3, output: 9, cacheRead: 0.5 });
    expect(await resolver.resolve(MODEL)).toEqual({ input: 3, output: 9, cacheRead: 0.5 });
  });
  it('falls back only to exact static entries and never retains stale live pricing on refresh failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(ratePage()));
    const resolver = new FireworksPricingResolver(fetchImpl);
    await resolver.resolve(MODEL);
    fetchImpl.mockRejectedValue(new Error('offline'));
    expect(await resolver.resolve(MODEL, true)).toBeNull();
    expect(await resolver.resolve('accounts/fireworks/models/gpt-oss-120b')).toMatchObject({ input: 0.15, output: 0.6 });
    expect(await resolver.resolve('accounts/fireworks/models/deepseek-unknown')).toBeNull();
  });
  it('expires successful and failed cache entries', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(ratePage()));
    const resolver = new FireworksPricingResolver(fetchImpl);
    await resolver.resolve(MODEL);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    fetchImpl.mockRejectedValue(new Error('offline'));
    expect(await resolver.resolve(MODEL)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await resolver.resolve(MODEL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await resolver.resolve(MODEL);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([
    { model: MODEL, fallback: null },
    { model: 'accounts/fireworks/models/gpt-oss-120b', fallback: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.15 } },
  ])('replaces stale live pricing with the short-lived fallback when saturated: $model', async ({ model, fallback }) => {
    vi.useFakeTimers();
    let busy = false;
    const releases: Array<() => void> = [];
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith(model.split('/').at(-1)!)) return new Response(ratePage(model));
      if (!busy) return new Response('unavailable');
      return new Promise<Response>(resolve => { releases.push(() => resolve(new Response('unavailable'))); });
    });
    const resolver = new FireworksPricingResolver(fetchImpl);
    expect(await resolver.resolve(model)).toEqual(price);
    busy = true;
    const pending = Array.from({ length: 200 }, (_, i) => resolver.resolve(`accounts/fireworks/models/busy-${i}`));
    try {
      expect(fetchImpl).toHaveBeenCalledTimes(5); // Seed + four active requests; the rest wait.
      expect(await resolver.resolve(model, true)).toEqual(fallback);
      expect(await resolver.resolve(model)).toEqual(fallback);
      expect(fetchImpl).toHaveBeenCalledTimes(5); // Saturation cannot start another request.
    } finally {
      busy = false;
      for (const release of releases) release();
      await Promise.all(pending);
    }
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await resolver.resolve(model)).toEqual(fallback);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(await resolver.resolve(model)).toEqual(price);
    expect(fetchImpl).toHaveBeenCalledTimes(calls + 1);
  });
  it('bounds concurrency and times out both queued and hanging requests', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const resolver = new FireworksPricingResolver(fetchImpl);
    const results = Promise.all(Array.from({ length: 20 }, (_, i) => resolver.resolve(`accounts/fireworks/models/test-${i}`)));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await results).toEqual(Array(20).fill(null));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchImpl.mock.calls) expect(init?.signal?.aborted).toBe(true);
  });
  it('aborts an HTTP error response whose body is still streaming', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), { status: 503 });
    };
    expect(await new FireworksPricingResolver(fetchImpl).resolve(MODEL)).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
  it('rejects oversized bodies, missing cards, HTTP errors and unsafe model IDs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('x'.repeat(1_048_577)))
      .mockResolvedValueOnce(new Response('new shape'))
      .mockResolvedValueOnce(new Response('failure', { status: 503 }));
    const resolver = new FireworksPricingResolver(fetchImpl);
    expect(await resolver.resolve(MODEL)).toBeNull();
    expect(await resolver.resolve(MODEL, true)).toBeNull();
    expect(await resolver.resolve(MODEL, true)).toBeNull();
    expect(await resolver.resolve('accounts/fireworks/models/../../pricing')).toBeNull();
    expect(await resolver.resolve('accounts/other/models/qwen3p8-max')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
