import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { registerRenameGlobalField } from '../../src/mcp/tools/rename-global-field.js';
import { registerUpdateGlobalField } from '../../src/mcp/tools/update-global-field.js';
import { sha256 } from '../../src/indexer/hash.js';

type Mode = 'rename' | 'type-change';
let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let enqueued: Array<{ node_id: string; inTransaction: boolean }>;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  enqueued = [];
  createGlobalField(db, { name: 'count', field_type: 'string' });
  createSchemaDefinition(db, { name: 'note', field_claims: [{ field: 'count' }] });
  for (const name of ['a', 'b', 'c']) executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: `${name}.md`, title: name,
    types: ['note'], fields: { count: '12' }, body: 'Original body\n',
  });
  renderFieldsFile(db, vaultPath);
  renderSchemaFile(db, vaultPath, 'note');
});

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

async function changeField(mode: Mode, lock = writeLock, extra: Record<string, unknown> = {}) {
  let handler!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: typeof handler) => { handler = callback; },
  } as unknown as McpServer;
  const embeddingIndexer = {
    enqueue: ({ node_id }: { node_id: string }) => enqueued.push({ node_id, inTransaction: db.inTransaction }),
  } as unknown as EmbeddingIndexer;
  const register = mode === 'rename' ? registerRenameGlobalField : registerUpdateGlobalField;
  register(server, db, { vaultPath, writeLock: lock, embeddingIndexer });
  const args = mode === 'rename' ? { old_name: 'count', new_name: 'amount' }
    : { name: 'count', field_type: 'number', confirm: true };
  const response = await handler({ ...args, ...extra }) as { content: Array<{ text: string }> };
  return JSON.parse(response.content[0]!.text);
}

function orderedNodes() {
  const rows = db.prepare('SELECT DISTINCT node_id FROM node_fields WHERE field_name = ?').all('count') as Array<{ node_id: string }>;
  return rows.map(({ node_id }) => db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(node_id) as {
    id: string; file_path: string; title: string;
  });
}

function databaseSnapshot() {
  return Object.fromEntries([
    'global_fields', 'schemas', 'schema_field_claims', 'schema_file_hashes',
    'nodes', 'node_fields', 'node_explicit_null_fields', 'relationships', 'edits_log',
    'undo_operations', 'undo_snapshots', 'undo_global_field_snapshots', 'undo_schema_snapshots',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

function metadataBytes() {
  return ['.schemas/_fields.yaml', '.schemas/note.yaml'].map(path => readFileSync(join(vaultPath, path), 'utf8'));
}

describe.each<Mode>(['rename', 'type-change'])('global-field %s rollback', mode => {
  it.each(['before call', 'at write lock'])('rolls back all state when the last file disappears %s', async timing => {
    const paths = orderedNodes().map(node => join(vaultPath, node.file_path));
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const beforeDb = databaseSnapshot();
    const beforeMetadata = metadataBytes();
    const last = paths[2]!;
    const moved = join(vaultPath, 'moved.md');
    let injected = false;
    class RenameOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        if (path === last && !injected) {
          injected = true;
          expect(readFileSync(paths[0]!, 'utf8')).not.toBe(before[0]);
          renameSync(last, moved);
        }
        return super.withLockSync(path, fn);
      }
    }
    if (timing === 'before call') renameSync(last, moved);

    const result = await changeField(mode, timing === 'at write lock' ? new RenameOnLock() : writeLock);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('content changed since') } });
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(metadataBytes()).toEqual(beforeMetadata);
    expect(paths.slice(0, 2).map(path => readFileSync(path, 'utf8'))).toEqual(before.slice(0, 2));
    expect(existsSync(last)).toBe(false);
    expect(readFileSync(moved, 'utf8')).toBe(before[2]);
    expect(enqueued).toEqual([]);
    if (timing === 'at write lock') expect(injected).toBe(true);

    renameSync(moved, last);
    const retry = await changeField(mode);
    expect(retry).toMatchObject({ ok: true, data: { nodes_rerendered: 3, operation_id: expect.any(String) } });
    expect(enqueued).toHaveLength(3);
    expect(enqueued.every(entry => !entry.inTransaction)).toBe(true);
    const nodes = db.prepare('SELECT file_path, content_hash FROM nodes').all() as Array<{ file_path: string; content_hash: string }>;
    for (const node of nodes) expect(sha256(readFileSync(join(vaultPath, node.file_path), 'utf8'))).toBe(node.content_hash);
    expect(metadataBytes()).not.toEqual(beforeMetadata);
  });

  it.each(['edited', 'renamed'])('preserves a concurrent user change to an earlier file (%s)', async action => {
    const paths = orderedNodes().map(node => join(vaultPath, node.file_path));
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const beforeDb = databaseSnapshot();
    const beforeMetadata = metadataBytes();
    const movedFirst = join(vaultPath, 'moved-first.md');
    const userBytes = 'Concurrent user edit\n';
    let movedBytes = '';
    let injected = false;
    class ConcurrentChangeOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        if (path === paths[2] && !injected) {
          injected = true;
          if (action === 'edited') writeFileSync(paths[0]!, userBytes, 'utf8');
          else {
            movedBytes = readFileSync(paths[0]!, 'utf8');
            renameSync(paths[0]!, movedFirst);
          }
          renameSync(path, join(vaultPath, 'moved-last.md'));
        }
        return super.withLockSync(path, fn);
      }
    }

    expect((await changeField(mode, new ConcurrentChangeOnLock())).ok).toBe(false);
    expect(injected).toBe(true);
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(metadataBytes()).toEqual(beforeMetadata);
    expect(readFileSync(paths[1]!, 'utf8')).toBe(before[1]);
    if (action === 'edited') expect(readFileSync(paths[0]!, 'utf8')).toBe(userBytes);
    else {
      expect(existsSync(paths[0]!)).toBe(false);
      expect(readFileSync(movedFirst, 'utf8')).toBe(movedBytes);
    }
    expect(enqueued).toEqual([]);
  });
});

it('restores explicitly discarded uncoercible values when their missing projection aborts the type change', async () => {
  const last = orderedNodes()[2]!;
  executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: last.id, file_path: last.file_path, title: last.title,
    types: ['note'], fields: { count: 'not a number' }, body: 'Original body\n',
  });
  const paths = orderedNodes().map(node => join(vaultPath, node.file_path));
  const before = paths.map(path => readFileSync(path, 'utf8'));
  const beforeDb = databaseSnapshot();
  const beforeMetadata = metadataBytes();
  renameSync(join(vaultPath, last.file_path), join(vaultPath, 'moved.md'));

  expect((await changeField('type-change', writeLock, { discard_uncoercible: true })).ok).toBe(false);
  expect(databaseSnapshot()).toEqual(beforeDb);
  expect(metadataBytes()).toEqual(beforeMetadata);
  expect(paths.slice(0, 2).map(path => readFileSync(path, 'utf8'))).toEqual(before.slice(0, 2));
  expect(readFileSync(join(vaultPath, 'moved.md'), 'utf8')).toBe(before[2]);
  expect(enqueued).toEqual([]);
});
