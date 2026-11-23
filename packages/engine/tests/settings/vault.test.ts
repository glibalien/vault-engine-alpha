import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { writeSettingsNote, writeSettingsNotes } from '../../src/settings/note.js';
import { seedSettingsOnBoot } from '../../src/settings/seed.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import {
  addPendingSettingsNoteFields, getPendingSettingsNoteFields, getStoredSettings, markDomainSeeded, setStoredSettings,
} from '../../src/settings/store.js';
import { getVaultSettings } from '../../src/settings/vault.js';
import { defaultsFor, descriptorsFor, normalizeModelRef, vaultAliasFor, vaultSettingsFrom } from '@vault/settings-registry';
import { registerGetSettings, registerUpdateSettings } from '../../src/mcp/tools/settings.js';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { DEFAULT_TYPE_KEY, setTypeKey } from '../../src/parser/type-key.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { noteFor, notePathFor, notePathsOf } from '../helpers/settings-notes.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let service: SettingsService; let ingest: SettingsIngest;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new SettingsService(db, { settingsDir: 'Settings', attachmentDir: 'attachments' });
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  ingest = new SettingsIngest({ db, writeLock, vaultPath, service });
});
afterEach(() => { cleanup(); setSettingsChangeHook(null); });

const read = (rel: string): string => readFileSync(join(vaultPath, rel), 'utf8');
const fields = (rel: string): Map<string, unknown> => parseFrontmatter(read(rel)).fields;
function write(rel: string, content: string): void {
  const p = join(vaultPath, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}
/** A file edit as the watcher sees it: index the bytes, then the settings hook ingests them. */
function edit(rel: string, content: string): void {
  write(rel, content);
  processFileChange(join(vaultPath, rel), rel, db, writeLock, vaultPath);
}

function handlers() {
  const captured: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  const fake = {
    tool: (name: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured[name] = (args) => Promise.resolve(h(args));
    },
  } as unknown as McpServer;
  registerGetSettings(fake, service, new ModelCatalog(db, { settingsDir: 'Settings' }));
  registerUpdateSettings(fake, service, { db, writeLock, vaultPath, service });
  return captured;
}
const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
/** Index a changed note the way the watcher does; the settings hook then ingests it. */
const ingestChangedFile = (rel: string): void => { processFileChange(join(vaultPath, rel), rel, db, writeLock, vaultPath); };

describe('vault settings: none', () => {
  it('update-settings null sets a vault kind to none, and the default name restores it', () => {
    const r = service.applyPatch('vault', { projectType: null, dueField: null });
    expect(r.issues).toEqual([]);
    expect(r.applied.sort()).toEqual(['dueField', 'projectType']);
    expect(service.vault().projectType).toBeNull();
    expect(getStoredSettings(db, 'vault')).toEqual({ projectType: null, dueField: null });
    expect(getVaultSettings(db).dueField).toBeNull();
    service.applyPatch('vault', { projectType: 'project' });
    expect(getStoredSettings(db, 'vault')).toEqual({ dueField: null });
  });

  it('null still resets a key that does not accept null', () => {
    service.applyPatch('vault', { taskTickStatus: 'closed' });
    service.applyPatch('vault', { taskTickStatus: null });
    expect(service.vault().taskTickStatus).toBe('done');
  });

  it('outside the vault domain null still resets, as before (dailyBudgetCents keeps its cap)', () => {
    service.applyPatch('curator', { dailyBudgetCents: 50 });
    const r = service.applyPatch('curator', { dailyBudgetCents: null, bodyCharCap: null });
    expect(r.issues).toEqual([]);
    expect(service.effective('curator')['dailyBudgetCents']).toBe(100);
    expect(getStoredSettings(db, 'curator')).toEqual({});
  });

  it('a none set through the tool path is written as a bare key and survives a re-ingest', () => {
    service.applyPatch('vault', { projectType: null });
    writeSettingsNote({ db, writeLock, vaultPath, service }, noteFor('vault'), undefined, { touchedFields: ['projectType'] });
    expect(read('Settings/Vault.md')).toMatch(/\nprojectType:\n/);
    expect(fields('Settings/Vault.md').get('projectType')).toBeNull();
    // A boot reconcile reads the file back as a snapshot: an absent key would reset it.
    ingest.reconcile();
    expect(service.vault().projectType).toBeNull();
    // Restoring the name drops the bare key.
    service.applyPatch('vault', { projectType: 'project' });
    writeSettingsNote({ db, writeLock, vaultPath, service }, noteFor('vault'), undefined, { touchedFields: ['projectType'] });
    expect(fields('Settings/Vault.md').get('projectType')).toBe('project');
  });

  it('a deleted Vault.md is regenerated with its none values', () => {
    service.applyPatch('vault', { projectType: null });
    ingest.reconcile();
    unlinkSync(join(vaultPath, 'Settings/Vault.md'));
    ingest.onFileEvent('Settings/Vault.md', 'unlink');
    expect(read('Settings/Vault.md')).toMatch(/\nprojectType:\n/);
    ingest.reconcile();
    expect(service.vault().projectType).toBeNull();
  });

  it('a kind emptied in the note is none', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    const text = read('Settings/Vault.md').replace(/\nmeetingType: meeting\n/, '\nmeetingType:\n');
    edit('Settings/Vault.md', text);
    expect(service.vault().meetingType).toBeNull();
    expect(service.issues('vault').filter(i => i.code !== 'SETTINGS_NOT_IN_VAULT')).toEqual([]);
    expect(read('Settings/Vault.md')).toMatch(/\nmeetingType:\n/);
  });
});

describe('vault settings: old keys are aliases', () => {
  it('a write through an old key lands in the vault map and reads back under both names', () => {
    const r = service.applyPatch('wiki', { projectType: 'initiative', statusField: 'state', subpageCap: 5 });
    expect(r.issues).toEqual([]);
    expect(r.applied.sort()).toEqual(['projectType', 'statusField', 'subpageCap']);
    expect(r.vaultApplied?.sort()).toEqual(['projectType', 'taskStatusField']);
    expect(getStoredSettings(db, 'wiki')).toEqual({ subpageCap: 5 });
    expect(getStoredSettings(db, 'vault')).toEqual({ projectType: 'initiative', taskStatusField: 'state' });
    expect(service.effectiveWithAliases('wiki')).toMatchObject({ projectType: 'initiative', statusField: 'state', subpageCap: 5 });
    service.applyPatch('curator', { activeStatuses: ['live'], projectStatusField: 'stage', topicDir: 'Subjects' });
    expect(service.vault()).toMatchObject({ projectActiveStatuses: ['live'], projectStatusField: 'stage', topicDir: 'Subjects' });
    expect(getStoredSettings(db, 'curator')).toEqual({});
  });

  it('a write through the new key is seen under the old name', () => {
    service.applyPatch('vault', { wikiDir: 'Pages', projectActiveStatuses: ['live'], personType: null });
    expect(service.effectiveWithAliases('wiki')).toMatchObject({ wikiDir: 'Pages', personType: null });
    expect(service.effectiveWithAliases('curator')).toMatchObject({ activeStatuses: ['live'] });
  });

  it('null through an old key resets the vault key, as it reset the old key', () => {
    service.applyPatch('vault', { projectType: 'initiative', topicDir: 'Subjects' });
    service.applyPatch('wiki', { projectType: null });
    service.applyPatch('curator', { topicDir: null });
    expect(service.vault().projectType).toBe('project');
    expect(service.vault().topicDir).toBeNull();
    expect(getStoredSettings(db, 'vault')).toEqual({});
  });

  it('reports an invalid old-key value under the old key', () => {
    const r = service.applyPatch('wiki', { projectType: '', statusOpen: 'open' });
    expect(r.applied).toEqual([]);
    expect(r.issues.map(i => [i.key, i.code])).toEqual([
      ['projectType', 'SETTINGS_INVALID_VALUE'], ['statusOpen', 'SETTINGS_INVALID_VALUE'],
    ]);
    expect(service.vault().projectType).toBe('project');
  });

  it('update-settings through an old key writes Vault.md; the old note no longer shows the line', async () => {
    // The wiki and curator notes stopped showing the vault keys under their old names
    // (#746); update-settings still accepts the old names and writes the vault key.
    const h = handlers();
    const res = parse(await h['update-settings']({ domain: 'wiki', patch: { projectType: 'initiative', subpageCap: 6 } }));
    expect(res.ok).toBe(true);
    expect(res.data.applied.sort()).toEqual(['projectType', 'subpageCap']);
    expect(res.data.effective).toMatchObject({ projectType: 'initiative', subpageCap: 6 });
    expect(res.data.stored).toEqual({ projectType: 'initiative', subpageCap: 6 });
    expect(fields('Settings/Vault.md').get('projectType')).toBe('initiative');
    expect(fields('Settings/Wiki.md').get('subpageCap')).toBe(6);
    expect(fields('Settings/Wiki.md').has('projectType')).toBe(false);
    expect(read('Settings/Wiki.md')).toContain('## Set in Vault.md');
    expect(read('Settings/Wiki.md')).toContain('- projectType: Vault.md projectType');
  });

  it('update-settings in the vault domain leaves Wiki.md and the Curator notes alone', async () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    const others = [...notePathsOf('wiki'), ...notePathsOf('curator')];
    const before = new Map(others.map(rel => [rel, read(rel)]));
    const res = parse(await handlers()['update-settings']({ domain: 'vault', patch: { wikiDir: 'Pages', projectActiveStatuses: ['live'] } }));
    expect(res.ok).toBe(true);
    expect(fields('Settings/Vault.md').get('wikiDir')).toBe('Pages');
    expect(fields('Settings/Vault.md').get('projectActiveStatuses')).toEqual(['live']);
    // No old-name mirror to journal or rewrite (#746).
    for (const rel of others) expect(read(rel), rel).toBe(before.get(rel));
    expect(getPendingSettingsNoteFields(db, 'wiki')).toEqual([]);
    expect(getPendingSettingsNoteFields(db, 'curator')).toEqual([]);
    // get-settings still reports the values under the old names.
    const all = parse(await handlers()['get-settings']({}));
    expect(all.data.domains.wiki.effective.wikiDir).toBe('Pages');
    expect(all.data.domains.curator.effective.activeStatuses).toEqual(['live']);
  });

  it('get-settings serves the vault domain, the old names and the install folders', async () => {
    service.applyPatch('vault', { taskType: null });
    service.applyPatch('curator', { activeStatuses: ['open', 'next'] });
    const all = parse(await handlers()['get-settings']({}));
    expect(all.data.attachmentDir).toBe('attachments');
    expect(all.data.typeKey).toBe('types');
    expect(all.data.domains.vault.effective.taskType).toBeNull();
    expect(all.data.domains.wiki.effective.taskType).toBeNull();
    expect(all.data.domains.wiki.stored).toEqual({ taskType: null });
    expect(all.data.domains.curator.effective.activeStatuses).toEqual(['open', 'next']);
    expect(all.data.domains.curator.stored).toEqual({ activeStatuses: ['open', 'next'] });
  });

  it('an old key typed into Settings/Wiki.md is not read: it is reported, naming its Vault.md key, and kept as typed', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    expect(fields('Settings/Wiki.md').has('projectType')).toBe(false);
    edit('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\nprojectType: initiative\nsubpageCap: 20\n'));
    expect(service.vault().projectType).toBe('project');
    expect(service.issues('wiki')).toEqual([expect.objectContaining({ key: 'projectType', code: 'SETTINGS_UNKNOWN_KEY' })]);
    expect(service.issues('wiki')[0]!.message).toContain('Settings/Vault.md as projectType');
    expect(fields('Settings/Wiki.md').get('projectType')).toBe('initiative');
    expect(read('Settings/Wiki.md')).toContain('> - **projectType** — ');
    expect(fields('Settings/Vault.md').get('projectType')).toBe('project');
    // Deleting the line clears the report and changes nothing else.
    edit('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nprojectType: initiative\n', '\n'));
    expect(service.issues('wiki')).toEqual([]);
    expect(service.vault().projectType).toBe('project');
    expect(fields('Settings/Wiki.md').has('projectType')).toBe(false);
    // A line equal to the vault map's value is the mirror older notes carried: dropped without a word.
    edit('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\nprojectType: project\nsubpageCap: 20\n'));
    expect(service.issues('wiki')).toEqual([]);
    expect(service.vault().projectType).toBe('project');
    expect(fields('Settings/Wiki.md').has('projectType')).toBe(false);
  });

  it('a Vault.md edit leaves Wiki.md alone, and the old name still reads the vault map', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    const wikiBefore = read('Settings/Wiki.md');
    edit('Settings/Vault.md', read('Settings/Vault.md').replace('\ntaskStatusField: status\n', '\ntaskStatusField: state\n'));
    expect(service.vault().taskStatusField).toBe('state');
    expect(read('Settings/Wiki.md')).toBe(wikiBefore);
    expect(fields('Settings/Wiki.md').has('statusField')).toBe(false);
    expect(service.effectiveWithAliases('wiki')['statusField']).toBe('state');
    // Re-reading Wiki.md changes nothing.
    const version = service.version('vault');
    ingest.onFileEvent('Settings/Wiki.md', 'change');
    expect(service.version('vault')).toBe(version);
    expect(read('Settings/Wiki.md')).toBe(wikiBefore);
  });

  it('a cross-note update keeps an unknown or invalid line in the other note', async () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    // A wiki update through an old name writes the vault map, so it projects Vault.md: the
    // other note now (#746), since Wiki.md no longer shows the vault keys.
    edit('Settings/Vault.md', read('Settings/Vault.md')
      .replace('\ntaskDoneStatuses:\n  - done\n', '\ndate: 2026-03-04\ntaskDoneStatuses: done\n'));
    const vaultIssues = () => service.issues('vault').filter(i => i.code !== 'SETTINGS_NOT_IN_VAULT').map(i => i.key).sort();
    expect(vaultIssues()).toEqual(['date', 'taskDoneStatuses']);
    const res = parse(await handlers()['update-settings']({ domain: 'wiki', patch: { wikiDir: 'Pages' } }));
    expect(res.ok).toBe(true);
    expect(service.vault().wikiDir).toBe('Pages');
    expect(fields('Settings/Vault.md').get('wikiDir')).toBe('Pages');
    expect(fields('Settings/Vault.md').get('date')).toBe('2026-03-04');
    expect(fields('Settings/Vault.md').get('taskDoneStatuses')).toBe('done');
    expect(service.vault().taskDoneStatuses).toEqual(['done']);
    expect(vaultIssues()).toEqual(['date', 'taskDoneStatuses']);
    expect(fields('Settings/Wiki.md').has('wikiDir')).toBe(false);
  });

  it('a none set while the old note holds an unread edit stays none when that edit is read', async () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    // An unread save that still carries the old name's line, as older notes mirrored it.
    write('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\nprojectType: project\nsubpageCap: 9\n'));
    const res = parse(await handlers()['update-settings']({ domain: 'vault', patch: { projectType: null } }));
    expect(res.ok).toBe(true);
    processFileChange(join(vaultPath, 'Settings/Wiki.md'), 'Settings/Wiki.md', db, writeLock, vaultPath);
    expect(service.vault().projectType).toBeNull();
    expect(service.wiki().subpageCap).toBe(9);
    // The line no longer equals the vault map: not read, reported, and kept as typed.
    expect(service.issues('wiki')).toEqual([expect.objectContaining({ key: 'projectType', code: 'SETTINGS_UNKNOWN_KEY' })]);
    expect(fields('Settings/Wiki.md').get('projectType')).toBe('project');
  });

  it('a none is not shown under the old name; an empty old-name line equal to it is dropped as a mirror', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    const wikiBefore = read('Settings/Wiki.md');
    edit('Settings/Vault.md', read('Settings/Vault.md').replace('\npersonType: person\n', '\npersonType:\n'));
    expect(service.vault().personType).toBeNull();
    expect(read('Settings/Wiki.md')).toBe(wikiBefore);
    // An older note's line for the none reads as the vault map's value, so it is dropped.
    edit('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\npersonType:\nsubpageCap: 20\n'));
    expect(service.vault().personType).toBeNull();
    expect(service.issues('wiki')).toEqual([]);
    expect(fields('Settings/Wiki.md').has('personType')).toBe(false);
  });

  it('keeps an unread Vault.md edit when an old note holds a differing old-name line at the same time', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    // Both notes edited while Engine was stopped.
    write('Settings/Vault.md', read('Settings/Vault.md').replace('\ntaskType: task\n', '\ntaskType: todo\n'));
    write('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\nsubpageCap: 20\nwikiDir: Pages\n'));
    ingest.reconcile({ ingestChangedFile });
    // The Vault.md edit is read; the old name in Wiki.md is not (#746), and is reported there.
    expect(service.vault()).toMatchObject({ taskType: 'todo', wikiDir: 'Wikis' });
    expect(fields('Settings/Vault.md').get('taskType')).toBe('todo');
    expect(fields('Settings/Vault.md').get('wikiDir')).toBe('Wikis');
    expect(fields('Settings/Wiki.md').get('wikiDir')).toBe('Pages');
    expect(fields('Settings/Wiki.md').has('taskType')).toBe(false);
    expect(service.issues('wiki')).toEqual([expect.objectContaining({ key: 'wikiDir', code: 'SETTINGS_UNKNOWN_KEY' })]);
  });

  it('update-settings through an old key keeps an unread Vault.md edit', async () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    // A save the watcher has not ingested yet.
    const edited = read('Settings/Vault.md').replace('\ntaskType: task\n', '\ntaskType: todo\n');
    write('Settings/Vault.md', edited);
    const res = parse(await handlers()['update-settings']({ domain: 'wiki', patch: { wikiDir: 'Pages' } }));
    expect(res.ok).toBe(true);
    expect(service.vault().wikiDir).toBe('Pages');
    expect(read('Settings/Vault.md')).toBe(edited);
    // The watcher then ingests the save; the journaled key joins it.
    processFileChange(join(vaultPath, 'Settings/Vault.md'), 'Settings/Vault.md', db, writeLock, vaultPath);
    expect(service.vault()).toMatchObject({ taskType: 'todo', wikiDir: 'Pages' });
    expect(fields('Settings/Vault.md').get('wikiDir')).toBe('Pages');
    expect(fields('Settings/Vault.md').get('taskType')).toBe('todo');
  });

  it('a stale old-name line does not write back a vault value changed elsewhere', () => {
    const hook: NonNullable<Parameters<typeof setSettingsChangeHook>[0]> = (relPath, kind, context) =>
      ingest.onFileEvent(relPath, kind, context);
    setSettingsChangeHook(hook);
    ingest.reconcile();
    // Wiki.md as an older release left it, mirroring the vault map under the old names
    // (indexed by its watcher).
    setSettingsChangeHook(null);
    edit('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\nprojectType: project\nsubpageCap: 20\nwikiDir: Wikis\n'));
    setSettingsChangeHook(hook);
    // Committed as update-settings commits, without the notes being projected (as when a
    // projection fails).
    service.applyPatch('wiki', { projectType: 'initiative' }, { journalProjection: true });
    service.applyPatch('vault', { wikiDir: 'Pages' }, { journalProjection: true });
    expect(fields('Settings/Wiki.md').get('projectType')).toBe('project');
    ingest.onFileEvent('Settings/Wiki.md', 'change');
    expect(service.vault()).toMatchObject({ projectType: 'initiative', wikiDir: 'Pages' });
    // The stale lines now differ from the vault map: not read, reported, kept as typed.
    expect(service.issues('wiki').map(i => [i.key, i.code]).sort()).toEqual([
      ['projectType', 'SETTINGS_UNKNOWN_KEY'], ['wikiDir', 'SETTINGS_UNKNOWN_KEY'],
    ]);
    expect(fields('Settings/Wiki.md').get('projectType')).toBe('project');
    expect(fields('Settings/Wiki.md').get('wikiDir')).toBe('Wikis');
    // A journal an older release left for those lines (it projected the vault map into them)
    // reads them as the vault map's values, so they are dropped as mirrors and the journal clears.
    addPendingSettingsNoteFields(db, 'wiki', ['projectType', 'wikiDir']);
    ingest.onFileEvent('Settings/Wiki.md', 'change');
    expect(service.vault()).toMatchObject({ projectType: 'initiative', wikiDir: 'Pages' });
    expect(service.issues('wiki')).toEqual([]);
    expect(fields('Settings/Wiki.md').has('projectType')).toBe(false);
    expect(fields('Settings/Wiki.md').has('wikiDir')).toBe(false);
    expect(getPendingSettingsNoteFields(db, 'wiki')).toEqual([]);
  });

  it('keeps an empty old key in Settings/Wiki.md as typed and reports it, not a none', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    edit('Settings/Wiki.md', read('Settings/Wiki.md').replace('\nsubpageCap: 20\n', '\nprojectType:\nsubpageCap: 20\n'));
    expect(service.vault().projectType).toBe('project');
    // Empty differs from the vault map's `project`, so the line is not read (#746).
    expect(service.issues('wiki')).toEqual([expect.objectContaining({ key: 'projectType', code: 'SETTINGS_UNKNOWN_KEY' })]);
    expect(read('Settings/Wiki.md')).toMatch(/\nprojectType:\n/);
  });

  it('an empty topicDir in a Curator note is not read while the vault map names a folder; equal to its none, it is dropped', () => {
    service.applyPatch('vault', { topicDir: 'Subjects' });
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    ingest.reconcile();
    for (const rel of notePathsOf('curator')) expect(fields(rel).has('topicDir'), rel).toBe(false);
    // Typed into the note about wikis, where a reader might look for it.
    const rel = notePathFor('curator', 'staleProjectDays');
    edit(rel, read(rel).replace('\nstaleProjectDays: 14\n', '\nstaleProjectDays: 14\ntopicDir:\n'));
    expect(service.vault().topicDir).toBe('Subjects');
    expect(service.issues('curator')).toEqual([expect.objectContaining({ key: 'topicDir', code: 'SETTINGS_UNKNOWN_KEY' })]);
    expect(service.issues('curator')[0]!.message).toContain('Settings/Vault.md as topicDir');
    expect(read(rel)).toMatch(/\ntopicDir:\n/);
    // Once the vault map's topicDir is none, the same line mirrors it and is dropped.
    service.applyPatch('vault', { topicDir: null });
    ingest.onFileEvent(rel, 'change');
    expect(service.vault().topicDir).toBeNull();
    expect(service.issues('curator')).toEqual([]);
    expect(fields(rel).has('topicDir')).toBe(false);
  });

});

/** Every wiki key the previous release had, at its defaults. */
const OLD_WIKI_DEFAULTS = {
  projectType: 'project', taskType: 'task', statusField: 'status',
  statusOpen: ['open', 'in-progress'], statusDone: ['done'], statusBlocked: ['blocked'],
  statusIgnored: ['dropped'], statusBacklog: ['backlog'], dueField: 'due',
  meetingType: 'meeting', personType: 'person', companyType: 'company',
  peopleField: 'people involved', companyField: 'company', wikiType: 'wiki', wikiDir: 'Wikis',
  subpageCap: 20, liveTaskGroupCap: 8, liveRelatedCap: 12, renderRelatedLive: true,
};

/** Frontmatter as the previous release rendered a settings note: every non-null key, model refs as links. */
function oldNote(values: Record<string, unknown>, modelRefKeys: Set<string>): string {
  const lines = ['---', 'types:'];
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      lines.push(value.length === 0 ? `${key}: []` : `${key}:`);
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(modelRefKeys.has(key) ? `[[${String(value).replace(/^\[\[|\]\]$/g, '')}]]` : value)}`);
    }
  }
  lines.push('---', 'Old body.', '');
  return lines.join('\n');
}

describe('vault settings: upgrade', () => {
  it('the installation\'s stored shape reads the same after the first boot, and a second boot changes nothing', () => {
    // As the previous release left it: wiki seeded with nothing stored and an unknown `date`
    // key in Wiki.md; curator seeded with these deviations, in the single Settings/Curator.md
    // of the layout before #746.
    markDomainSeeded(db, 'engine');
    markDomainSeeded(db, 'wiki');
    markDomainSeeded(db, 'curator');
    const curatorStored = {
      activeStatuses: ['open', 'in-progress', 'next'], wikiReconciliationMode: 'live',
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
      memorySweepEnabled: true, conversationSweepEnabled: true, orgSweepEnabled: true, conversationCaptureMode: 'live',
    };
    setStoredSettings(db, 'curator', curatorStored);
    // The previous release's curator keys: today's, plus the three that moved, with its stored values.
    const oldCurator: Record<string, unknown> = Object.assign(
      { ...defaultsFor('curator'), activeStatuses: ['open', 'in-progress'], projectStatusField: 'status', topicDir: null },
      curatorStored,
    );
    const curatorModelRefs = new Set(descriptorsFor('curator').filter(d => d.type.kind === 'model-ref').map(d => d.key));
    write('Settings/Wiki.md', oldNote({ ...OLD_WIKI_DEFAULTS, date: '2026-03-04' }, new Set()));
    write('Settings/Curator.md', oldNote(oldCurator, curatorModelRefs));
    const before = { wiki: fields('Settings/Wiki.md'), curator: fields('Settings/Curator.md') };

    // A start: settings seeding, the vault index, then the settings notes, as in production.
    const boot = (): void => {
      seedSettingsOnBoot(db, service, {});
      fullIndex(vaultPath, db);
      ingest.reconcile({ ingestChangedFile });
    };
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    boot();

    // Every value an existing reader sees under the old names is unchanged.
    const wiki = service.effectiveWithAliases('wiki');
    expect(Object.fromEntries(Object.keys(OLD_WIKI_DEFAULTS).map(k => [k, wiki[k]]))).toEqual(OLD_WIKI_DEFAULTS);
    expect(wiki['statusOpen']).toEqual(['open', 'in-progress']);
    const curator = service.effectiveWithAliases('curator');
    for (const [key, value] of Object.entries(oldCurator)) {
      expect(normalize(curator[key]), key).toEqual(normalize(value));
    }
    expect(curator['activeStatuses']).toEqual(['open', 'in-progress', 'next']);
    // Project lists come from Curator's keys, task lists from the wiki's (all defaults here).
    expect(service.vault()).toMatchObject({
      projectActiveStatuses: ['open', 'in-progress', 'next'], taskActiveStatuses: ['open', 'in-progress'],
      projectDoneStatuses: ['done'], taskDoneStatuses: ['done'], projectStatusField: 'status', taskStatusField: 'status',
    });
    // What Curator builds its run config from.
    const payload = { vault: { effective: service.effectiveWithAliases('vault') } };
    expect(vaultSettingsFrom(payload)).toMatchObject({
      projectType: 'project', wikiDir: 'Wikis', topicDir: null,
      projectActiveStatuses: ['open', 'in-progress', 'next'], projectStatusField: 'status',
    });
    // Wiki.md keeps every key and value of its own; the unknown `date` stays, reported as
    // before. Its old-name lines equal the vault map, so they are dropped as mirrors (#746).
    // The rewrite adds the wiki task windows (#448) at their defaults.
    const ownLines = (domain: 'wiki' | 'curator', map: Map<string, unknown>) =>
      new Map([...map].filter(([key]) => !vaultAliasFor(domain, key)));
    expect(fields('Settings/Wiki.md')).toEqual(new Map([
      ...ownLines('wiki', before.wiki), ['staleDays', 30], ['upcomingDays', 14], ['recentDays', 7],
    ]));
    expect(service.issues('wiki')).toEqual([expect.objectContaining({ key: 'date', code: 'SETTINGS_UNKNOWN_KEY' })]);
    // The single Curator.md was read one last time and removed, since nothing in it was
    // refused; its keys and values, but for the old names, are now in the folder's notes.
    expect(existsSync(join(vaultPath, 'Settings/Curator.md'))).toBe(false);
    const curatorNotes = new Map(notePathsOf('curator').flatMap(rel => [...fields(rel)]));
    expect(normalizeMap(curatorNotes)).toEqual(normalizeMap(ownLines('curator', before.curator)));
    expect(service.issues('curator')).toEqual([]);
    expect(fields('Settings/Vault.md').get('projectActiveStatuses')).toEqual(['open', 'in-progress', 'next']);

    // A second boot changes nothing: no setting, no note.
    const versions = (['engine', 'wiki', 'curator', 'vault'] as const).map(d => service.version(d));
    const noteNames = ['Settings/Wiki.md', 'Settings/Vault.md', ...notePathsOf('curator')];
    const notes = noteNames.map(read);
    boot();
    expect((['engine', 'wiki', 'curator', 'vault'] as const).map(d => service.version(d))).toEqual(versions);
    expect(noteNames.map(read)).toEqual(notes);
    expect(existsSync(join(vaultPath, 'Settings/Curator.md'))).toBe(false);
  });

  it('a value changed while rolled back to an older release survives the next upgrade', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    seedSettingsOnBoot(db, service, {});
    service.applyPatch('vault', { projectActiveStatuses: ['open'] });
    ingest.reconcile();
    // The older release, edited in its single Settings/Curator.md, keeps the value in
    // curator's store and that note (indexed by its watcher); it knows nothing of Vault.md
    // or of the folder of Curator notes (#746).
    setSettingsChangeHook(null);
    const curatorModelRefs = new Set(descriptorsFor('curator').filter(d => d.type.kind === 'model-ref').map(d => d.key));
    const rolledBack = oldNote(
      { ...defaultsFor('curator'), activeStatuses: ['open', 'next'], projectStatusField: 'status' }, curatorModelRefs);
    edit('Settings/Curator.md', rolledBack);
    setStoredSettings(db, 'curator', { activeStatuses: ['open', 'next'] });
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    expect(fields('Settings/Vault.md').get('projectActiveStatuses')).toEqual(['open']);

    seedSettingsOnBoot(db, service, {});
    ingest.reconcile({ ingestChangedFile });
    expect(getStoredSettings(db, 'curator')).toEqual({});
    expect(service.vault().projectActiveStatuses).toEqual(['open', 'next']);
    expect(fields('Settings/Vault.md').get('projectActiveStatuses')).toEqual(['open', 'next']);
    expect(service.effectiveWithAliases('curator')['activeStatuses']).toEqual(['open', 'next']);
    for (const rel of notePathsOf('curator')) expect(fields(rel).has('activeStatuses'), rel).toBe(false);
    // The single note was retired at the first start with the folder; it is never read again.
    expect(read('Settings/Curator.md')).toBe(rolledBack);
  });
});

const normalize = (value: unknown): unknown => typeof value === 'string' ? normalizeModelRef(value) || value : value;
const normalizeMap = (map: Map<string, unknown>): Record<string, unknown> =>
  Object.fromEntries([...map].map(([k, v]) => [k, normalize(v)]));

describe('vault settings: names the vault lacks', () => {
  it('warns for a designated type or field no note has, and not for none or self-created kinds', () => {
    const issues = () => service.issues('vault').filter(i => i.code === 'SETTINGS_NOT_IN_VAULT').map(i => i.key);
    const before = issues();
    expect(before).toContain('projectType');
    expect(before).toContain('peopleField');
    expect(before).not.toContain('wikiType');
    expect(before).not.toContain('wikiFlagField');
    createSchemaDefinition(db, { name: 'project', field_claims: [] });
    createGlobalField(db, { name: 'people involved', field_type: 'list', list_item_type: 'reference' });
    service.applyPatch('vault', { taskType: null });
    const after = issues();
    expect(after).not.toContain('projectType');
    expect(after).not.toContain('peopleField');
    expect(after).not.toContain('taskType');
    expect(existsSync(join(vaultPath, 'Settings/Vault.md'))).toBe(false);
    writeSettingsNote({ db, writeLock, vaultPath, service }, noteFor('vault'));
    expect(read('Settings/Vault.md')).toContain('meetingType** — meetingType names the type "meeting"');
    expect(read('Settings/Vault.md')).toContain('- Attachments: `attachments` (VAULT_ATTACHMENT_DIR)');
    expect(read('Settings/Vault.md')).toContain('- Type key: `types`, the frontmatter key that holds a note\'s types (VAULT_TYPE_KEY)');
  });
});

describe('vault settings: a designated type key (#445)', () => {
  beforeEach(() => setTypeKey('kind'));
  afterEach(() => setTypeKey(DEFAULT_TYPE_KEY));

  it('is reported by get-settings and listed in Vault.md, and every settings note carries it', async () => {
    const all = parse(await handlers()['get-settings']({ domain: 'vault' }));
    expect(all.data).toMatchObject({ settingsDir: 'Settings', attachmentDir: 'attachments', typeKey: 'kind' });
    const domains = ['engine', 'wiki', 'chat', 'curator', 'vault'] as const;
    for (const domain of domains) writeSettingsNotes({ db, writeLock, vaultPath, service }, domain);
    const vault = read('Settings/Vault.md');
    expect(vault).toContain('- Type key: `kind`, the frontmatter key that holds a note\'s types (VAULT_TYPE_KEY)');
    // Every note, the Curator's and Engine's folders of notes included (#746).
    for (const rel of domains.flatMap(domain => notePathsOf(domain))) {
      const text = read(rel);
      expect(text.startsWith('---\nkind:\n'), rel).toBe(true);
      expect(text).not.toMatch(/^types:/m);
    }
    // Read back, the notes hold the same settings.
    expect(fields('Settings/Vault.md').get('projectType')).toBe('project');
    expect(fields('Settings/Vault.md').has('kind')).toBe(false);
  });
});
