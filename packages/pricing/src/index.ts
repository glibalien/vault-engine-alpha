// @vault/pricing — the one rate table for every paid third-party call in the
// suite. LLM rows are USD per million tokens; audio rows are USD per audio
// minute (batch/pre-recorded rate). Editable — these are list prices and may
// change. Authoritative sources: the Anthropic Console for claude-* rows
// (cacheWrite is the 5-minute write rate); fireworks.ai/pricing +
// docs.fireworks.ai/serverless/pricing for Fireworks rows;
// ai.google.dev/gemini-api/docs/pricing for gemini rows;
// developers.openai.com/api/docs/pricing for gpt-* rows;
// deepgram.com/pricing for audio rows.

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Fireworks serverless (OpenAI-compat provider), July 2026 list prices.
  // cacheWrite mirrors the input rate as a guard — the curator adapter always
  // reports cacheWrite 0 (no write surcharge exists on that API).
  'accounts/fireworks/models/qwen3p7-plus': { input: 0.4, output: 1.6, cacheWrite: 0.4, cacheRead: 0.08 },
  'accounts/fireworks/models/kimi-k2p5': { input: 0.6, output: 3, cacheWrite: 0.6, cacheRead: 0.1 },
  'accounts/fireworks/models/kimi-k2p6': { input: 0.95, output: 4, cacheWrite: 0.95, cacheRead: 0.16 },
  'accounts/fireworks/models/deepseek-v4-pro': { input: 1.74, output: 3.48, cacheWrite: 1.74, cacheRead: 0.145 },
  'accounts/fireworks/models/gpt-oss-120b': { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.015 },
  'accounts/fireworks/models/minimax-m3': { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.06 },
  // Kimi K3 is a 2.8T-param flagship, NOT a cheap tier: 7.5x Qwen input,
  // 9.4x Qwen output. Verified against docs.fireworks.ai/serverless/pricing
  // 2026-08-01 (standard serving path; Fast/Priority/US variants cost more
  // and are separate model ids we do not carry).
  'accounts/fireworks/models/kimi-k3': { input: 3, output: 15, cacheWrite: 3, cacheRead: 0.3 },
  // OpenRouter, verified live via discover-models 2026-08-01. Note GLM 5.2 is
  // also served by Fireworks at $1.40/$4.40 — the catalog entry points at
  // OpenRouter, which is cheaper, so these are the rates that apply.
  'z-ai/glm-5.2': { input: 0.7168, output: 2.2528, cacheWrite: 0.7168, cacheRead: 0.13312 },
  'xiaomi/mimo-v2.5-pro': { input: 0.435, output: 0.87, cacheWrite: 0.435, cacheRead: 0.0036 },
  // Genuine cheap-tier candidates: ~0.35x Qwen input, ~0.18x Qwen output —
  // cheaper on output than gpt-oss-120b ($0.60). Both verified 2026-08-01.
  // -0731 is the official DeepSeek V4 Flash release (the unsuffixed id is the
  // superseded preview); same price, "substantially enhanced agentic
  // capabilities", so it is the one we carry in the catalog.
  'accounts/fireworks/models/deepseek-v4-flash': { input: 0.14, output: 0.28, cacheWrite: 0.14, cacheRead: 0.028 },
  'accounts/fireworks/models/deepseek-v4-flash-0731': { input: 0.14, output: 0.28, cacheWrite: 0.14, cacheRead: 0.028 },
  'xiaomi/mimo-v2.5': { input: 0.14, output: 0.28, cacheWrite: 0.14, cacheRead: 0.0028 },
  // Google Gemini API, July 2026 list prices (cacheRead = cached-input rate).
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheWrite: 0.3, cacheRead: 0.03 },
  // OpenAI API standard tier, verified at developers.openai.com/api/docs/pricing
  // and the model pages 2026-10-31. These are the ≤272K-input-token rates; above
  // that OpenAI charges about 2x input and 1.5x output, which Curator's calls
  // never reach. OpenAI caches long prompts automatically and bills each cache
  // write at 1.25x input (30-minute retention); usage reports them as
  // prompt_tokens_details.cache_write_tokens. GPT-5.6 Sol is left out while its
  // pricing is promotional.
  'gpt-6.1-terra': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.05 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 },
};

/** USD per audio MINUTE (batch/pre-recorded), matched by substring of the model id. */
const AUDIO_PRICING: Record<string, number> = {
  'nova-3': 0.0043,
};

/** Models with no rate of their own, because the provider prices each call by the model it
 *  routes to: OpenRouter's Auto Router. A call to one is priced from the provider's reported
 *  charge, or the Engine estimates it from recent charged calls; a price row for it could never
 *  be right (#340). */
const PROVIDER_PRICED_MODELS: ReadonlySet<string> = new Set(['openrouter/auto']);

export function isProviderPricedModel(model: string): boolean {
  return PROVIDER_PRICED_MODELS.has(model);
}

/** Exact static row only: suitable for discovery, where family guesses are unsafe. */
export function pricingForExact(model: string): ModelPricing | null {
  return Object.hasOwn(PRICING, model) ? { ...PRICING[model]! } : null;
}

/** Resolve pricing by exact id, else by model family in the id, else null. */
export function pricingFor(model: string): ModelPricing | null {
  if (PRICING[model]) return PRICING[model];
  if (model.includes('opus')) return PRICING['claude-opus-4-8'] ?? null;
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5'] ?? null;
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-6'] ?? null;
  if (model.includes('deepseek')) return PRICING['accounts/fireworks/models/deepseek-v4-pro'] ?? null;
  if (model.includes('gemini') && model.includes('flash')) return PRICING['gemini-2.5-flash'] ?? null;
  return null;
}

/** Frontmatter-first chain: entry pricing → static table → null. Missing cache
 *  rates default to the input rate (no-surcharge/no-discount guard). */
export function resolvePricing(
  model: string,
  entryPricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): ModelPricing | null {
  if (entryPricing) {
    return {
      input: entryPricing.input,
      output: entryPricing.output,
      cacheWrite: entryPricing.cacheWrite ?? entryPricing.input,
      cacheRead: entryPricing.cacheRead ?? entryPricing.input,
    };
  }
  return pricingFor(model);
}

/** Estimated USD for one call given an already-resolved ModelPricing. */
export function estimateCostUsdWith(pricing: ModelPricing, usage: TokenUsage): number {
  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheWrite * pricing.cacheWrite +
      usage.cacheRead * pricing.cacheRead) /
    1_000_000
  );
}

/** Estimated USD for one call. Returns null when the model's pricing is unknown. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const p = pricingFor(model);
  if (!p) return null;
  return estimateCostUsdWith(p, usage);
}

/** USD per audio minute for a transcription model id, else null. */
export function audioPricingFor(model: string): number | null {
  const key = Object.keys(AUDIO_PRICING).find((k) => model.includes(k));
  const rate = key !== undefined ? AUDIO_PRICING[key] : undefined;
  return rate ?? null;
}

/** Estimated USD for one transcription call. Null when the model is unknown. */
export function audioCostUsd(model: string, seconds: number): number | null {
  const perMinute = audioPricingFor(model);
  if (perMinute === null) return null;
  return (seconds / 60) * perMinute;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function formatUsage(usage: TokenUsage, costUsd: number | null): string {
  const cost = costUsd === null ? 'est cost n/a (unknown model)' : `est $${costUsd.toFixed(4)}`;
  return `in ${usage.input} · out ${usage.output} · cache_w ${usage.cacheWrite} · cache_r ${usage.cacheRead} → ${cost}`;
}
