// Regression: batch-mutate `set_title` desyncs nodes.title from the filename.
//
// Found 2026-08-03 while tracing broken wiki sub-page links. `update-node`
// (single AND query mode) derives a new file_path from a changed title and
// renames the file; batch-mutate's update path passes `file_path:
// node.file_path` verbatim while writing the new title into the DB. The result
// is a node whose title no longer matches its filename — which breaks every
// title-derived `[[wikilink]]` in Obsidian, and breaks them engine-side too the
// moment the watcher next re-parses the file (parse.ts always re-derives title
// from the filename).
//
// Two real vault nodes were desynced this way in a single call on 2026-07-25.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface BatchResponse {
  ok: boolean;
  data?: { results: Array<{ file_path: string; node_id?: string }>; [k: string]: unknown };
  error?: { code: string; message: string };
  warnings: Array<{ code: string; message: string }>;
}

function parseResult(result: unknown): BatchResponse {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as BatchResponse;
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerBatchMutate(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('batch-mutate set_title', () => {
  it('renames the file so title and filename stay in sync', async () => {
    const handler = getHandler();

    const created = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Old Title', types: ['bare'] } }],
    }));
    expect(created.ok).toBe(true);
    const nodeId = created.data!.results[0].node_id!;
    expect(existsSync(join(vaultPath, 'Old Title.md'))).toBe(true);

    const updated = parseResult(await handler({
      operations: [{ op: 'update', params: { node_id: nodeId, set_title: 'New Title' } }],
    }));
    expect(updated.ok).toBe(true);

    const row = db.prepare('SELECT title, file_path FROM nodes WHERE id = ?')
      .get(nodeId) as { title: string; file_path: string };

    // The DB title must never drift from the filename it is derived from.
    expect(row.title).toBe('New Title');
    expect(row.file_path).toBe('New Title.md');
    expect(existsSync(join(vaultPath, 'New Title.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Old Title.md'))).toBe(false);
  });

  it('sanitizes filename-illegal characters in a new title', async () => {
    const handler = getHandler();
    const created = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Plain', types: ['bare'] } }],
    }));
    const nodeId = created.data!.results[0].node_id!;

    const updated = parseResult(await handler({
      operations: [{ op: 'update', params: { node_id: nodeId, set_title: 'Site audit: link checker' } }],
    }));
    expect(updated.ok).toBe(true);

    const row = db.prepare('SELECT title, file_path FROM nodes WHERE id = ?')
      .get(nodeId) as { title: string; file_path: string };
    expect(row.file_path).toBe('Site audit- link checker.md');
    expect(existsSync(join(vaultPath, 'Site audit- link checker.md'))).toBe(true);
  });
});
