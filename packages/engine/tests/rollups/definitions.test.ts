import { expect, it } from 'vitest';
import {
  describeRelationshipViews,
  parseRelationshipViews,
  relationshipViewsHash,
} from '../../src/rollups/definitions.js';
import { makeRollupDb, projectViews } from '../helpers/rollup-fixture.js';
it('hashes object content canonically without discarding array order or absence', () => {
  expect(relationshipViewsHash({ a: 1, b: 2 })).toBe(
    relationshipViewsHash({ b: 2, a: 1 }),
  );
  expect(relationshipViewsHash([1, 2])).not.toBe(relationshipViewsHash([2, 1]));
  expect(relationshipViewsHash(undefined)).not.toBe(
    relationshipViewsHash(null),
  );
  expect(relationshipViewsHash(JSON.parse('{"__proto__":1}'))).not.toBe(
    relationshipViewsHash({}),
  );
});
it('discovers typed non-editable saved values and marks missing dependencies invalid', () => {
  const db = makeRollupDb();
  try {
    const d = describeRelationshipViews(db, 'project');
    expect(
      d.rollups.map((r) => [r.definition.name, r.state, r.type, r.nullable]),
    ).toEqual([
      ['open_task_count', 'valid', 'integer', false],
      ['next_due_date', 'valid', 'date', true],
    ]);
    db.prepare("DELETE FROM global_fields WHERE name='due'").run();
    expect(
      describeRelationshipViews(db, 'project').rollups.map((r) => r.state),
    ).toEqual(['valid', 'invalid']);
  } finally {
    db.close();
  }
});
it.each([
  { ...projectViews(), version: 2 },
  { ...projectViews(), extra: 1 },
  {
    ...projectViews(),
    relations: [...projectViews().relations, ...projectViews().relations],
  },
  {
    ...projectViews(),
    rollups: [{ ...projectViews().rollups[0], name: 'constructor' }],
  },
  {
    ...projectViews(),
    relations: [
      {
        ...projectViews().relations[0],
        filter: { fields: { status: { eq: 'open' } } },
      },
    ],
  },
  {
    ...projectViews(),
    rollups: [{ ...projectViews().rollups[0], filter: { types: ['task'] } }],
  },
  {
    ...projectViews(),
    rollups: [
      {
        ...projectViews().rollups[0],
        metric: { op: 'sum', field: 'estimate' },
      },
    ],
  },
])('rejects unsupported definitions %j', (value) => {
  expect(() => parseRelationshipViews(value)).toThrow();
});
it('reports absent and unsupported namespaces without modifying storage', () => {
  const db = makeRollupDb();
  try {
    expect(describeRelationshipViews(db, 'task').state).toBe('absent');
    db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
      JSON.stringify({ relationship_views_v1: { version: 99 } }),
    );
    expect(describeRelationshipViews(db, 'project').state).toBe('unsupported');
  } finally {
    db.close();
  }
});

it('bounds definition counts and total serialized metadata', () => {
  const base = projectViews();
  const relations = Array.from({ length: 16 }, (_, i) => ({
    ...base.relations[0],
    name: `r${i}`,
  }));
  const rollups = Array.from({ length: 32 }, (_, i) => ({
    ...base.rollups[0],
    relation: 'r0',
    name: `c${i}`,
  }));
  expect(() =>
    parseRelationshipViews({ version: 1, relations, rollups }),
  ).not.toThrow();
  expect(() =>
    parseRelationshipViews({
      version: 1,
      relations: [...relations, { ...relations[0], name: 'extra' }],
      rollups,
    }),
  ).toThrow();
  expect(() =>
    parseRelationshipViews({
      version: 1,
      relations,
      rollups: [...rollups, { ...rollups[0], name: 'extra' }],
    }),
  ).toThrow();
  expect(() =>
    parseRelationshipViews({
      version: 1,
      relations: relations.map((r) => ({
        ...r,
        label: 'x'.repeat(1024),
        description: 'x'.repeat(1024),
      })),
      rollups: rollups.map((r) => ({
        ...r,
        label: 'x'.repeat(1024),
        description: 'x'.repeat(1024),
      })),
    }),
  ).toThrow('64 KiB');
});

it.each([
  {},
  [],
  { version: null },
  { version: '1' },
  { version: true },
  { version: 0 },
  { version: -1 },
  { version: 1.5 },
  { version: Number.MAX_SAFE_INTEGER + 1 },
  { version: 1 },
])('reports malformed stored versions as invalid: %j', (raw) => {
  const db = makeRollupDb();
  try {
    db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
      JSON.stringify({ relationship_views_v1: raw }),
    );
    const before = db.serialize();
    expect(describeRelationshipViews(db, 'project').state).toBe('invalid');
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
it.each([2, 99])(
  'keeps recognizable future version %i unsupported',
  (version) => {
    const db = makeRollupDb();
    try {
      db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
        JSON.stringify({ relationship_views_v1: { version } }),
      );
      expect(describeRelationshipViews(db, 'project').state).toBe(
        'unsupported',
      );
    } finally {
      db.close();
    }
  },
);
