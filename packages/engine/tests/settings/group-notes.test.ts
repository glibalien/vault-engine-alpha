import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { descriptorsFor, normalizeModelRef, settingsNotePath, settingsNotesOf } from '@vault/settings-registry';
import type { SettingsDomain } from '@vault/settings-registry';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { noteFor, notePathFor, notePathsOf } from '../helpers/settings-notes.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { writeSettingsNotes } from '../../src/settings/note.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let service: SettingsService; let ingest: SettingsIngest; let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new SettingsService(db, { settingsDir: 'Settings' });
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  ingest = new SettingsIngest({ db, writeLock, vaultPath, service });
});
afterEach(() => { cleanup(); setSettingsChangeHook(null); vi.restoreAllMocks(); });

const deps = () => ({ db, writeLock, vaultPath, service });
const read = (relPath: string): string => readFileSync(join(vaultPath, relPath), 'utf8');
const fields = (relPath: string): Map<string, unknown> => parseFrontmatter(read(relPath)).fields;
function write(relPath: string, content: string): void {
  const abs = join(vaultPath, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('settings notes by area (#746)', () => {
  it('writes each Curator and Engine note with exactly its own keys, documented in its order', () => {
    service.applyPatch('curator', { dailyBudgetCents: 900, model: '[[Qwen 3.7 Plus]]' });
    writeSettingsNotes(deps(), 'curator');
    writeSettingsNotes(deps(), 'engine');
    for (const domain of ['curator', 'engine'] as const) {
      for (const note of settingsNotesOf(domain)) {
        const relPath = settingsNotePath('Settings', note);
        const parsed = parseFrontmatter(read(relPath));
        expect(parsed.parseError).toBeNull();
        // Frontmatter is in the renderer's key order; the documentation follows the note's.
        for (const key of parsed.fields.keys()) if (key !== 'types') expect(note.keys).toContain(key);
        const documented = [...parsed.body.matchAll(/^### (\S+)$/gm)].map(m => m[1]);
        expect(documented).toEqual(note.keys);
        // A key with a value is always written; only null ones may be left out.
        const effective = service.effective(domain);
        for (const key of note.keys) if (effective[key] !== null) expect(parsed.fields.has(key), key).toBe(true);
        expect(parsed.body).toContain(note.summary!);
        expect(db.prepare('SELECT title FROM nodes WHERE file_path = ?').get(relPath)).toMatchObject({ title: note.group });
      }
    }
    expect(fields(notePathFor('curator', 'dailyBudgetCents')).get('dailyBudgetCents')).toBe(900);
    expect(normalizeModelRef(fields(notePathFor('curator', 'model')).get('model'))).toBe('Qwen 3.7 Plus');
    // No single note, and no old vault names in frontmatter.
    expect(existsSync(join(vaultPath, 'Settings/Curator.md'))).toBe(false);
    expect(fields(notePathFor('curator')).has('activeStatuses')).toBe(false);
  });

  it('links each group note to its siblings and lists the old vault names on the first note only', () => {
    writeSettingsNotes(deps(), 'curator');
    const general = read('Settings/Curator/General.md');
    expect(general).toContain('**General** · [[Settings/Curator/Models|Models]] · [[Settings/Curator/Wikis|Wikis]]');
    expect(general).toContain('## Set in Vault.md');
    expect(general).toContain('- activeStatuses: Vault.md projectActiveStatuses');
    const models = read('Settings/Curator/Models.md');
    expect(models).toContain('[[Settings/Curator/General|General]] · **Models**');
    expect(models).not.toContain('## Set in Vault.md');
    expect(models).toContain('### wikiHomeMaxTokens');
    expect(models).not.toContain('### dailyBudgetCents');
  });

  it('reads one note as a snapshot of its own keys and leaves the other notes\' settings alone', () => {
    service.applyPatch('curator', { dailyBudgetCents: 900, wikiHomeMaxTokens: 32000, linkSweepNoteCap: 150 });
    writeSettingsNotes(deps(), 'curator');
    const relPath = notePathFor('curator', 'dailyBudgetCents');
    // An edit to the General note: one value changed, sweepAt's line deleted (a reset).
    write(relPath, '---\ndailyBudgetCents: 700\ntz: America/New_York\n---\n');
    ingest.onFileEvent(relPath, 'change');
    const stored = service.stored('curator');
    expect(stored).toMatchObject({ dailyBudgetCents: 700, tz: 'America/New_York', wikiHomeMaxTokens: 32000, linkSweepNoteCap: 150 });
    expect(service.issues('curator')).toEqual([]);
    // Write-back puts every General key back and nothing else.
    expect(fields(relPath).get('sweepAt')).toBe('05:00');
    expect(fields(relPath).has('wikiHomeMaxTokens')).toBe(false);
  });

  it('does not apply a key typed into the wrong note, and says which note holds it', () => {
    writeSettingsNotes(deps(), 'curator');
    const relPath = notePathFor('curator', 'dailyBudgetCents');
    write(relPath, `${read(relPath).replace('---\n', '---\nwikiHomeMaxTokens: 1234\n')}`);
    ingest.onFileEvent(relPath, 'change');
    expect(service.effective('curator')['wikiHomeMaxTokens']).not.toBe(1234);
    const issue = service.issues('curator').find(i => i.key === 'wikiHomeMaxTokens');
    expect(issue?.code).toBe('SETTINGS_UNKNOWN_KEY');
    expect(issue?.message).toContain('Settings/Curator/Models.md');
    // Kept as typed, with the warning in that note only.
    expect(fields(relPath).get('wikiHomeMaxTokens')).toBe(1234);
    expect(read(relPath)).toContain('> [!warning] Settings issues');
    expect(service.noteIssues(noteFor('curator', 'wikiHomeMaxTokens'))).toEqual([]);
  });

  it('drops an old vault name that mirrors the vault map, and reports one that differs', () => {
    writeSettingsNotes(deps(), 'wiki');
    const before = service.version('vault');
    // A Wiki.md from before #746 carried the vault keys under their old names.
    write('Settings/Wiki.md', `${read('Settings/Wiki.md').replace('---\n', '---\nstatusField: status\nwikiDir: Wikis\n')}`);
    ingest.onFileEvent('Settings/Wiki.md', 'change');
    expect(service.issues('wiki')).toEqual([]);
    expect(fields('Settings/Wiki.md').has('statusField')).toBe(false);
    expect(fields('Settings/Wiki.md').has('wikiDir')).toBe(false);
    // A changed one is not applied (Vault.md is where it is set) and stays as typed.
    write('Settings/Wiki.md', `${read('Settings/Wiki.md').replace('---\n', '---\nstatusField: state\n')}`);
    ingest.onFileEvent('Settings/Wiki.md', 'change');
    expect(service.vault().taskStatusField).toBe('status');
    expect(service.version('vault')).toBe(before);
    const issue = service.issues('wiki').find(i => i.key === 'statusField');
    expect(issue?.message).toContain('Settings/Vault.md as taskStatusField');
    expect(fields('Settings/Wiki.md').get('statusField')).toBe('state');
  });

  it('keeps a patch\'s issues in the notes it writes', () => {
    writeSettingsNotes(deps(), 'curator');
    const general = notePathFor('curator', 'dailyBudgetCents');
    write(general, `${read(general).replace(/dailyBudgetCents: \d+/, 'dailyBudgetCents: lots')}`);
    ingest.onFileEvent(general, 'change');
    expect(service.noteIssues(noteFor('curator', 'dailyBudgetCents')).map(i => i.key)).toEqual(['dailyBudgetCents']);
    const result = service.applyPatch('curator', { wikiHomeMaxTokens: -5 });
    expect(result.issues.map(i => i.key)).toEqual(['wikiHomeMaxTokens']);
    expect(service.noteIssues(noteFor('curator', 'wikiHomeMaxTokens')).map(i => i.key)).toEqual(['wikiHomeMaxTokens']);
    // The General note's own issue is untouched by a patch that wrote no General key.
    expect(service.noteIssues(noteFor('curator', 'dailyBudgetCents')).map(i => i.key)).toEqual(['dailyBudgetCents']);
    expect(service.issues('curator').map(i => i.key).sort()).toEqual(['dailyBudgetCents', 'wikiHomeMaxTokens']);
  });

  it('regenerates a deleted group note from the store', () => {
    service.applyPatch('engine', { backupKeep: 3 });
    writeSettingsNotes(deps(), 'engine');
    const relPath = notePathFor('engine', 'backupKeep');
    expect(relPath).toBe('Settings/Engine/Backups and retention.md');
    unlinkSync(join(vaultPath, relPath));
    ingest.onFileEvent(relPath, 'unlink');
    expect(fields(relPath).get('backupKeep')).toBe(3);
    expect(service.engine().backupKeep).toBe(3);
  });

  it('treats every group note as a settings note and nothing at the old paths', () => {
    for (const relPath of [...notePathsOf('curator'), ...notePathsOf('engine')]) {
      expect(ingest.handles(relPath)).not.toBeNull();
    }
    expect(ingest.handles('Settings/Curator.md')).toBeNull();
    expect(ingest.handles('Settings/Engine.md')).toBeNull();
    expect(ingest.handles('Settings/Wiki.md')).toBe('wiki');
    expect(ingest.noteAt('Settings/Engine/Provenance.md')?.group).toBe('Provenance');
  });
});

describe('retiring the single Curator and Engine notes (#746)', () => {
  /** The single note as the Engine wrote it before #746: every key, old vault names too. */
  function writeFlatNote(domain: SettingsDomain, overrides: Record<string, unknown> = {}): string {
    const relPath = `Settings/${domain === 'curator' ? 'Curator' : 'Engine'}.md`;
    const modelRefs = new Set(descriptorsFor(domain).filter(d => d.type.kind === 'model-ref').map(d => d.key));
    const values = Object.fromEntries(Object.entries(service.effectiveWithAliases(domain)).map(([key, value]) =>
      [key, modelRefs.has(key) && typeof value === 'string' ? `[[${normalizeModelRef(value)}]]` : value]));
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: relPath, title: relPath.slice(9, -3), types: [],
      fields: { ...values, ...overrides }, body: '## Keys\n\nThe old single note.\n', canonicalizeLinks: false,
    });
    return relPath;
  }

  it('removes a single note that holds only stored values and writes the folder', () => {
    service.applyPatch('curator', { dailyBudgetCents: 900, model: '[[Qwen 3.7 Plus]]', memorySweepTypes: ['meeting'] });
    service.applyPatch('engine', { backupKeep: 3, excludeDirs: ['Templates'] });
    const curator = writeFlatNote('curator');
    const engine = writeFlatNote('engine');
    const versions = { curator: service.version('curator'), engine: service.version('engine') };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    ingest.reconcile();
    for (const relPath of [curator, engine]) {
      expect(existsSync(join(vaultPath, relPath))).toBe(false);
      expect(db.prepare('SELECT 1 FROM nodes WHERE file_path = ?').get(relPath)).toBeUndefined();
    }
    expect(log.mock.calls.flat().join('\n')).toContain('removed Settings/Curator.md');
    // Nothing changed in the store; the folder's notes show it.
    expect(service.version('curator')).toBe(versions.curator);
    expect(service.version('engine')).toBe(versions.engine);
    expect(fields(notePathFor('curator', 'dailyBudgetCents')).get('dailyBudgetCents')).toBe(900);
    expect(fields(notePathFor('engine', 'backupKeep')).get('backupKeep')).toBe(3);
    expect(fields(notePathFor('engine', 'excludeDirs')).get('excludeDirs')).toEqual(['Templates']);
    expect(service.issues('curator')).toEqual([]);
  });

  it('takes a change made in the single note while the Engine was stopped, then removes it', () => {
    service.applyPatch('curator', { dailyBudgetCents: 900 });
    const relPath = writeFlatNote('curator', { dailyBudgetCents: 650, linkSweepMode: 'apply' });
    ingest.reconcile();
    expect(service.stored('curator')).toMatchObject({ dailyBudgetCents: 650, linkSweepMode: 'apply' });
    expect(existsSync(join(vaultPath, relPath))).toBe(false);
    expect(fields(notePathFor('curator', 'linkSweepMode')).get('linkSweepMode')).toBe('apply');
  });

  it('keeps a single note holding a refused value, warns, and never reads it again', () => {
    service.applyPatch('engine', { backupKeep: 3 });
    const relPath = writeFlatNote('engine', { backupKeep: 'many', normalizeQuiescenceMinutes: 30 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingest.reconcile();
    expect(existsSync(join(vaultPath, relPath))).toBe(true);
    expect(warn.mock.calls.flat().join('\n')).toContain('these lines were not taken: backupKeep');
    // The rest of it was read; the refused value kept its last-good one.
    expect(service.engine().normalizeQuiescenceMinutes).toBe(30);
    expect(service.engine().backupKeep).toBe(3);
    expect(service.issues('engine')).toEqual([]);
    // It is an ordinary note now: a later edit there changes nothing.
    write(relPath, '---\nnormalizeQuiescenceMinutes: 5\n---\n');
    ingest.onFileEvent(relPath, 'change');
    ingest.reconcile();
    expect(service.engine().normalizeQuiescenceMinutes).toBe(30);
  });

  it('keeps a single note whose old vault name differs from the vault map', () => {
    const relPath = writeFlatNote('curator', { activeStatuses: ['open', 'someday'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingest.reconcile();
    expect(existsSync(join(vaultPath, relPath))).toBe(true);
    expect(warn.mock.calls.flat().join('\n')).toContain('activeStatuses');
    expect(service.vault().projectActiveStatuses).not.toContain('someday');
  });

  it('reads an offline edit to the single note before consumers start, writing no file (Codex, #747)', () => {
    const relPath = writeFlatNote('engine', { extractionEnabled: false });
    const before = read(relPath);
    ingest.importFlatNotes();
    expect(service.engine().extractionEnabled).toBe(false);
    expect(read(relPath)).toBe(before);
    expect(existsSync(join(vaultPath, notePathFor('engine', 'extractionEnabled')))).toBe(false);
    // Reconcile then writes the folder and retires the note.
    ingest.reconcile();
    expect(existsSync(join(vaultPath, relPath))).toBe(false);
    expect(fields(notePathFor('engine', 'extractionEnabled')).get('extractionEnabled')).toBe(false);
    // Once retired, the import does nothing more.
    write(relPath, '---\nextractionEnabled: true\n---\n');
    ingest.importFlatNotes();
    expect(service.engine().extractionEnabled).toBe(false);
  });

  it('keeps a single note saved while it is being retired, with a warning, and reads it no more (Codex, #747)', () => {
    service.applyPatch('curator', { dailyBudgetCents: 900 });
    const relPath = writeFlatNote('curator');
    const replace = service.replaceFromFile.bind(service);
    // An editor saves the note right after the Engine read it.
    vi.spyOn(service, 'replaceFromFile').mockImplementationOnce((note, values) => {
      write(relPath, read(relPath).replace(/^dailyBudgetCents: .*$/m, 'dailyBudgetCents: 777'));
      return replace(note, values);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingest.reconcile();
    // The save is kept in the file, named in the log, and not applied.
    expect(read(relPath)).toContain('dailyBudgetCents: 777');
    expect(warn.mock.calls.flat().join('\n')).toContain('saved while it was being retired');
    expect(service.stored('curator')['dailyBudgetCents']).toBe(900);
    expect(fields(notePathFor('curator', 'dailyBudgetCents')).get('dailyBudgetCents')).toBe(900);
    // It is an ordinary note now: the folder's notes stay as they are at the next start.
    ingest.importFlatNotes();
    ingest.reconcile();
    expect(service.stored('curator')['dailyBudgetCents']).toBe(900);
    expect(existsSync(join(vaultPath, relPath))).toBe(true);
  });

  it('never reads or removes a single note outside the vault (Codex, #747)', () => {
    const outside = join(vaultPath, '..', `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    try {
      writeFileSync(join(outside, 'Curator.md'), '---\ndailyBudgetCents: 1\n---\n', 'utf8');
      const escaped = new SettingsService(db, { settingsDir: `../${outside.split('/').pop()}` });
      const escapedIngest = new SettingsIngest({ db, writeLock, vaultPath, service: escaped });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      escapedIngest.importFlatNotes();
      (escapedIngest as unknown as { retireFlatNotes(): void }).retireFlatNotes();
      expect(escaped.stored('curator')['dailyBudgetCents']).toBeUndefined();
      expect(existsSync(join(outside, 'Curator.md'))).toBe(true);
      expect(error.mock.calls.flat().join('\n')).toContain('Path traversal blocked');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does nothing on a vault that never had the single notes', () => {
    ingest.reconcile();
    expect(existsSync(join(vaultPath, notePathFor('curator', 'model')))).toBe(true);
    expect(existsSync(join(vaultPath, 'Settings/Curator.md'))).toBe(false);
  });
});
