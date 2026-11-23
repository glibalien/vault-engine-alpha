import { afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeTraversalDb } from '../helpers/traversal-fixture.js';
import { seedRel } from '../helpers/summary-fixture.js';
import { traverseNodes } from '../../src/traversal/service.js';
const databases: Database.Database[] = [];
const fixture = (pairs: Array<[string, string]>, extra: string[] = []) => {
  const db = makeTraversalDb(pairs, extra);
  databases.push(db);
  return db;
};
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const read = (db: Database.Database, args: Record<string, unknown> = {}) =>
  JSON.parse(
    traverseNodes(db, {
      root_id: 'A',
      field: 'blockedBy',
      direction: 'outgoing',
      ...args,
    }).content[0].text,
  );
it('diagnoses dangling resolved targets while returning the valid reachable graph without writes', () => {
  const db = fixture([['A', 'B'], ['B', 'C']]);
  db.pragma('foreign_keys=OFF');
  seedRel(db, 'A', 'missing alias 1', 'missing', 'blockedBy');
  seedRel(db, 'A', 'missing alias 2', 'missing', 'blockedBy');
  db.pragma('foreign_keys=ON');
  const before = db.serialize();
  const result = read(db);
  expect(result.ok).toBe(true);
  expect(result.data.nodes.map((n: { id: string }) => n.id)).toEqual(['A', 'B', 'C']);
  expect(result.data.edges).toEqual([
    { source_id: 'A', target_id: 'B', field: 'blockedBy' },
    { source_id: 'B', target_id: 'C', field: 'blockedBy' },
  ]);
  expect(result.data.unresolved).toEqual({ scope: 'expanded_sources', raw_count: 2, source_ids: ['A'] });
  expect(result.data.stats).toEqual({ returned_nodes: 3, returned_edges: 2, raw_rows_examined: 4 });
  expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'CROSS_NODE_FILTER_UNRESOLVED' }));
  expect(result.data.resolved_reachability_complete).toBe(true);
  expect(db.serialize().equals(before)).toBe(true);
});
it('includes dangling resolved targets in incoming vault-wide unresolved diagnostics', () => {
  const db = fixture([['A', 'B']], ['C']);
  db.pragma('foreign_keys=OFF');
  seedRel(db, 'C', 'Missing', 'missing', 'blockedBy');
  db.pragma('foreign_keys=ON');
  const result = read(db, { root_id: 'B', direction: 'incoming' });
  expect(result.data.nodes.map((n: { id: string }) => n.id)).toEqual(['B', 'A']);
  expect(result.data.unresolved).toEqual({ scope: 'vault_rel_type', exists: true });
  expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'CROSS_NODE_FILTER_UNRESOLVED' }));
});
it('does not inspect dangling references beyond the outgoing depth boundary', () => {
  const db = fixture([['A', 'B']]);
  db.pragma('foreign_keys=OFF');
  seedRel(db, 'B', 'Missing', 'missing', 'blockedBy');
  db.pragma('foreign_keys=ON');
  expect(read(db, { max_depth: 1 }).data.unresolved.raw_count).toBe(0);
  const expanded = read(db, { max_depth: 2 });
  expect(expanded.data.unresolved).toEqual({ scope: 'expanded_sources', raw_count: 1, source_ids: ['B'] });
  expect(expanded.data.boundary.depth_limited).toBe(false);
});
it.each([
  {
    pairs: [
      ['A', 'B'],
      ['B', 'C'],
    ],
    depth: 1,
    nodes: [
      ['A', 0],
      ['B', 1],
    ],
    edges: 1,
    boundary: ['B'],
    cycles: [],
  },
  {
    pairs: [
      ['A', 'B'],
      ['B', 'C'],
    ],
    depth: 3,
    nodes: [
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ],
    edges: 2,
    boundary: [],
    cycles: [],
  },
  {
    pairs: [
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'D'],
      ['C', 'D'],
    ],
    depth: 3,
    nodes: [
      ['A', 0],
      ['B', 1],
      ['C', 1],
      ['D', 2],
    ],
    edges: 4,
    boundary: [],
    cycles: [],
  },
  {
    pairs: [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
    ],
    depth: 3,
    nodes: [
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ],
    edges: 3,
    boundary: [],
    cycles: [['A', 'B', 'C']],
  },
  {
    pairs: [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
    ],
    depth: 2,
    nodes: [
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ],
    edges: 2,
    boundary: ['C'],
    cycles: [],
  },
  {
    pairs: [['A', 'A']],
    depth: 3,
    nodes: [['A', 0]],
    edges: 1,
    boundary: [],
    cycles: [['A']],
  },
  {
    pairs: [],
    depth: 3,
    nodes: [['A', 0]],
    edges: 0,
    boundary: [],
    cycles: [],
  },
])('returns the hand-checked graph %j', (c) => {
  const db = fixture(c.pairs as Array<[string, string]>, ['A']);
  const r = read(db, { max_depth: c.depth });
  expect(r.ok).toBe(true);
  expect(
    r.data.nodes.map((n: { id: string; depth: number }) => [n.id, n.depth]),
  ).toEqual(c.nodes);
  expect(r.data.edges).toHaveLength(c.edges);
  expect(r.data.boundary.unexpanded_node_ids).toEqual(c.boundary);
  expect(r.data.resolved_reachability_complete).toBe(c.boundary.length === 0);
  expect(r.data.cycles).toEqual({
    scope: 'returned_edges',
    components: c.cycles,
  });
});
it('walks incoming dependencies while retaining original edge orientation', () => {
  const r = read(
    fixture([
      ['A', 'B'],
      ['B', 'C'],
    ]),
    {
      root_id: 'C',
      direction: 'incoming',
      max_depth: 3,
      include_fields: ['status', 'due'],
    },
  );
  expect(
    r.data.nodes.map((n: { id: string; depth: number }) => [n.id, n.depth]),
  ).toEqual([
    ['C', 0],
    ['B', 1],
    ['A', 2],
  ]);
  expect(r.data.edges).toEqual([
    { source_id: 'A', target_id: 'B', field: 'blockedBy' },
    { source_id: 'B', target_id: 'C', field: 'blockedBy' },
  ]);
  expect(r.data.nodes[0].fields).toEqual({ status: 'done', due: null });
});
it('deduplicates resolved spellings, excludes prose and scopes outgoing unresolved rows', () => {
  const db = fixture([['A', 'B']], ['C']);
  seedRel(db, 'A', 'AliasB', 'B', 'blockedBy');
  seedRel(db, 'A', 'C', 'C', 'wiki-link');
  seedRel(db, 'A', 'Missing', null, 'blockedBy');
  seedRel(db, 'C', 'OtherMissing', null, 'blockedBy');
  const r = read(db);
  expect(r.data.edges).toHaveLength(1);
  expect(r.data.stats.raw_rows_examined).toBe(3);
  expect(r.data.unresolved).toEqual({
    scope: 'expanded_sources',
    raw_count: 1,
    source_ids: ['A'],
  });
  expect(r.warnings[0]).toMatchObject({
    code: 'CROSS_NODE_FILTER_UNRESOLVED',
    details: { scope: 'expanded_sources' },
  });
  const incoming = read(db, { root_id: 'B', direction: 'incoming' });
  expect(incoming.data.unresolved).toEqual({
    scope: 'vault_rel_type',
    exists: true,
  });
});
it('preserves rename identity, dangling deletion, null and absence without read writes', () => {
  const db = fixture([['A', 'B']]);
  db.prepare(
    "UPDATE nodes SET title='Renamed',file_path='Elsewhere.md' WHERE id='B'",
  ).run();
  const before = db.prepare('SELECT total_changes() AS n').get();
  const r = read(db, { include_fields: ['due', 'label'] });
  expect(r.data.nodes[1]).toMatchObject({
    id: 'B',
    title: 'Renamed',
    file_path: 'Elsewhere.md',
    fields: { due: null },
  });
  expect(r.data.nodes[1].fields).not.toHaveProperty('label');
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  db.prepare("DELETE FROM nodes WHERE id='B'").run();
  expect(read(db).data.unresolved.raw_count).toBe(1);
});
it.each([
  { root_id: 'missing' },
  { field: 'status' },
  { field: 'missing' },
  { field: 'wiki-link' },
  { include_fields: ['project'] },
  { include_fields: ['unknown'] },
])('rejects invalid identities or field semantics %j', (args) => {
  expect(() => read(fixture([], ['A']), args)).toThrow();
});
it('rejects malformed selected scalars instead of dropping or coercing them', () => {
  const db = fixture([['A', 'B']]);
  db.prepare(
    "INSERT INTO node_fields (node_id,field_name,value_json) VALUES ('A','flag','[')",
  ).run();
  expect(() => read(db, { include_fields: ['flag'] })).toThrowError(
    expect.objectContaining({
      code: 'VALIDATION_FAILED',
      details: expect.objectContaining({ reason: 'INVALID_LOOKUP_VALUE' }),
    }),
  );
});
