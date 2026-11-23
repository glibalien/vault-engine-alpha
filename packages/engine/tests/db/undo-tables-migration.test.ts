import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addGlobalFieldUndoSnapshots, addUndoLinkBindings, addUndoMemorySubjects, addUndoTables } from '../../src/db/migrate.js';

describe('addUndoTables', () => {
  it('creates undo_operations and undo_snapshots with expected columns and indexes', () => {
    const db = createTestDb();
    addUndoTables(db);

    const opCols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>);
    expect(opCols.map(c => c.name).sort()).toEqual(
      ['description', 'global_field_count', 'node_count', 'operation_id', 'schema_count', 'source_tool', 'status', 'timestamp'],
    );
    expect(opCols.find(c => c.name === 'operation_id')?.pk).toBe(1);

    const snapCols = (db.prepare('PRAGMA table_info(undo_snapshots)').all() as Array<{ name: string; pk: number }>);
    expect(snapCols.map(c => c.name).sort()).toEqual(
      ['body', 'explicit_null_fields', 'fields', 'file_only_fields', 'file_path', 'node_id', 'operation_id', 'post_mutation_hash', 'relationships', 'title', 'types', 'was_deleted'],
    );

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('undo_operations','undo_snapshots')").all() as Array<{ name: string }>).map(r => r.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_undo_operations_timestamp',
      'idx_undo_operations_status',
      'idx_undo_snapshots_node',
    ]));
  });

  it('creates global field undo snapshots and global_field_count idempotently', () => {
    const db = createTestDb();
    addGlobalFieldUndoSnapshots(db);
    expect(() => addGlobalFieldUndoSnapshots(db)).not.toThrow();

    const opCols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string }>);
    expect(opCols.map(c => c.name)).toContain('global_field_count');

    const snapCols = (db.prepare('PRAGMA table_info(undo_global_field_snapshots)').all() as Array<{ name: string }>);
    expect(snapCols.map(c => c.name).sort()).toEqual([
      'field_name',
      'global_field',
      'node_fields',
      'operation_id',
      'schema_claims',
      'was_deleted',
      'was_new',
      'was_renamed_from',
    ]);
  });

  it('adds the column for text only a file held to a table made before it (#656)', () => {
    const db = createTestDb();
    db.exec('DROP TABLE IF EXISTS undo_snapshots');
    db.exec(`CREATE TABLE undo_snapshots (
      operation_id TEXT NOT NULL, node_id TEXT NOT NULL, file_path TEXT NOT NULL, title TEXT, body TEXT, types TEXT,
      fields TEXT, relationships TEXT, explicit_null_fields TEXT, was_deleted INTEGER NOT NULL, post_mutation_hash TEXT,
      PRIMARY KEY (operation_id, node_id))`);
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, ?)').run('op1', 'n1', 'a.md', 0);
    addUndoTables(db);
    addUndoTables(db);
    const cols = (db.prepare('PRAGMA table_info(undo_snapshots)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('file_only_fields');
    expect(db.prepare('SELECT file_only_fields FROM undo_snapshots').get()).toEqual({ file_only_fields: null });
  });

  it('is idempotent — safe to run twice', () => {
    const db = createTestDb();
    addUndoTables(db);
    expect(() => addUndoTables(db)).not.toThrow();
  });

  it('cascades snapshot deletion when operation is deleted', () => {
    const db = createTestDb();
    addUndoTables(db);
    db.prepare('INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('op1', 1, 'create-node', 'desc', 1, 'active');
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, ?)')
      .run('op1', 'n1', 'a.md', 1);

    db.prepare('DELETE FROM undo_operations WHERE operation_id = ?').run('op1');
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe('addUndoLinkBindings (#665)', () => {
  it('creates the table idempotently, and its rows go with their operation', () => {
    const db = createTestDb();
    addUndoLinkBindings(db);
    expect(() => addUndoLinkBindings(db)).not.toThrow();

    const cols = (db.prepare('PRAGMA table_info(undo_link_bindings)').all() as Array<{ name: string }>).map(c => c.name).sort();
    expect(cols).toEqual(['bound_to', 'operation_id', 'rel_type', 'source_id', 'target']);

    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description) VALUES ('op1', 1, 'merge-nodes', 'merge')").run();
    db.prepare("INSERT INTO undo_link_bindings VALUES ('op1', 'n1', 'Sam Ortiz', 'wiki-link', 'n2')").run();
    db.prepare("DELETE FROM undo_operations WHERE operation_id = 'op1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM undo_link_bindings').get()).toEqual({ n: 0 });
  });
});

describe('addUndoMemorySubjects (#554)', () => {
  it('creates the table idempotently, and its rows go with their operation', () => {
    const db = createTestDb();
    addUndoMemorySubjects(db);
    expect(() => addUndoMemorySubjects(db)).not.toThrow();
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description) VALUES ('op1', 1, 'merge-nodes', 'merge')").run();
    db.prepare("INSERT INTO undo_memory_subjects VALUES ('op1', 1, 'Dana W', 'dana w', 'n2', 'tool', '2026-11-20T00:00:00.000Z', 'n1', 0)").run();
    db.prepare("DELETE FROM undo_operations WHERE operation_id = 'op1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM undo_memory_subjects').get()).toEqual({ n: 0 });
  });
});
