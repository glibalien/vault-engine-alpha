import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerUpdateGlobalField } from '../../src/mcp/tools/update-global-field.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  createGlobalField(db, { name: 'count', field_type: 'string', overrides_allowed: { ai_guessable: true } });
  createGlobalField(db, { name: 'status', field_type: 'string', required: true, default_value: 'open' });
  createSchemaDefinition(db, { name: 'note', field_claims: [{ field: 'count' }] });
});

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function node(name: string, count: string | null) {
  return executeMutation(db, writeLock, vaultPath, {
    source: count === null ? 'watcher' : 'tool', node_id: null, file_path: `${name}.md`, title: name,
    types: ['note'], fields: { count }, body: `Original ${name}\n`,
    explicitNullFields: count === null ? ['count'] : undefined,
  });
}

function handler(register: typeof registerUpdateSchema | typeof registerUpdateGlobalField) {
  let captured!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: typeof captured) => { captured = callback; },
    registerTool: (_name: string, _config: unknown, callback: typeof captured) => { captured = callback; },
  } as unknown as McpServer;
  register(server, db, { writeLock, vaultPath });
  return async (args: Record<string, unknown>) => {
    const result = await captured(args) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
  };
}

function databaseSnapshot() {
  return Object.fromEntries([
    'global_fields', 'schemas', 'schema_field_claims', 'nodes', 'node_types', 'node_fields',
    'node_explicit_null_fields', 'relationships', 'edits_log', 'undo_operations', 'undo_snapshots',
    'undo_schema_snapshots', 'undo_global_field_snapshots',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

function filesSnapshot() {
  return Object.fromEntries(readdirSync(vaultPath, { recursive: true }).map(String).sort()
    .filter(path => statSync(join(vaultPath, path)).isFile())
    .map(path => [path, readFileSync(join(vaultPath, path))]));
}

describe('schema and global-field preview projection preconditions', () => {
  it.each(['replacement', 'patch'] as const)('rejects schema %s preview and live when an affected file is missing', async form => {
    node('present', '42');
    node('missing', null);
    renameSync(join(vaultPath, 'missing.md'), join(vaultPath, 'moved.md'));
    const beforeDb = databaseSnapshot();
    const beforeFiles = filesSnapshot();
    const update = handler(registerUpdateSchema);
    const change = form === 'replacement'
      ? { field_claims: [{ field: 'count' }, { field: 'status' }] }
      : { add_field_claims: [{ field: 'status' }] };

    for (const dry_run of [false, true]) {
      const result = await update({ name: 'note', ...change, dry_run });
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('content changed since') } });
      expect(databaseSnapshot()).toEqual(beforeDb);
      expect(filesSnapshot()).toEqual(beforeFiles);
    }
  });

  it.each([
    ['value', '42'], ['explicit-null', null], ['discarded value', 'not-a-number'],
  ] as const)('rejects global-field preview and live for a missing %s node', async (_kind, value) => {
    node('present', '21');
    node('missing', value);
    renameSync(join(vaultPath, 'missing.md'), join(vaultPath, 'moved.md'));
    const beforeDb = databaseSnapshot();
    const beforeFiles = filesSnapshot();
    const update = handler(registerUpdateGlobalField);

    for (const confirm of [true, false]) {
      const result = await update({ name: 'count', field_type: 'number', confirm, discard_uncoercible: true });
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('content changed since') } });
      expect(databaseSnapshot()).toEqual(beforeDb);
      expect(filesSnapshot()).toEqual(beforeFiles);
    }
  });

  it('keeps global-field impact preview read-only when all target files exist', async () => {
    node('value', '42');
    node('explicit-null', null);
    node('discarded', 'not-a-number');
    const beforeDb = databaseSnapshot();
    const beforeFiles = filesSnapshot();
    const result = await handler(registerUpdateGlobalField)({ name: 'count', field_type: 'number' });

    expect(result).toMatchObject({ ok: true, data: { preview: true, affected_nodes: 2, would_orphan: 1 } });
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(filesSnapshot()).toEqual(beforeFiles);
  });

  it('does not require files for nodes outside the live field re-render target set', async () => {
    node('present', '42');
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'unrelated.md', title: 'Unrelated',
      types: ['note'], fields: {}, body: 'No count value or explicit-null marker\n',
    });
    renameSync(join(vaultPath, 'unrelated.md'), join(vaultPath, 'moved.md'));
    const beforeDb = databaseSnapshot();
    const beforeFiles = filesSnapshot();
    const update = handler(registerUpdateGlobalField);

    expect(await update({ name: 'count', field_type: 'number' })).toMatchObject({ ok: true, data: { preview: true } });
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(filesSnapshot()).toEqual(beforeFiles);
    expect(await update({ name: 'count', field_type: 'number', confirm: true })).toMatchObject({ ok: true });
  });

  it('retains global-field metadata updates without requiring node projections', async () => {
    const missing = node('missing', '42');
    renameSync(join(vaultPath, 'missing.md'), join(vaultPath, 'moved.md'));
    const beforeNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(missing.node_id);

    expect(await handler(registerUpdateGlobalField)({ name: 'count', description: 'A count' }))
      .toMatchObject({ ok: true, data: { preview: false } });
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(missing.node_id)).toEqual(beforeNode);
  });

  it('retains the global-field discard confirmation gate before live projection checks', async () => {
    node('missing', 'not-a-number');
    renameSync(join(vaultPath, 'missing.md'), join(vaultPath, 'moved.md'));
    const beforeDb = databaseSnapshot();
    const beforeFiles = filesSnapshot();
    const result = await handler(registerUpdateGlobalField)({ name: 'count', field_type: 'number', confirm: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(filesSnapshot()).toEqual(beforeFiles);
  });

  it.each([
    ['display', { display_name: 'Notes' }],
    ['AI-only claim', { update_field_claims: [{ field: 'count', ai_guessable: true }] }],
  ])('does not require node files for schema %s metadata', async (_name, change) => {
    node('missing', '42');
    renameSync(join(vaultPath, 'missing.md'), join(vaultPath, 'moved.md'));
    const beforeDb = databaseSnapshot();
    const beforeFiles = filesSnapshot();
    const update = handler(registerUpdateSchema);

    expect(await update({ name: 'note', ...change, dry_run: true })).toMatchObject({ ok: true });
    expect(databaseSnapshot()).toEqual(beforeDb);
    expect(filesSnapshot()).toEqual(beforeFiles);
    expect(await update({ name: 'note', ...change, dry_run: false })).toMatchObject({ ok: true });
  });
});
