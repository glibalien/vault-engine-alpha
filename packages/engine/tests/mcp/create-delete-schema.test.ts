import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addSchemaUndoSnapshots, addUiHints } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, getSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { registerCreateSchema } from '../../src/mcp/tools/create-schema.js';
import { registerDeleteSchema } from '../../src/mcp/tools/delete-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { listOperations } from '../../src/undo/operation.js';
import { restoreMany } from '../../src/undo/restore.js';
import {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  serializeFieldGuessCandidateIdentity,
} from '@vault/contract';

interface Envelope { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string }; warnings: unknown[] }
function parseResult(result: unknown): Envelope {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Envelope;
}

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function captureCreate(): (args: Record<string, unknown>) => Promise<unknown> {
  let h: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake = { registerTool: (_n: string, _c: unknown, fn: (...a: unknown[]) => unknown) => { h = (args) => fn(args) as Promise<unknown>; } } as unknown as McpServer;
  registerCreateSchema(fake, db, { vaultPath });
  return h!;
}
function captureDelete(): (args: Record<string, unknown>) => Promise<unknown> {
  let h: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, fn: (...a: unknown[]) => unknown) => { h = (args) => fn(args) as Promise<unknown>; } } as unknown as McpServer;
  registerDeleteSchema(fake, db, { vaultPath });
  return h!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addSchemaUndoSnapshots(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
});
afterEach(() => { db.close(); cleanup(); });

describe('create-schema undo', () => {
  it('creates op; undo removes schema + yaml', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    const handler = captureCreate();
    const result = parseResult(await handler({ name: 'task', field_claims: [{ field: 'status' }] }));
    expect(result.ok).toBe(true);

    const list = listOperations(db, { source_tool: 'create-schema' });
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].schema_count).toBe(1);

    restoreMany(db, writeLock, vaultPath, { operation_ids: [list.operations[0].operation_id], dry_run: false });

    expect(getSchemaDefinition(db, 'task')).toBeNull();
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(false);
  });

  it('discards its empty undo operation when candidate-budget admission rejects the schema', async () => {
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
    const handler = captureCreate();

    const result = parseResult(await handler({
      name: 'over-budget',
      field_claims: [{ field: overField }],
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/candidate identity projection.*20,000/i) },
    });
    expect(getSchemaDefinition(db, 'over-budget')).toBeNull();
    expect(listOperations(db, { source_tool: 'create-schema' }).operations).toEqual([]);
  });
});

describe('delete-schema undo', () => {
  it('deletes op; undo restores schema + yaml', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }], display_name: 'Task' });
    const handler = captureDelete();
    const result = parseResult(await handler({ name: 'task' }));
    expect(result.ok).toBe(true);

    const list = listOperations(db, { source_tool: 'delete-schema' });
    expect(list.operations.length).toBe(1);

    restoreMany(db, writeLock, vaultPath, { operation_ids: [list.operations[0].operation_id], dry_run: false });

    const restored = getSchemaDefinition(db, 'task');
    expect(restored?.display_name).toBe('Task');
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(true);
  });
});
