import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { executeDeletion } from '../../src/pipeline/delete.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { restoreMany } from '../../src/undo/restore.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import * as fileWriter from '../../src/pipeline/file-writer.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { captureSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
import { captureGlobalFieldSnapshot } from '../../src/undo/global-field-snapshot.js';

let db: ReturnType<typeof createTestDb>;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
});

afterEach(() => {
  setToolWriteHook(null);
  vi.restoreAllMocks();
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function mutate(body: string, nodeId: string | null = null, operationId?: string) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: nodeId, file_path: 'sequence.md', title: 'Sequence',
    types: [], fields: {}, body,
  }, undefined, operationId ? { operation_id: operationId } : undefined);
}

function operation(description: string, run: (id: string) => void) {
  const id = createOperation(db, { source_tool: 'batch-mutate', description });
  run(id);
  finalizeOperation(db, id);
  return id;
}

function deleteNode(nodeId: string, operationId: string) {
  executeDeletion(db, writeLock, vaultPath, {
    source: 'tool', node_id: nodeId, file_path: 'sequence.md', unlink_file: true,
  }, { operation_id: operationId });
}

function snapshot() {
  return Object.fromEntries([
    'nodes', 'node_fields', 'node_types', 'node_explicit_null_fields', 'relationships',
    'nodes_fts', 'edits_log', 'undo_operations', 'undo_snapshots', 'memories',
    'schemas', 'schema_field_claims', 'global_fields', 'undo_schema_snapshots', 'undo_global_field_snapshots',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

describe('sequential undo previews', () => {
  it('checks older updates against the state restored by newer updates without retaining effects', () => {
    const node = mutate('v1');
    const first = operation('v2', id => { mutate('v2', node.node_id, id); });
    const second = operation('v3', id => { mutate('v3', node.node_id, id); });
    const before = snapshot();
    const bytes = readFileSync(join(vaultPath, 'sequence.md'), 'utf8');
    const write = vi.spyOn(fileWriter, 'atomicWriteFile');
    const lock = vi.spyOn(writeLock, 'withLockSync');
    const hook = vi.fn();
    setToolWriteHook(hook);

    const preview = restoreMany(db, writeLock, vaultPath, { operation_ids: [first, second], dry_run: true });

    expect(preview.conflicts).toEqual([]);
    expect(preview.operations.map(item => item.status)).toEqual(['would_undo', 'would_undo']);
    expect(preview.total_undone).toBe(0);
    expect(preview.restored_node_ids).toEqual([]);
    expect(preview.deleted_node_ids).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(vaultPath, 'sequence.md'), 'utf8')).toBe(bytes);
    expect(write).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();

    const live = restoreMany(db, writeLock, vaultPath, { operation_ids: [first, second], dry_run: false });
    expect(live.conflicts).toEqual(preview.conflicts);
    expect(live.total_undone).toBe(2);
    expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id)).toEqual({ body: 'v1' });
  });

  it('releases a reused path before previewing restoration of its earlier occupant', () => {
    const original = mutate('Original');
    const deletion = operation('delete original', id => { deleteNode(original.node_id, id); });
    const creation = operation('create replacement', id => { mutate('Replacement', null, id); });
    const before = snapshot();
    const preview = restoreMany(db, writeLock, vaultPath, { operation_ids: [deletion, creation], dry_run: true });
    expect(preview.conflicts).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(vaultPath, 'sequence.md'), 'utf8')).toContain('Replacement');

    const live = restoreMany(db, writeLock, vaultPath, { operation_ids: [deletion, creation], dry_run: false });
    expect(live.conflicts).toEqual(preview.conflicts);
    expect(db.prepare('SELECT id, body FROM nodes').all()).toEqual([{ id: original.node_id, body: 'Original' }]);
  });

  it('simulates mixed create/update/delete history and suppresses deletion observers', () => {
    let nodeId = '';
    const creation = operation('create', id => { nodeId = mutate('v1', null, id).node_id; });
    const update = operation('update', id => { mutate('v2', nodeId, id); });
    const deletion = operation('delete', id => { deleteNode(nodeId, id); });
    // A vault memory can still depend on the deleted identity. During preview,
    // restoring and then deleting that identity must not announce expiration.
    db.prepare(`INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_node_id)
      VALUES ('curator', 'vault', 'Memory', '2026-01-01', '2026-01-01', '2026-01-01', 'note', ?)`).run(nodeId);
    const before = snapshot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const preview = restoreMany(db, writeLock, vaultPath, { operation_ids: [creation, update, deletion], dry_run: true });
    expect(preview.conflicts).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(vaultPath, 'sequence.md'))).toBe(false);
    expect(log).not.toHaveBeenCalled();

    const live = restoreMany(db, writeLock, vaultPath, { operation_ids: [creation, update, deletion], dry_run: false });
    expect(live.conflicts).toEqual(preview.conflicts);
    expect(live.total_undone).toBe(3);
    expect(db.prepare('SELECT id FROM nodes').all()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expired 1 dependent memory'));
  });

  it.each([undefined, 'skip', 'revert'] as const)('preserves live conflict resolution semantics (%s)', action => {
    const node = mutate('v1');
    const first = operation('v2', id => { mutate('v2', node.node_id, id); });
    const second = operation('v3', id => { mutate('v3', node.node_id, id); });
    mutate('External change', node.node_id);
    const options = { operation_ids: [first, second],
      ...(action ? { resolve_conflicts: [{ node_id: node.node_id, action }] } : {}),
    };
    const before = snapshot();
    const preview = restoreMany(db, writeLock, vaultPath, { ...options, dry_run: true });
    expect(snapshot()).toEqual(before);
    const live = restoreMany(db, writeLock, vaultPath, { ...options, dry_run: false });
    expect(preview.conflicts).toEqual(live.conflicts);
    expect(live.total_conflicts).toBe(action === 'revert' ? 1 : 2);
  });

  it('preserves missing-file recovery for a single operation', () => {
    const node = mutate('v1');
    const update = operation('v2', id => { mutate('v2', node.node_id, id); });
    unlinkSync(join(vaultPath, 'sequence.md'));
    const preview = restoreMany(db, writeLock, vaultPath, { operation_ids: [update], dry_run: true });
    expect(preview.conflicts).toEqual([]);
    expect(existsSync(join(vaultPath, 'sequence.md'))).toBe(false);
    expect(restoreMany(db, writeLock, vaultPath, { operation_ids: [update], dry_run: false }).conflicts).toEqual([]);
    expect(readFileSync(join(vaultPath, 'sequence.md'), 'utf8')).toContain('v1');
  });

  it('rolls back simulated schema and global-field restores without applying their file actions', () => {
    const definitions = operation('create definitions', id => {
      captureGlobalFieldSnapshot(db, id, 'status', { was_new: true });
      createGlobalField(db, { name: 'status', field_type: 'string' });
      captureSchemaSnapshot(db, id, 'task', { was_new: true });
      createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
    const creation = operation('create task', id => {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: null, file_path: 'sequence.md', title: 'Sequence',
        types: ['task'], fields: { status: 'open' }, body: 'Task',
      }, undefined, { operation_id: id });
    });
    const before = snapshot();
    const files = ['sequence.md', '.schemas/task.yaml', '.schemas/_fields.yaml'];
    const bytes = files.map(path => readFileSync(join(vaultPath, path), 'utf8'));
    const write = vi.spyOn(fileWriter, 'atomicWriteFile');

    const preview = restoreMany(db, writeLock, vaultPath, { operation_ids: [definitions, creation], dry_run: true });
    expect(preview.conflicts).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(files.map(path => readFileSync(join(vaultPath, path), 'utf8'))).toEqual(bytes);
    expect(write).not.toHaveBeenCalled();

    const live = restoreMany(db, writeLock, vaultPath, { operation_ids: [definitions, creation], dry_run: false });
    expect(live.conflicts).toEqual(preview.conflicts);
    expect(db.prepare('SELECT id FROM nodes').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM schemas WHERE name = 'task'").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM global_fields WHERE name = 'status'").all()).toEqual([]);
  });

  it('rolls back prior simulated restores when a later snapshot fails the live safe-path check', () => {
    const node = mutate('v1');
    const first = operation('v2', id => { mutate('v2', node.node_id, id); });
    const second = operation('v3', id => { mutate('v3', node.node_id, id); });
    db.prepare('UPDATE undo_snapshots SET file_path = ? WHERE operation_id = ?').run('../outside.md', first);
    const before = snapshot();
    const bytes = readFileSync(join(vaultPath, 'sequence.md'), 'utf8');
    const write = vi.spyOn(fileWriter, 'atomicWriteFile');

    expect(() => restoreMany(db, writeLock, vaultPath, { operation_ids: [first, second], dry_run: true }))
      .toThrow();
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(vaultPath, 'sequence.md'), 'utf8')).toBe(bytes);
    expect(write).not.toHaveBeenCalled();
  });
});
