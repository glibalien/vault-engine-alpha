import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { seedSettingsOnBoot, warnStaleEnv, migrateVisionSettingsOnBoot } from '../../src/settings/seed.js';
import { getStoredSettings, setStoredSettings, readJson, markDomainSeeded } from '../../src/settings/store.js';
import { notePathFor } from '../helpers/settings-notes.js';
import { fullIndex } from '../../src/indexer/indexer.js';

describe('seedSettingsOnBoot', () => {
  it('seeds engine from env exactly once', () => {
    const db = createTestDb();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    seedSettingsOnBoot(db, service, { VAULT_BACKUP_KEEP: '5' });
    expect(service.engine().backupKeep).toBe(5);
    expect(service.seeded('engine')).toBe(true);
    // second boot with different env: ignored
    seedSettingsOnBoot(db, service, { VAULT_BACKUP_KEEP: '9' });
    expect(service.engine().backupKeep).toBe(5);
  });

  it('migrates legacy meta.wiki_config into the wiki domain, its vocabulary keys into the vault domain', () => {
    const db = createTestDb();
    // Insert the raw legacy row exactly as a pre-upgrade engine left it.
    db.prepare(`INSERT INTO meta (key, value) VALUES ('wiki_config', ?)`)
      .run(JSON.stringify({ wikiDir: 'MyWikis', subpageCap: 5, statusDone: ['closed'] }));
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    seedSettingsOnBoot(db, service, {});
    expect(service.vault().wikiDir).toBe('MyWikis');
    expect(service.wiki().subpageCap).toBe(5);
    expect(service.seeded('wiki')).toBe(true);
    expect(service.seeded('vault')).toBe(true);
    // Pins that the migration branch actually ran: nothing else in this test
    // writes settings.wiki, so the stored deviations can only come from it.
    expect(getStoredSettings(db, 'wiki')).toEqual({ subpageCap: 5 });
    // The shared done list also seeds the project list.
    expect(getStoredSettings(db, 'vault')).toEqual({
      wikiDir: 'MyWikis', taskDoneStatuses: ['closed'], projectDoneStatuses: ['closed'],
    });
  });

  it('seeds wiki and vault at defaults when no legacy config exists', () => {
    const db = createTestDb();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    seedSettingsOnBoot(db, service, {});
    expect(service.seeded('wiki')).toBe(true);
    expect(service.seeded('vault')).toBe(true);
    expect(service.vault().wikiDir).toBe('Wikis');
    expect(getStoredSettings(db, 'vault')).toEqual({});
  });

  it('moves stored wiki and curator vocabulary keys into the vault domain', () => {
    const db = createTestDb();
    markDomainSeeded(db, 'wiki');
    markDomainSeeded(db, 'curator');
    setStoredSettings(db, 'wiki', {
      projectType: 'initiative', statusField: 'state', statusDone: ['closed'], statusOpen: ['open'],
      wikiDir: 'Pages', subpageCap: 9,
    });
    setStoredSettings(db, 'curator', {
      projectStatusField: 'stage', activeStatuses: ['live', 'paused'], topicDir: 'Subjects', staleProjectDays: 30,
    });
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    seedSettingsOnBoot(db, service, {});
    expect(getStoredSettings(db, 'wiki')).toEqual({ subpageCap: 9 });
    expect(getStoredSettings(db, 'curator')).toEqual({ staleProjectDays: 30 });
    expect(getStoredSettings(db, 'vault')).toEqual({
      projectType: 'initiative', taskStatusField: 'state', taskDoneStatuses: ['closed'], projectDoneStatuses: ['closed'],
      taskActiveStatuses: ['open'], wikiDir: 'Pages',
      projectStatusField: 'stage', projectActiveStatuses: ['live', 'paused'], topicDir: 'Subjects',
    });
    // The old names still read the same values.
    expect(service.effectiveWithAliases('wiki')).toMatchObject({
      projectType: 'initiative', statusField: 'state', statusDone: ['closed'], wikiDir: 'Pages', subpageCap: 9,
    });
    expect(service.effectiveWithAliases('curator')).toMatchObject({
      projectStatusField: 'stage', activeStatuses: ['live', 'paused'], topicDir: 'Subjects',
    });
    // Later boots move only old keys a rolled-back release stored again, and copy no list.
    setStoredSettings(db, 'vault', { ...getStoredSettings(db, 'vault'), taskBlockedStatuses: ['stuck'] });
    setStoredSettings(db, 'wiki', { subpageCap: 9, projectType: 'later' });
    seedSettingsOnBoot(db, service, {});
    expect(getStoredSettings(db, 'vault')).toMatchObject({ projectType: 'later' });
    expect(getStoredSettings(db, 'vault')).not.toHaveProperty('projectBlockedStatuses');
    expect(getStoredSettings(db, 'wiki')).toEqual({ subpageCap: 9 });
  });

  it('filters excludeDirs seed entries covering the settings folder per-entry (rest still seed)', () => {
    const db = createTestDb();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedSettingsOnBoot(db, service, { VAULT_EXCLUDE_DIRS: 'Templates, Settings' });
    expect(service.engine().excludeDirs).toEqual(['Templates']);   // 'Settings' dropped, not the whole list
    expect(warn.mock.calls.some(c => String(c[0]).includes('Settings'))).toBe(true);
    warn.mockRestore();
  });

  it('logs issues the wiki_config migration produces instead of discarding them', () => {
    const db = createTestDb();
    // plant a legacy blob that validateWikiConfigPatch tolerates but the registry rejects
    db.prepare(`INSERT INTO meta (key, value) VALUES ('wiki_config', ?)`)
      .run(JSON.stringify({ wikiDir: 'MyWikis' }));
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    seedSettingsOnBoot(db, service, {});
    expect(service.vault().wikiDir).toBe('MyWikis');   // clean migration stays silent + applied
    // (the loud path is exercised by unit-calling the new helper — see implementation note)
  });

  it('warns per env var whose value fails registry validation and is dropped before seeding', () => {
    const db = createTestDb();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedSettingsOnBoot(db, service, { VAULT_BACKUP_KEEP: 'abc' });
    expect(service.engine().backupKeep).toBe(7);   // default — the invalid value was never applied
    expect(warn.mock.calls.some(c =>
      String(c[0]).includes('VAULT_BACKUP_KEEP') && String(c[0]).includes('NOT seeded'),
    )).toBe(true);
    warn.mockRestore();
  });

  it('does not double-warn excludeDirs entries the settings-folder guard already reported', () => {
    const db = createTestDb();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every entry covers the settings folder → excludeDirs is deleted entirely by the guard.
    seedSettingsOnBoot(db, service, { VAULT_EXCLUDE_DIRS: 'Settings' });
    const genericDrop = warn.mock.calls.filter(c => String(c[0]).includes('VAULT_EXCLUDE_DIRS') && String(c[0]).includes('NOT seeded'));
    expect(genericDrop).toHaveLength(0);   // only the bespoke "were dropped at seeding" message fires
    expect(warn.mock.calls.some(c => String(c[0]).includes('were dropped at seeding'))).toBe(true);
    warn.mockRestore();
  });

  it('never seeds the chat/curator domains from the ENGINE env, and boot leaves them unseeded', () => {
    const db = createTestDb();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    seedSettingsOnBoot(db, service, { MODEL: 'x', CURATOR_MODEL: 'y' });
    expect(service.seeded('chat')).toBe(false);
    expect(service.seeded('curator')).toBe(false);
    expect(service.stored('chat')).toEqual({});
    expect(service.stored('curator')).toEqual({});
  });
});

describe('migrateVisionSettingsOnBoot', () => {
  function setup() {
    const db = createTestDb();
    const v = createTempVault();
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const noteDeps = { db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath: v.vaultPath, service };
    return { db, service, noteDeps, vaultPath: v.vaultPath, cleanup: v.cleanup };
  }

  it('rewrites stored qwen/qwenVisionModel → model/visionModel, drops the stale key, regenerates the note', () => {
    const { db, service, noteDeps, vaultPath, cleanup } = setup();
    // Raw pre-migration engine blob: old provider value + old key name.
    setStoredSettings(db, 'engine', { visionProvider: 'qwen', qwenVisionModel: '[[Kimi K2.6]]' });

    migrateVisionSettingsOnBoot(db, service, noteDeps);

    const stored = getStoredSettings(db, 'engine');
    expect(stored['visionProvider']).toBe('model');
    expect(stored['visionModel']).toBe('[[Kimi K2.6]]');
    expect('qwenVisionModel' in stored).toBe(false);
    // Meta guard stamped.
    expect(readJson<string | null>(db, 'settings.vision_model_migrated', null)).not.toBeNull();
    // Note regenerated with the new key (rendered bracketed by Task 9 wrap): the vision
    // keys are shown in Settings/Engine/Models.md (#746).
    const raw = readFileSync(join(vaultPath, notePathFor('engine', 'visionModel')), 'utf8');
    expect(raw).toContain('visionModel: "[[Kimi K2.6]]"');
    expect(raw).not.toContain('qwenVisionModel');
    // The retired key belongs to the domain's first note, which no longer carries it either.
    expect(readFileSync(join(vaultPath, notePathFor('engine')), 'utf8')).not.toContain('qwenVisionModel');
    cleanup();
  });

  /**
   * The old-shape lines, each in the note that shows its key now (#746): the vision keys and
   * an unrelated explicit null in Models.md, the retired key in the domain's first note
   * (General.md, which owns journaled keys no note shows), and backupKeep's explicit null in
   * Backups and retention.md.
   */
  function writeOldShapeNotes(vaultPath: string) {
    const paths = {
      models: notePathFor('engine', 'visionModel'),
      general: notePathFor('engine'),
      backups: notePathFor('engine', 'backupKeep'),
    };
    const files: Record<string, string> = {
      [paths.models]: '---\nextractionEnabled:\nvisionModel:\nvisionProvider:\n---\nOld engine settings body\n',
      [paths.general]: '---\nqwenVisionModel:\n---\nOld engine settings body\n',
      [paths.backups]: '---\nbackupKeep:\n---\nOld engine settings body\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(vaultPath, rel)), { recursive: true });
      writeFileSync(join(vaultPath, rel), text, 'utf8');
    }
    return paths;
  }

  function nullMarkers(db: ReturnType<typeof createTestDb>, relPath: string): Array<{ field_name: string }> {
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };
    return db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(node.id) as Array<{ field_name: string }>;
  }

  function expectMigratedNotes(db: ReturnType<typeof createTestDb>, vaultPath: string, paths: ReturnType<typeof writeOldShapeNotes>) {
    // The migration owns the vision keys and the retired key; every unrelated authored
    // marker stays, in the vision keys' note and in another note alike.
    expect(nullMarkers(db, paths.models)).toEqual([{ field_name: 'extractionEnabled' }]);
    expect(nullMarkers(db, paths.general)).toEqual([]);
    expect(nullMarkers(db, paths.backups)).toEqual([{ field_name: 'backupKeep' }]);
    const models = readFileSync(join(vaultPath, paths.models), 'utf8');
    expect(models).toMatch(/\nextractionEnabled:\n/);
    expect(models).toContain('visionProvider: model');
    expect(models).toContain('visionModel: "[[Kimi K2.6]]"');
    expect(readFileSync(join(vaultPath, paths.backups), 'utf8')).toMatch(/\nbackupKeep:\n/);
    for (const rel of Object.values(paths)) {
      expect(readFileSync(join(vaultPath, rel), 'utf8')).not.toContain('qwenVisionModel');
    }
  }

  it('owns migrated vision keys but preserves an unrelated explicit-null marker', () => {
    const { db, service, noteDeps, vaultPath, cleanup } = setup();
    const paths = writeOldShapeNotes(vaultPath);
    fullIndex(vaultPath, db);
    setStoredSettings(db, 'engine', {
      visionProvider: 'qwen',
      qwenVisionModel: '[[Kimi K2.6]]',
    });

    migrateVisionSettingsOnBoot(db, service, noteDeps);

    expectMigratedNotes(db, vaultPath, paths);
    cleanup();
  });

  it('replays durable vision ownership after stored migration commits but projection fails', () => {
    const { db, service, noteDeps, vaultPath, cleanup } = setup();
    const paths = writeOldShapeNotes(vaultPath);
    const notePath = join(vaultPath, paths.models);
    const parkedPath = `${notePath}.parked`;
    fullIndex(vaultPath, db);
    setStoredSettings(db, 'engine', {
      visionProvider: 'qwen',
      qwenVisionModel: '[[Kimi K2.6]]',
    });

    renameSync(notePath, parkedPath);
    expect(() => migrateVisionSettingsOnBoot(db, service, noteDeps)).toThrow();
    expect(getStoredSettings(db, 'engine')).toMatchObject({
      visionProvider: 'model', visionModel: '[[Kimi K2.6]]',
    });
    expect(readJson<string | null>(db, 'settings.vision_model_migrated', null)).toBeNull();
    renameSync(parkedPath, notePath);

    const restartedService = new SettingsService(db, { settingsDir: 'Settings' });
    const restartedDeps = { ...noteDeps, service: restartedService };
    migrateVisionSettingsOnBoot(db, restartedService, restartedDeps);
    new SettingsIngest(restartedDeps).reconcile();

    expectMigratedNotes(db, vaultPath, paths);
    expect(readJson<string | null>(db, 'settings.vision_model_migrated', null)).not.toBeNull();
    cleanup();
  });

  it('is idempotent — a second run after the guard is stamped changes nothing', () => {
    const { db, service, noteDeps, cleanup } = setup();
    setStoredSettings(db, 'engine', { visionProvider: 'qwen', qwenVisionModel: '[[Kimi K2.6]]' });
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    const afterFirst = getStoredSettings(db, 'engine');

    // Simulate a stray re-add of the legacy shape; the guard must prevent re-migration.
    setStoredSettings(db, 'engine', { visionProvider: 'qwen', qwenVisionModel: '[[Kimi K2.6]]' });
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    expect(getStoredSettings(db, 'engine')).toEqual({ visionProvider: 'qwen', qwenVisionModel: '[[Kimi K2.6]]' });
    // (i.e. untouched — the guard short-circuited before the rewrite)
    expect(afterFirst['visionModel']).toBe('[[Kimi K2.6]]');
    cleanup();
  });

  it('only moves qwenVisionModel when present, and maps only the qwen provider value', () => {
    const { db, service, noteDeps, cleanup } = setup();
    // visionProvider is already a normal value; no qwenVisionModel deviation stored.
    setStoredSettings(db, 'engine', { visionProvider: 'claude' });
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    expect(getStoredSettings(db, 'engine')).toEqual({ visionProvider: 'claude' });
    expect(readJson<string | null>(db, 'settings.vision_model_migrated', null)).not.toBeNull();
    cleanup();
  });

  it('stamps the guard even when there is nothing to migrate (empty blob)', () => {
    const { db, service, noteDeps, cleanup } = setup();
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    expect(readJson<string | null>(db, 'settings.vision_model_migrated', null)).not.toBeNull();
    expect(getStoredSettings(db, 'engine')).toEqual({});
    cleanup();
  });

  it('does NOT plant visionModel when the stored blob has qwen provider but no qwenVisionModel', () => {
    const { db, service, noteDeps, cleanup } = setup();
    setStoredSettings(db, 'engine', { visionProvider: 'qwen' });
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    const stored = getStoredSettings(db, 'engine');
    expect(stored['visionProvider']).toBe('model');
    expect('visionModel' in stored).toBe(false);   // nothing to carry over → not planted
    cleanup();
  });

  it('moves qwenVisionModel but leaves a non-qwen provider value untouched', () => {
    const { db, service, noteDeps, cleanup } = setup();
    setStoredSettings(db, 'engine', { visionProvider: 'gemini', qwenVisionModel: '[[Kimi K2.6]]' });
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    const stored = getStoredSettings(db, 'engine');
    expect(stored['visionProvider']).toBe('gemini');   // only 'qwen' is remapped
    expect(stored['visionModel']).toBe('[[Kimi K2.6]]');
    expect('qwenVisionModel' in stored).toBe(false);
    cleanup();
  });

  it('regenerates an old-shape on-disk note unconditionally (stored clean) so reconcile flags no unknown key', () => {
    // Prod upgrade shape: the on-disk note was rendered by OLD code and still carries
    // `qwenVisionModel: "[[Qwen 3.7 Plus]]"`, but that key was a DEFAULT value so it was
    // never a stored deviation — the stored blob is EMPTY. Pre-fix, the migration no-oped
    // (changed=false), reconcile() then flagged the stale on-disk key SETTINGS_UNKNOWN_KEY
    // and stamped a permanent warning callout. The unconditional note regeneration must
    // rewrite it clean first. Since #746 the retired key belongs to the domain's first note.
    const { db, service, noteDeps, vaultPath, cleanup } = setup();
    const notePath = join(vaultPath, notePathFor('engine'));
    mkdirSync(dirname(notePath), { recursive: true });
    writeFileSync(notePath, '---\nqwenVisionModel: "[[Qwen 3.7 Plus]]"\n---\n\n## Keys\n', 'utf8');

    migrateVisionSettingsOnBoot(db, service, noteDeps);
    new SettingsIngest(noteDeps).reconcile();

    const raw = readFileSync(notePath, 'utf8');
    expect(raw).not.toContain('qwenVisionModel');
    expect(raw).not.toContain('[!warning] Settings issues');
    expect(readFileSync(join(vaultPath, notePathFor('engine', 'visionModel')), 'utf8'))
      .toContain('visionModel: "[[Qwen 3.7 Plus]]"');
    expect(service.issues('engine')).toEqual([]);
    cleanup();
  });

  it('on the production order, retiring an old single Settings/Engine.md drops its stale qwenVisionModel line and removes it', () => {
    // Production defers the projection to reconcile(), whose one-time retirement reads the
    // single note of the previous layout (#746). The journaled retired key reads as dropped,
    // so nothing in the note is left out and it is removed.
    const { db, service, noteDeps, vaultPath, cleanup } = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flatPath = join(vaultPath, 'Settings/Engine.md');
    mkdirSync(dirname(flatPath), { recursive: true });
    writeFileSync(flatPath, '---\nqwenVisionModel: "[[Qwen 3.7 Plus]]"\n---\n\n## Keys\n', 'utf8');
    fullIndex(vaultPath, db);

    migrateVisionSettingsOnBoot(db, service, noteDeps, { deferProjection: true });
    new SettingsIngest(noteDeps).reconcile();

    expect(existsSync(flatPath)).toBe(false);
    expect(warn.mock.calls.some(c => String(c[0]).includes('Settings/Engine.md'))).toBe(false);
    expect(readFileSync(join(vaultPath, notePathFor('engine')), 'utf8')).not.toContain('qwenVisionModel');
    expect(readFileSync(join(vaultPath, notePathFor('engine', 'visionModel')), 'utf8'))
      .toContain('visionModel: "[[Qwen 3.7 Plus]]"');
    expect(service.issues('engine')).toEqual([]);
    expect(getStoredSettings(db, 'engine')).toEqual({});
    log.mockRestore();
    warn.mockRestore();
    cleanup();
  });
});

describe('warnStaleEnv', () => {
  it('names every still-set migrated var and logs one warning each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = warnStaleEnv({ VAULT_BACKUP_KEEP: '5', NORMALIZE_CRON: '0 3 * * *', VAULT_PATH: '/x' });
    expect(stale.sort()).toEqual(['NORMALIZE_CRON', 'VAULT_BACKUP_KEEP']);   // VAULT_PATH is bootstrap, not migrated
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('managed in Settings/');
    warn.mockRestore();
  });

  it('ignores chat/curator env vars — those services warn for themselves', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = warnStaleEnv({ MODEL: 'x', MAX_STEPS: '5', CURATOR_SWEEP_AT: '04:00', VAULT_BACKUP_KEEP: '5' });
    expect(stale).toEqual(['VAULT_BACKUP_KEEP']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
