import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';

function makeFakeEmbedder(): Embedder {
  return {
    async embedDocument(): Promise<Float32Array[]> {
      return [new Float32Array(256).fill(0.1)];
    },
    async embedQuery(): Promise<Float32Array> {
      return new Float32Array(256).fill(0.1);
    },
    isReady(): boolean {
      return true;
    },
  };
}

describe('vault-stats search_index', () => {
  let db: Database.Database;
  let handler: () => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    db = createTestDb();
    const embedder = makeFakeEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'test.md', 'Test', 'Body', 'h1')").run();
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    let captured: () => Promise<{ content: Array<{ type: string; text: string }> }>;
    const fakeServer = {
      tool: (
        _name: string,
        _desc: string,
        _schema: unknown,
        h: () => Promise<{ content: Array<{ type: string; text: string }> }>
      ) => {
        captured = h;
      },
    };
    registerVaultStats(fakeServer as any, db, undefined, indexer);
    handler = captured!;
  });

  it('includes search_index in vault-stats output', async () => {
    const result = await handler();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data.search_index).toBeDefined();
    expect(data.search_index.status).toBe('ready');
    expect(data.search_index.nodes_total).toBe(1);
    expect(data.search_index.nodes_indexed).toBe(1);
    expect(data.search_index.nodes_excluded).toBe(0);
    expect(data.search_index.nodes_unindexed).toBe(0);
    expect(data.search_index.pending).toBe(0);
  });

  it('exposes cycle-5 rolling-upgrade fields', async () => {
    const result = await handler();
    const data = JSON.parse(result.content[0].text).data;
    // Fresh test DB has no stored version row → getSearchVersion returns 1,
    // so a rolling upgrade is reported as pending against the v3 target.
    expect(data.search_index.target_version).toBe(3);
    expect(typeof data.search_index.stored_version).toBe('number');
    expect(typeof data.search_index.rolling_upgrade).toBe('boolean');
    expect(data.search_index.terminal_failures).toBe(0);
    expect(data.search_index.last_drain).toEqual({ completed: 1, skipped: 0, failed: 0 });
  });

  it('reports rolling_upgrade:false once the target version is stored', async () => {
    const { setSearchVersion, CURRENT_SEARCH_VERSION } = await import('../../src/db/search-version.js');
    setSearchVersion(db, CURRENT_SEARCH_VERSION);
    const result = await handler();
    const data = JSON.parse(result.content[0].text).data;
    expect(data.search_index.stored_version).toBe(CURRENT_SEARCH_VERSION);
    expect(data.search_index.rolling_upgrade).toBe(false);
  });

  it('omits search_index when no embeddingIndexer', async () => {
    let captured2: () => Promise<{ content: Array<{ type: string; text: string }> }>;
    const fakeServer2 = {
      tool: (
        _name: string,
        _desc: string,
        _schema: unknown,
        h: () => Promise<{ content: Array<{ type: string; text: string }> }>
      ) => {
        captured2 = h;
      },
    };
    registerVaultStats(fakeServer2 as any, db);
    const result = await captured2!();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data.search_index).toBeUndefined();
  });
});
