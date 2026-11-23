// Frozen copy of the real v1/v2 migration at base 51f19db; only the exported name differs.
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** Called by startup after ensureMetaTable, never from a tool or read. */
export function upgradeToLegacyProvenance(db: Database.Database): void {
  db.transaction(() => {
    const version = db.prepare("SELECT value FROM meta WHERE key = 'provenance_schema_version'").get() as { value: string } | undefined;
    if (version?.value === '2') return;
    if (version?.value === '1') { addReplacementLineage(db); return; }
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
  }).immediate();
}

function addReplacementLineage(db: Database.Database): void {
  db.exec(`ALTER TABLE provenance_outputs ADD COLUMN replaces_output_revision_id TEXT REFERENCES provenance_outputs(id);
    CREATE INDEX provenance_outputs_replaces ON provenance_outputs(replaces_output_revision_id);`);
  db.prepare("UPDATE meta SET value='2' WHERE key='provenance_schema_version'").run();
}
