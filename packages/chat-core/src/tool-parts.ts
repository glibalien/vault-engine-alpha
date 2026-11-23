import type { LanguageModelMiddleware, UIMessage } from 'ai';

/**
 * Drop tool-input chunks for a call whose `tool-call` has already arrived (#283).
 *
 * `@openrouter/ai-sdk-provider` emits `tool-call` as soon as the arguments parse as
 * JSON, then keeps emitting `tool-input-delta` (often empty) for later chunks of the
 * same call. On every delta the AI SDK's UI-message reader sets the part back to
 * `input-streaming` and clears `errorText`. A call that fails at once (a tool the model
 * hasn't loaded yet) gets its error result before those trailing deltas, so the part
 * ends stuck in `input-streaming`: "Working…" forever, though the model saw the error
 * and carried on. Once the call is complete its input can't change, so later
 * input chunks carry nothing. Applied in `runChatStream`, so every provider gets it.
 */
export const toolInputAfterCallMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const called = new Set<string>();
    return {
      ...rest,
      stream: stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'tool-call') {
            called.add(part.toolCallId);
          } else if ((part.type === 'tool-input-start' || part.type === 'tool-input-delta' || part.type === 'tool-input-end')
            && called.has(part.id)) {
            return;
          }
          controller.enqueue(part);
        },
      })),
    };
  },
};

/** What a tool call that never finished reports, to the reader and to the model. */
export const UNFINISHED_TOOL_TEXT = 'Interrupted: this tool call did not finish.';

type ToolPartLike = { type: string; state?: string; input?: unknown; errorText?: string };

const isUnfinishedToolPart = (part: ToolPartLike): boolean =>
  (part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
  && (part.state === 'input-streaming' || part.state === 'input-available');

/**
 * Mark tool parts that will never finish as failed ("Interrupted…"), for a turn that
 * has settled (#283). Run when a turn ends, before it is saved: a stopped turn leaves
 * the call it was running in `input-streaming` or `input-available` for good. As
 * `output-error`, the next send shows the model a failed call instead of dropping it,
 * which would leave that step's reasoning on its own (#282). Returns the same array
 * when nothing needed changing.
 */
export function settleUnfinishedToolParts(messages: UIMessage[]): UIMessage[] {
  let changed = false;
  const settled = messages.map((message) => {
    if (message.role !== 'assistant' || !message.parts.some((p) => isUnfinishedToolPart(p as ToolPartLike))) return message;
    changed = true;
    return {
      ...message,
      parts: message.parts.map((part) => {
        const p = part as ToolPartLike;
        if (!isUnfinishedToolPart(p)) return part;
        return { ...part, state: 'output-error', input: p.input ?? {}, errorText: UNFINISHED_TOOL_TEXT } as typeof part;
      }),
    };
  });
  return changed ? settled : messages;
}
