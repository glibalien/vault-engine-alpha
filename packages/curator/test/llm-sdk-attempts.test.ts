import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import { countingFetch, countSdkAttempts, type SdkAttemptTally } from '../src/llm/sdk-attempts.js';
import { createDispatchingLlmClient } from '../src/llm/index.js';
import { UsageReporter } from '../src/usage-reporter.js';
import type { Engine } from '../src/engine.js';
import type { StructuredCallRequest } from '../src/llm/types.js';

const req: StructuredCallRequest = {
  model: 'some/model', maxTokens: 1000, system: 'SYS', user: 'EVIDENCE',
  toolName: 'emit_thing', toolDescription: 'desc', schema: { type: 'object' },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
// retry-after-ms 0 keeps the SDK's own backoff out of the test's time.
const overloaded = () => json({ error: { message: 'busy' } }, 503, { 'retry-after-ms': '0' });
const completion = () => json({
  id: 'gen-1', model: 'some/model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
});
const message = () => json({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'tool_use', stop_sequence: null,
  content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_thing', input: { ok: true } }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

/** A fake network: answers in order, through the counting fetch the factory installs. */
function network(...answers: Array<() => Response>) {
  const base = vi.fn(async () => { const next = answers.shift(); if (!next) throw new Error('unexpected request'); return next(); });
  return { base, fetch: countingFetch(base) };
}

function openRouter(fetch: ReturnType<typeof countingFetch>) {
  return new OpenAiCompatLlmClient(new OpenAI({ apiKey: 'k', baseURL: 'https://openrouter.test/api/v1', fetch, maxRetries: 2 }),
    { provider: 'openrouter', fireworksExtensions: false });
}

describe('counting fetch', () => {
  it('counts only requests made inside a counted call, each into its own tally', async () => {
    const { base, fetch } = network(() => new Response('a'), () => new Response('b'), () => new Response('c'));
    const first: SdkAttemptTally = { count: 0 };
    const second: SdkAttemptTally = { count: 0 };
    await fetch('https://x.test/outside');
    await Promise.all([
      countSdkAttempts(first, async () => { await fetch('https://x.test/1'); }),
      countSdkAttempts(second, async () => { await fetch('https://x.test/2'); }),
    ]);
    expect(base).toHaveBeenCalledTimes(3);
    expect([first.count, second.count]).toEqual([1, 1]);
  });
});

describe('SDK attempts in call diagnostics (#321)', () => {
  it('reports one SDK request per adapter attempt when the SDK did not retry', async () => {
    const { fetch } = network(completion);
    const result = await openRouter(fetch).structuredCall(req);
    expect(result.diagnostics).toMatchObject({ adapterAttempts: 1, sdkAttempts: 1 });
  });

  it("counts the OpenAI SDK's quiet retry", async () => {
    const { base, fetch } = network(overloaded, completion);
    const result = await openRouter(fetch).structuredCall(req);
    expect(base).toHaveBeenCalledTimes(2);
    expect(result.diagnostics).toMatchObject({ adapterAttempts: 1, sdkAttempts: 2 });
  });

  it("counts the Anthropic SDK's quiet retry", async () => {
    const { fetch } = network(overloaded, message);
    const client = new AnthropicLlmClient(new Anthropic({ apiKey: 'k', baseURL: 'https://anthropic.test', fetch, maxRetries: 2 }));
    const result = await client.structuredCall({ ...req, model: 'claude-x' });
    expect(result.diagnostics).toMatchObject({ adapterAttempts: 1, sdkAttempts: 2 });
  });

  it('is installed by the production client factory', async () => {
    const { base } = network(overloaded, completion);
    vi.stubGlobal('fetch', base);
    try {
      const llm = createDispatchingLlmClient({ keys: { openrouter: 'k' }, baseURLs: {} }, () => 'openrouter');
      const result = await llm.structuredCall(req);
      expect(base).toHaveBeenCalledTimes(2);
      expect(result.diagnostics).toMatchObject({ adapterAttempts: 1, sdkAttempts: 2 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves the count unknown for a client built without the counting fetch', async () => {
    const create = vi.fn().mockResolvedValue(await completion().json());
    const client = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI,
      { provider: 'openrouter', fireworksExtensions: false });
    expect((await client.structuredCall(req)).diagnostics).toMatchObject({ adapterAttempts: 1, sdkAttempts: null });
  });

  it('marks usage complete only when every SDK request is accounted for', async () => {
    const report = async (...answers: Array<() => Response>) => {
      const recordUsage = vi.fn().mockResolvedValue({});
      const reporter = new UsageReporter({ recordUsage } as unknown as Engine, { provider: 'openrouter', experiment: null, variant: null });
      reporter.setContext({ project: 'Atlas', runRef: 'run' });
      await reporter.wrap(openRouter(network(...answers).fetch)).structuredCall(req);
      return recordUsage.mock.calls[0]![0] as { provider_cost_usd?: number; metadata: { curator_usage: { usage_complete: boolean } } };
    };
    const clean = await report(completion);
    expect(clean.metadata.curator_usage.usage_complete).toBe(true);
    expect(clean.provider_cost_usd).toBe(0.001);
    expect((await report(overloaded, completion)).metadata.curator_usage.usage_complete).toBe(false);
  });
});
