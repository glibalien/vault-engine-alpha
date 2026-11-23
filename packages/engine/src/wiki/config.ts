import type Database from 'better-sqlite3';
import { defaultsFor, effectiveSettings } from '@vault/settings-registry';
import type { VaultSettings, WikiSettings } from '@vault/settings-registry';
import { getStoredSettings, isDomainSeeded } from '../settings/store.js';
import { getVaultSettings } from '../settings/vault.js';

/**
 * What Engine's wiki code reads: the wiki domain's rendering settings plus the vault map
 * (kinds, fields, status values, folders). Both come from the settings registry; a kind or
 * field that is null is none.
 */
export type WikiConfig = WikiSettings & VaultSettings;

/** The config when the wiki page kind is set: what writing a wiki page needs. */
export type WikiWriteConfig = WikiConfig & { wikiType: string };

/** Registry defaults, for tests and fixtures. Not a second copy: derived from the registry. */
export const DEFAULT_WIKI_CONFIG: WikiWriteConfig = {
  ...(defaultsFor('wiki') as unknown as WikiSettings),
  ...(defaultsFor('vault') as unknown as VaultSettings & { wikiType: string }),
};

const LEGACY_KEY = 'wiki_config';

/**
 * The pre-settings `meta.wiki_config` blob, read once by the boot migration into the wiki
 * domain (whose update routes its vocabulary keys into the vault domain). Values are
 * validated there.
 */
function legacyStored(db: Database.Database): Record<string, unknown> {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_KEY) as { value: string } | undefined;
  if (!row) return {};
  const parsed = JSON.parse(row.value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored wiki_config must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function getStoredWikiConfig(db: Database.Database): Record<string, unknown> {
  if (isDomainSeeded(db, 'wiki')) return getStoredSettings(db, 'wiki');
  return legacyStored(db);
}

export function getWikiConfig(db: Database.Database): WikiConfig {
  return { ...effectiveSettings<WikiSettings>('wiki', getStoredSettings(db, 'wiki')), ...getVaultSettings(db) };
}

/** The refusal a wiki write returns when the vault map turns wiki pages off. */
export const WIKIS_OFF_MESSAGE = 'Wiki pages are off: wikiType is none in Settings/Vault.md. Name the kind wiki pages take to write them.';

/** The config narrowed for writing wiki pages, or null when the wiki page kind is none. */
export function wikiWriteConfig(config: WikiConfig): WikiWriteConfig | null {
  return config.wikiType === null ? null : config as WikiWriteConfig;
}

/** The wiki page kind, for code that writes pages. The write tools refuse first when it is none. */
export function requireWikiType(config: WikiConfig): string {
  if (config.wikiType === null) throw new Error(WIKIS_OFF_MESSAGE);
  return config.wikiType;
}
