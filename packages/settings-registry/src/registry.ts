import type { SettingDescriptor, SettingsDomain } from './types.js';
import { ENGINE_DESCRIPTORS } from './domains/engine.js';
import { WIKI_DESCRIPTORS } from './domains/wiki.js';
import { CHAT_DESCRIPTORS } from './domains/chat.js';
import { CURATOR_DESCRIPTORS } from './domains/curator.js';
import { VAULT_DESCRIPTORS } from './domains/vault.js';

export const DOMAINS = ['engine', 'wiki', 'chat', 'curator', 'vault'] as const satisfies readonly SettingsDomain[];
export const SETTINGS_REGISTRY: SettingDescriptor[] = [...ENGINE_DESCRIPTORS, ...WIKI_DESCRIPTORS, ...CHAT_DESCRIPTORS, ...CURATOR_DESCRIPTORS, ...VAULT_DESCRIPTORS];

export function descriptorsFor(domain: SettingsDomain): SettingDescriptor[] {
  return SETTINGS_REGISTRY.filter(d => d.domain === domain);
}

export function defaultsFor(domain: SettingsDomain): Record<string, unknown> {
  return Object.fromEntries(descriptorsFor(domain).map(d => [d.key, d.default]));
}
