import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  anthropicUsage,
  complete,
  createProviderClients,
  MissingProviderKeyError,
  providerKeyRef,
  openAiCompatUsage,
  providerKeysFromEnv,
  type ProviderClientOptions,
} from '../src/index.js';

function fakeFactories() {
  const openAiCreate = vi.fn();
  const anthropicCreate = vi.fn();
  const openAiOptions: Array<{ apiKey: string; baseURL: string }> = [];
  const anthropicOptions: Array<{ apiKey: string; baseURL?: string }> = [];
  const options: ProviderClientOptions = {
    createOpenAi: o => {
      openAiOptions.push(o);
      return { chat: { completions: { create: openAiCreate } } } as unknown as OpenAI;
    },
    createAnthropic: o => {
      anthropicOptions.push(o);
      return { messages: { create: anthropicCreate } } as unknown as Anthropic;
    },
  };
  return { options, openAiCreate, anthropicCreate, openAiOptions, anthropicOptions };
}

describe('providerKeysFromEnv', () => {
  it('reads each provider key from its table env var and skips blanks', () => {
    expect(providerKeysFromEnv({
      FIREWORKS_API_KEY: ' fw ', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: 'ak', OPENAI_API_KEY: 'sk', OTHER: 'x',
    })).toEqual({ fireworks: 'fw', anthropic: 'ak', openai: 'sk' });
  });
});

describe('createProviderClients', () => {
  it('builds one client per provider on first use, with the table base URL', () => {
    const f = fakeFactories();
    const clients = createProviderClients({ fireworks: 'fw', openrouter: 'or', anthropic: 'ak' }, f.options);
    expect(f.openAiOptions).toEqual([]);
    const a = clients.openAiCompat('fireworks');
    expect(clients.openAiCompat('fireworks')).toBe(a);
    clients.openAiCompat('openrouter');
    clients.anthropic();
    clients.anthropic();
    expect(f.openAiOptions).toEqual([
      { apiKey: 'fw', baseURL: 'https://api.fireworks.ai/inference/v1' },
      { apiKey: 'or', baseURL: 'https://openrouter.ai/api/v1' },
    ]);
    expect(f.anthropicOptions).toEqual([{ apiKey: 'ak' }]);
  });

  it('honours base URL overrides', () => {
    const f = fakeFactories();
    createProviderClients({ fireworks: 'fw' }, { ...f.options, baseURLs: { fireworks: 'https://example.test/v1' } })
      .openAiCompat('fireworks');
    expect(f.openAiOptions).toEqual([{ apiKey: 'fw', baseURL: 'https://example.test/v1' }]);
  });

  it('reports availability and fails loudly for a missing key', () => {
    const clients = createProviderClients({ fireworks: 'fw', openrouter: '  ' }, fakeFactories().options);
    expect(clients.has('fireworks')).toBe(true);
    expect(clients.has('openrouter')).toBe(false);
    expect(clients.has('anthropic')).toBe(false);
    expect(() => clients.openAiCompat('openrouter', 'qwen/x')).toThrow(MissingProviderKeyError);
    expect(() => clients.openAiCompat('openrouter', 'qwen/x'))
      .toThrow('model "qwen/x" needs the openrouter API key (OPENROUTER_API_KEY) — not set');
    expect(() => clients.anthropic()).toThrow('the anthropic API key (ANTHROPIC_API_KEY) is not set');
  });
});

describe('usage normalization', () => {
  it('subtracts cached reads from OpenAI-shape prompt tokens', () => {
    expect(openAiCompatUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } }, 'fireworks'))
      .toEqual({ input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
  });

  it('counts OpenRouter and OpenAI cache writes and ignores them elsewhere', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 300 } };
    expect(openAiCompatUsage(usage, 'openrouter')).toEqual({ input: 600, output: 5, cacheRead: 100, cacheWrite: 300 });
    expect(openAiCompatUsage(usage, 'fireworks')).toEqual({ input: 900, output: 5, cacheRead: 100, cacheWrite: 0 });
  });

  it('matches OpenAI\'s measured shape: written tokens are inside prompt_tokens', () => {
    // A first call to gpt-6-luna with a 3,753-token prompt, measured 2026-10-31.
    expect(openAiCompatUsage({ prompt_tokens: 3753, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3750 } }, 'openai'))
      .toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite: 3750 });
  });

  it('clamps input at zero and tolerates a missing block', () => {
    expect(openAiCompatUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } }, 'fireworks').input).toBe(0);
    expect(openAiCompatUsage(undefined, 'fireworks')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('maps Anthropic usage one to one', () => {
    expect(anthropicUsage({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: null }))
      .toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 0 });
  });
});

describe('complete', () => {
  const image = Buffer.from('img');
  const pdf = Buffer.from('pdf');

  it('sends an OpenAI-compatible request and reads text, usage and truncation', async () => {
    const f = fakeFactories();
    f.openAiCreate.mockResolvedValue({
      choices: [{ message: { content: 'out' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    const clients = createProviderClients({ openrouter: 'or' }, f.options);
    const result = await complete(clients, {
      provider: 'openrouter', model: 'm', system: 'SYS', json: true, maxTokens: 99,
      content: [{ type: 'image', mimeType: 'image/png', data: image }, { type: 'text', text: 'P' }],
    });
    expect(f.openAiCreate).toHaveBeenCalledWith({
      model: 'm',
      max_tokens: 99,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
          { type: 'text', text: 'P' },
        ] },
      ],
    });
    expect(result).toEqual({ text: 'out', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, truncated: true });
  });

  it("returns OpenRouter's reported charge and the response id, and no charge from other providers (#320)", async () => {
    const f = fakeFactories();
    const reply = (cost: unknown) => ({
      id: 'gen-123', choices: [{ message: { content: 'out' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, cost },
    });
    const ask = (provider: 'openrouter' | 'fireworks') =>
      complete(createProviderClients({ openrouter: 'or', fireworks: 'fw' }, f.options), { provider, model: 'm', content: 'hi', maxTokens: 5 });
    f.openAiCreate.mockResolvedValueOnce(reply(0.00042));
    expect(await ask('openrouter')).toMatchObject({ providerCostUsd: 0.00042, requestId: 'gen-123' });
    f.openAiCreate.mockResolvedValueOnce(reply(0));
    expect((await ask('openrouter')).providerCostUsd).toBe(0);
    for (const bad of [-1, '0.1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      f.openAiCreate.mockResolvedValueOnce(reply(bad));
      expect(await ask('openrouter')).not.toHaveProperty('providerCostUsd');
    }
    f.openAiCreate.mockResolvedValueOnce(reply(0.5));
    const other = await ask('fireworks');
    expect(other).not.toHaveProperty('providerCostUsd');
    expect(other.requestId).toBe('gen-123');
  });

  it('returns the model the response says served the call, e.g. where Auto Router routed it (#340)', async () => {
    const f = fakeFactories();
    const clients = createProviderClients({ openrouter: 'or', anthropic: 'sk' }, f.options);
    const reply = (model: unknown) => ({ model, choices: [{ message: { content: 'out' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    f.openAiCreate.mockResolvedValueOnce(reply('deepseek/deepseek-v4.1-flash'));
    expect((await complete(clients, { provider: 'openrouter', model: 'openrouter/auto', content: 'hi', maxTokens: 5 })).reportedModel)
      .toBe('deepseek/deepseek-v4.1-flash');
    for (const bad of ['', null, 42]) {
      f.openAiCreate.mockResolvedValueOnce(reply(bad));
      expect(await complete(clients, { provider: 'openrouter', model: 'openrouter/auto', content: 'hi', maxTokens: 5 })).not.toHaveProperty('reportedModel');
    }
    f.anthropicCreate.mockResolvedValueOnce({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' });
    expect((await complete(clients, { provider: 'anthropic', model: 'claude-sonnet-5-5', content: 'hi', maxTokens: 5 })).reportedModel)
      .toBe('claude-sonnet-5-5');
  });

  it('omits system and JSON mode when not asked, and tolerates empty content', async () => {
    const f = fakeFactories();
    f.openAiCreate.mockResolvedValue({ choices: [{ message: { content: null }, finish_reason: 'stop' }] });
    const result = await complete(createProviderClients({ fireworks: 'fw' }, f.options), {
      provider: 'fireworks', model: 'm', content: 'hi', maxTokens: 5,
    });
    expect(f.openAiCreate).toHaveBeenCalledWith({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('caps OpenAI output with max_completion_tokens at the OpenAI endpoint', async () => {
    const f = fakeFactories();
    f.openAiCreate.mockResolvedValue({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    await complete(createProviderClients({ openai: 'sk' }, f.options), {
      provider: 'openai', model: 'gpt-x', system: 'SYS', content: 'hi', maxTokens: 7, json: true,
    });
    expect(f.openAiOptions).toEqual([{ apiKey: 'sk', baseURL: 'https://api.openai.com/v1' }]);
    expect(f.openAiCreate).toHaveBeenCalledWith({
      model: 'gpt-x',
      max_completion_tokens: 7,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
    });
  });

  it('refuses PDF input where the provider takes none', async () => {
    const f = fakeFactories();
    await expect(complete(createProviderClients({ fireworks: 'fw' }, f.options), {
      provider: 'fireworks', model: 'm', content: [{ type: 'pdf', data: pdf }], maxTokens: 5,
    })).rejects.toThrow('PDF input is not supported on Fireworks');
    expect(f.openAiCreate).not.toHaveBeenCalled();
  });

  it('sends OpenAI a PDF as a base64 file part', async () => {
    const f = fakeFactories();
    f.openAiCreate.mockResolvedValue({ choices: [{ message: { content: 'text' }, finish_reason: 'stop' }] });
    await complete(createProviderClients({ openai: 'sk' }, f.options), {
      provider: 'openai', model: 'gpt-x', content: [{ type: 'pdf', data: pdf }, { type: 'text', text: 'P' }], maxTokens: 9,
    });
    expect(f.openAiCreate).toHaveBeenCalledWith({
      model: 'gpt-x',
      max_completion_tokens: 9,
      messages: [{ role: 'user', content: [
        { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } },
        { type: 'text', text: 'P' },
      ] }],
    });
  });

  it('sends an Anthropic request with image and document blocks', async () => {
    const f = fakeFactories();
    f.anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }],
      usage: { input_tokens: 3, output_tokens: 2 },
      stop_reason: 'max_tokens',
    });
    const result = await complete(createProviderClients({ anthropic: 'ak' }, f.options), {
      provider: 'anthropic', model: 'claude-x', system: 'SYS', maxTokens: 50,
      content: [{ type: 'image', mimeType: 'image/png', data: image }, { type: 'pdf', data: pdf }, { type: 'text', text: 'P' }],
    });
    expect(f.anthropicCreate).toHaveBeenCalledWith({
      model: 'claude-x',
      max_tokens: 50,
      system: 'SYS',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
        { type: 'text', text: 'P' },
      ] }],
    });
    expect(result).toEqual({ text: 'ab', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }, truncated: true });
  });

  it('fails before any request when the provider key is missing', async () => {
    const f = fakeFactories();
    await expect(complete(createProviderClients({}, f.options), {
      provider: 'anthropic', model: 'claude-x', content: 'hi', maxTokens: 5,
    })).rejects.toBeInstanceOf(MissingProviderKeyError);
    expect(f.anthropicCreate).not.toHaveBeenCalled();
  });
});

describe('providerKeyRef', () => {
  it('gives a stable short fingerprint that hides the key and tells keys apart', () => {
    expect(providerKeyRef('sk-or-secret')).toMatch(/^[0-9a-f]{16}$/);
    expect(providerKeyRef('sk-or-secret')).toBe(providerKeyRef('sk-or-secret'));
    expect(providerKeyRef('sk-or-other')).not.toBe(providerKeyRef('sk-or-secret'));
  });
});
