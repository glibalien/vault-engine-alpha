import type { LanguageModelUsage } from 'ai';
import type { ModelProvider } from '@vault/settings-registry';

export interface UsageEventArgsInput {
  model: string;
  provider: ModelProvider;
  service: 'chat-web' | 'chat-plugin';
  purpose?: 'conversation' | 'title-generation' | 'viz-interpret' | undefined;
  totalUsage: LanguageModelUsage;
  conversationId?: string | undefined;
  latencyMs?: number | undefined;
  /** The provider's own charge and response id for the call(s), when it reported them. */
  billing?: CallBilling | undefined;
}

/** What a provider reported for its call(s) beyond tokens: the charge it billed (OpenRouter's
 *  `usage.cost`), the response id, and the model the response says served it (where
 *  `openrouter/auto` routed it, #340). Absent means not reported, never zero. */
export interface CallBilling {
  providerCostUsd?: number;
  requestId?: string;
  reportedModel?: string;
}

/** One model call's billing from an AI SDK result or step: OpenRouter's `usage.cost` from its
 *  provider metadata, which `@openrouter/ai-sdk-provider` fills for streamed and non-streamed
 *  calls, the response id, and the response's model (`response.modelId`, which that provider
 *  takes from the response's `model`; the AI SDK falls back to the requested id when a
 *  response names none). */
export function callBilling(r: { providerMetadata?: unknown; response?: { id?: unknown; modelId?: unknown } | undefined }): CallBilling {
  const meta = r.providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined;
  const cost = meta?.openrouter?.usage?.cost;
  const id = r.response?.id;
  const model = r.response?.modelId;
  return {
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { providerCostUsd: cost } : {}),
    ...(typeof id === 'string' && id !== '' ? { requestId: id } : {}),
    ...(typeof model === 'string' && model !== '' ? { reportedModel: model } : {}),
  };
}

/** Billing for several calls recorded as one row (a turn's steps, a retried interpretation).
 *  The charge is their sum only when every call reported one: a missing charge would make the
 *  sum an undercount, so the ledger prices the tokens instead. The id is kept only for exactly
 *  one call, since one row can carry only one. The model is kept only when every call named the
 *  same one, as the Curator does: Auto Router may route each step elsewhere. */
export function combineBilling(calls: readonly CallBilling[]): CallBilling {
  const charged = calls.length > 0 && calls.every(c => c.providerCostUsd !== undefined);
  const only = calls.length === 1 ? calls[0]!.requestId : undefined;
  const models = new Set(calls.map(c => c.reportedModel));
  const model = calls.length > 0 && models.size === 1 ? calls[0]!.reportedModel : undefined;
  return {
    ...(charged ? { providerCostUsd: calls.reduce((n, c) => n + c.providerCostUsd!, 0) } : {}),
    ...(only !== undefined ? { requestId: only } : {}),
    ...(model !== undefined ? { reportedModel: model } : {}),
  };
}

/**
 * Map one finished conversation turn (AI-SDK totalUsage) to the engine's
 * record-usage tool arguments, in the ledger's bucket convention where
 * input_tokens EXCLUDES cached reads. Returns null when the provider reported
 * no usage at all (e.g. an aborted stream) so callers skip the report. The
 * chat loop can route to any provider in the model catalog — provider is
 * per-model, not hardcoded.
 *
 * ai@7 replaced the flat `cachedInputTokens` with `inputTokenDetails`, which
 * carries a provider-reported `noCacheTokens` (preferred over subtracting
 * ourselves) and — new — `cacheWriteTokens`. The ledger has always had a
 * cache_write_tokens column and @vault/pricing prices cacheWrite separately,
 * but the pre-v7 usage shape had no field for it, so cache writes were billed
 * at the plain input rate. Absent stays absent: the recorder writes NULL for
 * an omitted bucket, and "not measured" must not become a reported 0.
 */
export function usageEventArgs(i: UsageEventArgsInput): Record<string, unknown> | null {
  const u = i.totalUsage;
  if (u.inputTokens === undefined && u.outputTokens === undefined) return null;
  const details = u.inputTokenDetails;
  const cacheRead = details?.cacheReadTokens ?? 0;
  const cacheWrite = details?.cacheWriteTokens;
  const nonCached = details?.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cacheRead);
  return {
    provider: i.provider,
    service: i.service,
    purpose: i.purpose ?? 'conversation',
    model: i.model,
    input_tokens: nonCached,
    output_tokens: u.outputTokens ?? 0,
    cache_read_tokens: cacheRead,
    ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
    ...(i.conversationId !== undefined ? { conversation_id: i.conversationId } : {}),
    ...(i.latencyMs !== undefined ? { latency_ms: Math.round(i.latencyMs) } : {}),
    ...(i.billing?.providerCostUsd !== undefined ? { provider_cost_usd: i.billing.providerCostUsd } : {}),
    ...(i.billing?.requestId !== undefined ? { request_id: i.billing.requestId } : {}),
    ...(i.billing?.reportedModel !== undefined ? { reported_model: i.billing.reportedModel } : {}),
  };
}
