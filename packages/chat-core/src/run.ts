import { toolInputAfterCallMiddleware } from './tool-parts.js';
import {
  convertToModelMessages,
  createUIMessageStream,
  generateId as defaultGenerateId,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type PrepareStepFunction,
  type StepResult,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriter,
  wrapLanguageModel,
} from 'ai';
import { withoutDataParts, withoutEmptyAssistantMessages } from './compose.js';
import { chatErrorText } from './errors.js';

/** Claude 5-generation model ids: Opus, Sonnet, Haiku, Fable and Mythos 5.x. */
const CLAUDE_5_GENERATION = /^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:-|$)/;

/** True for the Claude models that think when a request leaves `thinking` out. Their
 *  thinking streams as empty blocks unless the request asks to see it (#400). Older
 *  Claude models think only when asked: Opus 4.8, 4.7 and 4.6 and Sonnet 4.6 would
 *  start thinking (more cost and latency), and Haiku 4.5 rejects adaptive thinking. */
export function claudeThinksByDefault(modelId: string): boolean {
  return CLAUDE_5_GENERATION.test(modelId);
}

export interface RunChatInput {
  /** Injected provider model (host supplies it — e.g. fireworks(model)). */
  model: LanguageModel;
  /** Pre-composed system prompt (host composes via composeSystem). */
  system: string;
  messages: UIMessage[];
  tools: ToolSet;
  maxSteps: number;
  /** Per-step tool visibility (tiering) — forwarded to streamText. */
  prepareStep?: PrepareStepFunction<ToolSet>;
  generateId?: () => string;
  abortSignal?: AbortSignal;
  /** Per agent step — host emits viz parts via the writer. */
  onStepFinish?: (step: StepResult<ToolSet>, writer: UIMessageStreamWriter) => void;
  /** streamText finished — host emits step-cap + usage parts via the writer. */
  onStreamFinish?: (info: { steps: StepResult<ToolSet>[]; totalUsage: LanguageModelUsage }, writer: UIMessageStreamWriter) => void;
  /** Whole UI-message stream assembled — host persists the final messages. */
  onComplete?: (finalMessages: UIMessage[]) => void;
  /** Map an error to the text surfaced to the client. */
  onError?: (err: unknown) => string;
}

/**
 * Host-agnostic chat loop: builds the AI-SDK UI-message stream around streamText.
 * The host injects the model, tools, and pre-composed system, and supplies
 * callbacks (which receive the stream writer) for its own viz/usage/persist
 * concerns. Returns the UIMessageStream — the host adapts it (HTTP response or
 * an in-process transport).
 */
export function runChatStream(input: RunChatInput): ReadableStream<UIMessageChunk> {
  // One handler, used in BOTH places. streamText does not reject on a provider
  // failure — it enqueues an {type:'error'} chunk into fullStream, and
  // toUIMessageStream() is what turns that chunk into user-visible text. Its
  // DEFAULT onError returns the literal "An error occurred.", so omitting the
  // option there masks every provider error (bad key, rate limit, context
  // overflow, account suspension) before createUIMessageStream's onError is
  // ever consulted. Both call sites must get it or the host's handler is dead
  // code. See the onError: line on toUIMessageStream below.
  const onError = input.onError ?? chatErrorText;
  const modelId = typeof input.model === 'string' ? input.model : input.model.modelId;
  return createUIMessageStream({
    originalMessages: input.messages,
    generateId: input.generateId ?? defaultGenerateId,
    onError,
    execute: async ({ writer }) => {
      const result = streamText({
        // Trailing tool-input chunks after a call completes would reopen its part (#283).
        model: typeof input.model === 'string'
          ? input.model
          : wrapLanguageModel({ model: input.model, middleware: toolInputAfterCallMiddleware }),
        // ai@7 renamed the prompt option `system` -> `instructions`.
        // RunChatInput.system stays our own name — hosts and the chat settings
        // key (chatSystemPrompt) are unaffected by the SDK rename.
        instructions: input.system,
        // ai@7 made convertToModelMessages async. Reasoning-only assistant
        // messages left by a stopped turn are dropped: see withoutEmptyAssistantMessages.
        messages: withoutEmptyAssistantMessages(await convertToModelMessages(withoutDataParts(input.messages), {
          ignoreIncompleteToolCalls: true,
        })),
        tools: input.tools,
        prepareStep: input.prepareStep,
        // Anthropic caches only when asked (#360). The top-level form moves the breakpoint
        // forward with each step of the tool loop, which resends the whole conversation.
        // Every other provider ignores this namespace; most of them cache without asking.
        // Claude 5-generation models think before they answer and stream that thinking
        // empty by default, so the chat pane sat silent until the answer (#400). Ask for
        // a summary instead, which the chat shows; it is billed the same. Only where
        // thinking is already on: on older models this would switch it on.
        providerOptions: {
          anthropic: {
            cacheControl: { type: 'ephemeral' },
            ...(claudeThinksByDefault(modelId) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
          },
        },
        abortSignal: input.abortSignal,
        stopWhen: stepCountIs(input.maxSteps),
        onStepFinish: (step) => input.onStepFinish?.(step, writer),
        onFinish: (info) => input.onStreamFinish?.({ steps: info.steps, totalUsage: info.totalUsage }, writer),
      });
      writer.merge(result.toUIMessageStream({ onError }));
    },
    onFinish: ({ messages }) => input.onComplete?.(messages),
  });
}
