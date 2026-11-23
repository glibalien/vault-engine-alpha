import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField, updateGlobalField } from '../../src/global-fields/crud.js';
import {
  getSchemaDefinition,
  createSchemaDefinition,
  updateSchemaDefinition,
  patchSchemaDefinition,
  deleteSchemaDefinition,
} from '../../src/schema/crud.js';
import { SchemaValidationError } from '../../src/schema/errors.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();

  // Seed global fields used across tests
  createGlobalField(db, { name: 'due_date', field_type: 'date' });
  createGlobalField(db, { name: 'priority', field_type: 'number' });
  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed'],
  });
});

// ── getSchemaDefinition ──────────────────────────────────────────────

describe('getSchemaDefinition', () => {
  it('returns null for missing schema', () => {
    expect(getSchemaDefinition(db, 'nonexistent')).toBeNull();
  });

  it('returns the schema after creation', () => {
    createSchemaDefinition(db, {
      name: 'Task',
      display_name: 'Task',
      field_claims: [],
    });
    const schema = getSchemaDefinition(db, 'Task');
    expect(schema).not.toBeNull();
    expect(schema!.name).toBe('Task');
    expect(schema!.display_name).toBe('Task');
  });
});

// ── createSchemaDefinition ───────────────────────────────────────────

describe('createSchemaDefinition', () => {
  it('creates schema with field claims and stores them in schema_field_claims', () => {
    const schema = createSchemaDefinition(db, {
      name: 'Task',
      display_name: 'Task',
      icon: '✅',
      field_claims: [
        { field: 'due_date', label: 'Due', sort_order: 1 },
        { field: 'priority', sort_order: 2 },
        { field: 'status', sort_order: 3 },
      ],
    });

    expect(schema.name).toBe('Task');
    expect(schema.display_name).toBe('Task');
    expect(schema.icon).toBe('✅');

    // Verify claims in DB
    const claims = db
      .prepare(`SELECT * FROM schema_field_claims WHERE schema_name = 'Task' ORDER BY sort_order`)
      .all() as Array<{ field: string; label: string | null; sort_order: number | null }>;

    expect(claims).toHaveLength(3);
    expect(claims[0].field).toBe('due_date');
    expect(claims[0].label).toBe('Due');
    expect(claims[1].field).toBe('priority');
    expect(claims[2].field).toBe('status');
  });

  it('stores required and default_value on claims as integer and JSON', () => {
    // Need a field with overrides_allowed to set required/default_value
    createGlobalField(db, {
      name: 'flexible_field',
      field_type: 'string',
      overrides_allowed: { required: true, default_value: true },
    });

    createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [
        { field: 'flexible_field', required: true, default_value: 'pending' },
      ],
    });

    const claim = db
      .prepare(`SELECT required_override, default_value_override, default_value_overridden FROM schema_field_claims WHERE schema_name = 'Task' AND field = 'flexible_field'`)
      .get() as { required_override: number | null; default_value_override: string | null; default_value_overridden: number };

    expect(claim.required_override).toBe(1);
    expect(claim.default_value_override).toBe(JSON.stringify('pending'));
    expect(claim.default_value_overridden).toBe(1);
  });

  it('stores an allowed AI-guessability override on claims', () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });

    createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [{ field: 'summary', ai_guessable: false }],
    });

    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'Task' AND field = 'summary'`).get())
      .toEqual({ ai_guessable_override: 0 });
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects enabling AI guessing through a schema override for reserved field %s',
    (field) => {
      createGlobalField(db, {
        name: field,
        field_type: 'string',
        overrides_allowed: { ai_guessable: true },
      });

      let caught: unknown;
      try {
        createSchemaDefinition(db, {
          name: 'Task',
          field_claims: [{ field, ai_guessable: true }],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaValidationError);
      expect((caught as SchemaValidationError).groups).toEqual([
        expect.objectContaining({
          reason: 'STRUCTURAL_INCOMPAT',
          field,
          message: expect.stringMatching(/reserved/i),
        }),
      ]);
    },
  );

  it('preserves disabling and null overrides for reserved fields', () => {
    createGlobalField(db, {
      name: 'constructor',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [{ field: 'constructor', ai_guessable: false }],
    });
    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'Task' AND field = 'constructor'`).get())
      .toEqual({ ai_guessable_override: 0 });

    updateSchemaDefinition(db, 'Task', {
      field_claims: [{ field: 'constructor' }],
    });

    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'Task' AND field = 'constructor'`).get())
      .toEqual({ ai_guessable_override: null });
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects updating a schema to enable AI guessing for reserved field %s',
    (field) => {
      createGlobalField(db, {
        name: field,
        field_type: 'string',
        overrides_allowed: { ai_guessable: true },
      });
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field }],
      });

      expect(() => updateSchemaDefinition(db, 'Task', {
        field_claims: [{ field, ai_guessable: true }],
      })).toThrow(SchemaValidationError);
      expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'Task' AND field = ?`).get(field))
        .toEqual({ ai_guessable_override: null });
    },
  );

  it('rejects AI-guessability override without permission', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'due_date', ai_guessable: true }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].reason).toBe('OVERRIDE_NOT_ALLOWED');
  });

  it('does not let a direct caller bypass AI override permission during creation', () => {
    const bypassClaim = {
      field: 'due_date',
      ai_guessable: true,
      preserve_ai_guessable_override: true,
    };

    expect(() => createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [bypassClaim],
    })).toThrow(SchemaValidationError);
  });

  it('rejects claim for nonexistent global field', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'nonexistent_field' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/Global field 'nonexistent_field' does not exist/);
  });

  it('rejects required override without overrides_allowed.required', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/overrides_allowed\.required/);
  });

  it('rejects default_value override without overrides_allowed.default_value', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'priority', default_value: 5 }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/overrides_allowed\.default_value/);
  });

  it('allows semantic override when overrides_allowed is true', () => {
    createGlobalField(db, {
      name: 'overridable',
      field_type: 'string',
      overrides_allowed: { required: true, default_value: true },
    });

    expect(() =>
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'overridable', required: true, default_value: 'hello' }],
      }),
    ).not.toThrow();
  });

  it('stores metadata as parsed JSON', () => {
    const meta = { color: 'blue', tags: ['a', 'b'] };
    const schema = createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [],
      metadata: meta,
    });
    expect(schema.metadata).toEqual(meta);
  });
});

// ── updateSchemaDefinition ───────────────────────────────────────────

describe('updateSchemaDefinition', () => {
  beforeEach(() => {
    createSchemaDefinition(db, {
      name: 'Task',
      display_name: 'Task',
      field_claims: [
        { field: 'due_date' },
        { field: 'priority' },
      ],
    });
  });

  it('full replaces field claims when field_claims provided', () => {
    updateSchemaDefinition(db, 'Task', {
      field_claims: [{ field: 'status' }],
    });

    const claims = db
      .prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'Task'`)
      .all() as Array<{ field: string }>;

    expect(claims).toHaveLength(1);
    expect(claims[0].field).toBe('status');
  });

  it('leaves claims untouched when field_claims not provided', () => {
    updateSchemaDefinition(db, 'Task', {
      display_name: 'Updated Task',
    });

    const claims = db
      .prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'Task' ORDER BY field`)
      .all() as Array<{ field: string }>;

    expect(claims).toHaveLength(2);

    const schema = getSchemaDefinition(db, 'Task');
    expect(schema!.display_name).toBe('Updated Task');
  });

  it('validates new claims during update (rejects nonexistent field)', () => {
    let caught: unknown = null;
    try {
      updateSchemaDefinition(db, 'Task', {
        field_claims: [{ field: 'ghost_field' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/Global field 'ghost_field' does not exist/);
  });

  it('does not let a direct caller bypass AI override permission during replacement', () => {
    const bypassClaim = {
      field: 'due_date',
      ai_guessable: true,
      preserve_ai_guessable_override: true,
    };

    expect(() => updateSchemaDefinition(db, 'Task', {
      field_claims: [bypassClaim],
    })).toThrow(SchemaValidationError);
  });

  it('rejects a full replacement that repeats an override after permission is disabled', () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    updateSchemaDefinition(db, 'Task', {
      field_claims: [{ field: 'summary', ai_guessable: true }],
    });
    updateGlobalField(db, 'summary', { overrides_allowed: { ai_guessable: false } });

    expect(() => updateSchemaDefinition(db, 'Task', {
      field_claims: [{ field: 'summary', ai_guessable: true }],
    })).toThrow(SchemaValidationError);
  });

  it('rejects caller-supplied preservation context on every exported claim CRUD surface', () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    updateSchemaDefinition(db, 'Task', {
      field_claims: [{ field: 'summary', ai_guessable: true }],
    });
    updateGlobalField(db, 'summary', { overrides_allowed: { ai_guessable: false } });

    const forgedContext = {
      preserved_ai_guessable_overrides: new Map([['summary', true]]),
    };

    expect(() => Reflect.apply(createSchemaDefinition, undefined, [
      db,
      { name: 'Forged', field_claims: [{ field: 'summary', ai_guessable: true }] },
      forgedContext,
    ])).toThrow(SchemaValidationError);
    expect(() => Reflect.apply(updateSchemaDefinition, undefined, [
      db,
      'Task',
      { field_claims: [{ field: 'summary', ai_guessable: true }] },
      forgedContext,
    ])).toThrow(SchemaValidationError);
  });

  it('validates semantic overrides during update', () => {
    let caught: unknown = null;
    try {
      updateSchemaDefinition(db, 'Task', {
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/overrides_allowed\.required/);
  });

  it('throws when schema does not exist', () => {
    expect(() =>
      updateSchemaDefinition(db, 'NonExistent', { display_name: 'x' }),
    ).toThrow(/not found/i);
  });

  it('updates metadata without touching claims', () => {
    updateSchemaDefinition(db, 'Task', {
      metadata: { version: 2 },
    });

    const schema = getSchemaDefinition(db, 'Task');
    expect(schema!.metadata).toEqual({ version: 2 });

    const claims = db
      .prepare(`SELECT COUNT(*) as cnt FROM schema_field_claims WHERE schema_name = 'Task'`)
      .get() as { cnt: number };
    expect(claims.cnt).toBe(2);
  });
});

// ── patchSchemaDefinition ────────────────────────────────────────────

describe('patchSchemaDefinition', () => {
  beforeEach(() => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'Article',
      field_claims: [{ field: 'summary', ai_guessable: true }],
    });
    updateGlobalField(db, 'summary', { overrides_allowed: { ai_guessable: false } });
  });

  it('derives omitted AI override preservation from the stored claim', () => {
    patchSchemaDefinition(db, 'Article', {
      update_field_claims: [{ field: 'summary', label: 'Summary' }],
    });

    expect(db.prepare(
      `SELECT label, ai_guessable_override FROM schema_field_claims WHERE schema_name = 'Article' AND field = 'summary'`,
    ).get()).toEqual({ label: 'Summary', ai_guessable_override: 1 });
  });

  it('permission-gates an explicit equal AI value even with forged context', () => {
    expect(() => Reflect.apply(patchSchemaDefinition, undefined, [
      db,
      'Article',
      { update_field_claims: [{ field: 'summary', ai_guessable: true }] },
      { preserved_ai_guessable_overrides: new Map([['summary', true]]) },
    ])).toThrow(SchemaValidationError);
  });

  it('rejects a full replacement smuggled into the patch input', () => {
    expect(() => Reflect.apply(patchSchemaDefinition, undefined, [
      db,
      'Article',
      {
        update_field_claims: [{ field: 'summary', label: 'Summary' }],
        field_claims: [{ field: 'summary', ai_guessable: true }],
        preserved_ai_guessable_overrides: new Map([['summary', true]]),
      },
    ])).toThrow(/full replacement/);
  });
});

describe('patchSchemaDefinition required override preservation', () => {
  beforeEach(() => {
    updateGlobalField(db, 'status', { overrides_allowed: { required: true } });
    createSchemaDefinition(db, { name: 'Task', field_claims: [{ field: 'status', required: true }] });
    updateGlobalField(db, 'status', { overrides_allowed: { required: false } });
  });

  it.each([true, false])('preserves an omitted stored required=%s override', (required) => {
    // Historical claims can outlive the permission that originally allowed them.
    db.prepare("UPDATE schema_field_claims SET required_override = ? WHERE schema_name = 'Task'").run(Number(required));
    patchSchemaDefinition(db, 'Task', { update_field_claims: [{ field: 'status', label: 'State' }] });
    expect(db.prepare("SELECT required_override, label FROM schema_field_claims WHERE schema_name = 'Task'").get())
      .toEqual({ required_override: Number(required), label: 'State' });
  });

  it.each([true, false])('rejects an explicit required=%s patch without permission', (required) => {
    expect(() => patchSchemaDefinition(db, 'Task', { update_field_claims: [{ field: 'status', required }] }))
      .toThrow(SchemaValidationError);
    expect(db.prepare("SELECT required_override FROM schema_field_claims WHERE schema_name = 'Task'").get())
      .toEqual({ required_override: 1 });
  });

  it('does not allow callers to forge preservation context', () => {
    expect(() => Reflect.apply(patchSchemaDefinition, undefined, [db, 'Task',
      { update_field_claims: [{ field: 'status', required: true }] },
      new Map(), new Map([['status', true]]),
    ])).toThrow(SchemaValidationError);
  });

  it('rejects new and full-replacement required overrides without permission', () => {
    expect(() => createSchemaDefinition(db, { name: 'Other', field_claims: [{ field: 'status', required: true }] }))
      .toThrow(SchemaValidationError);
    expect(() => patchSchemaDefinition(db, 'Task', { add_field_claims: [{ field: 'priority', required: false }] }))
      .toThrow(SchemaValidationError);
    expect(() => updateSchemaDefinition(db, 'Task', { field_claims: [{ field: 'status', required: true }] }))
      .toThrow(SchemaValidationError);
  });

  it('allows explicit changes when permission is enabled and removes claims normally', () => {
    updateGlobalField(db, 'status', { overrides_allowed: { required: true } });
    patchSchemaDefinition(db, 'Task', { update_field_claims: [{ field: 'status', required: false }] });
    expect(db.prepare("SELECT required_override FROM schema_field_claims WHERE schema_name = 'Task'").get())
      .toEqual({ required_override: 0 });
    updateGlobalField(db, 'status', { overrides_allowed: { required: false } });
    patchSchemaDefinition(db, 'Task', { remove_field_claims: ['status'] });
    expect(db.prepare("SELECT * FROM schema_field_claims WHERE schema_name = 'Task'").all()).toEqual([]);
  });
});

// ── deleteSchemaDefinition ──────────────────────────

describe('deleteSchemaDefinition', () => {
  it('removes schema and claims via CASCADE, leaves node_types intact', () => {
    createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [{ field: 'due_date' }, { field: 'priority' }],
    });

    // Insert a node with this type to simulate node_types rows
    db.prepare(`INSERT INTO nodes (id, file_path) VALUES ('n1', '/n1.md')`).run();
    db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('n1', 'Task')`).run();

    const result = deleteSchemaDefinition(db, 'Task');
    expect(result.affected_nodes).toBe(1);

    // Schema gone
    expect(getSchemaDefinition(db, 'Task')).toBeNull();

    // Claims gone (CASCADE)
    const claims = db
      .prepare(`SELECT COUNT(*) as cnt FROM schema_field_claims WHERE schema_name = 'Task'`)
      .get() as { cnt: number };
    expect(claims.cnt).toBe(0);

    // node_types row still present
    const nt = db
      .prepare(`SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = 'Task'`)
      .get() as { cnt: number };
    expect(nt.cnt).toBe(1);
  });

  it('throws when schema does not exist', () => {
    expect(() => deleteSchemaDefinition(db, 'NoSuchSchema')).toThrow(/not found/i);
  });
});

// ── SchemaValidationError path ──────────────────────────────────────

describe('validateClaims throws SchemaValidationError', () => {
  it('UNKNOWN_FIELD: claim referencing nonexistent global field', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'nonexistent' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('UNKNOWN_FIELD');
    expect(err.groups[0].field).toBe('nonexistent');
    expect(err.groups[0].count).toBe(1);
  });

  it('OVERRIDE_NOT_ALLOWED: required override without overrides_allowed.required', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('OVERRIDE_NOT_ALLOWED');
    expect(err.groups[0].field).toBe('due_date');
  });

  it('STRUCTURAL_INCOMPAT: enum override on non-enum field', () => {
    // Allow the override so we reach the structural check
    createGlobalField(db, {
      name: 'body_text',
      field_type: 'string',
      overrides_allowed: { enum_values: true },
    });

    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'body_text', enum_values_override: ['a', 'b'] }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('STRUCTURAL_INCOMPAT');
    expect(err.groups[0].field).toBe('body_text');
  });

  it('aggregates multiple claim-level failures into one throw (does not short-circuit)', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [
          { field: 'nonexistent_a' },
          { field: 'nonexistent_b' },
          { field: 'due_date', required: true }, // OVERRIDE_NOT_ALLOWED
        ],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(3);
  });
});
