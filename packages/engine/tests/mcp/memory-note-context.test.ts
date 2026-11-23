import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { makeMemoriesServer, callTool } from './memories.test.js';
import type { Embedder } from '../../src/search/embedder.js';
import { buildUserPrompt, noteLabel, type ConsolidationInput, type MemoryConsolidator } from '../../src/mcp/tools/memory-consolidation.js';
import { memoryNoteContext } from '../../src/memories/service.js';

function vec(x0: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = x0;
  v[1] = Math.sqrt(Math.max(0, 1 - x0 * x0));
  return v;
}

function embedder(map: Record<string, Float32Array>): Embedder {
  return { isReady: () => true, embedQuery: async (text: string) => map[text] ?? vec(0), embedDocument: async (text: string) => [map[text] ?? vec(0)] };
}

/** Two projects, a meeting filed under one of them by its field and under the other by a body
 *  link, a daily note filed under nothing. */
function seed(db: Database.Database): void {
  const node = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)');
  const type = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  const rel = db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)');
  node.run('p-acme', 'Projects/Acme Pilot.md', 'Acme Pilot', '', 'hp1');
  node.run('p-zen', 'Projects/Zenith Rollout.md', 'Zenith Rollout', '', 'hp2');
  type.run('p-acme', 'project');
  type.run('p-zen', 'project');
  node.run('m1', 'Meetings/Acme sync.md', 'Acme sync', 'Body mentions [[Zenith Rollout]].', 'hm1');
  type.run('m1', 'meeting');
  db.prepare("INSERT INTO node_fields (node_id, field_name, value_date) VALUES ('m1', 'date', '2026-10-05')").run();
  rel.run('m1', 'Acme Pilot', 'project', 'p-acme');
  rel.run('m1', 'Zenith Rollout', 'wiki-link', 'p-zen');
  node.run('d1', 'Daily/2026-10-20.md', '2026-10-20', 'Daily.', 'hd1');
}

describe("a memory's source note, for merge decisions (#352)", () => {
  it('names the note, its date and the projects it links to from a field or its body', () => {
    const { db } = makeMemoriesServer();
    seed(db);
    // A body link files a note under a project, as it makes the note evidence for that project's wiki (#453).
    expect(memoryNoteContext(db, 'm1')).toEqual({ title: 'Acme sync', date: '2026-10-05', projects: ['Acme Pilot', 'Zenith Rollout'] });
    expect(memoryNoteContext(db, 'p-acme')).toEqual({ title: 'Acme Pilot', date: null, projects: ['Acme Pilot'] });
    expect(memoryNoteContext(db, 'd1')).toEqual({ title: '2026-10-20', date: '2026-10-20', projects: [] });
    expect(memoryNoteContext(db, null)).toBeNull();
    expect(memoryNoteContext(db, 'missing')).toBeNull();
    db.close();
  });

  it('lists the projects a field links to before those only linked in the body, within the cap of five', () => {
    const { db } = makeMemoriesServer();
    const node = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)');
    const type = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
    const rel = db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)');
    node.run('n1', 'Notes/Roundup.md', 'Roundup', '', 'hn1');
    for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Yankee']) {
      node.run(`p-${title}`, `Projects/${title}.md`, title, '', `h-${title}`);
      type.run(`p-${title}`, 'project');
    }
    rel.run('n1', 'Yankee', 'project', 'p-Yankee');
    for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) rel.run('n1', title, 'wiki-link', `p-${title}`);
    // Linked from both a field and the body: it counts as filed by the field, once.
    rel.run('n1', 'Echo', 'related', 'p-Echo');
    expect(memoryNoteContext(db, 'n1')?.projects).toEqual(['Echo', 'Yankee', 'Alpha', 'Bravo', 'Charlie']);
    db.close();
  });

  it('shows each memory with its note, and tells the model different contexts are different facts', () => {
    const input: ConsolidationInput = {
      content: 'The headcount is 40.', category: 'fact', note: { title: 'Acme sync', date: '2026-10-05', projects: ['Acme Pilot'] },
      candidates: [
        { id: 7, content: 'The headcount is 55.', category: 'fact', valid_at: null, distance: 0.2,
          note: { title: 'Zenith kickoff', date: '2026-09-01', projects: ['Zenith Rollout', 'Acme Pilot'] } },
        { id: 8, content: 'Chat fact.', category: null, valid_at: null, distance: 0.3 },
      ],
    };
    const prompt = buildUserPrompt(input);
    expect(prompt).toContain('NEW [fact] (from note "Acme sync", 2026-10-05, filed under Acme Pilot): The headcount is 40.');
    expect(prompt).toContain('- id=7 [fact] (valid_at=unknown; from note "Zenith kickoff", 2026-09-01, filed under Zenith Rollout, Acme Pilot): The headcount is 55.');
    expect(prompt).toContain('- id=8 (valid_at=unknown; no source note): Chat fact.');
    expect(noteLabel({ title: 'Untitled "x"', date: null, projects: [] })).toBe('from note "Untitled \\"x\\""');
  });

  it("sends the consolidator the new memory's note and each candidate's", async () => {
    const seen: ConsolidationInput[] = [];
    const consolidator: MemoryConsolidator = { async consolidate(input) { seen.push(input); return { operation: 'add', reason: 'distinct' }; } };
    const { server, db } = makeMemoriesServer({ embedder: embedder({ first: vec(1), second: vec(0.8) }), consolidator });
    seed(db);
    await callTool(server, 'create-memory', { evidence: { kind: 'note', node_id: 'm1', hash: 'hm1' }, source: 'curator', content: 'first' });
    await callTool(server, 'create-memory', { evidence: { kind: 'note', node_id: 'd1', hash: 'hd1' }, source: 'curator', content: 'second' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.note).toEqual({ title: '2026-10-20', date: '2026-10-20', projects: [] });
    expect(seen[0]!.candidates.map(c => c.note)).toEqual([{ title: 'Acme sync', date: '2026-10-05', projects: ['Acme Pilot', 'Zenith Rollout'] }]);
    db.close();
  });

  it('gives near pairs their notes, for nightly reconcile', async () => {
    const consolidator: MemoryConsolidator = { async consolidate() { return { operation: 'add', reason: 'distinct' }; } };
    const { server, db } = makeMemoriesServer({ embedder: embedder({ first: vec(1), second: vec(0.8) }), consolidator });
    seed(db);
    await callTool(server, 'create-memory', { evidence: { kind: 'note', node_id: 'm1', hash: 'hm1' }, source: 'curator', content: 'first' });
    await callTool(server, 'create-memory', { evidence: { kind: 'conversation', ref: 'c#1' }, source: 'curator', content: 'second' });
    const res = await callTool(server, 'list-memory-near-pairs', { near: 0.01, far: 0.9 });
    const members = res.data.pairs.flatMap((pair: { a: Record<string, unknown>; b: Record<string, unknown> }) => [pair.a, pair.b]);
    expect(members.find((m: Record<string, unknown>) => m.content === 'first')).toMatchObject(
      { note_title: 'Acme sync', note_date: '2026-10-05', note_projects: ['Acme Pilot', 'Zenith Rollout'] });
    expect(members.find((m: Record<string, unknown>) => m.content === 'second')).toMatchObject(
      { note_title: null, note_date: null, note_projects: [] });
    db.close();
  });
});

describe("a project's memory set (#352)", () => {
  it('lists memories drawn from the project or from notes filed under it, for any node filed under it', async () => {
    const { server, db } = makeMemoriesServer();
    seed(db);
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('z1', 'Meetings/Zenith call.md', 'Zenith call', '', 'hz1')").run();
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('z1', 'Zenith Rollout', 'project', 'p-zen')").run();
    const make = (content: string, evidence: Record<string, unknown>, source = 'curator') =>
      callTool(server, 'create-memory', { evidence, source, content });
    await make('Acme meeting fact', { kind: 'note', node_id: 'm1', hash: 'hm1' });
    await make('Acme project note fact', { kind: 'note', node_id: 'p-acme', hash: 'hp1' });
    await make('Zenith fact', { kind: 'note', node_id: 'z1', hash: 'hz1' });
    await make('Daily fact', { kind: 'note', node_id: 'd1', hash: 'hd1' });
    await make('Chat fact', { kind: 'conversation', ref: 'c#1' }, 'claude');
    const contents = async (projectOf: string) =>
      ((await callTool(server, 'list-memories', { project_of: projectOf })).data.memories as Array<{ content: string }>).map(m => m.content).sort();
    expect(await contents('p-acme')).toEqual(['Acme meeting fact', 'Acme project note fact']);
    // The Acme meeting links Zenith only in its body. That files it under Zenith too, as it makes the
    // meeting evidence for Zenith's wiki (#453): its memories join Zenith's set, and it gets both sets.
    expect(await contents('p-zen')).toEqual(['Acme meeting fact', 'Zenith fact']);
    expect(await contents('z1')).toEqual(['Acme meeting fact', 'Zenith fact']);
    expect(await contents('m1')).toEqual(['Acme meeting fact', 'Acme project note fact', 'Zenith fact']);
    expect(await contents('d1')).toEqual([]);
    expect(await contents('missing')).toEqual([]);
    db.close();
  });
});

describe("a project's memory set, most specific first (#352)", () => {
  it("lists the project's own note first, then notes filed under fewer projects, counting body links", async () => {
    const { server, db } = makeMemoriesServer();
    seed(db);
    const node = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)');
    const rel = db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)');
    node.run('p-orb', 'Projects/Orbit Launch.md', 'Orbit Launch', '', 'hp3');
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('p-orb', 'project')").run();
    // The project note mentions two other projects in its body; it is still the project's own note.
    rel.run('p-acme', 'Zenith Rollout', 'wiki-link', 'p-zen');
    rel.run('p-acme', 'Orbit Launch', 'wiki-link', 'p-orb');
    // A summary filed under Acme by its field that mentions two more projects in its body: three in all,
    // against the Acme meeting's two (Acme by field, Zenith by body link).
    node.run('s1', 'Summaries/Weekly.md', 'Weekly summary', '', 'hs1');
    rel.run('s1', 'Acme Pilot', 'project', 'p-acme');
    rel.run('s1', 'Zenith Rollout', 'wiki-link', 'p-zen');
    rel.run('s1', 'Orbit Launch', 'wiki-link', 'p-orb');
    const make = async (content: string, node: string, hash: string, createdAt: string) => {
      await callTool(server, 'create-memory', { evidence: { kind: 'note', node_id: node, hash }, source: 'curator', content });
      // Newest first reads when each became true (#706), so both dates are set.
      db.prepare('UPDATE memories SET created_at = ?, valid_at = ? WHERE content = ?').run(createdAt, createdAt, content);
    };
    // Oldest first, so newest-first alone would give the reverse order.
    await make('Acme project note fact', 'p-acme', 'hp1', '2026-10-01T00:00:00.000Z');
    await make('Acme meeting fact', 'm1', 'hm1', '2026-10-02T00:00:00.000Z');
    await make('Shared summary fact', 's1', 'hs1', '2026-10-03T00:00:00.000Z');
    const listed = async (args: Record<string, unknown>) =>
      ((await callTool(server, 'list-memories', args)).data.memories as Array<{ content: string }>).map(m => m.content);
    expect(await listed({ project_of: 'p-acme' })).toEqual(['Acme project note fact', 'Acme meeting fact', 'Shared summary fact']);
    expect(await listed({ project_of: 'p-acme', limit: 2 })).toEqual(['Acme project note fact', 'Acme meeting fact']);
    // Without project_of, newest first.
    expect(await listed({})).toEqual(['Shared summary fact', 'Acme meeting fact', 'Acme project note fact']);
    db.close();
  });
});
