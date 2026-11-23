import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { assemble } from '../../src/extraction/assembler.js';

let db: ReturnType<typeof createTestDb>;
let vaultPath: string;
let cleanup: () => void;
let server: McpServer;
let cache: ExtractionCache;
let writeLock: WriteLockManager;
let rootId: string;
let targetId: string;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  for (const title of ['Root', 'Target']) {
    const filePath = `${title}.md`;
    writeFileSync(join(vaultPath, filePath), '---\ntypes: [note]\nnull_only: null\nshadow: null\n__proto__: null\ntext: Kept\n---\nBody');
    processFileChange(join(vaultPath, filePath), filePath, db, writeLock, vaultPath);
  }
  const idFor = (title: string) => (db.prepare('SELECT id FROM nodes WHERE title = ?').get(title) as { id: string }).id;
  rootId = idFor('Root');
  targetId = idFor('Target');
  for (const id of [rootId, targetId]) {
    // Defensive dual-row states must prefer the marker without repairing the DB.
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
      .run(id, 'shadow', 'Stale value', 'inline');
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_number, source) VALUES (?, ?, ?, ?)')
      .run(id, 'zero', 0, 'frontmatter');
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_date, source) VALUES (?, ?, ?, ?)')
      .run(id, 'date', '2026-09-13', 'frontmatter');
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES (?, ?, ?, ?)')
      .run(id, 'tags', '[]', 'frontmatter');
  }
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)')
    .run(rootId, 'Target', 'wiki-link', targetId);
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)')
    .run(targetId, 'Root', 'wiki-link', rootId);
  cache = new ExtractionCache(db, new ExtractorRegistry());
  server = new McpServer({ name: 'null-projections', version: '0' });
  registerGetNode(server, db, cache, vaultPath);
  registerQueryNodes(server, db);
});

afterEach(() => { writeLock.clearRecentWrites(); db.close(); cleanup(); });

async function call(name: string, params: Record<string, unknown>) {
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> })._registeredTools;
  const beforeDb = db.serialize();
  const files = ['Root.md', 'Target.md'].map(path => readFileSync(join(vaultPath, path), 'utf8'));
  const result = JSON.parse((await tools[name].handler(params)).content[0].text);
  expect(result.ok).toBe(true);
  expect(db.serialize().equals(beforeDb)).toBe(true);
  expect(['Root.md', 'Target.md'].map(path => readFileSync(join(vaultPath, path), 'utf8'))).toEqual(files);
  return result.data;
}

const nullDetail = { value: null, type: 'null', source: 'frontmatter' };
const expectedDetails = {
  null_only: nullDetail, shadow: nullDetail, ['__proto__']: nullDetail,
  text: { value: 'Kept', type: 'text', source: 'frontmatter' },
  zero: { value: 0, type: 'number', source: 'frontmatter' },
  date: { value: '2026-09-13', type: 'date', source: 'frontmatter' },
  tags: { value: [], type: 'json', source: 'frontmatter' },
};
const expectedValues = {
  null_only: null, shadow: null, ['__proto__']: null, text: 'Kept', zero: 0, date: '2026-09-13', tags: [],
};

describe('explicit-null read projections', () => {
  it.each(['node_id', 'file_path', 'title'])('preserves typed nulls when get-node resolves by %s', async selector => {
    const value = selector === 'node_id' ? rootId : selector === 'file_path' ? 'Root.md' : 'Root';
    for (const include_embeds of [undefined, false, true]) {
      const data = await call('get-node', { [selector]: value, ...(include_embeds === undefined ? {} : { include_embeds }) });
      expect(data.fields).toEqual(expectedDetails);
    }
  });

  it.each(['outgoing', 'incoming', 'both'])('preserves typed nulls for %s expanded neighbors', async direction => {
    const data = await call('get-node', { node_id: rootId, expand: { types: ['note'], direction, max_nodes: 10 } });
    expect(data.fields).toEqual(expectedDetails);
    expect(data.expanded[targetId].fields).toEqual(expectedDetails);
    expect(data.expand_stats).toEqual({ returned: 1, considered: 1, truncated: false });
  });

  it.each(['structured', 'fts'])('projects raw nulls through wildcard, named, and selective %s query results', async mode => {
    const query = mode === 'fts' ? { query: 'Root', search_mode: 'fts' } : { node_ids: [rootId] };
    for (const select of [undefined, ['title']]) {
      for (const [include_fields, expected] of [
        [['*'], expectedValues],
        [['null_only', 'shadow', '__proto__', 'zero', 'missing'], { null_only: null, shadow: null, ['__proto__']: null, zero: 0 }],
        [['missing'], {}],
      ] as const) {
        const data = await call('query-nodes', { ...query, include_fields, ...(select ? { select } : {}) });
        expect(data.nodes).toHaveLength(1);
        expect(data.nodes[0].fields).toEqual(expected);
      }
    }
  });

  it.each([undefined, []])('omits the fields map when include_fields is %s', async include_fields => {
    const data = await call('query-nodes', { node_ids: [rootId], include_fields });
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0]).not.toHaveProperty('fields');
  });

  it('keeps markers scoped to their node, including neighbors with only null fields or no fields', async () => {
    db.prepare('DELETE FROM node_fields WHERE node_id = ?').run(targetId);
    db.prepare('DELETE FROM node_explicit_null_fields WHERE node_id = ?').run(targetId);
    db.prepare('INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)').run(targetId, 'target_only');
    const data = await call('get-node', { node_id: rootId, expand: { types: ['note'], direction: 'outgoing', max_nodes: 10 } });
    expect(data.fields).toEqual(expectedDetails);
    expect(data.expanded[targetId].fields).toEqual({ target_only: nullDetail });
    const query = await call('query-nodes', { node_ids: [rootId, targetId], include_fields: ['*'] });
    expect(query.nodes.find((node: { id: string }) => node.id === rootId).fields).toEqual(expectedValues);
    expect(query.nodes.find((node: { id: string }) => node.id === targetId).fields).toEqual({ target_only: null });

    db.prepare('DELETE FROM node_explicit_null_fields WHERE node_id = ?').run(targetId);
    const empty = await call('get-node', { node_id: rootId, expand: { types: ['note'], direction: 'outgoing', max_nodes: 10 } });
    expect(empty.expanded[targetId].fields).toEqual({});
    const emptyQuery = await call('query-nodes', { node_ids: [targetId], include_fields: ['*'] });
    expect(emptyQuery.nodes[0].fields).toEqual({});
  });

  it('preserves explicit nulls in the assembler raw field projection', async () => {
    const beforeDb = db.serialize();
    const result = await assemble(db, rootId, cache, vaultPath);
    expect(result.node.fields).toEqual(expectedValues);
    expect(db.serialize().equals(beforeDb)).toBe(true);
  });
});
