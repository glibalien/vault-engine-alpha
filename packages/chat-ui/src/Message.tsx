import type { ReactNode } from 'react';
import type { PreviewRef } from './preview-ref.js';
import type { ChatUIMessage, ChatUIPart } from './types.js';
import { Icon } from './Icon.js';
import { MessageMarkdown } from './MessageMarkdown.js';

export function Message({ message, renderPart, onOpenPreview }: {
  message: ChatUIMessage;
  /** Renders non-text parts; gets the message too, e.g. to tell whether it is still streaming. */
  renderPart?: (part: ChatUIPart, index: number, message: ChatUIMessage) => ReactNode;
  onOpenPreview?: (ref: PreviewRef) => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="av">{isUser ? 'you' : <Icon name="sparkle" />}</div>
      <div className="body">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return <MessageMarkdown key={i} text={part.text ?? ''} onOpenPreview={onOpenPreview} />;
          }
          return renderPart ? <span key={i}>{renderPart(part, i, message)}</span> : null;
        })}
      </div>
    </div>
  );
}
