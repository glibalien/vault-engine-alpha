import { useEffect, useRef, type ReactNode } from 'react';
import type { PreviewRef } from './preview-ref.js';
import type { ChatUIMessage, ChatUIPart } from './types.js';
import { Message } from './Message.js';

export function Thread({ messages, renderPart, onOpenPreview }: {
  messages: ChatUIMessage[];
  renderPart?: (part: ChatUIPart, index: number, message: ChatUIMessage) => ReactNode;
  onOpenPreview?: (ref: PreviewRef) => void;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);
  return (
    <div className="thread">
      {messages.map((m) => <Message key={m.id} message={m} renderPart={renderPart} onOpenPreview={onOpenPreview} />)}
      <div ref={endRef} />
    </div>
  );
}
