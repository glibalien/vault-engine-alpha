import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { sha256 } from '../../src/indexer/hash.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  createGlobalField(db, { name: 'status', field_type: 'string', required: true, default_value: 'open' });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  for (const name of ['a', 'b', 'c']) {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: `${name}.md`, title: name,
      types: ['note'], fields: {}, body: `Original ${name}\n`,
    });
  }
});

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function updateSchema(lock = writeLock, dryRun = false): Promise<{ ok: boolean; error?: { message: string } }> {
  let handler!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    registerTool: (_name: string, _config: unknown, callback: typeof handler) => { handler = callback; },
  } as unknown as McpServer;
  registerUpdateSchema(server, db, { writeLock: lock, vaultPath });
  return handler({ name: 'note', field_claims: [{ field: 'status' }], dry_run: dryRun }).then(result => {
    const response = result as { content: Array<{ text: string }> };
    return JSON.parse(response.content[0]!.text);
  });
}

function orderedPaths(): string[] {
  // Match the production propagation query without assuming nanoid ordering.
  const rows = db.prepare('SELECT node_id FROM node_types WHERE schema_type = ?').all('note') as Array<{ node_id: string }>;
  return rows.map(row => {
    const node = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(row.node_id) as { file_path: string };
    return join(vaultPath, node.file_path);
  });
}

function databaseSnapshot() {
  return Object.fromEntries([
    'schemas', 'schema_field_claims', 'nodes', 'node_fields', 'node_explicit_null_fields',
    'edits_log', 'undo_operations', 'undo_snapshots', 'undo_schema_snapshots',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

describe('update-schema filesystem rollback', () => {
  it.each(['before call', 'at write lock'])('restores earlier files when the last projection disappears %s', async timing => {
    const paths = orderedPaths();
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const beforeDb = databaseSnapshot();
    const last = paths[2]!;
    const moved = join(vaultPath, 'moved.md');
    let renamed = false;
    class RenameOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        // Preview also takes locks. Only inject the rename after live writes
        // have changed an earlier file, proving rollback covers a late race.
        if (path === last && !renamed && readFileSync(paths[0]!, 'utf8') !== before[0]) {
          renamed = true;
          renameSync(last, moved);
        }
        return super.withLockSync(path, fn);
      }
    }
    if (timing === 'before call') renameSync(last, moved);

    const result = await updateSchema(timing === 'at write lock' ? new RenameOnLock() : writeLock);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('content changed since') } });
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(readFileSync(paths[0]!, 'utf8')).toBe(before[0]);
    expect(readFileSync(paths[1]!, 'utf8')).toBe(before[1]);
    expect(existsSync(last)).toBe(false);
    expect(readFileSync(moved, 'utf8')).toBe(before[2]);

    // A rejected attempt leaves no phantom defaults/undo rows and is retryable
    // after the missing projection is restored.
    renameSync(moved, last);
    expect((await updateSchema()).ok).toBe(true);
    for (const path of paths) expect(readFileSync(path, 'utf8')).toContain('status: open');
  });

  it.each(['edited', 'renamed'])('preserves an earlier file %s by the user while rolling back other files', async change => {
    const paths = orderedPaths();
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const beforeDb = databaseSnapshot();
    const movedLast = join(vaultPath, 'moved-last.md');
    const movedFirst = join(vaultPath, 'moved-first.md');
    const userBytes = 'User content saved during propagation\n';
    let injected = false;
    let renamedBytes = '';
    class ConcurrentChangesOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        if (path === paths[2] && !injected && readFileSync(paths[0]!, 'utf8') !== before[0]) {
          injected = true;
          if (change === 'edited') writeFileSync(paths[0]!, userBytes, 'utf8');
          else {
            renamedBytes = readFileSync(paths[0]!, 'utf8');
            renameSync(paths[0]!, movedFirst);
          }
          renameSync(path, movedLast);
        }
        return super.withLockSync(path, fn);
      }
    }

    const result = await updateSchema(new ConcurrentChangesOnLock());

    expect(result.ok).toBe(false);
    expect(injected).toBe(true);
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(readFileSync(paths[1]!, 'utf8')).toBe(before[1]);
    if (change === 'edited') expect(readFileSync(paths[0]!, 'utf8')).toBe(userBytes);
    else {
      expect(existsSync(paths[0]!)).toBe(false);
      expect(readFileSync(movedFirst, 'utf8')).toBe(renamedBytes);
    }
    expect(existsSync(paths[2]!)).toBe(false);
    expect(readFileSync(movedLast, 'utf8')).toBe(before[2]);
  });

  it('keeps successful propagation and dry-run behavior intact', async () => {
    const paths = orderedPaths();
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const beforeDb = databaseSnapshot();
    expect((await updateSchema(writeLock, true)).ok).toBe(true);
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before);

    expect((await updateSchema()).ok).toBe(true);
    const nodes = db.prepare('SELECT file_path, content_hash FROM nodes').all() as Array<{ file_path: string; content_hash: string }>;
    for (const node of nodes) {
      const content = readFileSync(join(vaultPath, node.file_path), 'utf8');
      expect(content).toContain('status: open');
      expect(sha256(content)).toBe(node.content_hash);
    }
  });
});
