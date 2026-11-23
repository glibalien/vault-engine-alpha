import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function createSchema(db: Database.Database): void {
  // Load sqlite-vec extension so the embedding_vec virtual table can be created.
  sqliteVec.load(db);
  // db.exec is the better-sqlite3 method for running multi-statement SQL,
  // not child_process.exec — this is safe, no shell involved.
  const runSql = db.exec.bind(db);
  runSql(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      title TEXT,
      body TEXT,
      content_hash TEXT,
      file_mtime INTEGER,
      content_changed_at INTEGER,
      indexed_at INTEGER,
      created_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS node_types (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      schema_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (node_id, schema_type)
    );
    CREATE INDEX IF NOT EXISTS idx_node_types_schema_type ON node_types(schema_type);

    CREATE TABLE IF NOT EXISTS global_fields (
      name TEXT PRIMARY KEY,
      field_type TEXT NOT NULL,
      enum_values TEXT,
      enum_groups TEXT,
      overrides_allowed_enum_groups INTEGER NOT NULL DEFAULT 0,
      reference_target TEXT,
      description TEXT,
      default_value TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      ai_guessable INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_required INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_ai_guessable INTEGER NOT NULL DEFAULT 0,
      list_item_type TEXT
    );

    CREATE TABLE IF NOT EXISTS schemas (
      name TEXT PRIMARY KEY,
      display_name TEXT,
      icon TEXT,
      filename_template TEXT,
      default_directory TEXT,
      field_claims TEXT NOT NULL DEFAULT '[]',
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_field_claims (
      schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      field TEXT NOT NULL REFERENCES global_fields(name),
      label TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 1000,
      required_override INTEGER,
      default_value_override TEXT,
      default_value_overridden INTEGER NOT NULL DEFAULT 0,
      enum_values_override TEXT,
      enum_groups_override TEXT,
      ai_guessable_override INTEGER,
      PRIMARY KEY (schema_name, field)
    );
    CREATE INDEX IF NOT EXISTS idx_sfc_field ON schema_field_claims(field);

    CREATE TABLE IF NOT EXISTS node_fields (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_date TEXT,
      value_json TEXT,
      value_raw_text TEXT,
      source TEXT NOT NULL DEFAULT 'frontmatter',
      PRIMARY KEY (node_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_node_fields_field_name ON node_fields(field_name);
    CREATE INDEX IF NOT EXISTS idx_node_fields_value_number ON node_fields(value_number);
    CREATE INDEX IF NOT EXISTS idx_node_fields_value_date ON node_fields(value_date);

    CREATE TABLE IF NOT EXISTS node_explicit_null_fields (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      PRIMARY KEY (node_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_node_explicit_null_fields_field
      ON node_explicit_null_fields(field_name);

    -- Relationships store raw target strings plus an optional resolved node id.
    -- resolved_target_id is populated at insert (indexer + pipeline) and maintained
    -- via src/resolver/refresh.ts on node create/rename/delete.
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      context TEXT,
      resolved_target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      UNIQUE(source_id, target, rel_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source_id ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
    CREATE INDEX IF NOT EXISTS idx_relationships_rel_type ON relationships(rel_type);
    -- Indexes on resolved_target_id are created by upgradeForResolvedTargetId in db/migrate.ts:
    -- on an existing DB the column doesn't exist yet when createSchema runs.

    CREATE TABLE IF NOT EXISTS edits_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edits_log_timestamp ON edits_log(timestamp);

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      event TEXT NOT NULL,
      source TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_file_path ON sync_log(file_path);
    CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);

    CREATE TABLE IF NOT EXISTS embedding_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      extraction_ref TEXT,
      embedded_at TEXT NOT NULL,
      UNIQUE(node_id, source_type, extraction_ref, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_meta_node_id ON embedding_meta(node_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS embedding_vec USING vec0(
      id INTEGER PRIMARY KEY,
      vector float[256]
    );

    CREATE TABLE IF NOT EXISTS schema_file_hashes (
      file_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      rendered_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      title,
      aliases,
      path,
      fields,
      links,
      body,
      content='',
      contentless_delete=1
    );

    CREATE TABLE IF NOT EXISTS extraction_cache (
      content_hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      extractor_id TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      metadata_json TEXT,
      extracted_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    -- Durable memories: freeform notes an agent/tool records for later recall.
    -- vec_id points at memory_embedding_vec.id (a dedicated vec0 virtual table,
    -- not the shared embedding_vec — no FK possible against a virtual table).
    -- The vec table, memories_fts, and its sync triggers are created in
    -- upgradeToMemories (db/migrate.ts), not here — see that migration's
    -- comment for why they're not duplicated in this fresh-DB path.
    -- v3 shape (evidence governance): ON DELETE SET NULL, never CASCADE —
    -- memories are expired app-side on node deletion, not silently deleted.
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'vault',
      node_id TEXT,
      content TEXT NOT NULL,
      category TEXT,
      metadata_json TEXT,
      vec_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expired_at TEXT,
      valid_at TEXT,
      invalid_at TEXT,
      superseded_by INTEGER,
      evidence_kind TEXT NOT NULL DEFAULT 'unknown',
      evidence_node_id TEXT,
      evidence_hash TEXT,
      evidence_ref TEXT,
      expire_reason TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
    );
    -- Only indexes on v1 columns here: createSchema runs BEFORE the migration
    -- chain on every boot, and CREATE TABLE IF NOT EXISTS no-ops against an
    -- existing older-shape table — an index on a v2/v3 column would throw
    -- "no such column" on that boot (2026-07-16 deploy crash-loop).
    -- idx_memories_live is owned by upgradeToMemoriesV2;
    -- idx_memories_evidence_node by upgradeToMemoriesV3 (migration-ordering rule).
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
    CREATE INDEX IF NOT EXISTS idx_memories_node_id ON memories(node_id);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

    -- Memory note receipts: idempotency + audit ledger for the editable
    -- Settings/Memories.md projection. Keyed by (block_key, edit_hash) so a
    -- repeated watcher/reconciler/restart delivery of the same edit is an
    -- exact no-op. Deliberately NO foreign key onto memories: a privacy purge
    -- must not erase or invalidate the idempotency/audit receipt (the row's
    -- source/result ids are plain integers, kept after the memory is gone).
    -- Table + index are also created by upgradeToMemoryNoteReceipts for
    -- existing DBs; declared here so fresh DBs have them without a migration.
    CREATE TABLE IF NOT EXISTS memory_note_receipts (
      block_key TEXT NOT NULL,
      edit_hash TEXT NOT NULL,
      source_memory_id INTEGER,
      result_memory_id INTEGER,
      outcome TEXT NOT NULL,
      details_json TEXT,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (block_key, edit_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_note_receipts_block
      ON memory_note_receipts(block_key, applied_at DESC);
  `);
}
