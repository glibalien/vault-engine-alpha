import { globalClassificationHash } from '../../src/classification/definitions.js';
import { inputDefinitionHash } from '../../src/classification/preview.js';
import { loadClassificationInput } from '../../src/classification/read.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addUiHints } from '../../src/db/migrate.js';
import { getGlobalField, createGlobalField, updateGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { createTempVault } from '../helpers/vault.js';
import {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  serializeFieldGuessCandidateIdentity,
} from '@vault/contract';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateSchema(fakeServer, db, { writeLock, vaultPath, syncLogger });
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  addSchemaUndoSnapshots(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);

  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed'],
  });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-schema structured validation errors', () => {
  it('leaves no undo operation when candidate-budget admission rejects the update', async () => {
    const emptyIdentityChars = serializeFieldGuessCandidateIdentity({
      field: '',
      field_type: 'string',
      list_item_type: null,
    }).length;
    const overField = 'x'.repeat(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS + 1 - emptyIdentityChars,
    );
    createGlobalField(db, {
      name: overField,
      field_type: 'string',
      ai_guessable: true,
    });
    const before = (db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get() as { c: number }).c;

    const result = parseResult(await getHandler()({
      name: 'note',
      field_claims: [{ field: overField }],
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/candidate identity projection.*20,000/i) },
    });
    expect((db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get() as { c: number }).c)
      .toBe(before);
  });

  it('rejects AI-guessability overrides without global permission', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'status', ai_guessable: true }],
    }));

    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: Array<{ reason: string }> } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details?.groups[0].reason).toBe('OVERRIDE_NOT_ALLOWED');
  });

  it('claim-level UNKNOWN_FIELD surfaces VALIDATION_FAILED envelope with groups', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'does_not_exist' }],
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: unknown[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details?.groups).toBeDefined();
    const groups = err.details!.groups as Array<{ reason: string; field: string }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('UNKNOWN_FIELD');
    expect(groups[0].field).toBe('does_not_exist');
  });

  it('propagation ENUM_MISMATCH across multiple nodes surfaces aggregated group', async () => {
    for (const [i, v] of [['a', 'active'], ['b', 'active'], ['c', 'draft']]) {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: `${i}.md`,
        title: i.toUpperCase(),
        types: ['note'],
        fields: { status: v },
        body: '',
      });
    }

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'status', sort_order: 1 }],
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: unknown[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    const groups = err.details!.groups as Array<{
      reason: string;
      field: string;
      count: number;
      invalid_values?: Array<{ value: string; count: number }>;
    }>;
    const enumGroup = groups.find(g => g.reason === 'ENUM_INVALID');
    expect(enumGroup).toBeDefined();
    expect(enumGroup!.count).toBe(3);
    expect(enumGroup!.invalid_values).toEqual([
      { value: 'active', count: 2 },
      { value: 'draft', count: 1 },
    ]);
  });

  it('non-SchemaValidationError still funnels through INVALID_PARAMS', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'does_not_exist',
      display_name: 'x',
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain("'does_not_exist' not found");
  });
});

describe('update-schema dry_run', () => {
  it('reports but does not propagate an AI-only claim change', async () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'article',
      field_claims: [{ field: 'summary', sort_order: 1000, ai_guessable: true }],
    });
    const article = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'article.md',
      title: 'Article',
      types: ['article'],
      fields: { summary: 'text' },
      body: '',
    });
    const handler = getHandler();

    const dryRun = parseResult(await handler({
      name: 'article',
      field_claims: [{ field: 'summary', sort_order: 1000, ai_guessable: false }],
      dry_run: true,
    }));
    expect(dryRun.ok).toBe(true);
    expect((dryRun as { data: { claims_modified: string[] } }).data.claims_modified).toEqual(['summary']);
    expect((dryRun as { data: { propagation: { nodes_affected: number } } }).data.propagation.nodes_affected).toBe(0);

    const articlePath = join(vaultPath, 'article.md');
    const nodeBefore = db.prepare(
      'SELECT version, content_hash, body FROM nodes WHERE id = ?',
    ).get(article.node_id);
    unlinkSync(articlePath);

    const commit = parseResult(await handler({
      name: 'article',
      field_claims: [{ field: 'summary', sort_order: 1000, ai_guessable: false }],
    }));
    expect(commit.ok).toBe(true);
    expect((commit as { data: { propagation: { nodes_affected: number } } }).data.propagation.nodes_affected).toBe(0);
    expect(existsSync(articlePath)).toBe(false);
    expect(db.prepare(
      'SELECT version, content_hash, body FROM nodes WHERE id = ?',
    ).get(article.node_id)).toEqual(nodeBefore);
    expect(db.prepare(
      'SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = ? AND field = ?',
    ).get('article', 'summary')).toEqual({ ai_guessable_override: 0 });
  });

  it('still propagates when an AI change also changes rendered claim metadata', async () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'article',
      field_claims: [{ field: 'summary', sort_order: 1000, ai_guessable: true }],
    });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'article.md',
      title: 'Article',
      types: ['article'],
      fields: { summary: 'text' },
      body: '',
    });

    const result = parseResult(await getHandler()({
      name: 'article',
      field_claims: [{ field: 'summary', sort_order: 900, ai_guessable: false }],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect((result as { data: { claims_modified: string[] } }).data.claims_modified).toEqual(['summary']);
    expect((result as { data: { propagation: { nodes_affected: number } } }).data.propagation.nodes_affected).toBe(1);
  });

  it('dry_run=true returns preview data without committing the change', async () => {
    // Reset default fixtures: we want a string field with a default, not the enum one.
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'open', required: true });
    // Create a task schema and node (note schema already created in beforeEach).
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'a.md',
      title: 'A',
      types: ['task'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'priority' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    const data = (result as { data: { claims_added: string[]; propagation: { defaults_populated: number } } }).data;
    expect(data.claims_added).toEqual(['priority']);
    expect(data.propagation.defaults_populated).toBe(1);

    // Assert no commit happened — no claims persisted.
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toEqual([]);
  });

  it('dry_run=true with claim-level failure returns ok:false with groups + preview data in error.details', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'nonexistent' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details: { groups: Array<{ reason: string }>; claims_added: string[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details.groups.some(g => g.reason === 'UNKNOWN_FIELD')).toBe(true);
    expect(err.details.claims_added).toEqual(['nonexistent']);
  });

  it('commit path (no dry_run) still works — single claim add persists + default populated', async () => {
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'a.md',
      title: 'A',
      types: ['task'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'priority' }],
    }));

    expect(result.ok).toBe(true);

    // Claim persisted.
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['priority']);

    // Node got the default value.
    const field = db.prepare('SELECT value_text FROM node_fields WHERE field_name = ?').get('priority') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('open');
  });
});

describe('update-schema patch-style field claim ops', () => {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createGlobalField(db, { name: 'priority', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1 }] });
    handler = getHandler();
  });

  it('add_field_claims appends claims without replacing existing claims', async () => {
    const result = parseResult(await handler({
      name: 'task',
      add_field_claims: [{ field: 'priority', sort_order: 2 }],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    const data = (result as { data: { claims_added: string[]; claims_removed: string[]; claims_modified: string[] } }).data;
    expect(data.claims_added).toEqual(['priority']);
    expect(data.claims_removed).toEqual([]);
    expect(data.claims_modified).toEqual([]);

    const dryClaims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ? ORDER BY sort_order').all('task') as Array<{ field: string }>;
    expect(dryClaims.map(c => c.field)).toEqual(['status']);

    const commit = parseResult(await handler({
      name: 'task',
      add_field_claims: [{ field: 'priority', sort_order: 2 }],
    }));

    expect(commit.ok).toBe(true);
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ? ORDER BY sort_order').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['status', 'priority']);
  });

  it('update_field_claims patches only the named existing claim', async () => {
    await handler({
      name: 'task',
      add_field_claims: [{ field: 'priority', sort_order: 2 }],
    });

    const result = parseResult(await handler({
      name: 'task',
      update_field_claims: [{ field: 'priority', label: 'Urgency' }],
    }));

    expect(result.ok).toBe(true);
    const claims = db.prepare('SELECT field, sort_order, label FROM schema_field_claims WHERE schema_name = ? ORDER BY field').all('task') as Array<{
      field: string;
      sort_order: number;
      label: string | null;
    }>;
    expect(claims).toEqual([
      { field: 'priority', sort_order: 2, label: 'Urgency' },
      { field: 'status', sort_order: 1, label: null },
    ]);
  });

  it('preserves an AI-guessability override in patches and clears it in full replacement', async () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'article',
      field_claims: [{ field: 'summary', ai_guessable: false }],
    });
    const articleHandler = getHandler();

    const patch = parseResult(await articleHandler({
      name: 'article',
      update_field_claims: [{ field: 'summary', label: 'Summary' }],
    }));
    expect(patch.ok).toBe(true);
    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'article' AND field = 'summary'`).get())
      .toEqual({ ai_guessable_override: 0 });

    const replace = parseResult(await articleHandler({
      name: 'article',
      field_claims: [{ field: 'summary' }],
    }));
    expect(replace.ok).toBe(true);
    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'article' AND field = 'summary'`).get())
      .toEqual({ ai_guessable_override: null });
  });

  it('preserves an omitted AI override after global permission is disabled', async () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'article',
      field_claims: [{ field: 'summary', ai_guessable: false }],
    });
    updateGlobalField(db, 'summary', { overrides_allowed: { ai_guessable: false } });
    const articleHandler = getHandler();

    const patch = parseResult(await articleHandler({
      name: 'article',
      update_field_claims: [{ field: 'summary', label: 'Summary' }],
    }));

    expect(patch.ok).toBe(true);
    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'article' AND field = 'summary'`).get())
      .toEqual({ ai_guessable_override: 0 });
  });

  it('permission-gates an explicit AI patch after global permission is disabled', async () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'article',
      field_claims: [{ field: 'summary', ai_guessable: false }],
    });
    updateGlobalField(db, 'summary', { overrides_allowed: { ai_guessable: false } });
    const articleHandler = getHandler();

    const result = parseResult(await articleHandler({
      name: 'article',
      update_field_claims: [{ field: 'summary', ai_guessable: false }],
    }));

    expect(result.ok).toBe(false);
    const error = (result as { error: { code: string; details: { groups: Array<{ reason: string; field: string }> } } }).error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details.groups).toEqual([
      expect.objectContaining({ reason: 'OVERRIDE_NOT_ALLOWED', field: 'summary' }),
    ]);
    expect(db.prepare(`SELECT ai_guessable_override FROM schema_field_claims WHERE schema_name = 'article' AND field = 'summary'`).get())
      .toEqual({ ai_guessable_override: 0 });
  });

  it('remove_field_claims uses the same orphan confirmation gate as replace-all removal', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'a.md',
      title: 'A',
      types: ['task'],
      fields: { status: 'done' },
      body: '',
    });

    const blocked = parseResult(await handler({
      name: 'task',
      remove_field_claims: ['status'],
    }));

    expect(blocked.ok).toBe(false);
    expect((blocked as { error: { code: string } }).error.code).toBe('CONFIRMATION_REQUIRED');

    const committed = parseResult(await handler({
      name: 'task',
      remove_field_claims: ['status'],
      confirm_large_change: true,
    }));

    expect(committed.ok).toBe(true);
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toEqual([]);
  });

  it('rejects mixing replace-all field_claims with patch-style claim ops', async () => {
    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      add_field_claims: [{ field: 'priority' }],
    }));

    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('cannot be combined');
  });

  it('rejects patch ops that target the wrong claim state before mutating', async () => {
    const duplicate = parseResult(await handler({
      name: 'task',
      add_field_claims: [{ field: 'status' }],
    }));
    expect(duplicate.ok).toBe(false);
    expect((duplicate as { error: { code: string; message: string } }).error.message).toContain('already claims');

    const missingUpdate = parseResult(await handler({
      name: 'task',
      update_field_claims: [{ field: 'priority' }],
    }));
    expect(missingUpdate.ok).toBe(false);
    expect((missingUpdate as { error: { code: string; message: string } }).error.message).toContain('does not claim');

    const missingRemove = parseResult(await handler({
      name: 'task',
      remove_field_claims: ['priority'],
    }));
    expect(missingRemove.ok).toBe(false);
    expect((missingRemove as { error: { code: string; message: string } }).error.message).toContain('does not claim');

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['status']);
  });

  it('surfaces validation details for invalid patch-added claims', async () => {
    const result = parseResult(await handler({
      name: 'task',
      add_field_claims: [{ field: 'missing' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details: { groups: Array<{ reason: string; field: string }>; claims_added: string[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details.groups).toEqual([
      expect.objectContaining({ reason: 'UNKNOWN_FIELD', field: 'missing' }),
    ]);
    expect(err.details.claims_added).toEqual(['missing']);
  });
});

describe('update-schema confirm_large_change gate', () => {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function createNode(overrides: { file_path: string; title: string; types: string[]; fields?: Record<string, unknown> }) {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: overrides.file_path,
      title: overrides.title,
      types: overrides.types,
      fields: overrides.fields ?? {},
      body: '',
    });
  }

  beforeEach(() => {
    // Replace the enum `status` created by the outer beforeEach with a string field.
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    handler = getHandler();
  });

  it('orphan-producing change without confirm_large_change returns CONFIRMATION_REQUIRED', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
    }));

    expect(result.ok).toBe(false);
    expect((result as { error?: { code: string } }).error?.code).toBe('CONFIRMATION_REQUIRED');
    const details = (result as { error: { details: {
      orphaned_field_names: Array<{ field: string; count: number }>;
      propagation: { fields_orphaned: number };
      claims_removed: string[];
    } } }).error.details;
    expect(details.orphaned_field_names).toEqual([{ field: 'status', count: 1 }]);
    expect(details.claims_removed).toEqual(['status']);
    expect(details.propagation.fields_orphaned).toBe(1);

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toHaveLength(1);
  });

  it('same change with confirm_large_change=true succeeds', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      confirm_large_change: true,
    }));

    expect(result.ok).toBe(true);
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toHaveLength(0);
  });

  it('change with zero orphans succeeds without confirm_large_change', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }],
    }));

    expect(result.ok).toBe(true);
  });

  it('dry_run with orphans does not trigger the gate — preview returns normally', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect((result as { data: { propagation: { fields_orphaned: number } } }).data.propagation.fields_orphaned).toBe(1);
  });
});

describe('update-schema undo integration', () => {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function createNode(overrides: { file_path: string; title: string; types: string[]; fields?: Record<string, unknown> }) {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: overrides.file_path,
      title: overrides.title,
      types: overrides.types,
      fields: overrides.fields ?? {},
      body: '',
    });
  }

  beforeEach(() => {
    db.prepare('DELETE FROM global_fields').run();
    handler = getHandler();
  });

  it('successful commit is captured in list-undo-history with schema_count=1', async () => {
    const { listOperations } = await import('../../src/undo/operation.js');
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }],
    }));
    expect(result.ok).toBe(true);

    const list = listOperations(db, { source_tool: 'update-schema' });
    expect(list.operations.length).toBe(1);
    const op = list.operations[0];
    expect(op.schema_count).toBe(1);
    expect(op.node_count).toBeGreaterThan(0);
  });

  it('undo-operations restores schema to pre-state (claims cleared)', async () => {
    const { restoreMany } = await import('../../src/undo/restore.js');
    const { listOperations } = await import('../../src/undo/operation.js');
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    await handler({ name: 'task', field_claims: [{ field: 'status' }] });

    const list = listOperations(db, { source_tool: 'update-schema' });
    const op_id = list.operations[0].operation_id;

    restoreMany(db, writeLock, vaultPath, { operation_ids: [op_id], dry_run: false });

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims).toEqual([]);
  });

  it('validation-rejecting commit rolls back; operation row carries counts=0', async () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'ok.md', title: 'OK', types: ['task'], fields: { status: 'open' } });

    db.prepare('UPDATE node_fields SET value_text = ? WHERE field_name = ?').run('garbage', 'status');

    createGlobalField(db, { name: 'priority', field_type: 'string', required: true, default_value: 'normal' });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }, { field: 'priority' }],
    }));

    expect(result.ok).toBe(false);
    expect((result as { error?: { code: string } }).error?.code).toBe('VALIDATION_FAILED');

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ? ORDER BY field').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['status']);

    const ops = db.prepare(
      "SELECT node_count, schema_count, status FROM undo_operations WHERE source_tool = 'update-schema'"
    ).all() as Array<{ node_count: number; schema_count: number; status: string }>;
    expect(ops.length).toBeLessThanOrEqual(1);
    if (ops.length === 1) {
      expect(ops[0].node_count).toBe(0);
      expect(ops[0].schema_count).toBe(0);
    }
  });
});


describe('status group patches with historical required overrides', () => {
  it('previews, commits and undoes classification without changing inherited requirements or nodes', async () => {
    createGlobalField(db, { name: 'context', field_type: 'string', overrides_allowed: { required: true } });
    updateGlobalField(db, 'status', { overrides_allowed: { required: true, enum_groups: true } });
    createSchemaDefinition(db, { name: 'task', field_claims: [
      { field: 'status', required: true }, { field: 'context', required: false },
    ] });
    updateGlobalField(db, 'status', { overrides_allowed: { required: false } });
    updateGlobalField(db, 'context', { overrides_allowed: { required: false } });
    executeMutation(db, writeLock, vaultPath, { source: 'tool', node_id: null, file_path: 'task.md',
      title: 'Task', types: ['task'], fields: { status: 'open' }, body: 'Keep the source.' });
    const claims = () => db.prepare("SELECT * FROM schema_field_claims WHERE schema_name = 'task' ORDER BY field").all();
    const beforeClaims = claims();
    const beforeNodes = db.prepare('SELECT * FROM nodes').all();
    const beforeOperations = db.prepare('SELECT * FROM undo_operations').all();
    const groups = { version: 1, groups: [{ name: 'actionable', values: ['open'] }] };
    const input = { name: 'task', update_field_claims: [{ field: 'status', enum_groups_override: groups,
      expected_enum_groups_hash: inputDefinitionHash(loadClassificationInput(db, { schema: 'task', field: 'status' })),
      expected_global_enum_groups_hash: globalClassificationHash(getGlobalField(db, 'status')!),
    }] };
    const handler = getHandler();
    const preview = parseResult(await handler({ ...input, dry_run: true }));
    expect(preview).toMatchObject({ ok: true, data: { would_commit: true, claims_modified: ['status'],
      propagation: { nodes_affected: 0, nodes_rerendered: 0, defaults_populated: 0, fields_orphaned: 0 } } });
    expect(claims()).toEqual(beforeClaims);
    expect(db.prepare('SELECT * FROM nodes').all()).toEqual(beforeNodes);
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual(beforeOperations);
    const committed = parseResult(await handler(input));
    expect(committed.ok).toBe(true);
    expect(db.prepare("SELECT field, required_override FROM schema_field_claims WHERE schema_name = 'task' ORDER BY field").all())
      .toEqual([{ field: 'context', required_override: 0 }, { field: 'status', required_override: 1 }]);
    expect(db.prepare("SELECT enum_groups_override FROM schema_field_claims WHERE schema_name = 'task' AND field = 'status'").get())
      .toEqual({ enum_groups_override: JSON.stringify(groups) });
    expect(db.prepare('SELECT * FROM nodes').all()).toEqual(beforeNodes);
    const { restoreMany } = await import('../../src/undo/restore.js');
    const operationId = (committed.data as { operation_id: string }).operation_id;
    const restored = restoreMany(db, writeLock, vaultPath, { operation_ids: [operationId], dry_run: false });
    expect(restored).toBeDefined();
    expect(claims()).toEqual(beforeClaims);
    expect(db.prepare('SELECT * FROM nodes').all()).toEqual(beforeNodes);
  });
});
