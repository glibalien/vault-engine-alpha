import { afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeRollupDb, projectViews } from '../helpers/rollup-fixture.js';
import { readRollups } from '../../src/rollups/service.js';
import { compileRollups } from '../../src/rollups/compile.js';
import { seedNode } from '../helpers/summary-fixture.js';
const dbs: Database.Database[] = [];
const fixture = () => {
  const db = makeRollupDb();
  dbs.push(db);
  return db;
};
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const read = (db: Database.Database, extra: Record<string, unknown> = {}) =>
  JSON.parse(
    readRollups(db, {
      schema: 'project',
      rollups: ['open_task_count', 'next_due_date'],
      ...extra,
    }).content[0].text,
  );
it('computes exact saved values independently of parent pagination and lookup caps', () => {
  const db = fixture(),
    before = db.serialize();
  expect(
    read(db).data.rows.map((r: { rollups: unknown }) => r.rollups),
  ).toEqual([
    { open_task_count: 2, next_due_date: '2026-09-18' },
    { open_task_count: 3, next_due_date: '2026-09-18' },
    { open_task_count: 0, next_due_date: null },
  ]);
  const r = read(db, {
    relations: [{ name: 'tasks', fields: ['status', 'due'], limit: 1 }],
    sort: { by: 'rollup', name: 'open_task_count', order: 'desc' },
    limit: 1,
  });
  expect(r.data.rows[0]).toMatchObject({
    node: { id: 'P2' },
    rollups: { open_task_count: 3 },
    relations: { tasks: { total: 3, returned: 1, truncated: true } },
  });
  expect(r.data.page.total).toBe(3);
  expect(r.data.rows[0]).not.toHaveProperty('fields');
  expect(r.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'RESULT_TRUNCATED',
        details: expect.objectContaining({ relation: 'tasks' }),
      }),
    ]),
  );
  expect(db.serialize()).toEqual(before);
});
it('packs equivalent selections but keeps unfiltered inverse lookups separate', () => {
  const db = fixture();
  const c = compileRollups(db, {
    schema: 'project',
    rollups: ['open_task_count', 'next_due_date'],
    relations: [{ name: 'tasks' }],
  });
  expect(c.summaryRequest.relations).toHaveLength(2);
  expect(c.summaryRequest.relations[0].metrics).toHaveLength(2);
});
it('reads fresh source state without changing parent versions', () => {
  const db = fixture();
  db.prepare(
    "UPDATE node_fields SET value_text='done' WHERE node_id='T2' AND field_name='status'",
  ).run();
  expect(read(db).data.rows[0].rollups).toEqual({
    open_task_count: 1,
    next_due_date: '2026-09-20',
  });
  expect(read(db).data.rows[1].rollups).toEqual({
    open_task_count: 2,
    next_due_date: null,
  });
});
it('keeps valid selections usable when an unselected definition loses its field', () => {
  const db = fixture();
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  expect(
    read(db, { rollups: ['open_task_count'] }).data.rows[0].rollups
      .open_task_count,
  ).toBe(2);
  expect(() => read(db)).toThrowError(
    expect.objectContaining({
      code: 'VALIDATION_FAILED',
      details: expect.objectContaining({ reason: 'INVALID_ROLLUP_DEFINITION' }),
    }),
  );
});
it.each([
  { rollups: [] },
  { rollups: ['unknown'] },
  { rollups: ['open_task_count', 'open_task_count'] },
  { filter: { without_types: ['project'] } },
  { sort: { by: 'rollup', name: 'not_selected', order: 'asc' } },
  { relations: [{ name: 'unknown' }] },
  { schema: 'unknown' },
  { extra: true },
])('rejects invalid selections %j', (args) => {
  expect(() => read(fixture(), args)).toThrow();
});
it('intersects additional parent types with the owning schema', () => {
  const db = fixture();
  expect(read(db, { filter: { types: ['task'] } }).data.rows).toEqual([]);
});
it('rejects too many independently filtered compiled relations', () => {
  const db = fixture(),
    base = projectViews(),
    views = {
      ...base,
      rollups: Array.from({ length: 5 }, (_, i) => ({
        ...base.rollups[0],
        name: `count${i}`,
        filter: { fields: { status: { eq: `status${i}` } } },
      })),
    };
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
    JSON.stringify({ relationship_views_v1: views }),
  );
  expect(() =>
    read(db, { rollups: views.rollups.map((r) => r.name) }),
  ).toThrow();
});

it('reports invalid off-page values using saved names without leaking stored content', () => {
  const db = fixture();
  db.prepare(
    "UPDATE node_fields SET value_text='PRIVATE INVALID' WHERE node_id='T2' AND field_name='due'",
  ).run();
  try {
    read(db, { limit: 1, offset: 2 });
    throw Error('expected validation');
  } catch (e) {
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: expect.objectContaining({
        rollups: ['next_due_date'],
        field: 'due',
      }),
    });
    expect(JSON.stringify(e)).not.toContain('PRIVATE INVALID');
  }
});
it('counts duplicate spellings once and excludes body links', () => {
  const db = fixture();
  db.prepare(
    "INSERT INTO relationships(source_id,target,resolved_target_id,rel_type) VALUES ('T1','alias','P1','project'),('T5','P1','P1','wiki-link')",
  ).run();
  expect(read(db).data.rows[0].rollups.open_task_count).toBe(2);
});
it('enforces the shared raw row budget before deduplicating aliases', () => {
  const db = fixture();
  db.transaction(() => {
    const insert = db.prepare(
      "INSERT INTO relationships(source_id,target,resolved_target_id,rel_type) VALUES ('T1',?,'P1','project')",
    );
    for (let i = 0; i < 50000; i++) insert.run(`alias${i}`);
  })();
  expect(() => read(db, { relations: [{ name: 'tasks' }] })).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({
        stage: 'relationships',
        reason: 'QUERY_LIMIT_EXCEEDED',
      }),
    }),
  );
  expect(read(db).data.rows[0].rollups.open_task_count).toBe(2);
});
it('allows packed rollups up to the public byte limit regardless of intermediate size', () => {
  const db = fixture();
  for (let i = 4; i <= 100; i++) seedNode(db, `P${i}`, ['project']);
  const names = Array.from({ length: 8 }, (_, i) => `c${i}`);
  const views = {
    ...projectViews(),
    rollups: names.map(name => ({ name, relation: 'tasks', metric: { op: 'count' } })),
  };
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
    JSON.stringify({ relationship_views_v1: views }),
  );
  const request = { schema: 'project', rollups: names, limit: 100 };
  const initial = Buffer.byteLength(readRollups(db, request).content[0].text);
  db.prepare("UPDATE nodes SET title=? WHERE id='P1'").run('x'.repeat(1048576 - initial + 2));
  const before = db.serialize();
  const result = readRollups(db, request);
  expect(Buffer.byteLength(result.content[0].text)).toBe(1048576);
  const envelope = JSON.parse(result.content[0].text);
  expect(envelope.ok).toBe(true);
  expect(envelope.data.rows).toHaveLength(100);
  expect(envelope.data.rows.find((r: { node: { id: string } }) => r.node.id === 'P1').rollups).toEqual({
    c0: 3, c1: 3, c2: 3, c3: 3, c4: 3, c5: 3, c6: 3, c7: 3,
  });
  expect(db.serialize().equals(before)).toBe(true);
  db.prepare("UPDATE nodes SET title=title||'x' WHERE id='P1'").run();
  expect(() => readRollups(db, request)).toThrow(expect.objectContaining({
    code: 'INVALID_PARAMS',
    details: expect.objectContaining({ stage: 'response_bytes', limit: 1048576, observed_at_least: 1048577 }),
  }));
});
it('bounds the final envelope including saved-definition descriptions', () => {
  const db = fixture(),
    original = projectViews(),
    base = {
      ...original,
      rollups: original.rollups.map((r) => ({
        ...r,
        description: 'x'.repeat(1024),
      })),
    };
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
    JSON.stringify({ relationship_views_v1: base }),
  );
  const request = {
    schema: 'project',
    rollups: ['open_task_count', 'next_due_date'],
  };
  const initial = Buffer.byteLength(readRollups(db, request).content[0].text);
  db.prepare("UPDATE nodes SET title=? WHERE id='P1'").run(
    'x'.repeat(1048576 - initial + 2),
  );
  expect(Buffer.byteLength(readRollups(db, request).content[0].text)).toBe(
    1048576,
  );
  db.prepare("UPDATE nodes SET title=title||'x' WHERE id='P1'").run();
  expect(() => readRollups(db, request)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({
        stage: 'response_bytes',
        limit: 1048576,
        observed_at_least: 1048577,
      }),
    }),
  );
});
it.each([
  { limit: 101 },
  { offset: 10001 },
  { relations: [{ name: 'tasks', limit: 11 }] },
  { relations: [{ name: 'tasks', fields: Array(6).fill('status') }] },
  { filter: { title_contains: 'x'.repeat(65536) } },
])('bounds saved read arguments %j', (extra) => {
  expect(() => read(fixture(), extra)).toThrow(
    expect.objectContaining({ code: 'INVALID_PARAMS' }),
  );
});
it('rejects parent populations over 10000 without returning a partial page', () => {
  const db = fixture();
  db.transaction(() => {
    const node = db.prepare('INSERT INTO nodes(id,file_path) VALUES (?,?)'),
      type = db.prepare(
        "INSERT INTO node_types(node_id,schema_type) VALUES (?,'project')",
      );
    for (let i = 0; i < 9998; i++) {
      node.run(`X${i}`, `X${i}.md`);
      type.run(`X${i}`);
    }
  })();
  expect(() => read(db)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({
        stage: 'parents',
        limit: 10000,
        observed_at_least: 10001,
      }),
    }),
  );
});
it('shares repeated inverse projections across distinct saved names', () => {
  const db = fixture(),
    base = projectViews(),
    views = {
      ...base,
      relations: ['tasks', 'others', 'again', 'last'].map((name) => ({
        ...base.relations[0],
        name,
      })),
    };
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
    JSON.stringify({ relationship_views_v1: views }),
  );
  const request = {
    schema: 'project',
    rollups: ['open_task_count'],
    relations: [
      { name: 'tasks', fields: ['status'] },
      { name: 'others', fields: ['due'] },
      { name: 'again', fields: ['due'] },
      { name: 'last', fields: ['due'] },
    ],
  };
  expect(compileRollups(db, request).summaryRequest.relations).toHaveLength(3);
  const result = JSON.parse(readRollups(db, request).content[0].text);
  expect(result.data.rows[0].relations.others).toEqual(
    result.data.rows[0].relations.last,
  );
});
