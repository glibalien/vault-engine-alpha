import type { TokenUsage } from '@vault/pricing';
import type { ModelProvider } from '@vault/settings-registry';

/** The usage block of an OpenAI-compatible chat completion, as providers send it. */
export interface OpenAiCompatUsageBlock {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
}

/** The usage block of an Anthropic message. */
export interface AnthropicUsageBlock {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** A non-negative safe integer: what a provider-reported token count must be. */
export function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Providers whose usage reports cache writes in `prompt_tokens_details.cache_write_tokens`,
 *  counted inside `prompt_tokens` (measured for OpenAI 2026-10-31). */
const CACHE_WRITE_REPORTERS: ReadonlySet<ModelProvider> = new Set<ModelProvider>(['openrouter', 'openai']);

export function reportsCacheWrites(provider: ModelProvider): boolean {
  return CACHE_WRITE_REPORTERS.has(provider);
}

/**
 * OpenAI-compatible usage in the suite's convention, where `input` excludes
 * cached tokens (Anthropic's convention). OpenAI-shape `prompt_tokens`
 * includes them, so cached reads and reported cache writes (OpenRouter,
 * OpenAI) are subtracted, clamped at zero in case a host reports more cached
 * than prompt tokens.
 */
export function openAiCompatUsage(usage: OpenAiCompatUsageBlock | null | undefined, provider: ModelProvider): TokenUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reportedWrites = usage?.prompt_tokens_details?.cache_write_tokens;
  const writes = reportsCacheWrites(provider) && validTokenCount(reportedWrites) ? reportedWrites : 0;
  return {
    input: Math.max(0, (usage?.prompt_tokens ?? 0) - cached - writes),
    output: usage?.completion_tokens ?? 0,
    cacheWrite: writes,
    cacheRead: cached,
  };
}

/** OpenRouter's charge for a call in USD (`usage.cost` on its responses), when it is a finite
 *  non-negative number. Other providers send no charge, so callers ask only for OpenRouter. */
export function openRouterReportedCost(usage: unknown): number | undefined {
  const cost = usage !== null && typeof usage === 'object' ? (usage as { cost?: unknown }).cost : undefined;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/** Anthropic usage maps one to one: its `input_tokens` already excludes cache tokens. */
export function anthropicUsage(usage: AnthropicUsageBlock | null | undefined): TokenUsage {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
  };
}
