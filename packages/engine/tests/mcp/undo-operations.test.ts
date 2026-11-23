import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { listOperations } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';
import { processFileChange } from '../../src/sync/watcher.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

describe('undo-operations', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerCreateNode(server, db, writeLock, vaultPath);
    registerUpdateNode(server, db, writeLock, vaultPath);
    registerDeleteNode(server, db, writeLock, vaultPath);
    registerUndoOperations(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('INVALID_PARAMS when neither operation_ids nor since provided', async () => {
    const result = await callTool(server, 'undo-operations', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('INVALID_PARAMS when both operation_ids and since provided', async () => {
    const result = await callTool(server, 'undo-operations', { operation_ids: ['x'], since: new Date().toISOString() });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('OPERATION_NOT_FOUND when id missing', async () => {
    const result = await callTool(server, 'undo-operations', { operation_ids: ['nope'], dry_run: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('OPERATION_NOT_FOUND');
  });

  it('with skip_missing, undoes the active operations and reports the rest (#644)', async () => {
    writeFileSync(join(vaultPath, 's.md'), '---\ntypes:\n  - note\n---\n# S\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    const written = JSON.parse((await callTool(server, 'update-node', { file_path: 's.md', set_body: 'v2' })).content[0].text);
    // A single-node write names its own undo operation.
    const operationId = written.data.operation_id as string;
    expect(operationId).toEqual(expect.any(String));

    const undone = JSON.parse((await callTool(server, 'undo-operations', {
      operation_ids: ['expired-long-ago', operationId], skip_missing: true, dry_run: false,
    })).content[0].text);
    expect(undone.ok).toBe(true);
    expect(undone.data).toMatchObject({ total_undone: 1, not_found: ['expired-long-ago'] });
    expect(readFileSync(join(vaultPath, 's.md'), 'utf-8')).toContain('v1');

    // Now nothing is active: an empty result, not a failure.
    const nothing = JSON.parse((await callTool(server, 'undo-operations', {
      operation_ids: [operationId], skip_missing: true, dry_run: false,
    })).content[0].text);
    expect(nothing).toMatchObject({ ok: true, data: { total_undone: 0, not_found: [operationId] } });

    const ranged = JSON.parse((await callTool(server, 'undo-operations', { since: new Date(0).toISOString(), skip_missing: true })).content[0].text);
    expect(ranged.error.code).toBe('INVALID_PARAMS');
  });

  it('dry-run returns zero total_undone but reports operations', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    const result = await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.total_undone).toBe(0);
    expect(payload.data.operations[0].status).toBe('would_undo');
  });

  it('executes undo when dry_run=false and reflects restored state', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    const result = await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: false });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.total_undone).toBe(1);
    const body = (db.prepare('SELECT body FROM nodes WHERE file_path = ?').get('u.md') as { body: string }).body;
    // Pre-update body as stored by indexer (retains H1 heading and trailing newline).
    expect(body).toBe('# U\n\nv1\n');
    expect(body).not.toBe('v2');
  });

  it('restores explicit-null markers from an update snapshot', async () => {
    const filePath = join(vaultPath, 'u.md');
    writeFileSync(filePath, '---\ntypes:\n  - note\ncontext:\n---\nv1\n', 'utf-8');
    processFileChange(filePath, 'u.md', db, writeLock, vaultPath);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'u.md'").get() as { id: string };

    await callTool(server, 'update-node', { node_id: node.id, set_fields: { context: 'work' } });
    const opId = listOperations(db, {}).operations[0].operation_id;
    expect(db.prepare(
      'SELECT explicit_null_fields FROM undo_snapshots WHERE operation_id = ? AND node_id = ?',
    ).get(opId, node.id)).toEqual({ explicit_null_fields: '["context"]' });

    await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: false });

    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?').all(node.id))
      .toEqual([{ field_name: 'context' }]);
    expect(readFileSync(filePath, 'utf-8')).toContain('\ncontext:\n');
  });

  it('captures explicit-null markers before a rename mutates identity', async () => {
    const filePath = join(vaultPath, 'u.md');
    writeFileSync(filePath, '---\ntypes:\n  - note\ncontext:\n---\nv1\n', 'utf-8');
    processFileChange(filePath, 'u.md', db, writeLock, vaultPath);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'u.md'").get() as { id: string };

    await callTool(server, 'update-node', { node_id: node.id, set_title: 'Renamed' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    expect(db.prepare(
      'SELECT explicit_null_fields FROM undo_snapshots WHERE operation_id = ? AND node_id = ?',
    ).get(opId, node.id)).toEqual({ explicit_null_fields: '["context"]' });
  });

  it('delete-node returns its undo operation, so one call brings the note back (#723)', async () => {
    const filePath = join(vaultPath, 'd.md');
    writeFileSync(filePath, '---\ntypes:\n  - note\n---\nbody\n', 'utf-8');
    processFileChange(filePath, 'd.md', db, writeLock, vaultPath);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'd.md'").get() as { id: string };
    const deleted = JSON.parse((await callTool(server, 'delete-node', { node_id: node.id, confirm: true, referencing_nodes_limit: 20 })).content[0].text);
    expect(deleted.data.operation_id).toBe(listOperations(db, {}).operations[0].operation_id);
    await callTool(server, 'undo-operations', { operation_ids: [deleted.data.operation_id], dry_run: false });
    expect(db.prepare('SELECT id FROM nodes WHERE id = ?').get(node.id)).toEqual({ id: node.id });
  });

  it('restores explicit-null markers after undoing node deletion', async () => {
    const filePath = join(vaultPath, 'u.md');
    writeFileSync(filePath, '---\ntypes:\n  - note\ncontext:\n---\nv1\n', 'utf-8');
    processFileChange(filePath, 'u.md', db, writeLock, vaultPath);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'u.md'").get() as { id: string };

    await callTool(server, 'delete-node', { node_id: node.id, confirm: true, referencing_nodes_limit: 20 });
    const opId = listOperations(db, {}).operations[0].operation_id;
    expect(db.prepare(
      'SELECT explicit_null_fields FROM undo_snapshots WHERE operation_id = ? AND node_id = ?',
    ).get(opId, node.id)).toEqual({ explicit_null_fields: '["context"]' });

    await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: false });

    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?').all(node.id))
      .toEqual([{ field_name: 'context' }]);
    expect(readFileSync(filePath, 'utf-8')).toContain('\ncontext:\n');
  });
});
