import { describe, it, expect, vi } from 'vitest';

const { runChatStream } = vi.hoisted(() => ({ runChatStream: vi.fn() }));
vi.mock('@vault/chat-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vault/chat-core')>();
  return { ...actual, runChatStream };
});

import { InProcessChatTransport } from '../../src/chat/in-process-transport.js';

const ENTRY = { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true } as const;

describe('InProcessChatTransport onUsage', () => {
  it('fires onUsage with totalUsage + chatId + the resolved entry when the stream finishes', async () => {
    const onUsage = vi.fn();
    const transport = new InProcessChatTransport({
      system: 'sys',
      tiering: { forRequest: () => ({ tools: {}, prepareStep: undefined }) } as never,
      turn: async () => ({ model: {} as never, maxSteps: 4, entry: ENTRY }),
      onUsage,
    });

    runChatStream.mockImplementation((input: { onStreamFinish?: (info: unknown) => void }) => {
      input.onStreamFinish?.({ steps: [], totalUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
      return new ReadableStream();
    });

    await transport.sendMessages({
      chatId: 'conv-7', messages: [], abortSignal: undefined,
      trigger: 'submit-message', messageId: undefined,
    } as never);

    expect(onUsage).toHaveBeenCalledTimes(1);
    const info = onUsage.mock.calls[0]![0] as { totalUsage: { inputTokens: number }; latencyMs: number; conversationId?: string; entry: { title: string } };
    expect(info.totalUsage.inputTokens).toBe(100);
    expect(info.conversationId).toBe('conv-7');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(info.entry).toEqual(ENTRY);
  });

  it("passes each step's OpenRouter charge to onUsage, summed for the turn", async () => {
    const onUsage = vi.fn();
    const transport = new InProcessChatTransport({
      system: 'sys',
      tiering: { forRequest: () => ({ tools: {}, prepareStep: undefined }) } as never,
      turn: async () => ({ model: {} as never, maxSteps: 4, entry: { ...ENTRY, provider: 'openrouter' as never } }),
      onUsage,
    });
    const step = (cost: number, id: string) => ({ providerMetadata: { openrouter: { usage: { cost } } }, response: { id } });
    runChatStream.mockImplementation((input: { onStreamFinish?: (info: unknown) => void }) => {
      input.onStreamFinish?.({ steps: [step(0.01, 'gen-a'), step(0.005, 'gen-b')], totalUsage: { inputTokens: 1, outputTokens: 1 } });
      return new ReadableStream();
    });
    await transport.sendMessages({ chatId: 'c', messages: [], abortSignal: undefined, trigger: 'submit-message', messageId: undefined } as never);
    const info = onUsage.mock.calls[0]![0] as { billing: { providerCostUsd?: number; requestId?: string } };
    expect(info.billing.providerCostUsd).toBeCloseTo(0.015);
    expect(info.billing.requestId).toBeUndefined();
  });
});
