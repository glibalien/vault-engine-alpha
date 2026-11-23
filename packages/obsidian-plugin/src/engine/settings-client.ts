import {
  effectiveSettings,
  defaultsFor,
  resolveModelRef,
  SEED_MODELS,
  FALLBACK_ENTRY,
  type ChatSettings,
  type ModelCatalogEntry,
  type ModelProvider,
} from '@vault/settings-registry';
import { SYSTEM_PROMPT, TIERING_SYSTEM_NOTE } from '@vault/chat-core';
import { unwrapEnvelope } from './client.js';
import type { CallFn } from './types.js';
import { DEFAULT_SETTINGS_DIR, settingsDirFrom } from './vault-map.js';

const TTL_MS = 30_000;

interface ChatDomainPayload {
  effective: Record<string, unknown>;
}

interface ModelsDomainPayload {
  catalog: ModelCatalogEntry[];
}

interface GetSettingsData {
  settingsDir?: unknown;
  domains: Record<string, ChatDomainPayload | ModelsDomainPayload>;
}

interface Snapshot {
  settings: ChatSettings;
  catalog: ModelCatalogEntry[];
  /** Engine's settings folder (VAULT_SETTINGS_DIR): the model notes are in `<settingsDir>/Models/`. */
  settingsDir: string;
}

/**
 * The plugin's read-only settings/catalog client over the engine MCP
 * connection. Mirrors the web's ChatSettingsClient fetch/TTL/last-known-snapshot
 * shape (packages/chat/src/server/settings.ts), simplified: no env seeding
 * here — the web server owns chat-domain seeding, and every surface reads the
 * same seeded/edited Settings/Chat.md note off the same engine.
 */
export class PluginSettingsClient {
  private snapshot: Snapshot;
  private fetchedAt = 0;
  /** Single-slot dedup: warns once per distinct dangling/unavailable default
   *  model-ref value, then suppresses a repeat warning for that same
   *  still-dangling value on the next resolvedDefault() call. A different
   *  dangling value warns again. Mirrors the web's
   *  ChatSettingsClient.warnedModel (Fix 3b, packages/chat/src/server/settings.ts). */
  private warnedDefault: string | null = null;

  constructor(private readonly call: CallFn) {
    this.snapshot = { settings: effectiveSettings<ChatSettings>('chat', {}), catalog: [...SEED_MODELS], settingsDir: DEFAULT_SETTINGS_DIR };
  }

  /** One omit-domain get-settings; 30s TTL; on failure serve last-known
   *  (registry defaults + SEED_MODELS before the first success). */
  async effective(): Promise<{ settings: ChatSettings; catalog: ModelCatalogEntry[]; settingsDir: string }> {
    if (Date.now() - this.fetchedAt > TTL_MS) await this.refresh();
    return this.snapshot;
  }

  async registerPromptDefaults(): Promise<void> {
    try {
      const result = await this.call({
        name: 'register-prompt-defaults',
        arguments: { domain: 'chat', defaults: { chatSystemPrompt: SYSTEM_PROMPT, chatTieringNote: TIERING_SYSTEM_NOTE } },
      });
      const env = unwrapEnvelope<{ domain: string; applied: string[]; changed: boolean }>(result);
      if (!env.ok) console.warn(`[vault-obsidian] prompt defaults registration failed: ${env.error?.message ?? 'unknown error'}`);
    } catch (err) {
      console.warn(`[vault-obsidian] prompt defaults registration skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Default chain (stored defaultModel → registry default → first enabled+available
   *  catalog entry → FALLBACK synthetic entry), availability-aware — same semantics
   *  as the web's resolvedEntry(). Warns once per distinct failing default value
   *  (Fix 3b: the warn-dedup slot resets on a clean resolve). */
  async resolvedDefault(availability: Record<ModelProvider, boolean>): Promise<ModelCatalogEntry> {
    const { settings, catalog } = await this.effective();
    const ref = settings.defaultModel;
    const direct = resolveModelRef(catalog, ref);
    if (direct && availability[direct.provider]) {
      this.warnedDefault = null;
      return direct;
    }
    this.warnDangling(ref);
    const registryDefaultRef = defaultsFor('chat')['defaultModel'] as string;
    const fromDefault = resolveModelRef(catalog, registryDefaultRef);
    if (fromDefault && availability[fromDefault.provider]) return fromDefault;
    // final-review Finding 1: an Anthropic-only surface must not be stuck on a
    // Fireworks-only default chain when a usable Claude entry exists — mirrors
    // ChatSettingsClient.resolveRef (packages/chat/src/server/settings.ts).
    const firstAvailable = catalog.find((e) => e.enabled && availability[e.provider]);
    if (firstAvailable) return firstAvailable;
    return { ...FALLBACK_ENTRY };
  }

  /** final-review Finding 2: mirrors the web's warnDangling — logs once per
   *  distinct failing default value, naming the ref and that it's falling back. */
  private warnDangling(ref: string): void {
    if (this.warnedDefault === ref) return;
    this.warnedDefault = ref;
    console.warn(`[vault-obsidian] settings default model ref "${ref}" does not resolve to an enabled Settings/Models entry with a configured provider key — falling back`);
  }

  /** STRICT: enabled + available, else null (per-conversation refs; Task 8). */
  async resolveRef(ref: string, availability: Record<ModelProvider, boolean>): Promise<ModelCatalogEntry | null> {
    const { catalog } = await this.effective();
    const entry = resolveModelRef(catalog, ref);
    return entry && availability[entry.provider] ? entry : null;
  }

  private async refresh(): Promise<void> {
    try {
      const result = await this.call({ name: 'get-settings', arguments: {} });
      const env = unwrapEnvelope<GetSettingsData>(result);
      if (!env.ok || !env.data) throw new Error(env.error?.message ?? 'get-settings failed');
      const chat = env.data.domains['chat'] as ChatDomainPayload | undefined;
      if (!chat) throw new Error('get-settings response missing the chat domain');
      const models = env.data.domains['models'] as ModelsDomainPayload | undefined;
      this.snapshot = {
        settings: chat.effective as unknown as ChatSettings,
        // Rollback-window tolerance: an engine response without the models key
        // (older engine build) keeps the prior/seed catalog rather than clearing it.
        catalog: models ? models.catalog : this.snapshot.catalog,
        // An Engine older than the vault map reports no folder: it is the default, Settings.
        settingsDir: settingsDirFrom(env.data),
      };
    } catch {
      // The engine being unreachable (or returning a bad response) is never
      // fatal — keep serving the last-known snapshot.
    } finally {
      this.fetchedAt = Date.now(); // success AND failure arm the TTL — no hammering
    }
  }
}
