import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { providerAvailability, providerRegistry, resolveModel } from '../src/index.js';
import type { ModelCatalogEntry } from '@vault/settings-registry';

const QWEN: ModelCatalogEntry = { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true };
const SONNET: ModelCatalogEntry = { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true };
const OPENROUTER_MODEL: ModelCatalogEntry = { title: 'Claude Sonnet 5 (OpenRouter)', provider: 'openrouter', model: 'anthropic/claude-sonnet-5', enabled: true };
const OPENAI_MODEL: ModelCatalogEntry = { title: 'GPT Test', provider: 'openai', model: 'gpt-test', enabled: true };

describe('providerAvailability', () => {
  it('reports presence booleans from the surface keys, trimming whitespace', () => {
    expect(providerAvailability({ fireworks: 'fw' })).toEqual({ fireworks: true, anthropic: false, openrouter: false, openai: false });
    expect(providerAvailability({ fireworks: '  ', anthropic: 'sk' })).toEqual({ fireworks: false, anthropic: true, openrouter: false, openai: false });
    expect(providerAvailability({})).toEqual({ fireworks: false, anthropic: false, openrouter: false, openai: false });
    expect(providerAvailability({ openrouter: 'k' })).toEqual({ fireworks: false, anthropic: false, openrouter: true, openai: false });
  });
});

describe('resolveModel', () => {
  it('builds a fireworks model and an anthropic model with the entry model id', () => {
    const fw = resolveModel(QWEN, { fireworks: 'fw-key' });
    const an = resolveModel(SONNET, { anthropic: 'sk-key' });
    expect((fw as { modelId: string }).modelId).toBe(QWEN.model);
    expect((an as { modelId: string }).modelId).toBe(SONNET.model);
  });
  it('builds an openrouter model with the entry model id', () => {
    const or = resolveModel(OPENROUTER_MODEL, { openrouter: 'k' });
    expect((or as { modelId: string }).modelId).toBe(OPENROUTER_MODEL.model);
  });
  it('throws loudly when the routed provider key is missing', () => {
    expect(() => resolveModel(SONNET, { fireworks: 'fw-key' }))
      .toThrow(/claude-sonnet-4-6.*anthropic API key/);
  });
  it('throws loudly naming openrouter when its key is missing', () => {
    expect(() => resolveModel(OPENROUTER_MODEL, {}))
      .toThrow(/openrouter API key/);
  });
  it('registry wires every catalog provider', () => {
    expect(Object.keys(providerRegistry).sort()).toEqual(['anthropic', 'fireworks', 'openai', 'openrouter']);
  });
  it('builds an openai model with the entry model id and needs the OpenAI key', () => {
    expect(providerAvailability({ openai: 'sk' }).openai).toBe(true);
    expect((resolveModel(OPENAI_MODEL, { openai: 'sk' }) as { modelId: string }).modelId).toBe(OPENAI_MODEL.model);
    expect(() => resolveModel(OPENAI_MODEL, {})).toThrow(/openai API key/);
  });

  // The plugin CANNOT stream from the renderer (Obsidian's requestUrl is
  // buffered-only), so every model it builds carries an injected fetch that
  // relays through the engine. If a provider ever ignores opts.fetch, VEfO's
  // LLM path silently dies. Pinned here for the providers below.
  it('routes through the injected fetch, and openrouter hits openrouter.ai', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(
        JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const model = resolveModel(OPENROUTER_MODEL, { openrouter: 'k' }, { fetch: fakeFetch });
    await generateText({ model, prompt: 'hello' }).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('openrouter.ai');
  });

  it('routes openai through the injected fetch to the Responses API with store off', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response('{"error":{"message":"stop here"}}', { status: 400, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const model = resolveModel(OPENAI_MODEL, { openai: 'sk' }, { fetch: fakeFetch });
    expect((model as { modelId: string }).modelId).toBe(OPENAI_MODEL.model);
    await generateText({ model, prompt: 'hello', maxRetries: 0 }).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-test', store: false, include: ['reasoning.encrypted_content'] });
  });
});
