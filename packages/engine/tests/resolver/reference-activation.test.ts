import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { previewReferenceActivation, applyReferenceActivation } from '../../src/resolver/activation.js';
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  db.exec(`INSERT INTO global_fields (name,field_type,reference_target) VALUES ('project','reference','project');
    INSERT INTO nodes (id,file_path,title,body,version) VALUES ('src','src.md','Source','unchanged',7), ('wrong','wrong.md','Same','',1), ('right','right.md','Same','',1);
    INSERT INTO node_types (node_id,schema_type) VALUES ('right','project');
    INSERT INTO node_fields (node_id,field_name,value_text,value_raw_text) VALUES ('src','project','Same','[[Same]]');
    INSERT INTO relationships (source_id,target,rel_type,context,resolved_target_id) VALUES ('src','Same','project','project','wrong'), ('src','Same','wiki-link','body','wrong');`);
});
afterEach(() => db.close());
it('previews typed redirects read-only and atomically activates only derived bindings and marker', () => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const fields = db.prepare('SELECT * FROM node_fields').all();
  const unchangedTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('relationships','meta') AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name}"`).all() }));
  const otherMeta = db.prepare('SELECT * FROM meta').all();
  const preview = previewReferenceActivation(db);
  expect(preview).toMatchObject({ format_version: 1, from_policy: 1, to_policy: 2,
    counts: { scanned: 1, unchanged: 0, newly_resolved: 0, newly_unresolved: 0, redirected: 1 },
    changes: [{ source_id: 'src', field: 'project', raw_target: 'Same', before_id: 'wrong', after_id: 'right', reason: 'resolved' }],
    truncated: false, omitted_changes: 0 });
  expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(db.prepare("SELECT * FROM meta WHERE key='reference_resolution_policy_version'").all()).toEqual([]);
  expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE rel_type='project'").get()).toEqual({ resolved_target_id: 'wrong' });
  const receipt = applyReferenceActivation(db, preview.fingerprint);
  expect(receipt).toMatchObject({ fingerprint: preview.fingerprint, from_policy: 1, to_policy: 2, counts: preview.counts, noop: false });
  expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE rel_type='project'").get()).toEqual({ resolved_target_id: 'right' });
  expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE rel_type='wiki-link'").get()).toEqual({ resolved_target_id: 'wrong' });
  expect(db.prepare('SELECT * FROM nodes').all()).toEqual(nodes);
  expect(db.prepare('SELECT * FROM node_fields').all()).toEqual(fields);
  for (const { name, rows } of unchangedTables) expect(db.prepare(`SELECT * FROM "${name}"`).all()).toEqual(rows);
  expect(db.prepare("SELECT * FROM meta WHERE key != 'reference_resolution_policy_version'").all()).toEqual(otherMeta);
  expect(db.prepare("SELECT value FROM meta WHERE key='reference_resolution_policy_version'").get()).toEqual({ value: '2' });
  expect(() => applyReferenceActivation(db, preview.fingerprint)).toThrow(/stale/i);
  const fresh = previewReferenceActivation(db);
  expect(applyReferenceActivation(db, fresh.fingerprint)).toMatchObject({ noop: true, counts: { unchanged: 1 } });
});
it.each([
  "UPDATE nodes SET title='Changed' WHERE id='right'",
  "UPDATE nodes SET file_path='changed.md' WHERE id='right'",
  "DELETE FROM node_types WHERE node_id='right'",
  "UPDATE global_fields SET reference_target='task' WHERE name='project'",
  "UPDATE global_fields SET field_type='text' WHERE name='project'",
  "UPDATE node_fields SET value_text='Other'",
  "UPDATE node_fields SET value_raw_text='Other raw'",
  "UPDATE relationships SET target='Other' WHERE rel_type='project'",
  "UPDATE relationships SET context='orphan' WHERE rel_type='project'",
  "UPDATE relationships SET resolved_target_id=NULL WHERE rel_type='project'",
  "INSERT INTO meta (key,value) VALUES ('reference_resolution_policy_version','1')",
  "INSERT INTO meta (key,value) VALUES ('reference_resolution_policy_version','2')",
  "UPDATE global_fields SET list_item_type='reference' WHERE name='project'",
])('rejects stale complete snapshot after %s', sql => {
  const preview = previewReferenceActivation(db);
  db.exec(sql);
  expect(() => applyReferenceActivation(db, preview.fingerprint)).toThrow(/stale/i);
});
it('excludes physical edge IDs from the fingerprint', () => {
  const preview = previewReferenceActivation(db);
  db.exec('UPDATE relationships SET id=id+100');
  expect(previewReferenceActivation(db).fingerprint).toBe(preview.fingerprint);
});
it('rolls bindings back if marker commit fails', () => {
  const preview = previewReferenceActivation(db);
  db.exec("CREATE TRIGGER deny_marker BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  expect(() => applyReferenceActivation(db, preview.fingerprint)).toThrow('injected failure');
  expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE rel_type='project'").get()).toEqual({ resolved_target_id: 'wrong' });
  expect(db.prepare("SELECT * FROM meta WHERE key='reference_resolution_policy_version'").all()).toEqual([]);
});
it('bounds examples while counting and fingerprinting every typed edge', () => {
  const insert = db.prepare("INSERT INTO relationships (source_id,target,rel_type,context,resolved_target_id) VALUES (?, 'Same','project','project','wrong')");
  for (let n = 0; n < 60; n++) {
    db.prepare('INSERT INTO nodes (id,file_path) VALUES (?,?)').run(`s${n}`, `s${n}.md`);
    db.prepare("INSERT INTO node_fields (node_id,field_name,value_text) VALUES (?,'project','Same')").run(`s${n}`);
    insert.run(`s${n}`);
  }
  const preview = previewReferenceActivation(db);
  expect(preview.counts).toMatchObject({ scanned: 61, redirected: 61 });
  expect(preview.changes).toHaveLength(50);
  expect(preview).toMatchObject({ truncated: true, omitted_changes: 11 });
  db.exec("UPDATE relationships SET resolved_target_id=NULL WHERE source_id='src'");
  expect(() => applyReferenceActivation(db, preview.fingerprint)).toThrow(/stale/i);
});
it('requires owning top-level apply transaction so commit cannot be deferred by caller', () => {
  const preview = previewReferenceActivation(db);
  expect(() => db.transaction(() => applyReferenceActivation(db, preview.fingerprint))()).toThrow(/transaction/i);
});
it('counts unresolved, newly resolved and unchanged outcomes independently', () => {
  db.exec("UPDATE relationships SET resolved_target_id=NULL WHERE rel_type='project'");
  expect(previewReferenceActivation(db).counts).toMatchObject({ newly_resolved: 1, unchanged: 0 });
  db.exec("INSERT INTO node_types (node_id,schema_type) VALUES ('wrong','project')");
  expect(previewReferenceActivation(db).counts).toMatchObject({ unchanged: 1, changed: 0 });
  db.exec("UPDATE relationships SET resolved_target_id='wrong' WHERE rel_type='project'");
  expect(previewReferenceActivation(db)).toMatchObject({ counts: { newly_unresolved: 1 }, changes: [{ after_id: null, reason: 'ambiguous' }] });
  db.exec("DELETE FROM node_types");
  expect(previewReferenceActivation(db).changes[0].reason).toBe('type_mismatch');
  db.exec("UPDATE relationships SET target='Gone' WHERE rel_type='project'; UPDATE node_fields SET value_text='Gone'");
  expect(previewReferenceActivation(db).changes[0].reason).toBe('missing');
});
it('bounds encoded details even when one raw reference exceeds the byte budget', () => {
  const raw = 'x'.repeat(40_000);
  db.prepare("UPDATE relationships SET target=? WHERE rel_type='project'").run(raw);
  db.prepare('UPDATE node_fields SET value_text=?').run(raw);
  const preview = previewReferenceActivation(db);
  expect(preview).toMatchObject({ counts: { changed: 1 }, changes: [], truncated: true, omitted_changes: 1 });
  expect(Buffer.byteLength(JSON.stringify(preview.changes))).toBeLessThanOrEqual(32 * 1024);
  expect(applyReferenceActivation(db, preview.fingerprint).counts.newly_unresolved).toBe(1);
});
it('applies more than one bounded edge batch', () => {
  for (let n = 0; n < 510; n++) {
    db.prepare('INSERT INTO nodes (id,file_path) VALUES (?,?)').run(`batch${n}`, `batch${n}.md`);
    db.prepare("INSERT INTO node_fields (node_id,field_name,value_text) VALUES (?,'project','Same')").run(`batch${n}`);
    db.prepare("INSERT INTO relationships (source_id,target,rel_type,context) VALUES (?,'Same','project','project')").run(`batch${n}`);
  }
  const preview = previewReferenceActivation(db);
  expect(applyReferenceActivation(db, preview.fingerprint).counts).toMatchObject({ scanned: 511, newly_resolved: 510, redirected: 1 });
  expect(db.prepare("SELECT count(*) AS n FROM relationships WHERE rel_type='project' AND resolved_target_id='right'").get()).toEqual({ n: 511 });
});
