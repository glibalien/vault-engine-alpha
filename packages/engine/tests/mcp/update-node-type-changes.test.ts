import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints, addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { executeMutation } from '../../src/pipeline/execute.js';

// Type membership changes go through update-node (add_types / remove_types /
// set_types); the standalone add-type-to-node and remove-type-from-node tools
// were retired. These cases carry over the behaviors those tools pinned.

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface Response {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings: Array<{ code: string; message: string; severity?: string }>;
}

async function updateNode(args: Record<string, unknown>): Promise<Response> {
  let handler!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => { handler = h; },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, writeLock, vaultPath);
  const result = await handler(args) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Response;
}

function createNode(filePath: string, types: string[], fields: Record<string, unknown> = {}): string {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: filePath,
    title: filePath.replace(/\.md$/, ''), types, fields, body: '',
  }).node_id;
}

const explicitNulls = (nodeId: string) => db.prepare(
  'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
).all(nodeId);
const storedField = (nodeId: string, field: string) => db.prepare(
  'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
).get(nodeId, field);
const undoCount = () => (db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get() as { c: number }).c;
const codes = (r: Response) => r.warnings.map(w => w.code);

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node type changes', () => {
  it('keeps an orphan explicit-null marker instead of defaulting the newly claimed field', async () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal', required: true });
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });
    const nodeId = createNode('Explicit Null.md', ['note']);
    db.prepare('INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)').run(nodeId, 'priority');

    const preview = await updateNode({ node_id: nodeId, add_types: ['task'], dry_run: true });
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview.data)).not.toContain('"defaulted"');
    expect(undoCount()).toBe(0);

    const live = await updateNode({ node_id: nodeId, add_types: ['task'] });
    expect(live.ok).toBe(true);
    expect(live.data?.types).toEqual(['note', 'task']);
    expect(explicitNulls(nodeId)).toEqual([{ field_name: 'priority' }]);
    expect(storedField(nodeId, 'priority')).toBeUndefined();
  });

  it('reports and audits an explicit-null field orphaned by remove_types', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'a', field_claims: [{ field: 'status' }] });
    createSchemaDefinition(db, { name: 'b', field_claims: [] });
    const nodeId = createNode('Null Live.md', ['a', 'b']);
    db.prepare('INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES (?, ?)').run(nodeId, 'status');

    const result = await updateNode({ node_id: nodeId, remove_types: ['a'] });

    expect(result.ok).toBe(true);
    expect(result.data?.types).toEqual(['b']);
    expect(result.data?.orphan_fields).toEqual(['status']);
    expect(codes(result)).not.toContain('LAST_TYPE_REMOVAL');
    expect(explicitNulls(nodeId)).toEqual([{ field_name: 'status' }]);
    expect(storedField(nodeId, 'status')).toBeUndefined();
    const log = db.prepare(
      `SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'fields-orphaned' ORDER BY id DESC LIMIT 1`,
    ).get(nodeId) as { details: string };
    expect(JSON.parse(log.details)).toMatchObject({ source: 'tool', orphaned_fields: ['status'], node_types: ['b'] });
    expect(readFileSync(join(vaultPath, 'Null Live.md'), 'utf8')).toMatch(/^status:\s*$/m);
  });

  it.each([
    ['remove_types', { remove_types: ['task'] }],
    ['set_types', { set_types: [] }],
  ])('warns LAST_TYPE_REMOVAL when %s leaves the node typeless', async (_label, change) => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    const nodeId = createNode('Last Type.md', ['task'], { status: 'open' });

    const preview = await updateNode({ node_id: nodeId, ...change, dry_run: true });
    expect(preview.ok).toBe(true);
    expect(codes(preview)).toContain('LAST_TYPE_REMOVAL');
    expect(undoCount()).toBe(0);

    const live = await updateNode({ node_id: nodeId, ...change });
    expect(live.ok).toBe(true);
    expect(live.data?.types).toEqual([]);
    expect(live.data?.orphan_fields).toEqual(['status']);
    expect(codes(live)).toContain('LAST_TYPE_REMOVAL');
    expect(live.warnings.find(w => w.code === 'LAST_TYPE_REMOVAL')?.severity).toBe('warning');
  });

  it('does not warn when an untyped node stays untyped', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const nodeId = createNode('Untyped.md', []);
    const result = await updateNode({ node_id: nodeId, set_types: [] });
    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain('LAST_TYPE_REMOVAL');
  });
});
