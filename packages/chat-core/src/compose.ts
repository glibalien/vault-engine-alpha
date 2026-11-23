import type { AssistantModelMessage, ModelMessage, UIMessage } from 'ai';

/** e.g. "Today is Friday, 2026-07-10 (Europe/Amsterdam)." Built per call — never
 *  capture at module load; long-running servers would go stale. Date-only: a
 *  clock time would change the system prompt every turn and defeat prefix caching. */
export function currentDateLine(now: Date = new Date()): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const date = now.toLocaleDateString('en-CA'); // local YYYY-MM-DD
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Today is ${weekday}, ${date} (${tz}).`;
}

/** Compose the system prompt: base, then the current-date line, then the assembled working-context block, then the transient inline-surface stash. */
export function composeSystem(base: string, contextBlock: string, stash: string | undefined, now: Date = new Date()): string {
  let out = `${base}\n\n${currentDateLine(now)}`;
  if (contextBlock) out += `\n\n${contextBlock}`;
  if (stash) out += `\n\n## Live app context (from an embedded surface)\n${stash}`;
  return out;
}

/** Strip UI-only data parts before model conversion — they are host artifacts. */
export function withoutDataParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({ ...m, parts: m.parts.filter((p) => !p.type.startsWith('data-')) }));
}

/** Drop assistant model messages that hold nothing but reasoning or blank text.
 *  A turn stopped mid-reasoning leaves one, and so does a step whose only tool
 *  call never finished (`ignoreIncompleteToolCalls` removes the call and keeps
 *  the reasoning). OpenRouter sends such a message as `{ role: 'assistant',
 *  content: null }`, which some upstreams reject (Qwen via Alibaba: 400 "The
 *  content field is a required field."). The stored conversation is replayed on
 *  every send, so one bad message failed every later turn. Filtering at send
 *  time also repairs conversations already stored that way. The AI SDK already
 *  drops assistant messages with no parts at all, so this adds no new shape. */
export function withoutEmptyAssistantMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((m) => m.role !== 'assistant' || hasAssistantOutput(m.content));
}

function hasAssistantOutput(content: AssistantModelMessage['content']): boolean {
  if (typeof content === 'string') return content.trim() !== '';
  return content.some((part) => {
    if (part.type === 'reasoning') return false;
    if (part.type === 'text') return part.text.trim() !== '';
    return true; // tool calls, files and anything newer count as output
  });
}
