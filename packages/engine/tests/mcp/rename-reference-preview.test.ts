import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints, addUndoTables } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';

interface ToolResponse {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    details?: Record<string, unknown>;
  };
}

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function captureHandler(
  register: (server: McpServer) => void,
): (args: Record<string, unknown>) => Promise<unknown> {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, fn: (...args: unknown[]) => unknown) => {
      handler = (args) => fn(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  register(server);
  return handler!;
}

function parseResult(result: unknown): ToolResponse {
  const envelope = result as { content: Array<{ text: string }> };
  return JSON.parse(envelope.content[0].text) as ToolResponse;
}

function updateHandler() {
  return captureHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
}

function batchHandler() {
  return captureHandler(server => registerBatchMutate(server, db, writeLock, vaultPath));
}

function createNode(params: {
  filePath: string;
  title: string;
  types: string[];
  fields?: Record<string, unknown>;
  body?: string;
}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: params.filePath,
    title: params.title,
    types: params.types,
    fields: params.fields ?? {},
    body: params.body ?? '',
  });
}

function persistedState() {
  return {
    nodes: db.prepare(
      'SELECT id, file_path, title, body, content_hash, version FROM nodes ORDER BY id',
    ).all(),
    fields: db.prepare(
      'SELECT node_id, field_name, value_text, value_json FROM node_fields ORDER BY node_id, field_name',
    ).all(),
    relationships: db.prepare(
      'SELECT source_id, target, resolved_target_id FROM relationships ORDER BY source_id, target',
    ).all(),
    sideEffects: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get(),
  };
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addUiHints(db);
  writeLock = new WriteLockManager();

  createGlobalField(db, { name: 'project', field_type: 'reference' });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('rename reference dry-run parity', () => {
  it('update-node rejects a missing referencing file that live rename would rewrite', async () => {
    const target = createNode({ filePath: 'Old Name.md', title: 'Old Name', types: ['note'] });
    const reference = createNode({
      filePath: 'Reference.md',
      title: 'Reference',
      types: ['note'],
      body: 'See [[Old Name]] for details.',
    });
    const targetPath = join(vaultPath, 'Old Name.md');
    const referencePath = join(vaultPath, 'Reference.md');
    const targetContent = readFileSync(targetPath, 'utf8');
    unlinkSync(referencePath);
    const before = persistedState();

    const result = parseResult(await updateHandler()({
      node_id: target.node_id,
      set_title: 'New Name',
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONTENT_HASH_MISMATCH',
      details: {
        current_content_hash: null,
        current_node: { id: reference.node_id },
      },
    });
    expect(persistedState()).toEqual(before);
    expect(readFileSync(targetPath, 'utf8')).toBe(targetContent);
    expect(existsSync(join(vaultPath, 'New Name.md'))).toBe(false);
    expect(existsSync(referencePath)).toBe(false);
  });

  it('update-node ignores a missing resolved candidate whose contents would not change', async () => {
    const target = createNode({ filePath: 'Old Name.md', title: 'Old Name', types: ['note'] });
    const unaffected = createNode({
      filePath: 'Case-only Reference.md',
      title: 'Case-only Reference',
      types: ['task'],
      fields: { project: 'old name' },
    });
    expect(db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?',
    ).get(unaffected.node_id)).toEqual({ resolved_target_id: target.node_id });
    const unaffectedPath = join(vaultPath, 'Case-only Reference.md');
    unlinkSync(unaffectedPath);
    const before = persistedState();

    const result = parseResult(await updateHandler()({
      node_id: target.node_id,
      set_title: 'New Name',
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      dry_run: true,
      preview: { title: 'New Name', file_path: 'New Name.md' },
    });
    expect(persistedState()).toEqual(before);
    expect(existsSync(unaffectedPath)).toBe(false);
    expect(existsSync(join(vaultPath, 'Old Name.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'New Name.md'))).toBe(false);
  });

  it('batch-mutate rejects a missing referencing file and rolls back its composed preview', async () => {
    const target = createNode({ filePath: 'Old Name.md', title: 'Old Name', types: ['note'] });
    const reference = createNode({
      filePath: 'Reference.md',
      title: 'Reference',
      types: ['task'],
      fields: { project: 'Old Name' },
    });
    const referencePath = join(vaultPath, 'Reference.md');
    unlinkSync(referencePath);
    const before = persistedState();

    const result = parseResult(await batchHandler()({
      dry_run: true,
      operations: [{
        op: 'update',
        params: { node_id: target.node_id, set_title: 'New Name', set_body: 'preview-only body' },
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONTENT_HASH_MISMATCH',
      details: {
        current_content_hash: null,
        current_node: { id: reference.node_id },
      },
    });
    expect(persistedState()).toEqual(before);
    expect(existsSync(join(vaultPath, 'Old Name.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'New Name.md'))).toBe(false);
    expect(existsSync(referencePath)).toBe(false);
  });

  it('batch-mutate keeps composed create-reference-rename previews side-effect free', async () => {
    const before = persistedState();

    const result = parseResult(await batchHandler()({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'Old Name', types: ['note'] } },
        {
          op: 'create',
          params: {
            title: 'Reference',
            types: ['task'],
            fields: { project: 'Old Name' },
            body: 'See [[Old Name]].',
          },
        },
        { op: 'update', params: { title: 'Old Name', set_title: 'New Name' } },
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ dry_run: true, op_count: 3 });
    expect(result.data?.would_apply).toHaveLength(3);
    expect(persistedState()).toEqual(before);
    expect(existsSync(join(vaultPath, 'Old Name.md'))).toBe(false);
    expect(existsSync(join(vaultPath, 'New Name.md'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Reference.md'))).toBe(false);
  });
});

it('typed exact-path rename previews reject missing reference projections', async () => {
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
  db.prepare("UPDATE global_fields SET reference_target = 'note' WHERE name = 'project'").run();
  const target = createNode({ filePath: 'Old Name.md', title: 'Old Name', types: ['note'] });
  createNode({ filePath: 'Reference.md', title: 'Reference', types: ['task'], fields: { project: 'Old Name.md' } });
  unlinkSync(join(vaultPath, 'Reference.md'));
  const before = persistedState();
  for (const handler of [updateHandler(), batchHandler()]) {
    const params = { node_id: target.node_id, set_title: 'New Name' };
    const result = parseResult(await handler({ ...params, operations: [{ op: 'update', params }], dry_run: true }));
    expect(result.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(persistedState()).toEqual(before);
  }
});
