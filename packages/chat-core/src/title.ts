import { generateText, type LanguageModel, type LanguageModelUsage, type UIMessage } from 'ai';
import { resolveModelRef, type ModelCatalogEntry, type ModelProvider } from '@vault/settings-registry';
import { usageEventArgs, callBilling, type CallBilling } from './usage.js';

export const DEFAULT_TITLE_TIMEOUT_MS = 15_000;
const ASSISTANT_SLICE_CHARS = 1_500;
const TITLE_MAX_CHARS = 80;

const TITLE_SYSTEM = 'You name chat conversations. Given the first exchange of a conversation, reply with ONLY a concise title for it: 2-6 words, no quotes, no trailing punctuation, in the same language as the user\'s message. Capture the topic or task, not the phrasing (e.g. "Identifying Project Alpha Task", not "Can you find my task").';

const partText = (m: UIMessage): string =>
  m.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join(' ').trim();

/** First non-empty user message + the first assistant reply after it (sliced), or null. */
export function firstExchangeText(messages: UIMessage[]): { userText: string; assistantText: string } | null {
  const ui = messages.findIndex((m) => m.role === 'user' && partText(m) !== '');
  if (ui < 0) return null;
  const assistant = messages.slice(ui + 1).find((m) => m.role === 'assistant' && partText(m) !== '');
  return { userText: partText(messages[ui]!), assistantText: assistant ? partText(assistant).slice(0, ASSISTANT_SLICE_CHARS) : '' };
}

/** Model output → displayable title, or null when nothing usable survives. Defensive against
 *  reasoning models that inline think blocks (gpt-oss/deepseek) and quote-happy outputs. */
export function sanitizeTitle(raw: string): string | null {
  let t = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  t = t.replace(/[.:;,!?…\s]+$/g, '').trim();
  if (t === '') return null;
  return t.length > TITLE_MAX_CHARS ? t.slice(0, TITLE_MAX_CHARS).trimEnd() : t;
}

/** One-shot title completion. Null on error/timeout/empty — callers fall back mechanically. */
export async function generateConversationTitle(opts: {
  model: LanguageModel; userText: string; assistantText: string; timeoutMs?: number;
}): Promise<{ title: string; usage: LanguageModelUsage; billing: CallBilling } | null> {
  try {
    const result = await generateText({
      model: opts.model,
      system: TITLE_SYSTEM,
      prompt: `User: ${opts.userText}\n\nAssistant: ${opts.assistantText}`,
      // Reasoning models (gpt-oss) think in output tokens before the few-word answer.
      maxOutputTokens: 2048,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS),
    });
    const title = sanitizeTitle(result.text);
    return title ? { title, usage: result.usage, billing: callBilling(result) } : null;
  } catch {
    return null;
  }
}

export interface TitleFlowOpts {
  conversationId: string;
  messages: UIMessage[];
  /** Mechanical fallback title, or null to save nothing on LLM failure (backfill mode). */
  fallbackTitle: string | null;
  titleModelRef: string;
  catalog: ModelCatalogEntry[];
  availability: Record<ModelProvider, boolean>;
  makeModel: (entry: ModelCatalogEntry) => LanguageModel;
  service: 'chat-web' | 'chat-plugin';
  saveTitle: (title: string) => Promise<void>;
  /** Fire-and-forget spend report — the caller owns transport + its error handling. */
  recordUsage: (args: Record<string, unknown>) => void;
  log: (msg: string) => void;
  timeoutMs?: number;
}

/**
 * The shared title orchestration both surfaces wire behind their placeholder guards:
 * strict titleModel resolution → generate → async title-only save → spend record.
 * Returns true when a title (LLM or fallback) was saved; never throws — titling
 * must never break the turn that spawned it.
 */
export async function runTitleFlow(o: TitleFlowOpts): Promise<boolean> {
  try {
    const exchange = firstExchangeText(o.messages);
    const entry = resolveModelRef(o.catalog, o.titleModelRef);
    let title: string | null;
    if (!exchange) {
      title = o.fallbackTitle;
    } else if (!entry || !o.availability[entry.provider]) {
      o.log(`title model ref "${o.titleModelRef}" is unknown, disabled, or its provider key is missing — using derived title`);
      title = o.fallbackTitle;
    } else {
      let result: { title: string; usage: LanguageModelUsage; billing: CallBilling } | null = null;
      try {
        result = await generateConversationTitle({ model: o.makeModel(entry), ...exchange, timeoutMs: o.timeoutMs });
      } catch (err) {
        o.log(`title generation failed for ${o.conversationId}: ${err instanceof Error ? err.message : String(err)}`);
        result = null;
      }
      if (result) {
        try {
          const args = usageEventArgs({
            model: entry.model, provider: entry.provider, service: o.service,
            purpose: 'title-generation', totalUsage: result.usage, conversationId: o.conversationId,
            billing: result.billing,
          });
          if (args) o.recordUsage(args);
        } catch (err) {
          o.log(`title usage record failed for ${o.conversationId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      title = result?.title ?? o.fallbackTitle;
    }
    if (title === null) return false;
    await o.saveTitle(title);
    return true;
  } catch (err) {
    // Generation (above) and usage-recording each have their own inner catch, so this outer
    // catch fires only when saveTitle (or something unexpected) throws — not generation.
    o.log(`title not saved for ${o.conversationId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
