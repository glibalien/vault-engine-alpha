import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { interpretToolArgs, type InterpretConfig } from '../src/interpret-core.js';

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10 },
};

const CONFIG: InterpretConfig<{ n: number }> = {
  schema: { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'number' } } },
  system: () => 'emit {"n": <number>}',
  prompt: (text, current) => (current ? `current ${JSON.stringify(current)}; change: ${text}` : text),
  sanitize: (raw) => {
    const n = (raw as { n?: unknown }).n;
    return typeof n === 'number' && n > 0 ? { value: { n } } : { error: 'n must be a positive number' };
  },
};

const modelReturning = (...texts: string[]) => {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)]! }],
      finishReason: 'stop', usage: USAGE, warnings: [],
    }),
  });
};

describe('interpretToolArgs', () => {
  it('returns the sanitized value + usage', async () => {
    const got = await interpretToolArgs({ text: 'five', model: modelReturning('{"n":5}'), config: CONFIG });
    expect(got).toMatchObject({ ok: true, value: { n: 5 } });
    if (got.ok) expect(got.usage.outputTokens).toBe(10);
  });
  it('retries once with the sanitize error appended, summing usage', async () => {
    const got = await interpretToolArgs({ text: 'x', model: modelReturning('{"n":-1}', '{"n":2}'), config: CONFIG });
    expect(got).toMatchObject({ ok: true, value: { n: 2 } });
    if (got.ok) expect(got.usage.outputTokens).toBe(20);
  });
  it("carries OpenRouter's charge for every attempt, and the id only for a single attempt", async () => {
    let i = 0;
    const charged = new MockLanguageModelV4({
      doGenerate: async () => {
        i += 1;
        return {
          content: [{ type: 'text', text: i === 1 ? '{"n":-1}' : '{"n":3}' }], finishReason: 'stop', usage: USAGE, warnings: [],
          providerMetadata: { openrouter: { usage: { cost: i === 1 ? 0.001 : 0.002 } } },
          response: { id: `gen-${i}` },
        };
      },
    });
    const two = await interpretToolArgs({ text: 'x', model: charged, config: CONFIG });
    expect(two.ok && two.billing.providerCostUsd).toBeCloseTo(0.003);
    expect(two.ok && two.billing.requestId).toBeUndefined();
    i = 1; // the next call answers validly at once
    const one = await interpretToolArgs({ text: 'x', model: charged, config: CONFIG });
    // The AI SDK falls back to the requested model's id when the response names none (#340).
    expect(one.ok && one.billing).toEqual({ providerCostUsd: 0.002, requestId: 'gen-2', reportedModel: 'mock-model-id' });
  });
  it('fails closed after two invalid attempts with the sanitize message', async () => {
    const got = await interpretToolArgs({ text: 'x', model: modelReturning('{"n":-1}'), config: CONFIG });
    expect(got).toMatchObject({ ok: false, error: expect.stringContaining('positive') });
  });
  it('bounds TOTAL wall clock: a hanging model resolves ok:false within timeoutMs', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => await new Promise(() => {}) });
    const got = await interpretToolArgs({ text: 'x', model, timeoutMs: 25, config: CONFIG });
    expect(got.ok).toBe(false);
  });
  it('uses a custom correction wording on the retry when config.correction is provided', async () => {
    const prompts: string[] = [];
    let i = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        const userMsg = (opts.prompt as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user');
        const content = userMsg?.content as Array<{ type: string; text?: string }> | undefined;
        prompts.push(content?.[0]?.text ?? '');
        const texts = ['{"n":-1}', '{"n":2}'];
        return { content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)]! }], finishReason: 'stop', usage: USAGE, warnings: [] };
      },
    });
    const config: InterpretConfig<{ n: number }> = { ...CONFIG, correction: (error) => `CUSTOM CORRECTION: ${error}` };
    const got = await interpretToolArgs({ text: 'x', model, config });
    expect(got).toMatchObject({ ok: true, value: { n: 2 } });
    expect(prompts[1]).toContain('CUSTOM CORRECTION: n must be a positive number');
    expect(prompts[1]).not.toContain('Return a corrected full object');
  });

  it('passes current through to the prompt builder (tweak mode)', async () => {
    let seenPrompt = '';
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        // opts.prompt is the parsed LanguageModelV2Prompt array; pull the raw
        // user-message text rather than JSON.stringify-ing the whole array,
        // which would double-escape the quotes CONFIG.prompt embeds via its
        // own JSON.stringify(current) call.
        const userMsg = (opts.prompt as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user');
        const content = userMsg?.content as Array<{ type: string; text?: string }> | undefined;
        seenPrompt = content?.[0]?.text ?? '';
        return { content: [{ type: 'text', text: '{"n":1}' }], finishReason: 'stop', usage: USAGE, warnings: [] };
      },
    });
    await interpretToolArgs({ text: 'bump', current: { n: 7 }, model, config: CONFIG });
    expect(seenPrompt).toContain('current {"n":7}');
  });
});
