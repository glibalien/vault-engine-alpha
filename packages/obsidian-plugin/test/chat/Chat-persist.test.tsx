import { it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// jsdom doesn't implement scrollIntoView; Thread calls it on mount.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

let mockState: { messages: unknown[]; status: string; sendMessage: () => void; setMessages: (m: unknown[]) => void; stop: () => void; error?: { message: string } };
let lastUseChatArg: { id?: string; messages?: unknown[] } | undefined;
vi.mock('@ai-sdk/react', () => ({ useChat: (arg: unknown) => { lastUseChatArg = arg as never; return mockState; } }));
import { Chat } from '../../src/chat/Chat.js';
const tx = {} as never;
const searchNodes = async () => [];
beforeEach(() => { mockState = { messages: [], status: 'ready', sendMessage: vi.fn(), setMessages: vi.fn(), stop: vi.fn(), error: undefined }; lastUseChatArg = undefined; });

it('passes conversationId + initialMessages into useChat', () => {
  const init = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
  render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" initialMessages={init as never} />);
  expect(lastUseChatArg?.id).toBe('c1');
  expect(lastUseChatArg?.messages).toEqual(init);
});

it('fires onSettled once when a turn completes (submitted → ready)', () => {
  const onSettled = vi.fn();
  mockState.status = 'submitted';
  const { rerender } = render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  expect(onSettled).not.toHaveBeenCalled();
  mockState = { ...mockState, status: 'ready', messages: [{ id: 'm', role: 'assistant', parts: [] }] };
  rerender(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledWith(mockState.messages);
  rerender(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />); // stays ready → no refire
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it('on unmount mid-turn, stops the stream and persists the partial turn', () => {
  const onSettled = vi.fn();
  const stop = vi.fn();
  mockState = {
    ...mockState,
    status: 'streaming',
    stop,
    messages: [{ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] }],
  };
  const { unmount } = render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  expect(onSettled).not.toHaveBeenCalled();
  unmount();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledWith(mockState.messages);
});

it('on unmount when idle (no in-flight turn), does not persist or stop again', () => {
  const onSettled = vi.fn();
  const stop = vi.fn();
  mockState = { ...mockState, status: 'ready', stop, messages: [] };
  const { unmount } = render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  unmount();
  expect(stop).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
});

const unfinishedTurn = () => [
  { id: 'u', role: 'user', parts: [{ type: 'text', text: 'build the wiki' }] },
  { id: 'a', role: 'assistant', parts: [
    { type: 'dynamic-tool', toolName: 'query-nodes', toolCallId: 'c0', state: 'output-available', input: {}, output: { ok: true } },
    { type: 'dynamic-tool', toolName: 'create-project-wiki', toolCallId: 'c1', state: 'input-available', input: { project: 'Atlas' } },
  ] },
];

it('a stopped turn saves its unfinished tool call as interrupted, and shows it so (#283)', () => {
  const onSettled = vi.fn();
  mockState = { ...mockState, status: 'streaming', messages: unfinishedTurn() };
  const { rerender, container } = render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  expect(container.textContent).toContain('Working…');
  mockState = { ...mockState, status: 'ready' };
  rerender(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  const saved = onSettled.mock.calls[0]![0] as Array<{ parts: Array<{ toolCallId?: string; state?: string; errorText?: string }> }>;
  const parts = saved[1]!.parts;
  expect(parts.find((p) => p.toolCallId === 'c0')?.state).toBe('output-available');
  expect(parts.find((p) => p.toolCallId === 'c1')).toMatchObject({ state: 'output-error', errorText: 'Interrupted: this tool call did not finish.' });
  expect(mockState.setMessages).toHaveBeenCalledWith(saved);
  // Even before useChat's state catches up, a settled message never shows Working….
  expect(container.textContent).not.toContain('Working…');
  expect(container.textContent).toContain('Interrupted');
});

it('a turn with no unfinished tool call is saved as is, without touching useChat state', () => {
  const onSettled = vi.fn();
  mockState = { ...mockState, status: 'streaming' };
  const { rerender } = render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  const messages = [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'done' }] }];
  mockState = { ...mockState, status: 'ready', messages };
  rerender(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  expect(onSettled).toHaveBeenCalledWith(messages);
  expect(mockState.setMessages).not.toHaveBeenCalled();
});

it('on unmount mid-turn, the saved turn marks its unfinished tool call interrupted', () => {
  const onSettled = vi.fn();
  mockState = { ...mockState, status: 'streaming', messages: unfinishedTurn() };
  const { unmount } = render(<Chat transport={tx} searchNodes={searchNodes} conversationId="c1" onSettled={onSettled} />);
  unmount();
  const saved = onSettled.mock.calls[0]![0] as Array<{ parts: Array<{ toolCallId?: string; state?: string }> }>;
  expect(saved[1]!.parts.find((p) => p.toolCallId === 'c1')?.state).toBe('output-error');
});
