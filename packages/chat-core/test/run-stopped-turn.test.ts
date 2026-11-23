import { describe, expect, it } from 'vitest';
import { convertToModelMessages, type UIMessage, type UIMessageChunk } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { runChatStream } from '../src/run.js';

// #282: the shape a turn stopped mid-reasoning leaves behind. Step 1's create-memory
// call never finished (persisted as input-streaming), step 2 loaded a tool, and Stop
// cut step 3 off while it was still reasoning. The two failed turns after it were
// persisted as empty assistant messages.
const STOPPED_CONVERSATION = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'build the wiki' }] },
  { id: 'a1', role: 'assistant', parts: [
    { type: 'step-start' },
    { type: 'reasoning', text: 'I should remember this first.', state: 'done' },
    { type: 'dynamic-tool', toolName: 'create-memory', toolCallId: 'c1', state: 'input-streaming', input: { text: 'x' } },
    { type: 'step-start' },
    { type: 'reasoning', text: 'Load the tool.', state: 'done' },
    { type: 'dynamic-tool', toolName: 'load-tools', toolCallId: 'c2', state: 'output-available', input: { names: ['create-memory'] }, output: { ok: true } },
    { type: 'step-start' },
    { type: 'reasoning', text: 'Now I will', state: 'streaming' },
  ] },
  { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'no, wait' }] },
  { id: 'a2', role: 'assistant', parts: [] },
  { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'hello?' }] },
  { id: 'a3', role: 'assistant', parts: [{ type: 'step-start' }] },
  { id: 'u4', role: 'user', parts: [{ type: 'text', text: 'try again' }] },
] as UIMessage[];

const SSE_OK = [
  { id: 'gen-1', model: 'qwen/qwen3.7-plus', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
  { id: 'gen-1', model: 'qwen/qwen3.7-plus', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';

type SentMessage = { role: string; content: unknown; tool_calls?: unknown[] };

function openRouterCapturing(response: () => Response) {
  const sent: { messages?: SentMessage[] } = {};
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.messages = (JSON.parse(String(init?.body)) as { messages: SentMessage[] }).messages;
    return response();
  }) as typeof globalThis.fetch;
  const model = createOpenRouter({ apiKey: 'test', compatibility: 'strict', fetch })('qwen/qwen3.7-plus');
  return { model, sent };
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

describe('runChatStream after a stopped turn (#282)', () => {
  it('the fixture still converts to reasoning-only assistant messages', async () => {
    // Guards the fixture: if an AI SDK bump stops producing these, the test below
    // would pass without exercising the filter.
    const converted = await convertToModelMessages(STOPPED_CONVERSATION, { ignoreIncompleteToolCalls: true });
    const reasoningOnly = converted.filter((m) => m.role === 'assistant' && Array.isArray(m.content)
      && m.content.every((p) => p.type === 'reasoning'));
    expect(reasoningOnly).toHaveLength(2);
  });

  it('sends no assistant message without content or tool calls, and the turn succeeds', async () => {
    const { model, sent } = openRouterCapturing(() => new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    let finalMessages: UIMessage[] = [];
    const chunks = await collect(runChatStream({
      model, system: 'SYS', messages: STOPPED_CONVERSATION, tools: {}, maxSteps: 2,
      onComplete: (messages) => { finalMessages = messages; },
    }));

    const messages = sent.messages ?? [];
    const empty = messages.filter((m) => m.role === 'assistant'
      && (m.content === null || (typeof m.content === 'string' && m.content.trim() === ''))
      && !(m.tool_calls?.length));
    expect(empty).toEqual([]);
    // Everything with content survives: the tool step and every user message.
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'user', 'user']);
    expect(messages.find((m) => m.role === 'assistant')?.tool_calls).toHaveLength(1);

    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    const reply = finalMessages.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe('ok');
  });

  it('shows the upstream reason when OpenRouter reports the error inside the stream', async () => {
    const inStreamError = `data: ${JSON.stringify({ id: 'gen-2', choices: [], error: {
      message: 'Provider returned error', code: 400,
      metadata: { provider_name: 'Alibaba', raw: '{"error":{"message":"The content field is a required field."}}' },
    } })}\n\ndata: [DONE]\n\n`;
    const { model } = openRouterCapturing(() => new Response(inStreamError, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const chunks = await collect(runChatStream({
      model, system: 'SYS', tools: {}, maxSteps: 1,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as UIMessage[],
    }));
    const error = chunks.find((c) => c.type === 'error');
    expect(error).toEqual({ type: 'error', errorText: 'Provider error 400: [Alibaba] The content field is a required field.' });
  });
});
