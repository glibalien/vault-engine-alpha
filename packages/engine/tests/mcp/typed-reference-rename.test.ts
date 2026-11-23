import { rerenderNodesWithField } from '../../src/schema/propagate.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildNodeQuery } from '../../src/mcp/query-builder.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { restoreOperation } from '../../src/undo/restore.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField, updateGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let lock: WriteLockManager;
beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  lock = new WriteLockManager();
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'note', field_type: 'reference', reference_target: 'note' });
  createGlobalField(db, { name: 'label', field_type: 'string' });
  createSchemaDefinition(db, { name: 'project', field_claims: [] });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: ['project', 'projects', 'note', 'label'].map(field => ({ field })) });
});
afterEach(() => { db.close(); cleanup(); });
function node(file_path: string, title: string, types: string[], fields: Record<string, unknown> = {}, body = '', node_id: string | null = null) {
  return executeMutation(db, lock, vaultPath, { source: 'tool', node_id, file_path, title, types, fields, body }).node_id;
}
function rename(id: string, title: string, file_path: string) {
  const before = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(id) as { file_path: string; title: string };
  return db.transaction(() => executeRename(db, lock, vaultPath, { node_id: id, ...before }, title, file_path))();
}
function field(id: string, name: string) {
  const row = db.prepare('SELECT value_text, value_json FROM node_fields WHERE node_id = ? AND field_name = ?').get(id, name) as { value_text: string; value_json: string | null };
  return row.value_json ? JSON.parse(row.value_json) : row.value_text;
}
function target(id: string, name: string) {
  return db.prepare('SELECT target, resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = ?').all(id, name);
}

describe('typed reference rename and move', () => {
  it('preserves exact .md paths on a move even with a unique title', () => {
    const p = node('Projects/Old.md', 'Old', ['project']);
    const s = node('Task.md', 'Task', ['task'], { project: 'Projects/Old.md' });
    rename(p, 'Old', 'Archive/Old.md');
    expect(field(s, 'project')).toBe('Archive/Old.md');
    expect(target(s, 'project')).toEqual([{ target: 'Archive/Old.md', resolved_target_id: p }]);
  });
  it('retains title spelling when the new title uniquely identifies the project', () => {
    const p = node('Projects/Old.md', 'Old', ['project']);
    const s = node('Task.md', 'Task', ['task'], { project: 'Old' });
    rename(p, 'New', 'Projects/New.md');
    expect(field(s, 'project')).toBe('New');
    expect(target(s, 'project')).toEqual([{ target: 'New', resolved_target_id: p }]);
  });
  it('uses the exact path when the new title collides and preserves list order and duplicates', () => {
    const p = node('Projects/Old.md', 'Old', ['project']);
    node('Elsewhere/New.md', 'New', ['project']);
    const s = node('Task.md', 'Task', ['task'], { project: 'Old', projects: ['Old', 'Elsewhere/New.md', 'Old'] });
    rename(p, 'New', 'Projects/New.md');
    expect(field(s, 'project')).toBe('Projects/New.md');
    expect(field(s, 'projects')).toEqual(['Projects/New.md', 'Elsewhere/New.md', 'Projects/New.md']);
    expect(target(s, 'project')).toEqual([{ target: 'Projects/New.md', resolved_target_id: p }]);
  });
  it('rewrites only the stored field tuple and leaves unrelated same-text body and fields intact', () => {
    const n = node('Old.md', 'Old', ['note']);
    const p = node('Projects/Old.md', 'Old', ['project']);
    const s = node('Task.md', 'Task', ['task'], { project: 'Old', note: 'Old', label: 'Old' }, 'See [[Old]].');
    expect(target(s, 'note')[0]).toMatchObject({ resolved_target_id: n });
    rename(p, 'New', 'Projects/New.md');
    expect(field(s, 'project')).toBe('New');
    expect(field(s, 'note')).toBe('Old');
    expect(field(s, 'label')).toBe('Old');
    expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(s)).toEqual({ body: 'See [[Old]].' });
    expect(target(s, 'note')[0]).toMatchObject({ resolved_target_id: n });
  });
  it('refreshes previously ambiguous references using the pre-rename identity', () => {
    const p = node('Projects/Old.md', 'Old', ['project']);
    const other = node('Elsewhere/Old.md', 'Old', ['project']);
    const s = node('Task.md', 'Task', ['task'], { project: 'Old' });
    expect(target(s, 'project')[0]).toMatchObject({ resolved_target_id: null });
    rename(p, 'New', 'Projects/New.md');
    expect(field(s, 'project')).toBe('Old');
    expect(target(s, 'project')[0]).toMatchObject({ resolved_target_id: other });
  });
  it('rewrites a self-reference without restoring the old node identity', () => {
    const p = node('Projects/Old.md', 'Old', ['project', 'task'], { project: 'Projects/Old.md' });
    rename(p, 'New', 'Projects/New.md');
    expect(field(p, 'project')).toBe('Projects/New.md');
    expect(db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(p)).toEqual({ file_path: 'Projects/New.md', title: 'New' });
  });
  it('under policy 1, rewrites a value naming the note by title or by path (#590)', () => {
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'reference_resolution_policy_version'").run();
    const p = node('Projects/Old.md', 'Old', ['project']);
    const s = node('Task.md', 'Task', ['task'], { project: 'Projects/Old.md', label: 'Old' });
    rename(p, 'New', 'Projects/New.md');
    // Before #590, policy 1 left a path value naming the old file.
    expect(field(s, 'project')).toBe('Projects/New.md');
    expect(field(s, 'label')).toBe('New');
  });
});

async function tool(kind: 'update' | 'batch', args: Record<string, unknown>) {
  let handler!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = { tool: (_name: string, _description: string, _schema: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  if (kind === 'update') registerUpdateNode(server, db, lock, vaultPath);
  else registerBatchMutate(server, db, lock, vaultPath);
  const raw = await handler(args) as { content: Array<{ text: string }> };
  return JSON.parse(raw.content[0].text);
}

it.each(['single', 'query'] as const)('preserves typed identity in directory-only update-node %s preview/apply and undo', async mode => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  const s = node('Task.md', 'Task', ['task'], { project: 'Projects/Old.md' });
  const params = { ...(mode === 'single' ? { node_id: p } : { query: { node_ids: [p] } }), set_directory: 'Archive' };
  const before = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
  expect((await tool('update', { ...params, dry_run: true })).ok).toBe(true);
  expect(field(s, 'project')).toBe('Projects/Old.md');
  expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(before);
  expect(existsSync(join(vaultPath, 'Archive/Old.md'))).toBe(false);
  expect((await tool('update', { ...params, dry_run: false })).ok).toBe(true);
  expect(field(s, 'project')).toBe('Archive/Old.md');
  expect(target(s, 'project')).toEqual([{ target: 'Archive/Old.md', resolved_target_id: p }]);
  const op = db.prepare('SELECT operation_id FROM undo_operations').get() as { operation_id: string };
  restoreOperation(db, lock, vaultPath, op.operation_id, new Set([op.operation_id]));
  expect(field(s, 'project')).toBe('Projects/Old.md');
  expect(target(s, 'project')).toEqual([{ target: 'Projects/Old.md', resolved_target_id: p }]);
  expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(before);
});

it.each(['single', 'query'] as const)('rejects a directory-only %s preview when an exact-path referring file is missing', async mode => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  node('Task.md', 'Task', ['task'], { project: 'Projects/Old.md' });
  unlinkSync(join(vaultPath, 'Task.md'));
  const result = await tool('update', { ...(mode === 'single' ? { node_id: p } : { query: { node_ids: [p] } }), set_directory: 'Archive', dry_run: true });
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe('CONTENT_HASH_MISMATCH');
  expect(existsSync(join(vaultPath, 'Projects/Old.md'))).toBe(true);
});

it('previews a typed self-reference at its existing projection path', async () => {
  const p = node('Projects/Old.md', 'Old', ['project', 'task'], { project: 'Projects/Old.md' });
  const result = await tool('update', { node_id: p, set_title: 'New', dry_run: true });
  expect(result.ok).toBe(true);
  expect(field(p, 'project')).toBe('Projects/Old.md');
});
it('keeps typed batch references on the filename when a retitle sanitizes to the same filename', async () => {
  const p = node('Projects/A-B.md', 'A:B', ['project']);
  // Written as the requested title, stored as the note's filename-derived one.
  const s = node('Task.md', 'Task', ['task'], { project: 'A:B' });
  expect(field(s, 'project')).toBe('A-B');
  const result = await tool('batch', { operations: [{ op: 'update', params: { node_id: p, set_title: 'A?B' } }] });
  expect(result.ok).toBe(true);
  expect(field(s, 'project')).toBe('A-B');
  expect(target(s, 'project')[0]).toMatchObject({ resolved_target_id: p });
});

it.each(['rename', 'move', 'query', 'batch'] as const)('matches preview/apply diagnostics after %s rewrites an exact self-reference', async mode => {
  const p = node('Projects/Old.md', 'Old', ['project', 'task'], { project: 'Projects/Old.md' });
  node('Other.md', 'Projects/Old.md', ['note']);
  const changes = mode === 'move' || mode === 'query' ? { set_directory: 'Archive' } : { set_title: 'New' };
  const args = mode === 'batch'
    ? { operations: [{ op: 'update', params: { node_id: p, ...changes } }] }
    : { ...(mode === 'query' ? { query: { node_ids: [p] } } : { node_id: p }), ...changes };
  const preview = await tool(mode === 'batch' ? 'batch' : 'update', { ...args, dry_run: true });
  const applied = await tool(mode === 'batch' ? 'batch' : 'update', { ...args, dry_run: false });
  expect(preview.ok).toBe(true);
  expect(applied.ok).toBe(true);
  const references = (result: { warnings: Array<{ code: string }> }) => result.warnings.filter(warning => warning.code.startsWith('REFERENCE_'));
  expect(references(preview)).toEqual(references(applied));
  expect(references(applied)).toEqual([]);
});

it('keeps body rewrites made by an earlier target before moving its referring source', async () => {
  const p = node('Projects/Old.md', 'Old', ['project'], {}, '', '000-target');
  const s = node('Task.md', 'Task', ['task'], { project: 'Projects/Old.md' }, 'See [[Projects/Old.md]].', '999-source');
  const query = { node_ids: [p, s] };
  const selection = buildNodeQuery(query, db);
  expect((db.prepare(selection.sql).all(...selection.params) as Array<{ id: string }>).map(row => row.id)).toEqual([p, s]);
  const result = await tool('update', { query, set_directory: 'Archive', dry_run: false });
  expect(result.ok).toBe(true);
  expect(result.data.errors).toEqual([]);
  expect(field(s, 'project')).toBe('Archive/Old.md');
  // A body link written as the path keeps its folder (#590).
  expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(s)).toEqual({ body: 'See [[Archive/Old.md]].' });
  expect(readFileSync(join(vaultPath, 'Archive/Task.md'), 'utf8')).toContain('See [[Archive/Old.md]].');
  expect(target(s, 'wiki-link')).toEqual([{ target: 'Archive/Old.md', resolved_target_id: p }]);
});
it('retains the existing directory-only move rejection for path separators in titles', async () => {
  // Only a legacy stored title can still hold a separator; tool writes store the filename's.
  const p = executeMutation(db, lock, vaultPath, { source: 'watcher', node_id: null, file_path: 'Projects/A-B.md', title: 'A/B', types: ['project'], fields: {}, body: '' }).node_id;
  const result = await tool('update', { node_id: p, set_directory: 'Archive' });
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe('INVALID_PARAMS');
});


it('keeps indexed unclaimed scalar and list raw values consistent through rename, reindex and undo', async () => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  const other = node('Projects/Other.md', 'Other', ['project']);
  const path = join(vaultPath, 'Unclaimed.md');
  writeFileSync(path, '---\nproject: "[[Projects/Old.md]]"\nprojects: ["[[Projects/Old.md]]", "Projects/Other.md", "[[Projects/Old.md]]"]\nlabel: "[[Projects/Old.md]]"\nempty: []\nnullable:\n---\n');
  const s = indexFile(path, vaultPath, db)!;
  const raw = () => db.prepare('SELECT field_name, value_raw_text FROM node_fields WHERE node_id = ? ORDER BY field_name').all(s);
  const beforeRaw = raw();
  const yaml = () => parse(readFileSync(path, 'utf8').split('---')[1]);
  expect((await tool('update', { node_id: p, set_title: 'New', set_directory: 'Projects' })).ok).toBe(true);
  expect(field(s, 'project')).toBe('Projects/New.md');
  expect(field(s, 'projects')).toEqual(['Projects/New.md', 'Projects/Other.md', 'Projects/New.md']);
  // A path link in a field that isn't a typed reference follows the note too (#590).
  expect(yaml()).toMatchObject({ project: '[[Projects/New.md]]', projects: ['[[Projects/New.md]]', 'Projects/Other.md', '[[Projects/New.md]]'], label: '[[Projects/New.md]]', empty: [], nullable: null });
  expect(raw()).toEqual(expect.arrayContaining([{ field_name: 'project', value_raw_text: '[[Projects/New.md]]' }, { field_name: 'projects', value_raw_text: '["[[Projects/New.md]]","Projects/Other.md","[[Projects/New.md]]"]' }]));
  indexFile(path, vaultPath, db);
  expect(target(s, 'project')).toEqual([{ target: 'Projects/New.md', resolved_target_id: p }]);
  expect(target(s, 'projects')).toEqual([{ target: 'Projects/New.md', resolved_target_id: p }, { target: 'Projects/Other.md', resolved_target_id: other }]);
  const op = db.prepare('SELECT operation_id FROM undo_operations').get() as { operation_id: string };
  restoreOperation(db, lock, vaultPath, op.operation_id, new Set([op.operation_id]));
  expect(raw()).toEqual(beforeRaw);
  expect(yaml()).toMatchObject({ project: '[[Projects/Old.md]]', projects: ['[[Projects/Old.md]]', 'Projects/Other.md', '[[Projects/Old.md]]'], label: '[[Projects/Old.md]]' });
  indexFile(path, vaultPath, db);
  expect(target(s, 'project')).toEqual([{ target: 'Projects/Old.md', resolved_target_id: p }]);
});

it.each(['rename-first', 'introduce-later', 'remove-later'] as const)('reports final composed batch reference state: %s', async scenario => {
  const p = node('Projects/Example.md', 'Example', ['project']);
  const other = node(`Archive/${scenario === 'remove-later' ? 'Example' : 'Other'}.md`, scenario === 'remove-later' ? 'Example' : 'Other', ['project']);
  const create = { op: 'create', params: { title: 'Source', types: ['task'], fields: { project: 'Example' } } };
  const rename = { op: 'update', params: { node_id: other, set_title: scenario === 'remove-later' ? 'Other' : 'Example' } };
  const operations = scenario === 'rename-first' ? [rename, create] : [create, scenario === 'introduce-later' ? { op: 'create', params: { title: 'Example', directory: 'Duplicate', types: ['project'] } } : rename];
  const before = db.prepare('SELECT * FROM nodes ORDER BY id').all();
  const preview = await tool('batch', { operations, dry_run: true });
  expect(preview.ok).toBe(true);
  expect(db.prepare('SELECT * FROM nodes ORDER BY id').all()).toEqual(before);
  expect(existsSync(join(vaultPath, 'Source.md'))).toBe(false);
  if (scenario === 'rename-first') expect(preview.data.would_apply[0].file_path).toBe('Archive/Example.md');
  const applied = await tool('batch', { operations, dry_run: false });
  expect(applied.ok).toBe(true);
  const warnings = (env: typeof applied) => env.warnings.filter((w: { code: string }) => w.code.startsWith('REFERENCE_')).map((w: { code: string; op_index: number }) => ({ code: w.code, op_index: w.op_index }));
  const expected = scenario === 'remove-later' ? [] : [{ code: 'REFERENCE_AMBIGUOUS', op_index: scenario === 'rename-first' ? 1 : 0 }];
  expect(warnings(preview)).toEqual(expected);
  expect(warnings(applied)).toEqual(expected);
  const source = applied.data.results.find((r: { op: string }) => r.op === 'create').node_id;
  expect(target(source, 'project')).toEqual([{ target: 'Example', resolved_target_id: scenario === 'remove-later' ? p : null }]);
});


it('restores absent raw text from the snapshot after reindex added it', async () => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  const s = node('Unclaimed.md', 'Unclaimed', [], { project: 'Projects/Old.md', projects: ['Projects/Old.md', 'Projects/Old.md'] });
  expect((await tool('update', { node_id: p, set_title: 'New', set_directory: 'Projects' })).ok).toBe(true);
  const path = join(vaultPath, 'Unclaimed.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n');
  indexFile(path, vaultPath, db);
  const op = db.prepare('SELECT operation_id FROM undo_operations').get() as { operation_id: string };
  restoreOperation(db, lock, vaultPath, op.operation_id, new Set([op.operation_id]), { resolve_conflicts: [{ node_id: s, action: 'revert' }] });
  expect(db.prepare("SELECT field_name, value_raw_text FROM node_fields WHERE node_id = ? AND field_name IN ('project', 'projects') ORDER BY field_name").all(s)).toEqual([
    { field_name: 'project', value_raw_text: null }, { field_name: 'projects', value_raw_text: null },
  ]);
  expect(field(s, 'projects')).toEqual(['Projects/Old.md', 'Projects/Old.md']);
  indexFile(join(vaultPath, 'Unclaimed.md'), vaultPath, db);
  expect(target(s, 'project')).toEqual([{ target: 'Projects/Old.md', resolved_target_id: p }]);
});


it('composes governed reference rewrites and repeated renames without preview files or undo records', async () => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  const s = node('Task.md', 'Task', ['task'], { project: 'Projects/Old.md' });
  node('Wrong.md', 'Projects/Old.md', ['note']);
  const snapshot = db.serialize();
  const targetBefore = readFileSync(join(vaultPath, 'Projects/Old.md'), 'utf8');
  const sourceBefore = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
  const operations = [
    { op: 'update', params: { node_id: p, set_title: 'Middle' } },
    { op: 'update', params: { file_path: 'Projects/Middle.md', set_title: 'New' } },
    { op: 'update', params: { node_id: s, append_body: 'Keep the rewritten reference.' } },
  ];
  const preview = await tool('batch', { operations, dry_run: true });
  expect(preview.ok).toBe(true);
  expect(preview.data.would_apply).toHaveLength(3);
  expect(preview.data.would_apply[1].file_path).toBe('Projects/New.md');
  expect(preview.warnings).toEqual([]);
  expect(db.serialize()).toEqual(snapshot);
  expect(readFileSync(join(vaultPath, 'Projects/Old.md'), 'utf8')).toBe(targetBefore);
  expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(sourceBefore);
  expect(existsSync(join(vaultPath, 'Projects/New.md'))).toBe(false);
  expect(existsSync(join(vaultPath, 'Projects/Middle.md'))).toBe(false);
  const applied = await tool('batch', { operations, dry_run: false });
  expect(applied.ok).toBe(true);
  expect(applied.warnings).toEqual([]);
  expect(target(s, 'project')).toEqual([{ target: 'Projects/New.md', resolved_target_id: p }]);
});

it('attributes a source once to its last successful direct batch operation', async () => {
  node('Projects/Example.md', 'Example', ['project']);
  node('Archive/Example.md', 'Example', ['project']);
  const s = node('Source.md', 'Source', ['task'], { project: 'Example' });
  for (const dry_run of [true, false]) {
    const result = await tool('batch', { dry_run, operations: [
      { op: 'update', params: { node_id: s, set_body: 'First' } },
      { op: 'update', params: { node_id: s, set_body: 'Final' } },
    ] });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'REFERENCE_AMBIGUOUS', op_index: 1 });
  }
});

it('rolls back raw reference rewrites when a later batch operation fails', async () => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  const path = join(vaultPath, 'Unclaimed.md');
  writeFileSync(path, '---\nproject: "[[Projects/Old.md]]"\n---\n');
  const s = indexFile(path, vaultPath, db)!;
  const before = readFileSync(path, 'utf8');
  for (const dry_run of [true, false]) {
    const result = await tool('batch', { dry_run, operations: [
      { op: 'update', params: { node_id: p, set_title: 'New' } },
      { op: 'create', params: { title: 'Invalid', types: ['unknown'] } },
    ] });
    if (dry_run) expect(result.data.failed_at).toBe(1);
    else expect(result.ok).toBe(false);
    expect(field(s, 'project')).toBe('Projects/Old.md');
    expect(db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(s)).toEqual({ value_raw_text: '[[Projects/Old.md]]' });
    expect(target(s, 'project')).toEqual([{ target: 'Projects/Old.md', resolved_target_id: p }]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(vaultPath, 'Projects/Old.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Projects/New.md'))).toBe(false);
  }
});


it.each([false, true])('renames an unclaimed scalar coerced to a reference list with stale scalar raw text (expanded=%s)', async expanded => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  const other = node('Projects/Other.md', 'Other', ['project']);
  const path = join(vaultPath, 'Transition.md');
  writeFileSync(path, '---\nproject: "[[Projects/Old.md|Alias]]"\nlabel: "[[Untouched|Label]]"\n---\n');
  const s = indexFile(path, vaultPath, db);
  updateGlobalField(db, 'project', { field_type: 'list', list_item_type: 'reference', confirm: true });
  rerenderNodesWithField(db, lock, vaultPath, 'project');
  if (expanded) {
    node('Transition.md', 'Transition', [], {
      project: ['Projects/Old.md', 'Projects/Other.md', 'Projects/Old.md'], label: 'Untouched',
    }, 'Expanded references.', s);
    // The write keeps the written form of the item it kept and writes the new ones as links (#663).
    const rawNow = "SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'";
    expect(db.prepare(rawNow).get(s)).toEqual({ value_raw_text: JSON.stringify(['[[Projects/Old.md|Alias]]', '[[Projects/Other.md]]', '[[Projects/Old.md]]']) });
    // Before #663 it left the raw text it found, and a row written then still holds it: put
    // it back, to see a rename read such a row.
    db.prepare("UPDATE node_fields SET value_raw_text = ? WHERE node_id = ? AND field_name = 'project'").run('[[Projects/Old.md|Alias]]', s);
  }
  const beforeValues = expanded ? ['Projects/Old.md', 'Projects/Other.md', 'Projects/Old.md'] : ['Projects/Old.md'];
  expect(field(s, 'project')).toEqual(beforeValues);
  const rawBefore = db.prepare('SELECT field_name, value_raw_text FROM node_fields WHERE node_id = ? ORDER BY field_name').all(s);
  expect(rawBefore).toContainEqual({ field_name: 'project', value_raw_text: '[[Projects/Old.md|Alias]]' });
  const renamed = await tool('update', { node_id: p, set_title: 'New', set_directory: 'Projects' });
  expect(renamed.ok).toBe(true);
  const expectedRaw = expanded ? ['[[Projects/New.md|Alias]]', '[[Projects/Other.md]]', '[[Projects/New.md]]'] : ['[[Projects/New.md|Alias]]'];
  const yaml = parse(readFileSync(path, 'utf8').split('---')[1]);
  expect(yaml.project).toEqual(expectedRaw);
  expect(yaml.label).toBe('[[Untouched|Label]]');
  expect(db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(s)).toEqual({ value_raw_text: JSON.stringify(expectedRaw) });
  indexFile(path, vaultPath, db);
  expect(field(s, 'project')).toEqual(expanded ? ['Projects/New.md', 'Projects/Other.md', 'Projects/New.md'] : ['Projects/New.md']);
  expect(target(s, 'project')).toEqual(expanded ? [
    { target: 'Projects/New.md', resolved_target_id: p }, { target: 'Projects/Other.md', resolved_target_id: other },
  ] : [{ target: 'Projects/New.md', resolved_target_id: p }]);
  const op = db.prepare('SELECT operation_id FROM undo_operations').get() as { operation_id: string };
  const undone = restoreOperation(db, lock, vaultPath, op.operation_id, new Set([op.operation_id]));
  expect(undone.total_conflicts).toBe(0);
  expect(field(s, 'project')).toEqual(beforeValues);
  expect(db.prepare('SELECT field_name, value_raw_text FROM node_fields WHERE node_id = ? ORDER BY field_name').all(s)).toEqual(rawBefore);
  expect(parse(readFileSync(path, 'utf8').split('---')[1]).project).toBe('[[Projects/Old.md|Alias]]');
  expect(target(s, 'project')[0]).toEqual({ target: 'Projects/Old.md', resolved_target_id: p });
});


it.each(['single', 'multiple', 'unmatched'] as const)('normalizes stale raw list text after an unclaimed field becomes scalar (%s)', async shape => {
  const p = node('Projects/Old.md', 'Old', ['project']);
  node('Projects/Other.md', 'Other', ['project']);
  const path = join(vaultPath, 'Scalar.md');
  const rawItems = shape === 'multiple' ? ['[[Projects/Old.md|Alias]]', '[[Projects/Other.md]]']
    : shape === 'unmatched' ? ['[[Projects/Other.md]]'] : ['[[Projects/Old.md|Alias]]'];
  writeFileSync(path, `---\nproject: ${JSON.stringify(rawItems)}\nlabel: "[[Untouched|Label]]"\n---\n`);
  const s = indexFile(path, vaultPath, db);
  node('Scalar.md', 'Scalar', [], { project: 'Projects/Old.md', label: 'Untouched' }, 'Scalar edit.', s);
  expect(field(s, 'project')).toBe('Projects/Old.md');
  // The write keeps the written form of the item it kept, and no raw text where it kept none (#663).
  expect(db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(s))
    .toEqual({ value_raw_text: shape === 'unmatched' ? null : '[[Projects/Old.md|Alias]]' });
  // Before #663 it left the raw list it found, and a row written then still holds it: put it
  // back, to see a rename read such a row.
  db.prepare("UPDATE node_fields SET value_raw_text = ? WHERE node_id = ? AND field_name = 'project'").run(JSON.stringify(rawItems), s);
  expect(db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(s)).toEqual({ value_raw_text: JSON.stringify(rawItems) });
  expect((await tool('update', { node_id: p, set_title: 'New', set_directory: 'Projects' })).ok).toBe(true);
  const expectedRaw = shape === 'unmatched' ? '[[Projects/New.md]]' : '[[Projects/New.md|Alias]]';
  expect(parse(readFileSync(path, 'utf8').split('---')[1])).toMatchObject({ project: expectedRaw, label: '[[Untouched|Label]]' });
  indexFile(path, vaultPath, db);
  expect(field(s, 'project')).toBe('Projects/New.md');
  expect(target(s, 'project')).toEqual([{ target: 'Projects/New.md', resolved_target_id: p }]);
  const op = db.prepare('SELECT operation_id FROM undo_operations').get() as { operation_id: string };
  expect(restoreOperation(db, lock, vaultPath, op.operation_id, new Set([op.operation_id])).total_conflicts).toBe(0);
  expect(field(s, 'project')).toBe('Projects/Old.md');
  expect(parse(readFileSync(path, 'utf8').split('---')[1]).project).toEqual(rawItems);
  expect(target(s, 'project')).toEqual([{ target: 'Projects/Old.md', resolved_target_id: p }]);
});
