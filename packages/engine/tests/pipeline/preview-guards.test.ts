import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertMutationPreviewGuards, ContentHashMismatchError, executeMutation, StaleNodeError,
} from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import * as fileWriter from '../../src/pipeline/file-writer.js';

let db: ReturnType<typeof createTestDb>;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let nodeId: string;
let currentHash: string;

function mutation(overrides: Partial<ProposedMutation> = {}): ProposedMutation {
  return {
    source: 'tool', node_id: nodeId, file_path: 'preview.md', title: 'Preview',
    types: [], fields: {}, body: 'Original', ...overrides,
  };
}

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  const operationId = createOperation(db, { source_tool: 'create-node', description: 'Original' });
  const created = executeMutation(db, writeLock, vaultPath, mutation({ node_id: null }),
    undefined, { operation_id: operationId });
  finalizeOperation(db, operationId);
  nodeId = created.node_id;
  currentHash = created.rendered_hash;
  writeLock.clearRecentWrites();
});

afterEach(() => {
  setToolWriteHook(null);
  vi.restoreAllMocks();
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function snapshot() {
  const path = join(vaultPath, 'preview.md');
  return {
    file: existsSync(path) ? readFileSync(path, 'utf8') : null,
    tables: Object.fromEntries([
      'nodes', 'node_fields', 'node_types', 'node_explicit_null_fields', 'relationships',
      'nodes_fts', 'edits_log', 'undo_operations', 'undo_snapshots',
    ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])),
  };
}

function rejection(proposed: ProposedMutation, expected: typeof ContentHashMismatchError | typeof StaleNodeError) {
  const before = snapshot();
  expect(() => assertMutationPreviewGuards(db, writeLock, vaultPath, proposed)).toThrow(expected);
  expect(snapshot()).toEqual(before);
  expect(() => executeMutation(db, writeLock, vaultPath, proposed)).toThrow(expected);
  expect(snapshot()).toEqual(before);
}

describe('assertMutationPreviewGuards', () => {
  it.each([false, true])('prepares a changed mutation without DB, history, file or notification effects (db_only=%s)', dbOnly => {
    const before = snapshot();
    const hook = vi.fn();
    setToolWriteHook(hook);
    const write = vi.spyOn(fileWriter, 'atomicWriteFile');
    const proposed = mutation({ body: 'Changed [[Target]]', fields: { count: 42 }, db_only: dbOnly,
      expectedVersion: 1, expectedContentHash: currentHash, expectedDiskContentHash: currentHash });

    expect(() => assertMutationPreviewGuards(db, writeLock, vaultPath, proposed)).not.toThrow();

    expect(snapshot()).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(writeLock.isLocked(join(vaultPath, 'preview.md'))).toBe(false);

    const result = executeMutation(db, writeLock, vaultPath, proposed);
    expect(result.file_written).toBe(!dbOnly);
    expect(db.prepare('SELECT body, version FROM nodes WHERE id = ?').get(nodeId))
      .toEqual({ body: 'Changed [[Target]]', version: 2 });
    if (dbOnly) expect(hook).not.toHaveBeenCalled();
    else expect(hook).toHaveBeenCalledWith('preview.md');
  });

  it.each(['tool', 'propagation'] as const)('rejects an indexed missing file like live %s mutations', source => {
    unlinkSync(join(vaultPath, 'preview.md'));
    rejection(mutation({ source, body: 'Changed' }), ContentHashMismatchError);
    expect(existsSync(join(vaultPath, 'preview.md'))).toBe(false);
  });

  it('retains the db_only missing-file and disk-CAS exceptions without persisting DB changes', () => {
    unlinkSync(join(vaultPath, 'preview.md'));
    const proposed = mutation({ body: 'Changed', db_only: true, expectedDiskContentHash: 'stale' });
    const before = snapshot();
    expect(() => assertMutationPreviewGuards(db, writeLock, vaultPath, proposed)).not.toThrow();
    expect(snapshot()).toEqual(before);
    expect(executeMutation(db, writeLock, vaultPath, proposed).file_written).toBe(false);
    expect(existsSync(join(vaultPath, 'preview.md'))).toBe(false);
  });

  it.each(['normalizer', 'undo', 'watcher'] as const)('retains %s missing-file recovery without recreating during preview', source => {
    unlinkSync(join(vaultPath, 'preview.md'));
    const proposed = mutation({ source, body: 'Changed' });
    const before = snapshot();
    expect(() => assertMutationPreviewGuards(db, writeLock, vaultPath, proposed)).not.toThrow();
    expect(snapshot()).toEqual(before);
    expect(executeMutation(db, writeLock, vaultPath, proposed).file_written).toBe(true);
  });

  it.each([false, true])('rejects a stale version for a changed mutation (db_only=%s)', dbOnly => {
    rejection(mutation({ body: 'Changed', expectedVersion: 0, db_only: dbOnly }), StaleNodeError);
  });

  it.each(['Original', 'Changed'])('checks DB content hash before the no-op branch (body=%s)', body => {
    rejection(mutation({ body, expectedContentHash: 'stale', expectedVersion: 0 }), ContentHashMismatchError);
  });

  it('preserves the stale-version and disk-CAS exceptions for a genuine no-op', () => {
    const proposed = mutation({ expectedVersion: 0, expectedContentHash: currentHash, expectedDiskContentHash: 'stale' });
    const before = snapshot();
    const hook = vi.fn();
    setToolWriteHook(hook);
    expect(() => assertMutationPreviewGuards(db, writeLock, vaultPath, proposed)).not.toThrow();
    expect(snapshot()).toEqual(before);
    expect(executeMutation(db, writeLock, vaultPath, proposed).file_written).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(hook).not.toHaveBeenCalled();
  });

  it('checks a stale version when identical rendered bytes still change node identity', () => {
    // A stored title that drifted from the filename is reset by any write, so
    // identical bytes still change identity.
    db.prepare("UPDATE nodes SET title = 'Drifted Title' WHERE id = ?").run(nodeId);
    rejection(mutation({ expectedVersion: 0 }), StaleNodeError);
  });

  it.each(['stale', null])('rejects mismatched disk CAS for a changed mutation (expected=%s)', expectedDiskContentHash => {
    rejection(mutation({ body: 'Changed', expectedDiskContentHash }), ContentHashMismatchError);
  });

  it('checks disk drift even when the stored DB hash still matches', () => {
    writeFileSync(join(vaultPath, 'preview.md'), 'External edit');
    rejection(mutation({ body: 'Changed', expectedContentHash: currentHash,
      expectedDiskContentHash: currentHash }), ContentHashMismatchError);
  });

  it('checks disk CAS under the same write-lock boundary as live mutation', () => {
    const path = join(vaultPath, 'preview.md');
    const bytes = readFileSync(path, 'utf8');
    class EditOnLock extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        writeFileSync(filePath, 'Changed at lock');
        return super.withLockSync(filePath, fn);
      }
    }
    const before = snapshot().tables;
    const proposed = mutation({ body: 'Changed', expectedDiskContentHash: currentHash });
    for (const run of [assertMutationPreviewGuards, executeMutation]) {
      writeFileSync(path, bytes);
      expect(() => run(db, new EditOnLock(), vaultPath, proposed)).toThrow(ContentHashMismatchError);
      expect(snapshot().tables).toEqual(before);
      expect(readFileSync(path, 'utf8')).toBe('Changed at lock');
    }
  });

  it('rechecks file presence at the write lock in preview and live execution', () => {
    const path = join(vaultPath, 'preview.md');
    const bytes = readFileSync(path, 'utf8');
    class UnlinkOnLock extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        unlinkSync(filePath);
        return super.withLockSync(filePath, fn);
      }
    }
    const before = snapshot().tables;
    for (const run of [assertMutationPreviewGuards, executeMutation]) {
      writeFileSync(path, bytes);
      expect(() => run(db, new UnlinkOnLock(), vaultPath, mutation({ body: 'Changed' })))
        .toThrow(ContentHashMismatchError);
      expect(snapshot().tables).toEqual(before);
      expect(existsSync(path)).toBe(false);
    }
  });

  it('allows absent-file creation with null disk CAS without creating a preview node or file', () => {
    const proposed = mutation({ node_id: null, file_path: 'new.md', expectedDiskContentHash: null });
    const before = snapshot();
    expect(() => assertMutationPreviewGuards(db, writeLock, vaultPath, proposed)).not.toThrow();
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(vaultPath, 'new.md'))).toBe(false);
    expect(executeMutation(db, writeLock, vaultPath, proposed).file_written).toBe(true);
    expect(existsSync(join(vaultPath, 'new.md'))).toBe(true);
  });
});
