import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface ToolResult { ok: boolean; data?: any; error?: { code: string; message: string; details?: any }; warnings: unknown[]; }
function parseResult(result: unknown): ToolResult {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as ToolResult;
}
function getHandler(registerFn: (server: McpServer) => void) {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => { captured = (args) => h(args) as Promise<unknown>; },
    registerTool: (_n: string, _c: unknown, h: (...a: unknown[]) => unknown) => { captured = (args) => h(args) as Promise<unknown>; },
  } as unknown as McpServer;
  registerFn(fakeServer);
  return captured!;
}
function createNode(filePath = 'node.md', title = 'Node', body = '') {
  return executeMutation(db, writeLock, vaultPath, { source: 'tool', node_id: null, file_path: filePath, title, types: ['note'], fields: {}, body });
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  writeLock = new WriteLockManager();
});
afterEach(() => { db.close(); cleanup(); });

describe('update-node expected_content_hash', () => {
  it('applies when the hash matches and returns the new content_hash', async () => {
    const created = createNode('cas.md', 'Cas', 'start');
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
    const res = parseResult(await handler({ node_id: created.node_id, set_body: 'edited', expected_content_hash: created.rendered_hash }));
    expect(res.ok).toBe(true);
    expect(typeof res.data.content_hash).toBe('string');
    expect(res.data.content_hash).not.toBe(created.rendered_hash);
    const row = db.prepare('SELECT body, content_hash FROM nodes WHERE id = ?').get(created.node_id) as { body: string; content_hash: string };
    expect(row.body).toBe('edited');
    expect(res.data.content_hash).toBe(row.content_hash);
  });

  it('returns CONTENT_HASH_MISMATCH with current_node when the hash moved', async () => {
    const created = createNode('cas2.md', 'Cas2', 'original');
    const stale = created.rendered_hash;
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
    await handler({ node_id: created.node_id, set_body: 'concurrent' }); // moves the hash, no guard
    const res = parseResult(await handler({ node_id: created.node_id, set_body: 'mine', expected_content_hash: stale }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(res.error?.details.expected_content_hash).toBe(stale);
    expect(typeof res.error?.details.current_content_hash).toBe('string');
    expect(res.error?.details.current_node.id).toBe(created.node_id);
    expect(res.error?.details.current_node.body).toBe('concurrent');
    const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.node_id) as { body: string };
    expect(row.body).toBe('concurrent');
  });

  it('refuses when the file on disk holds a save the database has not read, and keeps that save', async () => {
    const created = createNode('cas-disk.md', 'Cas Disk', 'original');
    const absPath = join(vaultPath, 'cas-disk.md');
    const typed = readFileSync(absPath, 'utf8').replace('original', 'typed in the editor');
    writeFileSync(absPath, typed);
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));

    const res = parseResult(await handler({
      node_id: created.node_id,
      set_body: 'original with a [[Link]]',
      expected_content_hash: created.rendered_hash,
    }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(readFileSync(absPath, 'utf8')).toBe(typed);
    expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.node_id)).toEqual({ body: 'original' });
  });

  it('reports explicit-null fields in the current node for a content-hash retry', async () => {
    const created = createNode('cas-explicit-null.md', 'Cas Explicit Null', 'original');
    db.prepare(
      'INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)',
    ).run(created.node_id, 'context');
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));

    const res = parseResult(await handler({
      node_id: created.node_id,
      set_body: 'must not apply',
      expected_content_hash: 'stale-content-hash',
    }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(res.error?.details.current_node.fields).toEqual({ context: null });
    expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.node_id))
      .toEqual({ body: 'original' });
  });

  it('fails retryably without recreating a temporarily missing existing-node file', async () => {
    const created = createNode('rename-grace.md', 'Rename Grace', 'original');
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    const absPath = join(vaultPath, 'rename-grace.md');
    unlinkSync(absPath);

    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
    const res = parseResult(await handler({
      node_id: created.node_id,
      set_body: 'must not apply',
      expected_version: (beforeNode as { version: number }).version,
      expected_content_hash: created.rendered_hash,
    }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(res.error?.details.current_content_hash).toBeNull();
    expect(res.error?.details.current_node.id).toBe(created.node_id);
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('rechecks file presence inside the write lock before an existing-node write', async () => {
    const created = createNode('lock-race.md', 'Lock Race', 'original');
    const absPath = join(vaultPath, 'lock-race.md');
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id);
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
        if (!this.deleted && filePath === absPath) {
          this.deleted = true;
          unlinkSync(filePath);
        }
        return super.withLockSync(filePath, fn);
      }
    }
    writeLock = new DeleteOnLock();

    const enqueued: string[] = [];
    const handler = getHandler(server => registerUpdateNode(
      server,
      db,
      writeLock,
      vaultPath,
      undefined,
      { enqueue: ({ node_id }: { node_id: string }) => enqueued.push(node_id) } as any,
    ));
    const res = parseResult(await handler({
      node_id: created.node_id,
      set_body: 'must not apply',
    }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(res.error?.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
    expect(enqueued).toEqual([]);
  });

  it('rejects expected_content_hash in query mode', async () => {
    createNode('q.md', 'Q');
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
    const res = parseResult(await handler({ query: { types: ['note'] }, set_fields: { status: 'x' }, expected_content_hash: 'abc' }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_PARAMS');
    expect(res.error?.message).toMatch(/expected_content_hash/);
  });

  it('returns a retryable no-side-effect failure for a query update whose file disappears inside the lock', async () => {
    const created = createNode('query-race.md', 'Query Race', 'original');
    const absPath = join(vaultPath, 'query-race.md');
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id);
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
        if (!this.deleted && filePath === absPath) {
          this.deleted = true;
          unlinkSync(filePath);
        }
        return super.withLockSync(filePath, fn);
      }
    }
    writeLock = new DeleteOnLock();

    const enqueued: string[] = [];
    const handler = getHandler(server => registerUpdateNode(
      server,
      db,
      writeLock,
      vaultPath,
      undefined,
      { enqueue: ({ node_id }: { node_id: string }) => enqueued.push(node_id) } as any,
    ));
    const res = parseResult(await handler({
      query: { types: ['note'] },
      set_fields: { query_race: 'must not apply' },
      dry_run: false,
    }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(res.error?.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
    expect(enqueued).toEqual([]);
  });

  it('rolls back field/body changes and rename when a referencing file is already absent', async () => {
    const target = createNode('Rename Target.md', 'Rename Target', 'original');
    const reference = createNode('rename-reference.md', 'Rename Reference', 'See [[Rename Target]].');
    const targetAbsPath = join(vaultPath, 'Rename Target.md');
    const renamedAbsPath = join(vaultPath, 'Renamed Target.md');
    const referenceAbsPath = join(vaultPath, 'rename-reference.md');
    const beforeTargetFile = db.prepare('SELECT content_hash FROM nodes WHERE id = ?')
      .get(target.node_id) as { content_hash: string };
    const beforeNodes = db.prepare(
      'SELECT id, title, file_path, body, content_hash, version FROM nodes WHERE id IN (?, ?) ORDER BY id',
    ).all(target.node_id, reference.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(referenceAbsPath);

    const result = parseResult(await getHandler(server => registerUpdateNode(
      server,
      db,
      writeLock,
      vaultPath,
    ))({
      node_id: target.node_id,
      set_title: 'Renamed Target',
      set_body: 'must not apply',
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error?.details.current_content_hash).toBeNull();
    expect(existsSync(targetAbsPath)).toBe(true);
    expect(existsSync(renamedAbsPath)).toBe(false);
    expect(existsSync(referenceAbsPath)).toBe(false);
    expect(db.prepare(
      'SELECT id, title, file_path, body, content_hash, version FROM nodes WHERE id IN (?, ?) ORDER BY id',
    ).all(target.node_id, reference.node_id)).toEqual(beforeNodes);
    expect(db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(target.node_id))
      .toEqual(beforeTargetFile);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });
});

describe('batch-mutate missing existing-node files', () => {
  it.each([
    ['before execution', false],
    ['inside the write lock', true],
  ])('returns a retryable no-side-effect failure when the file disappears %s', async (_label, deleteOnLock) => {
    const created = createNode('batch-missing.md', 'Batch Missing', 'original');
    const absPath = join(vaultPath, 'batch-missing.md');
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();

    if (deleteOnLock) {
      class DeleteOnLock extends WriteLockManager {
        private deleted = false;

        override withLockSync<T>(filePath: string, fn: () => T): T {
          if (!this.deleted && filePath === absPath) {
            this.deleted = true;
            unlinkSync(filePath);
          }
          return super.withLockSync(filePath, fn);
        }
      }
      writeLock = new DeleteOnLock();
    } else {
      unlinkSync(absPath);
    }

    const handler = getHandler(server => registerBatchMutate(server, db, writeLock, vaultPath));
    const res = parseResult(await handler({
      operations: [{
        op: 'update',
        params: { node_id: created.node_id, set_body: 'must not apply' },
      }],
    }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(res.error?.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });
});
