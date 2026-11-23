import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { writeModelNoteIfAbsent } from '../../src/settings/note.js';
import { seedModelsOnBoot } from '../../src/settings/seed.js';
import { setStoredSettings, getStoredSettings } from '../../src/settings/store.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import { notePathsOf } from '../helpers/settings-notes.js';
import { SEED_MODELS } from '@vault/settings-registry';
import type { ModelCatalogEntry } from '@vault/settings-registry';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let writeLock: WriteLockManager; let service: SettingsService;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  service = new SettingsService(db, { settingsDir: 'Settings' });
});
afterEach(() => { cleanup(); setToolWriteHook(null); });

const deps = () => ({ db, writeLock, vaultPath, service });
const catalog = (env: Record<string, string | undefined> = {}) =>
  new ModelCatalog(db, { settingsDir: 'Settings', env });

describe('Models/ ingest wiring', () => {
  it('a Models/ change invalidates + version-bumps and never writes the file back', () => {
    // create a valid note, ingest sees it, then corrupt its frontmatter on disk
    writeModelNoteIfAbsent(deps(), SEED_MODELS[0]!);
    const c = catalog(); const ingest = new SettingsIngest({ ...deps(), service }, c);
    const rel = 'Settings/Models/Qwen 3.7 Plus.md';
    const before = readFileSync(join(vaultPath, rel), 'utf8');
    const v = c.version();
    ingest.onFileEvent(rel, 'change');
    expect(c.version()).toBe(v + 1);
    expect(readFileSync(join(vaultPath, rel), 'utf8')).toBe(before);   // byte-identical: no write-back
  });

  it('unlink of a model note does NOT regenerate it', () => {
    writeModelNoteIfAbsent(deps(), SEED_MODELS[0]!);
    const c = catalog(); const ingest = new SettingsIngest({ ...deps(), service }, c);
    const rel = 'Settings/Models/Qwen 3.7 Plus.md';
    unlinkSync(join(vaultPath, rel));
    ingest.onFileEvent(rel, 'unlink');
    expect(existsSync(join(vaultPath, rel))).toBe(false);
  });

  it('domain notes still round-trip through the Phase 1/2 path untouched', () => {
    const ingest = new SettingsIngest({ ...deps(), service }, catalog());
    ingest.reconcile();
    // The Engine's settings are a folder of notes, one per area (#746).
    for (const rel of notePathsOf('engine')) expect(existsSync(join(vaultPath, rel))).toBe(true);
    expect(existsSync(join(vaultPath, 'Settings/Engine.md'))).toBe(false);
  });
});

describe('writeModelNoteIfAbsent', () => {
  it('creates once with user-ownership footer, then never overwrites', () => {
    expect(writeModelNoteIfAbsent(deps(), SEED_MODELS[3]!)).toBe(true);
    const p = join(vaultPath, 'Settings/Models/Claude Sonnet 4.6.md');
    const created = readFileSync(p, 'utf8');
    expect(created).toContain('provider: anthropic');
    expect(created).toContain("body is yours");
    // user edits the body; a second call must not clobber it
    writeFileSync(p, created.replace('body is yours', 'body is yours\n\nMY NOTES'), 'utf8');
    expect(writeModelNoteIfAbsent(deps(), SEED_MODELS[3]!)).toBe(false);
    expect(readFileSync(p, 'utf8')).toContain('MY NOTES');
  });

  it('keeps a note on disk that the index has not seen yet, and reports it was not written', () => {
    // Saved offline, or a moment ago: the file exists but no node row does.
    const p = join(vaultPath, 'Settings/Models/Claude Sonnet 4.6.md');
    mkdirSync(join(vaultPath, 'Settings/Models'), { recursive: true });
    writeFileSync(p, '---\nprovider: anthropic\nmodel: claude-sonnet-4-6\nenabled: true\n---\nMY NOTES\n');

    expect(writeModelNoteIfAbsent(deps(), SEED_MODELS[3]!)).toBe(false);

    expect(readFileSync(p, 'utf8')).toContain('MY NOTES');
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  it('writes optional capability + pricing fields, round-tripping through catalog assembly', () => {
    const entry: ModelCatalogEntry = {
      title: 'Fancy Vision Model',
      provider: 'openrouter',
      model: 'vendor/fancy-vision',
      enabled: true,
      vision: true,
      tools: true,
      contextLength: 1_000_000,
      pricing: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.25 },
    };
    expect(writeModelNoteIfAbsent(deps(), entry)).toBe(true);

    // Assert via a re-assembled catalog entry (frontmatter → ModelCatalog).
    const assembled = catalog().entries().find(e => e.title === 'Fancy Vision Model')!;
    expect(assembled).toMatchObject({
      provider: 'openrouter',
      model: 'vendor/fancy-vision',
      enabled: true,
      vision: true,
      tools: true,
      contextLength: 1_000_000,
      pricing: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.25 },
    });

    // Body gains a capabilities line; the "body is yours" trailer is preserved verbatim.
    const raw = readFileSync(join(vaultPath, 'Settings/Models/Fancy Vision Model.md'), 'utf8');
    expect(raw).toContain('`vision`');
    expect(raw).toContain('`tools`');
    expect(raw).toContain('1,000,000-token context');
    expect(raw).toContain("*This note's body is yours — the engine never rewrites it.");
  });

  it('omits absent optional fields entirely — never writes nulls', () => {
    // A bare entry (no capabilities/pricing) must not emit vision/tools/price_* keys.
    expect(writeModelNoteIfAbsent(deps(), SEED_MODELS[0]!)).toBe(true);
    const raw = readFileSync(join(vaultPath, `Settings/Models/${SEED_MODELS[0]!.title}.md`), 'utf8');
    expect(raw).not.toMatch(/^vision:/m);
    expect(raw).not.toMatch(/^tools:/m);
    expect(raw).not.toMatch(/^context_length:/m);
    expect(raw).not.toMatch(/^price_input:/m);
    // And no capabilities line in the body.
    expect(raw).not.toContain('-token context');
  });
});

describe('tool-path Models/ catalog invalidation (general fix)', () => {
  it('an executeMutation({source:tool}) write to Settings/Models/X.md bumps version + refreshes entries with NO watcher event', () => {
    const c = catalog();
    // Wire the real seam: pipeline → notifyToolWrite → SettingsIngest.onToolWrite.
    const ingest = new SettingsIngest({ ...deps(), service }, c);
    setToolWriteHook((relPath) => ingest.onToolWrite(relPath));

    // Prime the cache so a stale read would be observable without invalidation.
    expect(c.entries()).toHaveLength(0);
    const versionBefore = c.version();

    // A plain tool-path mutation to a Models/ note — no watcher event, no manual invalidate.
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Settings/Models/Tool Minted.md',
      title: 'Tool Minted', types: [],
      fields: { provider: 'fireworks', model: 'accounts/fireworks/models/tool-minted', enabled: true },
      body: 'seeded for test',
    });

    expect(c.version()).toBe(versionBefore + 1);          // bumped by the seam
    expect(c.entries().map(e => e.title)).toEqual(['Tool Minted']);  // cache refreshed
  });

  it('a tool write OUTSIDE Models/ does not bump the catalog version', () => {
    const c = catalog();
    const ingest = new SettingsIngest({ ...deps(), service }, c);
    setToolWriteHook((relPath) => ingest.onToolWrite(relPath));
    const versionBefore = c.version();
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Notes/Some Note.md',
      title: 'Some Note', types: [], fields: {}, body: 'not a model note',
    });
    expect(c.version()).toBe(versionBefore);
  });
});

describe('seedModelsOnBoot', () => {
  it('creates the seed notes exactly once and stamps the flag', () => {
    seedModelsOnBoot(db, service, deps(), catalog());
    for (const m of SEED_MODELS) expect(existsSync(join(vaultPath, `Settings/Models/${m.title}.md`))).toBe(true);
    const mtimes = SEED_MODELS.map(m => statSync(join(vaultPath, `Settings/Models/${m.title}.md`)).mtimeMs);
    seedModelsOnBoot(db, service, deps(), catalog());   // second boot: no-op
    expect(SEED_MODELS.map(m => statSync(join(vaultPath, `Settings/Models/${m.title}.md`)).mtimeMs)).toEqual(mtimes);
  });

  it('rewrites stored raw ids into refs, creating notes for unknown ids', () => {
    // simulate a Phase 2 store: raw ids as deviations (engine domain key used as the vehicle;
    // the key map is data-driven so this exercises the real rewrite path)
    setStoredSettings(db, 'curator', { model: 'accounts/fireworks/models/deepseek-v4-pro', orgSweepModel: 'accounts/fireworks/models/custom-x' });
    seedModelsOnBoot(db, service, deps(), catalog());
    const stored = getStoredSettings(db, 'curator');
    expect(stored['model']).toBe('[[DeepSeek v4 Pro]]');
    expect(stored['orgSweepModel']).toBe('[[custom-x]]');
    expect(existsSync(join(vaultPath, 'Settings/Models/custom-x.md'))).toBe(true);
    const custom = readFileSync(join(vaultPath, 'Settings/Models/custom-x.md'), 'utf8');
    expect(custom).toContain('provider: fireworks');   // inferred from the id shape
  });

  it('leaves an unindexed note at a migration path alone, and the raw id with it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStoredSettings(db, 'curator', { orgSweepModel: 'accounts/fireworks/models/custom-x' });
    mkdirSync(join(vaultPath, 'Settings/Models'), { recursive: true });
    writeFileSync(join(vaultPath, 'Settings/Models/custom-x.md'), 'my own note\n');

    seedModelsOnBoot(db, service, deps(), catalog());

    expect(readFileSync(join(vaultPath, 'Settings/Models/custom-x.md'), 'utf8')).toBe('my own note\n');
    expect(getStoredSettings(db, 'curator')['orgSweepModel']).toBe('accounts/fireworks/models/custom-x');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Settings/Models/custom-x.md already exists'));
    warn.mockRestore();
  });
});
