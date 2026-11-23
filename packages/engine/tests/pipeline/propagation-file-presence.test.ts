import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ContentHashMismatchError, executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import * as fileWriter from '../../src/pipeline/file-writer.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
});

afterEach(() => {
  vi.restoreAllMocks();
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function createNode() {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'original.md', title: 'Original',
    types: [], fields: {}, body: 'Original body\n',
  });
}

describe('propagation file presence', () => {
  it('reads the body only for render comparison and rollback, not for presence checks', () => {
    const node = createNode();
    const read = vi.spyOn(fileWriter, 'readFileIfExists');

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'propagation', node_id: node.node_id,
      file_path: 'original.md', title: 'Original', types: [],
      fields: { added: 'schema change' }, body: 'Original body\n',
    });

    expect(result.file_written).toBe(true);
    expect(readFileSync(join(vaultPath, 'original.md'), 'utf8')).toContain('added: schema change');
    expect(read).toHaveBeenCalledExactlyOnceWith(join(vaultPath, 'original.md'));
  });

  it.each(['before mutation', 'at the write lock'])('does not resurrect a file renamed %s', timing => {
    const node = createNode();
    const originalPath = join(vaultPath, 'original.md');
    const renamedPath = join(vaultPath, 'renamed.md');
    const originalBytes = readFileSync(originalPath, 'utf8');
    const before = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.node_id);
    const editsBefore = db.prepare('SELECT * FROM edits_log').all();
    class RenameOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        renameSync(path, renamedPath);
        return super.withLockSync(path, fn);
      }
    }
    if (timing === 'before mutation') renameSync(originalPath, renamedPath);

    expect(() => executeMutation(db,
      timing === 'at the write lock' ? new RenameOnLock() : writeLock, vaultPath, {
        source: 'propagation', node_id: node.node_id,
        file_path: 'original.md', title: 'Original', types: [],
        fields: { added: 'schema change' }, body: 'Original body\n',
      })).toThrow(ContentHashMismatchError);

    expect(existsSync(originalPath)).toBe(false);
    expect(readFileSync(renamedPath, 'utf8')).toBe(originalBytes);
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.node_id)).toEqual(before);
    expect(db.prepare('SELECT * FROM edits_log').all()).toEqual(editsBefore);
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(node.node_id)).toEqual([]);
  });

  it('rejects a directory in place of an indexed file', () => {
    const node = createNode();
    const originalPath = join(vaultPath, 'original.md');
    renameSync(originalPath, join(vaultPath, 'renamed.md'));
    mkdirSync(originalPath);
    const before = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.node_id);

    expect(() => executeMutation(db, writeLock, vaultPath, {
      source: 'propagation', node_id: node.node_id,
      file_path: 'original.md', title: 'Original', types: [],
      fields: { added: 'schema change' }, body: 'Original body\n',
    })).toThrow(ContentHashMismatchError);

    expect(statSync(originalPath).isDirectory()).toBe(true);
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.node_id)).toEqual(before);
  });

  // Root can read mode-000 files; Windows does not implement POSIX read bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects a file the process cannot read', () => {
      const node = createNode();
      const originalPath = join(vaultPath, 'original.md');
      const before = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.node_id);
      chmodSync(originalPath, 0o000);

      try {
        expect(() => executeMutation(db, writeLock, vaultPath, {
          source: 'propagation', node_id: node.node_id,
          file_path: 'original.md', title: 'Original', types: [],
          fields: { added: 'schema change' }, body: 'Original body\n',
        })).toThrow(ContentHashMismatchError);

        expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.node_id)).toEqual(before);
      } finally {
        chmodSync(originalPath, 0o600);
      }
    },
  );

  it.each(['normalizer', 'undo', 'watcher'] as const)('preserves intentional %s recovery', source => {
    const node = createNode();
    renameSync(join(vaultPath, 'original.md'), join(vaultPath, 'renamed.md'));

    const result = executeMutation(db, writeLock, vaultPath, {
      source, node_id: node.node_id, file_path: 'original.md', title: 'Original',
      types: [], fields: {}, body: 'Original body\n',
    });

    expect(result.file_written).toBe(true);
    expect(existsSync(join(vaultPath, 'original.md'))).toBe(true);
  });

  it('preserves database-only propagation previews while the file is absent', () => {
    const node = createNode();
    renameSync(join(vaultPath, 'original.md'), join(vaultPath, 'renamed.md'));
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'propagation', node_id: node.node_id,
      file_path: 'original.md', title: 'Original', types: [], fields: {},
      body: 'Original body\n', db_only: true,
    });
    expect(result.file_written).toBe(false);
    expect(existsSync(join(vaultPath, 'original.md'))).toBe(false);
  });
});
