import { afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeTraversalDb } from '../helpers/traversal-fixture.js';
import { seedNode, seedRel } from '../helpers/summary-fixture.js';
import { traverseNodes } from '../../src/traversal/service.js';
const dbs: Database.Database[] = [];
const fixture = () => {
  const db = makeTraversalDb([], ['A']);
  dbs.push(db);
  return db;
};
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const read = (db: Database.Database, extra: Record<string, unknown> = {}) =>
  JSON.parse(
    traverseNodes(db, {
      root_id: 'A',
      field: 'blockedBy',
      direction: 'outgoing',
      ...extra,
    }).content[0].text,
  );
it('accepts 500 nodes including root and fails on node 501', () => {
  const db = fixture();
  for (let i = 0; i < 500; i++) {
    seedNode(db, `N${i}`, ['task']);
    if (i < 499) seedRel(db, 'A', `N${i}`, `N${i}`, 'blockedBy');
  }
  expect(read(db).data.nodes).toHaveLength(500);
  seedRel(db, 'A', 'N499', 'N499', 'blockedBy');
  expect(() => read(db)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({
        stage: 'nodes',
        observed_at_least: 501,
      }),
    }),
  );
});
it('counts raw aliases before deduplication and fails on row 10001', () => {
  const db = fixture();
  seedNode(db, 'B', ['task']);
  db.transaction(() => {
    for (let i = 0; i < 10000; i++)
      seedRel(db, 'A', `alias${i}`, 'B', 'blockedBy');
  })();
  expect(read(db).data.stats).toEqual({
    returned_nodes: 2,
    returned_edges: 1,
    raw_rows_examined: 10000,
  });
  seedRel(db, 'A', 'extra', 'B', 'blockedBy');
  expect(() => read(db)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ stage: 'relationships' }),
    }),
  );
});
it('counts dangling resolved rows against the raw budget without consuming the node budget', () => {
  const db = fixture();
  db.pragma('foreign_keys=OFF');
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) seedRel(db, 'A', `alias${i}`, `missing${i}`, 'blockedBy');
  })();
  db.pragma('foreign_keys=ON');
  const result = read(db);
  expect(result.data.stats).toEqual({ returned_nodes: 1, returned_edges: 0, raw_rows_examined: 10000 });
  expect(result.data.unresolved.raw_count).toBe(10000);
  db.pragma('foreign_keys=OFF');
  seedRel(db, 'A', 'extra', 'missing-extra', 'blockedBy');
  db.pragma('foreign_keys=ON');
  expect(() => read(db)).toThrowError(expect.objectContaining({ details: expect.objectContaining({ stage: 'relationships' }) }));
});
it('accepts 2000 logical edges and rejects the next despite bounded nodes', () => {
  const db = fixture();
  const ids = Array.from(
    { length: 45 },
    (_, i) => `N${String(i).padStart(2, '0')}`,
  );
  for (const id of ids) {
    seedNode(db, id, ['task']);
    seedRel(db, 'A', id, id, 'blockedBy');
  }
  let count = ids.length;
  let extra: [string, string] | undefined;
  db.transaction(() => {
    for (const s of ids)
      for (const t of ids) {
        if (count < 2000) {
          seedRel(db, s, t, t, 'blockedBy');
          count++;
        } else extra ??= [s, t];
      }
  })();
  expect(read(db).data.edges).toHaveLength(2000);
  seedRel(db, extra![0], extra![1], extra![1], 'blockedBy');
  expect(() => read(db)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ stage: 'edges' }),
    }),
  );
});
it('bounds the actual UTF-8 success envelope including values and warnings', () => {
  const db = fixture();
  db.prepare(
    "INSERT INTO node_fields (node_id,field_name,value_text) VALUES ('A','label','')",
  ).run();
  const args = {
    root_id: 'A',
    field: 'blockedBy',
    direction: 'outgoing',
    include_fields: ['label'],
  };
  const empty = traverseNodes(db, args).content[0].text;
  const fill = 1048576 - Buffer.byteLength(empty);
  db.prepare(
    "UPDATE node_fields SET value_text=? WHERE node_id='A' AND field_name='label'",
  ).run('x'.repeat(fill));
  expect(Buffer.byteLength(traverseNodes(db, args).content[0].text)).toBe(
    1048576,
  );
  db.prepare(
    "UPDATE node_fields SET value_text=value_text || 'x' WHERE node_id='A' AND field_name='label'",
  ).run();
  expect(() => traverseNodes(db, args)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ stage: 'response_bytes' }),
    }),
  );
});
