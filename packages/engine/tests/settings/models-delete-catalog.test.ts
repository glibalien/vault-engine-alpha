import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';

// #595: deleting a Settings/Models/ note through a tool, a batch or an undo takes the
// model out of the cached catalog at once, as a tool write does.

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let catalog: ModelCatalog;
let catalogChanges: number;
const handlers = new Map<string, Handler>();

const MODEL_PATH = 'Settings/Models/Tool Minted.md';
const MODEL_FIELDS = { provider: 'fireworks', model: 'accounts/fireworks/models/tool-minted', enabled: true };

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  const service = new SettingsService(db, { settingsDir: 'Settings' });
  catalog = new ModelCatalog(db, { settingsDir: 'Settings', env: {} });
  catalogChanges = 0;
  const ingest = new SettingsIngest({ db, writeLock, vaultPath, service }, catalog, () => { catalogChanges++; });
  setToolWriteHook((relPath) => ingest.onToolWrite(relPath));
  handlers.clear();
  const server = { tool: (name: string, _d: string, _s: unknown, cb: Handler) => { handlers.set(name, cb); } } as unknown as McpServer;
  registerDeleteNode(server, db, writeLock, vaultPath);
  registerBatchMutate(server, db, writeLock, vaultPath);
  registerCreateNode(server, db, writeLock, vaultPath);
  registerUndoOperations(server, db, writeLock, vaultPath);
});

afterEach(() => { setToolWriteHook(null); cleanup(); });

async function call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const result = await handlers.get(name)!(args);
  return JSON.parse(result.content[0]!.text);
}

function mintModelNote(): string {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: MODEL_PATH, title: 'Tool Minted',
    types: [], fields: MODEL_FIELDS, body: 'seeded for test',
  });
  return result.node_id;
}

const titles = () => catalog.entries().map(e => e.title);

describe('deleting a model note refreshes the catalog (#595)', () => {
  it('delete-node', async () => {
    const nodeId = mintModelNote();
    expect(titles()).toEqual(['Tool Minted']);
    const version = catalog.version();
    const changes = catalogChanges;

    const r = await call('delete-node', { node_id: nodeId, confirm: true, referencing_nodes_limit: 10 });

    expect(r.ok).toBe(true);
    expect(existsSync(join(vaultPath, MODEL_PATH))).toBe(false);
    expect(titles()).toEqual([]);
    expect(catalog.version()).toBe(version + 1);
    expect(catalogChanges).toBe(changes + 1);
  });

  it('a delete-node preview leaves the catalog alone', async () => {
    const nodeId = mintModelNote();
    expect(titles()).toEqual(['Tool Minted']);
    const version = catalog.version();

    const r = await call('delete-node', { node_id: nodeId, confirm: false, referencing_nodes_limit: 10 });

    expect(r.ok).toBe(true);
    expect(catalog.version()).toBe(version);
    expect(titles()).toEqual(['Tool Minted']);
  });

  it('batch-mutate, once the batch commits', async () => {
    const nodeId = mintModelNote();
    expect(titles()).toEqual(['Tool Minted']);
    const version = catalog.version();

    const preview = await call('batch-mutate', { dry_run: true, operations: [{ op: 'delete', params: { node_id: nodeId } }] });
    expect(preview.ok).toBe(true);
    expect(catalog.version()).toBe(version);
    expect(titles()).toEqual(['Tool Minted']);

    const r = await call('batch-mutate', { dry_run: false, operations: [{ op: 'delete', params: { node_id: nodeId } }] });
    expect(r.ok).toBe(true);
    expect(titles()).toEqual([]);
    expect(catalog.version()).toBe(version + 1);
  });

  it('an undo that removes a created model note', async () => {
    const created = await call('create-node', {
      title: 'Tool Minted', types: [], fields: MODEL_FIELDS, body: 'seeded for test',
      directory: 'Settings/Models', override_default_directory: true,
    });
    expect(created.ok).toBe(true);
    expect(titles()).toEqual(['Tool Minted']);
    const version = catalog.version();
    const { operation_id } = db.prepare(
      "SELECT operation_id FROM undo_operations WHERE source_tool = 'create-node' ORDER BY timestamp DESC LIMIT 1",
    ).get() as { operation_id: string };

    const r = await call('undo-operations', { operation_ids: [operation_id], dry_run: false });

    expect(r.ok).toBe(true);
    expect(titles()).toEqual([]);
    expect(catalog.version()).toBeGreaterThan(version);
  });
});
