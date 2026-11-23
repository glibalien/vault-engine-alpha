import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { resolveTarget } from '../../src/resolver/resolve.js';
import { missingLinkKey, readLinkCounts } from '../../src/mcp/link-counts.js';

let db: Database.Database;
let server: McpServer;
let client: Client;
let cleanup: () => void;

function seedNode(id: string, title: string): void {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `Notes/${title}.md`, title, '', `hash-${id}`, 1000, 2000);
}

function seedRel(sourceId: string, target: string, relType = 'wiki-link'): void {
  const resolved = resolveTarget(db, target);
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)',
  ).run(sourceId, target, relType, null, resolved?.id ?? null);
}

/**
 * Alpha  in 2 (Gamma, Delta) · out 1 (Beta) · unresolved 2 (Missing Note, Ghost)
 * Beta   in 2 (Alpha, Foxtrot) · out 0
 * Gamma  in 0 · out 1 (Alpha)
 * Delta  in 0 · out 1 (Alpha, through a body link and a field)
 * Echo   no links
 * Foxtrot in 0 · out 1 (Beta)
 */
function seedFixture(): void {
  for (const [id, title] of [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma'], ['d', 'Delta'], ['e', 'Echo'], ['f', 'Foxtrot']]) seedNode(id, title);
  seedRel('a', 'Beta');
  seedRel('a', 'Beta', 'project'); // same note through a field: still one outlink
  seedRel('a', 'Alpha'); // self-link: never counted
  seedRel('a', 'Missing Note');
  seedRel('a', 'missing note.md'); // the same missing note, spelled differently
  seedRel('a', 'Ghost#Intro'); // a missing note named through a heading
  seedRel('a', 'diagram.png'); // an attachment, not a missing note
  seedRel('a', '#Heading'); // a heading in the same note
  seedRel('c', 'Alpha');
  seedRel('d', 'Alpha');
  seedRel('d', 'Alpha', 'related');
  seedRel('f', 'Beta');
}

beforeEach(async () => {
  db = createTestDb();
  seedFixture();
  const vault = createTempVault();
  cleanup = vault.cleanup;
  server = new McpServer({ name: 'link-counts-test', version: '1' });
  registerQueryNodes(server, db);
  registerGetNode(server, db);
  registerUpdateNode(server, db, new WriteLockManager(), vault.vaultPath);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
  cleanup();
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  try { return JSON.parse(text); } catch { return { transportError: result.isError, message: text }; }
}

const COUNT_SELECT = ['title', 'inlink_count', 'outlink_count', 'unresolved_link_count'];

async function titles(args: Record<string, unknown>): Promise<string[]> {
  const env = await call('query-nodes', { select: ['title'], limit: 200, ...args });
  expect(env.ok).toBe(true);
  return env.data.nodes.map((n: { title: string }) => n.title);
}

describe('missingLinkKey', () => {
  it('names the missing note, folding spelling and dropping anchors', () => {
    expect(missingLinkKey('Missing Note')).toBe('missing note');
    expect(missingLinkKey('missing note.md')).toBe('missing note');
    expect(missingLinkKey('Ghost#Intro')).toBe('ghost');
    expect(missingLinkKey('Ghost#^block')).toBe('ghost');
    expect(missingLinkKey('Projects/Plan')).toBe('projects-plan');
  });

  it('skips attachments and same-note headings', () => {
    for (const target of ['diagram.png', 'Scan.PDF', 'clip.3gp', 'board.canvas', 'report.pdf#page=3', '#Heading', '  '])
      expect(missingLinkKey(target)).toBeNull();
  });

  it('keeps note names with dots in them', () => {
    expect(missingLinkKey('Version 2.0')).toBe('version 2.0');
    expect(missingLinkKey('Dr. Smith')).toBe('dr. smith');
  });

  it('treats an explicit .md as a note, even with a dotted name', () => {
    expect(missingLinkKey('Report.v2.md')).toBe('report.v2');
    expect(missingLinkKey('Report.v2.md#Intro')).toBe('report.v2');
  });
});

describe('query-nodes link counts', () => {
  it('returns exact counts as selectable columns', async () => {
    const env = await call('query-nodes', { select: COUNT_SELECT, sort_by: 'title' });
    expect(env.ok).toBe(true);
    expect(env.data.nodes).toEqual([
      { title: 'Alpha', inlink_count: 2, outlink_count: 1, unresolved_link_count: 2 },
      { title: 'Beta', inlink_count: 2, outlink_count: 0, unresolved_link_count: 0 },
      { title: 'Delta', inlink_count: 0, outlink_count: 1, unresolved_link_count: 0 },
      { title: 'Echo', inlink_count: 0, outlink_count: 0, unresolved_link_count: 0 },
      { title: 'Foxtrot', inlink_count: 0, outlink_count: 1, unresolved_link_count: 0 },
      { title: 'Gamma', inlink_count: 0, outlink_count: 1, unresolved_link_count: 0 },
    ]);
  });

  it('leaves the counts out of the default row shape', async () => {
    const env = await call('query-nodes', {});
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data.nodes[0])).not.toContain('inlink_count');
    expect(Object.keys(env.data.nodes[0])).not.toContain('outlink_count');
  });

  it('filters on each count', async () => {
    expect(await titles({ link_counts: { incoming: { lte: 1 } } })).toEqual(['Delta', 'Echo', 'Foxtrot', 'Gamma']);
    expect(await titles({ link_counts: { outgoing: { eq: 0 } } })).toEqual(['Beta', 'Echo']);
    expect(await titles({ link_counts: { unresolved: { gte: 1 } } })).toEqual(['Alpha']);
    expect(await titles({ link_counts: { incoming: { gte: 1, lt: 3 }, outgoing: { lte: 1 } } })).toEqual(['Alpha', 'Beta']);
    expect(await titles({ link_counts: { incoming: { ne: 0 } } })).toEqual(['Alpha', 'Beta']);
  });

  it('reports total for a filtered count', async () => {
    const env = await call('query-nodes', { link_counts: { incoming: { lte: 1 }, outgoing: { lte: 1 } }, limit: 2 });
    expect(env.ok).toBe(true);
    expect(env.data.total).toBe(4);
    expect(env.data.nodes).toHaveLength(2);
  });

  it('works inside a where expression, so either count can match', async () => {
    const where = { any: [{ link_counts: { incoming: { gte: 2 } } }, { link_counts: { outgoing: { eq: 0 } } }] };
    expect(await titles({ where })).toEqual(['Alpha', 'Beta', 'Echo']);
  });

  it('narrows to some link fields with rel_type', async () => {
    expect(await titles({ link_counts: { rel_type: 'related', incoming: { gte: 1 } } })).toEqual(['Alpha']);
    expect(await titles({ link_counts: { rel_type: ['project', 'related'], outgoing: { gte: 1 } } })).toEqual(['Alpha', 'Delta']);
  });

  it('sorts by a count, ties falling back to title', async () => {
    const byIn = await call('query-nodes', { select: ['title', 'inlink_count'], sort_by: 'inlink_count', sort_order: 'desc' });
    expect(byIn.data.nodes.map((n: { title: string }) => n.title)).toEqual(['Alpha', 'Beta', 'Delta', 'Echo', 'Foxtrot', 'Gamma']);
    const byOut = await titles({ sort_by: 'outlink_count', sort_order: 'asc' });
    expect(byOut).toEqual(['Beta', 'Echo', 'Alpha', 'Delta', 'Foxtrot', 'Gamma']);
    const byUnresolved = await titles({ sort_by: 'unresolved_link_count', sort_order: 'desc', limit: 1 });
    expect(byUnresolved).toEqual(['Alpha']);
  });

  it('pages a count sort stably', async () => {
    const first = await titles({ sort_by: 'inlink_count', limit: 3 });
    const second = await titles({ sort_by: 'inlink_count', limit: 3, offset: 3 });
    expect([...first, ...second]).toEqual(['Delta', 'Echo', 'Foxtrot', 'Gamma', 'Alpha', 'Beta']);
  });

  it('follows a link that resolves later', async () => {
    seedNode('g', 'Missing Note');
    db.prepare("UPDATE relationships SET resolved_target_id = 'g' WHERE target IN ('Missing Note', 'missing note.md')").run();
    const env = await call('query-nodes', { select: COUNT_SELECT, title_eq: 'Alpha' });
    expect(env.data.nodes[0]).toMatchObject({ outlink_count: 2, unresolved_link_count: 1 });
    const missing = await call('query-nodes', { select: COUNT_SELECT, title_eq: 'Missing Note' });
    expect(missing.data.nodes[0]).toMatchObject({ inlink_count: 1 });
  });

  it.each([
    [{ incoming: { lte: -1 } }],
    [{ incoming: { lte: 1.5 } }],
    [{ incoming: {} }],
    [{ rel_type: 'project' }],
    [{ sideways: { eq: 1 } }],
  ])('rejects a malformed filter %j', async (link_counts) => {
    const env = await call('query-nodes', { link_counts });
    expect(env.ok === false || env.transportError === true).toBe(true);
  });

  it('rejects a malformed filter inside where', async () => {
    const env = await call('query-nodes', { where: { any: [{ link_counts: { incoming: 'one' } }, { types: ['note'] }] } });
    expect(env.ok === false || env.transportError === true).toBe(true);
  });
});

describe('get-node link counts', () => {
  it('reports the same counts as query-nodes', async () => {
    const env = await call('get-node', { title: 'Alpha' });
    expect(env.ok).toBe(true);
    expect(env.data.link_counts).toEqual({ incoming: 2, outgoing: 1, unresolved: 2 });
    const isolated = await call('get-node', { title: 'Echo' });
    expect(isolated.data.link_counts).toEqual({ incoming: 0, outgoing: 0, unresolved: 0 });
  });

  it('matches readLinkCounts', () => {
    const counts = readLinkCounts(db, ['a', 'b', 'missing-id']);
    expect(counts.get('a')).toEqual({ incoming: 2, outgoing: 1, unresolved: 2 });
    expect(counts.get('b')).toEqual({ incoming: 2, outgoing: 0, unresolved: 0 });
    expect(counts.has('missing-id')).toBe(false);
  });
});

describe('update-node query mode', () => {
  it('refuses a link_counts filter instead of dropping it and widening the match', async () => {
    const env = await call('update-node', { query: { link_counts: { incoming: { eq: 0 } } }, add_types: ['note'], dry_run: true });
    expect(env.ok === false || env.transportError === true).toBe(true);
  });
});
