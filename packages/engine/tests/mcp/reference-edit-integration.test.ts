import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { referenceEditFixture } from '../helpers/reference-edit.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';
import * as fileWriter from '../../src/pipeline/file-writer.js';
import { updateSchemaDefinition } from '../../src/schema/crud.js';

const fixtures: ReturnType<typeof referenceEditFixture>[] = [];
afterEach(() => { setToolWriteHook(null); vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.cleanup()); });
function setup() {
  const f = referenceEditFixture(); fixtures.push(f);
  const callbacks = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const server = { tool: (name: string, _description: string, _schema: unknown, cb: (params: Record<string, unknown>) => Promise<unknown>) => { callbacks.set(name, cb); } } as unknown as McpServer;
  const enqueued: string[] = [];
  const indexer = { enqueue: ({ node_id }: { node_id: string }) => { expect(f.db.inTransaction).toBe(false); enqueued.push(node_id); } } as unknown as EmbeddingIndexer;
  registerUpdateNode(server, f.db, f.writeLock, f.vaultPath, new SyncLogger(f.db), indexer);
  registerUndoOperations(server, f.db, f.writeLock, f.vaultPath);
  const call = async (params: Record<string, unknown>, name = 'update-node') => {
    const result = await callbacks.get(name)!(params) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text);
  };
  const edit = (action = 'add', extra: Record<string, unknown> = {}, target = f.projectIds[1]) => call({ node_id: f.taskId, reference_edit: { field: 'project', action, target: { node_id: target } }, dry_run: false, ...extra });
  return { ...f, call, edit, enqueued };
}

describe('reference edit lifecycle', () => {
  it('uses commit order for opposing intents and does not claim exactly-once retries', async () => {
    const f = setup();
    const original = f.source();
    await f.edit(); await f.edit('remove'); await f.edit();
    expect(f.members()).toEqual(['P1', 'P2']);
    expect(await f.edit('add', { expected_version: original.version })).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    await f.edit('remove');
    expect(f.members()).toEqual(['P1']);
  });
  it('re-evaluates after preview and honors explicit preview guards', async () => {
    const f = setup();
    const preview = await f.edit('add', { dry_run: true });
    await f.edit('add', {}, f.projectIds[2]);
    expect(await f.edit('add', { expected_version: preview.data.reference_edit.observed_version })).toMatchObject({ ok: false });
    expect(await f.edit()).toMatchObject({ ok: true });
    expect(f.members()).toEqual(['P1', 'P3', 'P2']);
  });
  it('revalidates target type and schema after preview', async () => {
    const f = setup();
    await f.edit('add', { dry_run: true });
    f.db.prepare('DELETE FROM node_types WHERE node_id = ?').run(f.projectIds[1]);
    expect(await f.edit()).toMatchObject({ ok: false, error: { details: { reason: 'target_type' } } });
    updateSchemaDefinition(f.db, 'Task', { field_claims: [] });
    expect(await f.edit()).toMatchObject({ ok: false, error: { details: { reason: 'field_kind' } } });
  });
  it('publishes exactly one notification and search enqueue after commit, none for preview or no-op', async () => {
    const f = setup();
    const notifications: string[] = [];
    setToolWriteHook(path => { expect(f.db.inTransaction).toBe(false); notifications.push(path); });
    await f.edit('add', { dry_run: true });
    expect(f.enqueued).toEqual([]);
    expect(notifications).toEqual([]);
    await f.edit(); await f.edit();
    expect(notifications).toEqual(['Task.md']);
    expect(f.enqueued).toEqual([f.taskId]);
    expect(f.db.prepare('SELECT event FROM sync_log').all()).toEqual([{ event: 'file-written' }]);
  });
  it('rolls back files and all database effects when a post-write database step fails', async () => {
    const f = setup();
    f.db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON nodes BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const before = f.snapshot();
    const notifications: string[] = []; setToolWriteHook(path => { notifications.push(path); });
    expect(await f.edit()).toMatchObject({ ok: false });
    expect(f.snapshot()).toEqual(before);
    expect(f.enqueued).toEqual([]); expect(notifications).toEqual([]);
  });
  it('does not clobber a concurrent disk edit during rollback and reports incomplete restoration', async () => {
    const f = setup();
    f.db.function('interrupt_write', () => { writeFileSync(join(f.vaultPath, 'Task.md'), 'concurrent human edit'); throw new Error('injected'); });
    f.db.exec('CREATE TRIGGER injected_failure BEFORE UPDATE ON nodes BEGIN SELECT interrupt_write(); END');
    const before = f.snapshot().tables;
    expect(await f.edit()).toMatchObject({ ok: false, error: { details: { reason: 'rollback_incomplete' } } });
    expect(f.snapshot().tables).toEqual(before);
    expect(readFileSync(join(f.vaultPath, 'Task.md'), 'utf8')).toBe('concurrent human edit');
  });
  it('leaves no empty operation on filesystem failure', async () => {
    const f = setup();
    const before = f.snapshot();
    vi.spyOn(fileWriter, 'atomicWriteFile').mockImplementationOnce(() => { throw new Error('write failed'); });
    expect(await f.edit()).toMatchObject({ ok: false });
    expect(f.snapshot()).toEqual(before);
  });
  it('restores the projection when the outer commit fails after the pipeline succeeds', async () => {
    const f = setup();
    f.db.pragma('foreign_keys = ON');
    f.db.exec(`CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_at_commit AFTER UPDATE ON nodes BEGIN INSERT INTO commit_child VALUES (1); END;`);
    const before = f.snapshot();
    const notifications: string[] = []; setToolWriteHook(path => { notifications.push(path); });
    expect(await f.edit()).toMatchObject({ ok: false });
    expect(f.snapshot()).toEqual(before);
    expect(f.enqueued).toEqual([]); expect(notifications).toEqual([]);
    expect(f.db.prepare('SELECT * FROM commit_child').all()).toEqual([]);
  });
  it('restores a member change with normal undo and reports conflicts after a later edit', async () => {
    const f = setup();
    const result = await f.edit();
    const undone = await f.call({ operation_ids: [result.data.reference_edit.operation_id], dry_run: false }, 'undo-operations');
    expect(undone.ok).toBe(true);
    expect(f.members()).toEqual(['P1']);
    const again = await f.edit(); await f.edit('add', {}, f.projectIds[2]);
    const conflicted = await f.call({ operation_ids: [again.data.reference_edit.operation_id], dry_run: true }, 'undo-operations');
    expect(JSON.stringify(conflicted)).toMatch(/superseded_by_later_op|modified_after_operation/);
  });
  it('keeps a newly added title reference valid across ordinary rename and move', async () => {
    const f = setup();
    await f.edit();
    expect(await f.call({ node_id: f.projectIds[1], set_title: 'Renamed', set_directory: 'Moved' })).toMatchObject({ ok: true });
    expect(f.members()).toEqual(['P1', 'Renamed']);
    expect(await f.edit('remove')).toMatchObject({ ok: true });
    expect(f.members()).toEqual(['P1']);
  });
});
