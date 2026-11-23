import type { SettingsDomain } from './types.js';
import { defaultsFor, descriptorsFor } from './registry.js';
import { validateValue } from './validate.js';
import { VAULT_ALIASES } from './domains/vault.js';
import type { VaultAlias, VaultKey, VaultSettings } from './domains/vault.js';

/** The alias `key` of `domain` names, or undefined when `key` is not an alias there. */
export function vaultAliasFor(domain: SettingsDomain, key: string): VaultAlias | undefined {
  return VAULT_ALIASES.find(alias => alias.domain === domain && alias.key === key);
}

/** Every alias an older domain still answers to. */
export function vaultAliasesOf(domain: SettingsDomain): readonly VaultAlias[] {
  return VAULT_ALIASES.filter(alias => alias.domain === domain);
}

/** The values of `domain`'s aliases, read from the vault map: what get-settings reports under the old names. */
export function vaultAliasValues(domain: SettingsDomain, vault: VaultSettings): Record<string, unknown> {
  return Object.fromEntries(vaultAliasesOf(domain).map(alias => [alias.key, vault[alias.vaultKey]]));
}

/**
 * The vault map from a get-settings `domains` payload (call get-settings without a domain, or
 * with `domain: 'vault'`). Every key is present: a missing or malformed value falls back to its
 * default. An Engine older than the vault domain reports no `vault`; then the map is read from
 * the old wiki and curator keys it still reports.
 *
 * A kind or field that is `null` is none: skip what depends on it. Never put a default name
 * in its place.
 */
export function vaultSettingsFrom(domains: Record<string, unknown> | null | undefined): VaultSettings {
  const out = defaultsFor('vault') as unknown as Record<string, unknown>;
  const byKey = new Map(descriptorsFor('vault').map(d => [d.key, d]));
  const take = (key: VaultKey, value: unknown): void => {
    const d = byKey.get(key);
    if (d && value !== undefined && validateValue(d, value) === null) out[key] = value;
  };
  const vault = effectiveOf(domains, 'vault');
  if (vault) {
    for (const key of byKey.keys()) take(key as VaultKey, vault[key]);
  } else {
    for (const alias of VAULT_ALIASES) take(alias.vaultKey, effectiveOf(domains, alias.domain)?.[alias.key]);
  }
  return out as unknown as VaultSettings;
}

function effectiveOf(domains: Record<string, unknown> | null | undefined, domain: string): Record<string, unknown> | undefined {
  const payload = domains?.[domain];
  if (payload === null || typeof payload !== 'object') return undefined;
  const effective = (payload as { effective?: unknown }).effective;
  return effective !== null && typeof effective === 'object' ? effective as Record<string, unknown> : undefined;
}
