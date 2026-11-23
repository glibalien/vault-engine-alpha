import type { ModelProvider } from './providers.js';

export interface ModelEntryPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCatalogEntry {
  title: string;
  provider: ModelProvider;
  model: string;
  enabled: boolean;
  vision?: boolean;
  tools?: boolean;
  contextLength?: number;
  pricing?: ModelEntryPricing;
}

export interface ModelProviderConflict {
  code: 'AMBIGUOUS_MODEL_PROVIDER';
}

/**
 * Detect enabled catalog aliases that would collapse one raw provider model ID
 * onto more than one provider. The diagnostic is intentionally identity-free:
 * callers can fail closed without placing dynamic model IDs in logs.
 */
export function modelProviderConflicts(catalog: readonly ModelCatalogEntry[]): ModelProviderConflict[] {
  const providersByModel = new Map<string, ModelProvider>();
  let ambiguous = false;
  for (const entry of catalog) {
    if (!entry.enabled) continue;
    const provider = providersByModel.get(entry.model);
    if (provider !== undefined && provider !== entry.provider) ambiguous = true;
    else providersByModel.set(entry.model, entry.provider);
  }
  return ambiguous ? [{ code: 'AMBIGUOUS_MODEL_PROVIDER' }] : [];
}

const WIKILINK = /^\[\[(.*)\]\]$/;

/** '[[Title]]' or bare 'Title' → 'Title'. Non-strings normalize to '' (invalid). */
export function normalizeModelRef(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const m = WIKILINK.exec(trimmed);
  return (m ? m[1]!.trim() : trimmed).trim();
}

/** Title match against ENABLED entries only — a disabled entry is deliberately unresolvable. */
export function resolveModelRef(catalog: ModelCatalogEntry[], ref: unknown): ModelCatalogEntry | null {
  const title = normalizeModelRef(ref);
  if (title === '') return null;
  return catalog.find(e => e.enabled && e.title === title) ?? null;
}

export const SEED_MODELS: readonly ModelCatalogEntry[] = [
  { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true },
  { title: 'DeepSeek v4 Pro', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-pro', enabled: true },
  { title: 'Kimi K2.6', provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', enabled: true },
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
  { title: 'GPT-OSS 120B', provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true },
];

/** Last resort when even a registry-default ref dangles (user deleted a seed note). */
export const FALLBACK_MODELS: Readonly<Record<string, { provider: ModelProvider; model: string }>> =
  Object.fromEntries(SEED_MODELS.map(m => [m.title, { provider: m.provider, model: m.model }]));

/** Last-resort catalog entry (the first seed model) — the single source of the
 *  fallback title the chat surfaces use when even the registry default dangles. */
export const FALLBACK_ENTRY: ModelCatalogEntry = SEED_MODELS[0];
