import type Database from 'better-sqlite3';
import { buildFtsRow } from '../search/fts-row.js';

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
}

/** Add persisted AI-guessability metadata to pre-existing field tables. */
export function upgradeForAiGuessableFields(db: Database.Database): void {
  db.transaction(() => {
    const global = tableColumns(db, 'global_fields');
    if (!global.has('ai_guessable')) {
      db.exec('ALTER TABLE global_fields ADD COLUMN ai_guessable INTEGER NOT NULL DEFAULT 0');
    }
    if (!global.has('overrides_allowed_ai_guessable')) {
      db.exec('ALTER TABLE global_fields ADD COLUMN overrides_allowed_ai_guessable INTEGER NOT NULL DEFAULT 0');
    }
    const claims = tableColumns(db, 'schema_field_claims');
    if (!claims.has('ai_guessable_override')) {
      db.exec('ALTER TABLE schema_field_claims ADD COLUMN ai_guessable_override INTEGER');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_explicit_null_fields (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        PRIMARY KEY (node_id, field_name)
      );
      CREATE INDEX IF NOT EXISTS idx_node_explicit_null_fields_field
        ON node_explicit_null_fields(field_name);
    `);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'undo_snapshots'`,
    ).get();
    if (tables && !tableColumns(db, 'undo_snapshots').has('explicit_null_fields')) {
      db.exec('ALTER TABLE undo_snapshots ADD COLUMN explicit_null_fields TEXT');
    }
  })();
}

/**
 * Upgrade an existing Phase 1 database to Phase 2.
 *
 * Safe to run on a database that already has the Phase 2 schema — all
 * operations are guarded by existence checks so the function is idempotent.
 */
/**
 * Upgrade an existing Phase 2 database to Phase 3.
 *
 * Adds: node_fields.value_raw_text column, schema_file_hashes table.
 * Idempotent — safe to run on a database that already has the Phase 3 schema.
 */
export function upgradeToPhase3(db: Database.Database): void {
  const run = db.transaction(() => {
    // --- node_fields: add value_raw_text column if missing ---
    const nfColumns = (
      db.prepare('PRAGMA table_info(node_fields)').all() as { name: string }[]
    ).map(c => c.name);

    if (!nfColumns.includes('value_raw_text')) {
      db.prepare(
        'ALTER TABLE node_fields ADD COLUMN value_raw_text TEXT'
      ).run();
    }

    // --- schema_file_hashes table ---
    db.prepare(`
      CREATE TABLE IF NOT EXISTS schema_file_hashes (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        rendered_at INTEGER NOT NULL
      )
    `).run();
  });

  run();
}

export function upgradeToPhase6(db: Database.Database): void {
  const run = db.transaction(() => {
    const tables = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
      ).all() as { name: string }[]
    ).map(t => t.name);

    if (!tables.includes('extraction_cache')) {
      db.prepare(`
        CREATE TABLE extraction_cache (
          content_hash TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          extractor_id TEXT NOT NULL,
          extracted_text TEXT NOT NULL,
          metadata_json TEXT,
          extracted_at TEXT NOT NULL
        )
      `).run();
    }
  });
  run();
}

/**
 * Add monotonic version stamps to nodes for optimistic concurrency.
 * Idempotent — safe to run on a database that already has the column.
 *
 * Spec: docs/superpowers/specs/2026-05-03-version-stamping-design.md
 */
export function upgradeToVersionStamps(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[])
      .map(c => c.name);
    if (!cols.includes('version')) {
      db.prepare('ALTER TABLE nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1').run();
    }
  });
  run();
}

/**
 * Upgrade an existing database to Phase 4.
 *
 * Drops the old `embeddings` placeholder table, creates `embedding_meta` and
 * the `embedding_vec` virtual table. Idempotent — safe to run multiple times.
 *
 * NOTE: sqlite-vec must be loaded on `db` before calling this function.
 */
export function upgradeToPhase4(db: Database.Database): void {
  const run = db.transaction(() => {
    // Drop old placeholder table if it exists
    db.prepare('DROP TABLE IF EXISTS embeddings').run();

    // Create embedding_meta
    db.prepare(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        extraction_ref TEXT,
        embedded_at TEXT NOT NULL,
        UNIQUE(node_id, source_type, extraction_ref, chunk_index)
      )
    `).run();

    // Create index for embedding_meta
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_embedding_meta_node_id ON embedding_meta(node_id)'
    ).run();

    // Create embedding_vec virtual table (requires sqlite-vec loaded)
    const vecExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_vec'")
      .get();
    if (!vecExists) {
      db.prepare(`
        CREATE VIRTUAL TABLE embedding_vec USING vec0(
          id INTEGER PRIMARY KEY,
          vector float[256]
        )
      `).run();
    }
  });

  run();
}

export function addCreatedAt(db: Database.Database): void {
  const run = db.transaction(() => {
    const columns = (
      db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]
    ).map(c => c.name);

    if (!columns.includes('created_at')) {
      db.prepare('ALTER TABLE nodes ADD COLUMN created_at INTEGER').run();
      // Backfill: use indexed_at as best available proxy for creation time
      db.prepare('UPDATE nodes SET created_at = indexed_at WHERE created_at IS NULL AND indexed_at IS NOT NULL').run();
    }
  });

  run();
}

export function upgradeForContentChangedAt(db: Database.Database): void {
  const run = db.transaction(() => {
    const columns = (
      db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]
    ).map(c => c.name);

    if (!columns.includes('content_changed_at')) {
      db.prepare('ALTER TABLE nodes ADD COLUMN content_changed_at INTEGER').run();
      // Backfill: best available baseline is the current file_mtime. content_changed_at
      // then advances only on a real content_hash change going forward.
      db.prepare('UPDATE nodes SET content_changed_at = file_mtime WHERE content_changed_at IS NULL AND file_mtime IS NOT NULL').run();
    }
  });
  run();
}

/**
 * Upgrade an existing database for per-type field overrides.
 *
 * global_fields: replaces single `per_type_overrides_allowed` with three
 * granular `overrides_allowed_*` columns.
 *
 * schema_field_claims: renames `required` → `required_override`,
 * `default_value` → `default_value_override`, adds `default_value_overridden`
 * and `enum_values_override`.
 *
 * Idempotent — safe to run on a database that already has the new schema.
 */
export function upgradeForOverrides(db: Database.Database): void {
  const run = db.transaction(() => {
    // --- global_fields: add granular override columns ---
    const gfColumns = (
      db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[]
    ).map(c => c.name);

    if (!gfColumns.includes('overrides_allowed_required')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN overrides_allowed_required INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('overrides_allowed_default_value')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('overrides_allowed_enum_values')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0'
      ).run();
    }

    // Migrate data from old per_type_overrides_allowed → new columns
    if (gfColumns.includes('per_type_overrides_allowed')) {
      db.prepare(`
        UPDATE global_fields
        SET overrides_allowed_required = per_type_overrides_allowed,
            overrides_allowed_default_value = per_type_overrides_allowed
        WHERE 1=1
      `).run();
      // Drop old column (SQLite 3.35.0+)
      db.prepare('ALTER TABLE global_fields DROP COLUMN per_type_overrides_allowed').run();
    }

    // --- schema_field_claims: rename + add columns ---
    const sfcColumns = (
      db.prepare('PRAGMA table_info(schema_field_claims)').all() as { name: string }[]
    ).map(c => c.name);

    // Rename required → required_override
    if (sfcColumns.includes('required') && !sfcColumns.includes('required_override')) {
      db.prepare(
        'ALTER TABLE schema_field_claims RENAME COLUMN required TO required_override'
      ).run();
    }

    // Rename default_value → default_value_override
    if (sfcColumns.includes('default_value') && !sfcColumns.includes('default_value_override')) {
      db.prepare(
        'ALTER TABLE schema_field_claims RENAME COLUMN default_value TO default_value_override'
      ).run();
    }

    // Add default_value_overridden
    // Re-read columns after renames
    const sfcColumnsAfter = (
      db.prepare('PRAGMA table_info(schema_field_claims)').all() as { name: string }[]
    ).map(c => c.name);

    if (!sfcColumnsAfter.includes('default_value_overridden')) {
      db.prepare(
        'ALTER TABLE schema_field_claims ADD COLUMN default_value_overridden INTEGER NOT NULL DEFAULT 0'
      ).run();
    }

    // Add enum_values_override
    if (!sfcColumnsAfter.includes('enum_values_override')) {
      db.prepare(
        'ALTER TABLE schema_field_claims ADD COLUMN enum_values_override TEXT'
      ).run();
    }

    // Backfill: mark default_value_overridden = 1 where default_value_override IS NOT NULL
    db.prepare(`
      UPDATE schema_field_claims
      SET default_value_overridden = 1
      WHERE default_value_override IS NOT NULL AND default_value_overridden = 0
    `).run();
  });

  run();
}

export function upgradeToPhase2(db: Database.Database): void {
  const run = db.transaction(() => {
    // --- global_fields: add three new columns if missing ---
    const gfColumns = (
      db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[]
    ).map(c => c.name);

    if (!gfColumns.includes('required')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN required INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('per_type_overrides_allowed')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('list_item_type')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN list_item_type TEXT'
      ).run();
    }

    // --- schema_field_claims table ---
    const tables = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_field_claims'"
      ).all() as { name: string }[]
    ).map(t => t.name);

    if (!tables.includes('schema_field_claims')) {
      db.prepare(`
        CREATE TABLE schema_field_claims (
          schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
          field TEXT NOT NULL REFERENCES global_fields(name),
          label TEXT,
          description TEXT,
          sort_order INTEGER DEFAULT 1000,
          required INTEGER,
          default_value TEXT,
          PRIMARY KEY (schema_name, field)
        )
      `).run();
    }

    // --- idx_sfc_field index ---
    const indexes = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sfc_field'"
      ).all() as { name: string }[]
    ).map(i => i.name);

    if (!indexes.includes('idx_sfc_field')) {
      db.prepare(
        'CREATE INDEX idx_sfc_field ON schema_field_claims(field)'
      ).run();
    }
  });

  run();
}

/**
 * Migration: ensure `meta` table exists (added 2026-04-16 for search_version).
 *
 * Idempotent — safe to run on a database that already has the meta table.
 */
export function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Migration: add `resolved_target_id` column + supporting indexes to
 * `relationships` (added 2026-04-18 for cross-node query filtering).
 *
 * The column is populated at insert (indexer + pipeline) and maintained via
 * src/resolver/refresh.ts on node create/rename/delete. A separate one-shot
 * backfill walks all existing rows on first boot after upgrade.
 *
 * Idempotent — safe to run on a database that already has the new column.
 */
export function upgradeForResolvedTargetId(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    const hasCol = cols.some(c => c.name === 'resolved_target_id');
    if (!hasCol) {
      db.prepare(
        'ALTER TABLE relationships ADD COLUMN resolved_target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL'
      ).run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_relationships_resolved_target_id ON relationships(resolved_target_id)'
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_relationships_source_resolved ON relationships(source_id, resolved_target_id)'
    ).run();
  });
  run();
}

/**
 * Migration: add undo_operations and undo_snapshots tables (2026-04-19).
 *
 * Snapshot-based operation-level undo. See
 * docs/superpowers/specs/2026-04-19-undo-system-design.md.
 *
 * Idempotent — safe to run on a database that already has the tables.
 */
export function addUndoTables(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_operations (
        operation_id TEXT PRIMARY KEY,
        timestamp    INTEGER NOT NULL,
        source_tool  TEXT NOT NULL,
        description  TEXT NOT NULL,
        node_count   INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'active'
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_snapshots (
        operation_id       TEXT NOT NULL REFERENCES undo_operations(operation_id) ON DELETE CASCADE,
        node_id            TEXT NOT NULL,
        file_path          TEXT NOT NULL,
        title              TEXT,
        body               TEXT,
        types              TEXT,
        fields             TEXT,
        relationships      TEXT,
        explicit_null_fields TEXT,
        was_deleted        INTEGER NOT NULL,
        post_mutation_hash TEXT,
        file_only_fields   TEXT,
        PRIMARY KEY (operation_id, node_id)
      )
    `).run();
    // The lines of fields only the note's file held (#656): JSON [{ name, text }], or NULL.
    if (!tableColumns(db, 'undo_snapshots').has('file_only_fields')) {
      db.exec('ALTER TABLE undo_snapshots ADD COLUMN file_only_fields TEXT');
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_operations_timestamp ON undo_operations(timestamp)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_operations_status    ON undo_operations(status)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_snapshots_node       ON undo_snapshots(node_id)').run();
  });
  run();
}

/**
 * Migration: add undo_schema_snapshots table + undo_operations.schema_count
 * column (2026-04-22, Phase B3).
 *
 * Captures pre-mutation schema state so update-schema/create-schema/delete-schema
 * can participate in the undo system. schema_count surfaces via list-undo-history
 * alongside node_count.
 *
 * Per the migration-ordering rule, CREATE INDEX on the new column lives in this
 * migration, not in createSchema's CREATE TABLE IF NOT EXISTS path.
 *
 * Idempotent — safe to run on a database that already has the new schema.
 */
export function addSchemaUndoSnapshots(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_schema_snapshots (
        operation_id       TEXT NOT NULL,
        schema_name        TEXT NOT NULL,
        was_new            INTEGER NOT NULL DEFAULT 0,
        was_deleted        INTEGER NOT NULL DEFAULT 0,
        display_name       TEXT,
        icon               TEXT,
        filename_template  TEXT,
        default_directory  TEXT,
        metadata           TEXT,
        field_claims       TEXT,
        PRIMARY KEY (operation_id, schema_name),
        FOREIGN KEY (operation_id) REFERENCES undo_operations(operation_id) ON DELETE CASCADE
      )
    `).run();

    const cols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('schema_count')) {
      db.prepare('ALTER TABLE undo_operations ADD COLUMN schema_count INTEGER NOT NULL DEFAULT 0').run();
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_schema_snapshots_op ON undo_schema_snapshots(operation_id)').run();
  });
  run();
}

/**
 * Migration: add undo_global_field_snapshots table +
 * undo_operations.global_field_count column (2026-04-29).
 *
 * Captures pre-mutation global field state plus dependent schema claims and
 * node field rows so global-field CRUD can participate in operation-level undo.
 *
 * Idempotent — safe to run on a database that already has the new schema.
 */
export function addGlobalFieldUndoSnapshots(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_global_field_snapshots (
        operation_id      TEXT NOT NULL,
        field_name        TEXT NOT NULL,
        was_new           INTEGER NOT NULL DEFAULT 0,
        was_deleted       INTEGER NOT NULL DEFAULT 0,
        was_renamed_from  TEXT,
        global_field      TEXT,
        schema_claims     TEXT NOT NULL DEFAULT '[]',
        node_fields       TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (operation_id, field_name),
        FOREIGN KEY (operation_id) REFERENCES undo_operations(operation_id) ON DELETE CASCADE
      )
    `).run();

    const cols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('global_field_count')) {
      db.prepare('ALTER TABLE undo_operations ADD COLUMN global_field_count INTEGER NOT NULL DEFAULT 0').run();
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_global_field_snapshots_op ON undo_global_field_snapshots(operation_id)').run();
  });
  run();
}

/**
 * Migration: add undo_link_bindings (2026-11-19, #665).
 *
 * The note each link was bound to before an operation bound it elsewhere without writing the
 * link's own note (a merge folding away a same-titled copy). A restore binds the link there
 * again once the notes are back. Rows go with their operation (ON DELETE CASCADE).
 *
 * Idempotent — safe to run on a database that already has the table.
 */
export function addUndoLinkBindings(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS undo_link_bindings (
      operation_id TEXT NOT NULL REFERENCES undo_operations(operation_id) ON DELETE CASCADE,
      source_id    TEXT NOT NULL,
      target       TEXT NOT NULL,
      rel_type     TEXT NOT NULL,
      bound_to     TEXT NOT NULL,
      PRIMARY KEY (operation_id, source_id, target, rel_type)
    )
  `).run();
}

/**
 * Migration: add undo_memory_subjects (2026-11-20, #554).
 *
 * The memory subjects an operation moved off the notes it folded away (a merge), so a restore
 * links them to those notes again and adds back the ones it dropped. `kept_id` and `dropped`
 * are what the merge left (linked to the kept note, or removed), so a restore touches only a
 * subject still in that state. Rows go with their operation (ON DELETE CASCADE).
 *
 * Idempotent — safe to run on a database that already has the table.
 */
export function addUndoMemorySubjects(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS undo_memory_subjects (
      operation_id TEXT NOT NULL REFERENCES undo_operations(operation_id) ON DELETE CASCADE,
      memory_id    INTEGER NOT NULL,
      name         TEXT NOT NULL,
      name_key     TEXT NOT NULL,
      node_id      TEXT NOT NULL,
      set_by       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      kept_id      TEXT NOT NULL,
      dropped      INTEGER NOT NULL,
      PRIMARY KEY (operation_id, memory_id, name_key)
    )
  `).run();
}

/**
 * Migration: add node_types.sort_order column (2026-04-22, Phase A3).
 *
 * Enables deterministic "first type" lookup for multi-typed nodes — wins
 * back parity with the explicit types[0] ordering that create-node uses.
 *
 * Backfill uses SQLite rowid per (node_id) partition — best-effort proxy
 * for original insertion order. New inserts populate sort_order explicitly
 * via pipeline/indexer loops (caller-supplied types array index).
 *
 * Idempotent — safe to run on a database that already has the column.
 */
export function addNodeTypesSortOrder(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(node_types)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('sort_order')) {
      db.prepare('ALTER TABLE node_types ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0').run();
      db.prepare(`
        UPDATE node_types
        SET sort_order = (
          SELECT rn - 1 FROM (
            SELECT node_id, schema_type, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY rowid) AS rn
            FROM node_types
          ) sub
          WHERE sub.node_id = node_types.node_id AND sub.schema_type = node_types.schema_type
        )
      `).run();
    }
  });
  run();
}

/**
 * Migration: add `ui_hints` column to `global_fields` (2026-05-03).
 *
 * Stores UI rendering hints (widget / label / help / order) as a
 * JSON-serialized object, or NULL when no hints are set. Existing rows stay
 * NULL — bundles fall back to the documented inference table.
 *
 * Spec: docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md
 *
 * Idempotent — safe to run on a database that already has the column.
 */
export function addUiHints(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(global_fields)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('ui_hints')) {
      db.prepare('ALTER TABLE global_fields ADD COLUMN ui_hints TEXT').run();
    }
  });
  run();
}

/**
 * Migration: add `attachment_transcripts` table + indexes (2026-06-09).
 *
 * Keyed by embed ref, indexed by vault path, so transcripts survive deletion
 * of the source binary (which the content-hash-keyed extraction_cache cannot —
 * its key is a hash of live bytes). Idempotent — safe to run on a database
 * that already has the table.
 *
 * Spec: docs/superpowers/specs/2026-06-09-deleted-attachment-transcript-retention-design.md
 */
export function upgradeForAttachmentTranscripts(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS attachment_transcripts (
        embed_ref      TEXT PRIMARY KEY,
        vault_path     TEXT,
        content_hash   TEXT NOT NULL,
        extracted_text TEXT NOT NULL,
        media_type     TEXT NOT NULL,
        extractor_id   TEXT NOT NULL,
        source_deleted INTEGER NOT NULL DEFAULT 0,
        captured_at    TEXT NOT NULL,
        deleted_at     TEXT,
        metadata_json  TEXT,
        materialized_node_id TEXT,
        materialized_at      TEXT
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_attachment_transcripts_vault_path ON attachment_transcripts(vault_path)'
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_attachment_transcripts_source_deleted ON attachment_transcripts(source_deleted)'
    ).run();

    // Pre-existing tables (prod DB created before metadata_json) need an
    // ALTER-add; CREATE TABLE IF NOT EXISTS is a no-op for them.
    const cols = (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('metadata_json')) {
      db.prepare('ALTER TABLE attachment_transcripts ADD COLUMN metadata_json TEXT').run();
    }

    // Backfill diarization/extraction metadata from extraction_cache (write-once,
    // keyed by content_hash). Only fills NULLs; never overwrites existing rows.
    const hasCache = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='extraction_cache'").get() as { c: number }).c > 0;
    if (hasCache) {
      db.prepare(`
        UPDATE attachment_transcripts
           SET metadata_json = (
             SELECT ec.metadata_json FROM extraction_cache ec
              WHERE ec.content_hash = attachment_transcripts.content_hash
              LIMIT 1
           )
         WHERE metadata_json IS NULL
           AND content_hash IN (SELECT content_hash FROM extraction_cache WHERE metadata_json IS NOT NULL)
      `).run();
    }
  });
  run();
}

/**
 * Phase 2 (materialize-transcript): records that a retained transcript has been
 * materialized into a real markdown node. Columns are added by ALTER because
 * the table already exists on the prod DB (created by
 * upgradeForAttachmentTranscripts). Idempotent.
 *
 * Spec: docs/superpowers/specs/2026-06-09-materialize-transcript-phase2-design.md
 */
export function upgradeForMaterializedTranscripts(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[])
      .map(c => c.name);
    if (!cols.includes('materialized_node_id')) {
      db.prepare('ALTER TABLE attachment_transcripts ADD COLUMN materialized_node_id TEXT').run();
    }
    if (!cols.includes('materialized_at')) {
      db.prepare('ALTER TABLE attachment_transcripts ADD COLUMN materialized_at TEXT').run();
    }
  });
  run();
}

/**
 * Epic C3 (archive-source): append-only provenance log for archived/purged
 * source attachments. Append-only on purpose — attachment_transcripts.capture()
 * resets deletion state when a file reappears and is re-indexed, so archive
 * provenance must live where re-capture cannot touch it. The file's byte size
 * is recorded here because it exists nowhere else in the DB. Indexes live in
 * this migration, not createSchema (CREATE TABLE IF NOT EXISTS no-ops on
 * existing DBs). Idempotent.
 *
 * Spec: docs/superpowers/specs/2026-06-09-archive-source-design.md
 */
export function upgradeForArchiveLog(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS archive_log (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_path           TEXT NOT NULL,
        content_hash         TEXT NOT NULL,
        bytes                INTEGER NOT NULL,
        mode                 TEXT NOT NULL,
        archive_path         TEXT,
        materialized_node_id TEXT,
        operation_id         TEXT,
        archived_at          TEXT NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_archive_log_vault_path ON archive_log(vault_path)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_archive_log_archived_at ON archive_log(archived_at)').run();
  });
  run();
}

/**
 * DB-health Part B (2026-06-09): extraction_cache.last_used_at for LRU-style
 * retention. Backfilled to the migration timestamp — NOT extracted_at — so
 * every pre-existing row gets a full retention window before it is ever
 * eligible for eviction. The column also lives in createSchema for fresh DBs
 * (CREATE TABLE IF NOT EXISTS no-ops on existing ones). Idempotent.
 *
 * Spec: docs/superpowers/specs/2026-06-09-db-health-bundle-design.md
 */
export function upgradeForExtractionCacheLastUsed(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(extraction_cache)').all() as { name: string }[])
      .map(c => c.name);
    if (!cols.includes('last_used_at')) {
      db.prepare('ALTER TABLE extraction_cache ADD COLUMN last_used_at TEXT').run();
    }
    db.prepare('UPDATE extraction_cache SET last_used_at = ? WHERE last_used_at IS NULL')
      .run(new Date().toISOString());
    // Index lives here, not createSchema: createSchema runs before this
    // migration at startup, and on an existing DB the column wouldn't exist yet.
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_extraction_cache_last_used_at ON extraction_cache(last_used_at)'
    ).run();
  });
  run();
}

/** Create the boards store (Phase 4). Idempotent. */
export function upgradeBoardsStore(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS boards (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        cards_json  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_boards_updated ON boards(updated_at DESC)').run();
  });
  run();
}

/**
 * Create the board↔doc association store (Phase 4b). Idempotent.
 * Must run AFTER upgradeBoardsStore — board_links FK-references boards(id).
 * doc_node_id is a stable engine node id (rename-safe); the engine never
 * resolves it against `nodes` (opaque, per charter engine/client separation).
 */
export function upgradeBoardLinksStore(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS board_links (
        board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        doc_node_id TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (board_id, doc_node_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_board_links_doc ON board_links(doc_node_id)').run();
  });
  run();
}

/**
 * Undo of the short-lived one-view-per-board split (#279, 2026-10-31), which broke every
 * multi-card board into one board per card. Boards hold several views again, and the split
 * left only fragments behind, so — by the owner's explicit decision — a database that ran the
 * split (meta key `boards_single_view` present) drops every board and board link, once, and
 * forgets the key. Databases that never ran the split are untouched. Not silent and not
 * irreversible: the deleted rows are kept as JSON in meta `boards_reset_export`
 * (`{ reset_at, boards, board_links }`, raw table rows), and the counts are logged.
 */
export function resetBoardsAfterSingleViewSplit(db: Database.Database): void {
  ensureMetaTable(db);
  const marker = db.prepare("SELECT value FROM meta WHERE key = 'boards_single_view'").get();
  if (marker === undefined) return;

  const run = db.transaction(() => {
    const exported = {
      reset_at: new Date().toISOString(),
      boards: db.prepare('SELECT * FROM boards').all(),
      board_links: db.prepare('SELECT * FROM board_links').all(),
    };
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('boards_reset_export', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify(exported));
    const links = db.prepare('DELETE FROM board_links').run().changes;
    const boards = db.prepare('DELETE FROM boards').run().changes;
    db.prepare("DELETE FROM meta WHERE key = 'boards_single_view'").run();
    return { boards, links };
  });
  const { boards, links } = run();
  console.log(`[vault-engine] boards reset after the one-view-per-board split: deleted ${boards} boards and ${links} board links (kept in meta boards_reset_export)`);
}

export function upgradeConversationsStore(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS conversations (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        archived     INTEGER NOT NULL DEFAULT 0,
        client_state TEXT,
        revision     INTEGER NOT NULL DEFAULT 1
      )
    `).run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL,
        message_json    TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)').run();
    // Guarded ALTER for existing DBs — CREATE TABLE IF NOT EXISTS no-ops there, so the
    // live column add must be the ALTER (memory feedback_migration_ordering). Opaque JSON;
    // the engine never parses client_state (same charter pattern as message_json/cards_json).
    const hasClientState = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'client_state');
    if (!hasClientState) db.prepare('ALTER TABLE conversations ADD COLUMN client_state TEXT').run();
    const hasRevision = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'revision');
    if (!hasRevision) db.prepare('ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1').run();
  });
  run();
}

/**
 * Create the conversation↔doc association store. Idempotent.
 * Must run AFTER upgradeConversationsStore — conversation_links FK-references conversations(id).
 * doc_node_id is a stable engine node id (rename-safe); the engine never resolves
 * it against `nodes` at runtime (opaque, per charter). Mirrors board_links.
 *
 * Also performs a one-time backfill: resolves legacy owner_doc (a file path) to a stable
 * node id via nodes.file_path JOIN, then drops owner_doc + its unique index. Guarded by a
 * column-existence check so it is run-once/idempotent and a no-op on fresh + migrated DBs.
 */
export function upgradeConversationLinks(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_links (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        doc_node_id     TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, doc_node_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_conversation_links_doc ON conversation_links(doc_node_id)').run();

    // One-time backfill off the legacy owner_doc column, then drop it. Guarded by
    // column-existence so this is run-once / idempotent and a no-op on fresh + migrated DBs.
    const hasOwnerDoc = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'owner_doc');
    if (hasOwnerDoc) {
      // Resolve owner_doc (a file path) → stable node id via nodes; unresolvable paths are skipped
      // (the conversation is retained, just loses its anchor — Open decision C). Archived rows link too.
      db.prepare(`
        INSERT OR IGNORE INTO conversation_links (conversation_id, doc_node_id, created_at)
        SELECT c.id, n.id, ?
          FROM conversations c JOIN nodes n ON n.file_path = c.owner_doc
         WHERE c.owner_doc IS NOT NULL
      `).run(Date.now());
      // Index must go before the column it references can be dropped.
      db.prepare('DROP INDEX IF EXISTS idx_conversations_owner').run();
      db.prepare('ALTER TABLE conversations DROP COLUMN owner_doc').run(); // SQLite ≥3.35
    }
  });
  run();
}

/**
 * Spend ledger: one row per paid third-party API call (LLM tokens, Deepgram
 * audio seconds, Exa actual dollars). cost_usd is computed at write time and
 * the unit prices snapshotted into pricing_json, so rate-table changes never
 * rewrite history; cost_basis is 'computed' | 'provider-reported' | 'unpriced'.
 * Append-only. Attribution ids (conversation_id/run_ref) are opaque — no FK,
 * mirroring the conversation_links precedent for cross-store references.
 */
export function addUsageEvents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                 TEXT NOT NULL,
      provider           TEXT NOT NULL,
      model              TEXT,
      service            TEXT NOT NULL,
      purpose            TEXT NOT NULL,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      audio_seconds      REAL,
      cost_usd           REAL NOT NULL,
      cost_basis         TEXT NOT NULL,
      pricing_json       TEXT,
      conversation_id    TEXT,
      run_ref            TEXT,
      source_ref         TEXT,
      experiment         TEXT,
      variant            TEXT,
      latency_ms         INTEGER,
      request_id         TEXT,
      metadata_json      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_events_conversation ON usage_events(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_experiment ON usage_events(experiment);
    CREATE INDEX IF NOT EXISTS idx_usage_events_run_ref ON usage_events(run_ref);
  `);
  addUsageConfirmations(db);
}

/**
 * Provider confirmations of ledger rows (#329): a side table keyed by usage_events id, so a
 * provider's own figure for a call never overwrites `cost_usd`, which the daily budget and
 * past reports keep using. `status` is 'confirmed' (confirmed_cost_usd set), 'pending' (the
 * provider has the request but no cost yet) or 'not_found'. Created with the ledger because
 * every spend report reads it.
 */
export function addUsageConfirmations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_confirmations (
      usage_event_id     INTEGER PRIMARY KEY REFERENCES usage_events(id),
      status             TEXT NOT NULL,
      confirmed_cost_usd REAL,
      attempts           INTEGER NOT NULL,
      checked_at         TEXT NOT NULL,
      detail             TEXT
    );
  `);
  addProviderReconciliation(db);
}

/**
 * Provider reconciliation (#328). `provider_usage_readings` holds each reading of a provider's
 * running usage figure for one API key (`key_ref` is a short one-way fingerprint of the key, so
 * readings from different keys never pair up). `provider_reconciliations` holds one row per
 * interval between two consecutive readings of the same key: the provider's spend over it, and
 * the ledger's total over exactly the same span (`ts` > start_at and <= end_at) and the gap as of
 * the reading. Reports recompute the ledger side, since a row can arrive after its interval was
 * stored. Ledger rows themselves are never changed.
 */
export function addProviderReconciliation(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_usage_readings (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      provider  TEXT NOT NULL,
      key_ref   TEXT NOT NULL,
      taken_at  TEXT NOT NULL,
      usage_usd REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_usage_readings ON provider_usage_readings(provider, key_ref, taken_at);
    CREATE TABLE IF NOT EXISTS provider_reconciliations (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      provider               TEXT NOT NULL,
      start_at               TEXT NOT NULL,
      end_at                 TEXT NOT NULL,
      provider_usd           REAL NOT NULL,
      ledger_usd             REAL NOT NULL,
      gap_usd                REAL NOT NULL,
      ledger_events          INTEGER NOT NULL,
      ledger_unpriced_events INTEGER NOT NULL,
      ledger_by_service_json TEXT NOT NULL,
      UNIQUE (provider, start_at, end_at)
    );
  `);
  addUsageKeyRefs(db);
}

/**
 * Which API key paid (#345). `usage_events.key_ref` is the paying key's fingerprint, null when
 * unknown: an older row, or a caller that doesn't report one. `provider_reconciliations.key_ref`
 * is the key an interval was read from, null for one stored before this column existed.
 */
function addUsageKeyRefs(db: Database.Database): void {
  for (const table of ['usage_events', 'provider_reconciliations']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'key_ref')) db.exec(`ALTER TABLE ${table} ADD COLUMN key_ref TEXT`);
  }
}

/**
 * Durable Memories v1: `memories` core table + indexes (also declared in
 * createSchema for fresh DBs), a dedicated cosine `memory_embedding_vec` vec0
 * table, a contentless `memories_fts` FTS5 table, and the three triggers that
 * keep it in sync. Idempotent — safe to run on a DB that already has all of
 * this (every statement is `IF NOT EXISTS`).
 *
 * `memory_embedding_vec` is deliberately NOT the shared `embedding_vec` table:
 * that table is swept against `embedding_meta` (src/db/maintenance.ts) and
 * would silently erase memory vectors that have no corresponding
 * `embedding_meta` row. Requires sqlite-vec to already be loaded on `db`
 * (createSchema loads it before this runs in the startup chain).
 *
 * Spec: docs/superpowers/specs/2026-07-05-durable-memories-design.md
 */
export function upgradeToMemories(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(`
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
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_node_id ON memories(node_id);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_embedding_vec USING vec0(
        id INTEGER PRIMARY KEY,
        vector float[256] distance_metric=cosine
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, category,
        content='', contentless_delete=1
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.id;
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
      END;
    `);
  });

  run();
}

/**
 * Durable Memories v2: add bi-temporal validity columns and the partial live
 * read-path index. Idempotent and safe on DBs already migrated to v2.
 *
 * Spec: docs/superpowers/specs/2026-07-05-durable-memories-design.md
 */
export function upgradeToMemoriesV2(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[])
      .map((c) => c.name);
    const add = (name: string, decl: string): void => {
      if (!cols.includes(name)) {
        db.prepare(`ALTER TABLE memories ADD COLUMN ${name} ${decl}`).run();
      }
    };

    add('expired_at', 'TEXT');
    add('valid_at', 'TEXT');
    add('invalid_at', 'TEXT');
    add('superseded_by', 'INTEGER');

    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_live ON memories(source, scope) WHERE expired_at IS NULL;');
    db.prepare('UPDATE memories SET valid_at = created_at WHERE valid_at IS NULL').run();
  });

  run();
}

/**
 * Durable Memories v3 (evidence governance): rebuild the memories table to
 * (a) add evidence provenance columns + expire_reason and (b) replace the
 * node_id FK's ON DELETE CASCADE with SET NULL — memories must never be
 * silently hard-deleted by a node deletion (charter: data is never silently
 * deleted); executeDeletion expires them app-side (P3) and SET NULL is the
 * backstop, reported by vault-doctor's memories_orphan_node_scope invariant.
 *
 * SQLite cannot alter constraints, so this is a full rebuild. Row ids are
 * copied verbatim, which keeps the contentless memories_fts table (rowid-
 * keyed) valid without a rebuild; DROP TABLE does not fire the per-row FTS
 * DELETE trigger. Triggers and indexes die with the old table and are
 * recreated against the renamed one. Backfill: rows stamped by the memory
 * sweep (metadata_json.origin = 'memory-sweep') become evidence_kind='note'
 * with node id + content hash lifted from the stamp; everything else is
 * grandfathered as 'unknown'.
 *
 * Spec: docs/superpowers/specs/2026-07-15-memories-v3-evidence-governance-design.md
 */
export function upgradeToMemoriesV3(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[])
    .map((c) => c.name);
  if (cols.includes('evidence_kind')) {
    // Already v3-shaped — either this migration ran, or createSchema built the
    // fresh table. Either way the evidence index is owned HERE, not by
    // createSchema (which must never index columns older tables lack), so
    // ensure it exists before returning.
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_evidence_node ON memories(evidence_node_id) WHERE expired_at IS NULL;');
    return;
  }

  // PRAGMA foreign_keys is a no-op inside a transaction — toggle outside it.
  const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      // DROP TABLE memories (below) discards the sqlite_sequence entry for
      // 'memories' along with the table. Without restoring it after the
      // rebuild, a pre-migration hard-deleted max-id memory would let a
      // post-migration insert reuse that id, silently re-targeting any
      // superseded_by lineage link that still points at the old id.
      const hasSeqTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      ).get();
      const seqRow = hasSeqTable
        ? (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memories'").get() as { seq: number } | undefined)
        : undefined;

      db.exec(`
        CREATE TABLE memories_v3 (
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

        INSERT INTO memories_v3 (
          id, source, scope, node_id, content, category, metadata_json, vec_id,
          created_at, updated_at, expired_at, valid_at, invalid_at, superseded_by,
          evidence_kind, evidence_node_id, evidence_hash, evidence_ref
        )
        SELECT
          id, source, scope, node_id, content, category, metadata_json, vec_id,
          created_at, updated_at, expired_at, valid_at, invalid_at, superseded_by,
          CASE WHEN json_extract(metadata_json, '$.origin') = 'memory-sweep' THEN 'note' ELSE 'unknown' END,
          CASE WHEN json_extract(metadata_json, '$.origin') = 'memory-sweep' THEN json_extract(metadata_json, '$.source_node_id') END,
          CASE WHEN json_extract(metadata_json, '$.origin') = 'memory-sweep' THEN json_extract(metadata_json, '$.content_hash') END,
          NULL
        FROM memories;

        DROP TABLE memories;
        ALTER TABLE memories_v3 RENAME TO memories;

        CREATE INDEX idx_memories_source ON memories(source);
        CREATE INDEX idx_memories_node_id ON memories(node_id);
        CREATE INDEX idx_memories_category ON memories(category);
        CREATE INDEX idx_memories_live ON memories(source, scope) WHERE expired_at IS NULL;
        CREATE INDEX idx_memories_evidence_node ON memories(evidence_node_id) WHERE expired_at IS NULL;

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, category)
          VALUES (new.id, new.content, new.category);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.id;
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.id;
          INSERT INTO memories_fts(rowid, content, category)
          VALUES (new.id, new.content, new.category);
        END;
      `);

      // The RENAME carried memories_v3's own sequence entry over under the
      // name 'memories', seeded from the copied rows' max id — but only if
      // at least one row was copied. Bump it back up to the pre-drop
      // high-water mark (or insert it, if no rows were copied and the RENAME
      // left no entry at all).
      if (seqRow) {
        const bumped = db.prepare(
          "UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'memories'",
        ).run(seqRow.seq);
        if (bumped.changes === 0) {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('memories', ?)").run(seqRow.seq);
        }
      }

      const violations = db.pragma('foreign_key_check(memories)') as unknown[];
      if (violations.length > 0) {
        throw new Error(`memories v3 rebuild produced ${violations.length} foreign-key violations`);
      }
    });
    run();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

/**
 * Search Quality Cycle 2 (finding #4a): widen nodes_fts from (title, body) to
 * (title, aliases, path, fields, links, body). FTS5 has no ALTER, so drop the
 * contentless index and rebuild it from nodes/node_fields/relationships.
 *
 * Guarded by meta key `fts_schema_version` (absent/<2 => rebuild, then set 2).
 * NOT a search_version bump - no vectors move. On a fresh DB the nodes table is
 * empty during migration, so the repopulation loop is a harmless no-op and
 * fullIndex populates the columns via the write sites. Idempotent.
 *
 * Spec: docs/superpowers/specs/2026-07-07-search-recall-lane-richer-fts-design.md
 */
export function upgradeToRicherFts(db: Database.Database): void {
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'fts_schema_version'").get() as
    | { value: string }
    | undefined;
  if (versionRow && parseInt(versionRow.value, 10) >= 2) return;

  const run = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS nodes_fts');
    db.exec(`
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        title, aliases, path, fields, links, body,
        content='', contentless_delete=1
      )
    `);
    const insert = db.prepare(
      `INSERT INTO nodes_fts (rowid, title, aliases, path, fields, links, body)
       VALUES (@rowid, @title, @aliases, @path, @fields, @links, @body)`
    );
    const nodes = db.prepare('SELECT id, rowid FROM nodes').all() as { id: string; rowid: number }[];
    for (const n of nodes) {
      insert.run({ rowid: n.rowid, ...buildFtsRow(db, n.id) });
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('fts_schema_version', '2')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
  });
  run();
}

/**
 * Durable Memory Markdown Projection — idempotency/audit receipt ledger.
 *
 * `memory_note_receipts` keys every applied (or definitively rejected) edit
 * from `Settings/Memories.md` by `(block_key, edit_hash)` so a repeated
 * watcher/reconciler/restart delivery of the same edit is an exact no-op, and
 * maps `new:<uuid>` owner drafts to their resulting memory id. Deliberately
 * NO foreign key onto `memories`: a privacy purge must not erase or
 * invalidate the receipt — `source_memory_id` / `result_memory_id` are plain
 * integers that survive the memory they point at.
 *
 * Idempotent: every statement is `IF NOT EXISTS`. Runs after `upgradeToMemoriesV3`
 * in the boot chain and in `createTestDb`.
 *
 * Spec: docs/superpowers/plans/2026-08-13-durable-memory-markdown-projection.md
 */
export function upgradeToMemoryNoteReceipts(db: Database.Database): void {
  db.exec(`
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

/**
 * Memory history (#300): one row for each in-place change that would otherwise overwrite a
 * memory's record — a reactivation (the expiry it cleared) or a category/metadata edit
 * (the values it replaced). Content changes never land here; they version the memory and
 * keep the old row. Like `memory_note_receipts`, no foreign key onto `memories`: a purge
 * deletes the memory's history rows explicitly in the same transaction.
 *
 * Idempotent (`IF NOT EXISTS`); declared only here, and run on every boot and in
 * `createTestDb`, so fresh and existing DBs get the same table.
 */
export function upgradeToMemoryHistory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      change TEXT NOT NULL,
      reason TEXT,
      previous_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_history_memory ON memory_history(memory_id, id);
  `);
}

/**
 * Memories added without consolidation (#346): create-memory falls back to adding a
 * gray-band memory when its consolidation call fails (a spent key, an outage, an unusable
 * answer), and records it here so `replay-memory-consolidation` can re-run the decision.
 * The replay deletes a row once it has applied that memory's verdict. Like `memory_history`,
 * no foreign key onto `memories`: a purge deletes the memory's row explicitly.
 *
 * Idempotent (`IF NOT EXISTS`); declared only here, and run on every boot and in
 * `createTestDb`.
 */
/**
 * Node facts (#378, #389) were retired on 2026-11-09: project wikis went back to note evidence
 * and memories stayed the one extraction system (#352). Their tables, first named `node_items*`,
 * held derived data only, so they are dropped rather than left behind. Idempotent.
 */
export function dropRetiredNodeFacts(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS node_fact_subjects;
    DROP TABLE IF EXISTS node_facts;
    DROP TABLE IF EXISTS node_fact_extractions;
    DROP TABLE IF EXISTS node_item_subjects;
    DROP TABLE IF EXISTS node_items;
    DROP TABLE IF EXISTS node_item_extractions;
  `);
}

/**
 * `memories.changed_by` (#532): the signed-in chat client that last wrote a row through the
 * memory tools, or NULL when the suite itself wrote it. A memory keeps its `source` across
 * updates, so without this an `owner` or `curator` memory rewritten by a chat client would
 * still read as the owner's or the Curator's own words. Existing rows stay NULL.
 *
 * Idempotent; run on every boot and in `createTestDb`.
 */
export function upgradeToMemoryChangedBy(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('changed_by')) db.prepare('ALTER TABLE memories ADD COLUMN changed_by TEXT').run();
}

/**
 * What each memory is about (#554): a many-to-many link from a memory to the notes of the
 * vault map's `entityTypes`. `name` is the name as given, kept whether or not a note answered
 * to it, so a name with no note yet is matched once one does (`src/memories/subjects.ts`);
 * `name_key` is its link key. `node_id` is the note it resolved to when it was set, NULL when
 * none or several did. `set_by` says how it was set: `tool` (an MCP call), `owner` (an edit of
 * the memory note). Like `memory_history`, no foreign key onto `memories` or `nodes`: a purge
 * deletes a memory's rows in its transaction, and a deleted note leaves its links to be read
 * by name.
 *
 * Idempotent (`IF NOT EXISTS`); run on every boot and in `createTestDb`.
 */
export function upgradeToMemorySubjects(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_subjects (
      memory_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      node_id TEXT,
      set_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, name_key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_subjects_node ON memory_subjects(node_id);
    CREATE INDEX IF NOT EXISTS idx_memory_subjects_key ON memory_subjects(name_key);
  `);
}

/**
 * When a token was revoked and when an authorization code was exchanged (#533), so a second
 * presentation can be told from a first and timed against it: a rotated refresh token or an
 * exchanged code presented again signs that client out (`src/auth/provider.ts`). The auth
 * tables are created by `createAuthSchema` when the HTTP transport first starts, with both
 * columns; this adds them to tables created before that. Existing rows keep NULL. A database
 * that has never served HTTP has no auth tables, and nothing to do.
 *
 * Idempotent; run on every boot.
 */
export function upgradeToOAuthReuseTimes(db: Database.Database): void {
  const upgrades: Array<[table: string, column: string]> = [['oauth_tokens', 'revoked_at'], ['oauth_codes', 'used_at']];
  for (const [table, column] of upgrades) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (columns.length > 0 && !columns.includes(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`).run();
  }
}

export function upgradeToMemoryConsolidationPending(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_consolidation_pending (
      memory_id INTEGER PRIMARY KEY,
      failed_at TEXT NOT NULL,
      reason TEXT
    );
  `);
}

/**
 * Versions of a wiki home that only a status write produced (#547): from `base_version` up to
 * `last_version`, each write after `base_version` changed `wiki_status` alone. A wiki reconcile
 * or home refresh that read the home at any of those versions is still current
 * (`wiki/status-versions.ts`), so the Engine's background `behind` write never makes a page
 * request or a refresh fail as stale. Idempotent; run on every boot.
 */
export function upgradeToWikiStatusVersions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_status_versions (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      base_version INTEGER NOT NULL,
      last_version INTEGER NOT NULL
    );
  `);
}

export { upgradeToProvenance } from '../provenance/migrate.js';

/** Nullable classification metadata; does not activate consumers or touch node data. */
export function upgradeToEnumGroups(db: Database.Database): void {
  db.transaction(() => {
    ensureMetaTable(db);
    const global = tableColumns(db, 'global_fields');
    if (!global.has('enum_groups')) db.exec('ALTER TABLE global_fields ADD COLUMN enum_groups TEXT');
    if (!global.has('overrides_allowed_enum_groups')) db.exec('ALTER TABLE global_fields ADD COLUMN overrides_allowed_enum_groups INTEGER NOT NULL DEFAULT 0');
    if (!tableColumns(db, 'schema_field_claims').has('enum_groups_override')) db.exec('ALTER TABLE schema_field_claims ADD COLUMN enum_groups_override TEXT');
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('enum_groups_schema_version','1')").run();
  })();
}
