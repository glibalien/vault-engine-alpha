// An existing installation upgraded to the map-reading wiki, memory, search and transcript
// code (#446) reads every name it used to hard-code, unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { seedSettingsOnBoot } from '../../src/settings/seed.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import { markDomainSeeded, setStoredSettings } from '../../src/settings/store.js';
import { getVaultSettings } from '../../src/settings/vault.js';
import { semanticPriorityFields } from '../../src/search/semantic-context.js';
import { transcriptKind } from '../../src/mcp/tools/materialize-transcript.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
});
afterEach(() => { cleanup(); setSettingsChangeHook(null); db.close(); });

function write(rel: string, content: string): void {
  const p = join(vaultPath, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

describe('map readers on an upgraded installation', () => {
  it('read the names they used as literals', () => {
    // The installation as the previous release left it: the wiki domain seeded with nothing
    // stored (its note carries one unknown key), the curator domain with its own values.
    markDomainSeeded(db, 'wiki');
    markDomainSeeded(db, 'curator');
    markDomainSeeded(db, 'engine');
    setStoredSettings(db, 'curator', {
      activeStatuses: ['open', 'in-progress', 'next'], wikiReconciliationMode: 'live', tz: '', topicDir: null,
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
    });
    write('Settings/Wiki.md', ['---', 'date: 2026-01-01', '---', ''].join('\n'));
    const service = new SettingsService(db, { settingsDir: 'Settings', attachmentDir: 'attachments' });
    const ingest = new SettingsIngest({ db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service });

    seedSettingsOnBoot(db, service, {});
    ingest.reconcile();

    expect(getVaultSettings(db)).toMatchObject({
      dateField: 'date', priorityField: 'priority', scheduledField: 'scheduled', peopleField: 'people involved',
      wikiType: 'wiki', meetingType: 'meeting', transcriptType: 'transcript', transcriptDir: 'Transcripts',
    });
    expect(transcriptKind(db)).toEqual({ type: 'transcript', dir: 'Transcripts' });
    // No priority list in the embedding context: the same bytes, so nothing re-embeds.
    expect(semanticPriorityFields(getVaultSettings(db).peopleField)).toBeUndefined();
  });
});
