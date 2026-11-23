import { beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { setMeta } from '../../src/db/meta.js';
import { EXPLICIT_NULL_BACKFILL_META_KEY } from '../../src/sync/explicit-null-backfill.js';
import {
  decodeFieldGuessCursor,
  encodeFieldGuessCursor,
} from '../../src/field-guess/candidates.js';
import { registerListFieldGuessCandidates } from '../../src/mcp/tools/list-field-guess-candidates.js';
import type { FieldType } from '../../src/validation/types.js';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity: string }>;
}

interface CandidatePage {
  candidates: Array<Record<string, any>>;
  next_cursor: string | null;
}

function getToolHandler(server: McpServer, name: string): (args: Record<string, unknown>) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ?? tool.handler;
}

function payload<T>(result: unknown): Envelope<T> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as Envelope<T>;
}

function insertNode(
  db: Database.Database,
  input: {
    id: string;
    type: string;
    mtime?: number | null;
    fields?: Record<string, unknown>;
    explicitNullFields?: string[];
  },
): void {
  db.prepare(`
    INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `${input.id}.md`,
    `Title ${input.id}`,
    `SECRET BODY ${input.id}`,
    `hash-${input.id}`,
    input.mtime === undefined ? 100 : input.mtime,
    1_000,
    7,
  );
  db.prepare(
    'INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, 0)',
  ).run(input.id, input.type);

  const insertField = db.prepare(`
    INSERT INTO node_fields (
      node_id, field_name, value_text, value_number, value_date, value_json, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'frontmatter')
  `);
  for (const [field, value] of Object.entries(input.fields ?? {})) {
    insertField.run(
      input.id,
      field,
      typeof value === 'string' ? value : null,
      typeof value === 'number' ? value : null,
      null,
      typeof value === 'string' || typeof value === 'number' ? null : JSON.stringify(value),
    );
  }
  for (const field of input.explicitNullFields ?? []) {
    db.prepare(
      'INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)',
    ).run(input.id, field);
  }
}

function createField(
  db: Database.Database,
  name: string,
  options: {
    type?: FieldType;
    listItemType?: FieldType;
    required?: boolean;
    aiGuessable?: boolean;
    enumValues?: string[];
    defaultValue?: unknown;
    description?: string;
  } = {},
): void {
  createGlobalField(db, {
    name,
    field_type: options.type ?? 'string',
    required: options.required ?? false,
    ai_guessable: options.aiGuessable ?? true,
    ...(options.listItemType === undefined ? {} : { list_item_type: options.listItemType }),
    ...(options.enumValues === undefined ? {} : { enum_values: options.enumValues }),
    ...(options.defaultValue === undefined ? {} : { default_value: options.defaultValue }),
    ...(options.description === undefined ? {} : { description: options.description }),
  });
}

function completeBackfill(db: Database.Database): void {
  setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
}

describe('list-field-guess-candidates', () => {
  let db: Database.Database;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    db = createTestDb();
    const server = new McpServer({ name: 'test', version: '0' });
    registerListFieldGuessCandidates(server, db);
    handler = getToolHandler(server, 'list-field-guess-candidates');
  });

  it('returns an empty page and warning until explicit-null backfill completes', async () => {
    createField(db, 'status', { type: 'enum', enumValues: ['active', 'paused'], required: true });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'status' }] });
    insertNode(db, { id: 'pending', type: 'Project', fields: { status: 'bogus' } });

    const envelope = payload<CandidatePage>(await handler({}));

    expect(envelope).toEqual({
      ok: true,
      data: { candidates: [], next_cursor: null },
      warnings: [{
        code: 'FIELD_PRESENCE_BACKFILL_PENDING',
        severity: 'warning',
        message: expect.any(String),
      }],
    });
  });

  it('leaves out the suite\'s own notes and wiki pages (#600)', async () => {
    createField(db, 'status', { type: 'enum', enumValues: ['active', 'paused'], required: true });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'status' }] });
    createSchemaDefinition(db, { name: 'wiki', field_claims: [{ field: 'status' }] });
    insertNode(db, { id: 'plain', type: 'Project', mtime: 300 });
    insertNode(db, { id: 'journal', type: 'Project', mtime: 400, fields: { vault_engine_projection: 'journal' } });
    insertNode(db, { id: 'page', type: 'wiki', mtime: 500 });
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({ limit: 200 }));

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.candidates.map(candidate => candidate.node_id)).toEqual(['plain']);
  });

  it('returns the exact body-free, current-value-free contract without writing defaults or state', async () => {
    const secretEnumValue = 'SECRET_ENUM_CURRENT_VALUE_7f31';
    createField(db, 'status', {
      type: 'enum',
      enumValues: ['active', 'paused'],
      required: true,
      description: 'Global status description',
    });
    createField(db, 'context', {
      required: true,
      defaultValue: 'creation-only default',
      description: 'Global context description',
    });
    createField(db, 'private_note', { aiGuessable: false });
    createField(db, 'orphan_guessable');
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [
        { field: 'status', description: 'Global status description', sort_order: 1 },
        { field: 'context', description: 'Effective context description', sort_order: 2 },
        { field: 'private_note', sort_order: 3 },
      ],
    });
    insertNode(db, {
      id: 'candidate',
      type: 'Project',
      mtime: 500,
      fields: {
        status: secretEnumValue,
        private_note: 'do not expose me',
        orphan_guessable: 'orphan value',
      },
    });
    completeBackfill(db);
    const before = {
      nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
      fields: db.prepare('SELECT * FROM node_fields ORDER BY node_id, field_name').all(),
      markers: db.prepare('SELECT * FROM node_explicit_null_fields ORDER BY node_id, field_name').all(),
    };

    const envelope = payload<CandidatePage>(await handler({ limit: 200 }));

    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.data).toEqual({
      candidates: [{
        node_id: 'candidate',
        title: 'Title candidate',
        file_path: 'candidate.md',
        types: ['Project'],
        version: 7,
        content_hash: 'hash-candidate',
        file_mtime: 500,
        fields: [{
          field: 'status',
          description: 'Global status description',
          field_type: 'enum',
          list_item_type: null,
          required: true,
          enum_values: ['active', 'paused'],
          reference_target: null,
          claiming_types: ['Project'],
          eligibility: 'invalid',
          validation_issue: {
            field: 'status',
            severity: 'error',
            code: 'ENUM_MISMATCH',
            message: expect.stringContaining('enum'),
            details: {
              allowed_values: ['active', 'paused'],
              closest_match: null,
            },
          },
          definition_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }, {
          field: 'context',
          description: 'Effective context description',
          field_type: 'string',
          list_item_type: null,
          required: true,
          enum_values: null,
          reference_target: null,
          claiming_types: ['Project'],
          eligibility: 'absent',
          definition_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }],
      }],
      next_cursor: null,
    });
    expect(envelope.data?.candidates[0]).not.toHaveProperty('body');
    expect(envelope.data?.candidates[0]).not.toHaveProperty('current_fields');
    expect(envelope.data?.candidates[0]).not.toHaveProperty('field_values');
    expect(JSON.stringify(envelope.data?.candidates[0])).not.toContain(secretEnumValue);
    expect(db.prepare('SELECT * FROM nodes ORDER BY id').all()).toEqual(before.nodes);
    expect(db.prepare('SELECT * FROM node_fields ORDER BY node_id, field_name').all()).toEqual(before.fields);
    expect(db.prepare('SELECT * FROM node_explicit_null_fields ORDER BY node_id, field_name').all()).toEqual(before.markers);
  });

  it('treats an explicit-null marker as authoritative over a retained invalid value row', async () => {
    createField(db, 'status', {
      type: 'enum',
      enumValues: ['active', 'paused'],
      required: true,
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'status' }],
    });
    insertNode(db, {
      id: 'explicit-null-retained-value',
      type: 'Project',
      fields: { status: 'active' },
      explicitNullFields: ['status'],
    });
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({}));

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.candidates).toHaveLength(1);
    expect(envelope.data?.candidates[0]?.fields).toEqual([
      expect.objectContaining({ field: 'status', eligibility: 'required_empty' }),
    ]);
  });

  it('redacts invalid list element values and reasons from the entire candidate payload', async () => {
    const secretListValue = 'SECRET_LIST_ELEMENT_VALUE_91ad';
    createField(db, 'estimates', { type: 'list', listItemType: 'number' });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'estimates' }],
    });
    insertNode(db, {
      id: 'list-secret',
      type: 'Project',
      fields: { estimates: [secretListValue] },
    });
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({}));
    const candidate = envelope.data?.candidates[0];
    const issue = candidate?.fields[0].validation_issue;

    expect(envelope.ok).toBe(true);
    expect(issue).toMatchObject({
      field: 'estimates',
      severity: 'error',
      code: 'LIST_ITEM_COERCION_FAILED',
      details: { element_errors: [{ index: 0 }] },
    });
    expect(JSON.stringify(candidate)).not.toContain(secretListValue);
  });

  it('uses a global-only description as effective guidance and definition-hash input', async () => {
    createField(db, 'context', {
      required: true,
      description: 'Global context guidance v1',
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'context' }],
    });
    insertNode(db, { id: 'global-description', type: 'Project' });
    completeBackfill(db);

    const first = payload<CandidatePage>(await handler({}));
    const firstField = first.data?.candidates[0].fields[0];
    expect(firstField?.description).toBe('Global context guidance v1');

    db.prepare(`
      UPDATE global_fields
      SET description = 'Global context guidance v2'
      WHERE name = 'context'
    `).run();

    const second = payload<CandidatePage>(await handler({}));
    const secondField = second.data?.candidates[0].fields[0];
    expect(secondField?.description).toBe('Global context guidance v2');
    expect(secondField?.definition_hash).not.toBe(firstField?.definition_hash);
  });

  it('keeps schema description precedence and hashes only the effective description', async () => {
    createField(db, 'context', {
      required: true,
      description: 'Ignored global guidance v1',
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'context', description: 'Schema guidance v1' }],
    });
    insertNode(db, { id: 'schema-description', type: 'Project' });
    completeBackfill(db);

    const first = payload<CandidatePage>(await handler({}));
    const firstField = first.data?.candidates[0].fields[0];
    expect(firstField?.description).toBe('Schema guidance v1');

    db.prepare(`
      UPDATE global_fields
      SET description = 'Ignored global guidance v2'
      WHERE name = 'context'
    `).run();
    const globalChanged = payload<CandidatePage>(await handler({}));
    const globalChangedField = globalChanged.data?.candidates[0].fields[0];
    expect(globalChangedField?.description).toBe('Schema guidance v1');
    expect(globalChangedField?.definition_hash).toBe(firstField?.definition_hash);

    db.prepare(`
      UPDATE schema_field_claims
      SET description = 'Schema guidance v2'
      WHERE schema_name = 'Project' AND field = 'context'
    `).run();
    const schemaChanged = payload<CandidatePage>(await handler({}));
    const schemaChangedField = schemaChanged.data?.candidates[0].fields[0];
    expect(schemaChangedField?.description).toBe('Schema guidance v2');
    expect(schemaChangedField?.definition_hash).not.toBe(firstField?.definition_hash);
  });

  it('distinguishes required and optional explicit nulls and excludes orphan fields', async () => {
    createField(db, 'required_context', { required: true });
    createField(db, 'optional_context');
    createField(db, 'orphan_guessable');
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'required_context' }, { field: 'optional_context' }],
    });
    insertNode(db, {
      id: 'nulls',
      type: 'Project',
      explicitNullFields: ['required_context', 'optional_context', 'orphan_guessable'],
    });
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({}));

    expect(envelope.data?.candidates).toHaveLength(1);
    expect(envelope.data?.candidates[0].fields.map((field: Record<string, unknown>) => [
      field.field,
      field.eligibility,
    ])).toEqual([['required_context', 'required_empty']]);
  });

  it('preserves schema AI-guess overrides and multi-type conflict cancellation when prefetched', async () => {
    createGlobalField(db, {
      name: 'context',
      field_type: 'string',
      required: true,
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'Enabled',
      field_claims: [{ field: 'context', ai_guessable: true }],
    });
    createSchemaDefinition(db, {
      name: 'Disabled',
      field_claims: [{ field: 'context', ai_guessable: false }],
    });
    insertNode(db, { id: 'enabled', type: 'Enabled' });
    insertNode(db, { id: 'disabled', type: 'Disabled' });
    insertNode(db, { id: 'conflict', type: 'Enabled' });
    db.prepare(
      'INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)',
    ).run('conflict', 'Disabled', 1);
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({}));

    expect(envelope.data?.candidates.map(candidate => candidate.node_id)).toEqual(['enabled']);
    expect(envelope.data?.candidates[0].fields[0]).toMatchObject({
      field: 'context',
      required: true,
      claiming_types: ['Enabled'],
      eligibility: 'absent',
    });
  });

  it('excludes reserved names enabled by legacy global and schema-override state', async () => {
    for (const name of ['__proto__', 'prototype', 'constructor']) {
      createGlobalField(db, {
        name,
        field_type: 'string',
        required: true,
        overrides_allowed: { ai_guessable: true },
      });
    }
    createField(db, 'ordinary', { required: true });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [
        { field: '__proto__' },
        { field: 'prototype', ai_guessable: false },
        { field: 'constructor' },
        { field: 'ordinary' },
      ],
    });
    db.prepare(`
      UPDATE global_fields
      SET ai_guessable = 1
      WHERE name IN ('__proto__', 'constructor')
    `).run();
    db.prepare(`
      UPDATE schema_field_claims
      SET ai_guessable_override = 1
      WHERE schema_name = 'Project' AND field = 'prototype'
    `).run();
    insertNode(db, { id: 'legacy', type: 'Project' });
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({}));

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.candidates).toHaveLength(1);
    expect(envelope.data?.candidates[0].fields.map((field: Record<string, unknown>) => field.field))
      .toEqual(['ordinary']);
  });

  it('orders by minimum urgency, mtime descending with nulls last, then node id', async () => {
    createField(db, 'required_status', {
      type: 'enum',
      enumValues: ['active'],
      required: true,
    });
    createField(db, 'optional_context');
    createSchemaDefinition(db, { name: 'Required', field_claims: [{ field: 'required_status' }] });
    createSchemaDefinition(db, { name: 'Optional', field_claims: [{ field: 'optional_context' }] });

    insertNode(db, { id: 'p1-b', type: 'Required', mtime: 300, fields: { required_status: 'bogus' } });
    insertNode(db, { id: 'p1-a', type: 'Required', mtime: 300, explicitNullFields: ['required_status'] });
    insertNode(db, { id: 'p1-older', type: 'Required', mtime: 200, fields: { required_status: 'bogus' } });
    insertNode(db, { id: 'p1-null', type: 'Required', mtime: null, fields: { required_status: 'bogus' } });
    insertNode(db, { id: 'p2', type: 'Required', mtime: 900 });
    insertNode(db, { id: 'p3', type: 'Optional', mtime: 1_000 });
    completeBackfill(db);

    const envelope = payload<CandidatePage>(await handler({ limit: 200 }));

    expect(envelope.data?.candidates.map(candidate => candidate.node_id)).toEqual([
      'p1-a',
      'p1-b',
      'p1-older',
      'p1-null',
      'p2',
    ]);
  });

  it('uses a keyset cursor when the prior page leaves the candidate set', async () => {
    createField(db, 'status', {
      type: 'enum',
      enumValues: ['active'],
      required: true,
    });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'status' }] });
    insertNode(db, { id: 'first', type: 'Project', mtime: 300, fields: { status: 'bogus' } });
    insertNode(db, { id: 'second', type: 'Project', mtime: 200, fields: { status: 'bogus' } });
    insertNode(db, { id: 'third', type: 'Project', mtime: 100, fields: { status: 'bogus' } });
    completeBackfill(db);

    const first = payload<CandidatePage>(await handler({ limit: 1 }));
    expect(first.data?.candidates.map(candidate => candidate.node_id)).toEqual(['first']);
    expect(first.data?.next_cursor).not.toBeNull();

    db.prepare(`
      UPDATE node_fields
      SET value_text = 'active'
      WHERE node_id = 'first' AND field_name = 'status'
    `).run();

    const second = payload<CandidatePage>(await handler({
      limit: 1,
      cursor: first.data?.next_cursor,
    }));
    expect(second.data?.candidates.map(candidate => candidate.node_id)).toEqual(['second']);
  });

  it('keeps later pages query-bounded on a representative large vault', async () => {
    const queries: string[] = [];
    db.close();
    db = createTestDb({ verbose: message => queries.push(String(message)) });
    const server = new McpServer({ name: 'test', version: '0' });
    registerListFieldGuessCandidates(server, db);
    handler = getToolHandler(server, 'list-field-guess-candidates');

    createField(db, 'status', {
      type: 'enum',
      enumValues: ['active'],
      required: true,
    });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'status' }] });
    for (let index = 0; index < 500; index++) {
      insertNode(db, {
        id: `large-${String(index).padStart(3, '0')}`,
        type: 'Project',
        mtime: 1_000 - index,
        fields: { status: 'invalid' },
      });
    }
    completeBackfill(db);

    queries.length = 0;
    const first = payload<CandidatePage>(await handler({ limit: 5 }));
    const firstPageQueries = queries.length;
    queries.length = 0;
    const second = payload<CandidatePage>(await handler({
      limit: 5,
      cursor: first.data?.next_cursor,
    }));

    expect(first.data?.candidates.map(candidate => candidate.node_id)).toEqual([
      'large-000', 'large-001', 'large-002', 'large-003', 'large-004',
    ]);
    expect(second.data?.candidates.map(candidate => candidate.node_id)).toEqual([
      'large-005', 'large-006', 'large-007', 'large-008', 'large-009',
    ]);
    // 11: one read of the vault map per call, for the wiki kind wiki pages are left out by (#600).
    expect(firstPageQueries).toBeLessThanOrEqual(11);
    expect(queries.length).toBeLessThanOrEqual(11);
  });

  it('does not repeat an absent-only whole-vault scan after entering the required-absence lane', async () => {
    const queries: string[] = [];
    db.close();
    db = createTestDb({ verbose: message => queries.push(String(message)) });
    const server = new McpServer({ name: 'test', version: '0' });
    registerListFieldGuessCandidates(server, db);
    handler = getToolHandler(server, 'list-field-guess-candidates');

    createField(db, 'context', { required: true });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'context' }] });
    for (let index = 0; index < 500; index++) {
      insertNode(db, {
        id: `absent-${String(index).padStart(3, '0')}`,
        type: 'Project',
        mtime: 1_000 - index,
      });
    }
    completeBackfill(db);

    queries.length = 0;
    const first = payload<CandidatePage>(await handler({ limit: 5 }));
    const firstPageQueries = queries.length;
    queries.length = 0;
    const second = payload<CandidatePage>(await handler({
      limit: 5,
      cursor: first.data?.next_cursor,
    }));

    expect(first.data?.candidates.map(candidate => candidate.node_id)).toEqual([
      'absent-000', 'absent-001', 'absent-002', 'absent-003', 'absent-004',
    ]);
    expect(second.data?.candidates.map(candidate => candidate.node_id)).toEqual([
      'absent-005', 'absent-006', 'absent-007', 'absent-008', 'absent-009',
    ]);
    // +1 each: one read of the vault map per call, for the wiki kind (#600).
    expect(firstPageQueries).toBeLessThanOrEqual(76);
    expect(queries.length).toBeLessThanOrEqual(11);
  });

  it('paginates from urgent invalid values into absent required values without replaying promoted work', async () => {
    createField(db, 'status', {
      type: 'enum',
      enumValues: ['active'],
      required: true,
    });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'status' }] });
    insertNode(db, { id: 'urgent', type: 'Project', mtime: 300, fields: { status: 'invalid' } });
    insertNode(db, { id: 'promoted-ahead', type: 'Project', mtime: 400 });
    insertNode(db, { id: 'absent-next', type: 'Project', mtime: 200 });
    completeBackfill(db);

    const first = payload<CandidatePage>(await handler({ limit: 1 }));
    expect(first.data?.candidates.map(candidate => candidate.node_id)).toEqual(['urgent']);

    db.prepare(`
      UPDATE node_fields
      SET value_text = 'active'
      WHERE node_id = 'urgent' AND field_name = 'status'
    `).run();
    db.prepare(`
      INSERT INTO node_fields (
        node_id, field_name, value_text, value_number, value_date, value_json, source
      ) VALUES ('promoted-ahead', 'status', 'invalid', NULL, NULL, NULL, 'frontmatter')
    `).run();

    const second = payload<CandidatePage>(await handler({
      limit: 1,
      cursor: first.data?.next_cursor,
    }));
    expect(second.data?.candidates.map(candidate => candidate.node_id)).toEqual(['absent-next']);

    const nextSweep = payload<CandidatePage>(await handler({ limit: 1 }));
    expect(nextSweep.data?.candidates.map(candidate => candidate.node_id)).toEqual(['promoted-ahead']);
  });

  it('round-trips opaque base64url cursors and returns INVALID_PARAMS for malformed cursors', async () => {
    const tuple = { priority: 1 as const, file_mtime: null, node_id: 'node/with spaces' };
    const cursor = encodeFieldGuessCursor(tuple);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('node/with spaces');
    expect(decodeFieldGuessCursor(cursor)).toEqual(tuple);

    completeBackfill(db);
    const malformed = payload<CandidatePage>(await handler({ cursor: 'not valid base64url!' }));
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringContaining('cursor'),
    });
    expect(malformed.warnings).toEqual([]);
  });

  it('defaults limit to 100, accepts 200, and rejects 201', async () => {
    createField(db, 'context', { required: true });
    createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'context' }] });
    for (let index = 0; index < 201; index++) {
      insertNode(db, {
        id: `node-${String(index).padStart(3, '0')}`,
        type: 'Project',
        mtime: index,
      });
    }
    completeBackfill(db);

    const defaultPage = payload<CandidatePage>(await handler({}));
    expect(defaultPage.ok).toBe(true);
    expect(defaultPage.data?.candidates).toHaveLength(100);
    expect(defaultPage.data?.next_cursor).not.toBeNull();

    const maxPage = payload<CandidatePage>(await handler({ limit: 200 }));
    expect(maxPage.ok).toBe(true);
    expect(maxPage.data?.candidates).toHaveLength(200);
    expect(maxPage.data?.next_cursor).not.toBeNull();

    const tooLarge = payload<CandidatePage>(await handler({ limit: 201 }));
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(tooLarge.warnings).toEqual([]);
  });
  describe('an on-demand run that names its fields (#644)', () => {
    /** Meetings with an optional date and people the owner never marked AI-guessable, and a task. */
    function seedMeetings(): void {
      completeBackfill(db);
      createField(db, 'date', { type: 'date', aiGuessable: false });
      createField(db, 'people', { type: 'list', listItemType: 'string', aiGuessable: false });
      createField(db, 'status', { type: 'enum', enumValues: ['open', 'done'], aiGuessable: false });
      createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'date' }, { field: 'people' }] });
      createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }, { field: 'date' }] });
      insertNode(db, { id: 'empty', type: 'meeting', mtime: 500 });
      insertNode(db, { id: 'dated', type: 'meeting', mtime: 400, fields: { date: '2024-03-01' } });
      insertNode(db, { id: 'full', type: 'meeting', mtime: 300, fields: { date: '2024-03-02', people: ['Dana'] } });
      insertNode(db, { id: 'tbd', type: 'meeting', mtime: 200, fields: { date: 'TBD', people: [] } });
      insertNode(db, { id: 'chore', type: 'task', mtime: 100 });
      db.prepare("UPDATE nodes SET file_path = 'Archive/' || file_path WHERE id = 'tbd'").run();
    }

    const offeredBy = (page: CandidatePage): Record<string, string[]> =>
      Object.fromEntries(page.candidates.map(candidate => [
        candidate.node_id as string,
        (candidate.fields as Array<{ field: string; eligibility: string }>).map(field => `${field.field}:${field.eligibility}`),
      ]));

    it('offers nothing under the nightly rule: the fields are optional and unmarked', async () => {
      seedMeetings();
      // No mark either: the nightly listing's shape is unchanged.
      expect(payload<CandidatePage>(await handler({})).data).toEqual({ candidates: [], next_cursor: null });
    });

    it('reads no note text to work out the scope', async () => {
      seedMeetings();
      const prepare = db.prepare.bind(db);
      const seen: string[] = [];
      db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql); }) as typeof db.prepare;
      try {
        await handler({ requested: { fields: ['date'], query: { types: ['meeting'], path_prefix: 'Archive/' } } });
      } finally {
        db.prepare = prepare as typeof db.prepare;
      }
      // The scope is a subquery of ids: the query builder's row query would carry every body.
      const scoped = seen.filter(sql => sql.includes('nodes.id IN ('));
      expect(scoped.length).toBeGreaterThan(0);
      for (const sql of scoped) expect(sql).toContain('nodes.id IN (SELECT DISTINCT n.id FROM nodes n');
    });

    it('offers each named field a note holds no value for, newest note first', async () => {
      seedMeetings();
      const envelope = payload<CandidatePage>(await handler({
        requested: { fields: ['date', 'people'], query: { types: ['meeting'] } },
      }));
      expect(envelope.ok).toBe(true);
      // `full` has both; `dated` lacks only people; `tbd` holds an empty list, and a date that is
      // not a date: that one is someone's text, and is left alone unless the run asks to replace it.
      expect(offeredBy(envelope.data!)).toEqual({
        empty: ['date:absent', 'people:absent'],
        dated: ['people:absent'],
        tbd: ['people:absent'],
      });
      expect(envelope.data!.candidates.map(candidate => candidate.node_id)).toEqual(['empty', 'dated', 'tbd']);
      // Marked, so a caller can tell this from the nightly listing an older Engine would answer with.
      expect((envelope.data as { mode?: string }).mode).toBe('requested');
      // Body-free, like the nightly listing.
      expect(JSON.stringify(envelope.data)).not.toContain('SECRET BODY');
    });

    it('offers a value that fails its field\'s type only to a run that asks to replace it', async () => {
      seedMeetings();
      const replacing = payload<CandidatePage>(await handler({
        requested: { fields: ['date', 'people'], query: { types: ['meeting'] }, replace_invalid: true },
      }));
      expect(offeredBy(replacing.data!)).toEqual({
        empty: ['date:absent', 'people:absent'],
        dated: ['people:absent'],
        tbd: ['date:invalid', 'people:absent'],
      });
      // A note whose only gap is such a value is in scope only then; a valid value never is.
      db.prepare("UPDATE node_fields SET value_json = ? WHERE node_id = 'tbd' AND field_name = 'people'").run(JSON.stringify(['Dana']));
      const dateOnly = { fields: ['date'], query: { node_ids: ['tbd', 'full'] } };
      expect(offeredBy(payload<CandidatePage>(await handler({ requested: dateOnly })).data!)).toEqual({});
      expect(offeredBy(payload<CandidatePage>(await handler({ requested: { ...dateOnly, replace_invalid: true } })).data!))
        .toEqual({ tbd: ['date:invalid'] });
    });

    it('covers only the notes the query selects, and only the fields named', async () => {
      seedMeetings();
      const dateOnly = payload<CandidatePage>(await handler({ requested: { fields: ['date'] } }));
      // No query: every note whose kinds claim the field, so the task too.
      expect(offeredBy(dateOnly.data!)).toEqual({ empty: ['date:absent'], chore: ['date:absent'] });

      const archived = payload<CandidatePage>(await handler({
        requested: { fields: ['date', 'people'], query: { types: ['meeting'], path_prefix: 'Archive/' } },
      }));
      expect(Object.keys(offeredBy(archived.data!))).toEqual(['tbd']);

      const byId = payload<CandidatePage>(await handler({
        requested: { fields: ['people'], query: { node_ids: ['dated', 'full', 'chore'] } },
      }));
      // `chore` is a task, and no kind of it claims people.
      expect(offeredBy(byId.data!)).toEqual({ dated: ['people:absent'] });
    });

    it('pages with the cursor and never offers suite notes or wiki pages', async () => {
      seedMeetings();
      createSchemaDefinition(db, { name: 'wiki', field_claims: [{ field: 'date' }] });
      insertNode(db, { id: 'page', type: 'wiki', mtime: 900 });
      insertNode(db, { id: 'journal', type: 'meeting', mtime: 800, fields: { vault_engine_projection: 'journal' } });
      const request = { fields: ['date', 'people'] };
      const first = payload<CandidatePage>(await handler({ limit: 2, requested: request }));
      expect(first.data!.candidates.map(candidate => candidate.node_id)).toEqual(['empty', 'dated']);
      expect(first.data!.next_cursor).toEqual(expect.any(String));
      const second = payload<CandidatePage>(await handler({ limit: 2, cursor: first.data!.next_cursor, requested: request }));
      expect(second.data!.candidates.map(candidate => candidate.node_id)).toEqual(['tbd', 'chore']);
      expect(second.data!.next_cursor).toBeNull();
    });

    it('refuses a malformed scope as query-nodes would, before any note is selected', async () => {
      seedMeetings();
      // Through a real client, so the tool's own schema runs: the handler alone would not check it.
      const server = new McpServer({ name: 'test', version: '0' });
      registerListFieldGuessCandidates(server, db);
      const client = new Client({ name: 'test', version: '0' });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const call = async (query: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'list-field-guess-candidates', arguments: { requested: { fields: ['date'], query } } });
        return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
      };
      try {
        // `exists` as a string would have selected the notes that HAVE a people value.
        const wrongType = await call({ fields: { people: { exists: 'false' } } });
        expect(wrongType.isError).toBe(true);
        expect(wrongType.text).toMatch(/Input validation error/);
        expect((await call({ fields: { people: { exist: false } } })).isError).toBe(true);
        expect((await call({ join_filters: [] })).isError).toBe(true);
        const grouped = await call({ fields: { status: { in_group: { schema: 'task', group: 'open' } } } });
        expect(grouped.isError).toBe(true);
        expect(grouped.text).toContain('Group predicates');
        // The well-formed predicate selects the notes without people: `tbd` holds an empty list, which is a value.
        const valid = JSON.parse((await call({ fields: { people: { exists: false } } })).text) as Envelope<CandidatePage>;
        expect(valid.ok).toBe(true);
        expect(valid.data!.candidates.map(candidate => candidate.node_id)).toEqual(['empty', 'chore']);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it('refuses a field no type claims, naming it', async () => {
      seedMeetings();
      createField(db, 'mood', { aiGuessable: false });
      const envelope = payload<CandidatePage>(await handler({ requested: { fields: ['date', 'mood', 'nope'] } }));
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toMatchObject({ code: 'INVALID_PARAMS', details: { fields: ['mood', 'nope'] } });
    });
  });
});
