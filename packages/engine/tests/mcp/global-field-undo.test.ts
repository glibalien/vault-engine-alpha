import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  serializeFieldGuessCandidateIdentity,
} from '@vault/contract';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField, getGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { getWikiConfig } from '../../src/wiki/config.js';
import { createOperation } from '../../src/undo/operation.js';
import { processFileChange } from '../../src/sync/watcher.js';

// Fields newer than the five-claim legacy wiki schema: the reconciliation fields and wiki_status (#547).
const RECONCILIATION_WIKI_FIELDS = ['wiki_kind', 'wiki_origin', 'wiki_scope', 'wiki_replaced_by', 'wiki_pinned', 'wiki_topology_hash', 'wiki_reconcile_key', 'wiki_status'];
const FIELD_GUESS_BUDGET_ERROR = /AI field-guess candidate identity projection.*20,000/i;

function exactBudgetStringFieldName(): string {
  return stringFieldNameForProjectionChars(FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS);
}

function stringFieldNameForProjectionChars(chars: number): string {
  const emptyIdentityChars = serializeFieldGuessCandidateIdentity({
    field: '',
    field_type: 'string',
    list_item_type: null,
  }).length;
  return 'z'.repeat(chars - emptyIdentityChars);
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('global-field MCP undo', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerAllTools(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) });
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function readVault(relPath: string): string {
    return readFileSync(join(vaultPath, relPath), 'utf-8');
  }

  function undoHistory(): Array<{
    operation_id: string;
    source_tool: string;
    description: string;
    node_count: number;
  }> {
    return db.prepare(`
      SELECT operation_id, source_tool, description, node_count
      FROM undo_operations
      ORDER BY timestamp, operation_id
    `).all() as Array<{
      operation_id: string;
      source_tool: string;
      description: string;
      node_count: number;
    }>;
  }

  async function latestOperationId(sourceTool: string): Promise<string> {
    const history = payload(await callTool(server, 'list-undo-history', { source_tool: sourceTool }));
    expect(history.ok).toBe(true);
    expect(history.data.operations[0].global_field_count).toBe(1);
    return history.data.operations[0].operation_id;
  }

  async function undo(operationId: string): Promise<void> {
    const result = payload(await callTool(server, 'undo-operations', {
      operation_ids: [operationId],
      dry_run: false,
    }));
    expect(result.ok).toBe(true);
  }

  function seedStatusSchema(): void {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      description: 'Original status',
    });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status', sort_order: 1 }],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
  }

  function seedTaskNode(value: string, id = 'n1', filePath = 'task.md'): void {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: id,
      file_path: filePath,
      title: id,
      types: ['task'],
      fields: { status: value },
      body: 'Body',
    });
  }

  function seedExplicitNullContext(additionalFrontmatter = ''): void {
    createGlobalField(db, { name: 'context', field_type: 'string' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'context', sort_order: 1 }],
    });
    const content = `---\ntypes:\n  - task\ncontext:\n${additionalFrontmatter}---\nBody`;
    writeFileSync(join(vaultPath, 'task.md'), content, 'utf-8');
    processFileChange(join(vaultPath, 'task.md'), 'task.md', db, writeLock, vaultPath);
  }

  it('create-global-field undo removes the field and updates _fields.yaml', async () => {
    const create = payload(await callTool(server, 'create-global-field', {
      name: 'priority',
      field_type: 'string',
      description: 'Priority field',
    }));
    expect(create.ok).toBe(true);
    expect(readVault('.schemas/_fields.yaml')).toContain('priority');

    const opId = await latestOperationId('create-global-field');
    await undo(opId);

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'priority'`).get()).toBeUndefined();
    const fieldsYaml = readVault('.schemas/_fields.yaml');
    expect(fieldsYaml).not.toContain('priority');
  });

  it('update-global-field undo restores _fields.yaml and affected schema YAML', async () => {
    seedStatusSchema();

    const update = payload(await callTool(server, 'update-global-field', {
      name: 'status',
      enum_values: ['open', 'done'],
      description: 'Updated status',
    }));
    expect(update.ok).toBe(true);
    expect(readVault('.schemas/_fields.yaml')).toContain('done');
    expect(readVault('.schemas/task.yaml')).toContain('done');

    const opId = await latestOperationId('update-global-field');
    await undo(opId);

    const fieldsYaml = readVault('.schemas/_fields.yaml');
    const schemaYaml = readVault('.schemas/task.yaml');
    expect(fieldsYaml).toContain('closed');
    expect(fieldsYaml).not.toContain('done');
    expect(schemaYaml).toContain('closed');
    expect(schemaYaml).not.toContain('done');
  });

  it('confirmed type-change undo restores deleted node_fields rows and node markdown', async () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'count', sort_order: 1 }],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n1',
      file_path: 'n1.md',
      title: 'n1',
      types: ['task'],
      fields: { count: '42' },
      body: '',
    });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n2',
      file_path: 'n2.md',
      title: 'n2',
      types: ['task'],
      fields: { count: 'not-a-number' },
      body: '',
    });

    const update = payload(await callTool(server, 'update-global-field', {
      name: 'count',
      field_type: 'number',
      confirm: true,
      discard_uncoercible: true,
    }));
    expect(update.ok).toBe(true);
    expect(db.prepare(`SELECT 1 FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`).get()).toBeUndefined();

    const opId = await latestOperationId('update-global-field');
    await undo(opId);

    const restored = db.prepare(`SELECT value_text FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`).get() as { value_text: string };
    expect(restored.value_text).toBe('not-a-number');
    expect(readVault('n1.md')).toContain('count: "42"');
    expect(readVault('n2.md')).toContain('count: not-a-number');
  });

  it('rename-global-field undo restores DB rows and rendered files', async () => {
    seedStatusSchema();
    seedTaskNode('open');

    const rename = payload(await callTool(server, 'rename-global-field', {
      old_name: 'status',
      new_name: 'state',
    }));
    expect(rename.ok).toBe(true);
    expect(readVault('task.md')).toContain('state: open');

    const opId = await latestOperationId('rename-global-field');
    await undo(opId);

    expect(db.prepare(`SELECT name FROM global_fields WHERE name = 'status'`).get()).toEqual({ name: 'status' });
    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'state'`).get()).toBeUndefined();
    expect(readVault('.schemas/_fields.yaml')).toContain('status');
    expect(readVault('.schemas/_fields.yaml')).not.toContain('state');
    expect(readVault('.schemas/task.yaml')).toContain('field: status');
    expect(readVault('task.md')).toContain('status: open');
    expect(readVault('task.md')).not.toContain('state: open');
  });

  it('rename-global-field returns INVALID_PARAMS and rolls back its operation for an unsafe reserved destination', async () => {
    createGlobalField(db, {
      name: 'summary',
      field_type: 'string',
      ai_guessable: true,
    });
    renderFieldsFile(db, vaultPath);
    const fieldsBefore = readVault('.schemas/_fields.yaml');

    const rename = payload(await callTool(server, 'rename-global-field', {
      old_name: 'summary',
      new_name: 'constructor',
    }));

    expect(rename).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS', message: expect.stringMatching(/reserved/i) },
      warnings: [],
    });
    expect(getGlobalField(db, 'summary')?.ai_guessable).toBe(true);
    expect(getGlobalField(db, 'constructor')).toBeNull();
    expect(readVault('.schemas/_fields.yaml')).toBe(fieldsBefore);
    expect(undoHistory()).toEqual([]);
  });

  it('rename-global-field counts a defensive dual row once and undo restores both rows', async () => {
    seedExplicitNullContext();
    const nodeId = (db.prepare(
      `SELECT id FROM nodes WHERE file_path = 'task.md'`,
    ).get() as { id: string }).id;
    db.prepare(`
      INSERT INTO node_fields (node_id, field_name, value_text)
      VALUES (?, 'context', 'Retained rejected value')
    `).run(nodeId);

    const rename = payload(await callTool(server, 'rename-global-field', {
      old_name: 'context',
      new_name: 'background',
    }));
    expect(rename.ok).toBe(true);
    expect(rename.data.affected_nodes).toBe(1);
    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields').all())
      .toEqual([{ field_name: 'background' }]);
    expect(readVault('task.md')).toContain('\nbackground:\n');
    expect(readVault('task.md')).not.toContain('\ncontext:\n');

    const opId = await latestOperationId('rename-global-field');
    await undo(opId);

    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields').all())
      .toEqual([{ field_name: 'context' }]);
    expect(db.prepare(
      `SELECT field_name, value_text FROM node_fields WHERE node_id = ?`,
    ).all(nodeId)).toEqual([
      { field_name: 'context', value_text: 'Retained rejected value' },
    ]);
  });

  it('rename-global-field aborts without DB or file changes on an explicit-null target collision', async () => {
    seedExplicitNullContext('background:\n');
    const fileBefore = readVault('task.md');
    const undoHistoryBefore = undoHistory();

    const rename = payload(await callTool(server, 'rename-global-field', {
      old_name: 'context',
      new_name: 'background',
    }));

    expect(rename.ok).toBe(false);
    expect(rename.error.code).toBe('INVALID_PARAMS');
    expect(rename.error.message).toMatch(/already has.*background|background.*already exists|conflict/i);
    expect(getGlobalField(db, 'context')).not.toBeNull();
    expect(getGlobalField(db, 'background')).toBeNull();
    expect(db.prepare(
      `SELECT field FROM schema_field_claims WHERE schema_name = 'task'`,
    ).all()).toEqual([{ field: 'context' }]);
    expect(db.prepare(
      `SELECT field_name FROM node_explicit_null_fields ORDER BY field_name`,
    ).all()).toEqual([
      { field_name: 'background' },
      { field_name: 'context' },
    ]);
    expect(readVault('task.md')).toBe(fileBefore);
    expect(undoHistory()).toEqual(undoHistoryBefore);
  });

  it('rename-global-field aborts without DB or file changes on a valued target collision', async () => {
    seedExplicitNullContext('background: Existing value\n');
    const fileBefore = readVault('task.md');
    const undoHistoryBefore = undoHistory();

    const rename = payload(await callTool(server, 'rename-global-field', {
      old_name: 'context',
      new_name: 'background',
    }));

    expect(rename.ok).toBe(false);
    expect(rename.error.code).toBe('INVALID_PARAMS');
    expect(rename.error.message).toMatch(/already has.*background|background.*already exists|conflict/i);
    expect(getGlobalField(db, 'context')).not.toBeNull();
    expect(getGlobalField(db, 'background')).toBeNull();
    expect(db.prepare(
      `SELECT field FROM schema_field_claims WHERE schema_name = 'task'`,
    ).all()).toEqual([{ field: 'context' }]);
    expect(db.prepare(
      `SELECT field_name FROM node_explicit_null_fields`,
    ).all()).toEqual([{ field_name: 'context' }]);
    expect(db.prepare(
      `SELECT field_name, value_text FROM node_fields`,
    ).all()).toEqual([{ field_name: 'background', value_text: 'Existing value' }]);
    expect(readVault('task.md')).toBe(fileBefore);
    expect(undoHistory()).toEqual(undoHistoryBefore);
  });

  it('delete-global-field reports an explicit-null node and undo restores its definition and claim', async () => {
    seedExplicitNullContext();

    const del = payload(await callTool(server, 'delete-global-field', { name: 'context' }));

    expect(del.ok).toBe(true);
    expect(del.data.affected_nodes).toBe(1);
    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields').all())
      .toEqual([{ field_name: 'context' }]);
    expect(readVault('task.md')).toContain('\ncontext:\n');

    const opId = await latestOperationId('delete-global-field');
    await undo(opId);

    expect(getGlobalField(db, 'context')).not.toBeNull();
    expect(db.prepare(
      `SELECT field FROM schema_field_claims WHERE schema_name = 'task' AND field = 'context'`,
    ).get()).toEqual({ field: 'context' });
    expect(db.prepare('SELECT field_name FROM node_explicit_null_fields').all())
      .toEqual([{ field_name: 'context' }]);
    expect(readVault('.schemas/_fields.yaml')).toContain('context');
    expect(readVault('.schemas/task.yaml')).toContain('field: context');
    expect(readVault('task.md')).toContain('\ncontext:\n');
  });

  it('delete-global-field undo restores field, claims, and rendered YAML', async () => {
    seedStatusSchema();
    seedTaskNode('open');

    const del = payload(await callTool(server, 'delete-global-field', { name: 'status' }));
    expect(del.ok).toBe(true);
    expect(readVault('.schemas/_fields.yaml')).not.toContain('status');
    expect(readVault('.schemas/task.yaml')).not.toContain('field: status');

    const opId = await latestOperationId('delete-global-field');
    await undo(opId);

    expect(db.prepare(`SELECT name FROM global_fields WHERE name = 'status'`).get()).toEqual({ name: 'status' });
    expect(db.prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'task' AND field = 'status'`).get()).toEqual({ field: 'status' });
    expect(readVault('.schemas/_fields.yaml')).toContain('status');
    expect(readVault('.schemas/task.yaml')).toContain('field: status');
    expect(readVault('task.md')).toContain('status: open');
  });

  it('rejects dry-run and live global-field undo that would exceed the candidate identity bound', async () => {
    createGlobalField(db, {
      name: 'context',
      field_type: 'string',
      required: true,
      ai_guessable: true,
    });
    createSchemaDefinition(db, {
      name: 'project',
      field_claims: [{ field: 'context' }],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'project');

    const update = payload(await callTool(server, 'update-global-field', {
      name: 'context',
      ai_guessable: false,
    }));
    expect(update.ok).toBe(true);
    const operationId = await latestOperationId('update-global-field');

    const exactField = exactBudgetStringFieldName();
    createGlobalField(db, {
      name: exactField,
      field_type: 'string',
      required: true,
      ai_guessable: true,
    });
    createSchemaDefinition(db, {
      name: 'budget',
      field_claims: [{ field: exactField }],
    });

    const fieldsFileBefore = readVault('.schemas/_fields.yaml');
    const dryRunResult = payload(await callTool(server, 'undo-operations', {
      operation_ids: [operationId],
      dry_run: true,
    }));
    expect(dryRunResult).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(FIELD_GUESS_BUDGET_ERROR),
      },
      warnings: [],
    });
    expect(getGlobalField(db, 'context')?.ai_guessable).toBe(false);
    expect(db.prepare(
      'SELECT status FROM undo_operations WHERE operation_id = ?',
    ).get(operationId)).toEqual({ status: 'active' });
    expect(readVault('.schemas/_fields.yaml')).toBe(fieldsFileBefore);

    const undoResult = payload(await callTool(server, 'undo-operations', {
      operation_ids: [operationId],
      dry_run: false,
    }));
    expect(undoResult).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(FIELD_GUESS_BUDGET_ERROR),
      },
      warnings: [],
    });
    expect(getGlobalField(db, 'context')?.ai_guessable).toBe(false);
    expect(db.prepare(
      'SELECT status FROM undo_operations WHERE operation_id = ?',
    ).get(operationId)).toEqual({ status: 'active' });
  });

  it('rolls back a schema undo that would exceed the candidate identity bound', async () => {
    createGlobalField(db, {
      name: 'context',
      field_type: 'string',
      required: true,
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'project',
      field_claims: [{ field: 'context', ai_guessable: true }],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'project');

    const update = payload(await callTool(server, 'update-schema', {
      name: 'project',
      field_claims: [{ field: 'context', ai_guessable: false }],
    }));
    expect(update.ok).toBe(true);
    const operationId = update.data.operation_id as string;

    const exactField = exactBudgetStringFieldName();
    createGlobalField(db, {
      name: exactField,
      field_type: 'string',
      required: true,
      ai_guessable: true,
    });
    createSchemaDefinition(db, {
      name: 'budget',
      field_claims: [{ field: exactField }],
    });

    const undoResult = payload(await callTool(server, 'undo-operations', {
      operation_ids: [operationId],
      dry_run: false,
    }));
    expect(undoResult).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(FIELD_GUESS_BUDGET_ERROR),
      },
      warnings: [],
    });
    expect(db.prepare(`
      SELECT ai_guessable_override
      FROM schema_field_claims
      WHERE schema_name = 'project' AND field = 'context'
    `).get()).toEqual({ ai_guessable_override: 0 });
    expect(db.prepare(
      'SELECT status FROM undo_operations WHERE operation_id = ?',
    ).get(operationId)).toEqual({ status: 'active' });
  });

  it('preflights a multi-operation undo so a later budget failure cannot commit an earlier restore', async () => {
    for (const field of ['context_a', 'context_b']) {
      createGlobalField(db, {
        name: field,
        field_type: 'string',
        required: true,
        ai_guessable: true,
      });
      createSchemaDefinition(db, {
        name: field,
        field_claims: [{ field }],
      });
      renderSchemaFile(db, vaultPath, field);
    }
    renderFieldsFile(db, vaultPath);

    const disableA = payload(await callTool(server, 'update-global-field', {
      name: 'context_a',
      ai_guessable: false,
    }));
    const disableB = payload(await callTool(server, 'update-global-field', {
      name: 'context_b',
      ai_guessable: false,
    }));
    expect(disableA.ok).toBe(true);
    expect(disableB.ok).toBe(true);
    const operationA = disableA.data.operation_id as string;
    const operationB = disableB.data.operation_id as string;
    db.prepare('UPDATE undo_operations SET timestamp = ? WHERE operation_id = ?')
      .run(1_000, operationA);
    db.prepare('UPDATE undo_operations SET timestamp = ? WHERE operation_id = ?')
      .run(2_000, operationB);

    const oneRestoredIdentityChars = serializeFieldGuessCandidateIdentity({
      field: 'context_a',
      field_type: 'string',
      list_item_type: null,
    }).length;
    const baseField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS - oneRestoredIdentityChars - 1,
    );
    createGlobalField(db, {
      name: baseField,
      field_type: 'string',
      required: true,
      ai_guessable: true,
    });
    createSchemaDefinition(db, {
      name: 'budget',
      field_claims: [{ field: baseField }],
    });
    const fieldsFileBefore = readVault('.schemas/_fields.yaml');

    const undoResult = payload(await callTool(server, 'undo-operations', {
      operation_ids: [operationA, operationB],
      dry_run: false,
    }));

    expect(undoResult).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(FIELD_GUESS_BUDGET_ERROR),
      },
      warnings: [],
    });
    expect(getGlobalField(db, 'context_a')?.ai_guessable).toBe(false);
    expect(getGlobalField(db, 'context_b')?.ai_guessable).toBe(false);
    const operationStatuses = db.prepare(`
      SELECT operation_id, status
      FROM undo_operations
      WHERE operation_id IN (?, ?)
    `).all(operationA, operationB) as Array<{ operation_id: string; status: string }>;
    expect(Object.fromEntries(operationStatuses.map(row => [row.operation_id, row.status])))
      .toEqual({ [operationA]: 'active', [operationB]: 'active' });
    expect(readVault('.schemas/_fields.yaml')).toBe(fieldsFileBefore);
  });

  describe('undo keeps note values the operation did not change (#468)', () => {
    function fieldRows(field: string): unknown[] {
      return db.prepare(`
        SELECT n.file_path, f.value_text, f.value_number, f.value_date, f.value_json, f.value_raw_text, f.source
        FROM node_fields f JOIN nodes n ON n.id = f.node_id
        WHERE f.field_name = ?
        ORDER BY n.file_path
      `).all(field);
    }

    function fieldEdges(field: string): unknown[] {
      return db.prepare(`
        SELECT n.file_path, r.target, r.rel_type, r.context, r.resolved_target_id
        FROM relationships r JOIN nodes n ON n.id = r.source_id
        WHERE r.rel_type = ?
        ORDER BY n.file_path, r.target
      `).all(field);
    }

    function writeNote(relPath: string, content: string): void {
      writeFileSync(join(vaultPath, relPath), content, 'utf-8');
      processFileChange(join(vaultPath, relPath), relPath, db, writeLock, vaultPath);
    }

    function usePolicy(policy: 1 | 2): void {
      if (policy === 2) db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    }

    // Notes that already use `customer` before any definition exists: a bare value,
    // a link, and a list mixing both.
    const UNMANAGED_NOTES: Record<string, string> = {
      'a.md': '---\ncustomer: Acme\n---\nBody A\n',
      'b.md': '---\ncustomer: "[[Beta Works]]"\nrank: 3\n---\nBody B\n',
      'c.md': '---\ncustomer:\n  - Acme\n  - "[[Beta Works]]"\n---\nBody C\n',
    };

    it.each([
      { field_type: 'string', policy: 1 as const },
      { field_type: 'reference', policy: 1 as const },
      { field_type: 'reference', policy: 2 as const },
    ])('create-global-field ($field_type, policy $policy) undo leaves existing values and files exactly as they were', async ({ field_type, policy }) => {
      usePolicy(policy);
      writeNote('Acme.md', '---\nrank: 1\n---\nBody\n');
      for (const [relPath, content] of Object.entries(UNMANAGED_NOTES)) writeNote(relPath, content);
      const rowsBefore = fieldRows('customer');
      const edgesBefore = fieldEdges('customer');
      expect(rowsBefore).toHaveLength(3);

      const create = payload(await callTool(server, 'create-global-field', { name: 'customer', field_type }));
      expect(create.ok).toBe(true);
      const result = payload(await callTool(server, 'undo-operations', {
        operation_ids: [create.data.operation_id],
        dry_run: false,
      }));
      expect(result.ok).toBe(true);

      expect(getGlobalField(db, 'customer')).toBeNull();
      expect(fieldRows('customer')).toEqual(rowsBefore);
      // The bare value is plain text again, with no link derived from it.
      expect(fieldEdges('customer')).toEqual(edgesBefore);
      for (const [relPath, content] of Object.entries(UNMANAGED_NOTES)) expect(readVault(relPath)).toBe(content);
    });

    it('create-global-field undo keeps a bare value as the note shows it after edits while the field was a reference', async () => {
      usePolicy(2);
      writeNote('Target.md', '---\nrank: 1\n---\nBody\n');
      writeNote('tool.md', '---\nowner: Target\n---\nBody\n');
      writeNote('hand.md', '---\nowner: Target\n---\nBody\n');
      const create = payload(await callTool(server, 'create-global-field', { name: 'owner', field_type: 'reference' }));
      // A tool edit renders the value as the reference it now is; an edit by hand keeps it bare.
      const toolId = (db.prepare(`SELECT id FROM nodes WHERE file_path = 'tool.md'`).get() as { id: string }).id;
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: toolId, file_path: 'tool.md', title: 'tool', types: [], fields: { owner: 'Target' }, body: 'Edited by a tool',
      });
      writeNote('hand.md', '---\nowner: Target\n---\nEdited by hand\n');
      expect(readVault('tool.md')).toContain('owner: "[[Target]]"');
      // An editor then leaves a duplicate key, which the parser tolerates, before any re-index.
      const toolFile = readVault('tool.md').replace('---\n', '---\nextra: 1\nextra: 2\n');
      writeFileSync(join(vaultPath, 'tool.md'), toolFile, 'utf-8');

      await undo(create.data.operation_id);

      expect(fieldRows('owner')).toEqual([
        expect.objectContaining({ file_path: 'hand.md', value_text: 'Target', value_raw_text: null }),
        expect.objectContaining({ file_path: 'tool.md', value_text: 'Target', value_raw_text: '[[Target]]' }),
      ]);
      expect(fieldEdges('owner')).toEqual([expect.objectContaining({ file_path: 'tool.md', target: 'Target' })]);
      expect(readVault('tool.md')).toBe(toolFile);
      expect(readVault('hand.md')).toBe('---\nowner: Target\n---\nEdited by hand\n');
    });

    it('create-global-field undo with no existing values removes only the definition', async () => {
      writeNote('other.md', '---\nrank: 3\n---\nBody\n');
      const create = payload(await callTool(server, 'create-global-field', { name: 'customer', field_type: 'string' }));
      await undo(create.data.operation_id);

      expect(getGlobalField(db, 'customer')).toBeNull();
      expect(fieldRows('customer')).toEqual([]);
      expect(readVault('other.md')).toBe('---\nrank: 3\n---\nBody\n');
    });

    it('undoing a creation and the claim that converted its values restores the original values', async () => {
      createSchemaDefinition(db, { name: 'item', field_claims: [] });
      renderSchemaFile(db, vaultPath, 'item');
      const original = '---\ntypes:\n  - item\nsize: "5"\n---\nBody\n';
      writeNote('item.md', original);
      const rowsBefore = fieldRows('size');
      expect(rowsBefore).toEqual([expect.objectContaining({ value_text: '5', value_number: null })]);

      const create = payload(await callTool(server, 'create-global-field', { name: 'size', field_type: 'number' }));
      const claim = payload(await callTool(server, 'update-schema', { name: 'item', add_field_claims: [{ field: 'size' }] }));
      expect(claim.ok).toBe(true);
      expect(fieldRows('size')).toEqual([expect.objectContaining({ value_text: null, value_number: 5 })]);

      const result = payload(await callTool(server, 'undo-operations', {
        operation_ids: [create.data.operation_id, claim.data.operation_id],
        dry_run: false,
      }));
      expect(result.ok).toBe(true);

      expect(getGlobalField(db, 'size')).toBeNull();
      expect(fieldRows('size')).toEqual(rowsBefore);
      expect(readVault('item.md')).toBe(original);
    });

    it('undoing only the creation keeps the values a later claim converted; undoing the claim then restores them', async () => {
      createSchemaDefinition(db, { name: 'item', field_claims: [] });
      renderSchemaFile(db, vaultPath, 'item');
      const original = '---\ntypes:\n  - item\nsize: "5"\n---\nBody\n';
      writeNote('item.md', original);
      const rowsBefore = fieldRows('size');

      const create = payload(await callTool(server, 'create-global-field', { name: 'size', field_type: 'number' }));
      const claim = payload(await callTool(server, 'update-schema', { name: 'item', add_field_claims: [{ field: 'size' }] }));
      const converted = readVault('item.md');
      expect(converted).toContain('size: 5\n');

      await undo(create.data.operation_id);
      expect(getGlobalField(db, 'size')).toBeNull();
      expect(db.prepare(`SELECT 1 FROM schema_field_claims WHERE field = 'size'`).get()).toBeUndefined();
      // The creation converted nothing, so its undo keeps the claim's value.
      expect(fieldRows('size')).toEqual([expect.objectContaining({ value_text: null, value_number: 5 })]);
      expect(readVault('item.md')).toBe(converted);

      await undo(claim.data.operation_id);
      expect(fieldRows('size')).toEqual(rowsBefore);
      expect(readVault('item.md')).toBe(original);
    });

    it('create-global-field undo keeps the link of a reference value written while the field was defined', async () => {
      usePolicy(2);
      const create = payload(await callTool(server, 'create-global-field', { name: 'owner', field_type: 'reference' }));
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: 'n1',
        file_path: 'n1.md',
        title: 'n1',
        types: [],
        fields: { owner: 'Target' },
        body: 'Body',
      });
      const written = readVault('n1.md');
      expect(written).toContain('owner: "[[Target]]"');

      await undo(create.data.operation_id);

      expect(getGlobalField(db, 'owner')).toBeNull();
      expect(fieldRows('owner')).toEqual([expect.objectContaining({ value_text: 'Target', value_raw_text: '[[Target]]' })]);
      expect(readVault('n1.md')).toBe(written);
    });

    it('rename-global-field undo keeps a value written under the new name after the rename', async () => {
      seedStatusSchema();
      seedTaskNode('open');
      const rename = payload(await callTool(server, 'rename-global-field', { old_name: 'status', new_name: 'state' }));
      expect(rename.ok).toBe(true);
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: 'n2', file_path: 'later.md', title: 'later', types: ['task'], fields: { state: 'closed' }, body: 'Body',
      });

      await undo(rename.data.operation_id);

      expect(fieldRows('status')).toEqual([expect.objectContaining({ file_path: 'task.md', value_text: 'open' })]);
      expect(fieldRows('state')).toEqual([expect.objectContaining({ file_path: 'later.md', value_text: 'closed' })]);
      expect(readVault('later.md')).toContain('state: closed');
      expect(readVault('task.md')).toContain('status: open');
    });

    it('rename-global-field undo keeps the link of a reference value left under the new name', async () => {
      usePolicy(2);
      createGlobalField(db, { name: 'owner', field_type: 'reference' });
      createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'owner', sort_order: 1 }] });
      renderFieldsFile(db, vaultPath);
      renderSchemaFile(db, vaultPath, 'task');
      writeNote('Target.md', '---\nrank: 1\n---\nBody\n');
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: 'n1', file_path: 'task.md', title: 'task', types: ['task'], fields: { owner: 'Target' }, body: 'Body',
      });
      const rename = payload(await callTool(server, 'rename-global-field', { old_name: 'owner', new_name: 'lead' }));
      expect(rename.ok).toBe(true);
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: 'n2', file_path: 'later.md', title: 'later', types: ['task'], fields: { lead: 'Target' }, body: 'Body',
      });
      expect(readVault('later.md')).toContain('lead: "[[Target]]"');

      await undo(rename.data.operation_id);

      expect(fieldRows('owner')).toEqual([expect.objectContaining({ file_path: 'task.md', value_text: 'Target' })]);
      expect(fieldRows('lead')).toEqual([expect.objectContaining({ file_path: 'later.md', value_text: 'Target', value_raw_text: '[[Target]]' })]);
      expect(readVault('later.md')).toContain('lead: "[[Target]]"');
      expect(fieldEdges('lead')).toEqual([expect.objectContaining({ file_path: 'later.md', target: 'Target', resolved_target_id: expect.any(String) })]);
    });

    it('delete-global-field undo keeps a value a note gained after the deletion', async () => {
      seedStatusSchema();
      seedTaskNode('open');
      const del = payload(await callTool(server, 'delete-global-field', { name: 'status' }));
      expect(del.ok).toBe(true);
      writeNote('later.md', '---\nstatus: closed\n---\nBody\n');

      await undo(del.data.operation_id);

      expect(fieldRows('status')).toEqual([
        expect.objectContaining({ file_path: 'later.md', value_text: 'closed' }),
        expect.objectContaining({ file_path: 'task.md', value_text: 'open' }),
      ]);
      expect(readVault('later.md')).toContain('status: closed');
    });

    it('update-global-field undo keeps a value a note gained after the update', async () => {
      seedStatusSchema();
      seedTaskNode('open');
      const update = payload(await callTool(server, 'update-global-field', { name: 'status', field_type: 'string', confirm: true }));
      expect(update.ok).toBe(true);
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: 'n2', file_path: 'later.md', title: 'later', types: ['task'], fields: { status: 'waiting' }, body: 'Body',
      });
      const later = readVault('later.md');
      expect(later).toContain('status: waiting');

      await undo(update.data.operation_id);

      expect(getGlobalField(db, 'status')?.field_type).toBe('enum');
      expect(fieldRows('status')).toEqual([
        expect.objectContaining({ file_path: 'later.md', value_text: 'waiting' }),
        expect.objectContaining({ file_path: 'task.md', value_text: 'open' }),
      ]);
      // The note the update never touched is not rewritten, so its file keeps the value
      // the restored enum does not accept, and a re-index keeps it too.
      expect(readVault('later.md')).toBe(later);
      processFileChange(join(vaultPath, 'later.md'), 'later.md', db, writeLock, vaultPath);
      expect(fieldRows('status')).toEqual([
        expect.objectContaining({ file_path: 'later.md', value_text: 'waiting' }),
        expect.objectContaining({ file_path: 'task.md', value_text: 'open' }),
      ]);
    });
  });

  it('wiki bootstrap undo restores the legacy schema and removes reconciliation fields', async () => {
    // Given: a legacy wiki schema and an undo operation for its upgrade.
    ensureWikiSchema(db, getWikiConfig(db));
    db.prepare(`DELETE FROM schema_field_claims WHERE schema_name = 'wiki' AND field IN (${RECONCILIATION_WIKI_FIELDS.map(() => '?').join(', ')})`).run(...RECONCILIATION_WIKI_FIELDS);
    db.prepare(`DELETE FROM global_fields WHERE name IN (${RECONCILIATION_WIKI_FIELDS.map(() => '?').join(', ')})`).run(...RECONCILIATION_WIKI_FIELDS);
    const operationId = createOperation(db, { source_tool: 'wiki-write', description: 'Upgrade wiki schema' });

    // When: bootstrap upgrades the schema and the operation is undone.
    ensureWikiSchema(db, getWikiConfig(db), operationId);
    await undo(operationId);

    // Then: the original claim set returns and new global fields are removed.
    expect(db.prepare(`SELECT schema_count FROM undo_operations WHERE operation_id = ?`).get(operationId)).toEqual({ schema_count: 1 });
    expect(db.prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'wiki' ORDER BY sort_order`).all()).toEqual([
      { field: 'wiki_for' },
      { field: 'wiki_parent' },
      { field: 'wiki_evidence_hash' },
      { field: 'wiki_curated_at' },
      { field: 'wiki_state' },
    ]);
    expect(db.prepare(`SELECT name FROM global_fields WHERE name IN (${RECONCILIATION_WIKI_FIELDS.map(() => '?').join(', ')})`).all(...RECONCILIATION_WIKI_FIELDS)).toEqual([]);
  });
});
