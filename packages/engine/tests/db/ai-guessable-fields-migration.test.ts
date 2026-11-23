import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { upgradeForAiGuessableFields } from '../../src/db/migrate.js';

function column(db: Database.Database, table: string, name: string): { dflt_value: string | null } | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; dflt_value: string | null }>)
    .find(column => column.name === name);
}

function tableInfo(db: Database.Database, table: string): Array<{ name: string; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
}

describe('upgradeForAiGuessableFields', () => {
  it('adds inert AI-guess columns to an existing database', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE global_fields (
        name TEXT PRIMARY KEY,
        field_type TEXT NOT NULL
      );
      CREATE TABLE schemas (name TEXT PRIMARY KEY);
      CREATE TABLE schema_field_claims (
        schema_name TEXT NOT NULL REFERENCES schemas(name),
        field TEXT NOT NULL REFERENCES global_fields(name),
        PRIMARY KEY (schema_name, field)
      );
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE undo_snapshots (
        operation_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        PRIMARY KEY (operation_id, node_id)
      );
    `);
    db.prepare('INSERT INTO global_fields (name, field_type) VALUES (?, ?)').run('status', 'string');
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id) VALUES (?, ?)').run('op-1', 'n1');

    upgradeForAiGuessableFields(db);
    upgradeForAiGuessableFields(db);

    expect(column(db, 'global_fields', 'ai_guessable')?.dflt_value).toBe('0');
    expect(column(db, 'global_fields', 'overrides_allowed_ai_guessable')?.dflt_value).toBe('0');
    expect(column(db, 'schema_field_claims', 'ai_guessable_override')).toBeDefined();
    expect(db.prepare('SELECT ai_guessable FROM global_fields WHERE name = ?').get('status')).toEqual({ ai_guessable: 0 });
    expect(tableInfo(db, 'node_explicit_null_fields')).toEqual([
      expect.objectContaining({ name: 'node_id', pk: 1 }),
      expect.objectContaining({ name: 'field_name', pk: 2 }),
    ]);
    expect(db.prepare(`PRAGMA foreign_key_list(node_explicit_null_fields)`).all()).toEqual([
      expect.objectContaining({ table: 'nodes', from: 'node_id', to: 'id', on_delete: 'CASCADE' }),
    ]);
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_node_explicit_null_fields_field'`,
    ).get()).toEqual({ name: 'idx_node_explicit_null_fields_field' });
    expect(column(db, 'undo_snapshots', 'explicit_null_fields')).toBeDefined();
    expect(db.prepare('SELECT explicit_null_fields FROM undo_snapshots WHERE operation_id = ?').get('op-1'))
      .toEqual({ explicit_null_fields: null });
  });
});
