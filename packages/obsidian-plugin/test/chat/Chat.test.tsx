import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VizClientProvider } from '@vault/viz-ui';

// jsdom doesn't implement scrollIntoView; Thread calls it on mount.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const stubCall = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true,"data":{"nodes":[],"total":0}}' }] }));

const sendMessage = vi.fn();
let mockState: Record<string, unknown> = { messages: [], status: 'ready', sendMessage, stop: vi.fn(), error: undefined };
vi.mock('@ai-sdk/react', () => ({ useChat: () => mockState }));
import { Chat } from '../../src/chat/Chat.js';

const tx = {} as never;
const searchNodes = async () => [];

describe('plugin Chat', () => {
  it('renders assistant markdown + a tool trace', () => {
    mockState = {
      messages: [
        { id: 'a', role: 'assistant', parts: [{ type: 'text', text: '# Hi\n\n- one' }] },
        { id: 'b', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'query-nodes', toolCallId: 't1', state: 'output-available', input: {}, output: { ok: true } }] },
      ],
      status: 'ready', sendMessage: vi.fn(), stop: vi.fn(), error: undefined,
    };
    const { container } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.msg.assistant h1')?.textContent).toBe('Hi');
    expect(container.querySelector('.msg.assistant li')?.textContent).toBe('one');
    expect(container.querySelector('.toolcall')).not.toBeNull();
  });

  it('shows the thinking indicator while submitted, not when ready', () => {
    mockState = { messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], status: 'submitted', sendMessage: vi.fn(), stop: vi.fn(), error: undefined };
    const { container, rerender } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.vc-thinking')).not.toBeNull();
    mockState = { ...mockState, status: 'ready' };
    rerender(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.vc-thinking')).toBeNull();
  });
});

describe('Chat', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders assistant text and a tool-trace', () => {
    mockState = {
      messages: [
        { id: 'a', role: 'assistant', parts: [
          { type: 'text', text: 'Hello there' },
          { type: 'dynamic-tool', toolName: 'query-nodes', toolCallId: 't1', state: 'output-available', input: { types: ['task'] }, output: { ok: true } },
        ] },
      ],
      status: 'ready', sendMessage, stop: vi.fn(), error: undefined,
    };
    render(<Chat transport={{} as never} searchNodes={searchNodes} />);
    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.getByText('Search vault')).toBeTruthy();
  });

  it('renders a VizCard for a data-viz part', () => {
    mockState = {
      messages: [
        { id: 'a', role: 'assistant', parts: [
          { type: 'data-viz', id: 't1', data: { toolCallId: 't1', collapsed: true, spec: { kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: ['status'] } } },
        ] },
      ],
      status: 'ready', sendMessage, stop: vi.fn(), error: undefined,
    };
    const { container } = render(
      <VizClientProvider call={stubCall as never}>
        <Chat transport={{} as never} searchNodes={searchNodes} />
      </VizClientProvider>,
    );
    // VizCard's root is `.viz`; its header always renders the spec title (`.q`),
    // even collapsed and before the async query resolves.
    expect(container.querySelector('.viz')).toBeTruthy();
    expect(screen.getByText('Tasks')).toBeTruthy();
  });

  it('sends a message on Send click', () => {
    mockState = { messages: [], status: 'ready', sendMessage, stop: vi.fn(), error: undefined };
    const { container } = render(<Chat transport={{} as never} searchNodes={searchNodes} />);
    fireEvent.change(screen.getByPlaceholderText('Ask the vault…'), { target: { value: 'find my tasks' } });
    fireEvent.click(container.querySelector('.composer .send')!);
    expect(sendMessage).toHaveBeenCalledWith({ text: 'find my tasks' });
  });

  it('calls onPinToBoard with the card spec when the pin affordance is clicked', () => {
    const spec = { kind: 'table' as const, title: 'My Tasks', query: { types: ['task'] }, display_fields: ['status'] };
    mockState = {
      messages: [
        { id: 'a', role: 'assistant', parts: [
          { type: 'data-viz', id: 't1', data: { toolCallId: 't1', collapsed: false, spec } },
        ] },
      ],
      status: 'ready', sendMessage, stop: vi.fn(), error: undefined,
    };
    const onPinToBoard = vi.fn();
    render(
      <VizClientProvider call={stubCall as never}>
        <Chat transport={{} as never} onPinToBoard={onPinToBoard} searchNodes={searchNodes} />
      </VizClientProvider>,
    );
    fireEvent.click(screen.getByText('pin'));
    expect(onPinToBoard).toHaveBeenCalledWith(spec);
  });
});

describe('Chat reasoning (#400)', () => {
  const user = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'find my tasks' }] };
  const thinking = { type: 'reasoning', text: '**Searching**\n\nLooking for open tasks.', state: 'streaming' };
  const state = (parts: unknown[], status: string) => ({
    messages: [user, { id: 'a', role: 'assistant', parts }], status, sendMessage, setMessages: vi.fn(), stop: vi.fn(), error: undefined,
  });

  it('keeps the thinking spinner while the stream is open but has only an empty reasoning part', () => {
    mockState = state([{ type: 'step-start' }, { type: 'reasoning', text: '', state: 'streaming' }], 'streaming');
    const { container } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.vc-thinking')).not.toBeNull();
    expect(container.querySelector('.reasoning')).toBeNull();
  });

  it('replaces the spinner with the Thinking block once the first summary text arrives', () => {
    mockState = state([{ type: 'step-start' }, { type: 'reasoning', text: '', state: 'streaming' }], 'streaming');
    const { container, rerender } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.vc-thinking')).not.toBeNull();

    mockState = state([{ type: 'step-start' }, { type: 'reasoning', text: 'Looking for', state: 'streaming' }], 'streaming');
    rerender(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.vc-thinking')).toBeNull();
    expect(container.querySelector('.reasoning .rs-head')?.textContent).toBe('Thinking…');
    expect(container.querySelector('.reasoning .rs-body')?.textContent).toBe('Looking for');
  });

  it('shows the thinking open while it streams, then collapses it once the answer starts', () => {
    mockState = state([{ type: 'step-start' }, thinking], 'streaming');
    const { container, rerender } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.reasoning .rs-head')?.textContent).toBe('Thinking…');
    expect(container.querySelector('.reasoning .rs-body')?.textContent).toContain('Looking for open tasks.');
    expect(container.querySelector('.vc-thinking')).toBeNull();

    mockState = state([{ type: 'step-start' }, { ...thinking, state: 'done' }, { type: 'text', text: 'You have 3.', state: 'streaming' }], 'streaming');
    rerender(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.reasoning .rs-head')?.textContent).toBe('Thinking');
    expect(container.querySelector('.reasoning .rs-body')).toBeNull();
    expect(screen.getByText('You have 3.')).toBeTruthy();
  });

  it('keeps thinking open through a tool call, and collapses it when the turn ends', () => {
    const tool = { type: 'dynamic-tool', toolName: 'query-nodes', toolCallId: 't1', state: 'output-available', input: {}, output: { ok: true } };
    mockState = state([{ type: 'step-start' }, { ...thinking, state: 'done' }, tool], 'streaming');
    const { container, rerender } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.reasoning .rs-body')).not.toBeNull();
    expect(container.querySelector('.reasoning .spin')).toBeNull();

    mockState = state([{ type: 'step-start' }, { ...thinking, state: 'done' }, tool], 'ready');
    rerender(<Chat transport={tx} searchNodes={searchNodes} />);
    expect(container.querySelector('.reasoning .rs-body')).toBeNull();
    expect(container.querySelector('.reasoning .rs-head')?.textContent).toBe('Thinking');
  });

  it('shows earlier messages\' thinking collapsed and empty reasoning parts not at all', () => {
    mockState = {
      messages: [
        user,
        { id: 'a1', role: 'assistant', parts: [{ ...thinking, state: 'done' }, { type: 'text', text: 'Done.' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and now?' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'reasoning', text: '', state: 'streaming' }] },
      ],
      status: 'streaming', sendMessage, stop: vi.fn(), error: undefined,
    };
    const { container } = render(<Chat transport={tx} searchNodes={searchNodes} />);
    const blocks = container.querySelectorAll('.reasoning');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.querySelector('.rs-head')?.textContent).toBe('Thinking');
    expect(blocks[0]!.querySelector('.rs-body')).toBeNull();
  });
});
