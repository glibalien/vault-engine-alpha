// tests/mcp/tool-embedding-enqueue.test.ts
//
// T0.3: tool-path writes never produced a watcher event (write-skip), so a
// node created/edited via an MCP tool was not enqueued for embedding and stayed
// missing from semantic search until the next startup bulk pass. These tests
// pin that a tool write enqueues the node and the self-draining indexer embeds
// it (an embedding_meta row exists after drain()).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';

function fakeEmbedder(): Embedder {
  return {
    async embedDocument(): Promise<Float32Array[]> {
      return [new Float32Array(256).fill(0.1)];
    },
    async embedQuery(): Promise<Float32Array> {
      return new Float32Array(256).fill(0.1);
    },
    isReady(): boolean { return true; },
  };
}

interface Response {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function parseResult(result: unknown): Response {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Response;
}

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let indexer: EmbeddingIndexer;

function getCreateNodeHandler(): (args: Record<string, unknown>) => Promise<unknown> {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerCreateNode(fakeServer, db, writeLock, vaultPath, undefined, indexer);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
  writeLock = new WriteLockManager();
  indexer = createEmbeddingIndexer(db, fakeEmbedder());
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('tool writes enqueue for embedding (T0.3)', () => {
  it('create-node produces an embedding_meta row after drain', async () => {
    const handler = getCreateNodeHandler();
    const response = parseResult(await handler({ title: 'Indexed Note', types: ['note'], body: 'hello world' }));
    expect(response.ok).toBe(true);

    await indexer.drain();

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM embedding_meta WHERE source_type = 'node'")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('does not enqueue on a dry-run create', async () => {
    const handler = getCreateNodeHandler();
    const response = parseResult(await handler({ title: 'Dry Note', types: ['note'], body: 'x', dry_run: true }));
    expect(response.ok).toBe(true);

    await indexer.drain();

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM embedding_meta WHERE source_type = 'node'")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });
});
