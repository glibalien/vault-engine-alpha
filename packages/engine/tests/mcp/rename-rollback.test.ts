import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder, addUiHints } from '../../src/db/migrate.js';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('rename filesystem rollback', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-rename-rollback-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('reverses the on-disk rename when the outer transaction throws', () => {
    const writeLock = new WriteLockManager();

    // Create a node at Notes/old.md via the pipeline so DB and disk agree.
    const oldFilePath = 'Notes/old.md';
    const initial = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'old',
      types: [],
      fields: {},
      body: '# old',
    });
    const nodeId = initial.node_id;
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);

    const newFilePath = 'Notes/new.md';
    const fsUndos: Array<() => void> = [];
    const fsRollback = { push: (u: () => void) => fsUndos.push(u) };

    const txn = db.transaction(() => {
      executeRename(
        db,
        writeLock,
        vaultPath,
        { node_id: nodeId, file_path: oldFilePath, title: 'old' },
        'new',
        newFilePath,
        undefined,
        undefined,
        fsRollback,
      );
      throw new Error('simulated downstream failure after rename');
    });

    expect(() => txn()).toThrow('simulated downstream failure after rename');

    // Run the rollback (mimics what update-node does in its catch block).
    for (let i = fsUndos.length - 1; i >= 0; i--) {
      fsUndos[i]();
    }

    // DB-level: nodes row should still be at the old path.
    const row = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?')
      .get(nodeId) as { file_path: string; title: string };
    expect(row.file_path).toBe(oldFilePath);
    expect(row.title).toBe('old');

    // Filesystem: file should be back at the old path, not at the new path.
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, newFilePath))).toBe(false);
  });

  it('update-node set_title catch path: rolls back file and returns INTERNAL_ERROR', async () => {
    // Add undo tables + sort-order column (required by update-node →
    // createOperation and node_types sort_order queries).
    addUndoTables(db);
    addNodeTypesSortOrder(db);

    // Use a normal lock for setup so the node is created cleanly.
    const setupLock = new WriteLockManager();

    // Create the node. After this, Notes/RollbackOrig.md is on disk and in the DB.
    const oldFilePath = 'Notes/RollbackOrig.md';
    executeMutation(db, setupLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'RollbackOrig',
      types: [],
      fields: {},
      body: '',
    });
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);

    // Stale the DB content_hash so the no-op guard in executeMutation doesn't
    // short-circuit the write path inside executeRename's re-render step.
    // Without this, rendered content is identical to disk content and the
    // pipeline exits early, never reaching writeLock.withLockSync().
    db.prepare("UPDATE nodes SET content_hash = 'stale' WHERE file_path = ?")
      .run(oldFilePath);

    // Now build a WriteLockManager that throws on its very first withLockSync
    // call. Since the setup executeMutation used a separate lock, the first
    // call this lock sees is the re-render inside executeRename (after
    // renameSync has already moved the file to the new path).
    class FailingWriteLockManager extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        throw new Error('simulated write-lock failure on re-render');
      }
    }
    const failingLock = new FailingWriteLockManager();

    // Capture the registered handler via a fake McpServer (same pattern as
    // rename-node-directory.test.ts).
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
        handler = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerUpdateNode(fakeServer, db, failingLock, vaultPath);

    const newFilePath = 'Notes/RollbackNew.md';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Invoke the full handler. Inside executeRename:
    //   step 1 — renameSync moves the file to RollbackNew.md (already on disk)
    //   step 2 — UPDATE nodes SET file_path … (in txn)
    //   step 3 — executeMutation re-renders → withLockSync throws → txn rolls back
    // update-node's catch block runs fsUndos in reverse, restoring the file.
    const raw = await handler({ title: 'RollbackOrig', set_title: 'RollbackNew' });
    const result = JSON.parse(
      (raw as { content: Array<{ text: string }> }).content[0].text,
    );

    errorSpy.mockRestore();

    // 1. Handler returns INTERNAL_ERROR.
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INTERNAL_ERROR');

    // 2. DB row still points at the old path.
    const row = db.prepare('SELECT file_path FROM nodes WHERE title = ?')
      .get('RollbackOrig') as { file_path: string } | undefined;
    expect(row?.file_path).toBe(oldFilePath);

    // 3. File restored on disk.
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, newFilePath))).toBe(false);
  });

  it('update-node set_title catch path: restores executeMutation file writes before rolling back the rename', async () => {
    addUndoTables(db);
    addNodeTypesSortOrder(db);

    const setupLock = new WriteLockManager();

    const oldFilePath = 'Notes/RollbackOrig.md';
    executeMutation(db, setupLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'RollbackOrig',
      types: [],
      fields: {},
      body: '',
    });

    const refFilePath = 'Notes/Ref.md';
    executeMutation(db, setupLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: refFilePath,
      title: 'Ref',
      types: [],
      fields: {},
      body: 'See [[RollbackOrig]].',
    });

    class FailingAfterWriteLockManager extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        const result = fn();
        throw new Error(`simulated post-write failure for ${filePath}`);
      }
    }
    const failingLock = new FailingAfterWriteLockManager();

    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
        handler = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerUpdateNode(fakeServer, db, failingLock, vaultPath);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = await handler({ title: 'RollbackOrig', set_title: 'RollbackNew' });
    const result = JSON.parse(
      (raw as { content: Array<{ text: string }> }).content[0].text,
    );
    errorSpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INTERNAL_ERROR');

    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/RollbackNew.md'))).toBe(false);
    expect(readFileSync(join(vaultPath, refFilePath), 'utf-8')).toContain('[[RollbackOrig]]');
    expect(readFileSync(join(vaultPath, refFilePath), 'utf-8')).not.toContain('[[RollbackNew]]');
  });
  it('restores typed fields, duplicate list values, derived bindings and files after reference rewrite failure', async () => {
    addUndoTables(db);
    addNodeTypesSortOrder(db);
    addUiHints(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
    createSchemaDefinition(db, { name: 'project', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'projects' }] });
    const lock = new WriteLockManager();
    const p = executeMutation(db, lock, vaultPath, { source: 'tool', node_id: null,
      file_path: 'Old.md', title: 'Old', types: ['project'], fields: {}, body: '' });
    const s = executeMutation(db, lock, vaultPath, { source: 'tool', node_id: null,
      file_path: 'Task.md', title: 'Task', types: ['task'], fields: { projects: ['Old.md', 'Old.md'] }, body: '' });
    const oldFile = readFileSync(join(vaultPath, 'Old.md'), 'utf8');
    const refFile = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
    const before = db.prepare('SELECT * FROM relationships ORDER BY id').all();
    class FailReferenceLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        const result = fn();
        if (path.endsWith('Task.md')) throw new Error('reference write failed');
        return result;
      }
    }
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    registerUpdateNode({ tool: (_n: string, _d: string, _s: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer,
      db, new FailReferenceLock(), vaultPath);
    const response = await handler({ node_id: p.node_id, set_title: 'New' }) as { content: Array<{ text: string }> };
    expect(JSON.parse(response.content[0].text).ok).toBe(false);
    expect(db.prepare('SELECT * FROM relationships ORDER BY id').all()).toEqual(before);
    expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'projects'").get(s.node_id))
      .toEqual({ value_json: '["Old.md","Old.md"]' });
    expect(readFileSync(join(vaultPath, 'Old.md'), 'utf8')).toBe(oldFile);
    expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(refFile);
    expect(existsSync(join(vaultPath, 'New.md'))).toBe(false);
  });

});
