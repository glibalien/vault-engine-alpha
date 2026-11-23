import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

// #332: query-nodes filters, selects and sorts on created_at (when the Engine first indexed a note).

let db: Database.Database;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  db = createTestDb();
  const insert = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('old', 'old.md', 'Old', '', 'h1', 5000, 5000, Date.parse('2026-10-01T00:00:00Z'));
  insert.run('mid', 'mid.md', 'Mid', '', 'h2', 9000, 9000, Date.parse('2026-11-10T00:00:00Z'));
  insert.run('new', 'new.md', 'New', '', 'h3', 1000, 1000, Date.parse('2026-11-16T00:00:00Z'));
  server = new McpServer({ name: 'created-at', version: '1' });
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

async function query(args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'query-nodes', arguments: args });
  return JSON.parse((result.content as { text: string }[])[0]!.text) as { ok: boolean; data: { nodes: Array<Record<string, unknown>> } };
}

it('lists notes created since a time, oldest first, with their creation time', async () => {
  const r = await query({ created_since: '2026-11-01T00:00:00Z', select: ['id', 'created_at'], sort_by: 'created_at', sort_order: 'asc' });
  expect(r.ok).toBe(true);
  expect(r.data.nodes).toEqual([
    { id: 'mid', created_at: Date.parse('2026-11-10T00:00:00Z') },
    { id: 'new', created_at: Date.parse('2026-11-16T00:00:00Z') },
  ]);
  const newestFirst = await query({ select: ['id'], sort_by: 'created_at', sort_order: 'desc' });
  expect(newestFirst.data.nodes.map(n => n.id)).toEqual(['new', 'mid', 'old']);
});
