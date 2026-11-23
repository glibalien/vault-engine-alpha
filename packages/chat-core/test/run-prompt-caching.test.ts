import { describe, expect, it, vi } from 'vitest';
import { jsonSchema, tool, type UIMessage } from 'ai';
import { providerRegistry } from '../src/providers.js';
import { claudeThinksByDefault, runChatStream } from '../src/run.js';

async function drain(stream: ReadableStream): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

const sse = (events: readonly unknown[]): Response => new Response(
  events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

/** Anthropic's stream for one reply: a tool call, text that ends the turn, or a
 *  summarized thinking block followed by that text. */
function anthropicReply(content: 'tool' | 'text' | 'thinking'): Response {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage } };
  const end = (stop_reason: string, index = 0) => [
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  if (content === 'thinking') {
    return sse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Looking for the notes' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' first.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
      ...end('end_turn', 1)]);
  }
  if (content === 'tool') {
    return sse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'ping', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      ...end('tool_use')]);
  }
  return sse([start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    ...end('end_turn')]);
}

const USER = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as UIMessage[];
const bodies = (fetch: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> =>
  fetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

describe('runChatStream prompt caching (#360)', () => {
  it('asks Anthropic to cache on every step of a tool loop, over the growing conversation', async () => {
    const replies = [anthropicReply('tool'), anthropicReply('text')];
    const fetch = vi.fn(async () => replies.shift()!);
    const model = providerRegistry.anthropic('key', fetch as unknown as typeof globalThis.fetch)('claude-sonnet-5-5');

    await drain(runChatStream({
      model,
      system: 'SYS',
      messages: USER,
      tools: { ping: tool({ description: 'Ping.', inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => 'pong' }) },
      maxSteps: 4,
    }));

    const [first, second] = bodies(fetch);
    expect(first!['cache_control']).toEqual({ type: 'ephemeral' });
    expect(second!['cache_control']).toEqual({ type: 'ephemeral' });
    expect((second!['messages'] as unknown[]).length).toBeGreaterThan((first!['messages'] as unknown[]).length);
    // The payload the Engine's relay forwards: no breakpoint moved onto a block by hand.
    expect(JSON.stringify(first!['messages'])).not.toContain('cache_control');
  });

  it('sends nothing Anthropic-specific to another provider', async () => {
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) => ({
      id: 'x', object: 'chat.completion.chunk', model: 'qwen/qwen3.7-plus',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    });
    const fetch = vi.fn(async () => sse([
      chunk({ role: 'assistant', content: 'hi' }, null),
      chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      '[DONE]',
    ]));
    const model = providerRegistry.openrouter('key', fetch as unknown as typeof globalThis.fetch)('qwen/qwen3.7-plus');

    await drain(runChatStream({ model, system: 'SYS', messages: USER, tools: {}, maxSteps: 1 }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(bodies(fetch)[0])).not.toMatch(/cache_?control/i);
  });
});

describe('runChatStream thinking display (#400)', () => {
  it('knows which Claude models think when the request leaves thinking out', () => {
    for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5',
      'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-sonnet-5-5-20261001']) {
      expect(claudeThinksByDefault(id), id).toBe(true);
    }
    for (const id of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-sonnet-latest', 'claude-opus-50', 'claude-sonnet-55',
      'anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5-5', 'qwen/qwen3.7-plus', '']) {
      expect(claudeThinksByDefault(id), id).toBe(false);
    }
  });

  it('asks a Claude 5-generation model for summarized thinking, alongside caching, on every step', async () => {
    const replies = [anthropicReply('tool'), anthropicReply('text')];
    const fetch = vi.fn(async () => replies.shift()!);
    const model = providerRegistry.anthropic('key', fetch as unknown as typeof globalThis.fetch)('claude-sonnet-5-5');

    await drain(runChatStream({
      model,
      system: 'SYS',
      messages: USER,
      tools: { ping: tool({ description: 'Ping.', inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => 'pong' }) },
      maxSteps: 4,
    }));

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const body of bodies(fetch)) {
      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['cache_control']).toEqual({ type: 'ephemeral' });
      expect(body).not.toHaveProperty('output_config');
    }
  });

  it.each(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8'])('leaves thinking out for %s, which does not think by default', async (id) => {
    const fetch = vi.fn(async () => anthropicReply('text'));
    const model = providerRegistry.anthropic('key', fetch as unknown as typeof globalThis.fetch)(id);

    await drain(runChatStream({ model, system: 'SYS', messages: USER, tools: {}, maxSteps: 1 }));

    const [body] = bodies(fetch);
    expect(body).not.toHaveProperty('thinking');
    expect(body!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('streams the thinking summary to the chat as reasoning, before the answer', async () => {
    const fetch = vi.fn(async () => anthropicReply('thinking'));
    const model = providerRegistry.anthropic('key', fetch as unknown as typeof globalThis.fetch)('claude-sonnet-5-5');

    const chunks = await drain(runChatStream({ model, system: 'SYS', messages: USER, tools: {}, maxSteps: 1 })) as Array<{ type: string; delta?: string }>;

    const types = chunks.map((c) => c.type);
    expect(types.indexOf('reasoning-start')).toBeGreaterThan(-1);
    expect(types.indexOf('reasoning-start')).toBeLessThan(types.indexOf('text-start'));
    const thought = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.delta).join('');
    expect(thought).toBe('Looking for the notes first.');
  });

  it('does not send a Claude thinking setting through OpenRouter, even for a Claude model', async () => {
    const fetch = vi.fn(async () => sse([
      { id: 'x', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      '[DONE]',
    ]));
    const model = providerRegistry.openrouter('key', fetch as unknown as typeof globalThis.fetch)('anthropic/claude-sonnet-5.5');

    await drain(runChatStream({ model, system: 'SYS', messages: USER, tools: {}, maxSteps: 1 }));

    expect(JSON.stringify(bodies(fetch)[0])).not.toMatch(/thinking|summarized/i);
  });
});
