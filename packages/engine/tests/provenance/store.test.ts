import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { upgradeToProvenance } from '../../src/provenance/migrate.js';
import { ProvenanceStore } from '../../src/provenance/store.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../../src/provenance/limits.js';
import { randomUUID } from 'node:crypto';

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE nodes(id TEXT PRIMARY KEY); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE relationships(id TEXT); INSERT INTO relationships VALUES (\'untouched\')');
  upgradeToProvenance(db);
  return { db, store: new ProvenanceStore(db) };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe('provenance migration and reservations', () => {
  it('migrates once without modifying ordinary relationship rows', () => {
    const { db, store } = fixture();
    const namespace = store.namespace();
    upgradeToProvenance(db);
    expect(store.namespace()).toBe(namespace);
    expect(namespace).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.prepare('SELECT * FROM relationships').all()).toEqual([{ id: 'untouched' }]);
    expect(db.prepare("SELECT value FROM meta WHERE key='provenance_schema_version'").get()).toEqual({ value: '4' });
  });
  it('rolls back the version and all DDL on migration failure', () => {
    const db = new Database(':memory:'); databases.push(db);
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE provenance_outputs(conflict TEXT)');
    expect(() => upgradeToProvenance(db)).toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key='provenance_schema_version'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='provenance_sources'").get()).toBeUndefined();
  });
  it('preserves native source identity when a live node disappears', () => {
    const { db, store } = fixture();
    db.prepare('INSERT INTO nodes VALUES (?)').run('note');
    const source = { namespace: store.namespace(), kind: 'node' as const, native_id: 'note' };
    const id = db.transaction(() => store.ensureSource(source))();
    db.prepare('DELETE FROM nodes WHERE id=?').run('note');
    expect(db.prepare('SELECT native_id,live_node_id FROM provenance_sources WHERE id=?').get(id)).toEqual({ native_id: 'note', live_node_id: null });
    expect(db.transaction(() => store.ensureSource(source))()).toBe(id);
  });
  it('reserves capacity once, counts actual plus unused, and rolls back failed attempts', () => {
    const { db, store } = fixture();
    const limits = { ...DEFAULT_PROVENANCE_LIMITS, capacityBytes: DEFAULT_PROVENANCE_LIMITS.totalBytes };
    const reserve = () => store.reserve({ attempt_key: randomUUID(), run_ref: randomUUID(), project_id: 'project', bundle_digest: 'digest' }, limits);
    const row = db.transaction(reserve).immediate();
    expect(store.usedBytes()).toBe(limits.totalBytes);
    expect(() => db.transaction(reserve).immediate()).toThrow('PROVENANCE_CAPACITY');
    db.transaction(() => store.putPayload(row.id, 'request', 'é')).immediate();
    expect(store.get(row.id)?.payload_bytes).toBe(2);
    expect(store.usedBytes()).toBe(limits.totalBytes);
    db.transaction(() => store.releaseReservation(row.id)).immediate();
    expect(store.usedBytes()).toBe(2);
    db.transaction(() => store.putPayload(row.id, 'request', 'é')).immediate();
    expect(store.usedBytes()).toBe(2);
    expect(() => db.transaction(() => { store.releaseReservation(row.id); reserve(); }).immediate()).toThrow();
    expect(store.usedBytes()).toBe(2);
  });
  it('scopes the same attempt key to its capture flow', () => {
    const { db, store } = fixture();
    const limits = { ...DEFAULT_PROVENANCE_LIMITS, capacityBytes: DEFAULT_PROVENANCE_LIMITS.totalBytes * 2 };
    const input = { attempt_key: 'same-attempt', run_ref: 'run', project_id: 'project', bundle_digest: 'digest' };
    const home = db.transaction(() => store.reserve(input, limits))();
    const page = db.transaction(() => store.reserve({ ...input, flow: 'project-subpage-v1' }, limits))();
    expect(home.producer).toBe('curator-home-v1');
    expect(page.producer).toBe('curator-subpage-v1');
    expect(store.byAttempt('same-attempt')?.id).toBe(home.id);
    expect(store.byAttempt('same-attempt', 'project-subpage-v1')?.id).toBe(page.id);
  });
  it('requires a transaction for store mutations', () => {
    const { store } = fixture();
    expect(() => store.ensureSource({ namespace: store.namespace(), kind: 'node', native_id: 'note' })).toThrow();
  });
});
