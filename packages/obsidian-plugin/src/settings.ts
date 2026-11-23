// src/settings.ts
import type { ProviderKeys } from '@vault/chat-core';
import type { SearchMode } from './search/search.js';

export interface VaultPluginSettings {
  engineUrl: string;
  token: string;
  curatorUrl: string;
  curatorToken: string;
  fireworksApiKey: string;
  anthropicApiKey: string;
  openrouterApiKey: string;
  openaiApiKey: string;
  searchMode: SearchMode;
}
export const DEFAULT_SETTINGS: VaultPluginSettings = {
  engineUrl: 'http://localhost:3334/mcp',
  token: '',
  curatorUrl: 'http://localhost:3335/mcp',
  curatorToken: '',
  fireworksApiKey: '',
  anthropicApiKey: '',
  openrouterApiKey: '',
  openaiApiKey: '',
  searchMode: 'hybrid',
};

/**
 * Merge data.json into DEFAULT_SETTINGS, dropping the free-text `model` key
 * retired in Phase 4 (model choice now comes from engine settings + the
 * picker) so a still-present stale key from an older install is never
 * re-persisted. Pure so it's testable without an Obsidian `Plugin` instance —
 * `main.ts#loadSettings` is a thin `this.settings = mergeSettings(await
 * this.loadData())` wrapper around this.
 */
export function mergeSettings(raw: unknown): VaultPluginSettings {
  const cleaned = { ...((raw ?? {}) as Record<string, unknown>) };
  delete cleaned['model'];
  return Object.assign({}, DEFAULT_SETTINGS, cleaned);
}

type KeySettings = Pick<VaultPluginSettings, 'fireworksApiKey' | 'anthropicApiKey' | 'openrouterApiKey' | 'openaiApiKey'>;

/** The model provider keys this plugin holds, in chat-core's shape — the one
 *  place the settings fields map to catalog providers. */
export function providerKeys(settings: KeySettings): ProviderKeys {
  return {
    fireworks: settings.fireworksApiKey,
    anthropic: settings.anthropicApiKey,
    openrouter: settings.openrouterApiKey,
    openai: settings.openaiApiKey,
  };
}

/**
 * True when at least one provider key is configured locally — the gate for chat features
 * (ChatView.onOpen, main.ts#chatPing). The per-conversation model picker lets a
 * conversation route to any provider (chat-core's `resolveModel` dispatches per-model), so
 * any one key alone suffices.
 */
export function hasProviderKey(settings: KeySettings): boolean {
  return Object.values(providerKeys(settings)).some(key => !!key);
}
