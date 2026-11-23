import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { runMigrations, MIGRATIONS } from '../src/db/migrate.js';
import * as ledger from '../src/db/home-refresh.js';
import { randomUUID } from 'node:crypto';

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() { const db = new Database(':memory:'); dbs.push(db); runMigrations(db); return db; }
export function refreshRequest() {
  return { request_id: randomUUID(), confirm_paid: true as const, guard: { version: 1 as const, vault_namespace: 'vault', project_id: 'project',
    home_node_id: 'home', output_revision_id: 'output', home_version: 2, topology_hash: 'topology', configuration_digest: 'config', corrections_digest: 'corrections' } };
}
it('deduplicates identical requests and blocks another active request for the same target', () => {
  const db = fixture(); const req = refreshRequest();
  const first = ledger.admitHomeRefresh(db, req);
  expect(ledger.admitHomeRefresh(db, req)).toEqual(first);
  expect(ledger.admitHomeRefresh(db, { ...req, request_id: randomUUID() }).request_id).toBe(req.request_id);
  expect(() => ledger.admitHomeRefresh(db, { ...req, guard: { ...req.guard, home_version: 3 } })).toThrow('REQUEST_CONFLICT');
  expect(db.prepare('SELECT COUNT(*) AS n FROM home_refresh_requests').get()).toEqual({ n: 1 });
});
it('guards transitions and clears temporary generated text on terminal status without forgetting identity', () => {
  const db = fixture(); const req = refreshRequest(); ledger.admitHomeRefresh(db, req);
  ledger.transitionHomeRefresh(db, req.request_id, 'queued', { phase: 'stage_pending', stage_json: '{"secret":"generated"}' });
  expect(() => ledger.transitionHomeRefresh(db, req.request_id, 'queued', { phase: 'preparing' })).toThrow('REQUEST_STATE_CONFLICT');
  ledger.transitionHomeRefresh(db, req.request_id, 'stage_pending', { phase: 'failed', message: 'Failed' });
  expect(ledger.getHomeRefresh(db, req.request_id)?.stage_json).toBeNull();
  expect(ledger.admitHomeRefresh(db, req).phase).toBe('failed');
  expect(ledger.listRecoverableHomeRefreshes(db)).toEqual([]);
});
it('retains coalesced UUIDs and their own immutable request digest after the original is terminal', () => {
  const db = fixture(); const a = refreshRequest();
  const b = { ...a, request_id: randomUUID(), guard: { ...a.guard, configuration_digest: 'new-config' } };
  ledger.admitHomeRefresh(db, a);
  expect(ledger.admitHomeRefresh(db, b).request_id).toBe(a.request_id);
  ledger.transitionHomeRefresh(db, a.request_id, 'queued', { phase: 'committed' });
  expect(ledger.getHomeRefresh(db, b.request_id)?.phase).toBe('committed');
  expect(ledger.admitHomeRefresh(db, b).request_id).toBe(a.request_id);
  expect(() => ledger.admitHomeRefresh(db, { ...b, guard: a.guard })).toThrow('REQUEST_CONFLICT');
  expect(db.prepare('SELECT COUNT(*) AS n FROM home_refresh_requests').get()).toEqual({ n: 1 });
});
it('migration 17 preserves prior controls and rolls back atomically if its table creation fails', () => {
  const db = new Database(':memory:'); dbs.push(db);
  runMigrations(db, MIGRATIONS.filter(m => m.version <= 16));
  const identity = db.prepare('SELECT * FROM provenance_identity').all();
  expect(() => runMigrations(db, [...MIGRATIONS.filter(m => m.version <= 16), { version: 17, name: 'failing-refresh',
    up: d => { ledger.createHomeRefreshRequests(d); throw Error('disk failure'); } }])).toThrow('disk failure');
  expect(db.pragma('user_version', { simple: true })).toBe(16);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='home_refresh_requests'").get()).toBeUndefined();
  runMigrations(db);
  expect(db.pragma('user_version', { simple: true })).toBe(41);
  expect(db.prepare('SELECT * FROM provenance_identity').all()).toEqual(identity);
});
it('migration 18 preserves existing requests and rolls back alias creation atomically', () => {
  const db = new Database(':memory:'); dbs.push(db);
  runMigrations(db, MIGRATIONS.filter(m => m.version <= 17));
  db.prepare(`INSERT INTO home_refresh_requests(request_id,request_digest,request_json,vault_namespace,home_node_id,project_id,
    phase,message,attempt_key,run_ref,generated_at,created_at,updated_at) VALUES ('existing','digest','{}','vault','home','project',
    'committed','done','attempt','run','date','date','date')`).run();
  const before = db.prepare('SELECT * FROM home_refresh_requests').all();
  expect(() => runMigrations(db, [{ version: 18, name: 'fail-alias', up: d => {
    ledger.createHomeRefreshAliases(d); throw Error('disk failure');
  } }])).toThrow('disk failure');
  expect(db.pragma('user_version', { simple: true })).toBe(17);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='home_refresh_aliases'").get()).toBeUndefined();
  runMigrations(db);
  expect(db.prepare('SELECT * FROM home_refresh_requests').all()).toEqual(before);
  expect(ledger.getHomeRefresh(db, 'existing')?.phase).toBe('committed');
});
