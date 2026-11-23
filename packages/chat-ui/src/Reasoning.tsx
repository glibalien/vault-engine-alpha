import { useState } from 'react';
import type { PreviewRef } from './preview-ref.js';
import type { ChatUIPart } from './types.js';
import { Icon } from './Icon.js';
import { MessageMarkdown } from './MessageMarkdown.js';

/** True when answer text follows the part at `index`, i.e. the reasoning before it is over. */
export function hasTextAfter(parts: readonly ChatUIPart[], index: number): boolean {
  return parts.slice(index + 1).some((part) => part.type === 'text' && (part.text ?? '').trim() !== '');
}

/** A model's reasoning (an AI SDK `reasoning` part), muted and collapsible.
 *  `live`: the message is still streaming and no answer text follows this part yet. The
 *  block is then open and fills in as the reasoning streams; otherwise it is one line the
 *  reader can open. `streaming`: this part is still arriving, so it shows as working (in
 *  a tool loop, an earlier block stays open but is finished). A part with no text renders
 *  nothing: stored messages and some providers carry empty reasoning parts, and a bare
 *  header would be noise. */
export function Reasoning({ text, live = false, streaming = false, onOpenPreview }: {
  text?: string;
  live?: boolean;
  streaming?: boolean;
  onOpenPreview?: (ref: PreviewRef) => void;
}) {
  // The reader's choice, once they make one; until then the block follows `live`.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const body = (text ?? '').trim();
  if (body === '') return null;
  const open = toggled ?? live;
  const working = live && streaming;
  const toggle = () => setToggled(!open);
  return (
    <div className={`reasoning${live ? ' live' : ''}`}>
      <div
        className="rs-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
      >
        <Icon name="chevron" className={open ? 'chev open' : 'chev'} />
        <span>{working ? 'Thinking…' : 'Thinking'}</span>
        {working && <span className="spin" />}
      </div>
      {open && (
        <div className="rs-body">
          <MessageMarkdown text={body} onOpenPreview={onOpenPreview} />
        </div>
      )}
    </div>
  );
}
