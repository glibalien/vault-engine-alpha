import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: unknown): any {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('update-node set_title races with missing files', () => {
  it('fails retryably without recording undo state when the source Markdown is absent', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Inbox/Missing.md',
      title: 'Missing',
      types: ['bare'],
      fields: {},
      body: 'original',
    });
    const absPath = join(vaultPath, 'Inbox/Missing.md');
    const beforeNode = db.prepare(
      'SELECT title, file_path, body, content_hash, version FROM nodes WHERE id = ?',
    ).get(created.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(absPath);

    const result = parseResult(await getHandler()({
      node_id: created.node_id,
      set_title: 'Must Not Rename',
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error?.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(existsSync(join(vaultPath, 'Inbox/Must Not Rename.md'))).toBe(false);
    expect(db.prepare(
      'SELECT title, file_path, body, content_hash, version FROM nodes WHERE id = ?',
    ).get(created.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('fails retryably and rolls back the rename when a referencing file disappears inside its write lock', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Inbox/Race.md',
      title: 'Race',
      types: ['bare'],
      fields: {},
      body: 'original',
    });
    const referencing = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Inbox/Reference.md',
      title: 'Reference',
      types: ['bare'],
      fields: {},
      body: 'See [[Race]].',
    });
    const oldAbsPath = join(vaultPath, 'Inbox/Race.md');
    const newAbsPath = join(vaultPath, 'Inbox/Raced.md');
    const referenceAbsPath = join(vaultPath, 'Inbox/Reference.md');
    const beforeNodes = db.prepare(
      'SELECT title, file_path, body, content_hash, version FROM nodes WHERE id IN (?, ?) ORDER BY id',
    ).all(created.node_id, referencing.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();

    class DeleteOnLock extends WriteLockManager {
      private deleted = false;

      override withLockSync<T>(filePath: string, fn: () => T): T {
        if (!this.deleted && filePath === referenceAbsPath) {
          this.deleted = true;
          unlinkSync(filePath);
        }
        return super.withLockSync(filePath, fn);
      }
    }
    writeLock = new DeleteOnLock();

    const result = parseResult(await getHandler()({
      node_id: created.node_id,
      set_title: 'Raced',
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error?.details.current_content_hash).toBeNull();
    expect(existsSync(oldAbsPath)).toBe(true);
    expect(existsSync(newAbsPath)).toBe(false);
    expect(existsSync(referenceAbsPath)).toBe(false);
    expect(db.prepare(
      'SELECT title, file_path, body, content_hash, version FROM nodes WHERE id IN (?, ?) ORDER BY id',
    ).all(created.node_id, referencing.node_id)).toEqual(beforeNodes);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });
});
