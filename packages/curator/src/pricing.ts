// Re-exported from @vault/pricing — the shared suite-wide rate table.
// This module path stays alive so existing imports (runs.ts, curate.ts,
// run.ts, report.ts) keep working, and so the curator's own cost math and
// the engine's spend ledger can never disagree on rates. The curator's
// TokenUsage (types.ts) is structurally identical to the package's — TS
// structural typing keeps every call site compiling unchanged.
import { addUsage, estimateCostUsdWith, pricingFor, ZERO_USAGE, type ModelPricing, type TokenUsage } from '@vault/pricing';
import type { Config } from './config.js';

export {
  pricingFor,
  estimateCostUsd,
  addUsage,
  ZERO_USAGE,
  formatUsage,
  type ModelPricing,
} from '@vault/pricing';

export type PricingLookup = (model: string) => ModelPricing | null;

/** The model catalog's rate first, then the static table, which doesn't list every catalog
 *  model (#356). The daily budget prices calls the same way. */
export function catalogPricing(config: Pick<Config, 'modelPricing'>): PricingLookup {
  return model => config.modelPricing?.[model] ?? pricingFor(model);
}

/** Prices usage per model, summing each model's usage first so a single-model
 *  total equals estimateCostUsd exactly. Null when any model's pricing is unknown. */
export function estimateCostByModel(
  parts: Iterable<readonly [model: string, usage: TokenUsage]>,
  pricing: PricingLookup = pricingFor,
): number | null {
  const byModel = new Map<string, TokenUsage>();
  for (const [model, usage] of parts) byModel.set(model, addUsage(byModel.get(model) ?? ZERO_USAGE, usage));
  let total = 0;
  for (const [model, usage] of byModel) {
    const rates = pricing(model);
    if (rates === null) return null;
    total += estimateCostUsdWith(rates, usage);
  }
  return total;
}
