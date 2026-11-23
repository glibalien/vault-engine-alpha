import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { makeRollupDb } from '../helpers/rollup-fixture.js';
import { registerReadRollups } from '../../src/mcp/tools/read-rollups.js';

let db: Database.Database;
let server: McpServer;
let client: Client;
beforeEach(async () => {
  db = makeRollupDb();
  server = new McpServer({ name: 'rollup-guidance', version: '1' });
  registerReadRollups(server, db);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => { await client.close(); await server.close(); db.close(); });
async function call(extra: Record<string, unknown> = {}) {
  const response = await client.callTool({ name: 'read-rollups', arguments: {
    schema: 'project', rollups: ['open_task_count', 'next_due_date'], ...extra,
  } });
  expect(response.isError).not.toBe(true);
  return JSON.parse((response.content as Array<{ text: string }>)[0].text);
}
it('supports multiple metrics, a field filter, metric sorting and related identity in one read', async () => {
  const before = db.serialize();
  const result = await call({ filter: { fields: { status: { ne: 'done' } } },
    sort: { by: 'rollup', name: 'open_task_count', order: 'desc' },
    relations: [{ name: 'tasks', fields: ['status', 'due'], limit: 1 }], limit: 1 });
  expect(result).toMatchObject({ ok: true, data: { rows: [{
    node: { id: 'P2' }, rollups: { open_task_count: 3, next_due_date: '2026-09-18' },
    relations: { tasks: { total: 3, returned: 1, truncated: true, items: [{
      id: 'T2', title: 'T2', file_path: 'T2.md', version: expect.any(Number),
      fields: { status: 'in-progress', due: '2026-09-18' },
    }] } },
  }], page: { total: 3 } } });
  expect(db.serialize()).toEqual(before);
});
it.each([
  [{ filter: { status: { ne: 'done' } } }, /filter\.fields/],
  [{ sort: { by: 'open_task_count', order: 'desc' } }, /by.*rollup.*name/],
  [{ relations: [{ name: 'tasks', fields: ['title', 'status', 'due'] }] }, /already.*title/],
])('explains how to correct reported argument mistake %j', async (args, message) => {
  const before = db.serialize();
  expect(await call(args)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringMatching(message) } });
  expect(db.serialize()).toEqual(before);
});
it('keeps genuine typed fields named title selectable separately from node identity', async () => {
  db.prepare("INSERT INTO global_fields(name,field_type) VALUES ('title','string')").run();
  db.prepare("INSERT INTO node_fields(node_id,field_name,value_text,source) VALUES ('T1','title','Custom title','frontmatter')").run();
  const result = await call({ filter: { node_ids: ['P1'] }, relations: [{ name: 'tasks', fields: ['title'], limit: 1 }] });
  expect(result).toMatchObject({ ok: true, data: { rows: [{ relations: { tasks: {
    items: [{ id: 'T1', title: 'T1', fields: { title: 'Custom title' } }],
  } } }] } });
});
it('advertises the filter, sort and lookup distinctions through tools/list', async () => {
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'read-rollups')!;
  expect(tool.description).toContain('filter.fields');
  expect(tool.description).toContain('multiple rollups');
  expect(tool.description).toContain('already include id, title, file_path and version');
  expect(JSON.stringify(tool.inputSchema)).toContain('typed global fields');
});
