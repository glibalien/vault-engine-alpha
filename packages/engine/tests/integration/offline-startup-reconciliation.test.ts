import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import {
  addGlobalFieldUndoSnapshots,
  addNodeTypesSortOrder,
  addSchemaUndoSnapshots,
  addUiHints,
  addUndoTables,
  upgradeToMemories,
  upgradeToMemoriesV2,
  upgradeToMemoriesV3,
  upgradeToMemoryNoteReceipts,
  upgradeToMemoryHistory,
} from '../../src/db/migrate.js';
import { createSchema } from '../../src/db/schema.js';
import { CURRENT_SEARCH_VERSION, setSearchVersion } from '../../src/db/search-version.js';
import { setMeta } from '../../src/db/meta.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { setExcludeDirs } from '../../src/indexer/ignore.js';
import { MemoryNoteIngest } from '../../src/memories/note-ingest.js';
import { memoryNotePath } from '../../src/memories/note-format.js';
import { MemoryNoteProjection } from '../../src/memories/note-projection.js';
import { MemoryNoteReceipts } from '../../src/memories/note-receipts.js';
import { MemoryService } from '../../src/memories/service.js';
import { setStoredSettings, writeJson } from '../../src/settings/store.js';
import { EXPLICIT_NULL_BACKFILL_META_KEY } from '../../src/sync/explicit-null-backfill.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { notePathFor } from '../helpers/settings-notes.js';

const SETTINGS_DIR = 'Settings';
const ENGINE_DIR = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(ENGINE_DIR, '../..');
const TSX_PATH = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const INDEX_PATH = join(ENGINE_DIR, 'src', 'index.ts');
const REDIRECT_CONSOLE_LOG = `data:text/javascript,${encodeURIComponent(
  'console.log = (...args) => console.error(...args);',
)}`;

const tempVaults: string[] = [];

afterEach(() => {
  setExcludeDirs([]);
  for (const vaultPath of tempVaults.splice(0)) {
    rmSync(vaultPath, { recursive: true, force: true });
  }
});

function createVault(): { vaultPath: string; dbPath: string; db: Database.Database } {
  const vaultPath = mkdtempSync(join(tmpdir(), 'vault-offline-startup-'));
  tempVaults.push(vaultPath);
  const dbPath = join(vaultPath, '.vault-engine', 'test.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  createSchema(db);
  markOneShotStartupWorkComplete(db);
  setSearchVersion(db, CURRENT_SEARCH_VERSION);
  return { vaultPath, dbPath, db };
}

function markOneShotStartupWorkComplete(db: Database.Database): void {
  const completedAt = '2026-08-29T00:00:00.000Z';
  writeJson(db, 'settings.seeded', { engine: completedAt, wiki: completedAt });
  writeJson(db, 'settings.models_seeded', completedAt);
  writeJson(db, 'settings.vision_model_migrated', completedAt);
  setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
}

function enableMemorySchema(db: Database.Database): void {
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  addSchemaUndoSnapshots(db);
  addGlobalFieldUndoSnapshots(db);
  addUiHints(db);
  upgradeToMemories(db);
  upgradeToMemoriesV2(db);
  upgradeToMemoriesV3(db);
  upgradeToMemoryNoteReceipts(db);
  upgradeToMemoryHistory(db);
}

function writeNote(vaultPath: string, relPath: string, contents: string): void {
  const absPath = join(vaultPath, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf8');
}

/**
 * Write Engine settings as the group notes that show them (#746): each line goes to the note
 * of its key, and each note holds only its own keys.
 */
function writeEngineNotes(vaultPath: string, lines: Record<string, string>): void {
  const byNote = new Map<string, string[]>();
  for (const [key, line] of Object.entries(lines)) {
    const relPath = notePathFor('engine', key);
    byNote.set(relPath, [...(byNote.get(relPath) ?? []), line]);
  }
  for (const [relPath, noteLines] of byNote) writeNote(vaultPath, relPath, `---\n${noteLines.join('\n')}\n---\n`);
}

function childEnv(vaultPath: string, dbPath: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    VAULT_PATH: vaultPath,
    DB_PATH: dbPath,
    VAULT_SETTINGS_DIR: SETTINGS_DIR,
    VAULT_ENGINE_MODELS_OFFLINE: '1',
    FIREWORKS_API_KEY: '',
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    DEEPGRAM_API_KEY: '',
    EXA_API_KEY: '',
  };
}

async function withEngine<T>(
  vaultPath: string,
  dbPath: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', REDIRECT_CONSOLE_LOG, TSX_PATH, INDEX_PATH, '--transport', 'stdio'],
    cwd: ENGINE_DIR,
    env: childEnv(vaultPath, dbPath),
    stderr: 'pipe',
  });
  let logs = '';
  transport.stderr?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  const client = new Client({ name: 'offline-startup-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await run(client);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nEngine logs:\n${logs}`);
  } finally {
    await client.close().catch(() => {});
  }
}

function toolEnvelope(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('Tool response contained no content array');
  const text = content.find((part): part is { type: 'text'; text: string } => (
    typeof part === 'object'
      && part !== null
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
  ));
  if (!text) throw new Error('Tool response contained no text payload');
  return JSON.parse(text.text) as Record<string, any>;
}

describe('offline startup reconciliation', () => {
  it('applies an offline Engine settings edit before the first tool request', async () => {
    const { vaultPath, dbPath, db } = createVault();
    setStoredSettings(db, 'engine', {
      backupsEnabled: false,
      excludeDirs: [],
      syncLogRetentionHours: 1,
      visionProvider: 'gemini',
    });
    writeEngineNotes(vaultPath, {
      backupsEnabled: 'backupsEnabled: false',
      excludeDirs: 'excludeDirs: []',
      syncLogRetentionHours: 'syncLogRetentionHours: 1',
      visionProvider: 'visionProvider: gemini',
    });
    writeNote(vaultPath, 'OfflineExcluded/Hidden.md', '---\ntitle: Hidden\n---\nHidden\n');
    setExcludeDirs([]);
    fullIndex(vaultPath, db);

    const oldSyncTimestamp = Date.now() - 2 * 3_600_000;
    db.prepare(
      'INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)',
    ).run(oldSyncTimestamp, 'keep-me.md', 'watcher-event', 'watcher', '{}');
    // The offline edit changes three of the Engine's notes: General, Backups and retention, Models.
    writeEngineNotes(vaultPath, {
      backupsEnabled: 'backupsEnabled: false',
      excludeDirs: 'excludeDirs:\n  - OfflineExcluded',
      syncLogRetentionHours: 'syncLogRetentionHours: 24',
      visionProvider: 'visionProvider: claude',
    });
    db.close();

    await withEngine(vaultPath, dbPath, async (client) => {
      const response = toolEnvelope(await client.callTool({ name: 'vault-stats', arguments: {} }));
      expect(response.ok).toBe(true);
      const unavailable = response.data.extractors.unavailable as Array<{ id: string }>;
      expect(unavailable.some(entry => entry.id === 'claude-vision-image')).toBe(true);
      expect(unavailable.some(entry => entry.id === 'gemini-vision-image')).toBe(false);

      const observer = new Database(dbPath, { readonly: true });
      try {
        expect(observer.prepare('SELECT id FROM nodes WHERE file_path = ?').get('OfflineExcluded/Hidden.md'))
          .toBeUndefined();
        expect(observer.prepare('SELECT timestamp FROM sync_log WHERE file_path = ?').get('keep-me.md'))
          .toBeDefined();
      } finally {
        observer.close();
      }
    });
  }, 40_000);

  it('refreshes the indexed Models catalog before the first tool request', async () => {
    const { vaultPath, dbPath, db } = createVault();
    writeNote(
      vaultPath,
      'Settings/Models/Offline Model.md',
      '---\nprovider: fireworks\nmodel: accounts/fireworks/models/old-offline\nenabled: true\nvision: true\n---\n',
    );
    setExcludeDirs([]);
    fullIndex(vaultPath, db);
    writeNote(
      vaultPath,
      'Settings/Models/Offline Model.md',
      '---\nprovider: fireworks\nmodel: accounts/fireworks/models/new-offline\nenabled: true\nvision: true\n---\n',
    );
    // Simulate an offline edit with a distinct timestamp at indexer precision.
    const modelPath = join(vaultPath, 'Settings/Models/Offline Model.md');
    const indexedMtime = (db.prepare('SELECT file_mtime FROM nodes WHERE file_path = ?')
      .get('Settings/Models/Offline Model.md') as { file_mtime: number }).file_mtime;
    utimesSync(modelPath, new Date(), new Date(indexedMtime + 2_000));
    db.close();

    await withEngine(vaultPath, dbPath, async (client) => {
      const response = toolEnvelope(await client.callTool({
        name: 'get-settings',
        arguments: { domain: 'models' },
      }));
      expect(response.ok).toBe(true);
      expect(response.data.domains.models.catalog).toContainEqual(expect.objectContaining({
        title: 'Offline Model',
        model: 'accounts/fireworks/models/new-offline',
      }));
      expect(response.data.domains.models.catalog).not.toContainEqual(expect.objectContaining({
        model: 'accounts/fireworks/models/old-offline',
      }));
      expect(response.data.domains.models.version).toBe(1);
    });
  }, 40_000);

  it('applies an offline Memories note edit before the first memory query', async () => {
    const { vaultPath, dbPath, db } = createVault();
    enableMemorySchema(db);
    const service = new MemoryService(db);
    const receipts = new MemoryNoteReceipts(db);
    const ingest = new MemoryNoteIngest({ db, vaultPath, settingsDir: SETTINGS_DIR, service, receipts });
    const projection = new MemoryNoteProjection({
      db,
      writeLock: new WriteLockManager(),
      vaultPath,
      settingsDir: SETTINGS_DIR,
      service,
      ingest,
    });
    const created = await service.create({
      source: 'chat',
      content: 'original offline memory',
      scope: 'vault',
      evidence: { kind: 'conversation', ref: 'offline-startup#0' },
    });
    expect(created.result.ok).toBe(true);
    await projection.refresh();
    const notePath = join(vaultPath, memoryNotePath(SETTINGS_DIR));
    const original = readFileSync(notePath, 'utf8');
    writeFileSync(notePath, original.replace('category:\n', 'category: preference\n'), 'utf8');
    db.close();

    await withEngine(vaultPath, dbPath, async (client) => {
      const response = toolEnvelope(await client.callTool({
        name: 'list-memories',
        arguments: { limit: 50, offset: 0 },
      }));
      expect(response.ok).toBe(true);
      expect(response.data.memories).toContainEqual(expect.objectContaining({
        content: 'original offline memory',
        category: 'preference',
      }));
    });
  }, 40_000);
});

describe('typed reference startup policy', () => {
  it.each([1, 2])('repairs stale nonnull bindings only for active policy %s', async policy => {
    const { vaultPath, dbPath, db } = createVault();
    setStoredSettings(db, 'engine', { backupsEnabled: false, excludeDirs: [] });
    db.exec("INSERT INTO global_fields(name,field_type,reference_target) VALUES ('project','reference','project')");
    writeNote(vaultPath,'A/Same.md','---\ntitle: Same\ntypes: [project]\n---\n');
    writeNote(vaultPath,'B/Same.md','---\ntitle: Same\ntypes: [project]\n---\n');
    writeNote(vaultPath,'Source.md','---\ntitle: Source\nproject: "[[Same]]"\n---\n');
    setExcludeDirs([]); fullIndex(vaultPath, db);
    const p1 = (db.prepare("SELECT id FROM nodes WHERE file_path='A/Same.md'").get() as { id: string }).id;
    db.prepare("UPDATE relationships SET resolved_target_id=? WHERE rel_type='project'").run(p1);
    if (policy === 2) setMeta(db,'reference_resolution_policy_version','2');
    db.close();
    await withEngine(vaultPath, dbPath, async () => {
      const observer = new Database(dbPath, { readonly: true });
      try {
        expect(observer.prepare("SELECT value FROM meta WHERE key='reference_resolution_policy_version'").get()).toEqual({ value: String(policy) });
        expect(observer.prepare("SELECT resolved_target_id FROM relationships WHERE rel_type='project'").get()).toEqual({ resolved_target_id: policy === 2 ? null : p1 });
      } finally { observer.close(); }
    });
  }, 40_000);
  it('serves v2 bindings after the exclusion-driven second full index', async () => {
    const { vaultPath, dbPath, db } = createVault();
    setStoredSettings(db, 'engine', { backupsEnabled: false, excludeDirs: [] });
    db.exec("INSERT INTO global_fields(name,field_type,reference_target) VALUES ('project','reference','project')");
    writeNote(vaultPath,'A/Same.md','---\ntitle: Same\ntypes: [project]\n---\n');
    writeNote(vaultPath,'Excluded/Same.md','---\ntitle: Same\ntypes: [project]\n---\n');
    writeNote(vaultPath,'Source.md','---\ntitle: Source\nproject: "[[Same]]"\n---\n');
    writeEngineNotes(vaultPath, { backupsEnabled: 'backupsEnabled: false', excludeDirs: 'excludeDirs: []' });
    setExcludeDirs([]); fullIndex(vaultPath, db);
    const p1 = (db.prepare("SELECT id FROM nodes WHERE file_path='A/Same.md'").get() as { id: string }).id;
    setMeta(db,'reference_resolution_policy_version','2');
    db.exec("UPDATE relationships SET resolved_target_id=NULL WHERE rel_type='project'");
    writeEngineNotes(vaultPath, { backupsEnabled: 'backupsEnabled: false', excludeDirs: 'excludeDirs: [Excluded]' });
    db.close();
    await withEngine(vaultPath, dbPath, async () => {
      const observer = new Database(dbPath, { readonly: true });
      try {
        expect(observer.prepare("SELECT id FROM nodes WHERE file_path='Excluded/Same.md'").get()).toBeUndefined();
        expect(observer.prepare("SELECT resolved_target_id FROM relationships WHERE rel_type='project'").get()).toEqual({ resolved_target_id: p1 });
      } finally { observer.close(); }
    });
  }, 40_000);
});
