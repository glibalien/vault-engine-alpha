import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContentHashMismatchError, executeMutation } from '../../src/pipeline/execute.js';
import * as fileWriter from '../../src/pipeline/file-writer.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { sha256 } from '../../src/indexer/hash.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';

let db: ReturnType<typeof createTestDb>;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function create(overrides: Partial<ProposedMutation> = {}): ProposedMutation {
  return {
    source: 'tool', node_id: null, file_path: 'New.md', title: 'New',
    types: [], fields: {}, body: 'Engine body', expectedDiskContentHash: null, ...overrides,
  };
}

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

describe('expected-absent writes', () => {
  it('creates the file when it is still absent', () => {
    const result = executeMutation(db, writeLock, vaultPath, create());

    expect(result.file_written).toBe(true);
    expect(readFileSync(join(vaultPath, 'New.md'), 'utf8')).toContain('Engine body');
  });

  it('keeps a file an external writer creates after the absence check, and fails stale', () => {
    const target = join(vaultPath, 'New.md');
    // Obsidian saves the file right after the disk check under the write lock saw it absent,
    // before the publish. The write lock holds Engine writers only.
    const real = fileWriter.readFileIfExists;
    vi.spyOn(fileWriter, 'readFileIfExists').mockImplementation(path => {
      const content = real(path);
      if (path === target && writeLock.isLocked(target)) writeFileSync(target, 'external bytes');
      return content;
    });

    let error: unknown;
    try {
      executeMutation(db, writeLock, vaultPath, create());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ContentHashMismatchError);
    expect((error as ContentHashMismatchError).currentHash).toBe(sha256('external bytes'));
    expect(readFileSync(target, 'utf8')).toBe('external bytes');
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  it('still overwrites a file whose hash matches the expectation', () => {
    const first = executeMutation(db, writeLock, vaultPath, create());

    executeMutation(db, writeLock, vaultPath, create({
      node_id: first.node_id, body: 'Changed', expectedDiskContentHash: first.rendered_hash,
    }));

    expect(readFileSync(join(vaultPath, 'New.md'), 'utf8')).toContain('Changed');
  });

  it('does not take an unreadable target for an absent one', () => {
    // A directory where the note would go cannot be read as a file.
    mkdirSync(join(vaultPath, 'New.md'));

    expect(() => executeMutation(db, writeLock, vaultPath, create())).toThrow(/EISDIR/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  // Root reads any file, so the permission cannot be denied there.
  it.skipIf(process.getuid?.() === 0)('keeps a file it may not read rather than replacing it', () => {
    const target = join(vaultPath, 'New.md');
    writeFileSync(target, 'private bytes');
    chmodSync(target, 0o000);
    try {
      expect(() => executeMutation(db, writeLock, vaultPath, create())).toThrow(/EACCES/);
    } finally {
      chmodSync(target, 0o600);
    }

    expect(readFileSync(target, 'utf8')).toBe('private bytes');
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  it('removes its own created file on rollback, leaving nothing behind', () => {
    const rollback: Array<() => void> = [];

    executeMutation(db, writeLock, vaultPath, create(), undefined, undefined, rollback);
    for (const undo of rollback.reverse()) undo();

    expect(existsSync(join(vaultPath, 'New.md'))).toBe(false);
  });
});
