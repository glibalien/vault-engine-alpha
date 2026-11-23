import { vaultSettingsFrom, type VaultSettings } from '@vault/settings-registry';
import { connectEngine } from './transport.js';
import { unwrapEnvelope } from './client.js';
import type { CallFn } from './types.js';
import type { VaultPluginSettings } from '../settings.js';

/** How long a read of the map is reused, as for the project type (project-wikis.ts). */
const TTL_MS = 10 * 60_000;

/** Engine's settings folder when it reports none (an Engine older than the vault map). */
export const DEFAULT_SETTINGS_DIR = 'Settings';

/** What the plugin reads from Engine about the user's vault: the vault map's names
 *  (`Settings/Vault.md`), the settings folder set at install, and the configured time zone. */
export interface VaultMap {
  vault: VaultSettings;
  settingsDir: string;
  /** Curator's `tz` setting, the zone dates are taken in (#459); null when empty or unknown, and
   *  then views use the viewer's zone. */
  timeZone: string | null;
}

/** The map before Engine has been read, or when it can't be: the map's defaults, today's names. */
export const DEFAULT_VAULT_MAP: VaultMap = { vault: vaultSettingsFrom(undefined), settingsDir: DEFAULT_SETTINGS_DIR, timeZone: null };

/** Curator's `tz` in a get-settings `domains` payload; null when unset, empty or not reported. */
export function timeZoneFrom(domains: Record<string, unknown> | undefined): string | null {
  const curator = domains?.['curator'];
  const effective = curator !== null && typeof curator === 'object' ? (curator as { effective?: unknown }).effective : undefined;
  const tz = effective !== null && typeof effective === 'object' ? (effective as { tz?: unknown }).tz : undefined;
  return typeof tz === 'string' && tz.trim() !== '' ? tz.trim() : null;
}

/** The settings folder in a get-settings payload; `Settings` when Engine reports none. */
export function settingsDirFrom(data: { settingsDir?: unknown } | undefined): string {
  const dir = data?.settingsDir;
  return typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : DEFAULT_SETTINGS_DIR;
}

/** The map from a get-settings payload (no domain). An Engine older than the map reports no vault
 *  domain and no settings folder: the map is read from its old wiki and curator keys, and the folder
 *  is `Settings`. A null name stays null: none. */
export function vaultMapFrom(data: { settingsDir?: unknown; domains?: Record<string, unknown> } | undefined): VaultMap {
  return { vault: vaultSettingsFrom(data?.domains), settingsDir: settingsDirFrom(data), timeZone: timeZoneFrom(data?.domains) };
}

/** One get-settings read. Throws when Engine answers with an error or with no domains. */
export async function readVaultMap(call: CallFn): Promise<VaultMap> {
  const env = unwrapEnvelope<{ settingsDir?: unknown; domains?: Record<string, unknown> }>(
    await call({ name: 'get-settings', arguments: {} }));
  if (!env.ok || !env.data?.domains) throw Error(env.error?.message ?? 'Engine reported no settings');
  return vaultMapFrom(env.data);
}

/** Read the map over a short-lived connection: the same tool an AI caller has. */
export async function readVaultMapOver(settings: Pick<VaultPluginSettings, 'engineUrl' | 'token'>): Promise<VaultMap> {
  const conn = await connectEngine(settings.engineUrl, settings.token);
  try { return await readVaultMap(conn.call); } finally { await conn.close().catch(() => {}); }
}

/**
 * The vault map, known without waiting: a reading-view post-processor and a view's presets can't
 * wait for Engine. Read in the background when stale and served as last known; until a read
 * succeeds, the map's defaults (today's names). A failed read keeps the last known map and waits
 * out the same interval. Views subscribe and re-render when a read changes it.
 */
export class VaultMapIndex {
  private map: VaultMap;
  private readAt = -Infinity;
  private loading: Promise<void> | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  /** `initial` is the map served until the first read lands: the defaults unless given. */
  constructor(
    private readonly read: () => Promise<VaultMap>,
    private readonly now: () => number = Date.now,
    initial: VaultMap = DEFAULT_VAULT_MAP,
  ) {
    this.map = initial;
  }

  /** The last known map. Pure, so a view can read it during render. */
  readonly current = (): VaultMap => this.map;

  /** Start a background read if the map is stale. */
  refresh(): void {
    void this.load();
  }

  /** The map, read first when stale. Never rejects: on failure, the last known map. */
  async load(): Promise<VaultMap> {
    if (this.now() - this.readAt >= TTL_MS) {
      this.loading ??= this.fetch();
      await this.loading;
    }
    return this.map;
  }

  /** Called whenever the map changes. Returns the unsubscribe. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /**
   * The Engine connection changed: read the map again now. A read still in flight from the old
   * connection is dropped. Until the new read lands, the last known map stays, so open views keep
   * their names rather than falling back to the defaults.
   */
  reset(): void {
    this.generation++;
    this.readAt = -Infinity;
    this.loading = null;
    this.refresh();
  }

  private async fetch(): Promise<void> {
    const generation = this.generation;
    try {
      const map = await this.read();
      if (generation === this.generation) this.set(map);
    } catch { /* Keep the last known map. */ } finally {
      // Success and failure both wait out the TTL: no hammering an unreachable Engine.
      if (generation === this.generation) { this.readAt = this.now(); this.loading = null; }
    }
  }

  private set(map: VaultMap): void {
    if (JSON.stringify(map) === JSON.stringify(this.map)) return;
    this.map = map;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * An open view's map: read over the view's own Engine connection, starting from `seed` (the
 * plugin's last known map) until that read lands. A view keeps the connection it opened with,
 * so its names must come from that Engine too; the plugin-wide map follows the settings and
 * switches to a new Engine at once, which would have a view read and write the new Engine's
 * field names on the old one.
 */
export function connectionVaultMap(call: CallFn, seed: VaultMap): VaultMapIndex {
  return new VaultMapIndex(() => readVaultMap(call), Date.now, seed);
}
