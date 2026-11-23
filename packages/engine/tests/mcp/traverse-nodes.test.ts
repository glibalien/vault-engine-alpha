import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { makeTraversalDb } from '../helpers/traversal-fixture.js';
import { registerTraverseNodes } from '../../src/mcp/tools/traverse-nodes.js';
let db: Database.Database, server: McpServer, client: Client;
beforeEach(async () => {
  db = makeTraversalDb([
    ['A', 'B'],
    ['B', 'C'],
  ]);
  server = new McpServer({ name: 'traversal-test', version: '1' });
  registerTraverseNodes(server, db);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});
async function call(args: Record<string, unknown>) {
  const r = await client.callTool({ name: 'traverse-nodes', arguments: args });
  return JSON.parse((r.content as Array<{ text: string }>)[0].text);
}
it('advertises a strict independent graph read and reports a depth boundary', async () => {
  const tool = (await client.listTools()).tools[0];
  expect(tool.name).toBe('traverse-nodes');
  expect(tool.inputSchema.additionalProperties).toBe(false);
  expect(tool.annotations).toMatchObject({
    readOnlyHint: true,
    idempotentHint: true,
  });
  expect(tool._meta).toBeUndefined();
  const r = await call({
    root_id: 'A',
    field: 'blockedBy',
    direction: 'outgoing',
    max_depth: 1,
  });
  expect(r).toMatchObject({
    ok: true,
    data: { kind: 'node_traversal', resolved_reachability_complete: false },
    warnings: [{ code: 'RESULT_TRUNCATED' }],
  });
  expect(r.data.nodes.map((n: { id: string }) => n.id)).toEqual(['A', 'B']);
});
it.each([
  { extra: true },
  { direction: 'both' },
  { field: 'status' },
  { include_fields: ['project'] },
])('preserves standard failure envelopes %j', async (patch) => {
  const r = await call({
    root_id: 'A',
    field: 'blockedBy',
    direction: 'outgoing',
    ...patch,
  });
  expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  expect(r).not.toHaveProperty('data');
});
it('returns NOT_FOUND for an absent exact root', async () => {
  expect(
    await call({
      root_id: 'absent',
      field: 'blockedBy',
      direction: 'incoming',
    }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});
