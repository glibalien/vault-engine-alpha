import { createAnthropic } from '@ai-sdk/anthropic';
import { createFireworks } from '@ai-sdk/fireworks';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { MODEL_PROVIDERS, PROVIDERS, type ModelCatalogEntry, type ModelProvider } from '@vault/settings-registry';

/** API key per catalog provider, as this surface holds them. */
export type ProviderKeys = Partial<Record<ModelProvider, string>>;

export const OPENROUTER_BASE_URL = PROVIDERS.openrouter.baseURL;

const present = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';

/** Presence booleans from a surface's OWN keys — the picker greying source (never the engine's). */
export function providerAvailability(keys: ProviderKeys): Record<ModelProvider, boolean> {
  return Object.fromEntries(MODEL_PROVIDERS.map(p => [p, present(keys[p])])) as Record<ModelProvider, boolean>;
}

/** Chat's AI SDK provider per catalog provider. */
export const providerRegistry: Record<ModelProvider, (apiKey: string, fetch?: typeof globalThis.fetch) => (modelId: string) => LanguageModel> = {
  fireworks: (apiKey, fetch) => createFireworks({ apiKey, fetch }),
  anthropic: (apiKey, fetch) => createAnthropic({ apiKey, fetch }),
  // Native provider (needs ai@7) — replaces the @ai-sdk/openai-compatible shim
  // this had to use while pinned to ai@5. `compatibility: 'strict'` is correct
  // when talking to OpenRouter's own API: the default 'compatible' mode
  // withholds streamOptions, which is what carries streamed usage accounting.
  openrouter: (apiKey, fetch) => {
    const provider = createOpenRouter({ apiKey, baseURL: OPENROUTER_BASE_URL, compatibility: 'strict', fetch });
    return (modelId) => provider(modelId);
  },
  // The Responses API: newer OpenAI reasoning models (gpt-5.6) refuse function
  // tools on Chat Completions unless reasoning is switched off. Responses stores
  // each response as application state by default, so every call sends
  // store: false (OpenAI's abuse-monitoring retention is separate and still
  // applies) and asks for encrypted reasoning, which the SDK passes back between
  // tool steps.
  openai: (apiKey, fetch) => {
    const provider = createOpenAI({ apiKey, baseURL: PROVIDERS.openai.baseURL, fetch });
    return (modelId) => wrapLanguageModel({
      model: provider.responses(modelId),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { openai: { store: false, include: ['reasoning.encrypted_content'] } } },
      }),
    });
  },
};

/** Catalog entry + surface keys → injected LanguageModel. Throws LOUDLY when the entry's
 *  provider key is missing (mirror of curator's dispatching-client rule: no silent fallback).
 *  opts.fetch: custom transport (the plugin's engine-relay shim). */
export function resolveModel(entry: ModelCatalogEntry, keys: ProviderKeys, opts?: { fetch?: typeof globalThis.fetch }): LanguageModel {
  const key = keys[entry.provider];
  if (!present(key)) {
    throw new Error(`model "${entry.model}" needs the ${entry.provider} API key — not configured on this surface`);
  }
  return providerRegistry[entry.provider](key!, opts?.fetch)(entry.model);
}
