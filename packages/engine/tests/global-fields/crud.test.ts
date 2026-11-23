import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  getGlobalField,
  createGlobalField,
  updateGlobalField,
  renameGlobalField,
  deleteGlobalField,
  TypeChangeRequiresDiscardError,
} from '../../src/global-fields/crud.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ── helpers ──────────────────────────────────────────────────────────

function insertNode(id: string, filePath: string): void {
  db.prepare(
    `INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`,
  ).run(id, filePath, id);
}

function insertNodeField(nodeId: string, fieldName: string, opts: {
  value_text?: string | null;
  value_number?: number | null;
  value_date?: string | null;
  value_json?: string | null;
} = {}): void {
  db.prepare(
    `INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    nodeId,
    fieldName,
    opts.value_text ?? null,
    opts.value_number ?? null,
    opts.value_date ?? null,
    opts.value_json ?? null,
  );
}

function insertExplicitNullField(nodeId: string, fieldName: string): void {
  db.prepare(
    `INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)`,
  ).run(nodeId, fieldName);
}

function insertSchema(name: string): void {
  db.prepare(
    `INSERT INTO schemas (name, field_claims) VALUES (?, '[]')`,
  ).run(name);
}

function insertFieldClaim(
  schemaName: string,
  field: string,
  aiGuessableOverride?: boolean,
): void {
  db.prepare(
    `INSERT INTO schema_field_claims (schema_name, field, ai_guessable_override) VALUES (?, ?, ?)`,
  ).run(
    schemaName,
    field,
    aiGuessableOverride === undefined ? null : aiGuessableOverride ? 1 : 0,
  );
}

// ── createGlobalField ────────────────────────────────────────────────

describe('createGlobalField', () => {
  it('creates a string field and returns the definition', () => {
    const result = createGlobalField(db, {
      name: 'title',
      field_type: 'string',
      description: 'The title',
    });
    expect(result).toEqual({
      name: 'title',
      field_type: 'string',
      enum_values: null,
      enum_groups: null,
      reference_target: null,
      description: 'The title',
      default_value: null,
      required: false,
      ai_guessable: false,
      overrides_allowed: {
        required: false,
        default_value: false,
        enum_values: false,
        enum_groups: false,
        ai_guessable: false,
      },
      list_item_type: null,
      ui_hints: null,
    });
  });

  it('creates an enum field with values', () => {
    const result = createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['active', 'archived'],
    });
    expect(result.field_type).toBe('enum');
    expect(result.enum_values).toEqual(['active', 'archived']);
  });

  it('persists AI-guessability and its override permission', () => {
    const result = createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      ai_guessable: true,
      overrides_allowed: { ai_guessable: true },
    });

    expect(result.ai_guessable).toBe(true);
    expect(result.overrides_allowed.ai_guessable).toBe(true);
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects enabling AI guessing for reserved field name %s',
    (name) => {
      expect(() => createGlobalField(db, {
        name,
        field_type: 'string',
        ai_guessable: true,
      })).toThrow(/reserved/i);
      expect(getGlobalField(db, name)).toBeNull();
    },
  );

  it('keeps reserved names available when AI guessing is disabled', () => {
    const field = createGlobalField(db, {
      name: '__proto__',
      field_type: 'string',
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true },
    });

    expect(field.ai_guessable).toBe(false);
    expect(field.overrides_allowed.ai_guessable).toBe(true);
  });

  it('creates a list field with item type', () => {
    const result = createGlobalField(db, {
      name: 'tags',
      field_type: 'list',
      list_item_type: 'string',
    });
    expect(result.field_type).toBe('list');
    expect(result.list_item_type).toBe('string');
  });

  it('rejects duplicate name', () => {
    createGlobalField(db, { name: 'title', field_type: 'string' });
    expect(() =>
      createGlobalField(db, { name: 'title', field_type: 'string' }),
    ).toThrow(/unique|duplicate|already exists/i);
  });

  it('rejects enum without enum_values', () => {
    expect(() =>
      createGlobalField(db, { name: 'status', field_type: 'enum' }),
    ).toThrow(/enum_values/i);
  });

  it('rejects list without list_item_type', () => {
    expect(() =>
      createGlobalField(db, { name: 'tags', field_type: 'list' }),
    ).toThrow(/list_item_type/i);
  });

  it('rejects nested list (list_item_type = list)', () => {
    expect(() =>
      createGlobalField(db, {
        name: 'nested',
        field_type: 'list',
        list_item_type: 'list',
      }),
    ).toThrow(/nested/i);
  });
});

// ── getGlobalField ───────────────────────────────────────────────────

describe('getGlobalField', () => {
  it('returns null for missing field', () => {
    expect(getGlobalField(db, 'nope')).toBeNull();
  });

  it('returns parsed field with correct types', () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'number',
      required: true,
      default_value: 5,
    });
    const field = getGlobalField(db, 'priority');
    expect(field).not.toBeNull();
    expect(field!.required).toBe(true);
    expect(field!.default_value).toBe(5);
  });
});

// ── renameGlobalField ────────────────────────────────────────────────

describe('renameGlobalField', () => {
  it('renames across global_fields, node_fields, and schema_field_claims atomically', () => {
    // Setup: global field, a node with that field, a schema claim
    createGlobalField(db, { name: 'old_name', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'old_name', { value_text: 'hello' });
    insertSchema('Person');
    insertFieldClaim('Person', 'old_name');

    const result = renameGlobalField(db, 'old_name', 'new_name');
    expect(result.affected_nodes).toBe(1);
    expect(result.affected_schemas).toBe(1);

    // old name gone
    expect(getGlobalField(db, 'old_name')).toBeNull();
    // new name exists
    const field = getGlobalField(db, 'new_name');
    expect(field).not.toBeNull();
    expect(field!.field_type).toBe('string');

    // node_fields updated
    const nf = db.prepare(
      `SELECT field_name FROM node_fields WHERE node_id = 'n1'`,
    ).get() as { field_name: string };
    expect(nf.field_name).toBe('new_name');

    // schema_field_claims updated
    const sfc = db.prepare(
      `SELECT field FROM schema_field_claims WHERE schema_name = 'Person'`,
    ).get() as { field: string };
    expect(sfc.field).toBe('new_name');
  });

  it('counts distinct affected nodes across valued and explicit-null storage', () => {
    createGlobalField(db, { name: 'context', field_type: 'string' });
    insertNode('dual', '/dual.md');
    insertNode('valued', '/valued.md');
    insertNode('null', '/null.md');
    insertNodeField('dual', 'context', { value_text: 'Retained rejected value' });
    insertExplicitNullField('dual', 'context');
    insertNodeField('valued', 'context', { value_text: 'Accepted value' });
    insertExplicitNullField('null', 'context');

    const result = renameGlobalField(db, 'context', 'background');

    expect(result.affected_nodes).toBe(3);
    expect(db.prepare(
      `SELECT node_id, field_name FROM node_fields ORDER BY node_id`,
    ).all()).toEqual([
      { node_id: 'dual', field_name: 'background' },
      { node_id: 'valued', field_name: 'background' },
    ]);
    expect(db.prepare(
      `SELECT node_id, field_name FROM node_explicit_null_fields ORDER BY node_id`,
    ).all()).toEqual([
      { node_id: 'dual', field_name: 'background' },
      { node_id: 'null', field_name: 'background' },
    ]);
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'atomically rejects renaming a globally AI-guessable field to reserved name %s',
    (newName) => {
      createGlobalField(db, {
        name: 'summary',
        field_type: 'string',
        ai_guessable: true,
      });
      insertNode('n1', '/n1.md');
      insertNodeField('n1', 'summary', { value_text: 'Existing summary' });
      insertSchema('Article');
      insertFieldClaim('Article', 'summary');

      expect(() => renameGlobalField(db, 'summary', newName)).toThrow(/reserved/i);

      expect(getGlobalField(db, 'summary')?.ai_guessable).toBe(true);
      expect(getGlobalField(db, newName)).toBeNull();
      expect(db.prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'Article'`).get())
        .toEqual({ field: 'summary' });
      expect(db.prepare(`SELECT field_name, value_text FROM node_fields WHERE node_id = 'n1'`).get())
        .toEqual({ field_name: 'summary', value_text: 'Existing summary' });
    },
  );

  it.each(['__proto__', 'prototype', 'constructor'])(
    'atomically rejects renaming a field with a true schema AI override to reserved name %s',
    (newName) => {
      createGlobalField(db, {
        name: 'summary',
        field_type: 'string',
        overrides_allowed: { ai_guessable: true },
      });
      insertSchema('Article');
      insertFieldClaim('Article', 'summary', true);

      expect(() => renameGlobalField(db, 'summary', newName)).toThrow(/reserved/i);

      expect(getGlobalField(db, 'summary')?.ai_guessable).toBe(false);
      expect(getGlobalField(db, newName)).toBeNull();
      expect(db.prepare(`SELECT field, ai_guessable_override FROM schema_field_claims WHERE schema_name = 'Article'`).get())
        .toEqual({ field: 'summary', ai_guessable_override: 1 });
    },
  );

  it('allows a reserved destination when global AI guessing is unset and dependent overrides are null or false', () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    insertSchema('Article');
    insertSchema('ArchivedArticle');
    insertFieldClaim('Article', 'summary');
    insertFieldClaim('ArchivedArticle', 'summary', false);

    const result = renameGlobalField(db, 'summary', 'constructor');

    expect(result.affected_schemas).toBe(2);
    expect(getGlobalField(db, 'summary')).toBeNull();
    expect(getGlobalField(db, 'constructor')).toMatchObject({
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true },
    });
    expect(db.prepare(`
      SELECT schema_name, field, ai_guessable_override
      FROM schema_field_claims
      ORDER BY schema_name
    `).all()).toEqual([
      { schema_name: 'ArchivedArticle', field: 'constructor', ai_guessable_override: 0 },
      { schema_name: 'Article', field: 'constructor', ai_guessable_override: null },
    ]);
  });

  it('rejects a rename when an explicit-null source would collide with an explicit-null target', () => {
    createGlobalField(db, { name: 'context', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertExplicitNullField('n1', 'context');
    insertExplicitNullField('n1', 'background');

    expect(() => renameGlobalField(db, 'context', 'background'))
      .toThrow(/already has.*background|background.*already exists|conflict/i);

    expect(getGlobalField(db, 'context')).not.toBeNull();
    expect(getGlobalField(db, 'background')).toBeNull();
    expect(db.prepare(
      `SELECT field_name FROM node_explicit_null_fields WHERE node_id = 'n1' ORDER BY field_name`,
    ).all()).toEqual([
      { field_name: 'background' },
      { field_name: 'context' },
    ]);
  });

  it('rejects a rename when an explicit-null source would collide with a valued target', () => {
    createGlobalField(db, { name: 'context', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertExplicitNullField('n1', 'context');
    insertNodeField('n1', 'background', { value_text: 'Existing value' });

    expect(() => renameGlobalField(db, 'context', 'background'))
      .toThrow(/already has.*background|background.*already exists|conflict/i);

    expect(getGlobalField(db, 'context')).not.toBeNull();
    expect(getGlobalField(db, 'background')).toBeNull();
    expect(db.prepare(
      `SELECT field_name FROM node_explicit_null_fields WHERE node_id = 'n1'`,
    ).all()).toEqual([{ field_name: 'context' }]);
    expect(db.prepare(
      `SELECT field_name, value_text FROM node_fields WHERE node_id = 'n1'`,
    ).all()).toEqual([{ field_name: 'background', value_text: 'Existing value' }]);
  });
});

// ── deleteGlobalField ────────────────────────────────────────────────

describe('deleteGlobalField', () => {
  it('removes from global_fields and schema_field_claims, leaves node_fields intact', () => {
    createGlobalField(db, { name: 'doomed', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'doomed', { value_text: 'still here' });
    insertSchema('Person');
    insertFieldClaim('Person', 'doomed');

    const result = deleteGlobalField(db, 'doomed');
    expect(result.affected_nodes).toBe(1);
    expect(result.affected_schemas).toBe(1);

    // global_fields gone
    expect(getGlobalField(db, 'doomed')).toBeNull();

    // schema_field_claims gone (CASCADE)
    const sfc = db.prepare(
      `SELECT COUNT(*) as cnt FROM schema_field_claims WHERE field = 'doomed'`,
    ).get() as { cnt: number };
    expect(sfc.cnt).toBe(0);

    // node_fields still present (orphaned)
    const nf = db.prepare(
      `SELECT value_text FROM node_fields WHERE field_name = 'doomed'`,
    ).get() as { value_text: string };
    expect(nf.value_text).toBe('still here');
  });

  it('counts each affected node once across valued and explicit-null storage', () => {
    createGlobalField(db, { name: 'context', field_type: 'string' });
    insertNode('dual', '/dual.md');
    insertNode('valued', '/valued.md');
    insertNode('null', '/null.md');
    insertNodeField('dual', 'context', { value_text: 'Retained rejected value' });
    insertExplicitNullField('dual', 'context');
    insertNodeField('valued', 'context', { value_text: 'Accepted value' });
    insertExplicitNullField('null', 'context');

    const result = deleteGlobalField(db, 'context');

    expect(result.affected_nodes).toBe(3);
    expect(db.prepare(
      `SELECT node_id, field_name FROM node_fields ORDER BY node_id`,
    ).all()).toEqual([
      { node_id: 'dual', field_name: 'context' },
      { node_id: 'valued', field_name: 'context' },
    ]);
    expect(db.prepare(
      `SELECT node_id, field_name FROM node_explicit_null_fields ORDER BY node_id`,
    ).all()).toEqual([
      { node_id: 'dual', field_name: 'context' },
      { node_id: 'null', field_name: 'context' },
    ]);
  });
});

// ── updateGlobalField ────────────────────────────────────────────────

describe('updateGlobalField', () => {
  it('applies AI metadata with a confirmed type change', () => {
    createGlobalField(db, { name: 'score', field_type: 'string' });

    updateGlobalField(db, 'score', {
      field_type: 'number',
      confirm: true,
      ai_guessable: true,
      overrides_allowed: { ai_guessable: true },
    });

    const field = getGlobalField(db, 'score');
    expect(field!.field_type).toBe('number');
    expect(field!.ai_guessable).toBe(true);
    expect(field!.overrides_allowed.ai_guessable).toBe(true);
  });

  it('updates AI-guessability and its override permission', () => {
    createGlobalField(db, { name: 'summary', field_type: 'string' });

    const result = updateGlobalField(db, 'summary', {
      ai_guessable: true,
      overrides_allowed: { ai_guessable: true },
    });

    expect(result.field!.ai_guessable).toBe(true);
    expect(result.field!.overrides_allowed.ai_guessable).toBe(true);
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects enabling AI guessing for existing reserved field name %s',
    (name) => {
      createGlobalField(db, { name, field_type: 'string' });

      expect(() => updateGlobalField(db, name, { ai_guessable: true }))
        .toThrow(/reserved/i);
      expect(getGlobalField(db, name)?.ai_guessable).toBe(false);
    },
  );

  it('allows explicitly disabling AI guessing for a legacy reserved field', () => {
    createGlobalField(db, { name: 'constructor', field_type: 'string' });
    db.prepare('UPDATE global_fields SET ai_guessable = 1 WHERE name = ?').run('constructor');

    const result = updateGlobalField(db, 'constructor', { ai_guessable: false });

    expect(result.field?.ai_guessable).toBe(false);
  });

  it('updates description (non-type-change)', () => {
    createGlobalField(db, { name: 'title', field_type: 'string' });
    const result = updateGlobalField(db, 'title', { description: 'Updated desc' });
    expect(result.preview).toBe(false);
    expect(result.field!.description).toBe('Updated desc');
  });

  it('type change preview without confirm returns preview, no DB change', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });

    const result = updateGlobalField(db, 'count', { field_type: 'number' });

    expect(result.preview).toBe(true);
    expect(result.applied).toBeUndefined();
    expect(result.affected_nodes).toBe(1);
    expect(result.coercible!.length).toBe(1);
    expect(result.coercible![0].new_value).toBe(42);
    expect(result.uncoercible!.length).toBe(0);

    // DB unchanged
    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('string');
  });

  it('type change with confirm and all-coercible values applies coercion', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });

    const result = updateGlobalField(db, 'count', {
      field_type: 'number',
      confirm: true,
    });

    expect(result.preview).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.coercible!.length).toBe(1);
    expect(result.uncoercible!.length).toBe(0);

    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('number');

    const n1 = db.prepare(
      `SELECT value_number, value_text FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_number: number | null; value_text: string | null };
    expect(n1.value_number).toBe(42);
    expect(n1.value_text).toBeNull();
  });

  it('type change with confirm and uncoercible values throws without discard_uncoercible flag — DB unchanged', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    expect(() =>
      updateGlobalField(db, 'count', { field_type: 'number', confirm: true }),
    ).toThrow(TypeChangeRequiresDiscardError);

    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('string');

    const n1 = db.prepare(
      `SELECT value_text FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_text: string };
    expect(n1.value_text).toBe('42');
    const n2 = db.prepare(
      `SELECT value_text FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`,
    ).get() as { value_text: string };
    expect(n2.value_text).toBe('not-a-number');

    const editsCount = (
      db.prepare(`SELECT COUNT(*) as c FROM edits_log WHERE event_type = 'value-removed'`).get() as { c: number }
    ).c;
    expect(editsCount).toBe(0);
  });

  it('TypeChangeRequiresDiscardError carries affected_nodes, coercible_count, and uncoercible array', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    let caught: TypeChangeRequiresDiscardError | undefined;
    try {
      updateGlobalField(db, 'count', { field_type: 'number', confirm: true });
    } catch (err) {
      if (err instanceof TypeChangeRequiresDiscardError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.details.affected_nodes).toBe(2);
    expect(caught!.details.coercible_count).toBe(1);
    expect(caught!.details.uncoercible).toHaveLength(1);
    expect(caught!.details.uncoercible[0].node_id).toBe('n2');
    expect(caught!.details.uncoercible[0].value).toBe('not-a-number');
  });

  it('type change with confirm and discard_uncoercible:true applies and removes uncoercible row', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    const result = updateGlobalField(db, 'count', {
      field_type: 'number',
      confirm: true,
      discard_uncoercible: true,
    });

    expect(result.preview).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.coercible!.length).toBe(1);
    expect(result.uncoercible!.length).toBe(1);

    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('number');

    const n1 = db.prepare(
      `SELECT value_number FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_number: number };
    expect(n1.value_number).toBe(42);

    const n2 = db.prepare(
      `SELECT * FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`,
    ).get();
    expect(n2).toBeUndefined();

    const log = db
      .prepare(`SELECT event_type, details FROM edits_log WHERE event_type = 'value-removed'`)
      .get() as { event_type: string; details: string };
    expect(log).toBeDefined();
    expect(JSON.parse(log.details).removed_value).toBe('not-a-number');
  });

  it('rejects clearing enum_values on an enum field', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
    expect(() => updateGlobalField(db, 'status', { enum_values: [] })).toThrow(/enum_values/);
  });

  it('rejects clearing list_item_type on a list field', () => {
    createGlobalField(db, { name: 'tags', field_type: 'list', list_item_type: 'string' });
    // Attempting to set list_item_type to null should fail
    expect(() => updateGlobalField(db, 'tags', { list_item_type: undefined as any })).not.toThrow();
    // But explicitly setting it to something invalid should fail
    expect(() => updateGlobalField(db, 'tags', { list_item_type: 'list' as any })).toThrow(/nested/i);
  });
});
