import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { processFileChange, startWatcher, type VaultWatcher } from '../../src/sync/watcher.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import { notePathFor } from '../helpers/settings-notes.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let watcher: VaultWatcher;
let writeLock: WriteLockManager;
let service: SettingsService;
// A group note of the Engine's settings folder (#746).
const canonical = notePathFor('engine', 'backupKeep');
const authored = '---\nbackupKeep: 3\n---\nUser-authored notes stay with this file.\n';

beforeEach(async () => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  service = new SettingsService(db, { settingsDir: 'Settings' });
  const ingest = new SettingsIngest({ db, vaultPath, writeLock, service });
  setSettingsChangeHook((path, kind, context) => ingest.onFileEvent(path, kind, context));
  mkdirSync(join(vaultPath, dirname(canonical)), { recursive: true });
  writeFileSync(join(vaultPath, canonical), authored, 'utf8');
  processFileChange(join(vaultPath, canonical), canonical, db, writeLock, vaultPath,
    undefined, undefined, { allowSettingsWriteBack: false });
  watcher = startWatcher(vaultPath, db, new IndexMutex(), writeLock, undefined, undefined, undefined, {
    debounceMs: 200, maxWaitMs: 400, renameGraceMs: 1500,
  });
  await watcher.waitUntilReady();
});

afterEach(async () => {
  setSettingsChangeHook(null);
  await watcher.close();
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

describe('live settings-note renames', () => {
  it.each(['unlink first', 'add first'])('regenerates the canonical path after identity pairing (%s)', async order => {
    const renamed = canonical.replace(/\.md$/, ' Renamed.md');
    const before = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(canonical) as { id: string };
    renameSync(join(vaultPath, canonical), join(vaultPath, renamed));
    // Deliver both possible event orders; the real watcher debounce must allow
    // the unlink to be stashed before processing the add and pairing identity.
    for (const event of order === 'unlink first' ? ['unlink', 'add'] : ['add', 'unlink']) {
      watcher.emit(event, join(vaultPath, event === 'unlink' ? canonical : renamed));
    }

    await vi.waitFor(() => {
      expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(renamed)).toEqual(before);
      expect(existsSync(join(vaultPath, canonical))).toBe(true);
    }, { timeout: 3000 });
    const regenerated = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(canonical) as { id: string };
    expect(regenerated.id).not.toBe(before.id);
    expect(readFileSync(join(vaultPath, renamed), 'utf8')).toBe(authored);
    expect(readFileSync(join(vaultPath, canonical), 'utf8')).toContain('backupKeep: 3');
    expect(service.engine().backupKeep).toBe(3);
  });
});
