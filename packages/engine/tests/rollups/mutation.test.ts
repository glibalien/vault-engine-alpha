import { afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { normalizeRelationshipViewsMutation } from '../../src/rollups/mutation.js';
import {
  namespace,
  relationshipViewsHash,
} from '../../src/rollups/definitions.js';
import { makeSummaryDb } from '../helpers/summary-fixture.js';
import { projectViews } from '../helpers/rollup-fixture.js';
import {
  createSchemaDefinition,
  updateSchemaDefinition,
  patchSchemaDefinition,
} from '../../src/schema/crud.js';
const dbs: Database.Database[] = [];
const fixture = () => {
  const db = makeSummaryDb();
  dbs.push(db);
  return db;
};
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
it('honors explicit metadata replacement when removing definitions and still guards attaching them', () => {
  const db = fixture();
  const views = projectViews();
  const current = { other: 1, relationship_views_v1: views };
  for (const metadata of ['replacement', 0, false, ['replacement'], null, { other: 2 }]) {
    const input = {
      metadata, relationship_views: null,
      expected_relationship_views_hash: relationshipViewsHash(views),
    };
    expect(normalizeRelationshipViewsMutation(db, current, input)).toEqual(metadata);
    expect(() => normalizeRelationshipViewsMutation(db, current, { ...input, expected_relationship_views_hash: 'stale' }))
      .toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  }
  for (const metadata of ['legacy', 0, false, ['legacy']]) {
    expect(() => normalizeRelationshipViewsMutation(db, metadata, {
      relationship_views: views, expected_relationship_views_hash: relationshipViewsHash(undefined),
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  }
});
it('uses compare-and-swap for add/change/remove while preserving unrelated metadata', () => {
  const db = fixture(),
    hash = relationshipViewsHash(undefined);
  const first = normalizeRelationshipViewsMutation(
    db,
    { other: 1 },
    {
      relationship_views: projectViews(),
      expected_relationship_views_hash: hash,
    },
  );
  expect(first).toMatchObject({
    other: 1,
    relationship_views_v1: projectViews(),
  });
  expect(() =>
    normalizeRelationshipViewsMutation(db, first, {
      relationship_views: null,
      expected_relationship_views_hash: hash,
    }),
  ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  const removed = normalizeRelationshipViewsMutation(db, first, {
    relationship_views: null,
    expected_relationship_views_hash: relationshipViewsHash(namespace(first)),
  });
  expect(removed).toEqual({ other: 1 });
});
it('preserves definitions on ordinary metadata replacement and rejects raw namespace writes', () => {
  const db = fixture(),
    old = { other: 1, relationship_views_v1: projectViews() };
  expect(
    normalizeRelationshipViewsMutation(db, old, { metadata: { newValue: 2 } }),
  ).toEqual({ newValue: 2, relationship_views_v1: projectViews() });
  expect(() =>
    normalizeRelationshipViewsMutation(db, old, { metadata: null }),
  ).toThrow();
  expect(() =>
    normalizeRelationshipViewsMutation(
      db,
      {},
      { metadata: { relationship_views_v1: projectViews() } },
    ),
  ).toThrow();
  expect(() =>
    normalizeRelationshipViewsMutation(db, 'legacy', {
      relationship_views: projectViews(),
      expected_relationship_views_hash: relationshipViewsHash(undefined),
    }),
  ).toThrow();
});
it('enforces governance in CRUD and patch paths, including absent-namespace writes', () => {
  const db = fixture();
  const hash = relationshipViewsHash(undefined);
  expect(() =>
    updateSchemaDefinition(db, 'project', {
      relationship_views: projectViews(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  updateSchemaDefinition(db, 'project', {
    relationship_views: projectViews(),
    expected_relationship_views_hash: hash,
  });
  const result = patchSchemaDefinition(db, 'project', {
    relationship_views: null,
    expected_relationship_views_hash: relationshipViewsHash(projectViews()),
  });
  expect(namespace(result.metadata)).toBeUndefined();
  const created = createSchemaDefinition(db, {
    name: 'another',
    field_claims: [],
    relationship_views: projectViews(),
  });
  expect(namespace(created.metadata)).toEqual(projectViews());
});
it('validates changes without requiring unchanged invalid definitions to be repaired', () => {
  const db = fixture(),
    old = projectViews();
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  const changed = projectViews();
  changed.rollups[0].name = 'remaining';
  expect(() =>
    normalizeRelationshipViewsMutation(
      db,
      { relationship_views_v1: old },
      {
        relationship_views: changed,
        expected_relationship_views_hash: relationshipViewsHash(old),
      },
    ),
  ).not.toThrow();
  changed.rollups[1].name = 'changed_invalid';
  expect(() =>
    normalizeRelationshipViewsMutation(
      db,
      { relationship_views_v1: old },
      {
        relationship_views: changed,
        expected_relationship_views_hash: relationshipViewsHash(old),
      },
    ),
  ).toThrow();
});

it('preserves unchanged missing-relation rollups during an unrelated edit', () => {
  const db = fixture();
  const base = projectViews();
  const legacy = {
    ...base,
    rollups: [
      ...base.rollups,
      { name: 'legacy_count', relation: 'missing', metric: { op: 'count' } },
    ],
  };
  const next = {
    ...legacy,
    rollups: legacy.rollups.map((r) =>
      r.name === 'open_task_count'
        ? { ...r, description: 'Updated valid rollup' }
        : r,
    ),
  };
  const metadata = { other: 1, relationship_views_v1: legacy };
  expect(
    normalizeRelationshipViewsMutation(db, metadata, {
      relationship_views: next,
      expected_relationship_views_hash: relationshipViewsHash(legacy),
    }),
  ).toEqual({ other: 1, relationship_views_v1: next });
  const changedInvalid = {
    ...next,
    rollups: next.rollups.map((r) =>
      r.name === 'legacy_count'
        ? { ...r, description: 'Changed invalid rollup' }
        : r,
    ),
  };
  expect(() =>
    normalizeRelationshipViewsMutation(db, metadata, {
      relationship_views: changedInvalid,
      expected_relationship_views_hash: relationshipViewsHash(legacy),
    }),
  ).toThrow('Unknown saved relation');
});
it('rejects newly introduced missing dependencies and removal of an existing relation', () => {
  const db = fixture(),
    base = projectViews();
  expect(() =>
    normalizeRelationshipViewsMutation(
      db,
      {},
      {
        relationship_views: { ...base, relations: [] },
        expected_relationship_views_hash: relationshipViewsHash(undefined),
      },
    ),
  ).toThrow('Unknown saved relation');
  expect(() =>
    normalizeRelationshipViewsMutation(
      db,
      { relationship_views_v1: base },
      {
        relationship_views: { ...base, relations: [] },
        expected_relationship_views_hash: relationshipViewsHash(base),
      },
    ),
  ).toThrow('Unknown saved relation');
});
