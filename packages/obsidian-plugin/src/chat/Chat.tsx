import { useEffect, useRef, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import type { ChatTransport, UIMessage } from 'ai';
import { Thread, ToolTrace, Reasoning, hasTextAfter, Composer, type ChatUIMessage, type ChatUIPart, type ModelPickerProps, type NodeCandidate } from '@vault/chat-ui';
import { settleUnfinishedToolParts } from '@vault/chat-core';
import { PluginVizCard } from './PluginVizCard.js';
import type { VizSpec, PreviewRef } from '@vault/viz-ui';

export function Chat({ transport, onOpenPreview, onPinToBoard, conversationId, initialMessages, onSettled, searchNodes, onAddNodeChip, modelPicker }: {
  transport: ChatTransport<UIMessage>;
  onOpenPreview?: (ref: PreviewRef) => void;
  onPinToBoard?: (spec: VizSpec) => void;
  conversationId?: string;
  initialMessages?: UIMessage[];
  onSettled?: (messages: UIMessage[]) => void;
  searchNodes: (q: string) => Promise<NodeCandidate[]>;
  onAddNodeChip?: (c: NodeCandidate) => void;
  /** Model picker chip + popover, rendered in the composer — omitted entirely when absent. */
  modelPicker?: ModelPickerProps;
}) {
  const { messages, sendMessage, setMessages, status, stop, error } = useChat<UIMessage>(
    conversationId !== undefined ? { id: conversationId, messages: initialMessages, transport } : { transport },
  );
  const busy = status === 'submitted' || status === 'streaming';

  // Fire onSettled once per completed turn (busy → ready), for the host to persist.
  // A tool call still without a result then never gets one (Stop, a failed turn), so it
  // is marked interrupted first, both here and in what is saved (#283).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) { wasBusy.current = true; return; }
    if (wasBusy.current) {
      wasBusy.current = false;
      const settled = settleUnfinishedToolParts(messages);
      if (settled !== messages) setMessages(settled);
      onSettled?.(settled);
    }
  }, [busy, messages, onSettled, setMessages]);

  // Live refs so the unmount cleanup reads current values, not a stale closure.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const stopRef = useRef(stop);
  stopRef.current = stop;

  // M1: switching conversations remounts <Chat key={conversationId}>; if a turn is
  // in flight at unmount, the busy→ready effect never runs, so persist the partial
  // turn and abort the stream here instead of silently dropping it.
  useEffect(() => () => {
    if (wasBusy.current) {
      wasBusy.current = false;
      stopRef.current?.();
      onSettledRef.current?.(settleUnfinishedToolParts(messagesRef.current));
    }
  }, []);

  // Only the last message can still be streaming; elsewhere a call without a result is interrupted.
  const streamingId = busy ? messages[messages.length - 1]?.id : undefined;
  const renderPart = (part: ChatUIPart, i: number, message: ChatUIMessage): ReactNode => {
    if (part.type === 'dynamic-tool') return <ToolTrace key={i} part={part as never} settled={message.id !== streamingId} />;
    // Open while the model is still thinking: the message streams and no answer text follows yet.
    if (part.type === 'reasoning') {
      const live = message.id === streamingId && !hasTextAfter(message.parts, i);
      const streaming = (part as { state?: string }).state === 'streaming';
      return <Reasoning key={i} text={part.text} live={live} streaming={streaming} onOpenPreview={onOpenPreview} />;
    }
    if (part.type === 'data-viz') {
      const d = (part as unknown as { data: { toolCallId: string; spec: VizSpec; collapsed?: boolean } }).data;
      return <PluginVizCard key={d.toolCallId} spec={d.spec} collapsed={d.collapsed} onOpenPreview={onOpenPreview} onPin={onPinToBoard} />;
    }
    return null;
  };
  // Keep the spinner until the streaming message shows something: the stream opens well
  // before a thinking model's first summary words, and the pane would sit blank (#400).
  const last = messages[messages.length - 1];
  const waiting = busy && !(last?.role === 'assistant' && last.parts.some(rendersSomething));

  return (
    <div className="vc-root">
      <div className="vc-messages">
        <Thread messages={messages as unknown as ChatUIMessage[]} renderPart={renderPart} onOpenPreview={onOpenPreview} />
        {waiting && (
          <div className="vc-thinking" aria-live="polite"><span className="spin" /> thinking…</div>
        )}
        {error && <div className="vc-error" role="alert">⚠ {error.message}</div>}
      </div>
      <Composer
        disabled={busy}
        streaming={busy}
        capped={false}
        searchNodes={searchNodes}
        onSend={(t) => void sendMessage({ text: t })}
        onStop={() => void stop()}
        onAddNodeChip={onAddNodeChip}
        onOpenPreview={onOpenPreview}
        modelPicker={modelPicker}
      />
    </div>
  );
}

/** Whether the chat draws anything for a part: blank text and empty reasoning draw nothing,
 *  and neither do parts it has no renderer for (step-start and the like). */
function rendersSomething(part: { type: string; text?: string }): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return (part.text ?? '').trim() !== '';
  return part.type === 'dynamic-tool' || part.type === 'data-viz';
}
