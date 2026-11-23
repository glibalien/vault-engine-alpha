import type { LanguageModel } from 'ai';
import type { ModelCatalogEntry, ModelProvider } from '@vault/settings-registry';
import { providerAvailability, type ProviderKeys } from '@vault/chat-core';

/** The slice of PluginSettingsClient turn resolution needs (keeps this module
 *  Obsidian-free and trivially fakeable in tests). */
export interface TurnSettingsClient {
  resolveRef(ref: string, availability: Record<ModelProvider, boolean>): Promise<ModelCatalogEntry | null>;
  resolvedDefault(availability: Record<ModelProvider, boolean>): Promise<ModelCatalogEntry>;
  effective(): Promise<{ settings: { maxSteps: number } }>;
}

export interface TurnResolverDeps {
  settingsClient: TurnSettingsClient;
  keys: ProviderKeys;
  /** Provider-key-aware model factory — the Obsidian-coupled relay stays at the caller. */
  makeModel: (entry: ModelCatalogEntry) => LanguageModel;
  warn?: (msg: string) => void;
}

export interface TurnResolver {
  /** Resolved fresh at each send: current picker selection or the settings
   *  default, live maxSteps. Both settingsClient calls piggyback on the same
   *  30s-TTL snapshot, so this rarely means two round-trips. */
  turn(): Promise<{ model: LanguageModel; maxSteps: number; entry: ModelCatalogEntry }>;
  /** The per-conversation model-picker selection (a Settings/Models catalog
   *  title), read fresh by turn() at each send. null = no override → resolves
   *  the surface default. ChatPane keeps this in lockstep with its own React
   *  state — same cross-boundary discipline as ChatContextHolder. */
  onModelRefChange(title: string | null): void;
}

export function makeTurnResolver({ settingsClient, keys, makeModel, warn = (m) => console.warn(m) }: TurnResolverDeps): TurnResolver {
  let selectedModelRef: string | null = null;
  // Single-slot dedup for the stale-ref warning (mirrors the web's ChatSettingsClient
  // warnedModel): warn once per distinct dangling value, not once per send while it stays
  // stale, but re-warn if it dangles again after a clean resolve in between.
  let warnedModelRef: string | null = null;

  return {
    onModelRefChange(title: string | null): void { selectedModelRef = title; },
    async turn() {
      const avail = providerAvailability(keys);
      // STRICT per-conversation resolution (enabled + this surface's provider key configured);
      // unlike the web server (which rejects the turn outright), the plugin IS the resolver on
      // this surface — a stale persisted ref (deleted/disabled note, or its key removed) just
      // degrades to the default rather than blocking the send. Warn once so it's not silent.
      let entry = selectedModelRef ? await settingsClient.resolveRef(selectedModelRef, avail) : null;
      if (!entry && selectedModelRef) {
        if (warnedModelRef !== selectedModelRef) {
          warnedModelRef = selectedModelRef;
          warn(`[vault-obsidian] model ref "${selectedModelRef}" no longer resolves (deleted/disabled note, or its provider key was removed) — falling back to the default model`);
        }
      } else {
        warnedModelRef = null; // clean resolve (or no override) — a later dangling value re-warns
      }
      entry ??= await settingsClient.resolvedDefault(avail);
      const model = makeModel(entry);
      const { settings } = await settingsClient.effective();
      return { model, maxSteps: settings.maxSteps, entry };
    },
  };
}
