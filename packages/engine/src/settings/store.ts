import type Database from 'better-sqlite3';
import type { SettingsDomain } from '@vault/settings-registry';

const SETTINGS_NOTE_PENDING_FIELDS_KEY = 'settings.note_projection_pending_fields';

export function readJson<T>(db: Database.Database, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch (err) {
    // A corrupt meta row must not crash boot; the fallback serves until the next
    // write repairs the row. Loud so operators see the data loss.
    console.error(`[settings] malformed JSON in meta.${key} — serving fallback:`,
      err instanceof Error ? err.message : err);
    return fallback;
  }
}

export function writeJson(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

function pendingFieldsByDomain(db: Database.Database): Partial<Record<SettingsDomain, string[]>> {
  const raw = readJson<unknown>(db, SETTINGS_NOTE_PENDING_FIELDS_KEY, {});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Partial<Record<SettingsDomain, string[]>> = {};
  for (const [domain, fields] of Object.entries(raw)) {
    if (!Array.isArray(fields)) continue;
    result[domain as SettingsDomain] = [...new Set(fields.filter(
      (field): field is string => typeof field === 'string' && field.length > 0,
    ))].sort();
  }
  return result;
}

/** Durable field ownership awaiting a successful projection of the domain's settings notes. */
export function getPendingSettingsNoteFields(
  db: Database.Database, domain: SettingsDomain,
): string[] {
  return pendingFieldsByDomain(db)[domain] ?? [];
}

/**
 * Union caller-owned fields into the durable projection journal. The caller
 * places this in the same SQLite transaction as its settings commit whenever
 * possible. File-snapshot canonicalization must not use this journal: a failed
 * compare-and-swap leaves the newer human file authoritative on its next event.
 */
export function addPendingSettingsNoteFields(
  db: Database.Database, domain: SettingsDomain, fields: Iterable<string>,
): string[] {
  const current = pendingFieldsByDomain(db);
  const next = [...new Set([...(current[domain] ?? []), ...fields])].filter(Boolean).sort();
  if (next.length === 0) return [];
  current[domain] = next;
  writeJson(db, SETTINGS_NOTE_PENDING_FIELDS_KEY, current);
  return next;
}

/** Clear ownership only after the corresponding note projection succeeds. With `fields`,
 *  only those: a domain shown in several notes clears what the written note owned (#746). */
export function clearPendingSettingsNoteFields(
  db: Database.Database, domain: SettingsDomain, fields?: Iterable<string>,
): void {
  const current = pendingFieldsByDomain(db);
  if (!(domain in current)) return;
  if (fields !== undefined) {
    const cleared = new Set(fields);
    const left = (current[domain] ?? []).filter(field => !cleared.has(field));
    if (left.length === (current[domain] ?? []).length) return;
    if (left.length > 0) {
      current[domain] = left;
      writeJson(db, SETTINGS_NOTE_PENDING_FIELDS_KEY, current);
      return;
    }
  }
  delete current[domain];
  if (Object.keys(current).length === 0) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(SETTINGS_NOTE_PENDING_FIELDS_KEY);
  } else {
    writeJson(db, SETTINGS_NOTE_PENDING_FIELDS_KEY, current);
  }
}

export function getStoredSettings(db: Database.Database, domain: SettingsDomain): Record<string, unknown> {
  return readJson(db, `settings.${domain}`, {});
}

export function setStoredSettings(db: Database.Database, domain: SettingsDomain, patch: Record<string, unknown>): void {
  writeJson(db, `settings.${domain}`, patch);
  const versions = readJson<Record<string, number>>(db, 'settings.versions', {});
  versions[domain] = (versions[domain] ?? 0) + 1;
  writeJson(db, 'settings.versions', versions);
}

export function getSettingsVersion(db: Database.Database, domain: SettingsDomain): number {
  return readJson<Record<string, number>>(db, 'settings.versions', {})[domain] ?? 0;
}

export function isDomainSeeded(db: Database.Database, domain: SettingsDomain): boolean {
  return readJson<Record<string, string>>(db, 'settings.seeded', {})[domain] !== undefined;
}

export function markDomainSeeded(db: Database.Database, domain: SettingsDomain): void {
  const seeded = readJson<Record<string, string>>(db, 'settings.seeded', {});
  // Idempotent: the timestamp records the FIRST seeding (forensic — "when did env
  // seeding happen"); later calls (update-settings marks its domain on every
  // successful apply) must not shift it.
  if (seeded[domain] !== undefined) return;
  seeded[domain] = new Date().toISOString();
  writeJson(db, 'settings.seeded', seeded);
}

export function getPromptDefaults(db: Database.Database, domain: SettingsDomain): Record<string, string> {
  return readJson<Record<string, string>>(db, `prompt_defaults.${domain}`, {});
}

export function setPromptDefaults(db: Database.Database, domain: SettingsDomain, defaults: Record<string, string>): void {
  writeJson(db, `prompt_defaults.${domain}`, defaults);
}

export function getPromptDefaultHashes(db: Database.Database, domain: SettingsDomain): Record<string, string> {
  return readJson<Record<string, string>>(db, `prompt_default_hashes.${domain}`, {});
}

export function setPromptDefaultHashes(db: Database.Database, domain: SettingsDomain, hashes: Record<string, string>): void {
  writeJson(db, `prompt_default_hashes.${domain}`, hashes);
}

export function getPromptOverrideHashes(db: Database.Database, domain: SettingsDomain): Record<string, string> {
  return readJson<Record<string, string>>(db, `prompt_override_hashes.${domain}`, {});
}

export function setPromptOverrideHashes(db: Database.Database, domain: SettingsDomain, hashes: Record<string, string>): void {
  writeJson(db, `prompt_override_hashes.${domain}`, hashes);
}
