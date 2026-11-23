import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';
import { createGlobalField, deleteGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { splitFrontmatter } from '../../src/parser/frontmatter.js';
import { parse as parseYaml } from 'yaml';
import { createOperation } from '../../src/undo/operation.js';
import { captureGlobalFieldSnapshot, restoreGlobalFieldSnapshot } from '../../src/undo/global-field-snapshot.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
const lock = new WriteLockManager();

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, '2');
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'unclaimed', field_type: 'reference', reference_target: 'project' });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }, { field: 'projects' }] });
});
afterEach(() => { db.close(); cleanup(); });

function target(path: string, types: string[]) {
  return executeMutation(db, lock, vaultPath, {
    source: 'tool', node_id: null, file_path: path, title: path.slice(0, -3), types, fields: {}, body: '',
  }).node_id;
}

function relationships(nodeId: string) {
  return db.prepare('SELECT target, rel_type, context, resolved_target_id FROM relationships WHERE source_id = ? ORDER BY rel_type, target')
    .all(nodeId) as Array<{ target: string; rel_type: string; context: string; resolved_target_id: string | null }>;
}

describe('typed pipeline references', () => {
  it('filters scalar and list fields, preserves raw values and unresolved bindings', () => {
    const projectId = target('Projects/P1.md', ['project']);
    const wikiId = target('Wiki/P1.md', ['wiki']);
    const result = executeMutation(db, lock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Task.md', title: 'Task', types: ['task'],
      fields: { project: 'P1', projects: ['P1', 'Missing'], unclaimed: 'P1' },
      body: 'project [[P1]]',
    });
    const rels = relationships(result.node_id);
    expect(rels.find(r => r.rel_type === 'project')?.resolved_target_id).toBe(projectId);
    expect(rels.find(r => r.rel_type === 'projects' && r.target === 'P1')?.resolved_target_id).toBe(projectId);
    expect(rels.find(r => r.rel_type === 'projects' && r.target === 'Missing')?.resolved_target_id).toBeNull();
    expect(rels.find(r => r.rel_type === 'unclaimed')?.resolved_target_id).toBe(projectId);
    expect(rels.find(r => r.rel_type === 'wiki-link')).toMatchObject({ target: 'P1', resolved_target_id: wikiId });
    expect(result.referenceDiagnostics.some(d => d.request.rawTarget === 'Missing' && d.resolution.status === 'unresolved')).toBe(true);
    const rendered = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
    const frontmatter = parseYaml(splitFrontmatter(rendered).yaml ?? '') as Record<string, unknown>;
    expect(frontmatter.project).toBe('[[P1]]');
    expect(frontmatter.unclaimed).toBe('[[P1]]');
    expect(frontmatter.projects).toEqual(['[[P1]]', '[[Missing]]']);
    expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'projects'").get(result.node_id))
      .toEqual({ value_json: JSON.stringify(['P1', 'Missing']) });
  });

  it('keeps a wrong-type explicit path unresolved and ignores null and empty lists', () => {
    target('Wiki/Only.md', ['wiki']);
    const result = executeMutation(db, lock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Task.md', title: 'Task', types: ['task'],
      fields: { project: 'Wiki/Only.md', projects: [] }, body: '',
    });
    expect(relationships(result.node_id)).toEqual([{ target: 'Wiki/Only.md', rel_type: 'project', context: 'project', resolved_target_id: null }]);
    expect(result.referenceDiagnostics[0]?.resolution).toMatchObject({ status: 'unresolved', reason: 'type_mismatch' });
  });

  it('gives tool and watcher db_only writes the same typed binding', () => {
    const projectId = target('Projects/P1.md', ['project']);
    target('Wiki/P1.md', ['wiki']);
    const base = { node_id: null, title: 'Task', types: ['task'], fields: { project: 'P1' }, body: '' };
    const tool = executeMutation(db, lock, vaultPath, { ...base, source: 'tool', file_path: 'Tool.md' });
    const watcher = executeMutation(db, lock, vaultPath, { ...base, source: 'watcher', file_path: 'Watcher.md', db_only: true });
    expect(relationships(tool.node_id)[0]?.resolved_target_id).toBe(projectId);
    expect(relationships(watcher.node_id)[0]?.resolved_target_id).toBe(projectId);
    expect(watcher.file_written).toBe(false);
  });

  it('keeps same-tier typed ambiguity unresolved', () => {
    const first = target('Projects/P1.md', ['project']);
    db.prepare("UPDATE nodes SET title = 'P1' WHERE id = ?").run(first);
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('second-project', 'Other/P1.md', 'P1')").run();
    db.prepare("INSERT INTO node_types (node_id, schema_type, sort_order) VALUES ('second-project', 'project', 0)").run();
    const result = executeMutation(db, lock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Task.md', title: 'Task', types: ['task'], fields: { project: 'P1' }, body: '',
    });
    expect(relationships(result.node_id)[0]?.resolved_target_id).toBeNull();
    expect(result.referenceDiagnostics[0]?.resolution).toMatchObject({ status: 'unresolved', reason: 'ambiguous', candidateCount: 2 });
  });
});


it('renders unclaimed reference lists with their original order and duplicates', () => {
  createGlobalField(db, { name: 'unclaimed_list', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
  const result = executeMutation(db, lock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'Orphan.md', title: 'Orphan', types: [],
    fields: { unclaimed_list: ['P1', 'Missing', 'P1'], ordinary: 'P1' }, body: '',
  });
  const fm = parseYaml(splitFrontmatter(readFileSync(join(vaultPath, result.file_path), 'utf8')).yaml ?? '');
  expect(fm.unclaimed_list).toEqual(['[[P1]]', '[[Missing]]', '[[P1]]']);
  expect(fm.ordinary).toBe('P1');
});

it.each(['project', 'projects'])('preserves %s links through definition deletion, rerender and undo', (field) => {
  const projectId = target('Projects/P1.md', ['project']);
  // Orphan links revert to unconstrained resolution, rather than retaining the old typed binding.
  const wikiId = target('Wiki/P1.md', ['wiki']);
  const fields = { [field]: field === 'project' ? 'P1' : ['P1', 'Missing', 'P1'] };
  const input = { source: 'tool' as const, node_id: null, file_path: 'Task.md', title: 'Task', types: ['task'], fields, body: 'Body' };
  const result = executeMutation(db, lock, vaultPath, input);
  const before = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
  const fieldRows = db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(result.node_id);
  expect(relationships(result.node_id).find(r => r.target === 'P1')?.resolved_target_id).toBe(projectId);
  const operation = createOperation(db, { source_tool: 'test', description: 'delete reference definition' });
  captureGlobalFieldSnapshot(db, operation, field, { was_deleted: true });
  deleteGlobalField(db, field);
  expect(relationships(result.node_id).find(r => r.target === 'P1')?.resolved_target_id).toBe(wikiId);
  expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(before);
  const rerender = executeMutation(db, lock, vaultPath, { ...input, node_id: result.node_id });
  expect(rerender.file_written).toBe(false);
  expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(before);
  expect(relationships(result.node_id).find(r => r.target === 'P1')?.resolved_target_id).toBe(wikiId);
  if (field === 'projects') expect(relationships(result.node_id).find(r => r.target === 'Missing')?.resolved_target_id).toBeNull();
  restoreGlobalFieldSnapshot(db, operation, field);
  expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(result.node_id)).toEqual(fieldRows);
  expect(relationships(result.node_id).find(r => r.target === 'P1')?.resolved_target_id).toBe(projectId);
});


it('preserves existing orphan aliases and rolls field deletion back atomically', () => {
  target('Projects/P1.md', ['project']);
  const result = executeMutation(db, lock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'Aliases.md', title: 'Aliases', types: ['task'],
    fields: { project: 'P1', unclaimed: 'P1' }, raw_field_texts: { unclaimed: '[[P1|Label]]' }, body: '',
  });
  const before = db.serialize();
  expect(() => db.transaction(() => {
    deleteGlobalField(db, 'project');
    deleteGlobalField(db, 'unclaimed');
    expect(relationships(result.node_id)).toHaveLength(2);
    expect(db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(result.node_id))
      .toEqual({ value_raw_text: '[[P1]]' });
    throw new Error('rollback');
  })()).toThrow('rollback');
  expect(db.serialize()).toEqual(before);
  deleteGlobalField(db, 'unclaimed');
  expect(db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'unclaimed'").get(result.node_id))
    .toEqual({ value_raw_text: '[[P1|Label]]' });
  expect(readFileSync(join(vaultPath, 'Aliases.md'), 'utf8')).toContain('[[P1|Label]]');
});

it('keeps v1 unclaimed rendering and deletion storage unchanged', () => {
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', REFERENCE_POLICY_VERSION_KEY);
  const result = executeMutation(db, lock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'Legacy.md', title: 'Legacy', types: ['task'],
    fields: { project: 'P1', unclaimed: 'P1' }, body: '',
  });
  const fm = parseYaml(splitFrontmatter(readFileSync(join(vaultPath, 'Legacy.md'), 'utf8')).yaml ?? '');
  expect(fm.unclaimed).toBe('P1');
  const fields = db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(result.node_id);
  deleteGlobalField(db, 'project');
  expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(result.node_id)).toEqual(fields);
});
