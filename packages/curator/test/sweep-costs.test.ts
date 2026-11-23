import { expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { UsageReporter } from '../src/usage-reporter.js';
import { CurationQueue } from '../src/queue.js';
import type { StructuredCallRequest } from '../src/llm/types.js';

const request: StructuredCallRequest = { model: 'openrouter/auto', maxTokens: 100, system: 's', user: 'u',
  toolName: 'emit', toolDescription: 'd', schema: {}, malformedOutputPolicy: 'fail-closed-redacted' };
const response = (id: string, cost: unknown, content = '{}') => ({ id, model: 'actual-model',
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 30, completion_tokens: 12, cost,
    prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 7 } } });
function fixture(responses: unknown[], provider: 'openrouter' | 'fireworks' = 'openrouter') {
  const create = vi.fn(); for (const r of responses) create.mockResolvedValueOnce(r);
  const raw = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI,
    { provider, fireworksExtensions: provider === 'fireworks' });
  const events: Record<string, any>[] = [];
  const reporter = new UsageReporter({ recordUsage: async e => { events.push(e); } }, { provider, experiment: null, variant: null });
  return { events, reporter, llm: reporter.wrap(raw) };
}

it('captures inline charges, resolved model and non-wiki stage without changing model output', async () => {
  const f = fixture([response('gen1', 0.12)]);
  f.reporter.setContext({ project: 'P', runRef: 'r', purpose: 'journal' });
  const result = await f.llm.structuredCall(request);
  expect(result.output).toEqual({});
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ provider_cost_usd: 0.12, request_id: 'gen1', input_tokens: 15,
    cache_read_tokens: 10, cache_write_tokens: 5, metadata: { curator_usage: {
      version: 1, stage: 'journal', outcome: 'returned', reported_model: 'actual-model', reasoning_tokens: 7,
    } } });
});

it('counts both billed attempts, including malformed output, without claiming a single generation ID', async () => {
  const f = fixture([response('gen1', 0.1, 'invalid'), response('gen2', 0.2)]);
  await f.llm.structuredCall({ ...request, malformedOutputPolicy: 'retry-once-with-content-sample' });
  expect(f.events).toHaveLength(1);
  expect(f.events[0]!.provider_cost_usd).toBeCloseTo(0.3);
  expect(f.events[0]).not.toHaveProperty('request_id');
  expect(f.events[0]!.metadata.curator_usage).toMatchObject({ response_count: 2, usage_complete: false });
});

it.each([undefined, -1, Infinity, NaN, '0.1'])('does not treat invalid or absent cost as actual: %s', async cost => {
  const f = fixture([response('gen1', cost)]);
  await f.llm.structuredCall(request);
  expect(f.events[0]).not.toHaveProperty('provider_cost_usd');
});

it('retains an explicitly free response and ignores unverified cost fields from another provider', async () => {
  const free = fixture([response('gen1', 0)]);
  await free.llm.structuredCall(request);
  expect(free.events[0]!.provider_cost_usd).toBe(0);
  const other = fixture([response('gen1', 1)], 'fireworks');
  await other.llm.structuredCall(request);
  expect(other.events[0]).not.toHaveProperty('provider_cost_usd');
});

it('does not claim a partial retry cost is the whole call charge', async () => {
  const f = fixture([response('gen1', 0.1, 'invalid'), response('gen2', undefined)]);
  await f.llm.structuredCall({ ...request, malformedOutputPolicy: 'retry-once-with-content-sample' });
  expect(f.events[0]).not.toHaveProperty('provider_cost_usd');
});

it('retains actual charges on failed output and when token accounting is unavailable', async () => {
  const f = fixture([response('bad', 0.15, 'invalid')]);
  await expect(f.llm.structuredCall(request)).rejects.toThrow();
  expect(f.events[0]).toMatchObject({ provider_cost_usd: 0.15, metadata: { curator_usage: { outcome: 'failed' } } });
  const noTokens = fixture([{ ...response('cost-only', 0.1), usage: { cost: 0.1 } }]);
  await noTokens.llm.structuredCall({ ...request, wikiContext: { stage: 'page', attempt: 0, policyVersion: 1,
    maxTokens: 100, configuration: { provider: 'openrouter', reasoningEffort: null } } });
  expect(noTokens.events[0]).toMatchObject({ provider_cost_usd: 0.1, metadata: { curator_usage: { usage_complete: false } } });
  expect(noTokens.events[0]).not.toHaveProperty('input_tokens');
});

it('does not turn malformed non-wiki token usage into a zero-cost estimate', async () => {
  const f = fixture([{ ...response('no-usage', undefined), usage: { prompt_tokens: -2, completion_tokens: NaN } }]);
  const result = await f.llm.structuredCall(request);
  expect(result.usageKnown).toBe(false);
  expect(f.events).toHaveLength(0);
});

it('keeps concurrent sweeps and interleaved on-demand jobs distinct through the real queue', async () => {
  const f = fixture([response('g1', 0.1), response('g2', 0.2), response('g3', 0.3)]);
  const queue = new CurationQueue();
  const work = () => queue.enqueue('job', () => f.llm.structuredCall(request));
  await Promise.all([
    f.reporter.withSweep({ ref: 's1', trigger: 'scheduled' }, work), work(),
    f.reporter.withSweep({ ref: 's2', trigger: 'cli' }, work),
  ]);
  expect(f.events.map(e => e.metadata.curator_usage.sweep_ref)).toEqual(['s1', undefined, 's2']);
});
