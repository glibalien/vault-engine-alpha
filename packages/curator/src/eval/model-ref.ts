import { resolveModelRef, type ModelCatalogEntry, type ModelProvider } from '@vault/settings-registry';
import { resolvePricing } from '@vault/pricing';
import { providerForModel } from '../llm/provider-for-model.js';
import type { ModelPricing, PricingLookup } from '../pricing.js';

export interface ResolvedEvalModel {
  /** Resolved provider model id (unmatched refs pass through unchanged). */
  model: string;
  /** Report label: catalog title for catalog hits, else the id's trailing path segment. */
  label: string;
}

/** 'accounts/fireworks/models/qwen3p7-plus' → 'qwen3p7-plus'; ids without '/' pass through. */
export function shortModelLabel(id: string): string {
  const seg = id.split('/').pop();
  return seg !== undefined && seg !== '' ? seg : id;
}

/**
 * Resolve a CLI model ref the way --judge-model always has: Settings/Models
 * catalog title (bare or [[wikilinked]]) first, then an enabled entry's raw
 * model id, else raw-id pass-through (routed to fireworks by the dispatching
 * client's default) with a warning. Catalog hits register their provider so
 * the dispatching client routes them correctly.
 */
export function resolveCliModelRef(
  catalog: ModelCatalogEntry[],
  ref: string,
  opts: {
    flagName: string;
    registerProvider: (model: string, provider: ModelProvider) => void;
    quiet?: boolean;
  },
): ResolvedEvalModel {
  const entry =
    resolveModelRef(catalog, ref) ??
    catalog.find((e) => e.enabled && e.model === ref) ??
    null;
  if (entry !== null) {
    opts.registerProvider(entry.model, entry.provider);
    return { model: entry.model, label: entry.title };
  }
  if (opts.quiet !== true) {
    console.warn(
      `[eval] ${opts.flagName} "${ref}" is not an enabled Settings/Models entry — treating it as a raw fireworks model id`,
    );
  }
  return { model: ref, label: shortModelLabel(ref) };
}

/**
 * The model an eval runs on, with its report label and provider (#570): the `--model` ref when
 * given (registering a catalog hit's provider in `modelProviders`), else the configured model.
 * The provider is the one the dispatching client will route to, or null when it can't tell.
 */
export function evalModel(
  catalog: ModelCatalogEntry[],
  modelProviders: Record<string, ModelProvider>,
  configured: string,
  ref: string | undefined,
  flagName = '--model',
): ResolvedEvalModel & { provider: ModelProvider | null } {
  const resolved = ref === undefined
    ? { model: configured, label: catalog.find((e) => e.enabled && e.model === configured)?.title ?? shortModelLabel(configured) }
    : resolveCliModelRef(catalog, ref, { flagName, registerProvider: (m, p) => { modelProviders[m] = p; } });
  let provider: ModelProvider | null;
  try {
    provider = providerForModel(modelProviders)(resolved.model);
  } catch {
    provider = null;
  }
  return { ...resolved, provider };
}

/**
 * Rates for any model an eval may run (#570): the configured models' rates, else the catalog
 * entry's, else the static table's. The Curator's own lookup knows only the models its settings
 * use, so a model picked with `--model` or `--judge-model` would otherwise lose its catalog rates.
 */
export function evalPricing(
  modelPricing: Record<string, ModelPricing | null> | undefined,
  catalog: ModelCatalogEntry[],
): PricingLookup {
  return (model) => modelPricing?.[model] ?? resolvePricing(model, catalog.find((e) => e.enabled && e.model === model)?.pricing);
}
