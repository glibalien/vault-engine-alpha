import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { executeDeletion } from '../../src/pipeline/delete.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField, updateGlobalField, renameGlobalField, deleteGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition, deleteSchemaDefinition } from '../../src/schema/crud.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { captureGlobalFieldSnapshot, restoreGlobalFieldSnapshot } from '../../src/undo/global-field-snapshot.js';
import { restoreOperation } from '../../src/undo/restore.js';

let db: Database.Database;
let vault: string;
let lock: WriteLockManager;
beforeEach(() => {
  db = createTestDb();
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
  vault = mkdtempSync(join(tmpdir(), 'typed-lifecycle-'));
  lock = new WriteLockManager();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'person', field_type: 'reference', reference_target: 'person' });
});
afterEach(() => { db.close(); rmSync(vault, { recursive: true, force: true }); });
function node(id: string, title = 'Same', types = ['project'], fields: Record<string, unknown> = {}) {
  return executeMutation(db, lock, vault, { source: 'watcher', node_id: id, file_path: `${id}.md`, title, types, fields, body: 'unchanged' });
}
function target(field = 'project') {
  return (db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = ?').get('src', field) as { resolved_target_id: string | null } | undefined)?.resolved_target_id;
}
function source() { node('src', 'Source', [], { project: 'Same', person: 'Same', empty: [], explicit: null }); }
function remove(id: string) { executeDeletion(db, lock, vault, { source: 'watcher', node_id: id, file_path: `${id}.md`, unlink_file: false }); }

describe('typed reference lifecycle', () => {
  it('invalidates non-null edges on duplicate creation and restores uniqueness on deletion without changing sources', () => {
    node('p1'); source();
    expect(target()).toBe('p1');
    const before = db.prepare("SELECT * FROM nodes WHERE id = 'src'").get();
    const fields = db.prepare("SELECT * FROM node_fields WHERE node_id = 'src'").all();
    writeFileSync(join(vault, 'src.md'), 'source bytes');
    db.prepare("INSERT INTO embedding_meta (node_id, source_type, source_hash, embedded_at) VALUES ('src', 'body', 'hash', 'now')").run();
    const embeddings = db.prepare("SELECT * FROM embedding_meta WHERE node_id = 'src'").all();
    node('wiki', 'Same', ['wiki']); expect(target()).toBe('p1');
    node('p2'); expect(target()).toBeNull();
    remove('p2'); expect(target()).toBe('p1');
    expect(db.prepare("SELECT * FROM nodes WHERE id = 'src'").get()).toEqual(before);
    expect(db.prepare("SELECT * FROM node_fields WHERE node_id = 'src'").all()).toEqual(fields);
    expect(db.prepare("SELECT * FROM embedding_meta WHERE node_id = 'src'").all()).toEqual(embeddings);
    expect(readFileSync(join(vault, 'src.md'), 'utf8')).toBe('source bytes');
  });
  it('recomputes target type changes independently for the same raw text', () => {
    node('p1'); node('person1', 'Same', ['person']); source();
    expect(target()).toBe('p1'); expect(target('person')).toBe('person1');
    node('p1', 'Same', ['wiki']); expect(target()).toBeNull();
    node('p1'); expect(target()).toBe('p1');
    expect(target('person')).toBe('person1');
  });
  it('recomputes rename into and out of collision including formerly non-null rows', () => {
    node('p1'); node('p2', 'Other'); source();
    node('p2'); expect(target()).toBeNull();
    node('p2', 'Other'); expect(target()).toBe('p1');
  });
  it('uses the final composed batch state and rolls preview state back', () => {
    node('p1');
    expect(() => db.transaction(() => {
      source(); expect(target()).toBe('p1'); node('p2'); expect(target()).toBeNull();
      throw new Error('preview rollback');
    })()).toThrow('preview rollback');
    expect(db.prepare("SELECT id FROM nodes WHERE id IN ('src', 'p2')").all()).toEqual([]);
    db.transaction(() => { source(); node('p2'); })(); expect(target()).toBeNull();
  });
  it('refreshes incoming bindings during indexFile without a source reindex', () => {
    node('p1'); source();
    writeFileSync(join(vault, 'Same.md'), '---\ntypes: [project]\n---\n');
    indexFile(join(vault, 'Same.md'), vault, db); expect(target()).toBeNull();
    writeFileSync(join(vault, 'Same.md'), '---\ntypes: [wiki]\n---\n');
    indexFile(join(vault, 'Same.md'), vault, db); expect(target()).toBe('p1');
  });
  it('refreshes reference_target-only changes and undo without changing raw values or source versions', () => {
    node('p1'); node('person1', 'Same', ['person']); source();
    const before = db.prepare("SELECT * FROM nodes WHERE id = 'src'").get();
    const operation = createOperation(db, { source_tool: 'test', description: 'target change' });
    captureGlobalFieldSnapshot(db, operation, 'project');
    updateGlobalField(db, 'project', { reference_target: 'person' }); expect(target()).toBe('person1');
    restoreGlobalFieldSnapshot(db, operation, 'project'); expect(target()).toBe('p1');
    expect(db.prepare("SELECT * FROM nodes WHERE id = 'src'").get()).toEqual(before);
  });
  it('derives field edges on scalar/list transitions and global rename/deletion', () => {
    node('p1'); source();
    updateGlobalField(db, 'project', { field_type: 'list', list_item_type: 'reference', confirm: true });
    expect(target()).toBe('p1');
    renameGlobalField(db, 'project', 'projects'); expect(target()).toBeUndefined(); expect(target('projects')).toBe('p1');
    deleteGlobalField(db, 'projects'); expect(target('projects')).toBe('p1');
    expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = 'src' AND field_name = 'projects'").get()).toEqual({ value_json: '["Same"]' });
  });
  it('preserves typed global semantics when a schema unclaims a field or is deleted', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
    node('p1'); node('src', 'Source', ['task'], { project: 'Same' });
    updateSchemaDefinition(db, 'task', { field_claims: [] }); expect(target()).toBe('p1');
    deleteSchemaDefinition(db, 'task'); expect(target()).toBe('p1');
    createSchemaDefinition(db, { name: 'project', field_claims: [] });
    deleteSchemaDefinition(db, 'project'); expect(target()).toBe('p1'); // schema deletion retains memberships
  });
  it('undoes target deletion with current candidate cardinality', () => {
    node('p1'); source();
    const operation = createOperation(db, { source_tool: 'test', description: 'delete target' });
    executeDeletion(db, lock, vault, { source: 'tool', node_id: 'p1', file_path: 'p1.md', unlink_file: false }, { operation_id: operation });
    finalizeOperation(db, operation); expect(target()).toBeNull();
    restoreOperation(db, lock, vault, operation, new Set()); expect(target()).toBe('p1');
  });
  it('undoes duplicate creation and target type removal', () => {
    node('p1'); source();
    const created = createOperation(db, { source_tool: 'test', description: 'create duplicate' });
    // A tool-created node's title is its filename's, so the duplicate needs a file named Same.
    executeMutation(db, lock, vault, { source: 'tool', node_id: null, file_path: 'Archive/Same.md', title: 'Same', types: ['project'], fields: {}, body: '' }, undefined, { operation_id: created });
    finalizeOperation(db, created); expect(target()).toBeNull();
    restoreOperation(db, lock, vault, created, new Set()); expect(target()).toBe('p1');
    const changed = createOperation(db, { source_tool: 'test', description: 'remove type' });
    executeMutation(db, lock, vault, { source: 'watcher', node_id: 'p1', file_path: 'p1.md', title: 'Same', types: [], fields: {}, body: 'unchanged' }, undefined, { operation_id: changed });
    finalizeOperation(db, changed); expect(target()).toBeNull();
    restoreOperation(db, lock, vault, changed, new Set()); expect(target()).toBe('p1');
  });
  it('restores global field rename and deletion bindings in undo', () => {
    node('p1'); source();
    const renamed = createOperation(db, { source_tool: 'test', description: 'rename field' });
    captureGlobalFieldSnapshot(db, renamed, 'projects', { was_renamed_from: 'project' });
    renameGlobalField(db, 'project', 'projects'); expect(target('projects')).toBe('p1');
    restoreGlobalFieldSnapshot(db, renamed, 'projects'); expect(target()).toBe('p1'); expect(target('projects')).toBeUndefined();
    const deleted = createOperation(db, { source_tool: 'test', description: 'delete field' });
    captureGlobalFieldSnapshot(db, deleted, 'project', { was_deleted: true });
    deleteGlobalField(db, 'project'); expect(target()).toBe('p1');
    restoreGlobalFieldSnapshot(db, deleted, 'project'); expect(target()).toBe('p1');
  });
  it('honors newly defined reference semantics for preserved orphan values', () => {
    node('p1'); node('src', 'Source', [], { future: 'Same' });
    expect(target('future')).toBeUndefined();
    createGlobalField(db, { name: 'future', field_type: 'reference', reference_target: 'project' });
    expect(target('future')).toBe('p1');
  });
  it('recomputes list item and scalar field kind transitions without reinterpreting bare strings as orphan links', () => {
    node('p1'); node('src', 'Source', [], { project: ['Same'] });
    updateGlobalField(db, 'project', { field_type: 'list', list_item_type: 'reference', confirm: true });
    node('src', 'Source', [], { project: ['Same'] }); expect(target()).toBe('p1');
    updateGlobalField(db, 'project', { list_item_type: 'string' }); expect(target()).toBeUndefined();
    updateGlobalField(db, 'project', { list_item_type: 'reference' }); expect(target()).toBe('p1');
    updateGlobalField(db, 'project', { field_type: 'reference', confirm: true, discard_uncoercible: true }); expect(target()).toBeUndefined();
    node('src', 'Source', [], { project: 'Same' }); expect(target()).toBe('p1');
    updateGlobalField(db, 'project', { field_type: 'string', confirm: true }); expect(target()).toBeUndefined();
  });

  it('commits final ambiguity through batch-mutate and rolls the complete preview back', async () => {
    createSchemaDefinition(db, { name: 'project', field_claims: [] });
    // Named Same on disk too: a tool write would otherwise canonicalize the
    // batch's `Same` reference to the only note it could mean (p1's file).
    executeMutation(db, lock, vault, { source: 'watcher', node_id: 'p1', file_path: 'Projects/Same.md', title: 'Same', types: ['project'], fields: {}, body: 'unchanged' });
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    registerBatchMutate({ tool: (_name: string, _description: string, _schema: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) => { handler = callback; } } as unknown as McpServer, db, lock, vault);
    const operations = [
      { op: 'create', params: { title: 'Earlier source', fields: { project: 'Same' } } },
      { op: 'create', params: { title: 'Same', types: ['project'] } },
    ];
    const beforeNodes = db.prepare('SELECT * FROM nodes').all();
    const beforeRelationships = db.prepare('SELECT * FROM relationships').all();
    const beforeUndo = db.prepare('SELECT * FROM undo_operations').all();
    function envelope(result: unknown): { ok: boolean } {
      return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    }
    expect(envelope(await handler({ operations, dry_run: true })).ok).toBe(true);
    expect(db.prepare('SELECT * FROM nodes').all()).toEqual(beforeNodes);
    expect(db.prepare('SELECT * FROM relationships').all()).toEqual(beforeRelationships);
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual(beforeUndo);
    expect(envelope(await handler({ operations, dry_run: false })).ok).toBe(true);
    expect(db.prepare("SELECT r.resolved_target_id FROM relationships r JOIN nodes n ON n.id = r.source_id WHERE n.title = 'Earlier source' AND r.rel_type = 'project'").get()).toEqual({ resolved_target_id: null });
  });

});
