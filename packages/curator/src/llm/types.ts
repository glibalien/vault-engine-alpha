import { safeDiagnostics } from './diagnostics.js';
import type { StructuredCallDiagnostics } from './diagnostics.js';
import type { Json } from '../provenance-types.js';
import type { TokenUsage } from '../types.js';
import type { ModelProvider } from '@vault/settings-registry';

/** Provider-portable JSON Schema (draft-2020-12 subset: type/properties/required/
 *  enum/items/description — no oneOf/pattern/minLength, which Fireworks'
 *  constrained decoding does not support). */
export type JsonSchema = Record<string, unknown>;

/** The default preserves the shared adapter's historical retry and raw-error
 *  behavior. Privacy- or paid-request-cap-sensitive callers opt into one
 *  attempt plus closed diagnostics for dispatch, transport, and output errors. */
export type MalformedOutputPolicy =
  | 'retry-once-with-content-sample'
  | 'fail-closed-redacted';

export type StructuredCallFailureReason =
  | 'provenance_capture_failed'
  | 'provider_dispatch_failed'
  | 'provider_transport_failed'
  | 'provider_call_failed'
  | 'provider_prompt_too_large'
  | 'missing_tool_use'
  | 'invalid_tool_use_count'
  | 'no_choices'
  | 'truncated'
  | 'content_filtered'
  | 'invalid_content_type'
  | 'empty_content'
  | 'invalid_page_envelope'
  | 'refused'
  | 'malformed_json';

export interface PreparedCapture {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly adapter_version: string;
  readonly payload: Json;
}

export type WikiCallStage = 'planner' | 'adjudicator' | 'page' | 'home';
export interface WikiCallContext {
  stage: WikiCallStage; target?: string; attempt: number; policyVersion: 1;
  maxTokens: number; configuration: LlmConfiguration;
}

export interface StructuredCallRequest {
  /** Internal observer context, never serialized into provider requests. */
  wikiContext?: WikiCallContext;
  /** Awaited before dispatch; rejection prevents the SDK call. */
  onPrepared?: (capture: PreparedCapture) => Promise<void>;
  model: string;
  maxTokens: number;
  /** Static instructions — placed first for prompt-cache prefix matching on every provider. */
  system: string;
  /** The variable evidence block. */
  user: string;
  /** Schema/tool name, e.g. 'emit_wiki_sections' (^[a-zA-Z0-9_-]+$ for OpenAI compat). */
  toolName: string;
  toolDescription: string;
  schema: JsonSchema;
  /** OpenAI-compatible APIs default to json_schema. Prompt-only omits the API
   *  response_format while retaining schema instructions and JSON parsing.
   *  Page-markdown uses a versioned raw Markdown envelope, normalized to
   *  {body, log_note}, with one attempt and redacted failures.
   *  Native Anthropic tool calls are unaffected; callers still validate output. */
  openAiResponseFormat?: 'json_schema' | 'prompt-only' | 'page-markdown';
  malformedOutputPolicy?: MalformedOutputPolicy;
  /** Optional hard cap over the serialized provider-bound prompt payload,
   *  including messages, system instructions, tools, and schema. */
  providerPromptCharCap?: number;
  /** Complete serialized provider parameters, measured in UTF-8 bytes. */
  providerRequestMaxBytes?: number;
  /** Awaited before an adapter retry dispatches; rejection ends the call with the usage so far.
   *  The daily budget admits each retry here instead of holding it up front. */
  beforeRetry?: () => Promise<void>;
}

export interface StructuredCallResult {
  diagnostics?: StructuredCallDiagnostics;
  /** false when the provider omitted usage; legacy callers retain numeric totals. */
  usageKnown?: boolean;
  /** Parsed JSON output. Callers validate (validateSections). */
  output: unknown;
  usage: TokenUsage;
}

/** A structured call failed before or after a provider response. `usage` is
 *  present only when billing metadata is known. Fail-closed callers use closed
 *  reason codes without raw output or dynamic identifiers; legacy-compatible
 *  messages may retain their historical diagnostics. */
export class StructuredCallFailure extends Error {
  readonly usage: TokenUsage | undefined;
  readonly reason: StructuredCallFailureReason | undefined;

  constructor(
    message: string,
    usage?: TokenUsage,
    reason?: StructuredCallFailureReason,
    public diagnostics?: StructuredCallDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StructuredCallFailure';
    this.usage = usage;
    this.reason = reason;
  }
}

function usageFrom(error: unknown): TokenUsage | undefined {
  try {
    if (error === null || typeof error !== 'object' || !Object.hasOwn(error, 'usage')) return undefined;
    const usage = (error as { usage?: unknown }).usage;
    if (usage === null || typeof usage !== 'object') return undefined;
    const record = usage as Record<string, unknown>;
    if (!['input', 'output', 'cacheWrite', 'cacheRead'].every(key =>
      typeof record[key] === 'number' && Number.isFinite(record[key]) && (record[key] as number) >= 0)) {
      return undefined;
    }
    return {
      input: record.input as number,
      output: record.output as number,
      cacheWrite: record.cacheWrite as number,
      cacheRead: record.cacheRead as number,
    };
  } catch {
    return undefined;
  }
}

/** Convert an arbitrary failure at a fail-closed request boundary into a
 *  metadata-only error. Already-projected failures retain identity and known
 *  usage; legacy/unprojected failures retain neither raw message nor stack. */
export function projectFailClosedFailure(
  error: unknown,
  reason: StructuredCallFailureReason,
): StructuredCallFailure {
  let diagnostics: StructuredCallDiagnostics | undefined;
  try {
    if (error instanceof StructuredCallFailure && error.reason !== undefined) return error;
    if (error instanceof StructuredCallFailure) diagnostics = safeDiagnostics(error.diagnostics);
  } catch {
    // Hostile proxy-like errors are projected below without inspecting them.
  }
  return new StructuredCallFailure(
    `structured call failed (reason=${reason})`,
    usageFrom(error),
    reason,
    diagnostics,
  );
}

/** OpenAI-compatible providers append this deterministic suffix to the system
 *  message so models see property semantics as well as constrained decoding. */
export function systemWithStructuredOutputSchema(
  req: Pick<StructuredCallRequest, 'system' | 'toolDescription' | 'schema'>,
): string {
  return `${req.system}\n\n# Output\n${req.toolDescription}\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}`;
}

/** Safe to persist in a durable request; credentials and SDK endpoints stay in bootstrap. */
export interface LlmConfiguration {
  provider: PreparedCapture['provider'];
  /** null freezes the absence of an explicit reasoning override. */
  reasoningEffort: string | null;
  /** Most tokens the model may spend reasoning, sent as `reasoning.max_tokens`. Absent means
   *  no budget, and stays absent from frozen records and policy hashes. Never set together
   *  with `reasoningEffort`: OpenRouter takes one or the other (#429). */
  reasoningBudget?: number;
}

/** Providers whose requests can carry a reasoning budget. OpenRouter maps
 *  `reasoning.max_tokens` onto each model's own thinking budget. Fireworks and OpenAI take
 *  only an effort, and the Anthropic adapter's forced tool call can't run with thinking. */
export function supportsReasoningBudget(provider: LlmConfiguration['provider']): boolean {
  return provider === 'openrouter';
}

export interface LlmClient {
  /** Resolve effective non-secret settings without dispatch or credential access. */
  configurationFor?(model: string): LlmConfiguration;
  /** Rebuild through the existing client seam using current credentials. */
  withConfiguration?(configuration: LlmConfiguration): LlmClient;
  readonly supportsPreparedCapture?: true;
  /** Builds immutable provider parameters without dispatch, capture or usage. */
  previewStructuredCall?(req: StructuredCallRequest): Promise<PreparedCapture>;
  /** Request one JSON object matching `schema`. Throws on failure —
   *  callers (curateProject) already capture every throw into CurateResult. */
  structuredCall(req: StructuredCallRequest): Promise<StructuredCallResult>;
}

/** Independent immutable provider parameters; never includes credentials/headers. */
export function immutablePreparedCapture(provider: PreparedCapture['provider'], model: string,
  adapterVersion: string, params: unknown): PreparedCapture {
  const payload = JSON.parse(JSON.stringify(params)) as Json;
  function freeze(value: Json): void {
    if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(payload);
  return Object.freeze({ provider, model, adapter_version: adapterVersion, payload });
}

/** Capture and send the same immutable parameter object. */
export async function capturePreparedRequest<T>(params: T, req: StructuredCallRequest, provider: PreparedCapture['provider'], adapterVersion: string): Promise<T> {
  if (!req.onPrepared) return params;
  try {
    const prepared = immutablePreparedCapture(provider, req.model, adapterVersion, params);
    await req.onPrepared(prepared);
    return prepared.payload as T;
  } catch {
    throw new StructuredCallFailure('structured call failed (reason=provenance_capture_failed)', undefined, 'provenance_capture_failed');
  }
}
