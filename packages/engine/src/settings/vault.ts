import type Database from 'better-sqlite3';
import {
  effectiveSettings, VAULT_FIELD_KEYS, VAULT_KIND_KEYS, VAULT_SELF_CREATED_KEYS,
} from '@vault/settings-registry';
import type { SettingIssue, VaultSettings } from '@vault/settings-registry';
import { getStoredSettings } from './store.js';

/**
 * The vault map (`Settings/Vault.md`) as Engine code reads it. A kind or field that is null
 * is none: skip what depends on it. Same values as `SettingsService.vault()`, for code that
 * holds only the database.
 */
export function getVaultSettings(db: Database.Database): VaultSettings {
  return effectiveSettings<VaultSettings>('vault', getStoredSettings(db, 'vault'));
}

/**
 * A warning for each designated kind or field the vault has nowhere: no schema or note of
 * that type, no global field or note value of that field, and one for the kinds memories can
 * be about that no note has. Kinds and fields the suite creates on first use are not checked,
 * and none is never a problem.
 */
export function vaultNameIssues(db: Database.Database, vault: VaultSettings): SettingIssue[] {
  const skip = new Set<string>(VAULT_SELF_CREATED_KEYS);
  const typeExists = db.prepare(`SELECT EXISTS (SELECT 1 FROM schemas WHERE name = ?)
    OR EXISTS (SELECT 1 FROM node_types WHERE schema_type = ?) AS found`);
  const fieldExists = db.prepare(`SELECT EXISTS (SELECT 1 FROM global_fields WHERE name = ?)
    OR EXISTS (SELECT 1 FROM node_fields WHERE field_name = ?) AS found`);
  const issues: SettingIssue[] = [];
  const check = (key: string, what: 'type' | 'field', exists: Database.Statement): void => {
    const name = vault[key as keyof VaultSettings];
    if (skip.has(key) || typeof name !== 'string') return;
    if ((exists.get(name, name) as { found: number }).found) return;
    issues.push({
      key, code: 'SETTINGS_NOT_IN_VAULT',
      message: `${key} names the ${what} "${name}", but no note in the vault has that ${what}. Name one the vault uses, or leave ${key} empty (none) to turn off what depends on it.`,
    });
  };
  for (const key of VAULT_KIND_KEYS) check(key, 'type', typeExists);
  for (const key of VAULT_FIELD_KEYS) check(key, 'field', fieldExists);
  // The owner's own note (#554), when set: a note should have that title.
  if (vault.ownerNote) {
    const title = vault.ownerNote.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]!.trim();
    if (db.prepare('SELECT 1 FROM nodes WHERE title = ? COLLATE NOCASE LIMIT 1').get(title) === undefined) {
      issues.push({
        key: 'ownerNote', code: 'SETTINGS_NOT_IN_VAULT',
        message: `ownerNote names "${title}", but no note has that title, so nothing keeps you out of memories' subjects. Name your own person note, or leave ownerNote empty.`,
      });
    }
  }
  // The kinds memories can be about (#554), when listed: each should be a kind the vault uses.
  // Unlisted, they are the person, company and project kinds, checked above.
  const missing = (vault.entityTypes ?? []).filter(type => !(typeExists.get(type, type) as { found: number }).found);
  if (missing.length > 0) {
    issues.push({
      key: 'entityTypes', code: 'SETTINGS_NOT_IN_VAULT',
      message: `entityTypes names ${missing.map(type => `"${type}"`).join(', ')}, but no note in the vault has ${missing.length === 1 ? 'that type' : 'those types'}. A memory can't link to a note of a kind no note has; remove ${missing.length === 1 ? 'it' : 'them'}, or keep ${missing.length === 1 ? 'it' : 'them'} for notes you will add.`,
    });
  }
  return issues;
}
