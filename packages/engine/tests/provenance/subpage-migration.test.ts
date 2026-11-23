import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { upgradeToProvenance } from '../../src/provenance/migrate.js';
import { upgradeToLegacyProvenance } from './legacy-migrate.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const legacyTables = [
  'provenance_sources', 'provenance_derivations', 'provenance_payloads',
  'provenance_observations', 'provenance_inputs', 'provenance_outputs',
  'provenance_purge_receipts', 'provenance_flow_activations',
] as const;

function snapshot(db: Database.Database) {
  return Object.fromEntries(legacyTables.map(table => [table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function fixture(version: 1 | 2) {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE nodes(id TEXT PRIMARY KEY); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  upgradeToLegacyProvenance(db); // Use the frozen real pre-v3 schema and constraints.
  if (version === 1) {
    db.exec("DROP INDEX provenance_outputs_replaces; ALTER TABLE provenance_outputs DROP COLUMN replaces_output_revision_id; UPDATE meta SET value='1' WHERE key='provenance_schema_version'");
  }
  db.prepare('INSERT INTO nodes(id) VALUES (?)').run('source-node');
  db.prepare("INSERT INTO provenance_sources(id,namespace,kind,native_id,live_node_id) VALUES ('source','vault','node','source-node','source-node')").run();
  const insertDerivation = db.prepare(`INSERT INTO provenance_derivations
    (id,producer,attempt_key,run_ref,project_id,bundle_digest,state,availability,created_at,lease_expires_at,
     committed_at,payload_bytes,reserved_remaining_bytes,reserved_limit,reconcile_key)
    VALUES (?,'curator-home-v1',?,'run','project','bundle','committed',?,'2026-01-01','2026-01-02',
            '2026-01-01',?,?,64,?)`);
  insertDerivation.run('first', 'attempt-1', 'retained', 32, 0, 'shared'); // 7 request bytes + 25 replay bytes
  insertDerivation.run('second', 'attempt-2', 'retained', 25, 0, 'replacement'); // 25 replay bytes
  insertDerivation.run('purged', 'attempt-3', 'purged', 0, 0, 'purged-key');
  db.prepare("INSERT INTO provenance_payloads(id,derivation_id,kind,text,bytes,digest) VALUES ('payload','first','request','1234567',7,'digest')").run();
  db.prepare("INSERT INTO provenance_observations(id,source_id,derivation_id,native_version,content_hash,observation_digest,observed_at) VALUES ('observation','source','first',3,'hash','observation-hash','2026-01-01')").run();
  db.prepare("INSERT INTO provenance_inputs(id,derivation_id,item_key,observation_id,role,retained_bytes) VALUES ('input','first','item','observation','source_material',7)").run();
  const outputColumns = 'id,derivation_id,node_id,node_version,committed_at,operation_id,reconcile_key,request_digest,contribution_digest,post_commit_observation,replay_result';
  db.prepare(`INSERT INTO provenance_outputs(${outputColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('output-1', 'first', 'home-node', 2, '2026-01-01', 'operation-1', 'shared', 'request', 'contribution', 'post-hash', '{"receipts":["output-1"]}');
  if (version === 2) {
    db.prepare(`INSERT INTO provenance_outputs(${outputColumns},replaces_output_revision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('output-2', 'second', 'home-node', 3, '2026-01-02', 'operation-2', 'replacement', 'request-2', 'contribution-2', null, '{"receipts":["output-2"]}', 'output-1');
  } else {
    db.prepare(`INSERT INTO provenance_outputs(${outputColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('output-2', 'second', 'home-node', 3, '2026-01-02', 'operation-2', 'replacement', 'request-2', 'contribution-2', null, '{"receipts":["output-2"]}');
  }
  db.prepare("INSERT INTO provenance_purge_receipts(id,scope_token,committed_at,source_ids,derivation_ids) VALUES ('purge','scope','2026-01-03','[]','[\"purged\"]')").run();
  db.prepare("INSERT INTO provenance_flow_activations(project_id,flow,first_committed_at) VALUES ('project','project-home-v1','2026-01-01')").run();
  return db;
}

function insertOutput(db: Database.Database, id: string, derivationId: string, nodeId: string) {
  db.prepare(`INSERT INTO provenance_outputs(id,derivation_id,node_id,node_version,committed_at,operation_id,reconcile_key)
    VALUES (?,?,?,1,'2026-01-04','operation-1','shared')`).run(id, derivationId, nodeId);
}

describe('provenance v3 storage migration', () => {
  for (const priorVersion of [1, 2] as const) {
    it(`preserves real v${priorVersion} history and admits sibling outputs`, () => {
      const db = fixture(priorVersion);
      db.prepare("INSERT INTO provenance_derivations(id,producer,attempt_key,run_ref,project_id,state,availability,created_at,lease_expires_at,payload_bytes,reserved_remaining_bytes,reserved_limit) VALUES ('third','curator-subpage-v1','attempt-4','run','project','committed','retained','2026-01-01','2026-01-02',0,0,10)").run();
      const before = snapshot(db);
      const usedBefore = db.prepare('SELECT SUM(payload_bytes + reserved_remaining_bytes) AS bytes FROM provenance_derivations').get();
      expect(usedBefore).toEqual({ bytes: 57 });
      upgradeToProvenance(db);
      const after = {
        legacyRows: Object.fromEntries(legacyTables.map(table => [table,
          db.prepare(`SELECT ${Object.keys((before[table] as Record<string, unknown>[])[0] ?? {}).join(',')} FROM ${table} ORDER BY rowid`).all(),
        ])),
        foreignKeyViolations: db.pragma('foreign_key_check'),
      };
      const insertSameReconcileDifferentNode = () => insertOutput(db, 'output-3', 'third', 'page-node');
      expect(insertSameReconcileDifferentNode).not.toThrow();
      expect(after.legacyRows).toEqual(before);
      expect(after.foreignKeyViolations).toEqual([]);
      expect(db.prepare('SELECT SUM(payload_bytes + reserved_remaining_bytes) AS bytes FROM provenance_derivations').get()).toEqual({ bytes: 57 });
      expect(db.prepare("SELECT SUM(payload_bytes + reserved_remaining_bytes) AS bytes FROM provenance_derivations WHERE availability='retained'").get()).toEqual({ bytes: 57 });
      expect(db.prepare('SELECT SUM(LENGTH(CAST(replay_result AS BLOB))) AS bytes FROM provenance_outputs').get()).toEqual({ bytes: 50 });
      expect(db.prepare("SELECT value FROM meta WHERE key='provenance_schema_version'").get()).toEqual({ value: '4' });
      expect(db.prepare('SELECT expected_post_commit_observation FROM provenance_observations WHERE id=?').get('observation')).toEqual({ expected_post_commit_observation: null });
      expect(db.prepare("SELECT replaces_output_revision_id FROM provenance_outputs WHERE id='output-2'").get()).toEqual({ replaces_output_revision_id: priorVersion === 2 ? 'output-1' : null });
      const insertSameReconcileSameNode = () => insertOutput(db, 'output-4', 'purged', 'page-node');
      expect(insertSameReconcileSameNode).toThrow();
      const insertSecondOutputForOneDerivation = () => insertOutput(db, 'output-5', 'first', 'other-node');
      expect(insertSecondOutputForOneDerivation).toThrow();
      const afterSecondMigration = snapshot(db);
      upgradeToProvenance(db);
      expect(snapshot(db)).toEqual(afterSecondMigration);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  }
});
