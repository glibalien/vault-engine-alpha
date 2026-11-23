import type Database from 'better-sqlite3';
import { USAGE_PURPOSES, type UsagePurpose } from '@vault/contract';
import { audioPricingFor, estimateCostUsdWith, isProviderPricedModel, resolvePricing, type TokenUsage } from '@vault/pricing';
import { MODEL_PROVIDERS, type ModelEntryPricing } from '@vault/settings-registry';
import { chargedRate, estimatePricingJson, totalTokens, type ChargedRate } from './provider-priced-estimate.js';

// Single source of truth for the ledger vocabularies. The record-usage MCP tool
// derives its zod enums from these arrays — a purpose added to the union but not
// the tool would make clients' spend reports fail validation and silently drop
// rows (the v1.6 memory-sweep near-miss).
// Every catalog model provider, plus the non-catalog paid services.
export const USAGE_PROVIDERS = [...MODEL_PROVIDERS, 'google', 'deepgram', 'exa'] as const;
export const USAGE_SERVICES = ['chat-web', 'chat-plugin', 'curator', 'engine'] as const;
// The purposes live in @vault/contract, so the services that report spend can't drift from them.
export { USAGE_PURPOSES, type UsagePurpose };
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
export type UsageService = (typeof USAGE_SERVICES)[number];
export type CostBasis = 'computed' | 'provider-reported' | 'unpriced';

export interface UsageEventInput {
  /** ISO 8601 UTC time of the API call. Defaults to now. */
  ts?: string | undefined;
  provider: UsageProvider;
  model?: string | undefined;
  service: UsageService;
  purpose: UsagePurpose;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  audioSeconds?: number | undefined;
  /** Actual account charge from the provider response, never a caller estimate. */
  providerCostUsd?: number | undefined;
  conversationId?: string | undefined;
  runRef?: string | undefined;
  sourceRef?: string | undefined;
  experiment?: string | undefined;
  variant?: string | undefined;
  latencyMs?: number | undefined;
  requestId?: string | undefined;
  /** Fingerprint of the API key that paid, when known (`providerKeyRef`). */
  keyRef?: string | undefined;
  /** The model the provider's response says served the call, when it named one. For
   *  OpenRouter's Auto Router (`openrouter/auto`) it is the model routed to (#340). Stored as
   *  `metadata.reported_model`; it never changes the price. An uncharged call to a model with no
   *  rate of its own is estimated from recent charged calls instead (`chargedRate`). */
  reportedModel?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** A normalized token usage as the recorder's token fields. */
export function usageTokenFields(usage: TokenUsage): Pick<UsageEventInput, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

/** A `complete()` result as the recorder's fields: its tokens, plus the provider's own charge,
 *  response id and serving model when the response carried them. A reported charge wins over the
 *  price table in `priceEvent`, so the call records as `provider-reported`. */
export function completionUsageFields(result: {
  usage: TokenUsage; providerCostUsd?: number | undefined; requestId?: string | undefined; reportedModel?: string | undefined;
}): Pick<UsageEventInput, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'providerCostUsd' | 'requestId' | 'reportedModel'> {
  return {
    ...usageTokenFields(result.usage),
    ...(result.providerCostUsd !== undefined ? { providerCostUsd: result.providerCostUsd } : {}),
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    ...(result.reportedModel !== undefined ? { reportedModel: result.reportedModel } : {}),
  };
}

export interface RecordedUsage {
  id: number;
  costUsd: number;
  costBasis: CostBasis;
}

interface PricedEvent {
  costUsd: number;
  costBasis: CostBasis;
  pricingJson: string | null;
}

/** Cost resolution: provider-reported dollars win; then audio duration × rate
 *  (audio path never consults the catalog — no per-note audio pricing exists);
 *  then token buckets × rate, resolved frontmatter-entry-first then the static
 *  table (`resolvePricing`); then, for a model with no rate of its own
 *  (OpenRouter's Auto Router), every token × the blended rate of recent charged
 *  calls to it (`rate`, #340); else unpriced (cost 0, flagged). */
export function priceEvent(
  e: UsageEventInput,
  catalogPricing?: (model: string) => ModelEntryPricing | null,
  rate?: ChargedRate | null,
): PricedEvent {
  if (e.providerCostUsd !== undefined) {
    return {
      costUsd: e.providerCostUsd,
      costBasis: 'provider-reported',
      pricingJson: JSON.stringify({ provider_reported: true }),
    };
  }
  if (e.audioSeconds !== undefined) {
    const perMinute = e.model !== undefined ? audioPricingFor(e.model) : null;
    if (perMinute === null) return { costUsd: 0, costBasis: 'unpriced', pricingJson: null };
    return {
      costUsd: (e.audioSeconds / 60) * perMinute,
      costBasis: 'computed',
      pricingJson: JSON.stringify({ usd_per_audio_minute: perMinute }),
    };
  }
  const usage: TokenUsage = {
    input: e.inputTokens ?? 0,
    output: e.outputTokens ?? 0,
    cacheWrite: e.cacheWriteTokens ?? 0,
    cacheRead: e.cacheReadTokens ?? 0,
  };
  const entryPricing = e.model !== undefined ? (catalogPricing?.(e.model) ?? undefined) : undefined;
  const pricing = e.model !== undefined ? resolvePricing(e.model, entryPricing) : null;
  if (pricing !== null && e.model !== undefined) {
    return { costUsd: estimateCostUsdWith(pricing, usage), costBasis: 'computed', pricingJson: JSON.stringify(pricing) };
  }
  const tokens = totalTokens(e);
  if (rate && e.model !== undefined && isProviderPricedModel(e.model) && tokens > 0) {
    return { costUsd: (tokens * rate.usdPerMillionTokens) / 1_000_000, costBasis: 'computed', pricingJson: estimatePricingJson(rate) };
  }
  return { costUsd: 0, costBasis: 'unpriced', pricingJson: null };
}

/** The charged-call rate an uncharged provider-priced call is estimated from; null when the
 *  call doesn't need one or the ledger can't give one. Never throws: recording must not fail. */
function estimateRateFor(db: Database.Database, e: UsageEventInput): ChargedRate | null {
  if (e.model === undefined || !isProviderPricedModel(e.model) || e.providerCostUsd !== undefined
    || e.audioSeconds !== undefined || totalTokens(e) <= 0) return null;
  try {
    return chargedRate(db, e.model);
  } catch (err) {
    console.warn(`[usage] no charged-call rate for ${e.model}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The row's metadata, with the serving model under `reported_model`. */
function metadataJson(e: UsageEventInput): string | null {
  const metadata = e.reportedModel !== undefined ? { ...e.metadata, reported_model: e.reportedModel } : e.metadata;
  return metadata !== undefined ? JSON.stringify(metadata) : null;
}

/** Writes usage_events rows. One instance per process, constructed in index.ts. */
export class UsageRecorder {
  /** Post-insert observer (usage CSV reports). Invoked after every successful
   *  insert; failures are swallowed — a broken observer must never fail the
   *  paid call being recorded. */
  onRecorded: (() => void) | undefined;

  /** Late-bound frontmatter-pricing source (Settings/Models/ catalog entries);
   *  consulted before the static table. Unset in stdio/test contexts — priceEvent
   *  falls back to the static table exactly as before wiring this in. */
  private catalogPricing: ((model: string) => ModelEntryPricing | null) | undefined;

  /** The Engine's own key per provider. Its in-process calls are paid with it, whichever
   *  service caused them: memory consolidation is recorded as the Curator's (#345). */
  private readonly ownKeyRefs = new Map<UsageProvider, string>();

  constructor(private readonly db: Database.Database) {}

  /** Wire a late-bound catalog-pricing lookup (called once from index.ts after
   *  ModelCatalog is constructed). Never required — omitting it preserves the
   *  pre-catalog table-only pricing chain byte-for-byte. */
  setCatalogPricing(fn: (model: string) => ModelEntryPricing | null): void {
    this.catalogPricing = fn;
  }

  setOwnKeyRef(provider: UsageProvider, keyRef: string): void {
    this.ownKeyRefs.set(provider, keyRef);
  }

  /** Compute cost + insert. Throws on DB failure — the record-usage tool path. */
  recordOrThrow(e: UsageEventInput): RecordedUsage {
    const priced = priceEvent(e, this.catalogPricing, estimateRateFor(this.db, e));
    const info = this.db.prepare(`
      INSERT INTO usage_events (
        ts, provider, model, service, purpose,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, audio_seconds,
        cost_usd, cost_basis, pricing_json,
        conversation_id, run_ref, source_ref, experiment, variant,
        latency_ms, request_id, metadata_json, key_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.ts ?? new Date().toISOString(),
      e.provider,
      e.model ?? null,
      e.service,
      e.purpose,
      e.inputTokens ?? null,
      e.outputTokens ?? null,
      e.cacheReadTokens ?? null,
      e.cacheWriteTokens ?? null,
      e.audioSeconds ?? null,
      priced.costUsd,
      priced.costBasis,
      priced.pricingJson,
      e.conversationId ?? null,
      e.runRef ?? null,
      e.sourceRef ?? null,
      e.experiment ?? null,
      e.variant ?? null,
      e.latencyMs ?? null,
      e.requestId ?? null,
      metadataJson(e),
      e.keyRef ?? null,
    );
    const recorded: RecordedUsage = {
      id: Number(info.lastInsertRowid), costUsd: priced.costUsd, costBasis: priced.costBasis,
    };
    try {
      this.onRecorded?.();
    } catch (err) {
      console.warn(`[usage] onRecorded observer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return recorded;
  }

  /** Best-effort: the in-process capture path. The ledger is an observer —
   *  a failed insert logs a warning and never fails the paid call it observed.
   *  Returns what was recorded, or null when nothing was. */
  record(e: UsageEventInput): RecordedUsage | null {
    try {
      return this.recordOrThrow({ ...e, keyRef: e.keyRef ?? this.ownKeyRefs.get(e.provider) });
    } catch (err) {
      console.warn(`[usage] event not recorded: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
