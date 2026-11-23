import { describe, expect, it, vi, beforeEach } from 'vitest';
import { inspect } from 'node:util';
import type { PreparedCapture, StructuredCallRequest } from '../src/llm/types.js';
import { loadLlmKeys, type LlmKeys } from '../src/config.js';
import type { Engine } from '../src/engine.js';
import { providerForModel } from '../src/llm/provider-for-model.js';
import { UsageReporter } from '../src/usage-reporter.js';

const { anthropicCreate, openaiCreate, AnthropicCtor, OpenAiCtor } = vi.hoisted(() => {
  const anthropicCreate = vi.fn();
  const openaiCreate = vi.fn();
  // `function`, not an arrow — mockImplementation must be constructor-capable
  // since llm/index.ts does `new Anthropic(...)` / `new OpenAI(...)`.
  const AnthropicCtor = vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
    return { __opts: opts, messages: { create: anthropicCreate } };
  });
  const OpenAiCtor = vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
    return { __opts: opts, chat: { completions: { create: openaiCreate } } };
  });
  return { anthropicCreate, openaiCreate, AnthropicCtor, OpenAiCtor };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicCtor }));
vi.mock('openai', () => ({ default: OpenAiCtor }));

// Imported after the mocks so llm/index.ts picks up the faked SDK constructors.
const { createDispatchingLlmClient } = await import('../src/llm/index.js');
const { callWithTopicBudget } = await import('../src/topic-request-budget.js');

const BASE_REQ: StructuredCallRequest = {
  model: 'claude-sonnet-4-6',
  maxTokens: 4000,
  system: 'SYS',
  user: 'EVIDENCE',
  toolName: 'emit_x',
  toolDescription: 'desc',
  schema: { type: 'object' },
};

const KEYS: LlmKeys = { keys: { anthropic: 'ak-test', fireworks: 'fw-test', openrouter: 'or-test', openai: 'oa-test' }, baseURLs: {} };

/** claude* -> anthropic, or/* -> openrouter, gpt-* -> openai, everything else -> fireworks (mirrors the real catalog shape). */
const providerFor = (model: string): 'anthropic' | 'fireworks' | 'openrouter' | 'openai' =>
  model.startsWith('claude') ? 'anthropic' : model.startsWith('or/') ? 'openrouter'
    : model.startsWith('gpt-') ? 'openai' : 'fireworks';

function anthropicResponse(input: unknown = { ok: true }) {
  return {
    content: [{ type: 'tool_use', name: 'emit_x', input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function openAiResponse(content = '{"ok":true}') {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

beforeEach(() => {
  anthropicCreate.mockReset().mockResolvedValue(anthropicResponse());
  openaiCreate.mockReset().mockResolvedValue(openAiResponse());
  AnthropicCtor.mockClear();
  OpenAiCtor.mockClear();
});

describe('createDispatchingLlmClient', () => {
  it.each([
    ['claude-sonnet-4-6', 'anthropic'],
    ['accounts/fireworks/models/kimi-k2p6', 'fireworks'],
    ['or/some-model', 'openrouter'],
    ['gpt-test-model', 'openai'],
  ] as const)('previews without dispatch or usage and matches actual capture for %s', async (model, provider) => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const client = new UsageReporter({ recordUsage } as unknown as Engine, {
      provider: providerFor, experiment: null, variant: null,
    }).wrap(createDispatchingLlmClient(KEYS, providerFor, { reasoningEffort: 'low' }));
    const onPrepared = vi.fn();
    const req = { ...BASE_REQ, model, onPrepared, malformedOutputPolicy: 'fail-closed-redacted' as const };
    expect(client.previewStructuredCall).toBeTypeOf('function');
    const preview = await client.previewStructuredCall!(req);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(preview.provider).toBe(provider);
    expect(JSON.stringify(preview)).not.toContain('ak-test');
    expect(JSON.stringify(preview)).not.toContain('or-test');
    expect(Object.isFrozen(preview.payload)).toBe(true);
    const messages = (preview.payload as { messages: Array<{ content: string }> }).messages;
    expect(() => { messages[0]!.content = 'mutated'; }).toThrow();
    await client.structuredCall(req);
    expect(onPrepared.mock.calls[0]![0]).toEqual(preview);
    const sdkCreate = provider === 'anthropic' ? anthropicCreate : openaiCreate;
    expect(sdkCreate.mock.calls[0]![0]).toEqual(preview.payload);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
  });

  it('does not invent preview support for an unsupported wrapped client', () => {
    const client = new UsageReporter({ recordUsage: vi.fn() } as unknown as Engine, {
      provider: 'openrouter', experiment: null, variant: null,
    }).wrap({ structuredCall: vi.fn() });
    expect(client.previewStructuredCall).toBeUndefined();
    expect(client.supportsPreparedCapture).toBeUndefined();
  });

  it('rejects preview with missing credentials without dispatching', async () => {
    const client = createDispatchingLlmClient({ ...KEYS, keys: { ...KEYS.keys, anthropic: undefined } }, providerFor);
    expect(client.previewStructuredCall).toBeTypeOf('function');
    await expect(client.previewStructuredCall!({ ...BASE_REQ, malformedOutputPolicy: 'fail-closed-redacted' }))
      .rejects.toThrow('provider_dispatch_failed');
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['claude-sonnet-4-6', 'anthropic'],
    ['accounts/fireworks/models/kimi-k2p6', 'fireworks'],
    ['or/some-model', 'openrouter'],
  ] as const)('preserves capture before dispatch and usage through the server wrapper for %s', async (model, provider) => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter({ recordUsage } as unknown as Engine, {
      provider: providerFor, experiment: null, variant: null,
    });
    const client = reporter.wrap(createDispatchingLlmClient(KEYS, providerFor), providerFor);
    // This is the capability consumed by curateProject's fail-closed guard.
    expect(client.supportsPreparedCapture).toBe(true);
    let captured: PreparedCapture | undefined;
    const sdkCreate = provider === 'anthropic' ? anthropicCreate : openaiCreate;
    sdkCreate.mockImplementationOnce(async payload => {
      expect(captured).toBeDefined();
      expect(payload).toBe(captured!.payload);
      return provider === 'anthropic' ? anthropicResponse() : openAiResponse();
    });

    const result = await client.structuredCall({ ...BASE_REQ, model, onPrepared: async capture => {
      expect(sdkCreate).not.toHaveBeenCalled();
      captured = capture;
    } });

    expect(result.output).toEqual({ ok: true });
    expect(captured?.provider).toBe(provider);
    expect(sdkCreate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ provider, model, input_tokens: 10, output_tokens: 5 });
  });

  it('keeps a failed capture fail-closed through the server wrapper without dispatch or usage', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter({ recordUsage } as unknown as Engine, {
      provider: providerFor, experiment: null, variant: null,
    });
    const client = reporter.wrap(createDispatchingLlmClient(KEYS, providerFor), providerFor);
    await expect(client.structuredCall({ ...BASE_REQ, onPrepared: async () => {
      throw new Error('Synthetic capture failure');
    } })).rejects.toThrow('provenance_capture_failed');
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('uses one provider resolver for dispatch and paid-usage attribution', async () => {
    const model = 'shared-raw-model-id';
    const provider = providerForModel({ [model]: 'openrouter' });
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter({ recordUsage } as unknown as Engine, {
      provider,
      experiment: null,
      variant: null,
    });
    const client = reporter.wrap(createDispatchingLlmClient(KEYS, provider, {}), provider);

    await client.structuredCall({ ...BASE_REQ, model });

    expect(OpenAiCtor).toHaveBeenCalledWith({
      apiKey: 'or-test', baseURL: 'https://openrouter.ai/api/v1', fetch: expect.any(Function),
    });
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ provider: 'openrouter', model });
  });

  it('routes a claude model to the anthropic adapter and a fireworks id to openai-compat', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, {});

    const claudeRes = await client.structuredCall({ ...BASE_REQ, model: 'claude-sonnet-4-6' });
    expect(claudeRes.output).toEqual({ ok: true });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(openaiCreate).not.toHaveBeenCalled();

    const fwRes = await client.structuredCall({ ...BASE_REQ, model: 'accounts/fireworks/models/kimi-k2p6' });
    expect(fwRes.output).toEqual({ ok: true });
    expect(openaiCreate).toHaveBeenCalledTimes(1);

    // Lazy construction: exactly one adapter instance per provider, however many calls route to it.
    expect(AnthropicCtor).toHaveBeenCalledTimes(1);
    expect(OpenAiCtor).toHaveBeenCalledTimes(1);

    await client.structuredCall({ ...BASE_REQ, model: 'claude-opus-9' });
    expect(AnthropicCtor).toHaveBeenCalledTimes(1); // still one — reused, not rebuilt
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  it('routes an openrouter-provider model to an openai-compat adapter built with the openrouter baseURL', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, {});

    const fwRes = await client.structuredCall({ ...BASE_REQ, model: 'accounts/fireworks/models/kimi-k2p6' });
    expect(fwRes.output).toEqual({ ok: true });

    const orRes = await client.structuredCall({ ...BASE_REQ, model: 'or/some-model' });
    expect(orRes.output).toEqual({ ok: true });
    expect(openaiCreate).toHaveBeenCalledTimes(2);

    // Two distinct OpenAI instances: one per provider, each with its own baseURL/key.
    expect(OpenAiCtor).toHaveBeenCalledTimes(2);
    expect(OpenAiCtor.mock.calls[0]?.[0]).toEqual({ apiKey: 'fw-test', baseURL: 'https://api.fireworks.ai/inference/v1', fetch: expect.any(Function) });
    expect(OpenAiCtor.mock.calls[1]?.[0]).toEqual({ apiKey: 'or-test', baseURL: 'https://openrouter.ai/api/v1', fetch: expect.any(Function) });

    // Lazy construction: a second openrouter call reuses the same adapter/instance.
    await client.structuredCall({ ...BASE_REQ, model: 'or/another-model' });
    expect(OpenAiCtor).toHaveBeenCalledTimes(2);
    expect(openaiCreate).toHaveBeenCalledTimes(3);
  });

  it('omits context_length_exceeded_behavior and the sticky user hint for the openrouter target, while the fireworks target keeps both', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, {});

    await client.structuredCall({ ...BASE_REQ, model: 'accounts/fireworks/models/kimi-k2p6' });
    const fwCall = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fwCall.user).toBe('vault-curator');
    expect(fwCall.context_length_exceeded_behavior).toBe('error');

    await client.structuredCall({ ...BASE_REQ, model: 'or/some-model' });
    const orCall = openaiCreate.mock.calls[1]?.[0] as Record<string, unknown>;
    expect('user' in orCall).toBe(false);
    expect('context_length_exceeded_behavior' in orCall).toBe(false);
    // Both targets still get the shared structured-output contract.
    expect(orCall.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'emit_x', schema: { type: 'object' } },
    });
  });

  it('routes an openai-provider model to the OpenAI endpoint with max_completion_tokens and no Fireworks extensions', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, { reasoningEffort: 'medium' });

    const res = await client.structuredCall({ ...BASE_REQ, model: 'gpt-test-model' });
    expect(res.output).toEqual({ ok: true });
    expect(OpenAiCtor).toHaveBeenCalledTimes(1);
    expect(OpenAiCtor.mock.calls[0]?.[0]).toEqual({ apiKey: 'oa-test', baseURL: 'https://api.openai.com/v1', fetch: expect.any(Function) });

    const call = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.max_completion_tokens).toBe(BASE_REQ.maxTokens);
    expect('max_tokens' in call).toBe(false);
    expect('user' in call).toBe(false);
    expect('context_length_exceeded_behavior' in call).toBe(false);
    expect(call.reasoning_effort).toBe('medium');
    expect(call.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'emit_x', schema: { type: 'object' } },
    });
    expect(client.configurationFor!('gpt-test-model')).toEqual({ provider: 'openai', reasoningEffort: 'medium' });
  });

  it('throws the loud missing-key message naming OPENAI_API_KEY when it is unset and an openai model is routed', async () => {
    const client = createDispatchingLlmClient({ ...KEYS, keys: { ...KEYS.keys, openai: undefined } }, providerFor, {});
    await expect(client.structuredCall({ ...BASE_REQ, model: 'gpt-test-model' }))
      .rejects.toThrow('model "gpt-test-model" needs the openai API key (OPENAI_API_KEY) — not set');
    expect(OpenAiCtor).not.toHaveBeenCalled();
  });

  it('throws the loud missing-key message naming OPENROUTER_API_KEY when it is unset and an openrouter model is routed', async () => {
    const client = createDispatchingLlmClient(
      { ...KEYS, keys: { ...KEYS.keys, openrouter: undefined } },
      providerFor,
      {},
    );
    await expect(client.structuredCall({ ...BASE_REQ, model: 'or/some-model' }))
      .rejects.toThrow('model "or/some-model" needs the openrouter API key (OPENROUTER_API_KEY) — not set');
    expect(OpenAiCtor).not.toHaveBeenCalled();
  });

  it('throws the loud missing-key message when the anthropic key is unset and a claude model is routed', async () => {
    const client = createDispatchingLlmClient(
      { ...KEYS, keys: { ...KEYS.keys, anthropic: undefined } },
      providerFor,
      {},
    );
    await expect(client.structuredCall({ ...BASE_REQ, model: 'claude-sonnet-4-6' }))
      .rejects.toThrow('model "claude-sonnet-4-6" needs the anthropic API key (ANTHROPIC_API_KEY) — not set');
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it('throws the loud missing-key message when the fireworks key is unset and a fireworks model is routed', async () => {
    const client = createDispatchingLlmClient(
      { ...KEYS, keys: { ...KEYS.keys, fireworks: undefined } },
      providerFor,
      {},
    );
    await expect(client.structuredCall({ ...BASE_REQ, model: 'accounts/fireworks/models/kimi-k2p6' }))
      .rejects.toThrow('model "accounts/fireworks/models/kimi-k2p6" needs the fireworks API key (FIREWORKS_API_KEY) — not set');
    expect(OpenAiCtor).not.toHaveBeenCalled();
  });

  it('projects fail-closed missing-key dispatch errors without retaining the dynamic model', async () => {
    const marker = 'RAW-DISPATCH-MODEL-MARKER-91bc';
    const client = createDispatchingLlmClient(
      { ...KEYS, keys: { ...KEYS.keys, fireworks: undefined } },
      () => 'fireworks',
      {},
    );
    let error: unknown;
    try {
      await client.structuredCall({
        ...BASE_REQ,
        model: `accounts/fireworks/models/${marker}`,
        malformedOutputPolicy: 'fail-closed-redacted',
      });
    } catch (caught) {
      error = caught;
    }
    const diagnostic = JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      inspect: inspect(error),
    });

    expect(error).toMatchObject({
      name: 'StructuredCallFailure',
      reason: 'provider_dispatch_failed',
      usage: undefined,
    });
    expect(diagnostic).not.toContain(marker);
    expect(OpenAiCtor).not.toHaveBeenCalled();
  });

  it('reasoningEffort reaches only the openai-compat adapter', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, { reasoningEffort: 'none' });

    await client.structuredCall({ ...BASE_REQ, model: 'claude-sonnet-4-6' });
    const anthropicCall = anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(anthropicCall.reasoning_effort).toBeUndefined();

    await client.structuredCall({ ...BASE_REQ, model: 'accounts/fireworks/models/kimi-k2p6' });
    const openaiCall = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openaiCall.reasoning_effort).toBe('none');
  });

  it('binds a reasoning budget to an OpenRouter model and refuses it for any other provider (#429)', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, { reasoningEffort: 'low' });
    const budgeted = client.withConfiguration!({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 3000 });
    await budgeted.structuredCall({ ...BASE_REQ, model: 'or/qwen' });
    const call = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.reasoning).toEqual({ max_tokens: 3000 });
    expect('reasoning_effort' in call).toBe(false);
    // The shared client has no budget of its own.
    expect(client.configurationFor!('or/qwen')).toEqual({ provider: 'openrouter', reasoningEffort: 'low' });
    for (const provider of ['anthropic', 'fireworks', 'openai'] as const) {
      expect(() => client.withConfiguration!({ provider, reasoningEffort: null, reasoningBudget: 3000 }))
        .toThrow(`REASONING_BUDGET_UNSUPPORTED: ${provider}`);
    }
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps a bound reasoning budget through a configurationFor -> withConfiguration round trip', async () => {
    const budgeted = createDispatchingLlmClient(KEYS, providerFor, { reasoningEffort: 'low' })
      .withConfiguration!({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 3000 });
    expect(budgeted.configurationFor!('or/qwen')).toEqual({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 3000 });
    await budgeted.withConfiguration!(budgeted.configurationFor!('or/qwen')).structuredCall({ ...BASE_REQ, model: 'or/qwen' });
    expect((openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>).reasoning).toEqual({ max_tokens: 3000 });
  });

  it('sends a topic stage call made through request budgeting with the stage reasoning budget', async () => {
    const budgeted = createDispatchingLlmClient(KEYS, providerFor, {})
      .withConfiguration!({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 3000 });
    const context = { sources: [], query: 'q', topicRequestMaxBytes: 100_000, topicPageRequestMaxBytes: 100_000,
      topicSourceExcerptMaxBytes: 1_000 };
    await callWithTopicBudget(budgeted, { context, query: 'q', maxBytes: 100_000 },
      evidence => ({ ...BASE_REQ, model: 'or/qwen', user: `EVIDENCE ${evidence ?? ''}` }));
    const call = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.reasoning).toEqual({ max_tokens: 3000 });
    expect('reasoning_effort' in call).toBe(false);
  });

  it('preserves the fail-closed policy through Fireworks dispatch to SDK request options', async () => {
    const client = createDispatchingLlmClient(KEYS, providerFor, {});

    await client.structuredCall({
      ...BASE_REQ,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      malformedOutputPolicy: 'fail-closed-redacted',
    });

    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(openaiCreate.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });
});

describe('loadLlmKeys', () => {
  it('reads every provider key from the provider table and leaves the base URLs at their defaults', () => {
    const keys = loadLlmKeys({
      ANTHROPIC_API_KEY: 'ak',
      FIREWORKS_API_KEY: 'fw',
      OPENROUTER_API_KEY: 'or',
      OPENAI_API_KEY: 'oa',
    } as NodeJS.ProcessEnv);
    expect(keys).toEqual({ keys: { anthropic: 'ak', fireworks: 'fw', openrouter: 'or', openai: 'oa' }, baseURLs: {} });
  });

  it('still reads the original Fireworks variables, and the legacy key wins when both are set', () => {
    expect(loadLlmKeys({ OPENAI_COMPAT_API_KEY: 'legacy' } as NodeJS.ProcessEnv).keys).toEqual({ fireworks: 'legacy' });
    expect(loadLlmKeys({ OPENAI_COMPAT_API_KEY: 'legacy', FIREWORKS_API_KEY: 'new' } as NodeJS.ProcessEnv).keys)
      .toEqual({ fireworks: 'legacy' });
  });

  it('strips a custom base url trailing slash', () => {
    const keys = loadLlmKeys({
      OPENAI_COMPAT_API_KEY: 'fw',
      OPENAI_COMPAT_BASE_URL: 'https://example.com/v1///',
    } as NodeJS.ProcessEnv);
    expect(keys.baseURLs).toEqual({ fireworks: 'https://example.com/v1' });
  });

  it('trims keys and drops blank ones', () => {
    expect(loadLlmKeys({ OPENROUTER_API_KEY: '  or-key  ', ANTHROPIC_API_KEY: 'ak' } as NodeJS.ProcessEnv).keys.openrouter).toBe('or-key');
    expect(loadLlmKeys({ OPENROUTER_API_KEY: '   ', ANTHROPIC_API_KEY: 'ak' } as NodeJS.ProcessEnv).keys).toEqual({ anthropic: 'ak' });
  });

  it('leaves every key unset when none is configured, without throwing', () => {
    expect(loadLlmKeys({} as NodeJS.ProcessEnv)).toEqual({ keys: {}, baseURLs: {} });
  });

  it('warns when no key is set, naming every key variable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadLlmKeys({} as NodeJS.ProcessEnv);
    expect(warn).toHaveBeenCalledTimes(1);
    for (const name of ['ANTHROPIC_API_KEY', 'FIREWORKS_API_KEY', 'OPENAI_COMPAT_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
      expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining(name));
    }
    warn.mockRestore();
  });

  it('does not warn when at least one key is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadLlmKeys({ ANTHROPIC_API_KEY: 'ak' } as NodeJS.ProcessEnv);
    loadLlmKeys({ OPENROUTER_API_KEY: 'or' } as NodeJS.ProcessEnv);
    loadLlmKeys({ OPENAI_COMPAT_API_KEY: 'fw' } as NodeJS.ProcessEnv);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});


describe('frozen requested-call configuration', () => {
  it.each(['reassigned', 'removed'] as const)('restores routing and reasoning after the route is %s', async change => {
    const model = 'shared-model';
    const original = createDispatchingLlmClient(KEYS, providerForModel({ [model]: 'openrouter' }), { reasoningEffort: 'low' });
    const frozen = original.configurationFor!(model);
    expect(frozen).toEqual({ provider: 'openrouter', reasoningEffort: 'low' });
    const provider = providerForModel(change === 'removed' ? {} : { [model]: 'fireworks' });
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter({ recordUsage } as unknown as Engine, { provider, experiment: null, variant: null });
    reporter.setContext({ project: 'project-1', runRef: 'original-run' });
    const reloaded = reporter.wrap(createDispatchingLlmClient({ ...KEYS, keys: { ...KEYS.keys, openrouter: 'rotated-key' } }, provider, { reasoningEffort: 'high' }), provider);
    const resumed = reloaded.withConfiguration!(frozen);
    const preview = await resumed.previewStructuredCall!({ ...BASE_REQ, model });
    await resumed.structuredCall({ ...BASE_REQ, model });
    expect(preview.provider).toBe('openrouter');
    expect(preview.payload).toMatchObject({ reasoning_effort: 'low' });
    expect(OpenAiCtor).toHaveBeenCalledWith({ apiKey: 'rotated-key', baseURL: 'https://openrouter.ai/api/v1', fetch: expect.any(Function) });
    expect(openaiCreate.mock.calls[0]![0]).toEqual(preview.payload);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ provider: 'openrouter', run_ref: 'original-run', input_tokens: 10, output_tokens: 5 });
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(frozen)).not.toMatch(/key|https|test/);
  });

  it('keeps an explicitly unset reasoning option unset after reload', async () => {
    const original = createDispatchingLlmClient(KEYS, () => 'fireworks');
    const frozen = original.configurationFor!('model');
    expect(frozen.reasoningEffort).toBeNull();
    const resumed = createDispatchingLlmClient(KEYS, () => 'openrouter', { reasoningEffort: 'high' }).withConfiguration!(frozen);
    const preview = await resumed.previewStructuredCall!({ ...BASE_REQ, model: 'model' });
    expect(preview.provider).toBe('fireworks');
    expect(preview.payload).not.toHaveProperty('reasoning_effort');
  });

  it('does not fall back when the frozen provider credential is unavailable', async () => {
    const resumed = createDispatchingLlmClient({ ...KEYS, keys: { ...KEYS.keys, openrouter: undefined } }, () => 'fireworks')
      .withConfiguration!({ provider: 'openrouter', reasoningEffort: null });
    await expect(resumed.previewStructuredCall!({ ...BASE_REQ, malformedOutputPolicy: 'fail-closed-redacted' }))
      .rejects.toThrow('provider_dispatch_failed');
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });
});

it('reports native Anthropic effective configuration without ignored global effort', () => {
  const llm = createDispatchingLlmClient(KEYS, () => 'anthropic', { reasoningEffort: 'high' });
  expect(llm.configurationFor!('claude')).toEqual({ provider: 'anthropic', reasoningEffort: null });
});
