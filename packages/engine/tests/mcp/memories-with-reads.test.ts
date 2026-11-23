import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { makeMemoriesServer, callTool } from './memories.test.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerProjectEvidence } from '../../src/mcp/tools/project-evidence.js';
import { insertMemoryVector } from '../../src/memories/service.js';
import { BEARING_CHAR_CAP } from '../../src/memories/bearing.js';
import { addSubjects } from '../../src/memories/subjects.js';
import { linkKey } from '../../src/resolver/near-miss.js';
import type { Embedder } from '../../src/search/embedder.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

/** A unit vector at `angle` radians in the first two dimensions: cosine distance 1 - cos(Δangle). */
function at(angle: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

function embedder(map: Record<string, number>): Embedder {
  const embedQuery = async (text: string) => at(map[text] ?? Math.PI / 2);
  return { isReady: () => true, embedQuery, embedDocument: async (text: string) => [await embedQuery(text)] };
}

interface MemoryInput {
  content: string;
  source?: string;
  scope?: 'vault' | 'node';
  node_id?: string;
  category?: string;
  created_at?: string;
  evidence_node_id?: string;
  evidence_ref?: string;
  expired?: boolean;
  angle?: number;
}

/** A memory written straight to the table, so its date and source are the test's to choose. */
function addMemory(db: Database.Database, m: MemoryInput): number {
  const at_ = m.created_at ?? '2026-10-01T00:00:00.000Z';
  const id = Number(db.prepare(
    `INSERT INTO memories (source, scope, node_id, content, category, created_at, updated_at, valid_at,
       evidence_kind, evidence_node_id, evidence_hash, evidence_ref, expired_at, expire_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.source ?? 'curator', m.scope ?? 'vault', m.node_id ?? null, m.content, m.category ?? null, at_, at_, at_,
    m.evidence_node_id ? 'note' : 'conversation', m.evidence_node_id ?? null, m.evidence_node_id ? 'h' : null,
    m.evidence_node_id ? null : (m.evidence_ref ?? 'c#1'),
    m.expired ? '2026-11-01T00:00:00.000Z' : null, m.expired ? 'deleted' : null,
  ).lastInsertRowid);
  if (m.angle !== undefined) insertMemoryVector(db, id, at(m.angle));
  return id;
}

/** A tool's handler, called as the SDK would after parsing. */
function handler(register: (server: McpServer) => void, name: string) {
  let call: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  register({ tool: (n: string, _d: string, _s: unknown, fn: typeof call) => { if (n === name) call = fn; } } as unknown as McpServer);
  return async (params: Record<string, unknown>) => JSON.parse((await call(params)).content[0]!.text);
}

const contents = (res: { data: { memories: Array<{ content: string }> } }) => res.data.memories.map(m => m.content);

describe('list-memories search_mode "semantic" (#560)', () => {
  it('ranks memories by meaning, closest first, without their words, and leaves out memories without a vector', async () => {
    const { server, db } = makeMemoriesServer({ embedder: embedder({ 'how long should pages be': 0.1 }) });
    cleanup.push(() => db.close());
    addMemory(db, { content: 'The owner wants short wiki pages', angle: 0 });
    addMemory(db, { content: 'Summaries go in the first paragraph', angle: 0.6 });
    addMemory(db, { content: 'Lunch is at noon on Fridays', angle: 1.5 });
    addMemory(db, { content: 'how long should pages be, a note without a vector' });

    const res = await callTool(server, 'list-memories', { query: 'how long should pages be', search_mode: 'semantic' });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
    // The lunch memory is past the default cut-off (distance 1 - cos 1.4, about 0.83).
    expect(contents(res)).toEqual(['The owner wants short wiki pages', 'Summaries go in the first paragraph']);
    expect(res.data.total).toBe(2);
    expect(res.data.search_mode).toBe('semantic');
    expect(res.data.query).toBe('how long should pages be');
    const distances = res.data.memories.map((m: { distance: number }) => m.distance);
    expect(distances[0]).toBeCloseTo(1 - Math.cos(0.1), 5);
    expect(distances[1]).toBeCloseTo(1 - Math.cos(0.5), 5);

    const everything = await callTool(server, 'list-memories', { query: 'how long should pages be', search_mode: 'semantic', max_distance: 2 });
    expect(contents(everything)).toEqual(['The owner wants short wiki pages', 'Summaries go in the first paragraph', 'Lunch is at noon on Fridays']);
    expect(everything.data.memories[2].distance).toBeCloseTo(1 - Math.cos(1.4), 5);
    expect(everything.data.total).toBe(3);
    const closest = await callTool(server, 'list-memories', { query: 'how long should pages be', search_mode: 'semantic', max_distance: 0.05 });
    expect(contents(closest)).toEqual(['The owner wants short wiki pages']);
    expect(closest.data.total).toBe(1);

    // Full text finds only the memory that has the words.
    const fts = await callTool(server, 'list-memories', { query: 'pages' });
    expect(contents(fts).sort()).toEqual(['The owner wants short wiki pages', 'how long should pages be, a note without a vector']);
    expect(fts.data).not.toHaveProperty('search_mode');
    expect(fts.data.memories[0]).not.toHaveProperty('distance');
  });

  it('returns nothing for a topic no memory is about', async () => {
    const { server, db } = makeMemoriesServer({ embedder: embedder({ 'favorite pizza toppings': Math.PI / 2 }) });
    cleanup.push(() => db.close());
    addMemory(db, { content: 'The owner wants short wiki pages', angle: 0 });
    addMemory(db, { content: 'Summaries go in the first paragraph', angle: 0.3 });
    const res = await callTool(server, 'list-memories', { query: 'favorite pizza toppings', search_mode: 'semantic' });
    expect(res.ok).toBe(true);
    expect(res.data.memories).toEqual([]);
    expect(res.data.total).toBe(0);
  });

  it('applies every filter, the limit and the offset', async () => {
    const { server, db } = makeMemoriesServer({ embedder: embedder({ q: 0 }) });
    cleanup.push(() => db.close());
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('p', 'Projects/Alpha.md', 'Alpha'), ('n', 'Notes/Alpha sync.md', 'Alpha sync')").run();
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('p', 'project')").run();
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('n', 'Alpha', 'project', 'p')").run();
    addMemory(db, { content: 'closest, from chat', source: 'chat', angle: 0 });
    addMemory(db, { content: 'second, from the curator', angle: 0.2 });
    addMemory(db, { content: 'third, from the curator, from the project', evidence_node_id: 'n', angle: 0.4 });
    addMemory(db, { content: 'fourth, from the curator', angle: 0.6 });
    addMemory(db, { content: 'retired', angle: 0, expired: true });

    const search = (args: Record<string, unknown>) => callTool(server, 'list-memories', { query: 'q', search_mode: 'semantic', ...args });
    expect(contents(await search({ source: 'curator' }))).toEqual(['second, from the curator', 'third, from the curator, from the project', 'fourth, from the curator']);
    expect(contents(await search({ project_of: 'p' }))).toEqual(['third, from the curator, from the project']);
    const page = await search({ limit: 2, offset: 1 });
    expect(contents(page)).toEqual(['second, from the curator', 'third, from the curator, from the project']);
    expect(page.data.total).toBe(4);
    expect(contents(await search({ include_superseded: true, limit: 2 }))).toEqual(['retired', 'closest, from chat']);
  });

  it('gives each memory its provenance observation when asked', async () => {
    const { server, db } = makeMemoriesServer({ embedder: embedder({ q: 0 }) });
    cleanup.push(() => db.close());
    const id = addMemory(db, { content: 'a fact', angle: 0 });
    const res = await callTool(server, 'list-memories', { query: 'q', search_mode: 'semantic', include_provenance: true });
    expect(res.data.memories[0].distance).toBeCloseTo(0, 5);
    expect(res.data.memories[0].provenance_observation.source.native_id).toBe(String(id));
  });

  it('needs a query', async () => {
    const { server, db } = makeMemoriesServer({ embedder: embedder({}) });
    cleanup.push(() => db.close());
    const res = await callTool(server, 'list-memories', { search_mode: 'semantic' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toMatch(/needs a query/);
  });

  it('searches the full text instead, with a warning, when there is no embedder', async () => {
    const { server, db } = makeMemoriesServer();
    cleanup.push(() => db.close());
    addMemory(db, { content: 'The owner wants short wiki pages' });
    addMemory(db, { content: 'Lunch is at noon' });
    const res = await callTool(server, 'list-memories', { query: 'wiki', search_mode: 'semantic' });
    expect(res.ok).toBe(true);
    expect(contents(res)).toEqual(['The owner wants short wiki pages']);
    expect(res.data).not.toHaveProperty('search_mode');
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'SEMANTIC_SEARCH_UNAVAILABLE', message: expect.stringMatching(/no embedder/) })]);

    // A query full text cannot parse fails, and still says why it was read as full text.
    const bad = await callTool(server, 'list-memories', { query: 'what is "unbalanced', search_mode: 'semantic' });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('INVALID_PARAMS');
    expect(bad.warnings).toEqual([expect.objectContaining({ code: 'SEMANTIC_SEARCH_UNAVAILABLE' })]);
  });

  it('searches the full text instead, with a warning, when the embedder fails', async () => {
    const failing: Embedder = {
      isReady: () => true,
      embedQuery: async () => { throw new Error('worker exited'); },
      embedDocument: async () => { throw new Error('worker exited'); },
    };
    const { server, db } = makeMemoriesServer({ embedder: failing });
    cleanup.push(() => db.close());
    addMemory(db, { content: 'The owner wants short wiki pages' });
    const res = await callTool(server, 'list-memories', { query: 'wiki', search_mode: 'semantic' });
    expect(contents(res)).toEqual(['The owner wants short wiki pages']);
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'SEMANTIC_SEARCH_UNAVAILABLE', message: expect.stringMatching(/embedder failed: worker exited/) })]);
  });

  it('defaults to full text, so existing callers are unchanged', async () => {
    const { server, db } = makeMemoriesServer({ embedder: embedder({}) });
    cleanup.push(() => db.close());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = (server as any)._registeredTools['list-memories'].inputSchema.shape;
    expect(shape.search_mode.parse(undefined)).toBe('fts');
  });
});

/** A project, two notes filed under it, and a note filed under nothing. */
function seedProject(db: Database.Database): void {
  const node = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)');
  const rel = db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)');
  node.run('p', 'Projects/Alpha.md', 'Alpha', '', 'hp');
  db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('p', 'project')").run();
  node.run('n', 'Meetings/Alpha sync.md', 'Alpha sync', 'Notes.', 'hn');
  node.run('o', 'Meetings/Alpha review.md', 'Alpha review', 'Notes.', 'ho');
  node.run('x', 'Daily/2026-10-20.md', '2026-10-20', 'Daily.', 'hx');
  rel.run('n', 'Alpha', 'project', 'p');
  rel.run('o', 'Alpha', 'wiki-link', 'p');
}

describe('get-node include_memories, the memories about a person (#554)', () => {
  it("adds the memories naming the note as a subject, from any note or chat, after the note's own", async () => {
    const db = createTestDb();
    cleanup.push(() => db.close());
    seedProject(db);
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)').run('dana', 'People/Dana Whitfield.md', 'Dana Whitfield', '', 'hd');
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('dana', 'person')").run();
    const about = (id: number) => addSubjects(db, id, [{ name: 'Dana Whitfield', name_key: linkKey('Dana Whitfield'), node_id: 'dana', status: 'linked' }], 'tool', '2026-11-01T00:00:00.000Z');
    const own = addMemory(db, { content: 'Dana prefers mornings', evidence_node_id: 'dana', created_at: '2026-09-01T00:00:00.000Z' });
    const meeting = addMemory(db, { content: 'Dana Whitfield leads the Alpha renewal', evidence_node_id: 'n', created_at: '2026-10-01T00:00:00.000Z' });
    const chat = addMemory(db, { content: 'Dana Whitfield moved to the platform team', source: 'claude', evidence_ref: 'conv#9', created_at: '2026-11-10T00:00:00.000Z' });
    about(meeting);
    about(chat);
    addMemory(db, { content: 'Unrelated fact', evidence_node_id: 'x' });

    const call = handler(server => registerGetNode(server, db), 'get-node');
    const res = await call({ node_id: 'dana', include_embeds: false, include_memories: true });
    expect(res.ok).toBe(true);
    expect(res.data.memories.map((m: { id: number; via: string }) => [m.id, m.via])).toEqual([
      [own, 'node'],
      // About Dana, newest first: from a chat, then from the Alpha sync.
      [chat, 'subject'],
      [meeting, 'subject'],
    ]);
    expect(res.data.memory_stats).toEqual({ returned: 3, considered: 3, truncated: false });

    // The meeting's own read is unchanged: Dana is a subject of its memory, not the meeting.
    const sync = await call({ node_id: 'n', include_embeds: false, include_memories: true });
    expect(sync.data.memories.find((m: { id: number }) => m.id === meeting)?.via).toBe('node');
  });
});

describe('get-node include_memories (#560)', () => {
  it("returns the node's own memories and its project's, preferences, corrections and rules first, each with its source", async () => {
    const db = createTestDb();
    cleanup.push(() => db.close());
    seedProject(db);
    const drawn = addMemory(db, { content: 'Drawn from the sync', evidence_node_id: 'n', category: 'fact', created_at: '2026-10-01T00:00:00.000Z' });
    const about = addMemory(db, { content: 'About the sync, from chat', source: 'chat', scope: 'node', node_id: 'n', evidence_ref: 'conv#4', created_at: '2026-10-03T00:00:00.000Z' });
    const project = addMemory(db, { content: 'From the review', evidence_node_id: 'o', created_at: '2026-10-05T00:00:00.000Z' });
    const preference = addMemory(db, { content: 'Keep Alpha notes short', evidence_node_id: 'o', category: 'preference', created_at: '2026-09-01T00:00:00.000Z' });
    const rule = addMemory(db, { content: 'Never give Alpha a date', evidence_node_id: 'n', category: 'rule', created_at: '2026-08-01T00:00:00.000Z' });
    // Not shown: another client's memory about the note (the chat's sources only), a retired one,
    // and one from a note filed under no project.
    addMemory(db, { content: 'About the sync, from another client', source: 'other-client', scope: 'node', node_id: 'n' });
    addMemory(db, { content: 'Retired', evidence_node_id: 'n', expired: true });
    addMemory(db, { content: 'From the daily note', evidence_node_id: 'x' });

    const call = handler(server => registerGetNode(server, db), 'get-node');
    const res = await call({ node_id: 'n', include_embeds: false, include_memories: true });
    expect(res.ok).toBe(true);
    expect(res.data.memories).toEqual([
      { id: preference, content: 'Keep Alpha notes short', category: 'preference', source: 'curator', created_at: '2026-09-01T00:00:00.000Z', valid_at: '2026-09-01T00:00:00.000Z',
        evidence_kind: 'note', evidence_node_id: 'o', evidence_ref: null, via: 'project' },
      { id: rule, content: 'Never give Alpha a date', category: 'rule', source: 'curator', created_at: '2026-08-01T00:00:00.000Z', valid_at: '2026-08-01T00:00:00.000Z',
        evidence_kind: 'note', evidence_node_id: 'n', evidence_ref: null, via: 'node' },
      { id: about, content: 'About the sync, from chat', category: null, source: 'chat', created_at: '2026-10-03T00:00:00.000Z', valid_at: '2026-10-03T00:00:00.000Z',
        evidence_kind: 'conversation', evidence_node_id: null, evidence_ref: 'conv#4', via: 'node' },
      { id: drawn, content: 'Drawn from the sync', category: 'fact', source: 'curator', created_at: '2026-10-01T00:00:00.000Z', valid_at: '2026-10-01T00:00:00.000Z',
        evidence_kind: 'note', evidence_node_id: 'n', evidence_ref: null, via: 'node' },
      { id: project, content: 'From the review', category: null, source: 'curator', created_at: '2026-10-05T00:00:00.000Z', valid_at: '2026-10-05T00:00:00.000Z',
        evidence_kind: 'note', evidence_node_id: 'o', evidence_ref: null, via: 'project' },
    ]);
    expect(res.data.memory_stats).toEqual({ returned: 5, considered: 5, truncated: false });

    const plain = await call({ node_id: 'n', include_embeds: false });
    expect(plain.data).not.toHaveProperty('memories');
    expect(plain.data).not.toHaveProperty('memory_stats');
  });

  it('returns only its own memories for a note filed under no project, and none when it has none', async () => {
    const db = createTestDb();
    cleanup.push(() => db.close());
    seedProject(db);
    addMemory(db, { content: 'From the daily note', evidence_node_id: 'x' });
    addMemory(db, { content: 'From the sync', evidence_node_id: 'n' });
    const call = handler(server => registerGetNode(server, db), 'get-node');
    expect(contents(await call({ node_id: 'x', include_embeds: false, include_memories: true }))).toEqual(['From the daily note']);
    db.prepare('DELETE FROM memories').run();
    const none = await call({ node_id: 'x', include_embeds: false, include_memories: true });
    expect(none.data.memories).toEqual([]);
    expect(none.data.memory_stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });

  it('stops on a whole memory at the character cap, and always returns the first', async () => {
    const db = createTestDb();
    cleanup.push(() => db.close());
    seedProject(db);
    const long = (letter: string, length: number) => letter.repeat(length);
    addMemory(db, { content: long('a', 2500), evidence_node_id: 'x', created_at: '2026-10-03T00:00:00.000Z' });
    addMemory(db, { content: long('b', 2500), evidence_node_id: 'x', created_at: '2026-10-02T00:00:00.000Z' });
    addMemory(db, { content: long('c', 2500), evidence_node_id: 'x', created_at: '2026-10-01T00:00:00.000Z' });
    const call = handler(server => registerGetNode(server, db), 'get-node');
    const res = await call({ node_id: 'x', include_embeds: false, include_memories: true });
    expect(contents(res)).toEqual([long('a', 2500), long('b', 2500)]);
    expect(res.data.memory_stats).toEqual({ returned: 2, considered: 3, truncated: true });

    db.prepare('DELETE FROM memories').run();
    addMemory(db, { content: long('d', BEARING_CHAR_CAP + 1000), evidence_node_id: 'x' });
    const one = await call({ node_id: 'x', include_embeds: false, include_memories: true });
    expect(contents(one)).toEqual([long('d', BEARING_CHAR_CAP + 1000)]);
    expect(one.data.memory_stats).toEqual({ returned: 1, considered: 1, truncated: false });
  });

  it('says it was cut when the node or its project has more memories than are fetched', async () => {
    const db = createTestDb();
    cleanup.push(() => db.close());
    seedProject(db);
    // 81 short memories of a note filed under no project: one past the 80 of its own that are considered.
    for (let i = 0; i < 81; i++) addMemory(db, { content: `daily ${i}`, evidence_node_id: 'x', created_at: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` });
    const call = handler(server => registerGetNode(server, db), 'get-node');
    const own = await call({ node_id: 'x', include_embeds: false, include_memories: true });
    expect(own.data.memory_stats).toEqual({ returned: 80, considered: 80, truncated: true });

    // 31 short memories from a note filed under the project: one past the project's 30.
    db.prepare('DELETE FROM memories').run();
    for (let i = 0; i < 31; i++) addMemory(db, { content: `review ${i}`, evidence_node_id: 'o' });
    const project = await call({ node_id: 'n', include_embeds: false, include_memories: true });
    expect(project.data.memory_stats).toEqual({ returned: 30, considered: 30, truncated: true });

    // Exactly at both limits: nothing left out.
    db.prepare('DELETE FROM memories').run();
    for (let i = 0; i < 30; i++) addMemory(db, { content: `review ${i}`, evidence_node_id: 'o' });
    for (let i = 0; i < 80; i++) addMemory(db, { content: `about ${i}`, source: 'chat', scope: 'node', node_id: 'n' });
    const full = await call({ node_id: 'n', include_embeds: false, include_memories: true });
    expect(full.data.memory_stats).toEqual({ returned: 110, considered: 110, truncated: false });

    // 31 memories drawn from the project note: the project set passes its 30, but its 31st is one
    // of the note's own, so nothing is left out, for get-node and project-evidence alike.
    db.prepare('DELETE FROM memories').run();
    for (let i = 0; i < 31; i++) addMemory(db, { content: `project ${i}`, evidence_node_id: 'p' });
    const projectNote = await call({ node_id: 'p', include_embeds: false, include_memories: true });
    expect(projectNote.data.memory_stats).toEqual({ returned: 31, considered: 31, truncated: false });
    const evidence = await handler(server => registerProjectEvidence(server, db), 'project-evidence')({ project: 'Alpha', include_memories: true });
    expect(evidence.data.memory_stats).toEqual({ returned: 31, considered: 31, truncated: false });
    // One more, from a note filed under the project, is left out.
    addMemory(db, { content: 'review extra', evidence_node_id: 'o', created_at: '2026-09-01T00:00:00.000Z' });
    const more = await call({ node_id: 'p', include_embeds: false, include_memories: true });
    expect(more.data.memory_stats).toEqual({ returned: 31, considered: 31, truncated: true });
  });
});

describe('project-evidence include_memories (#560)', () => {
  it("adds the project's memories without changing the evidence hash", async () => {
    const db = createTestDb();
    cleanup.push(() => db.close());
    seedProject(db);
    addMemory(db, { content: 'From the project note', evidence_node_id: 'p', created_at: '2026-10-01T00:00:00.000Z' });
    addMemory(db, { content: 'From the sync', evidence_node_id: 'n', created_at: '2026-10-04T00:00:00.000Z' });
    addMemory(db, { content: 'From the daily note', evidence_node_id: 'x' });
    const call = handler(server => registerProjectEvidence(server, db), 'project-evidence');

    const plain = await call({ project: 'Alpha' });
    expect(plain.data).not.toHaveProperty('memories');
    const res = await call({ project: 'Alpha', include_memories: true });
    expect(res.ok).toBe(true);
    expect(res.data.evidence_hash).toBe(plain.data.evidence_hash);
    expect(res.data.memories.map((m: { content: string; via: string }) => [m.content, m.via]))
      .toEqual([['From the project note', 'node'], ['From the sync', 'project']]);
    expect(res.data.memory_stats).toEqual({ returned: 2, considered: 2, truncated: false });
    expect(res.data).not.toHaveProperty('provenance_observations');

    const both = await call({ project: 'Alpha', include_memories: true, include_provenance: true });
    expect(both.data.memories).toHaveLength(2);
    expect(both.data.provenance_observations.nodes.p.source.native_id).toBe('p');
  });
});
