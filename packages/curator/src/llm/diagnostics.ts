import { validTokenCount } from '@vault/llm';
import { z } from 'zod';
import type { StructuredCallFailureReason, WikiCallContext } from './types.js';
import { PAGE_ENVELOPE_ISSUES } from './page-markdown-output.js';
import type { SdkAttemptTally } from './sdk-attempts.js';

const count = z.number().int().nonnegative();
const bounded = z.string().refine(s => Buffer.byteLength(s, 'utf8') <= 200);
export const diagnosticResponseSchema = z.object({
  attempt: count, finishReason: bounded.optional(), reportedModel: bounded.optional(), requestId: bounded.optional(),
  contentKind: z.enum(['null', 'string', 'array', 'object', 'other']),
  responseTextBytes: count.optional(), reasoningTokens: count.optional(), usageKnown: z.boolean(),
  providerCostUsd: z.number().nonnegative().finite().optional(),
  /** Why a page response's envelope was rejected; a closed code, never content. */
  envelopeIssue: z.enum(PAGE_ENVELOPE_ISSUES).optional(),
}).strict();
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const UPSTREAM = /^[A-Za-z0-9_.:() -]{1,64}$/;
/** Why the provider call threw: scalar identifiers only, never the provider's message or body text. */
export const diagnosticFailureSchema = z.object({
  attempt: count, kind: z.enum(['http', 'timeout', 'connection', 'other']),
  status: z.number().int().min(100).max(599).optional(), errorType: z.string().regex(TOKEN).optional(),
  code: z.string().regex(TOKEN).optional(), requestId: z.string().regex(TOKEN).optional(),
  upstream: z.string().regex(UPSTREAM).optional(),
  /** The provider said the key's spend limit or the account's credit ran out (#342). A closed flag
   *  read from the provider's wording, so a redacted failure can still be recognized. */
  spendLimit: z.literal(true).optional(),
}).strict();
export const diagnosticsSchema = z.object({
  version: z.literal(1), adapterAttempts: count, sdkAttempts: count.nullable(),
  responses: z.array(diagnosticResponseSchema).max(2), failure: diagnosticFailureSchema.optional(),
}).strict().refine(d => Buffer.byteLength(JSON.stringify(d), 'utf8') <= 4096);
export type DiagnosticResponse = z.infer<typeof diagnosticResponseSchema>;
export type DiagnosticFailure = z.infer<typeof diagnosticFailureSchema>;
export type StructuredCallDiagnostics = z.infer<typeof diagnosticsSchema>;

function short(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Bound work and preserve whole UTF-8 characters.
  let result = '';
  for (const char of value.slice(0, 200)) {
    if (Buffer.byteLength(result + char, 'utf8') > 200) break;
    result += char;
  }
  return result;
}
function matching(value: unknown, pattern: RegExp): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && pattern.test(text) ? text : undefined;
}
/** The first identifier-shaped `code` on the error or its causes (e.g. ECONNRESET under an SDK connection error). */
function causeCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const code = matching((current as { code?: unknown }).code, TOKEN);
    if (code !== undefined) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
/** Provider wording or codes for a spent key limit or an empty account (#342). */
export const SPEND_LIMIT_TEXT = /key limit exceeded|insufficient credits|credit balance is too low|insufficient_quota|exceeded your current quota/i;

/** Whether the provider's error says its spend limit or credit ran out. Only the match leaves; the text never does. */
function saysSpendLimit(error: unknown): boolean {
  try {
    const e = error as { message?: unknown; code?: unknown;
      error?: { message?: unknown; code?: unknown; type?: unknown; error?: { message?: unknown; type?: unknown } } } | null;
    // OpenAI-compatible bodies carry `error.message`; Anthropic nests `error.error.message`.
    return [e?.message, e?.code, e?.error?.message, e?.error?.code, e?.error?.error?.message]
      .some(value => typeof value === 'string' && SPEND_LIMIT_TEXT.test(value.slice(0, 2_000)));
  } catch {
    return false;
  }
}

function describeFailure(error: unknown, attempt: number): DiagnosticFailure {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown; requestID?: unknown; error?: { metadata?: { provider_name?: unknown } } };
  const status = typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599
    ? e.status : undefined;
  const errorType = matching(Object.getPrototypeOf(error)?.constructor?.name, TOKEN);
  const code = causeCode(error);
  const requestId = matching(e.requestID, TOKEN);
  const upstream = matching(e.error?.metadata?.provider_name, UPSTREAM);
  return {
    attempt, kind: status !== undefined ? 'http' : errorType === 'APIConnectionTimeoutError' ? 'timeout'
      : errorType === 'APIConnectionError' ? 'connection' : 'other',
    ...(status !== undefined ? { status } : {}), ...(errorType ? { errorType } : {}), ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}), ...(upstream ? { upstream } : {}),
    ...(status !== undefined && saysSpendLimit(error) ? { spendLimit: true as const } : {}),
  };
}
export { validTokenCount };
/** Only scalar/shape data enters this collector. It is never a business dependency.
 *  `sdkTally` counts the HTTP requests the SDK sent (its own retries included) when the client
 *  was built with `countingFetch`; a call that let the SDK retry reports that count, or null
 *  when nothing was counted (#321). */
export function createCallDiagnostics(enabled: boolean, singleSdkAttempt: boolean, sdkTally?: SdkAttemptTally) {
  let attempts = 0;
  const responses: DiagnosticResponse[] = [];
  let failure: DiagnosticFailure | undefined;
  return {
    start(): void { attempts++; },
    response(read: () => { content: unknown; finishReason?: unknown; reportedModel?: unknown;
      requestId?: unknown; reasoningTokens?: unknown; providerCostUsd?: unknown; envelopeIssue?: unknown; usageKnown: boolean }): void {
      if (!enabled || responses.length >= 2) return;
      try {
        const v = read(), content = v.content;
        const item: DiagnosticResponse = {
          attempt: Math.max(0, attempts - 1), usageKnown: v.usageKnown === true,
          contentKind: content === null ? 'null' : Array.isArray(content) ? 'array'
            : typeof content === 'string' ? 'string' : typeof content === 'object' ? 'object' : 'other',
          ...(typeof content === 'string' ? { responseTextBytes: Buffer.byteLength(content, 'utf8') } : {}),
        };
        for (const key of ['finishReason', 'reportedModel', 'requestId'] as const) {
          const value = short(v[key]); if (value !== undefined) item[key] = value;
        }
        if (validTokenCount(v.reasoningTokens)) item.reasoningTokens = v.reasoningTokens;
        if (typeof v.providerCostUsd === 'number' && Number.isFinite(v.providerCostUsd) && v.providerCostUsd >= 0)
          item.providerCostUsd = v.providerCostUsd;
        const envelope = diagnosticResponseSchema.shape.envelopeIssue.safeParse(v.envelopeIssue);
        if (envelope.success && envelope.data !== undefined) item.envelopeIssue = envelope.data;
        responses.push(item);
      } catch { /* Bad observer fields cannot alter provider result/error handling. */ }
    },
    /** Records why the SDK call threw, so a failed call says what the provider returned. */
    failure(error: unknown): void {
      if (!enabled) return;
      try { failure = describeFailure(error, Math.max(0, attempts - 1)); }
      catch { /* Hostile errors leave the failure unrecorded. */ }
    },
    snapshot(): StructuredCallDiagnostics | undefined {
      if (!enabled) return undefined;
      const counted = sdkTally !== undefined && sdkTally.count > 0 ? sdkTally.count : null;
      return { version: 1, adapterAttempts: attempts, sdkAttempts: singleSdkAttempt ? attempts : counted,
        responses: responses.map(r => ({ ...r })), ...(failure ? { failure: { ...failure } } : {}) };
    },
  };
}
export type CallDiagnosticsCollector = ReturnType<typeof createCallDiagnostics>;
export function safeDiagnostics(value: unknown): StructuredCallDiagnostics | undefined {
  try { const parsed = diagnosticsSchema.safeParse(value); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}
export function buildWikiCallMetadata(context: WikiCallContext, diagnostics: StructuredCallDiagnostics | undefined,
  usageKnown: boolean, outcome: 'returned' | 'failed', reason?: StructuredCallFailureReason): Record<string, unknown> {
  const safe = safeDiagnostics(diagnostics);
  const metadata = { wiki_call: {
    version: 1, stage: context.stage, target: short(context.target), attempt: context.attempt,
    max_tokens: context.maxTokens, provider: context.configuration.provider,
    reasoning_effort: short(context.configuration.reasoningEffort) ?? null,
    ...(context.configuration.reasoningBudget !== undefined ? { reasoning_budget: context.configuration.reasoningBudget } : {}),
    outcome, usage_known: usageKnown && (!safe || (safe.responses.length === safe.adapterAttempts
      && safe.responses.every(r => r.usageKnown))),
    ...(reason ? { reason } : {}), ...(safe ? { diagnostics: safe } : {}),
  } };
  // Context is internal, but never let an unexpectedly large observer record escape.
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096)
    return { wiki_call: { version: 1, stage: context.stage, outcome, usage_known: usageKnown, diagnostics_omitted: true } };
  return metadata;
}
