import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type { StructuredCallRequest } from '../src/llm/types.js';
const req: StructuredCallRequest = { model: 'test', maxTokens: 10, system: '😀 "quoted"',
  user: 'é', toolName: 'emit', toolDescription: 'schema', schema: { type: 'object' } };
describe.each(['anthropic', 'fireworks', 'openrouter'] as const)('%s byte budget', provider => {
  function fixture() {
    const create = vi.fn().mockResolvedValue(provider === 'anthropic'
      ? { content: [{ type: 'tool_use', name: 'emit', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const client = provider === 'anthropic'
      ? new AnthropicLlmClient({ messages: { create } } as unknown as Anthropic)
      : new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI,
        { provider, fireworksExtensions: provider !== 'openrouter' });
    return { create, client };
  }
  it('rejects one byte below UTF-8 size before dispatch', async () => {
    const { create, client } = fixture();
    const payload = (await client.previewStructuredCall(req)).payload;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bytes).toBeGreaterThan(JSON.stringify(payload).length);
    await expect(client.structuredCall({ ...req, providerRequestMaxBytes: bytes - 1 }))
      .rejects.toMatchObject({ reason: 'provider_prompt_too_large' });
    expect(create).not.toHaveBeenCalled();
  });
  it('sends exact-boundary payload without changing retry options', async () => {
    const { create, client } = fixture();
    const payload = (await client.previewStructuredCall(req)).payload;
    await client.structuredCall({ ...req, providerRequestMaxBytes: Buffer.byteLength(JSON.stringify(payload)) });
    expect(create.mock.calls[0]?.[0]).toEqual(payload);
    expect(create.mock.calls[0]?.[1]).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid budget %s', async limit => {
    const { create, client } = fixture();
    await expect(client.structuredCall({ ...req, providerRequestMaxBytes: limit })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  if (provider !== 'anthropic') it('retains malformed JSON retry', async () => {
    const { create, client } = fixture();
    create.mockResolvedValueOnce({ choices: [{ message: { content: 'bad' }, finish_reason: 'stop' }] });
    await client.structuredCall({ ...req, providerRequestMaxBytes: 10000 });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
