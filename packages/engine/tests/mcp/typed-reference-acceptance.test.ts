import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { previewReferenceActivation, applyReferenceActivation } from '../../src/resolver/activation.js';
import { fullIndex, indexFile } from '../../src/indexer/indexer.js';

let db: Database.Database;
let vault: string;
let cleanup: () => void;
let server: McpServer;
let client: Client;
async function connect(lock = new WriteLockManager()) {
  server = new McpServer({ name: 'typed-acceptance', version: '1' });
  client = new Client({ name: 'typed-client', version: '1' });
  registerAllTools(server, db, { vaultPath: vault, writeLock: lock });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}
beforeEach(async () => {
  db = createTestDb();
  ({ vaultPath: vault, cleanup } = createTempVault());
  db.prepare("INSERT INTO meta VALUES ('reference_resolution_policy_version', '2')").run();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'person', field_type: 'reference', reference_target: 'person' });
  createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
  for (const name of ['project', 'wiki', 'person', 'task']) createSchemaDefinition(db, { name, field_claims: name === 'task' ? ['project', 'person', 'projects'].map(field => ({ field })) : [] });
  db.prepare('UPDATE schemas SET metadata=? WHERE name=?').run(JSON.stringify({ relationship_views_v1: { version: 1, relations: [{ name: 'tasks', direction: 'incoming', field: 'project', filter: { types: ['task'] } }], rollups: [{ name: 'task_count', relation: 'tasks', metric: { op: 'count' } }] } }), 'project');
  await connect();
});
afterEach(async () => { await client.close(); await server.close(); db.close(); cleanup(); });
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}
async function create(title: string, type: string, directory: string, fields: Record<string, unknown> = {}, body = ''): Promise<string> {
  return (await call('create-node', { title, types: [type], directory, override_default_directory: true, fields, body })).data.node_id;
}
async function assertGraph(source: string, project: string, expected: string | null) {
  expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id=? AND rel_type='project'").get(source)).toEqual({ resolved_target_id: expected });
  const read = await call('get-node', { node_id: source, expand: { types: ['project'] } });
  expect(read.data.relationships.outgoing.project[0].target_id).toBe(expected);
  expect(Object.keys(read.data.expanded)).toEqual(expected ? [expected] : []);
  const incoming = await call('get-node', { node_id: project });
  expect((incoming.data.relationships.incoming.project ?? []).map((r: { source_id: string }) => r.source_id)).toEqual(expected === project ? [source] : []);
  const joined = await call('query-nodes', { types: ['task'], join_filters: [{ rel_type: 'project', target: { node_ids: [project] } }] });
  expect(joined.data.nodes.map((n: { id: string }) => n.id)).toEqual(expected === project ? [source] : []);
  const rollup = await call('read-rollups', { schema: 'project', rollups: ['task_count'] });
  expect(rollup.data.rows.find((r: { node: { id: string } }) => r.node.id === project).rollups.task_count).toBe(expected === project ? 1 : 0);
  const traversed = await call('traverse-nodes', { root_id: source, field: 'project', direction: 'outgoing', max_depth: 1 });
  expect(traversed.data.nodes.map((n: { id: string }) => n.id).sort()).toEqual([source, ...(expected ? [expected] : [])].sort());
}

it('keeps every graph read aligned through collision, disambiguation, move and undo over real MCP', async () => {
  const wiki = await create('Same', 'wiki', 'W');
  const project = await create('Same', 'project', 'Projects');
  const person = await create('Same', 'person', 'People');
  const source = await create('Task', 'task', 'Tasks', { project: 'Same', person: 'Same', projects: [], explicit: null, label: 'retained' }, 'See [[Same]].');
  // Tool null means unset. Index an explicit YAML null to pin preservation of
  // the distinct persisted-null representation through governed edits and undo.
  const sourcePath = join(vault, 'Tasks/Task.md');
  writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('---\n', '---\nexplicit: null\n'));
  indexFile(sourcePath, vault, db);
  expect(db.prepare("SELECT field_name FROM node_explicit_null_fields WHERE node_id=?").all(source)).toContainEqual({ field_name: 'explicit' });
  await assertGraph(source, project, project);
  const read = await call('get-node', { node_id: source });
  expect(read.data.relationships.outgoing.person[0].target_id).toBe(person);
  expect(read.data.relationships.outgoing['wiki-link'][0].target_id).toBe(wiki);
  const duplicate = await create('Same', 'project', 'Other');
  await assertGraph(source, project, null);
  expect((await call('get-node', { node_id: source })).warnings.some((w: { code: string }) => w.code === 'REFERENCE_AMBIGUOUS')).toBe(true);
  await call('update-node', { node_id: source, set_fields: { project: 'W/Same.md' } });
  await assertGraph(source, project, null);
  expect((await call('get-node', { node_id: source })).warnings.some((w: { code: string }) => w.code === 'REFERENCE_TARGET_TYPE_MISMATCH')).toBe(true);
  await call('update-node', { node_id: source, set_fields: { project: 'Projects/Same.md' } });
  await assertGraph(source, project, project);
  const before = readFileSync(join(vault, 'Tasks/Task.md'), 'utf8');
  await call('update-node', { node_id: project, set_title: 'Moved', set_directory: 'Archive' });
  await assertGraph(source, project, project);
  expect((await call('get-node', { node_id: source })).data.fields.project.value).toBe('Archive/Moved.md');
  const operation = db.prepare("SELECT operation_id FROM undo_operations WHERE source_tool='update-node' ORDER BY rowid DESC LIMIT 1").get() as { operation_id: string };
  expect((await call('undo-operations', { operation_ids: [operation.operation_id], dry_run: false })).data.total_undone).toBe(2);
  await assertGraph(source, project, project);
  expect(readFileSync(join(vault, 'Tasks/Task.md'), 'utf8')).toBe(before);
  expect((await call('get-node', { node_id: source })).data.fields).toMatchObject({ project: { value: 'Projects/Same.md' }, projects: { value: [] }, label: { value: 'retained' } });
  expect(db.prepare("SELECT field_name FROM node_explicit_null_fields WHERE node_id=?").all(source)).toContainEqual({ field_name: 'explicit' });
  expect(duplicate).not.toBe(project);
});

it('previews legacy wrong bindings without writes, rolls failed activation back, activates and reopens deterministically', async () => {
  db.prepare("UPDATE meta SET value='1' WHERE key='reference_resolution_policy_version'").run();
  const wiki = await create('Same', 'wiki', 'W');
  const project = await create('Same', 'project', 'Projects');
  const source = await create('Task', 'task', 'Tasks', { project: 'Same', projects: [], explicit: null });
  expect((await call('get-node', { node_id: source })).data.relationships.outgoing.project[0].target_id).toBe(wiki);
  const bytes = db.serialize();
  const markdown = readFileSync(join(vault, 'Tasks/Task.md'), 'utf8');
  const preview = previewReferenceActivation(db);
  expect(db.serialize()).toEqual(bytes);
  expect(preview.changes).toContainEqual(expect.objectContaining({ before_id: wiki, after_id: project }));
  db.exec("CREATE TRIGGER activation_failure BEFORE UPDATE ON meta WHEN NEW.key='reference_resolution_policy_version' BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END");
  expect(() => applyReferenceActivation(db, preview.fingerprint)).toThrow('injected activation failure');
  expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id=? AND rel_type='project'").get(source)).toEqual({ resolved_target_id: wiki });
  db.exec('DROP TRIGGER activation_failure');
  applyReferenceActivation(db, preview.fingerprint);
  await assertGraph(source, project, project);
  expect(readFileSync(join(vault, 'Tasks/Task.md'), 'utf8')).toBe(markdown);
  const file = join(vault, '.reopen.sqlite');
  writeFileSync(file, db.serialize());
  await client.close(); await server.close(); db.close();
  db = new Database(file); sqliteVec.load(db); db.pragma('foreign_keys=ON');
  await connect();
  fullIndex(vault, db); fullIndex(vault, db);
  await assertGraph(source, project, project);
});


it('rolls back database bindings and both rendered files after a real MCP reference rewrite fails after writing', async () => {
  const project = await create('Old', 'project', 'Projects');
  const source = await create('Task', 'task', 'Tasks', { project: 'Projects/Old.md' });
  const targetBytes = readFileSync(join(vault, 'Projects/Old.md'), 'utf8');
  const sourceBytes = readFileSync(join(vault, 'Tasks/Task.md'), 'utf8');
  const relationships = db.prepare('SELECT * FROM relationships').all();
  let failedAfterWrite = false;
  class FailReferenceWrite extends WriteLockManager {
    override withLockSync<T>(path: string, fn: () => T): T {
      const result = fn();
      if (path.endsWith('Tasks/Task.md') && !failedAfterWrite) {
        failedAfterWrite = true;
        throw new Error('injected failure after filesystem write');
      }
      return result;
    }
  }
  await client.close(); await server.close(); await connect(new FailReferenceWrite());
  const response = await client.callTool({ name: 'update-node', arguments: { node_id: project, set_title: 'New' } });
  const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
  expect(result.ok).toBe(false); expect(failedAfterWrite).toBe(true);
  expect(db.prepare('SELECT * FROM relationships').all()).toEqual(relationships);
  expect(readFileSync(join(vault, 'Projects/Old.md'), 'utf8')).toBe(targetBytes);
  expect(readFileSync(join(vault, 'Tasks/Task.md'), 'utf8')).toBe(sourceBytes);
  expect(existsSync(join(vault, 'Projects/New.md'))).toBe(false);
  await assertGraph(source, project, project);
});
