// packages/engine/tests/mcp/update-node-coalescing.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { EditSessionRegistry } from '../../src/undo/edit-session.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string; let cleanup: () => void;
let db: Database.Database; let writeLock: WriteLockManager;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function handlerWith(reg: EditSessionRegistry) {
  let captured!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = { tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => { captured = (args) => h(args) as Promise<unknown>; } } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, writeLock, vaultPath, undefined, undefined, reg);
  return captured;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:'); createSchema(db); addUndoTables(db); addUiHints(db);
  writeLock = new WriteLockManager();
});
afterEach(() => { db.close(); cleanup(); });

function makeNode(): string {
  const r = executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'Note.md', title: 'Note', types: [], fields: {}, body: 'v0',
  });
  return r.node_id;
}

describe('update-node edit_session_id coalescing', () => {
  it('collapses N saves in one session into a single undo op whose pre-state is the session start', async () => {
    const id = makeNode();
    const handler = handlerWith(new EditSessionRegistry());
    expect(parseResult(await handler({ node_id: id, set_body: 'v1', edit_session_id: 'sess-1' })).ok).toBe(true);
    expect(parseResult(await handler({ node_id: id, set_body: 'v2', edit_session_id: 'sess-1' })).ok).toBe(true);

    const ops = db.prepare("SELECT operation_id FROM undo_operations WHERE source_tool = 'update-node'").all() as Array<{ operation_id: string }>;
    expect(ops.length).toBe(1);
    const snaps = db.prepare('SELECT body FROM undo_snapshots WHERE operation_id = ?').all(ops[0].operation_id) as Array<{ body: string }>;
    expect(snaps.length).toBe(1);
    expect(snaps[0].body).toBe('v0'); // pre-state = body before the first save, not 'v1'
  });

  it('uses separate undo ops for separate sessions', async () => {
    const id = makeNode();
    const handler = handlerWith(new EditSessionRegistry());
    await handler({ node_id: id, set_body: 'a', edit_session_id: 'sess-1' });
    await handler({ node_id: id, set_body: 'b', edit_session_id: 'sess-2' });
    const ops = db.prepare("SELECT operation_id FROM undo_operations WHERE source_tool = 'update-node'").all();
    expect(ops.length).toBe(2);
  });

  it('rejects edit_session_id in query mode', async () => {
    const handler = handlerWith(new EditSessionRegistry());
    const env = parseResult(await handler({ query: { types: ['note'] }, set_fields: { x: 1 }, edit_session_id: 'sess-1' }));
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_PARAMS');
  });
});
