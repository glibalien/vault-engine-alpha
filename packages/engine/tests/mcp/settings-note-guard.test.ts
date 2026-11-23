import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { setSettingsChangeHook, setSettingsNoteResolver } from '../../src/settings/hook.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerGetSettings, registerUpdateSettings } from '../../src/mcp/tools/settings.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { notePathFor } from '../helpers/settings-notes.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let service: SettingsService; let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  service = new SettingsService(db, { settingsDir: 'Settings' });
  const ingest = new SettingsIngest({ db, writeLock, vaultPath, service });
  setSettingsNoteResolver(relPath => ingest.handles(relPath));
  setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});
afterEach(() => {
  setSettingsNoteResolver(null);
  setSettingsChangeHook(null);
  db.close();
  cleanup();
});

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
function handlers(): Record<string, Handler> {
  const captured: Record<string, Handler> = {};
  const fake = {
    tool: (name: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured[name] = args => Promise.resolve(h(args));
      return undefined;
    },
  } as unknown as McpServer;
  registerGetSettings(fake, service, new ModelCatalog(db, { settingsDir: 'Settings' }));
  registerUpdateSettings(fake, service, { db, writeLock, vaultPath, service });
  registerUpdateNode(fake, db, writeLock, vaultPath);
  registerBatchMutate(fake, db, writeLock, vaultPath);
  return captured;
}

const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

function snapshot(relPath: string) {
  const node = db.prepare('SELECT id, version, content_hash FROM nodes WHERE file_path = ?').get(relPath) as
    { id: string; version: number; content_hash: string };
  return { node, bytes: readFileSync(join(vaultPath, relPath), 'utf8') };
}

describe('generic node edits to a domain settings note', () => {
  it.each([
    // A group note of a domain shown in a folder (#746), and a domain's single note.
    { domain: 'curator', relPath: notePathFor('curator', 'dailyBudgetCents'), key: 'dailyBudgetCents', value: 300, attempted: 50 },
    { domain: 'wiki', relPath: notePathFor('wiki'), key: 'liveTaskGroupCap', value: 5, attempted: 12 },
  ])('are refused for $domain and leave the note and effective settings unchanged', async ({ domain, relPath, key, value, attempted }) => {
    const h = handlers();
    expect(parse(await h['update-settings']({ domain, patch: { [key]: value } })).ok).toBe(true);
    const before = snapshot(relPath);

    const attempts: Array<[string, Record<string, unknown>]> = [
      ['update-node', { file_path: relPath, set_fields: { [key]: attempted } }],
      ['update-node', { file_path: relPath, set_fields: { [key]: attempted }, dry_run: true }],
      ['update-node', { node_id: before.node.id, set_body: 'Replaced.' }],
      ['update-node', { query: { title_eq: basename(relPath, '.md') }, set_fields: { [key]: attempted }, dry_run: false }],
      ['update-node', { file_path: relPath, add_types: ['note'] }],
      ['update-node', { file_path: relPath, remove_types: ['note'] }],
    ];
    for (const [tool, args] of attempts) {
      const response = parse(await h[tool](args));
      expect(response, `${tool} ${JSON.stringify(args)}`).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS', message: expect.stringContaining('update-settings') },
      });
    }
    const batch = parse(await h['batch-mutate']({ operations: [{ op: 'update', params: { file_path: relPath, set_fields: { [key]: attempted } } }] }));
    expect(batch).toMatchObject({ ok: false, error: { code: 'BATCH_FAILED', message: expect.stringContaining('update-settings') } });

    expect(snapshot(relPath)).toEqual(before);
    const settings = parse(await h['get-settings']({ domain }));
    expect(settings.data.domains[domain].effective[key]).toBe(value);
  });

  it('keeps update-settings, watcher echoes, and fresh readers in agreement', async () => {
    const h = handlers();
    const relPath = notePathFor('engine', 'backupKeep');
    expect(parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } })).ok).toBe(true);
    expect(parse(await h['update-node']({ file_path: relPath, set_fields: { backupKeep: 9 } })).ok).toBe(false);
    const before = snapshot(relPath);

    // The watcher echo of the unchanged note is a hash skip: no new version, no new settings.
    processFileChange(join(vaultPath, relPath), relPath, db, writeLock, vaultPath);
    expect(snapshot(relPath)).toEqual(before);
    expect(service.engine().backupKeep).toBe(3);

    expect(parse(await h['update-settings']({ domain: 'engine', patch: { backupKeep: 4 } })).ok).toBe(true);
    processFileChange(join(vaultPath, relPath), relPath, db, writeLock, vaultPath);
    expect(new SettingsService(db, { settingsDir: 'Settings' }).engine().backupKeep).toBe(4);
    expect(readFileSync(join(vaultPath, relPath), 'utf8')).toMatch(/^backupKeep: 4$/m);
  });

  it('leaves ordinary notes and query matches outside Settings editable', async () => {
    const h = handlers();
    await h['update-settings']({ domain: 'engine', patch: { backupKeep: 3 } });
    const created = parse(await h['batch-mutate']({ operations: [{ op: 'create', params: { title: 'Plain', types: ['note'], body: 'Text.' } }] }));
    expect(created.ok).toBe(true);
    const updated = parse(await h['update-node']({ title: 'Plain', set_body: 'Edited.' }));
    expect(updated.ok).toBe(true);
    const bulk = parse(await h['update-node']({ query: { types: ['note'] }, set_fields: { status: 'open' }, dry_run: false }));
    expect(bulk.ok).toBe(true);
  });
});
