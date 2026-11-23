import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { ToolSet, UIMessage } from 'ai';
import { runChatStream } from '../src/run.js';
import { createToolTiering, LOAD_TOOLS_NAME } from '../src/tiering.js';
import { wrapEngineTools } from '../src/tools.js';

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe('runChatStream', () => {
  it('streams model text and fires onComplete with the assembled assistant message', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'Hello world' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2 } } },
        ]),
      }),
    });
    const onComplete = vi.fn();
    const onStreamFinish = vi.fn();

    const stream = runChatStream({
      model,
      system: 'SYS',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as UIMessage[],
      tools: {},
      maxSteps: 4,
      onComplete,
      onStreamFinish,
    });

    await drain(stream);

    expect(onStreamFinish).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const finalMessages = onComplete.mock.calls[0]![0] as UIMessage[];
    const assistant = finalMessages.find((m) => m.role === 'assistant');
    const text = (assistant?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toContain('Hello world');
  });
});

describe('runChatStream + tiering (scripted two-step)', () => {
  it('offers core+meta on step 1, and the loaded tool on step 2', async () => {
    const engineTools = wrapEngineTools(
      [
        { name: 'query-nodes', description: 'Query nodes.', inputSchema: { type: 'object' } },
        { name: 'vault-doctor', description: 'Integrity checks.', inputSchema: { type: 'object' } },
        { name: 'update-schema', description: 'Update a schema.', inputSchema: { type: 'object' } },
      ],
      async () => ({ content: [{ type: 'text', text: '{"ok":true,"data":{},"warnings":[]}' }] }),
    );
    const tiering = createToolTiering(engineTools as ToolSet, { core: ['query-nodes'] });
    const { tools, prepareStep } = tiering.forRequest([]);

    const offered: string[][] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(((options.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
        call += 1;
        if (call === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'tool-call', toolCallId: 'c1', toolName: LOAD_TOOLS_NAME, input: '{"names":["vault-doctor"]}' },
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1 } } },
            ]),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'done' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1 } } },
          ]),
        };
      },
    });

    const stream = runChatStream({
      model,
      system: 'SYS',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'run vault doctor' }] }] as UIMessage[],
      tools,
      prepareStep,
      maxSteps: 4,
    });
    await drain(stream);

    expect(offered).toHaveLength(2);
    expect(offered[0]!.sort()).toEqual([LOAD_TOOLS_NAME, 'query-nodes']);
    expect(offered[1]).toContain('vault-doctor');
    expect(offered[1]).not.toContain('update-schema'); // unloaded stays invisible
  });
});

describe('runChatStream + tiering (round trip: persisted messages reseed the next request)', () => {
  // Seeding parses the exact part shape the ai SDK persists for a dynamicTool call
  // ({type: 'dynamic-tool', toolName, state: 'output-available', output}). Fixtures
  // elsewhere hand-build that shape; this test captures it from a real streamText
  // turn via onComplete, so an ai bump that changes the persisted shape fails here.
  it('reconstructs the loaded set from onComplete-persisted messages', async () => {
    const engineTools = wrapEngineTools(
      [
        { name: 'query-nodes', description: 'Query nodes.', inputSchema: { type: 'object' } },
        { name: 'vault-doctor', description: 'Integrity checks.', inputSchema: { type: 'object' } },
      ],
      async () => ({ content: [{ type: 'text', text: '{"ok":true,"data":{},"warnings":[]}' }] }),
    );
    const tiering = createToolTiering(engineTools as ToolSet, { core: ['query-nodes'] });
    const turn1 = tiering.forRequest([]);

    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'tool-call', toolCallId: 'c1', toolName: LOAD_TOOLS_NAME, input: '{"names":["vault-doctor"]}' },
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1 } } },
            ]),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'done' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1 } } },
          ]),
        };
      },
    });

    let persisted: UIMessage[] = [];
    const stream = runChatStream({
      model,
      system: 'SYS',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'run vault doctor' }] }] as UIMessage[],
      tools: turn1.tools,
      prepareStep: turn1.prepareStep,
      maxSteps: 4,
      onComplete: (finalMessages) => {
        persisted = finalMessages;
      },
    });
    await drain(stream);

    const metaPart = persisted
      .flatMap((m) => m.parts ?? [])
      .find((p) => p.type === 'dynamic-tool' && (p as { toolName?: string }).toolName === LOAD_TOOLS_NAME) as
      | { state?: string; output?: { loaded?: unknown } }
      | undefined;
    expect(metaPart?.state).toBe('output-available');
    expect(metaPart?.output?.loaded).toEqual(['vault-doctor']);

    const turn2 = tiering.forRequest(persisted);
    expect(turn2.loaded()).toEqual(['vault-doctor']);
  });
});

describe('runChatStream error surfacing', () => {
  // Regression: streamText does NOT reject when the provider fails — it enqueues
  // an {type:'error'} chunk, and toUIMessageStream() renders it. Its DEFAULT
  // onError returns the literal "An error occurred.", so omitting the option
  // there masked every real provider error (bad key, rate limit, context
  // overflow, account suspension) before the host's handler could see it.
  // Both createUIMessageStream AND toUIMessageStream must receive onError.
  async function collectErrorText(onError?: (err: unknown) => string): Promise<string[]> {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('Account is suspended, possibly due to reaching the monthly spending limit');
      },
    });
    const stream = runChatStream({
      model,
      system: 'SYS',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as UIMessage[],
      tools: {},
      maxSteps: 1,
      ...(onError ? { onError } : {}),
    });
    const seen: string[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as { type?: string; errorText?: string };
      if (chunk.type === 'error' && typeof chunk.errorText === 'string') seen.push(chunk.errorText);
    }
    return seen;
  }

  it("surfaces the host's onError text, not the SDK's masked default", async () => {
    const seen = await collectErrorText((e) => (e instanceof Error ? e.message : String(e)));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join(' ')).toContain('monthly spending limit');
    expect(seen.join(' ')).not.toContain('An error occurred.');
  });

  it('falls back to String(err) rather than the SDK default when no onError is given', async () => {
    const seen = await collectErrorText();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join(' ')).toContain('monthly spending limit');
    expect(seen.join(' ')).not.toContain('An error occurred.');
  });
});
