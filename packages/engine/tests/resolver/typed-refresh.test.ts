import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { backfillResolvedTargets, refreshOnCreate } from '../../src/resolver/refresh.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { reconcileTypedReferences, refreshTypedReferences, readNodeResolutionIdentity } from '../../src/resolver/typed-refresh.js';
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  for (const id of ['p1', 'p2', 'src']) db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run(id, `${id}.md`, id === 'src' ? 'Source' : 'Same');
  db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('p1','project')").run();
  db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('src','project','Same')").run();
  db.prepare("INSERT INTO relationships (source_id,target,rel_type,context,resolved_target_id) VALUES ('src','Same','project','project','p1')").run();
});
afterEach(() => db.close());
function target() { return (db.prepare('SELECT resolved_target_id AS id FROM relationships').get() as { id: string | null }).id; }
it('reconciles stale non-null bindings after offline type edits and leaves raw storage untouched', () => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const fields = db.prepare('SELECT * FROM node_fields').all();
  db.prepare("INSERT INTO node_types (node_id,schema_type) VALUES ('p2','project')").run();
  const stats = db.transaction(() => reconcileTypedReferences(db))();
  expect(stats).toEqual({ scanned: 1, changed: 1 }); expect(target()).toBeNull();
  expect(db.prepare('SELECT * FROM nodes').all()).toEqual(nodes);
  expect(db.prepare('SELECT * FROM node_fields').all()).toEqual(fields);
});
it('requires an owning transaction and is rollback-safe', () => {
  expect(() => refreshTypedReferences(db, { kind: 'field', names: ['project'] })).toThrow(/transaction/i);
  expect(() => db.transaction(() => {
    const before = readNodeResolutionIdentity(db, 'p1');
    db.prepare("DELETE FROM node_types WHERE node_id = 'p1'").run();
    refreshTypedReferences(db, { kind: 'node', before, after: readNodeResolutionIdentity(db, 'p1') });
    expect(target()).toBeNull(); throw new Error('rollback');
  })()).toThrow('rollback');
  expect(target()).toBe('p1');
});
it('does not refresh typed semantics while the database is v1', () => {
  db.prepare("UPDATE meta SET value = '1' WHERE key = 'reference_resolution_policy_version'").run();
  db.prepare("DELETE FROM node_types WHERE node_id = 'p1'").run();
  expect(db.transaction(() => reconcileTypedReferences(db))()).toEqual({ scanned: 0, changed: 0 });
  expect(target()).toBe('p1');
});

it('keeps exact paths unresolved after wrong-type edits and path moves', () => {
  db.prepare("UPDATE relationships SET target = 'p1.md'").run();
  db.prepare("UPDATE node_fields SET value_text = 'p1.md'").run();
  db.transaction(() => {
    const before = readNodeResolutionIdentity(db, 'p1');
    db.prepare("DELETE FROM node_types WHERE node_id = 'p1'").run();
    refreshTypedReferences(db, { kind: 'node', before, after: readNodeResolutionIdentity(db, 'p1') });
  })();
  expect(target()).toBeNull();
  db.transaction(() => {
    const before = readNodeResolutionIdentity(db, 'p1');
    db.prepare("INSERT INTO node_types (node_id,schema_type) VALUES ('p1','project')").run();
    refreshTypedReferences(db, { kind: 'node', before, after: readNodeResolutionIdentity(db, 'p1') });
  })();
  expect(target()).toBe('p1');
  db.transaction(() => {
    const before = readNodeResolutionIdentity(db, 'p1');
    db.prepare("UPDATE nodes SET file_path = 'moved.md' WHERE id = 'p1'").run();
    refreshTypedReferences(db, { kind: 'node', before, after: readNodeResolutionIdentity(db, 'p1') });
  })();
  expect(target()).toBeNull();
});
it('keeps legacy NULL backfill and create shortcuts away from ambiguous typed edges', () => {
  db.prepare("INSERT INTO node_types (node_id,schema_type) VALUES ('p2','project')").run();
  refreshOnCreate(db, 'p2'); expect(target()).toBeNull();
  backfillResolvedTargets(db); expect(target()).toBeNull();
  db.prepare("INSERT INTO relationships (source_id,target,rel_type,context) VALUES ('src','Same','wiki-link','[[Same]]')").run();
  refreshOnCreate(db, 'p2');
  expect(db.prepare("SELECT resolved_target_id AS id FROM relationships WHERE rel_type = 'wiki-link'").get()).toEqual({ id: 'p2' });
  expect(db.prepare("SELECT resolved_target_id AS id FROM relationships WHERE rel_type = 'project'").get()).toEqual({ id: null });
});
it('preserves untyped origin for parser fallback links in a malformed reference field', () => {
  // Nested objects can contain parser-discovered links, but are not scalar
  // reference values and must retain the unconstrained orphan policy.
  db.prepare(`UPDATE node_fields SET value_text = NULL, value_json = '{"nested":"Same"}', value_raw_text = '{nested: "[[Same]]"}'`).run();
  db.prepare("INSERT INTO node_types (node_id,schema_type) VALUES ('p2','project')").run();
  refreshOnCreate(db, 'p2');
  expect(target()).toBe('p1');
});
