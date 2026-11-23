import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { writeModelNoteIfAbsent } from '../../src/settings/note.js';
import { registerGetSettings, registerUpdateSettings } from '../../src/mcp/tools/settings.js';
import { registerPromptDefaults } from '../../src/mcp/tools/prompt-defaults.js';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { notePathFor, notePathsOf } from '../helpers/settings-notes.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let service: SettingsService;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new SettingsService(db, { settingsDir: 'Settings' });
});
afterEach(() => cleanup());

function handlers() {
  const captured: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  const fake = {
    tool: (name: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured[name] = (args) => Promise.resolve(h(args));
    },
  } as unknown as McpServer;
  const noteDeps = { db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service };
  const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
  registerGetSettings(fake, service, catalog);
  registerUpdateSettings(fake, service, noteDeps);
  registerPromptDefaults(fake, service, noteDeps);
  return captured;
}

const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

describe('get-settings', () => {
  it('returns all domains without a param, one with', async () => {
    const h = handlers();
    const all = parse(await h['get-settings']({}));
    expect(all.ok).toBe(true);
    expect(all.data.settingsDir).toBe('Settings');
    expect(Object.keys(all.data.domains).sort()).toEqual(['chat', 'curator', 'engine', 'models', 'vault', 'wiki']);
    expect(all.data.domains.engine.effective.backupKeep).toBe(7);
    expect(all.data.domains.engine.version).toBe(0);
    expect(all.data.domains.engine.seeded).toBe(false);
    const one = parse(await h['get-settings']({ domain: 'wiki' }));
    expect(one.data.settingsDir).toBe('Settings');
    expect(Object.keys(one.data.domains)).toEqual(['wiki']);
  });

  it('serves the models pseudo-domain with catalog, providers, version, issues', async () => {
    const h = handlers();
    const noteDeps = { db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service };
    writeModelNoteIfAbsent(noteDeps, {
      title: 'Test Model', provider: 'fireworks', model: 'accounts/fireworks/models/test', enabled: true,
    });

    const r = parse(await h['get-settings']({ domain: 'models' }));
    expect(r.ok).toBe(true);
    expect(r.data.domains.models.catalog).toEqual([
      { title: 'Test Model', provider: 'fireworks', model: 'accounts/fireworks/models/test', enabled: true },
    ]);
    expect(r.data.domains.models.providers).toEqual({ fireworks: false, anthropic: false, gemini: false, openrouter: false, openai: false });
    expect(r.data.domains.models.version).toBe(0);
    expect(r.data.domains.models.issues).toEqual([]);

    const all = parse(await h['get-settings']({}));
    expect(Object.keys(all.data.domains).sort()).toEqual(['chat', 'curator', 'engine', 'models', 'vault', 'wiki']);
    expect(all.data.domains.models.catalog).toHaveLength(1);
  });

  it('serves the fallback instead of an INTERNAL_ERROR when stored settings are corrupted', async () => {
    // Since the settings/store.ts JSON guard (Phase 2 follow-up), a malformed
    // meta row is swallowed at the store layer — logged loudly, served as {}
    // — so it never reaches this tool's try/catch as a thrown error.
    const h = handlers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.prepare(`INSERT INTO meta (key, value) VALUES ('settings.engine', 'not json{{{')`).run();
    const r = parse(await h['get-settings']({ domain: 'engine' }));
    expect(r.ok).toBe(true);
    expect(r.data.domains.engine.effective.backupKeep).toBe(7);   // registry default; corrupt row served as {}
    expect(err).toHaveBeenCalled();   // domainPayload reads the corrupt row more than once (effective + stored)
    err.mockRestore();
  });
});

describe('update-settings', () => {
  it('applies a patch, writes the note, returns warnings for rejected keys', async () => {
    const h = handlers();
    const r = parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3, bogusKey: 1, backupIntervalHours: 0 } }));
    expect(r.ok).toBe(true);
    expect(r.data.applied).toEqual(['backupKeep']);
    expect(r.data.effective.backupKeep).toBe(3);
    expect(r.data.version).toBe(1);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.map((w: { code: string }) => w.code).sort())
      .toEqual(['SETTINGS_INVALID_VALUE', 'SETTINGS_UNKNOWN_KEY']);
    // The note that shows backupKeep is written (#746); the old single note is not.
    expect(existsSync(join(vaultPath, notePathFor('engine', 'backupKeep')))).toBe(true);
    expect(existsSync(join(vaultPath, 'Settings/Engine.md'))).toBe(false);
  });

  it('keeps an empty string list empty in storage, the note, and a reload (#454)', async () => {
    // The installer writes curator.activeStatuses: [] when it can't tell which statuses are active.
    const h = handlers();
    const r = parse(await h['update-settings']({ domain: 'curator', patch: { activeStatuses: [] } }));
    expect(r.ok).toBe(true);
    expect(r.data.applied).toEqual(['activeStatuses']);
    expect(r.data.stored.activeStatuses).toEqual([]);
    expect(r.data.effective.activeStatuses).toEqual([]);
    // The curator notes no longer show vault keys under their old names (#746): the list is
    // in Settings/Vault.md, under the vault key.
    const vaultNote = parseFrontmatter(readFileSync(join(vaultPath, notePathFor('vault')), 'utf8'));
    expect(vaultNote.fields.get('projectActiveStatuses')).toEqual([]);
    for (const relPath of notePathsOf('curator')) {
      if (!existsSync(join(vaultPath, relPath))) continue;
      expect(parseFrontmatter(readFileSync(join(vaultPath, relPath), 'utf8')).fields.has('activeStatuses')).toBe(false);
    }

    service = new SettingsService(db, { settingsDir: 'Settings' });
    new SettingsIngest({
      db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service,
    }).reconcile();
    // activeStatuses is an alias of the vault map's projectActiveStatuses (#444).
    expect(service.effectiveWithAliases('curator')['activeStatuses']).toEqual([]);
    expect(service.vault().projectActiveStatuses).toEqual([]);
  });

  it('null resets a key; unknown domain fails', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } });
    const r = parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: null } }));
    expect(r.data.effective.backupKeep).toBe(7);
    const bad = parse(await h['update-settings']({ domain: 'nope', patch: {} }));
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('INVALID_PARAMS');
  });

  it('converges service, Markdown, node fields, and markers after replacing a stale explicit null', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } });

    const relPath = notePathFor('engine', 'backupKeep');
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\nbackupKeep:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);

    const response = parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 4 } }));

    expect(response.ok).toBe(true);
    expect(response.data.effective.backupKeep).toBe(4);
    expect(service.engine().backupKeep).toBe(4);
    expect(parseFrontmatter(readFileSync(absPath, 'utf8')).fields.get('backupKeep')).toBe(4);
    expect(db.prepare(
      'SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(node.id, 'backupKeep')).toEqual({ value_number: 4 });
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('preserves an unrelated explicit-null marker when patching another key', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } });

    const relPath = notePathFor('engine', 'backupKeep');
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\nbackupKeep:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };

    const response = parse(await h['update-settings']({
      domain: 'engine', patch: { backupIntervalHours: 12 },
    }));

    expect(response.ok).toBe(true);
    expect(parseFrontmatter(readFileSync(absPath, 'utf8')).fields.get('backupKeep')).toBeNull();
    expect(parseFrontmatter(readFileSync(absPath, 'utf8')).fields.get('backupIntervalHours')).toBe(12);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);
  });

  it('clears an explicit-null marker when null resets a nullable key', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'curator', patch: { bodyCharCap: 1200 } });

    const relPath = notePathFor('curator', 'bodyCharCap');
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\nbodyCharCap:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };

    const response = parse(await h['update-settings']({ domain: 'curator', patch: { bodyCharCap: null } }));

    expect(response.ok).toBe(true);
    expect(response.data.effective.bodyCharCap).toBeNull();
    expect(parseFrontmatter(readFileSync(absPath, 'utf8')).fields.has('bodyCharCap')).toBe(false);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('a note-write failure after commit returns ok with a warning (change stays live)', async () => {
    // Real trigger: make the folder of the note that shows backupKeep unwritable so the
    // atomic write-back (temp-file → rename into Settings/Engine/) fails with EACCES,
    // exercising the commit-then-note-write isolation. chmod is a no-op as root, so skip there.
    if (process.getuid?.() === 0) return;
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } }); // creates the folder + note
    const settingsDir = join(vaultPath, dirname(notePathFor('engine', 'backupKeep')));
    chmodSync(settingsDir, 0o555); // read-only dir → rename into it fails
    try {
      const r = parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 4 } }));
      expect(r.ok).toBe(true);                       // NOT INTERNAL_ERROR
      expect(r.data.effective.backupKeep).toBe(4);   // commit is live
      expect(r.warnings.map((w: { code: string }) => w.code)).toContain('SETTINGS_NOTE_WRITE_FAILED');
    } finally {
      chmodSync(settingsDir, 0o755);                 // restore so cleanup() can rm the vault
    }
  });

  it('replays failed field ownership on a later unrelated successful update', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } });

    const relPath = notePathFor('engine', 'backupKeep');
    const absPath = join(vaultPath, relPath);
    const parkedPath = `${absPath}.parked`;
    writeFileSync(absPath, '---\nbackupKeep:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };

    renameSync(absPath, parkedPath);
    const failed = parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 4 } }));
    expect(failed.ok).toBe(true);
    expect(failed.warnings.map((w: { code: string }) => w.code)).toContain('SETTINGS_NOTE_WRITE_FAILED');
    renameSync(parkedPath, absPath);

    const retried = parse(await h['update-settings']({
      domain: 'engine', patch: { backupIntervalHours: 12 },
    }));

    expect(retried.ok).toBe(true);
    const parsed = parseFrontmatter(readFileSync(absPath, 'utf8'));
    expect(parsed.fields.get('backupKeep')).toBe(4);
    expect(parsed.fields.get('backupIntervalHours')).toBe(12);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('replays a failed nullable reset before restart reconcile ingests the stale null', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'curator', patch: { bodyCharCap: 1200 } });

    const relPath = notePathFor('curator', 'bodyCharCap');
    const absPath = join(vaultPath, relPath);
    const parkedPath = `${absPath}.parked`;
    writeFileSync(absPath, '---\nbodyCharCap:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };

    renameSync(absPath, parkedPath);
    const failed = parse(await h['update-settings']({ domain: 'curator', patch: { bodyCharCap: null } }));
    expect(failed.warnings.map((w: { code: string }) => w.code)).toContain('SETTINGS_NOTE_WRITE_FAILED');
    renameSync(parkedPath, absPath);

    service = new SettingsService(db, { settingsDir: 'Settings' });
    new SettingsIngest({
      db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service,
    }).reconcile();

    expect(service.effective('curator')['bodyCharCap']).toBeNull();
    expect(parseFrontmatter(readFileSync(absPath, 'utf8')).fields.has('bodyCharCap')).toBe(false);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('replays pending keys while preserving unrelated restart file edits and invalid raw values', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } });

    const relPath = notePathFor('engine', 'backupKeep');
    const absPath = join(vaultPath, relPath);
    const parkedPath = `${absPath}.parked`;
    writeFileSync(absPath, '---\nbackupKeep:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);

    renameSync(absPath, parkedPath);
    const failed = parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 4 } }));
    expect(failed.warnings.map((w: { code: string }) => w.code)).toContain('SETTINGS_NOTE_WRITE_FAILED');
    renameSync(parkedPath, absPath);
    // An unrelated edit to another key of the same note (#746: backupKeep's note) and an
    // unknown key, made while the Engine was stopped.
    writeFileSync(
      absPath,
      '---\nbackupKeep:\neditsLogRetentionDays: 31\nmysteryKey: keep me\n---\nHuman body\n',
      'utf8',
    );

    service = new SettingsService(db, { settingsDir: 'Settings' });
    new SettingsIngest({
      db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service,
    }).reconcile();

    expect(service.engine().backupKeep).toBe(4);
    expect(service.engine().editsLogRetentionDays).toBe(31);
    const raw = readFileSync(absPath, 'utf8');
    expect(parseFrontmatter(raw).fields.get('backupKeep')).toBe(4);
    expect(parseFrontmatter(raw).fields.get('editsLogRetentionDays')).toBe(31);
    expect(raw).toContain('mysteryKey: keep me');
    expect(service.issues('engine')).toEqual([
      expect.objectContaining({ key: 'mysteryKey', code: 'SETTINGS_UNKNOWN_KEY' }),
    ]);
  });

  it('marks the target domain seeded on first successful apply (service-side seeding contract)', async () => {
    const h = handlers();
    expect(service.seeded('chat')).toBe(false);
    await h['update-settings']({ domain: 'chat', patch: { maxSteps: 6 } });
    expect(service.seeded('chat')).toBe(true);
    const r = parse(await h['get-settings']({ domain: 'chat' }));
    expect(r.data.domains.chat.seeded).toBe(true);
    expect(r.data.domains.chat.effective.maxSteps).toBe(6);
  });

  it('marks seeded even when the patch is empty (fresh install with no migrated env vars)', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'curator', patch: {} });
    expect(service.seeded('curator')).toBe(true);
  });

  it('rejects update-settings on the models pseudo-domain', async () => {
    const h = handlers();
    const r = parse(await h['update-settings']({ domain: 'models', patch: {} }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_PARAMS');
    expect(r.error.message).toMatch(/Settings\/Models\//);
  });
});

describe('register-prompt-defaults', () => {
  it('stores defaults, writes the settings note, and warns for non-text keys', async () => {
    const h = handlers();
    const r = parse(await h['register-prompt-defaults']({
      domain: 'chat', defaults: { chatSystemPrompt: 'base prompt', maxSteps: 'bad' },
    }));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ domain: 'chat', applied: ['chatSystemPrompt'], changed: true });
    expect(r.warnings[0]).toMatchObject({ code: 'SETTINGS_UNKNOWN_KEY', field: 'maxSteps' });
    expect(service.promptDefaults('chat')).toEqual({ chatSystemPrompt: 'base prompt' });
    expect(existsSync(join(vaultPath, 'Settings/Chat.md'))).toBe(true);
  });

  it('is idempotent for unchanged defaults and rejects unknown domains', async () => {
    const h = handlers();
    await h['register-prompt-defaults']({ domain: 'chat', defaults: { chatSystemPrompt: 'base prompt' } });
    const same = parse(await h['register-prompt-defaults']({ domain: 'chat', defaults: { chatSystemPrompt: 'base prompt' } }));
    expect(same.ok).toBe(true);
    expect(same.data.changed).toBe(false);
    const bad = parse(await h['register-prompt-defaults']({ domain: 'models', defaults: {} }));
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('INVALID_PARAMS');
  });

  it('changes prompt documentation without clearing an unrelated explicit-null marker', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'chat', patch: { maxSteps: 8 } });

    const relPath = 'Settings/Chat.md';
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\nmaxSteps:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };

    const response = parse(await h['register-prompt-defaults']({
      domain: 'chat', defaults: { chatSystemPrompt: 'base prompt' },
    }));

    expect(response.ok).toBe(true);
    expect(readFileSync(absPath, 'utf8')).toMatch(/\nmaxSteps:\n/);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'maxSteps' }]);
  });
});
