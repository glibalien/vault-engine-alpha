import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { descriptorsFor, settingsNotePath, settingsNotesOf } from '@vault/settings-registry';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { noteFor, notePathFor } from '../helpers/settings-notes.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { writeSettingsNote, writeSettingsNotes } from '../../src/settings/note.js';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';
import { processFileChange } from '../../src/sync/watcher.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let service: SettingsService; let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new SettingsService(db, { settingsDir: 'Settings' });
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
});
afterEach(() => cleanup());

const deps = () => ({ db, writeLock, vaultPath, service });
/** Settings/Engine/Backups and retention.md, the note that shows backupKeep. */
const BACKUPS = noteFor('engine', 'backupKeep');
const BACKUPS_PATH = notePathFor('engine', 'backupKeep');

describe('writeSettingsNote', () => {
  it('materializes each engine group note with exactly its keys, effective values and doc body', () => {
    service.applyPatch('engine', { backupKeep: 3 });
    writeSettingsNotes(deps(), 'engine');
    const engineKeys = descriptorsFor('engine').map(d => d.key);
    for (const note of settingsNotesOf('engine')) {
      const raw = readFileSync(join(vaultPath, settingsNotePath('Settings', note)), 'utf8');
      const parsed = parseFrontmatter(raw);
      expect(parsed.parseError).toBeNull();
      // No engine key defaults to null, so each note holds exactly the keys it shows.
      expect([...parsed.fields.keys()].sort()).toEqual([...note.keys].sort());
      expect(parsed.body).toContain('## Keys');
      for (const key of engineKeys) {
        if (note.keys.includes(key)) expect(parsed.body).toContain(`### ${key}\n`);
        else expect(parsed.body).not.toContain(`### ${key}\n`);
      }
      expect(parsed.body).toContain('engine-owned documentation');
      expect(parsed.body).not.toContain('[!warning]');             // no issues
    }
    const parsed = parseFrontmatter(readFileSync(join(vaultPath, BACKUPS_PATH), 'utf8'));
    expect(parsed.fields.get('backupKeep')).toBe(3);
    expect(parsed.fields.get('backupIntervalHours')).toBe(24);   // default materialized
    expect(parsed.fields.get('backupsEnabled')).toBe(true);
  });

  it('renders an issues callout when the service holds issues', () => {
    service.replaceFromFile(BACKUPS, { backupKeep: 'bogus' });
    writeSettingsNote(deps(), BACKUPS);
    const raw = readFileSync(join(vaultPath, BACKUPS_PATH), 'utf8');
    expect(raw).toContain('> [!warning] Settings issues');
    expect(raw).toContain('**backupKeep**');
    // The issue is that note's: another engine note shows no callout.
    writeSettingsNote(deps(), noteFor('engine', 'excludeDirs'));
    expect(readFileSync(join(vaultPath, notePathFor('engine', 'excludeDirs')), 'utf8'))
      .not.toContain('[!warning] Settings issues');
  });

  it('is idempotent: second write leaves the same bytes and node version', () => {
    for (const note of settingsNotesOf('engine')) {
      const relPath = settingsNotePath('Settings', note);
      writeSettingsNote(deps(), note);
      const path = join(vaultPath, relPath);
      const first = readFileSync(path, 'utf8');
      const v1 = (db.prepare('SELECT version FROM nodes WHERE file_path = ?')
        .get(relPath) as { version: number }).version;
      writeSettingsNote(deps(), note);
      expect(readFileSync(path, 'utf8')).toBe(first);
      const v2 = (db.prepare('SELECT version FROM nodes WHERE file_path = ?')
        .get(relPath) as { version: number }).version;
      expect(v2).toBe(v1);
    }
  });

  it('creates a node row (settings notes are ordinary indexed nodes)', () => {
    writeSettingsNote(deps(), noteFor('wiki'));
    expect(existsSync(join(vaultPath, 'Settings/Wiki.md'))).toBe(true);
    const row = db.prepare('SELECT title FROM nodes WHERE file_path = ?').get('Settings/Wiki.md');
    expect(row).toMatchObject({ title: 'Wiki' });
  });

  it('clears stale explicit-null markers only for non-null fields in a canonical tool projection', () => {
    // Two keys of one note, Settings/Curator/Models.md: a non-null one the projection
    // touches, and one left at null that it does not.
    const models = noteFor('curator', 'memorySweepMaxTokens');
    expect(models.keys).toContain('memorySweepModel');
    service.applyPatch('curator', { memorySweepMaxTokens: 1200 });
    writeSettingsNote(deps(), models);

    const relPath = notePathFor('curator', 'memorySweepMaxTokens');
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\nmemorySweepMaxTokens:\nmemorySweepModel:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(node.id)).toEqual([
      { field_name: 'memorySweepMaxTokens' },
      { field_name: 'memorySweepModel' },
    ]);

    writeSettingsNote(deps(), models, undefined, { touchedFields: ['memorySweepMaxTokens'] });

    expect(service.effective('curator')).toMatchObject({ memorySweepMaxTokens: 1200, memorySweepModel: null });
    const parsed = parseFrontmatter(readFileSync(absPath, 'utf8'));
    expect(parsed.fields.get('memorySweepMaxTokens')).toBe(1200);
    expect(parsed.fields.get('memorySweepModel')).toBeNull();
    expect(db.prepare(
      'SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(node.id, 'memorySweepMaxTokens')).toEqual({ value_number: 1200 });
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(node.id)).toEqual([{ field_name: 'memorySweepModel' }]);
  });

  it('preserves an unrelated non-null projection marker when the caller owns only one field', () => {
    service.applyPatch('engine', { backupKeep: 4, backupIntervalHours: 12 });
    writeSettingsNote(deps(), BACKUPS);

    const relPath = BACKUPS_PATH;
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\nbackupIntervalHours:\nbackupKeep:\n---\n', 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };
    writeSettingsNote(deps(), BACKUPS, undefined, { touchedFields: ['backupKeep'] });

    const parsed = parseFrontmatter(readFileSync(absPath, 'utf8'));
    expect(parsed.fields.get('backupIntervalHours')).toBeNull();
    expect(parsed.fields.get('backupKeep')).toBe(4);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(node.id)).toEqual([{ field_name: 'backupIntervalHours' }]);
  });

  it('commits a marker-only repair once when the canonical file and value already match', () => {
    service.applyPatch('engine', { backupKeep: 4 });
    writeSettingsNote(deps(), BACKUPS, undefined, { touchedFields: ['backupKeep'] });

    const relPath = BACKUPS_PATH;
    const absPath = join(vaultPath, relPath);
    const canonical = readFileSync(absPath, 'utf8');
    const node = db.prepare(
      'SELECT id, version FROM nodes WHERE file_path = ?',
    ).get(relPath) as { id: string; version: number };
    expect(parseFrontmatter(canonical).fields.get('backupKeep')).toBe(4);
    expect(db.prepare(
      'SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(node.id, 'backupKeep')).toEqual({ value_number: 4 });

    db.prepare(
      'INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)',
    ).run(node.id, 'backupKeep');

    writeSettingsNote(deps(), BACKUPS, undefined, { touchedFields: ['backupKeep'] });

    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
    expect(readFileSync(absPath, 'utf8')).toBe(canonical);
    expect(db.prepare(
      'SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(node.id, 'backupKeep')).toEqual({ value_number: 4 });
    const repairedVersion = (db.prepare(
      'SELECT version FROM nodes WHERE id = ?',
    ).get(node.id) as { version: number }).version;
    expect(repairedVersion).toBe(node.version + 1);

    writeSettingsNote(deps(), BACKUPS);

    expect((db.prepare(
      'SELECT version FROM nodes WHERE id = ?',
    ).get(node.id) as { version: number }).version).toBe(repairedVersion);
    expect(readFileSync(absPath, 'utf8')).toBe(canonical);
  });
});

describe('writeSettingsNote — model-ref render-time [[ref]] wrapping', () => {
  it('renders a stored bare model-ref deviation as a quoted wikilink', () => {
    service.applyPatch('chat', { defaultModel: 'Kimi K2.6' });   // bare, no brackets
    writeSettingsNote(deps(), noteFor('chat'));
    const raw = readFileSync(join(vaultPath, notePathFor('chat')), 'utf8');
    expect(raw).toContain('defaultModel: "[[Kimi K2.6]]"');
    // Presentation only — reading it back still normalizes to the bare title.
    const parsed = parseFrontmatter(raw);
    expect(parsed.fields.get('defaultModel')).toBe('Kimi K2.6');
  });

  it('renders a default-valued (undeviated) model-ref key bracketed too', () => {
    const models = noteFor('engine', 'visionModel');              // Settings/Engine/Models.md
    expect(models.keys).toContain('memoryConsolidationModel');
    writeSettingsNote(deps(), models);
    const raw = readFileSync(join(vaultPath, notePathFor('engine', 'visionModel')), 'utf8');
    expect(raw).toContain('visionModel: "[[Qwen 3.7 Plus]]"');
    expect(raw).toContain('memoryConsolidationModel: "[[Qwen 3.7 Plus]]"');
  });

  it('writes a changed model-ref after the note was ingested, not the ingested old ref', () => {
    // The watcher stores the file's "[[Kimi K2.6]]" as the field's raw text;
    // a later settings change must not render that raw text back over the new value.
    service.applyPatch('chat', { defaultModel: 'Kimi K2.6' });
    writeSettingsNote(deps(), noteFor('chat'));
    const relPath = notePathFor('chat');
    const absPath = join(vaultPath, relPath);
    // A human edit to the note (here: reformatting) is ingested by the watcher.
    writeFileSync(absPath, readFileSync(absPath, 'utf8').replace('defaultModel: "[[Kimi K2.6]]"', 'defaultModel:  "[[Kimi K2.6]]"'), 'utf8');
    processFileChange(absPath, relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    expect(db.prepare(`SELECT f.value_raw_text FROM node_fields f JOIN nodes n ON n.id = f.node_id
      WHERE n.file_path = ? AND f.field_name = 'defaultModel'`).get(relPath)).toEqual({ value_raw_text: '[[Kimi K2.6]]' });

    service.applyPatch('chat', { defaultModel: 'Qwen 3.7 Plus' });
    writeSettingsNote(deps(), noteFor('chat'));
    const raw = readFileSync(absPath, 'utf8');
    expect(raw).toContain('defaultModel: "[[Qwen 3.7 Plus]]"');
    expect(raw).not.toContain('Kimi K2.6');
    expect(parseFrontmatter(raw).fields.get('defaultModel')).toBe('Qwen 3.7 Plus');
  });

  it('a nullable model-ref key left at null renders as today — omitted, no brackets around nothing', () => {
    const models = noteFor('curator', 'memorySweepModel');        // Settings/Curator/Models.md
    expect(models.keys).toContain('orgSweepModel');
    writeSettingsNote(deps(), models);
    const raw = readFileSync(join(vaultPath, notePathFor('curator', 'memorySweepModel')), 'utf8');
    const parsed = parseFrontmatter(raw);
    expect(parsed.parseError).toBeNull();
    expect(parsed.fields.has('memorySweepModel')).toBe(false);
    expect(parsed.fields.has('orgSweepModel')).toBe(false);
  });
});

describe('writeSettingsNote — prompt text documentation', () => {
  it('renders registered prompt defaults in collapsed callouts', () => {
    service.registerPromptDefaults('chat', { chatSystemPrompt: 'Line 1\nLine 2' });
    writeSettingsNote(deps(), noteFor('chat'));
    const raw = readFileSync(join(vaultPath, notePathFor('chat')), 'utf8');
    expect(raw).toContain('### chatSystemPrompt');
    expect(raw).toContain('Default: `""` (blank = built-in)');
    expect(raw).toContain('> [!note]- Built-in default (13 chars)');
    expect(raw).toContain('> Line 1');
    expect(raw).toContain('> Line 2');
  });

  it('renders stale warnings only after a default changes under an override', () => {
    service.registerPromptDefaults('chat', { chatSystemPrompt: 'v1' });
    service.applyPatch('chat', { chatSystemPrompt: 'custom' });
    service.registerPromptDefaults('chat', { chatSystemPrompt: 'v2' });
    writeSettingsNote(deps(), noteFor('chat'));
    const raw = readFileSync(join(vaultPath, notePathFor('chat')), 'utf8');
    expect(raw).toContain('> [!warning] Built-in default has changed');
    expect(raw).toContain('Clear `chatSystemPrompt` in frontmatter');
  });
});
