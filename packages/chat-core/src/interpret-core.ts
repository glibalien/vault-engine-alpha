import { generateObject, jsonSchema, type LanguageModel, type LanguageModelUsage } from 'ai';
import { callBilling, combineBilling, type CallBilling } from './usage.js';

export const DEFAULT_INTERPRET_TIMEOUT_MS = 20_000;

export interface InterpretConfig<T> {
  schema: Record<string, unknown>;
  system: (now?: Date) => string;
  prompt: (text: string, current?: unknown) => string;
  sanitize: (raw: unknown) => { value: T } | { error: string };
  /** Wording appended to the prompt on the one correction retry, given the sanitize error.
   *  Defaults to the generic "Return a corrected full object." — callers whose schema represents
   *  something more specific (e.g. interpretVizSpec's "full spec") can override the noun so the
   *  retry instruction reads naturally. */
  correction?: (error: string) => string;
}

const DEFAULT_CORRECTION = (error: string): string => `Your previous output was invalid: ${error}. Return a corrected full object.`;

export type ToolArgsOutcome<T> =
  | { ok: true; value: T; usage: LanguageModelUsage; billing: CallBilling }
  | { ok: false; error: string };

function addNum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * ai@7's LanguageModelUsage nests cache/reasoning detail under
 * inputTokenDetails/outputTokenDetails (required fields, not the flat shape
 * older AI SDKs used) — usageEventArgs (./usage.ts) reads those nested fields
 * for cache-read/write billing, so a naive top-level-only sum would silently
 * zero out cache accounting for downstream spend records. The `?.` on each
 * nested read is defensive (matching usage.ts's own idiom) — the type makes
 * the detail objects required, but a mocked or hand-built usage value (tests,
 * a future provider quirk) could still omit them; absent+absent still sums
 * to undefined either way.
 */
function sumUsage(list: LanguageModelUsage[]): LanguageModelUsage {
  return list.reduce<LanguageModelUsage>((a, b) => ({
    inputTokens: addNum(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addNum(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: addNum(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: addNum(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokens: addNum(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: addNum(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
      reasoningTokens: addNum(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
    },
    totalTokens: addNum(a.totalTokens, b.totalTokens),
  }), {
    inputTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  });
}

/**
 * One structured-output call (plus at most one correction retry) turning plain
 * language into sanitized tool args. Never throws — every failure is ok:false.
 * usage sums both attempts so the caller's spend record sees what was consumed.
 *
 * timeoutMs bounds the TOTAL wall clock across both attempts: a single
 * AbortSignal is created before the first attempt and shared by both
 * generateObject calls, so a correction retry can't double the worst case (a
 * per-attempt signal would). Each attempt is also explicitly raced against
 * that shared deadline — belt-and-braces alongside passing the signal to
 * generateObject — so a model/transport that doesn't itself respect the
 * signal (e.g. one that just hangs) still can't keep the caller waiting past
 * timeoutMs.
 */
export async function interpretToolArgs<T>(o: {
  text: string; current?: unknown; model: LanguageModel; timeoutMs?: number; config: InterpretConfig<T>;
}): Promise<ToolArgsOutcome<T>> {
  const usages: LanguageModelUsage[] = [];
  const billings: CallBilling[] = [];
  const abortSignal = AbortSignal.timeout(o.timeoutMs ?? DEFAULT_INTERPRET_TIMEOUT_MS);
  // Rejects once the shared deadline fires. Attached once, up front — well before the
  // timer can possibly fire — so both attempts race the SAME listener; once it rejects,
  // any subsequent race against it (the correction retry) settles immediately instead of
  // waiting out a second full timeout.
  const deadline = new Promise<never>((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => reject(abortSignal.reason ?? new Error('interpretToolArgs timed out')), { once: true });
  });
  const attempt = async (correction?: string): Promise<{ value: T } | { invalid: string }> => {
    try {
      const generated = await Promise.race([
        generateObject({
          model: o.model,
          schema: jsonSchema<Record<string, unknown>>(o.config.schema as Parameters<typeof jsonSchema>[0]),
          system: o.config.system(),
          prompt: o.config.prompt(o.text, o.current) + (correction ? `\n\n${correction}` : ''),
          abortSignal,
        }),
        deadline,
      ]);
      usages.push(generated.usage);
      billings.push(callBilling(generated));
      const s = o.config.sanitize(generated.object);
      return 'error' in s ? { invalid: s.error } : { value: s.value };
    } catch (err) {
      // Schema-mismatch, timeout, and transport errors all land here; the retry
      // gets one more chance with the message appended, then we fail closed.
      return { invalid: err instanceof Error ? err.message : String(err) };
    }
  };

  const correction = o.config.correction ?? DEFAULT_CORRECTION;
  let out = await attempt();
  if ('invalid' in out) {
    out = await attempt(correction(out.invalid));
  }
  if ('invalid' in out) return { ok: false, error: out.invalid };
  return { ok: true, value: out.value, usage: sumUsage(usages), billing: combineBilling(billings) };
}
