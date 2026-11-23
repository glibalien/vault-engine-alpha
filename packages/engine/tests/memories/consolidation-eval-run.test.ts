import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { createProviderClients } from '@vault/llm';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { createConsolidator, DEFAULT_CONSOLIDATION_MODEL } from '../../src/mcp/tools/memory-consolidation.js';
import { consolidationEvalTarget, EVAL_RESULT_PREFIX, EvalUsageTally, resultLine } from '../../src/memories/consolidation-eval-run.js';

// #570: the consolidation eval's model choice, usage count and result line for `eval:models`.

const CATALOG: ModelCatalogEntry[] = [
  { title: 'Qwen 3.7 Plus', provider: 'openrouter', model: 'qwen/qwen3.7-plus', enabled: true, pricing: { input: 0.5, output: 2 } },
  { title: 'Old Model', provider: 'fireworks', model: 'accounts/fireworks/models/old', enabled: false },
];

describe('consolidationEvalTarget', () => {
  it('runs a raw id with --provider, as before', () => {
    expect(consolidationEvalTarget({ provider: 'fireworks', model: 'accounts/fireworks/models/glm-5' }))
      .toEqual({ provider: 'fireworks', model: 'accounts/fireworks/models/glm-5', label: 'glm-5' });
    expect(() => consolidationEvalTarget({ provider: 'nowhere', model: 'x' })).toThrow('unknown --provider');
  });

  it('looks a bare --model up in the catalog, by title or by model id', () => {
    expect(consolidationEvalTarget({ model: '[[Qwen 3.7 Plus]]', catalog: CATALOG }))
      .toEqual({ provider: 'openrouter', model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus' });
    expect(consolidationEvalTarget({ model: 'qwen/qwen3.7-plus', catalog: CATALOG }).label).toBe('Qwen 3.7 Plus');
  });

  it('refuses a --model it cannot place, saying how to run it', () => {
    expect(() => consolidationEvalTarget({ model: 'Old Model', catalog: CATALOG })).toThrow('not an enabled Settings/Models entry');
    expect(() => consolidationEvalTarget({ model: 'Qwen 3.7 Plus' })).toThrow('needs the model catalog');
  });

  it('runs the configured model, else the built-in default', () => {
    expect(consolidationEvalTarget({ catalog: CATALOG, configured: { provider: 'openrouter', model: 'qwen/qwen3.7-plus' } }))
      .toEqual({ provider: 'openrouter', model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus' });
    expect(consolidationEvalTarget({})).toMatchObject({ provider: 'fireworks', model: DEFAULT_CONSOLIDATION_MODEL });
  });
});

describe('EvalUsageTally', () => {
  const target = { provider: 'openrouter' as const, model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus' };

  it('counts the calls the consolidator records, at the reported charge or the entry rates', async () => {
    const tally = new EvalUsageTally(target, { input: 0.5, output: 2 });
    const responses = [
      { usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, cost: 0.25 } },
      { usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } },
    ];
    const create = vi.fn(async () => ({
      choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' } }],
      ...responses.shift(),
    }));
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: vi.fn(() => ({ chat: { completions: { create } } }) as unknown as OpenAI) }),
      { provider: target.provider, model: target.model },
      tally,
    );
    const input = { content: 'Acme renews in March.', category: null, candidates: [] };
    await consolidator.consolidate(input);
    await consolidator.consolidate(input);

    expect(tally.calls).toMatchObject({
      model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus', provider: 'openrouter', calls: 2, failures: 0,
      usage: { input: 2_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    });
    // 0.25 reported, then 0.5 + 1.0 from the entry's rates.
    expect(tally.calls.costUsd).toBeCloseTo(1.75, 6);
  });

  it('has no cost once a call has neither a charge nor rates, and counts failed requests', () => {
    const tally = new EvalUsageTally({ provider: 'fireworks', model: 'accounts/fireworks/models/unknown-x', label: 'unknown-x' });
    tally.record({ provider: 'fireworks', service: 'engine', purpose: 'memory-consolidation', inputTokens: 10, outputTokens: 5, latencyMs: 30 });
    expect(tally.calls.costUsd).toBeNull();
    tally.failed(false, 20);
    tally.failed(true, 0);
    expect(tally.calls).toMatchObject({ calls: 2, failures: 2, latencyMs: 50 });
  });

  it('prints one prefixed JSON line', () => {
    const tally = new EvalUsageTally(target);
    const line = resultLine({ version: 1, eval: 'consolidation', score: { kind: 'exact', correct: 7, total: 8 }, failures: 0, job: tally.calls });
    expect(line.startsWith(EVAL_RESULT_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(EVAL_RESULT_PREFIX.length))).toMatchObject({ version: 1, eval: 'consolidation', score: { correct: 7, total: 8 } });
  });
});
