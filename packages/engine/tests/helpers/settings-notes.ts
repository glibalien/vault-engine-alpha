import { settingsNoteOfKey, settingsNotePath, settingsNotesOf } from '@vault/settings-registry';
import type { SettingsDomain, SettingsNote } from '@vault/settings-registry';

/**
 * The settings note that shows `key` (#746): `Settings/Engine/Backups and retention.md` for
 * `backupKeep`. Without a key, the domain's single note (`Settings/Wiki.md`), or for a
 * domain shown in a folder its first note (`General`).
 */
export function noteFor(domain: SettingsDomain, key?: string): SettingsNote {
  const note = key === undefined ? settingsNotesOf(domain)[0] : settingsNoteOfKey(domain, key);
  if (!note) throw new Error(`no ${domain} note shows ${key}`);
  return note;
}

/** The vault path of {@link noteFor}. */
export function notePathFor(domain: SettingsDomain, key?: string, settingsDir = 'Settings'): string {
  return settingsNotePath(settingsDir, noteFor(domain, key));
}

/** Every note path of a domain. */
export function notePathsOf(domain: SettingsDomain, settingsDir = 'Settings'): string[] {
  return settingsNotesOf(domain).map(note => settingsNotePath(settingsDir, note));
}
