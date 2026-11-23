import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { textHashes } from '../notes/text-hash.js';

/** Called by startup after ensureMetaTable, never from a tool or read. */
export function upgradeToProvenance(db: Database.Database): void {
  db.transaction(() => {
    const version = db.prepare("SELECT value FROM meta WHERE key = 'provenance_schema_version'").get() as { value: string } | undefined;
    if (version?.value === '4') return;
    if (version?.value === '3') { addObservationTextHash(db); return; }
    if (version?.value === '2') { addFlowAwareOutputs(db); addObservationTextHash(db); return; }
    if (version?.value === '1') { addReplacementLineage(db); addFlowAwareOutputs(db); addObservationTextHash(db); return; }
    if (version !== undefined) throw new Error('Unsupported provenance schema version');
    db.exec(`
      CREATE TABLE provenance_sources (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, kind TEXT NOT NULL, native_id TEXT NOT NULL,
        live_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
        UNIQUE(namespace, kind, native_id)
      );
      CREATE TABLE provenance_derivations (
        id TEXT PRIMARY KEY, producer TEXT NOT NULL, attempt_key TEXT NOT NULL, run_ref TEXT NOT NULL,
        project_id TEXT NOT NULL, bundle_digest TEXT, state TEXT NOT NULL
          CHECK(state IN ('prepared','result_staged','committed','failed','abandoned')),
        availability TEXT NOT NULL CHECK(availability IN ('retained','expired','purged')),
        created_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, sent_at TEXT, terminal_at TEXT,
        committed_at TEXT, predecessor_id TEXT REFERENCES provenance_derivations(id),
        payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
        reserved_remaining_bytes INTEGER NOT NULL CHECK(reserved_remaining_bytes >= 0),
        reserved_limit INTEGER NOT NULL, dependency_coverage TEXT, omissions_json TEXT, request_digest TEXT, reconcile_key TEXT,
        UNIQUE(producer, attempt_key)
      );
      CREATE INDEX provenance_derivations_lease ON provenance_derivations(availability,state,lease_expires_at);
      CREATE INDEX provenance_derivations_terminal ON provenance_derivations(availability,state,terminal_at);
      CREATE TABLE provenance_payloads (
        id TEXT PRIMARY KEY, derivation_id TEXT NOT NULL REFERENCES provenance_derivations(id),
        kind TEXT NOT NULL CHECK(kind IN ('request','attribution','staged_result','contribution')),
        text TEXT, bytes INTEGER NOT NULL CHECK(bytes >= 0), digest TEXT,
        UNIQUE(derivation_id, kind)
      );
      CREATE TABLE provenance_observations (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES provenance_sources(id),
        derivation_id TEXT NOT NULL REFERENCES provenance_derivations(id),
        native_version INTEGER, content_hash TEXT, hash_semantics TEXT, projection TEXT,
        observation_digest TEXT, observed_at TEXT, authority TEXT, label TEXT, path TEXT
      );
      CREATE INDEX provenance_observations_source ON provenance_observations(source_id,id);
      CREATE INDEX provenance_observations_derivation ON provenance_observations(derivation_id);
      CREATE TABLE provenance_inputs (
        id TEXT PRIMARY KEY, derivation_id TEXT NOT NULL REFERENCES provenance_derivations(id),
        item_key TEXT, observation_id TEXT REFERENCES provenance_observations(id),
        role TEXT, selection TEXT, spans TEXT, coverage TEXT, upstream_derivation_id TEXT,
        original_bytes INTEGER, retained_bytes INTEGER, input_digest TEXT, truncated INTEGER,
        UNIQUE(derivation_id,item_key)
      );
      CREATE INDEX provenance_inputs_observation ON provenance_inputs(observation_id,derivation_id);
      CREATE TABLE provenance_outputs (
        id TEXT PRIMARY KEY, derivation_id TEXT NOT NULL UNIQUE REFERENCES provenance_derivations(id),
        node_id TEXT NOT NULL, node_version INTEGER NOT NULL, committed_at TEXT NOT NULL,
        operation_id TEXT NOT NULL, reconcile_key TEXT NOT NULL UNIQUE, request_digest TEXT,
        contribution_digest TEXT, post_commit_observation TEXT, replay_result TEXT
      );
      CREATE INDEX provenance_outputs_commit ON provenance_outputs(committed_at,id);
      CREATE INDEX provenance_outputs_node ON provenance_outputs(node_id,committed_at,id);
      CREATE TABLE provenance_purge_receipts (
        id TEXT PRIMARY KEY, scope_token TEXT NOT NULL, committed_at TEXT NOT NULL,
        source_ids TEXT NOT NULL, derivation_ids TEXT NOT NULL
      );
      CREATE INDEX provenance_purge_receipts_commit ON provenance_purge_receipts(committed_at,id);
      CREATE TABLE provenance_flow_activations (
        project_id TEXT NOT NULL, flow TEXT NOT NULL, first_committed_at TEXT NOT NULL,
        PRIMARY KEY(project_id,flow)
      );
    `);
    db.prepare("INSERT INTO meta(key,value) VALUES ('provenance_vault_namespace',?)").run(randomUUID());
    db.prepare("INSERT INTO meta(key,value) VALUES ('provenance_schema_version','1')").run();
    addReplacementLineage(db);
    addFlowAwareOutputs(db);
    addObservationTextHash(db);
  }).immediate();
}

/**
 * Observations keep the note's text hash (#332), so the inspector can tell a note that only gained
 * links from one that changed. An existing observation of a note that is still as observed (same
 * version and content hash) takes the note's text hash now; one whose note changed since keeps
 * none, and compares as before.
 */
function addObservationTextHash(db: Database.Database): void {
  db.exec('ALTER TABLE provenance_observations ADD COLUMN text_hash TEXT');
  const nodeColumns = new Set((db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map(column => column.name));
  if (!['version', 'content_hash', 'body'].every(name => nodeColumns.has(name))) {
    db.prepare("UPDATE meta SET value='4' WHERE key='provenance_schema_version'").run();
    return;
  }
  const namespace = (db.prepare("SELECT value FROM meta WHERE key='provenance_vault_namespace'").get() as { value: string } | undefined)?.value;
  const rows = db.prepare(`
    SELECT o.id, s.native_id, o.native_version, o.content_hash
    FROM provenance_observations o
    JOIN provenance_sources s ON s.id = o.source_id
    JOIN nodes n ON n.id = s.native_id
    WHERE s.kind = 'node' AND s.namespace = ? AND o.authority = 'engine'
      AND o.native_version = n.version AND o.content_hash IS n.content_hash
  `).all(namespace ?? '') as Array<{ id: string; native_id: string }>;
  const hashes = textHashes(db, rows.map(row => row.native_id));
  const update = db.prepare('UPDATE provenance_observations SET text_hash = ? WHERE id = ?');
  for (const row of rows) {
    const hash = hashes.get(row.native_id);
    if (hash !== undefined) update.run(hash, row.id);
  }
  db.prepare("UPDATE meta SET value='4' WHERE key='provenance_schema_version'").run();
}

function addReplacementLineage(db: Database.Database): void {
  db.exec(`ALTER TABLE provenance_outputs ADD COLUMN replaces_output_revision_id TEXT REFERENCES provenance_outputs(id);
    CREATE INDEX provenance_outputs_replaces ON provenance_outputs(replaces_output_revision_id);`);
  db.prepare("UPDATE meta SET value='2' WHERE key='provenance_schema_version'").run();
}

/** Rebuilds the v2 table inside the ordered migration, retaining row IDs and lineage. */
function addFlowAwareOutputs(db: Database.Database): void {
  // DROP TABLE performs implicit deletes; defer the old self-FK until the
  // replacement table is installed, then verify all final references here.
  db.pragma('defer_foreign_keys = ON');
  db.exec(`
    CREATE TABLE provenance_outputs_v3 (
      id TEXT PRIMARY KEY, derivation_id TEXT NOT NULL UNIQUE REFERENCES provenance_derivations(id),
      node_id TEXT NOT NULL, node_version INTEGER NOT NULL, committed_at TEXT NOT NULL,
      operation_id TEXT NOT NULL, reconcile_key TEXT NOT NULL, request_digest TEXT,
      contribution_digest TEXT, post_commit_observation TEXT, replay_result TEXT,
      replaces_output_revision_id TEXT REFERENCES provenance_outputs_v3(id),
      UNIQUE(reconcile_key,node_id)
    );
    INSERT INTO provenance_outputs_v3
      (id,derivation_id,node_id,node_version,committed_at,operation_id,reconcile_key,
       request_digest,contribution_digest,post_commit_observation,replay_result,replaces_output_revision_id)
    SELECT id,derivation_id,node_id,node_version,committed_at,operation_id,reconcile_key,
       request_digest,contribution_digest,post_commit_observation,replay_result,replaces_output_revision_id
    FROM provenance_outputs;
    DROP TABLE provenance_outputs;
    ALTER TABLE provenance_outputs_v3 RENAME TO provenance_outputs;
    CREATE INDEX provenance_outputs_commit ON provenance_outputs(committed_at,id);
    CREATE INDEX provenance_outputs_node ON provenance_outputs(node_id,committed_at,id);
    CREATE INDEX provenance_outputs_replaces ON provenance_outputs(replaces_output_revision_id);
    CREATE INDEX provenance_outputs_batch ON provenance_outputs(reconcile_key,committed_at,id);
    ALTER TABLE provenance_observations ADD COLUMN expected_post_commit_observation TEXT;
  `);
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) throw new Error(`Provenance v3 migration foreign key violations: ${JSON.stringify(violations)}`);
  db.prepare("UPDATE meta SET value='3' WHERE key='provenance_schema_version'").run();
}
