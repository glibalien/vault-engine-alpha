import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createOperation } from '../../src/undo/operation.js';
import { createGlobalField, renameGlobalField } from '../../src/global-fields/crud.js';
import {
  captureGlobalFieldSnapshot,
  restoreGlobalFieldSnapshot,
  GLOBAL_FIELD_COLUMNS,
  SCHEMA_FIELD_CLAIM_COLUMNS,
  NODE_FIELD_COLUMNS,
} from '../../src/undo/global-field-snapshot.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function opId(): string {
  return createOperation(db, { source_tool: 'test', description: 'test' });
}

function seedField(name = 'status'): void {
  createGlobalField(db, {
    name,
    field_type: 'enum',
    enum_values: ['open', 'closed'],
    reference_target: 'task',
    description: 'Original description',
    default_value: 'open',
    required: true,
    ai_guessable: true,
    overrides_allowed: { required: true, default_value: true, enum_values: true, ai_guessable: true },
    list_item_type: 'string',
  });
}

function seedSchemaClaim(field = 'status'): void {
  db.prepare(`
    INSERT INTO schemas (name, display_name, field_claims)
    VALUES ('task', 'Task', '[]')
  `).run();
  db.prepare(`
    INSERT INTO schema_field_claims (
      schema_name, field, label, description, sort_order,
      required_override, default_value_override, default_value_overridden, enum_values_override, ai_guessable_override
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task', field, 'Status', 'Claim description', 7, 0, JSON.stringify('closed'), 1, JSON.stringify(['open']), 0);
}

function seedNodeField(field = 'status'): void {
  db.prepare(`
    INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
    VALUES ('n1', 'n1.md', 'N1', 'Body', 'h', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO node_fields (
      node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('n1', field, 'open', null, null, null, 'open', 'frontmatter');
}

describe('global-field undo snapshots', () => {
  it('restores legacy snapshots with missing AI metadata as false', () => {
    seedField();
    const operationId = opId();
    const legacyGlobalField = {
      name: 'status',
      field_type: 'enum',
      enum_values: JSON.stringify(['open', 'closed']),
      reference_target: 'task',
      description: 'Original description',
      default_value: JSON.stringify('open'),
      required: 1,
      overrides_allowed_required: 1,
      overrides_allowed_default_value: 1,
      overrides_allowed_enum_values: 1,
      list_item_type: 'string',
      ui_hints: null,
    };
    db.prepare(`
      INSERT INTO undo_global_field_snapshots (
        operation_id, field_name, was_new, was_deleted, was_renamed_from,
        global_field, schema_claims, node_fields
      ) VALUES (?, ?, 0, 0, NULL, ?, '[]', '[]')
    `).run(operationId, 'status', JSON.stringify(legacyGlobalField));
    db.prepare(`DELETE FROM global_fields WHERE name = 'status'`).run();

    expect(() => restoreGlobalFieldSnapshot(db, operationId, 'status')).not.toThrow();
    expect(db.prepare(`SELECT ai_guessable, overrides_allowed_ai_guessable FROM global_fields WHERE name = 'status'`).get())
      .toEqual({ ai_guessable: 0, overrides_allowed_ai_guessable: 0 });
  });

  it('capture/restore update round trip restores every global_fields column', () => {
    seedField();
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'status');

    db.prepare(`
      UPDATE global_fields
      SET field_type = 'string',
          enum_values = NULL,
          reference_target = NULL,
          description = 'Changed',
          default_value = NULL,
          required = 0,
          ai_guessable = 0,
          overrides_allowed_required = 0,
          overrides_allowed_default_value = 0,
          overrides_allowed_enum_values = 0,
          overrides_allowed_ai_guessable = 0,
          list_item_type = NULL
      WHERE name = 'status'
    `).run();

    restoreGlobalFieldSnapshot(db, op, 'status');
    const row = db.prepare(`SELECT ${GLOBAL_FIELD_COLUMNS.join(', ')} FROM global_fields WHERE name = 'status'`).get() as Record<string, unknown>;

    expect(row).toMatchObject({
      name: 'status',
      field_type: 'enum',
      enum_values: JSON.stringify(['open', 'closed']),
      reference_target: 'task',
      description: 'Original description',
      default_value: JSON.stringify('open'),
      required: 1,
      ai_guessable: 1,
      overrides_allowed_required: 1,
      overrides_allowed_default_value: 1,
      overrides_allowed_enum_values: 1,
      overrides_allowed_ai_guessable: 1,
      list_item_type: 'string',
    });
  });

  it('capture/restore delete round trip restores schema claims and node field values', () => {
    seedField();
    seedSchemaClaim();
    seedNodeField();
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'status', { was_deleted: true });

    db.prepare(`DELETE FROM schema_field_claims WHERE field = 'status'`).run();
    db.prepare(`DELETE FROM node_fields WHERE field_name = 'status'`).run();
    db.prepare(`DELETE FROM global_fields WHERE name = 'status'`).run();

    restoreGlobalFieldSnapshot(db, op, 'status');

    const claim = db.prepare(`SELECT ${SCHEMA_FIELD_CLAIM_COLUMNS.join(', ')} FROM schema_field_claims WHERE field = 'status'`).get();
    const nodeField = db.prepare(`SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE node_id = 'n1' AND field_name = 'status'`).get();
    expect(claim).toMatchObject({ schema_name: 'task', field: 'status', label: 'Status', sort_order: 7, ai_guessable_override: 0 });
    expect(nodeField).toMatchObject({ node_id: 'n1', field_name: 'status', value_text: 'open', value_raw_text: 'open', source: 'frontmatter' });
  });

  it('capture/restore create undo removes the created field and its claims and keeps note values (#468)', () => {
    seedNodeField();
    const before = db.prepare(`SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE field_name = 'status'`).all();
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'status', { was_new: true });
    seedField();
    seedSchemaClaim();

    const action = restoreGlobalFieldSnapshot(db, op, 'status');

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM schema_field_claims WHERE field = 'status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE field_name = 'status'`).all()).toEqual(before);
    // No note is rewritten; the catalog and the claiming schema are.
    expect(action).toEqual({ renderFieldsCatalog: true, schemaNames: ['task'], nodeIds: [] });
  });

  it('undoes a create snapshot the previous version wrote, with no recorded values, without deleting values', () => {
    seedNodeField();
    const before = db.prepare(`SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE field_name = 'status'`).all();
    const op = opId();
    // The shape Engine stored for a creation before #468: a marker row and no node values.
    db.prepare(`
      INSERT INTO undo_global_field_snapshots (
        operation_id, field_name, was_new, was_deleted, was_renamed_from,
        global_field, schema_claims, node_fields
      ) VALUES (?, 'status', 1, 0, NULL, NULL, '[]', '[]')
    `).run(op);
    seedField();

    restoreGlobalFieldSnapshot(db, op, 'status');

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE field_name = 'status'`).all()).toEqual(before);
  });

  it('rename restore returns the old name and removes the new name', () => {
    seedField('old_status');
    seedSchemaClaim('old_status');
    seedNodeField('old_status');
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'new_status', { was_renamed_from: 'old_status' });

    renameGlobalField(db, 'old_status', 'new_status');

    restoreGlobalFieldSnapshot(db, op, 'new_status');

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'new_status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM global_fields WHERE name = 'old_status'`).get()).toEqual({ name: 'old_status' });
    expect(db.prepare(`SELECT field FROM schema_field_claims WHERE field = 'old_status'`).get()).toEqual({ field: 'old_status' });
    expect(db.prepare(`SELECT field_name FROM node_fields WHERE field_name = 'old_status'`).get()).toEqual({ field_name: 'old_status' });
  });

  it('shared column-list constants cover current table columns', () => {
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(c => c.name);

    expect([...GLOBAL_FIELD_COLUMNS]).toEqual(cols('global_fields'));
    expect([...SCHEMA_FIELD_CLAIM_COLUMNS]).toEqual(cols('schema_field_claims'));
    expect([...NODE_FIELD_COLUMNS]).toEqual(cols('node_fields'));
  });
});

it('restores global groups and permission through rename undo without losing the override', () => {
  createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['ready'], enum_groups: { version: 1, groups: [{ name: 'active', values: ['ready'] }] }, overrides_allowed: { enum_groups: true } });
  db.prepare("INSERT INTO schemas(name) VALUES('task')").run();
  db.prepare("INSERT INTO schema_field_claims(schema_name,field,enum_groups_override) VALUES('task','status',?)").run(JSON.stringify({version:1,groups:[]}));
  const op = opId(); captureGlobalFieldSnapshot(db, op, 'phase', { was_renamed_from: 'status' });
  renameGlobalField(db, 'status', 'phase'); restoreGlobalFieldSnapshot(db, op, 'phase');
  expect(db.prepare("SELECT enum_groups,overrides_allowed_enum_groups FROM global_fields WHERE name='status'").get()).toEqual({enum_groups:JSON.stringify({version:1,groups:[{name:'active',values:['ready']}]}),overrides_allowed_enum_groups:1});
  expect(db.prepare('SELECT field,enum_groups_override FROM schema_field_claims').get()).toEqual({field:'status',enum_groups_override:JSON.stringify({version:1,groups:[]})});
});
