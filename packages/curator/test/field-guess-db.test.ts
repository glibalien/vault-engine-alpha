import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../src/db/migrate.js';
import {
  createFieldGuessTables,
  insertFieldGuessAttempts,
  terminalFieldGuessFields,
} from '../src/db/field-guess.js';
import {
  FIELD_GUESS_ACTION_MAX_CHARS,
  FIELD_GUESS_ERROR_MAX_CHARS,
  FIELD_GUESS_REASON_MAX_CHARS,
  FIELD_GUESS_VALUE_JSON_MAX_CHARS,
  type FieldGuessAttemptInput,
  type FieldGuessOutcome,
  type FieldGuessTerminalLookup,
} from '../src/field-guess/types.js';

function db(): Database.Database {
  const database = new Database(':memory:');
  runMigrations(database);
  return database;
}

function attempt(overrides: Partial<FieldGuessAttemptInput> = {}): FieldGuessAttemptInput {
  return {
    run_ref: 'run-1',
    call_ref: 'call-1',
    node_id: 'node-1',
    field_name: 'status',
    content_hash: 'content-1',
    definition_hash: 'definition-1',
    model: 'accounts/fireworks/models/gpt-oss-120b',
    classifier_version: 1,
    evidence_hash: 'evidence-1',
    evidence_version: 1,
    outcome: 'abstained',
    proposed_value: null,
    reason: null,
    error: null,
    action: null,
    attempted_at: '2026-08-25T12:00:00.000Z',
    ...overrides,
  };
}

function lookup(overrides: Partial<FieldGuessTerminalLookup> = {}): FieldGuessTerminalLookup {
  return {
    nodeId: 'node-1',
    contentHash: 'content-1',
    model: 'accounts/fireworks/models/gpt-oss-120b',
    classifierVersion: 1,
    evidenceHash: 'evidence-1',
    evidenceVersion: 1,
    fields: [{ field: 'status', definitionHash: 'definition-1' }],
    ...overrides,
  };
}

type AttemptRow = {
  id: number;
  run_ref: string;
  call_ref: string;
  node_id: string;
  field_name: string;
  content_hash: string;
  definition_hash: string;
  model: string;
  classifier_version: number;
  outcome: string;
  proposed_value_json: string | null;
  reason: string | null;
  error: string | null;
  action: string | null;
  attempted_at: string;
};

function rows(database: Database.Database): AttemptRow[] {
  return database.prepare('SELECT * FROM field_guess_attempts ORDER BY id').all() as AttemptRow[];
}

describe('field_guess_attempts migration 11', () => {
  it('creates the amended append-only schema, exact terminal index, and no Engine-node foreign key', () => {
    const database = db();
    expect(database.pragma('user_version', { simple: true })).toBe(41);
    expect((database.prepare('PRAGMA table_info(field_guess_attempts)').all() as Array<{
      name: string; type: string; notnull: number; pk: number;
    }>).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'run_ref', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'call_ref', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'node_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'field_name', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'content_hash', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'definition_hash', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'model', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'classifier_version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'outcome', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'proposed_value_json', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'reason', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'error', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'action', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'attempted_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'evidence_hash', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'evidence_version', type: 'INTEGER', notnull: 0, pk: 0 },
    ]);
    expect((database.prepare('PRAGMA index_info(idx_field_guess_terminal_lookup)').all() as Array<{
      name: string;
    }>).map(column => column.name)).toEqual([
      'node_id', 'field_name', 'content_hash', 'definition_hash', 'model', 'classifier_version', 'evidence_hash', 'evidence_version', 'outcome',
    ]);
    expect(database.prepare('PRAGMA foreign_key_list(field_guess_attempts)').all()).toEqual([]);
  });

  it('refuses to adopt a partial pre-existing attempt table and leaves migration 11 unapplied', () => {
    const database = new Database(':memory:');
    runMigrations(database, []);
    database.exec(`
      CREATE TABLE field_guess_attempts (
        id INTEGER PRIMARY KEY,
        node_id TEXT,
        field_name TEXT,
        content_hash TEXT,
        definition_hash TEXT,
        model TEXT,
        classifier_version INTEGER,
        outcome TEXT
      );
    `);
    database.pragma('user_version = 10');

    expect(() => runMigrations(database)).toThrow(/field_guess_attempts.*already exists/i);
    expect(database.pragma('user_version', { simple: true })).toBe(10);
    expect((database.prepare('PRAGMA table_info(field_guess_attempts)').all() as Array<{
      name: string;
    }>).map(column => column.name)).toEqual([
      'id', 'node_id', 'field_name', 'content_hash', 'definition_hash',
      'model', 'classifier_version', 'outcome',
    ]);
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_field_guess_terminal_lookup'",
    ).get()).toBeUndefined();
  });

  it('rolls migration 11 back when the terminal index name belongs to an incompatible object', () => {
    const database = new Database(':memory:');
    runMigrations(database, []);
    database.exec(`
      CREATE TABLE collision_holder (id INTEGER PRIMARY KEY);
      CREATE INDEX idx_field_guess_terminal_lookup ON collision_holder (id);
    `);
    database.pragma('user_version = 10');

    expect(() => runMigrations(database)).toThrow(/idx_field_guess_terminal_lookup.*already exists/i);
    expect(database.pragma('user_version', { simple: true })).toBe(10);
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='field_guess_attempts'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_field_guess_terminal_lookup'",
    ).get()).toEqual({ tbl_name: 'collision_holder' });
  });

  it('treats the raw migration creator as strict rather than independently idempotent', () => {
    const database = new Database(':memory:');
    createFieldGuessTables(database);
    expect(() => createFieldGuessTables(database)).toThrow(/field_guess_attempts.*already exists/i);
  });
});

describe('insertFieldGuessAttempts', () => {
  it('accepts exactly the eight outcomes and preserves run, call, timestamp, and nullable tracking', () => {
    const database = db();
    const outcomes: FieldGuessOutcome[] = [
      'set', 'abstained', 'rejected_value', 'rejected_reference',
      'reference_error', 'provider_error', 'stale_node', 'mutation_error',
    ];
    insertFieldGuessAttempts(database, outcomes.map((outcome, index) => attempt({
      call_ref: `call-${index}`,
      field_name: `field-${index}`,
      outcome,
    })));

    expect(rows(database).map(row => ({
      run_ref: row.run_ref,
      call_ref: row.call_ref,
      outcome: row.outcome,
      proposed_value_json: row.proposed_value_json,
      reason: row.reason,
      error: row.error,
      action: row.action,
      attempted_at: row.attempted_at,
    }))).toEqual(outcomes.map((outcome, index) => ({
      run_ref: 'run-1',
      call_ref: `call-${index}`,
      outcome,
      proposed_value_json: null,
      reason: null,
      error: null,
      action: null,
      attempted_at: '2026-08-25T12:00:00.000Z',
    })));
  });

  it('always appends duplicate attempts instead of updating or upserting', () => {
    const database = db();
    insertFieldGuessAttempts(database, [attempt()]);
    insertFieldGuessAttempts(database, [attempt({ reason: 'second observation' })]);

    expect(rows(database).map(row => ({ id: row.id, reason: row.reason }))).toEqual([
      { id: 1, reason: null },
      { id: 2, reason: 'second observation' },
    ]);
  });

  it('serializes each proposed value once and bounds value, reason, error, and action by Unicode code points', () => {
    const database = db();
    let serializations = 0;
    const proposedValue = {
      toJSON: () => {
        serializations += 1;
        return '🙂'.repeat(FIELD_GUESS_VALUE_JSON_MAX_CHARS);
      },
    };
    insertFieldGuessAttempts(database, [attempt({
      proposed_value: proposedValue,
      reason: `${'r'.repeat(FIELD_GUESS_REASON_MAX_CHARS - 1)}🙂tail`,
      error: `${'e'.repeat(FIELD_GUESS_ERROR_MAX_CHARS - 1)}🙂tail`,
      action: `${'a'.repeat(FIELD_GUESS_ACTION_MAX_CHARS - 1)}🙂tail`,
    })]);

    const [row] = rows(database);
    expect(serializations).toBe(1);
    expect(Array.from(row!.proposed_value_json ?? '')).toHaveLength(FIELD_GUESS_VALUE_JSON_MAX_CHARS);
    expect(row!.proposed_value_json).toBe(`"${'🙂'.repeat(FIELD_GUESS_VALUE_JSON_MAX_CHARS - 1)}`);
    expect(row!.reason).toBe(`${'r'.repeat(FIELD_GUESS_REASON_MAX_CHARS - 1)}🙂`);
    expect(row!.error).toBe(`${'e'.repeat(FIELD_GUESS_ERROR_MAX_CHARS - 1)}🙂`);
    expect(row!.action).toBe(`${'a'.repeat(FIELD_GUESS_ACTION_MAX_CHARS - 1)}🙂`);
  });

  it('rejects malformed input and leaves a multi-row batch atomic', () => {
    const database = db();
    expect(() => insertFieldGuessAttempts(database, [
      attempt({ field_name: 'valid-first' }),
      attempt({ outcome: 'invented' as FieldGuessOutcome }),
    ])).toThrow(/outcome/);
    expect(rows(database)).toEqual([]);

    database.exec(`
      CREATE TRIGGER reject_boom_attempt BEFORE INSERT ON field_guess_attempts
      WHEN NEW.field_name = 'boom'
      BEGIN SELECT RAISE(ABORT, 'boom rejected'); END;
    `);
    expect(() => insertFieldGuessAttempts(database, [
      attempt({ field_name: 'would-partially-write' }),
      attempt({ field_name: 'boom' }),
    ])).toThrow(/boom rejected/);
    expect(rows(database)).toEqual([]);
  });

  it('requires non-empty fingerprint and tracking strings plus a non-negative integer classifier version', () => {
    const database = db();
    for (const malformed of [
      attempt({ run_ref: '' }),
      attempt({ call_ref: '' }),
      attempt({ node_id: '' }),
      attempt({ field_name: '' }),
      attempt({ content_hash: '' }),
      attempt({ definition_hash: '' }),
      attempt({ model: '' }),
      attempt({ classifier_version: -1 }),
      attempt({ classifier_version: 1.5 }),
      attempt({ attempted_at: '' }),
      attempt({ reason: 42 as unknown as string }),
    ]) {
      expect(() => insertFieldGuessAttempts(database, [malformed])).toThrow();
    }
    expect(rows(database)).toEqual([]);
  });

  it.each([
    'not-a-timestamp',
    '2026-02-30T12:34:56.789Z',
    '2026-08-25T12:34:56Z',
    '2026-08-25 12:34:56.789Z',
    '2026-08-25T12:34:56.789+00:00',
    '2026-08-25T12:34:56.789Z ',
  ])('rejects non-canonical attempted_at value %j without inserting', attemptedAt => {
    const database = db();
    expect(() => insertFieldGuessAttempts(database, [attempt({ attempted_at: attemptedAt })]))
      .toThrow(/attempted_at.*Date#toISOString/);
    expect(rows(database)).toEqual([]);
  });

  it('rejects cyclic and BigInt proposed values before any row in a mixed batch is inserted', () => {
    const database = db();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    for (const proposedValue of [cyclic, 1n]) {
      expect(() => insertFieldGuessAttempts(database, [
        attempt({ field_name: 'serializable-first', proposed_value: { value: 'safe' } }),
        attempt({ field_name: 'unserializable-second', proposed_value: proposedValue }),
      ])).toThrow();
      expect(rows(database)).toEqual([]);
    }
  });
});

describe('field-guess evidence migration', () => {
  it('retains legacy attempts as unknown evidence and admits one new terminal fingerprint', () => {
    const database = new Database(':memory:');
    runMigrations(database, MIGRATIONS.filter(migration => migration.version <= 14));
    database.prepare(`INSERT INTO field_guess_attempts (
      run_ref, call_ref, node_id, field_name, content_hash, definition_hash,
      model, classifier_version, outcome, reason, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'run-1', 'call-1', 'node-1', 'status', 'content-1', 'definition-1',
      'accounts/fireworks/models/gpt-oss-120b', 1, 'abstained', 'Legacy explanation', '2026-08-25T12:00:00.000Z',
    );
    const legacy = database.prepare('SELECT * FROM field_guess_attempts').get() as Record<string, unknown>;
    runMigrations(database);
    const after = database.serialize();
    runMigrations(database);
    expect(database.serialize()).toEqual(after);
    expect(database.prepare('SELECT * FROM field_guess_attempts').get())
      .toEqual({ ...legacy, evidence_hash: null, evidence_version: null });
    expect(terminalFieldGuessFields(database, lookup())).toEqual(new Set());
    insertFieldGuessAttempts(database, [attempt({ run_ref: 'new-run' })]);
    expect(terminalFieldGuessFields(database, lookup())).toEqual(new Set(['status']));
    expect(database.prepare('SELECT id FROM field_guess_attempts ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
    database.close();
  });

  it('rolls back evidence DDL and the version when migration 15 encounters a partial schema', () => {
    const database = new Database(':memory:');
    runMigrations(database, MIGRATIONS.filter(migration => migration.version <= 14));
    database.exec('ALTER TABLE field_guess_attempts ADD COLUMN evidence_version INTEGER');
    const before = database.serialize();
    expect(() => runMigrations(database)).toThrow(/duplicate column name/);
    expect(database.serialize()).toEqual(before);
    expect(database.pragma('user_version', { simple: true })).toBe(14);
    database.close();
  });

  it('does not let legacy or partial fingerprints suppress current evidence', () => {
    const database = db();
    insertFieldGuessAttempts(database, [attempt({ evidence_hash: null, evidence_version: null })]);
    expect(terminalFieldGuessFields(database, lookup())).toEqual(new Set());
    expect(() => insertFieldGuessAttempts(database, [attempt({ evidence_hash: null })])).toThrow(/provided together/);
    expect(database.prepare('SELECT COUNT(*) AS n FROM field_guess_attempts').get()).toEqual({ n: 1 });
    database.close();
  });
});

describe('terminalFieldGuessFields', () => {
  it('suppresses only the three exact terminal outcomes, never set or operational failures', () => {
    const database = db();
    const outcomes: FieldGuessOutcome[] = [
      'set', 'abstained', 'rejected_value', 'rejected_reference',
      'reference_error', 'provider_error', 'stale_node', 'mutation_error',
    ];
    insertFieldGuessAttempts(database, outcomes.map((outcome, index) => attempt({
      field_name: `field-${index}`,
      definition_hash: `definition-${index}`,
      outcome,
    })));

    expect(terminalFieldGuessFields(database, lookup({
      fields: outcomes.map((_, index) => ({ field: `field-${index}`, definitionHash: `definition-${index}` })),
    }))).toEqual(new Set(['field-1', 'field-2', 'field-3']));
  });

  it('reopens when each fingerprint dimension changes independently and ignores unrelated field attempts', () => {
    const database = db();
    insertFieldGuessAttempts(database, [attempt({ outcome: 'abstained' })]);

    expect(terminalFieldGuessFields(database, lookup())).toEqual(new Set(['status']));
    expect(terminalFieldGuessFields(database, lookup({ nodeId: 'node-2' }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({ contentHash: 'content-2' }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({
      fields: [{ field: 'status', definitionHash: 'definition-2' }],
    }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({ model: 'other-model' }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({ classifierVersion: 2 }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({ evidenceHash: 'evidence-2' }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({ evidenceVersion: 2 }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({
      fields: [{ field: 'context', definitionHash: 'definition-1' }],
    }))).toEqual(new Set());
  });

  it('returns immediately for no fields and deduplicates repeated field fingerprints deterministically', () => {
    const database = db();
    insertFieldGuessAttempts(database, [attempt({ outcome: 'rejected_value' })]);

    expect(terminalFieldGuessFields(database, lookup({ fields: [] }))).toEqual(new Set());
    expect(terminalFieldGuessFields(database, lookup({
      fields: [
        { field: 'status', definitionHash: 'definition-1' },
        { field: 'status', definitionHash: 'definition-1' },
        { field: 'status', definitionHash: 'other-definition' },
      ],
    }))).toEqual(new Set(['status']));
  });
});
