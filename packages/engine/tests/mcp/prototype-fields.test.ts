import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { runNormalizerSweep } from '../../src/sync/normalizer.js';

const fieldNames = ['__proto__', 'prototype', 'constructor', 'toString'];

describe('prototype-sensitive field names through MCP handlers', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let server: McpServer;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    ({ vaultPath, cleanup } = createTempVault());
    db = createTestDb();
    server = new McpServer({ name: 'prototype-fields-test', version: '0' });
    writeLock = new WriteLockManager();
    registerAllTools(server, db, {
      vaultPath,
      writeLock,
      syncLogger: new SyncLogger(db),
    });
  });

  afterEach(() => {
    writeLock.clearRecentWrites();
    db.close();
    cleanup();
  });

  async function call(name: string, args: Record<string, unknown>) {
    // Invoke the actual handlers; separate input-schema tests exercise Zod parsing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools[name];
    expect(tool, `registered tool ${name}`).toBeDefined();
    const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.ok, `${name}: ${JSON.stringify(envelope)}`).toBe(true);
    return envelope.data;
  }

  function readYaml(path: string) {
    return parse(readFileSync(join(vaultPath, path), 'utf8'));
  }

  function frontmatter(path: string): Record<string, unknown> {
    const markdown = readFileSync(join(vaultPath, path), 'utf8');
    expect(markdown).toMatch(/^---\n/);
    return parse(markdown.split('---')[1]);
  }

  function expectPersisted(node: { node_id: string; file_path: string }, field: string, value: string) {
    expect(db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, field)).toEqual({ value_text: value });
    const rendered = frontmatter(node.file_path);
    expect(Object.hasOwn(rendered, field)).toBe(true);
    expect(rendered[field]).toBe(value);
  }

  function expectAbsent(node: { node_id: string; file_path: string }, field: string) {
    expect(db.prepare('SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, field)).toBeUndefined();
    expect(Object.hasOwn(frontmatter(node.file_path), field)).toBe(false);
  }

  function expectClaim(field: string) {
    expect(db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
      .all('record')).toEqual([{ field }]);
    expect(readYaml('.schemas/record.yaml').field_claims.map((claim: { field: string }) => claim.field))
      .toEqual([field]);
    expect(readYaml('.schemas/_fields.yaml').fields.map((entry: { name: string }) => entry.name))
      .toContain(field);
  }

  async function undo(operationId: string) {
    await call('undo-operations', { operation_ids: [operationId], dry_run: false });
  }

  async function latestOperationId(sourceTool: string): Promise<string> {
    const history = await call('list-undo-history', { source_tool: sourceTool });
    return history.operations[0].operation_id;
  }

  function ingest(path: string, markdown: string): { node_id: string; file_path: string } {
    writeLock.clearRecentWrites();
    writeFileSync(join(vaultPath, path), markdown, 'utf8');
    processFileChange(join(vaultPath, path), path, db, writeLock, vaultPath);
    const row = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(path) as { id: string };
    expect(row).toBeDefined();
    // The watcher only indexes the edit; normalization owns canonical rendering.
    expect(readFileSync(join(vaultPath, path), 'utf8')).toBe(markdown);
    return { node_id: row.id, file_path: path };
  }

  it.each(fieldNames)('preserves %s through create, update, read, query, expansion, and node undo', async (field) => {
    await call('create-global-field', { name: field, field_type: 'string' });
    await call('create-schema', { name: 'record', field_claims: [{ field }] });
    expectClaim(field);

    const node = await call('create-node', {
      title: 'Target', types: ['record'],
      fields: JSON.parse(`{${JSON.stringify(field)}:"original"}`), body: 'Target body',
    });
    expectPersisted(node, field, 'original');

    await call('update-node', { node_id: node.node_id, set_fields: Object.fromEntries([[field, 'updated']]) });
    expectPersisted(node, field, 'updated');
    const updateOperationId = await latestOperationId('update-node');

    const read = await call('get-node', { node_id: node.node_id });
    expect(Object.hasOwn(read.fields, field)).toBe(true);
    expect(read.fields[field].value).toBe('updated');

    for (const includeFields of [[field], ['*']]) {
      const query = await call('query-nodes', {
        fields: Object.fromEntries([[field, { eq: 'updated' }]]), include_fields: includeFields,
      });
      expect(query.total).toBe(1);
      expect(query.nodes[0].id).toBe(node.node_id);
      expect(Object.hasOwn(query.nodes[0].fields, field)).toBe(true);
      expect(query.nodes[0].fields[field]).toBe('updated');
    }

    const source = await call('create-node', { title: 'Source', types: ['record'], fields: {}, body: '[[Target]]' });
    const expanded = await call('get-node', {
      node_id: source.node_id, expand: { types: ['record'], direction: 'outgoing', max_nodes: 10 },
    });
    expect(expanded.expand_stats.returned).toBe(1);
    expect(Object.hasOwn(expanded.expanded[node.node_id].fields, field)).toBe(true);
    expect(expanded.expanded[node.node_id].fields[field].value).toBe('updated');

    await undo(updateOperationId);
    expectPersisted(node, field, 'original');
  });

  it.each(fieldNames)('renames into and out of %s and reverses both renames without losing values', async (field) => {
    await call('create-global-field', { name: 'status', field_type: 'string' });
    await call('create-schema', { name: 'record', field_claims: [{ field: 'status' }] });
    const node = await call('create-node', {
      title: 'Rename target', types: ['record'], fields: { status: 'preserved' }, body: 'Body',
    });

    const into = await call('rename-global-field', { old_name: 'status', new_name: field });
    expectPersisted(node, field, 'preserved');
    expectAbsent(node, 'status');
    expectClaim(field);

    const out = await call('rename-global-field', { old_name: field, new_name: 'state' });
    expectPersisted(node, 'state', 'preserved');
    expectAbsent(node, field);
    expectClaim('state');

    await undo(out.operation_id);
    expectPersisted(node, field, 'preserved');
    expectAbsent(node, 'state');
    expectClaim(field);

    await undo(into.operation_id);
    expectPersisted(node, 'status', 'preserved');
    expectAbsent(node, field);
    expectClaim('status');
  });

  it.each(fieldNames)('populates %s defaults during claim propagation and restores pre-propagation state on undo', async (field) => {
    await call('create-global-field', {
      name: field, field_type: 'string', required: true, default_value: 'default value',
    });
    await call('create-schema', { name: 'record', field_claims: [] });
    const node = await call('create-node', { title: 'Existing record', types: ['record'], fields: {}, body: 'Body' });
    expectAbsent(node, field);

    const update = await call('update-schema', { name: 'record', add_field_claims: [{ field }] });
    expectPersisted(node, field, 'default value');
    expectClaim(field);

    // A fresh node also receives the default, even when the field's name is inherited on {}.
    const fresh = await call('create-node', { title: 'Fresh record', types: ['record'], fields: {}, body: 'Body' });
    expectPersisted(fresh, field, 'default value');

    await undo(update.operation_id);
    expectAbsent(node, field);
    expect(db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('record')).toEqual([]);
    expect(readYaml('.schemas/record.yaml').field_claims).toEqual([]);
    // Undoing the schema operation must not remove a subsequently created node's data.
    expectPersisted(fresh, field, 'default value');
  });

  it.each(fieldNames)('preserves %s from watcher ingestion through normalization and a subsequent file edit', async (field) => {
    await call('create-global-field', { name: field, field_type: 'string' });
    await call('create-schema', { name: 'record', field_claims: [{ field }] });
    const node = ingest('Watched.md', `---\ntypes: [record]\n${field}: 'watched value'\n---\nBody`);
    expectPersisted(node, field, 'watched value');

    const normalized = runNormalizerSweep(vaultPath, db, writeLock);
    expect(normalized.errored).toBe(0);
    expect(normalized.rewritten).toBe(1);
    expectPersisted(node, field, 'watched value');

    ingest('Watched.md', `---\ntypes: [record]\n${field}: 'edited value'\n---\nEdited body`);
    const second = runNormalizerSweep(vaultPath, db, writeLock);
    expect(second.errored).toBe(0);
    expectPersisted(node, field, 'edited value');
    const read = await call('get-node', { node_id: node.node_id });
    expect(Object.hasOwn(read.fields, field)).toBe(true);
    expect(read.fields[field].value).toBe('edited value');
  });

  it.each(fieldNames)('preserves explicit-null %s through normalization, unrelated writes, replacement, and undo', async (field) => {
    await call('create-global-field', { name: field, field_type: 'string' });
    await call('create-schema', { name: 'record', field_claims: [{ field }] });
    const node = ingest('Null.md', `---\ntypes: [record]\n${field}: null\n---\nBody`);

    async function expectNull() {
      expect(db.prepare('SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?')
        .all(node.node_id)).toEqual([{ field_name: field }]);
      expect(Object.hasOwn(frontmatter(node.file_path), field)).toBe(true);
      expect(frontmatter(node.file_path)[field]).toBeNull();
      const read = await call('get-node', { node_id: node.node_id });
      expect(Object.hasOwn(read.fields, field)).toBe(true);
      expect(read.fields[field].value).toBeNull();
    }

    await expectNull();
    const normalized = runNormalizerSweep(vaultPath, db, writeLock);
    expect(normalized.errored).toBe(0);
    await expectNull();
    await call('update-node', { node_id: node.node_id, set_body: 'Updated body' });
    await expectNull();
    await call('update-node', { node_id: node.node_id, set_fields: Object.fromEntries([[field, 'replacement']]) });
    expectPersisted(node, field, 'replacement');
    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?').all(node.node_id))
      .toEqual([]);
    await undo(await latestOperationId('update-node'));
    await expectNull();
  });

  it.each(fieldNames)('preserves %s reference values and relationship groups in both directions', async (field) => {
    await call('create-global-field', { name: field, field_type: 'reference' });
    await call('create-schema', { name: 'record', field_claims: [{ field }] });
    const target = await call('create-node', { title: 'Reference target', types: ['record'], fields: {}, body: 'Target' });
    const source = await call('create-node', {
      title: 'Reference source', types: ['record'], fields: Object.fromEntries([[field, 'Reference target']]), body: 'Source',
    });
    expect(db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(source.node_id, field)).toEqual({ value_text: 'Reference target' });
    expect(frontmatter(source.file_path)[field]).toBe('[[Reference target]]');
    expect(db.prepare('SELECT rel_type, resolved_target_id FROM relationships WHERE source_id = ?')
      .all(source.node_id)).toContainEqual({ rel_type: field, resolved_target_id: target.node_id });

    const outgoing = await call('get-node', { node_id: source.node_id });
    expect(Object.hasOwn(outgoing.fields, field)).toBe(true);
    expect(outgoing.fields[field].value).toBe('Reference target');
    expect(Object.hasOwn(outgoing.relationships.outgoing, field)).toBe(true);
    expect(outgoing.relationships.outgoing[field]).toContainEqual(expect.objectContaining({ target_id: target.node_id }));
    const incoming = await call('get-node', {
      node_id: target.node_id, expand: { types: ['record'], direction: 'incoming', max_nodes: 10 },
    });
    expect(Object.hasOwn(incoming.relationships.incoming, field)).toBe(true);
    expect(incoming.relationships.incoming[field]).toContainEqual(expect.objectContaining({ source_id: source.node_id }));
    expect(incoming.expand_stats.returned).toBe(1);
    expect(Object.hasOwn(incoming.expanded[source.node_id].fields, field)).toBe(true);
    expect(incoming.expanded[source.node_id].fields[field].value).toBe('Reference target');
  });
});
