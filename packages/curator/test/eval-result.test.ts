import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry, ModelProvider } from '@vault/settings-registry';
import { CallMeter, EVAL_RESULT_PREFIX, flagValue, judgedScore, resultLine, wantsResultLine } from '../src/eval/result.js';
import { evalModel, evalPricing } from '../src/eval/model-ref.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';

const RATES = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };
const req = (model: string): StructuredCallRequest => ({
  model, maxTokens: 10, system: 's', user: 'u', toolName: 't', toolDescription: 'd', schema: { type: 'object' },
});

describe('CallMeter (#570)', () => {
  it('counts calls, tokens, time and estimated cost, and leaves other members alone', async () => {
    const client = {
      label: 'inner',
      describe(this: { label: string }) { return this.label; },
      async structuredCall() { return { output: { ok: true }, usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 } }; },
    };
    const meter = new CallMeter({ model: 'm', label: 'M', provider: 'openrouter' }, () => RATES);
    const wrapped = meter.wrap(client as unknown as LlmClient) as unknown as typeof client;

    await wrapped.structuredCall();
    await wrapped.structuredCall();

    expect(wrapped.describe()).toBe('inner');
    expect(meter.calls).toMatchObject({
      model: 'm', label: 'M', provider: 'openrouter', calls: 2, failures: 0,
      usage: { input: 2_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      costUsd: 2 + 4,
    });
    expect(meter.calls.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('counts a call that throws as a failure, with any usage it reports', async () => {
    const client: LlmClient = {
      async structuredCall() { throw new StructuredCallFailure('truncated', { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, 'truncated'); },
    };
    const meter = new CallMeter({ model: 'm', label: 'M', provider: null }, () => RATES);
    await expect(meter.wrap(client).structuredCall(req('m'))).rejects.toThrow('truncated');
    expect(meter.calls).toMatchObject({ calls: 1, failures: 1, usage: { input: 10, output: 20 } });
  });

  it('reports no cost once a call\'s usage is unknown (Codex on #618)', async () => {
    const results = [
      { output: {}, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
      { output: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageKnown: false },
      { output: {}, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
    ];
    const client: LlmClient = { async structuredCall() { return results.shift()!; } };
    const meter = new CallMeter({ model: 'm', label: 'M', provider: null }, () => RATES);
    const wrapped = meter.wrap(client);
    for (let i = 0; i < 3; i++) await wrapped.structuredCall(req('m'));
    expect(meter.calls).toMatchObject({ calls: 3, failures: 0, costUsd: null });
  });

  it('reports no cost for a model with no rates', async () => {
    const client: LlmClient = { async structuredCall() { return { output: {}, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }; } };
    const meter = new CallMeter({ model: 'm', label: 'M', provider: null }, () => null);
    await meter.wrap(client).structuredCall(req('m'));
    expect(meter.calls.costUsd).toBeNull();
  });
});

describe('result line', () => {
  it('reads the runner flags and prints one prefixed JSON line', () => {
    expect(wantsResultLine(['--model', 'X', '--json'])).toBe(true);
    expect(wantsResultLine(['--model', 'X'])).toBe(false);
    expect(flagValue(['--model', 'Qwen 3.7 Plus', '--json'], '--model')).toBe('Qwen 3.7 Plus');
    expect(flagValue(['--json'], '--model')).toBeUndefined();

    const score = judgedScore([{ coverage: 1, precision: 0.5 }, { coverage: 0.5, precision: 1 }], 2);
    expect(score).toEqual({ kind: 'judged', coverage: 0.75, precision: 0.75, total: 2 });
    const calls = { model: 'm', label: 'M', provider: null, calls: 0, failures: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 0, costUsd: 0 };
    const line = resultLine({ version: 1, eval: 'extraction', score, failures: 0, job: calls });
    expect(line.startsWith(EVAL_RESULT_PREFIX)).toBe(true);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line.slice(EVAL_RESULT_PREFIX.length))).toMatchObject({ version: 1, eval: 'extraction', score });
  });
});

describe('evalModel', () => {
  const catalog: ModelCatalogEntry[] = [
    { title: 'Qwen 3.7 Plus', provider: 'openrouter', model: 'qwen/qwen3.7-plus', enabled: true },
    { title: 'Off Model', provider: 'fireworks', model: 'accounts/fireworks/models/off', enabled: false },
  ];

  it('uses the configured model, labelled by its catalog title', () => {
    const providers: Record<string, ModelProvider> = { 'qwen/qwen3.7-plus': 'openrouter' };
    expect(evalModel(catalog, providers, 'qwen/qwen3.7-plus', undefined))
      .toEqual({ model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus', provider: 'openrouter' });
  });

  it('resolves a --model catalog title and registers its provider', () => {
    const providers: Record<string, ModelProvider> = {};
    expect(evalModel(catalog, providers, 'claude-sonnet-4-6', '[[Qwen 3.7 Plus]]'))
      .toEqual({ model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus', provider: 'openrouter' });
    expect(providers['qwen/qwen3.7-plus']).toBe('openrouter');
  });

  it('passes a raw id through, with its provider when the id says which', () => {
    expect(evalModel(catalog, {}, 'x', 'accounts/fireworks/models/glm-5', '--model'))
      .toMatchObject({ model: 'accounts/fireworks/models/glm-5', label: 'glm-5', provider: 'fireworks' });
    expect(evalModel(catalog, {}, 'x', 'some-unknown-model').provider).toBeNull();
  });
});

describe('evalPricing', () => {
  it("uses a catalog entry's rates for a model no setting uses (Codex on #618)", () => {
    const catalog: ModelCatalogEntry[] = [
      { title: 'Picked', provider: 'openrouter', model: 'vendor/picked', enabled: true, pricing: { input: 0.14, output: 0.42 } },
    ];
    const configured = { 'vendor/configured': { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } };
    const lookup = evalPricing(configured, catalog);
    expect(lookup('vendor/configured')).toEqual(configured['vendor/configured']);
    expect(lookup('vendor/picked')).toMatchObject({ input: 0.14, output: 0.42 });
    expect(lookup('vendor/unknown-model')).toBeNull();
  });
});
