import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { convertToModelMessages, type UIMessage } from 'ai';
import { runChatStream } from '../src/run.js';
import { settleUnfinishedToolParts, UNFINISHED_TOOL_TEXT } from '../src/tool-parts.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1 } };

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
}

describe('runChatStream with trailing tool-input chunks (#283)', () => {
  it('a call that fails at once ends failed, not stuck in input-streaming', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          // OpenRouter's shape: tool-call once the arguments parse, then a trailing empty
          // delta for the same call. create-memory isn't loaded, so the call fails at once.
          return { stream: convertArrayToReadableStream([
            { type: 'tool-input-start', id: 'c1', toolName: 'create-memory' },
            { type: 'tool-input-delta', id: 'c1', delta: '{"text":"x"}' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'create-memory', input: '{"text":"x"}' },
            { type: 'tool-input-delta', id: 'c1', delta: '' },
            { type: 'tool-input-end', id: 'c1' },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]) };
        }
        return { stream: convertArrayToReadableStream([
          { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: 'ok' }, { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: 'stop', usage },
        ]) };
      },
    });
    let finalMessages: UIMessage[] = [];
    await drain(runChatStream({
      model, system: 'SYS', tools: {}, maxSteps: 3,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'remember x' }] }] as UIMessage[],
      onComplete: (m) => { finalMessages = m; },
    }));
    const part = finalMessages.at(-1)!.parts.find((p) => (p as { toolCallId?: string }).toolCallId === 'c1') as
      { state: string; errorText?: string } | undefined;
    expect(part?.state).toBe('output-error');
    expect(part?.errorText).toBeTruthy();
  });
});

describe('settleUnfinishedToolParts', () => {
  const messages = (): UIMessage[] => [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] },
    { id: 'a', role: 'assistant', parts: [
      { type: 'step-start' },
      { type: 'dynamic-tool', toolName: 'query-nodes', toolCallId: 'c0', state: 'output-available', input: {}, output: { ok: true } },
      { type: 'dynamic-tool', toolName: 'create-memory', toolCallId: 'c1', state: 'input-streaming', input: undefined },
      { type: 'dynamic-tool', toolName: 'create-project-wiki', toolCallId: 'c2', state: 'input-available', input: { project: 'Atlas' } },
      { type: 'tool-present-viz', toolCallId: 'c3', state: 'input-available', input: { kind: 'table' } },
    ] },
  ] as UIMessage[];

  it('marks calls without a result as interrupted and leaves the rest alone', () => {
    const before = messages();
    const after = settleUnfinishedToolParts(before);
    const parts = after[1]!.parts as Array<{ toolCallId?: string; state?: string; input?: unknown; errorText?: string }>;
    expect(parts.find((p) => p.toolCallId === 'c0')).toBe(before[1]!.parts[1]);
    expect(parts.find((p) => p.toolCallId === 'c1')).toMatchObject({ state: 'output-error', input: {}, errorText: UNFINISHED_TOOL_TEXT });
    expect(parts.find((p) => p.toolCallId === 'c2')).toMatchObject({ state: 'output-error', input: { project: 'Atlas' }, errorText: UNFINISHED_TOOL_TEXT });
    expect(parts.find((p) => p.toolCallId === 'c3')).toMatchObject({ state: 'output-error', errorText: UNFINISHED_TOOL_TEXT });
    expect(after[0]).toBe(before[0]);
    expect(before[1]!.parts[2]).toMatchObject({ state: 'input-streaming' }); // not mutated
  });

  it('returns the same array when nothing is unfinished', () => {
    const done = [messages()[0]!, { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }] as UIMessage[];
    expect(settleUnfinishedToolParts(done)).toBe(done);
  });

  it('the model then sees a failed call instead of a dropped one', async () => {
    const converted = await convertToModelMessages(settleUnfinishedToolParts(messages()).slice(0, 2), { ignoreIncompleteToolCalls: true });
    const calls = converted.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === 'tool-call').map((p) => (p as { toolCallId: string }).toolCallId);
    expect(calls).toEqual(['c0', 'c1', 'c2', 'c3']);
    const results = converted.flatMap((m) => (m.role === 'tool' ? m.content : []))
      .map((p) => ({ id: (p as { toolCallId: string }).toolCallId, output: (p as { output: unknown }).output }));
    expect(results.find((r) => r.id === 'c1')?.output).toEqual({ type: 'error-text', value: UNFINISHED_TOOL_TEXT });
  });
});
