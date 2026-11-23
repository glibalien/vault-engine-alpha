// The curator `tz` description now lists everything the zone governs. On an existing
// installation the next Engine start re-renders the documentation body of the Curator note
// that shows `tz` (Settings/Curator/General.md since #746) with the new text and changes
// nothing else: no stored or effective value, no frontmatter line, no other settings note.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { descriptorsFor } from '@vault/settings-registry';
import type { SettingsDomain } from '@vault/settings-registry';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { seedSettingsOnBoot } from '../../src/settings/seed.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import { getSettingsVersion, getStoredSettings, markDomainSeeded, setStoredSettings } from '../../src/settings/store.js';
import { parseFrontmatterMapping } from '../../src/parser/frontmatter.js';
import { notePathFor, notePathsOf } from '../helpers/settings-notes.js';

/** The description the previous release rendered into the Curator note that shows `tz`. */
const PREVIOUS_TZ_DESCRIPTION = 'IANA timezone for the daily sweep. Empty = the curator host\'s system zone. Takes effect after the NEXT sweep completes or on curator restart. The dates written for you or told to a model are taken in this zone from their next run: wiki Log stamps, evidence dates and the "Today is" line in the Curator; wiki "today" (for overdue and upcoming tasks), retirement dates and memory consolidation\'s "Today is" line in the Engine (empty = the Engine host\'s zone).';

const DOMAINS: readonly SettingsDomain[] = ['engine', 'wiki', 'chat', 'curator', 'vault'];
const NOTES = DOMAINS.flatMap(d => notePathsOf(d));
const TZ_NOTE = notePathFor('curator', 'tz');

let db: Database.Database; let vaultPath: string; let cleanup: () => void;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
});
afterEach(() => { cleanup(); setSettingsChangeHook(null); db.close(); });

function boot(): SettingsService {
  const service = new SettingsService(db, { settingsDir: 'Settings', attachmentDir: 'attachments' });
  const ingest = new SettingsIngest({ db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service });
  seedSettingsOnBoot(db, service, {});
  ingest.reconcile();
  return service;
}

function read(rel: string): string {
  return readFileSync(join(vaultPath, rel), 'utf8');
}

function snapshot(service: SettingsService) {
  return {
    stored: Object.fromEntries(DOMAINS.map(d => [d, getStoredSettings(db, d)])),
    effective: Object.fromEntries(DOMAINS.map(d => [d, service.effectiveWithAliases(d)])),
    versions: Object.fromEntries(DOMAINS.map(d => [d, getSettingsVersion(db, d)])),
  };
}

describe('curator tz description on an upgraded installation', () => {
  it('re-renders only the Curator note body; every value stays', () => {
    // The installation as the previous release left it: every domain seeded, the wiki domain
    // with nothing stored (its note carries one unknown key), the curator and vault domains
    // with their own values.
    for (const d of DOMAINS) markDomainSeeded(db, d);
    setStoredSettings(db, 'curator', {
      wikiReconciliationMode: 'off', tz: '', topicDir: null,
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
      memorySweepEnabled: true, conversationSweepEnabled: true, orgSweepEnabled: true,
      conversationCaptureMode: 'live', journalEnabled: true,
    });
    setStoredSettings(db, 'vault', { projectActiveStatuses: ['open', 'in-progress', 'next'] });
    const wikiNote = join(vaultPath, 'Settings/Wiki.md');
    mkdirSync(dirname(wikiNote), { recursive: true });
    writeFileSync(wikiNote, ['---', 'date: 2026-01-01', '---', ''].join('\n'), 'utf8');

    const tz = descriptorsFor('curator').find(d => d.key === 'tz')!;
    const currentDescription = tz.description;
    expect(currentDescription).not.toBe(PREVIOUS_TZ_DESCRIPTION);
    let before: ReturnType<typeof snapshot>;
    const beforeNotes = new Map<string, string>();
    try {
      tz.description = PREVIOUS_TZ_DESCRIPTION;
      // Two starts of the previous release: the first writes the missing notes, the second
      // reads them back, as every start of a running installation does.
      boot();
      before = snapshot(boot());
      for (const note of NOTES) beforeNotes.set(note, read(note));
    } finally {
      tz.description = currentDescription;
    }
    expect(TZ_NOTE).toBe('Settings/Curator/General.md');
    expect(beforeNotes.get(TZ_NOTE)).toContain(PREVIOUS_TZ_DESCRIPTION);

    // The new release starts.
    const after = snapshot(boot());

    expect(after).toEqual(before);
    expect(after.effective['curator']).toMatchObject({ tz: '', activeStatuses: ['open', 'in-progress', 'next'] });

    const curatorBefore = beforeNotes.get(TZ_NOTE)!;
    const curatorAfter = read(TZ_NOTE);
    expect(parseFrontmatterMapping(curatorAfter).data).toEqual(parseFrontmatterMapping(curatorBefore).data);
    // The body's tz paragraph is the only change.
    expect(curatorAfter).toContain(currentDescription);
    expect(curatorAfter.replace(currentDescription, PREVIOUS_TZ_DESCRIPTION)).toBe(curatorBefore);
    for (const note of NOTES.filter(n => n !== TZ_NOTE)) {
      expect(read(note)).toBe(beforeNotes.get(note));
    }
  });
});
