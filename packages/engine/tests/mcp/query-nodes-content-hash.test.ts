import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

let db: Database.Database;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  db = createTestDb();
  const insert = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('a', 'Notes/Alpha.md', 'Alpha', '', 'hash-a', 1000, 2000);
  insert.run('b', 'Notes/Beta.md', 'Beta', '', null, 1000, 2000);
  server = new McpServer({ name: 'content-hash-test', version: '1' });
  registerQueryNodes(server, db);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});

async function query(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const result = await client.callTool({ name: 'query-nodes', arguments: args });
  const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { ok: boolean; data: { nodes: Array<Record<string, unknown>> } };
  expect(parsed.ok).toBe(true);
  return parsed.data.nodes;
}

describe('query-nodes content_hash (#659)', () => {
  it('returns each note\'s content hash when selected, null when it has none', async () => {
    const nodes = await query({ path_prefix: 'Notes/', select: ['id', 'content_hash'], sort_by: 'title' });
    expect(nodes).toEqual([{ id: 'a', content_hash: 'hash-a' }, { id: 'b', content_hash: null }]);
  });

  it('leaves it out of the default row shape', async () => {
    const nodes = await query({ path_prefix: 'Notes/', sort_by: 'title' });
    expect(nodes[0]).not.toHaveProperty('content_hash');
  });
});
