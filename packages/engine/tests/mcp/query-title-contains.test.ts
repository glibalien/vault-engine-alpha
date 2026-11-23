import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

// #559: exclude by part of a title, and title substrings match literally.

let db: Database.Database;
let server: McpServer;
let client: Client;

function seed(id: string, title: string, type: string): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${title}.md`, title, '', `h-${id}`, 1000, 1000);
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}

beforeEach(async () => {
  db = createTestDb();
  seed('P1', 'Alpha opportunity', 'project');
  seed('P2', 'Beta Project', 'project');
  seed('P3', 'Gamma OPPORTUNITY review', 'project');
  seed('N1', 'a_b notes', 'note');
  seed('N2', 'axb notes', 'note');
  seed('N3', '100% done', 'note');
  seed('T1', 'Task one', 'task');
  seed('T2', 'Task two', 'task');
  const rel = db.prepare('INSERT INTO relationships (source_id, target, resolved_target_id, rel_type) VALUES (?, ?, ?, ?)');
  rel.run('T1', 'Alpha opportunity', 'P1', 'project');
  rel.run('T2', 'Beta Project', 'P2', 'project');
  server = new McpServer({ name: 'title-contains', version: '1' });
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

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0].text;
  try { return JSON.parse(text); } catch { return { ok: false, transportError: result.isError, text }; }
}

async function ids(args: Record<string, unknown>): Promise<string[]> {
  const r = await call('query-nodes', args);
  expect(r.ok).toBe(true);
  return (r.data.nodes as { id: string }[]).map(n => n.id).sort();
}

describe('query-nodes without_title_contains', () => {
  it('excludes titles containing the text, ignoring case', async () => {
    expect(await ids({ types: ['project'], without_title_contains: 'opportunity' })).toEqual(['P2']);
  });

  it('excludes titles containing any text in a list', async () => {
    expect(await ids({ types: ['project'], without_title_contains: ['alpha', 'gamma'] })).toEqual(['P2']);
  });

  it('works inside where groups and join targets', async () => {
    expect(await ids({
      types: ['project'],
      where: { any: [{ without_title_contains: 'opportunity' }, { node_ids: ['P1'] }] },
    })).toEqual(['P1', 'P2']);
    expect(await ids({
      types: ['task'],
      join_filters: [{ rel_type: 'project', target: { without_title_contains: 'opportunity' } }],
    })).toEqual(['T2']);
  });

  it('refuses a blank text or an empty list', async () => {
    for (const value of ['', [], ['ok', '']]) {
      const r = await call('query-nodes', {
        types: ['project'],
        where: { any: [{ without_title_contains: value }, { node_ids: ['P1'] }] },
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe('title substrings match literally', () => {
  it('title_contains treats _ and % as plain characters', async () => {
    expect(await ids({ title_contains: 'a_b' })).toEqual(['N1']);
    expect(await ids({ title_contains: '0%' })).toEqual(['N3']);
  });

  it('without_title_contains treats _ and % as plain characters', async () => {
    expect(await ids({ types: ['note'], without_title_contains: '%' })).toEqual(['N1', 'N2']);
    expect(await ids({ types: ['note'], without_title_contains: 'a_b' })).toEqual(['N2', 'N3']);
  });
});
