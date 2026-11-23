import { createCallDiagnostics, validTokenCount, type CallDiagnosticsCollector } from './diagnostics.js';
import { countSdkAttempts, type SdkAttemptTally } from './sdk-attempts.js';
import type OpenAI from 'openai';
import { openAiCompatUsage, reportsCacheWrites, type OpenAiCompatProvider } from '@vault/llm';
import { PROVIDERS } from '@vault/settings-registry';
import { addUsage, ZERO_USAGE } from '../pricing.js';
import type { TokenUsage } from '../types.js';
import {
  capturePreparedRequest,
  immutablePreparedCapture,
  StructuredCallFailure,
  projectFailClosedFailure,
  supportsReasoningBudget,
  systemWithStructuredOutputSchema,
} from './types.js';
import type { LlmClient, LlmConfiguration, StructuredCallRequest, StructuredCallResult } from './types.js';
import { pageEnvelopeIssue, parsePageMarkdownOutput, systemWithPageMarkdownOutput } from './page-markdown-output.js';

function adapterVersion(req: StructuredCallRequest): string {
  return req.openAiResponseFormat === 'page-markdown' ? 'openai-compat-page-markdown-v1' : 'openai-compat-v1';
}

/** Constrained decoding guarantees shape, not that the model saw the field
 *  semantics (per-property descriptions), so embed the schema in the system
 *  text. Deterministic per call type — the provider's prefix-matched prompt
 *  cache stays warm. */
function safeFinishReason(value: unknown): string {
  return value === 'stop'
    || value === 'length'
    || value === 'tool_calls'
    || value === 'content_filter'
    || value === 'function_call'
    ? value
    : 'unknown';
}

function parseResponseContent(content: string, promptOnly: boolean): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    // Prompt-only models can wrap otherwise valid JSON in one Markdown fence.
    // Remove only that complete outer wrapper; parsing and caller validation
    // still reject malformed JSON, extra prose, and invalid page payloads.
    const fenced = promptOnly ? /^```json[ \t]*\r?\n([\s\S]*)\r?\n {0,3}```$/i.exec(content.trim()) : null;
    if (!fenced) throw error;
    return JSON.parse(fenced[1]!) as unknown;
  }
}

function redactedOutputFailure(
  reason: 'no_choices' | 'truncated' | 'content_filtered' | 'invalid_content_type' | 'empty_content' | 'malformed_json' | 'invalid_page_envelope' | 'refused',
  finishReason: unknown,
  usage?: TokenUsage,
): StructuredCallFailure {
  return new StructuredCallFailure(
    'structured output rejected '
    + `(reason=${reason}; finish_reason=${safeFinishReason(finishReason)})`,
    usage,
    reason,
  );
}

const PROVIDER_REASON_MAX_CHARS = 300;

/** The upstream message inside OpenRouter's `metadata.raw`, which is usually the
 *  provider's own JSON error body and sometimes plain text. */
function upstreamMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown } | null;
    const message = body?.error?.message ?? body?.message;
    if (typeof message === 'string') return message;
  } catch { /* plain text */ }
  return raw;
}

/** One server-log line saying why the provider rejected an HTTP request. The SDK
 *  message keeps only OpenRouter's wrapper text ("400 Provider returned error");
 *  the upstream reason is in `error.metadata.raw`. Only the status, provider name
 *  and a capped reason are read — never other metadata, which can quote the
 *  input. The thrown error is unchanged, so the reason stays out of anything a
 *  caller persists. Undefined for non-HTTP failures. */
export function providerRejectionSummary(error: unknown): string | undefined {
  try {
    const e = error as { status?: unknown; message?: unknown;
      error?: { message?: unknown; metadata?: { provider_name?: unknown; raw?: unknown } } } | null;
    if (typeof e?.status !== 'number') return undefined;
    const raw = e.error?.metadata?.raw;
    const reason = typeof raw === 'string' ? upstreamMessage(raw)
      : raw !== undefined ? JSON.stringify(raw)
        : typeof e.error?.message === 'string' ? e.error.message
          : typeof e.message === 'string' ? e.message : '';
    const text = String(reason).replace(/\s+/g, ' ').trim();
    const capped = text.length > PROVIDER_REASON_MAX_CHARS ? `${text.slice(0, PROVIDER_REASON_MAX_CHARS)}…` : text;
    const provider = typeof e.error?.metadata?.provider_name === 'string' ? ` from ${e.error.metadata.provider_name}` : '';
    return `HTTP ${e.status}${provider}: ${capped || '(no reason given)'}`;
  } catch {
    return undefined;
  }
}

/** Generic OpenAI-compatible chat-completions adapter; Fireworks serverless is
 *  the tested target. Structured output via response_format json_schema
 *  (constrained decoding on Fireworks). Non-streaming on purpose — streaming +
 *  structured output is the known-flaky path and nothing here streams. */
export interface OpenAiCompatOptions {
  provider?: OpenAiCompatProvider;
  /** Passed through as `reasoning_effort` when set. Kimi K2.6 on Fireworks runs
   *  thinking by default and bills reasoning as completion tokens (measured:
   *  369 completion tokens for a one-word answer); "none" disables it. Omitted
   *  from the request entirely when unset, so hosts that reject the param or
   *  its extended values are unaffected. */
  reasoningEffort?: string;
  /** Sent as `reasoning: { max_tokens }` when set: the most tokens the model may spend
   *  reasoning, inside `maxTokens`. OpenRouter only, and never with `reasoningEffort`,
   *  because OpenRouter takes one or the other. Anything else is refused, not dropped. */
  reasoningBudget?: number;
  /** Gate for two Fireworks-specific request extensions: the sticky `user`
   *  replica-affinity hint and `context_length_exceeded_behavior: 'error'`.
   *  Default `true` (Fireworks is the original, tested target). Set `false`
   *  for other OpenAI-compatible hosts (e.g. OpenRouter) that don't share
   *  Fireworks's replica-local prompt cache and may reject the unknown
   *  `context_length_exceeded_behavior` field outright. */
  fireworksExtensions?: boolean;
}

/** The provider an adapter serves. Legacy options without `provider` mean
 *  Fireworks, or OpenRouter when the Fireworks extensions are switched off. */
function providerOf(opts: OpenAiCompatOptions): OpenAiCompatProvider {
  return opts.provider ?? (opts.fireworksExtensions === false ? 'openrouter' : 'fireworks');
}

/** Refuses a reasoning budget the provider can't honor, one set beside an effort, or (given
 *  the request's cap) one that leaves the answer no room. A no-op without a budget. */
function assertReasoningBudget(opts: OpenAiCompatOptions, maxTokens?: number): void {
  const budget = opts.reasoningBudget;
  if (budget === undefined) return;
  const provider = providerOf(opts);
  if (!supportsReasoningBudget(provider)) {
    throw new Error(`REASONING_BUDGET_UNSUPPORTED: ${provider} requests can't carry a reasoning budget`);
  }
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('REASONING_BUDGET_INVALID: not a positive integer');
  if (opts.reasoningEffort !== undefined) {
    throw new Error('REASONING_BUDGET_INVALID: a reasoning budget and a reasoning effort can\'t be sent together');
  }
  if (maxTokens !== undefined && budget >= maxTokens) {
    throw new Error(`REASONING_BUDGET_TOO_LARGE: a reasoning budget of ${budget} leaves no room under max_tokens ${maxTokens}`);
  }
}

export function buildOpenAiCompatParams(
  req: StructuredCallRequest,
  opts: OpenAiCompatOptions = {},
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  assertReasoningBudget(opts, req.maxTokens);
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: req.model,
    // OpenAI's reasoning models take max_completion_tokens; the others max_tokens.
    [PROVIDERS[providerOf(opts)].maxTokensField]: req.maxTokens,
    messages: [
      { role: 'system', content: req.openAiResponseFormat === 'page-markdown' ? systemWithPageMarkdownOutput(req) : systemWithStructuredOutputSchema(req) },
      { role: 'user', content: req.user },
    ],
  };
  if (req.openAiResponseFormat === undefined || req.openAiResponseFormat === 'json_schema') {
    params.response_format = {
      type: 'json_schema',
      json_schema: { name: req.toolName, schema: req.schema },
    };
  }
  if (opts.fireworksExtensions !== false) {
    // Sticky-routing hint: serverless prompt caches are replica-local, so a
    // stable session id is what makes automatic caching hit across a sweep.
    // Deliberately the legacy `user` field, NOT prompt_cache_key — Fireworks
    // keys replica affinity off `user`; do not "modernize" this.
    params.user = 'vault-curator';
    // Fireworks defaults to silently shrinking max_tokens on context overflow;
    // require a loud error. Other compatible hosts opt out of the extensions.
    // @ts-expect-error -- Fireworks extension outside openai-node's types
    params.context_length_exceeded_behavior = 'error';
  }
  if (opts.reasoningEffort !== undefined) {
    // Fireworks accepts extended values ("none") outside the SDK's union.
    (params as unknown as Record<string, unknown>).reasoning_effort = opts.reasoningEffort;
  }
  if (opts.reasoningBudget !== undefined) {
    // OpenRouter's unified reasoning control; it maps max_tokens onto the model's own budget.
    (params as unknown as Record<string, unknown>).reasoning = { max_tokens: opts.reasoningBudget };
  }
  return params;
}

export function openAiCompatProviderPayloadChars(
  req: StructuredCallRequest,
  opts: OpenAiCompatOptions = {},
): number {
  return openAiCompatParamsChars(buildOpenAiCompatParams(req, opts));
}

export function openAiCompatParamsChars(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
): number {
  const serialized = JSON.stringify(params);
  if (serialized === undefined) throw new Error('provider request could not be serialized');
  return serialized.length;
}

export class OpenAiCompatLlmClient implements LlmClient {
  readonly supportsPreparedCapture = true as const;
  constructor(private readonly client: OpenAI, private readonly opts: OpenAiCompatOptions = {}) {
    this.opts = { ...opts };
    assertReasoningBudget(this.opts);
  }

  configurationFor(_model: string): LlmConfiguration {
    return { provider: providerOf(this.opts),
      reasoningEffort: this.opts.reasoningEffort ?? null,
      ...(this.opts.reasoningBudget !== undefined ? { reasoningBudget: this.opts.reasoningBudget } : {}) };
  }

  withConfiguration(configuration: LlmConfiguration): LlmClient {
    if (configuration.provider !== this.configurationFor('').provider) throw new Error('REQUEST_PROVIDER_MISMATCH');
    return new OpenAiCompatLlmClient(this.client, { ...this.opts, reasoningEffort: configuration.reasoningEffort ?? undefined,
      reasoningBudget: configuration.reasoningBudget });
  }

  async previewStructuredCall(req: StructuredCallRequest) {
    return immutablePreparedCapture(providerOf(this.opts),
      req.model, adapterVersion(req), buildOpenAiCompatParams(req, this.opts));
  }

  async structuredCall(req: StructuredCallRequest): Promise<StructuredCallResult> {
    const sdkTally: SdkAttemptTally = { count: 0 };
    const diagnostics = createCallDiagnostics(true,
      req.openAiResponseFormat === 'page-markdown' || req.onPrepared !== undefined || req.malformedOutputPolicy === 'fail-closed-redacted',
      sdkTally);
    try {
      const result = await countSdkAttempts(sdkTally, () => this.executeCall(req, diagnostics));
      const snapshot = diagnostics.snapshot();
      return snapshot ? { ...result, diagnostics: snapshot } : result;
    } catch (error) {
      try { if (error instanceof StructuredCallFailure) error.diagnostics = diagnostics.snapshot(); } catch { /* observer only */ }
      throw error;
    }
  }

  private async executeCall(req: StructuredCallRequest, diagnostics: CallDiagnosticsCollector): Promise<StructuredCallResult> {
    const pageMarkdown = req.openAiResponseFormat === 'page-markdown';
    const failClosed = pageMarkdown || req.onPrepared !== undefined || req.malformedOutputPolicy === 'fail-closed-redacted';
    let params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    try {
      // Checked before the size guard below, so a bad budget is never reported as a large prompt.
      assertReasoningBudget(this.opts, req.maxTokens);
    } catch (error) {
      throw failClosed ? projectFailClosedFailure(error, 'provider_dispatch_failed') : error;
    }
    try {
      params = buildOpenAiCompatParams(req, this.opts);
      if (req.providerPromptCharCap !== undefined
        && openAiCompatParamsChars(params) > req.providerPromptCharCap) {
        throw new StructuredCallFailure(
          'structured call failed (reason=provider_prompt_too_large)',
          undefined,
          'provider_prompt_too_large',
        );
      }
    } catch (error) {
      if (failClosed) throw projectFailClosedFailure(error, 'provider_prompt_too_large');
      if (error instanceof StructuredCallFailure && error.reason === 'provider_prompt_too_large') {
        throw new Error(`structured provider prompt exceeds ${req.providerPromptCharCap} characters`);
      }
      throw error;
    }
    params = await capturePreparedRequest(params, req, providerOf(this.opts), adapterVersion(req));
    let usage = ZERO_USAGE;
    let usageKnown = false;
    let lastSample = '';
    // The shared default keeps one bounded application retry. Privacy/cap-
    // sensitive callers use one SDK call with transport retries disabled and
    // fail without retaining model content.
    const attempts = failClosed ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && req.beforeRetry) {
        try {
          await req.beforeRetry();
        } catch (error) {
          // A refused retry ends the call; the first attempt's usage still settles.
          throw new StructuredCallFailure(`structured call retry not admitted (model ${req.model})`,
            usageKnown ? usage : undefined, undefined, undefined, { cause: error });
        }
      }
      assertProviderRequestBytes(params, req.providerRequestMaxBytes);
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        diagnostics.start();
        completion = failClosed
          ? await this.client.chat.completions.create(params, { maxRetries: 0 })
          : await this.client.chat.completions.create(params);
      } catch (error) {
        diagnostics.failure(error);
        const rejection = providerRejectionSummary(error);
        if (rejection) console.warn(`[curator] ${req.toolName} provider error (model ${req.model}): ${rejection}`);
        // A transport failure has no usage of its own. When an earlier
        // application attempt returned reported usage, preserve only that
        // accumulated accounting in a bounded failure. Before any response,
        // retain the provider error identity for legacy caller compatibility.
        if (!usageKnown) {
          throw failClosed
            ? projectFailClosedFailure(error, 'provider_transport_failed')
            : error;
        }
        throw new StructuredCallFailure(
          'structured call transport failed after a usage-bearing response',
          usage,
        );
      }
      let reportedUsageKnown = false;
      {
        try {
          const u = completion?.usage;
          const writes = (u?.prompt_tokens_details as { cache_write_tokens?: unknown } | undefined)?.cache_write_tokens;
          reportedUsageKnown = !!u && validTokenCount(u.prompt_tokens) && validTokenCount(u.completion_tokens)
            && (u.prompt_tokens_details?.cached_tokens == null || validTokenCount(u.prompt_tokens_details.cached_tokens))
            && (!reportsCacheWrites(this.configurationFor(req.model).provider) || writes == null || validTokenCount(writes));
        } catch { reportedUsageKnown = false; }
      }
      diagnostics.response(() => ({ content: completion?.choices?.[0]?.message?.content,
        ...(pageMarkdown && typeof completion?.choices?.[0]?.message?.content === 'string'
          ? { envelopeIssue: pageEnvelopeIssue(completion.choices[0].message.content) } : {}),
        finishReason: completion?.choices?.[0]?.finish_reason, reportedModel: completion?.model, requestId: completion?.id,
        providerCostUsd: this.configurationFor(req.model).provider === 'openrouter'
          ? (completion?.usage as { cost?: unknown } | undefined)?.cost : undefined,
        reasoningTokens: completion?.usage?.completion_tokens_details?.reasoning_tokens, usageKnown: reportedUsageKnown }));
      if (failClosed && (completion === null || typeof completion !== 'object' || Array.isArray(completion))) {
        throw redactedOutputFailure('invalid_content_type', undefined);
      }
      if (reportedUsageKnown) usage = addUsage(usage, openAiCompatUsage(completion.usage, this.configurationFor(req.model).provider));
      usageKnown ||= reportedUsageKnown;
      const failureUsage = usageKnown ? usage : undefined;
      if (failClosed && !Array.isArray(completion.choices)) {
        throw redactedOutputFailure('invalid_content_type', undefined, failureUsage);
      }
      const choice = completion.choices[0];
      if (!choice) {
        if (failClosed && completion.choices.length > 0) {
          throw redactedOutputFailure('invalid_content_type', undefined, failureUsage);
        }
        if (failClosed) {
          throw redactedOutputFailure('no_choices', undefined, failureUsage);
        }
        throw new StructuredCallFailure(
          `synthesis returned no choices (model ${req.model})`,
          failureUsage,
        );
      }
      if (failClosed && (choice.message === null || typeof choice.message !== 'object' || Array.isArray(choice.message))) {
        throw redactedOutputFailure('invalid_content_type', choice.finish_reason, failureUsage);
      }
      if (choice.finish_reason === 'length') {
        if (failClosed) {
          throw redactedOutputFailure('truncated', choice.finish_reason, failureUsage);
        }
        throw new StructuredCallFailure(
          `synthesis output truncated at ${req.maxTokens} tokens (model ${req.model}) — raise max_tokens`,
          failureUsage,
        );
      }
      if (choice.finish_reason === 'content_filter') {
        throw redactedOutputFailure('content_filtered', choice.finish_reason, failureUsage);
      }
      if (pageMarkdown && choice.message.refusal != null && choice.message.refusal !== '') {
        throw redactedOutputFailure('refused', choice.finish_reason, failureUsage);
      }
      if (pageMarkdown && choice.finish_reason !== 'stop') {
        throw redactedOutputFailure('invalid_page_envelope', choice.finish_reason, failureUsage);
      }
      const content = choice.message.content;
      if (failClosed && typeof content !== 'string') {
        throw redactedOutputFailure(
          'invalid_content_type',
          choice.finish_reason,
          failureUsage,
        );
      }
      if (content) {
        try {
          return { output: pageMarkdown ? parsePageMarkdownOutput(content) : parseResponseContent(content, req.openAiResponseFormat === 'prompt-only'), usage, ...(usageKnown ? {} : { usageKnown: false }) };
        } catch {
          if (failClosed) {
            throw redactedOutputFailure(
              pageMarkdown ? 'invalid_page_envelope' : 'malformed_json',
              choice.finish_reason,
              failureUsage,
            );
          }
          lastSample = content.slice(0, 200);
        }
      } else {
        if (failClosed) {
          throw redactedOutputFailure(
            'empty_content',
            choice.finish_reason,
            failureUsage,
          );
        }
        lastSample = `(empty content, finish_reason=${choice.finish_reason})`;
      }
      console.warn(`[curator] ${req.toolName} attempt ${attempt + 1} returned unparseable output (model ${req.model}); ${attempt === 0 ? 'retrying once' : 'giving up'}: ${lastSample}`);
    }
    throw new StructuredCallFailure(
      `synthesis returned unparseable JSON after retry (model ${req.model}): ${lastSample}`,
      usageKnown ? usage : undefined,
    );
  }
}
import { assertProviderRequestBytes } from './request-budget.js';
