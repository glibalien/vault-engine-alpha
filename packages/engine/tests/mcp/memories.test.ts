import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { upgradeToMemories } from '../../src/db/migrate.js';
import { registerMemoriesTools } from '../../src/mcp/tools/memories.js';
import { MemoryService } from '../../src/memories/service.js';
import type { Embedder } from '../../src/search/embedder.js';
import { runRetentionSweeps } from '../../src/db/retention.js';
import type { MemoryConsolidator } from '../../src/mcp/tools/memory-consolidation.js';

/** P2 enforcement: create-memory requires evidence. Tests not about evidence use this stamp. */
const EV = { kind: 'conversation', ref: 'test#0' } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  // Mirror the real MCP request pipeline: zod parses (and applies defaults)
  // before the handler ever sees the params — calling tool.handler directly
  // with raw args would skip zod .default()s (e.g. scope, limit, offset).
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = tool.callback ? await tool.callback(parsed) : await tool.handler(parsed);
  return JSON.parse(result.content[0].text);
}

/**
 * Deterministic fake embedder for dedup testing: maps the first character of
 * the input text to a one-hot dimension. Identical first characters collide
 * (cosine distance 0, i.e. a guaranteed near-duplicate); different first
 * characters are orthogonal (cosine distance 1, i.e. never a duplicate).
 */
const fakeEmbedder: Embedder = {
  async embedDocument(text: string) {
    return [await fakeEmbedder.embedQuery(text)];
  },
  async embedQuery(text: string) {
    const v = new Float32Array(256);
    const dim = (text.charCodeAt(0) || 0) % 256;
    v[dim] = 1;
    return v;
  },
  isReady: () => true,
};

export function makeMemoriesServer(options?: {
  embedder?: Embedder | undefined;
  consolidator?: MemoryConsolidator | undefined;
}): { server: McpServer; db: Database.Database } {
  const db = createTestDb();
  const service = new MemoryService(db, {
    ...(options?.embedder ? { embedder: options.embedder } : {}),
    ...(options?.consolidator ? { consolidator: options.consolidator } : {}),
  });
  const server = new McpServer({ name: 'test', version: '0' });
  registerMemoriesTools(server, service);
  return { server, db };
}

describe('memories tools (no embedder — FTS/exact-text dedup fallback)', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createTestDb();
    upgradeToMemories(db);
    server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, new MemoryService(db));
  });
  afterEach(() => db.close());

  it('creates a memory and flags dedup_degraded when no embedder is configured', async () => {
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'User prefers dark mode' });
    expect(res.ok).toBe(true);
    expect(res.data.embedding).toBe(false);
    expect(res.data.dedup_checked).toBe(true);
    expect(res.warnings.some((w: { code: string }) => w.code === 'MEMORY_DEDUP_DEGRADED')).toBe(true);
  });

  it('hard-rejects a near-exact (normalized) duplicate within the same source', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'User prefers dark mode' });
    const dup = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '  USER PREFERS   dark mode  ' });
    expect(dup.ok).toBe(false);
    expect(dup.error.code).toBe('DUPLICATE_MEMORY');
    expect(dup.error.details.dedup_method).toBe('fts');
  });

  it('allows the same near-exact content in a different source', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'User prefers dark mode' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'User prefers dark mode' });
    expect(res.ok).toBe(true);
  });

  it('allows a weaker (non-exact) match and just warns', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'User prefers dark mode in the editor' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'User also likes dark mode' });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w: { code: string }) => w.code === 'MEMORY_DEDUP_DEGRADED')).toBe(true);
  });

  it('rejects content over the 10000-char zod max before the handler ever runs', async () => {
    // callTool mirrors the real MCP pipeline: zod parses (and enforces
    // .max()) before the handler is invoked, so an oversized payload never
    // reaches create-memory's own logic — it fails at the schema-parse step.
    let caught: unknown;
    try {
      await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'x'.repeat(10001) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const zodError = caught as { issues?: Array<{ path: unknown[]; code: string }> };
    expect(zodError.issues?.some((i) => i.path.includes('content') && i.code === 'too_big')).toBe(true);
  });

  it('tolerates FTS5-special punctuation in content without crashing (safe MATCH build)', async () => {
    const content = 'Don\'t forget: multi-word-hyphenated-title "quoted phrase';
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content });
    expect(res.ok).toBe(true);

    const dup = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content });
    expect(dup.ok).toBe(false);
    expect(dup.error.code).toBe('DUPLICATE_MEMORY');
  });

  it('rejects scope=node without node_id', async () => {
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'x', scope: 'node' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
  });

  it('get-memory / NOT_FOUND', async () => {
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Some fact' });
    const got = await callTool(server, 'get-memory', { id: created.data.id });
    expect(got.ok).toBe(true);
    expect(got.data.content).toBe('Some fact');
    // created_at/updated_at are ISO-8601 with a 'T' separator and 'Z' UTC suffix.
    expect(got.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(got.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const missing = await callTool(server, 'get-memory', { id: 999999 });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('NOT_FOUND');
  });

  it('list-memories filters by source/category and paginates', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'one', category: 'fact' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'two', category: 'preference' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'three', category: 'fact' });

    const bySource = await callTool(server, 'list-memories', { source: 'chat' });
    expect(bySource.data.total).toBe(2);

    const byCategory = await callTool(server, 'list-memories', { category: 'fact' });
    expect(byCategory.data.total).toBe(2);

    const paged = await callTool(server, 'list-memories', { limit: 1, offset: 0 });
    expect(paged.data.memories).toHaveLength(1);
    expect(paged.data.total).toBe(3);
  });

  it('list-memories filters by scope/node_id and sorts by created_at DESC', async () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('n1', 'n1.md', 'N1'), ('n2', 'n2.md', 'N2')").run();

    const vaultMem = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'vault-scoped fact' });
    await new Promise((r) => setTimeout(r, 5));
    const nodeMem1 = await callTool(server, 'create-memory', { evidence: EV,
      source: 'chat', content: 'node1 fact', scope: 'node', node_id: 'n1',
    });
    await new Promise((r) => setTimeout(r, 5));
    const nodeMem2 = await callTool(server, 'create-memory', { evidence: EV,
      source: 'chat', content: 'node2 fact', scope: 'node', node_id: 'n2',
    });

    const byScope = await callTool(server, 'list-memories', { scope: 'node' });
    expect(byScope.data.total).toBe(2);
    expect(byScope.data.memories.map((m: { id: number }) => m.id).sort((a: number, b: number) => a - b))
      .toEqual([nodeMem1.data.id, nodeMem2.data.id].sort((a: number, b: number) => a - b));

    const byNode = await callTool(server, 'list-memories', { node_id: 'n1' });
    expect(byNode.data.total).toBe(1);
    expect(byNode.data.memories[0].id).toBe(nodeMem1.data.id);

    // Sorted by created_at DESC: the most-recently-created row comes first.
    const all = await callTool(server, 'list-memories', {});
    expect(all.data.memories.map((m: { id: number }) => m.id)).toEqual([
      nodeMem2.data.id, nodeMem1.data.id, vaultMem.data.id,
    ]);
  });

  it('list-memories query finds content via FTS5', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'The stakeholder is Alex' });
    const res = await callTool(server, 'list-memories', { query: 'stakeholder' });
    expect(res.ok).toBe(true);
    expect(res.data.memories).toHaveLength(1);
    expect(res.data.memories[0].content).toBe('The stakeholder is Alex');
  });

  it('list-memories query ranks multiple matches by relevance (bm25) and excludes non-matches', async () => {
    const weak = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'The stakeholder is Alex' });
    const strong = await callTool(server, 'create-memory', { evidence: EV,
      source: 'chat', content: 'stakeholder stakeholder stakeholder feedback needed',
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Completely unrelated note about the weather' });

    const res = await callTool(server, 'list-memories', { query: 'stakeholder' });
    expect(res.ok).toBe(true);
    expect(res.data.memories).toHaveLength(2);
    // Higher term frequency (denser match) ranks first via bm25.
    expect(res.data.memories.map((m: { id: number }) => m.id)).toEqual([strong.data.id, weak.data.id]);
  });

  it('update-memory versions on content change: new id, operation=update, old row supersedes', async () => {
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'original' });
    const before = created.data.id as number;
    const originalRow = db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(before) as { updated_at: string };

    await new Promise((r) => setTimeout(r, 5));
    const updated = await callTool(server, 'update-memory', { id: before, content: 'revised', category: 'note', evidence: EV });
    expect(updated.ok).toBe(true);
    expect(updated.data.id).not.toBe(before);
    expect(updated.data.operation).toBe('update');
    expect(updated.data.content).toBe('revised');
    expect(updated.data.category).toBe('note');
    expect(updated.data.updated_at).not.toBe(originalRow.updated_at);

    const old = await callTool(server, 'get-memory', { id: before });
    expect(old.data.expire_reason).toBe('superseded-by-update');
  });

  it('update-memory NOT_FOUND for a missing id', async () => {
    const res = await callTool(server, 'update-memory', { id: 424242, content: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('expire-memory purge removes the row and get-memory then 404s', async () => {
    const created = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'to be deleted' });
    const del = await callTool(server, 'expire-memory', { id: created.data.id, purge: true, confirm: true });
    expect(del.ok).toBe(true);
    expect(del.data.deleted.content).toBe('to be deleted');

    const got = await callTool(server, 'get-memory', { id: created.data.id });
    expect(got.ok).toBe(false);
    expect(got.error.code).toBe('NOT_FOUND');

    // The memories_fts trigger-synced row must be gone too, not just the
    // memories row — a list-memories query exercises the FTS table directly.
    const searched = await callTool(server, 'list-memories', { query: 'deleted' });
    expect(searched.ok).toBe(true);
    expect(searched.data.memories).toHaveLength(0);
  });

  it('expire-memory NOT_FOUND for a missing id', async () => {
    const res = await callTool(server, 'expire-memory', { id: 424242, purge: true, confirm: true });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
  });
});

describe('memories tools (with embedder — vector dedup + re-embed lifecycle)', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createTestDb();
    upgradeToMemories(db);
    server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, new MemoryService(db, { embedder: fakeEmbedder }));
  });
  afterEach(() => db.close());

  function vecRowCount(): number {
    return (db.prepare('SELECT COUNT(*) as c FROM memory_embedding_vec').get() as { c: number }).c;
  }

  it('create-memory embeds and stores a vec_id; no dedup_degraded warning', async () => {
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    expect(res.ok).toBe(true);
    expect(res.data.embedding).toBe(true);
    expect(res.warnings.some((w: { code: string }) => w.code === 'MEMORY_DEDUP_DEGRADED')).toBe(false);

    const row = db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(res.data.id) as { vec_id: number | null };
    expect(row.vec_id).not.toBeNull();
    expect(vecRowCount()).toBe(1);
  });

  it('rejects a same-source vector near-duplicate (same leading char -> distance 0)', async () => {
    const first = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    const dup = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xenial thoughts about Tuesdays' });
    expect(dup.ok).toBe(false);
    expect(dup.error.code).toBe('DUPLICATE_MEMORY');
    expect(dup.error.details.dedup_method).toBe('vector');
    expect(dup.error.details.existing_id).toBe(first.data.id);
    expect(vecRowCount()).toBe(1); // rejected memory never got a vec row
  });

  it('allows a same-source memory with an unrelated embedding (different leading char)', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Zebra crossing near the office' });
    expect(res.ok).toBe(true);
    expect(vecRowCount()).toBe(2);
  });

  it('allows a vector-duplicate in a different source (dedup is per-source)', async () => {
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'Xenial thoughts about Tuesdays' });
    expect(res.ok).toBe(true);
    expect(vecRowCount()).toBe(2);
  });

  it('catches a same-source vector duplicate even when 20 distance-tied other-source rows would crowd a small top-k window (verifies MEMORY_DEDUP_K=200, not a naive k=5)', async () => {
    // Insert 10 other-source rows (vector-identical: same leading char 'X',
    // so cosine distance 0) BEFORE the real same-source memory, and 10 more
    // AFTER it. Whatever tie-break order sqlite-vec uses for equal-distance
    // neighbors, the real duplicate sits in the middle of 21 tied rows — any
    // k <= 10 taken from either end would miss it entirely. Only a large k
    // (here 200) guarantees the KNN query even returns it, before the
    // per-source distance filter ever gets a chance to catch it.
    for (let i = 0; i < 10; i++) {
      const res = await callTool(server, 'create-memory', { evidence: EV, source: `other-before-${i}`, content: 'Xylophone lessons on Tuesdays' });
      expect(res.ok).toBe(true);
    }
    const real = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    expect(real.ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      const res = await callTool(server, 'create-memory', { evidence: EV, source: `other-after-${i}`, content: 'Xylophone lessons on Tuesdays' });
      expect(res.ok).toBe(true);
    }
    expect(vecRowCount()).toBe(21);

    const dup = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xenial thoughts about Tuesdays' });
    expect(dup.ok).toBe(false);
    expect(dup.error.code).toBe('DUPLICATE_MEMORY');
    expect(dup.error.details.dedup_method).toBe('vector');
    expect(dup.error.details.existing_id).toBe(real.data.id);
  });

  it('update-memory versions on content change: new row gets a fresh vector, old row keeps its own, row count grows by 1', async () => {
    // Create memory a with starting character 'Z' for one vector identity
    const a = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Zebra crossing near the office' });
    expect(vecRowCount()).toBe(1);

    // Create memory b with starting character 'Q' for a different vector identity
    const b = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Quokka encounter at sunrise' });
    expect(vecRowCount()).toBe(2);

    const bBeforeVecId = db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(b.data.id) as { vec_id: number };
    const before = db.prepare('SELECT vec_id, updated_at FROM memories WHERE id = ?').get(a.data.id) as { vec_id: number; updated_at: string };

    await new Promise((r) => setTimeout(r, 5));
    const updated = await callTool(server, 'update-memory', { id: a.data.id, content: 'Another fact entirely', evidence: EV });
    expect(updated.ok).toBe(true);
    expect(updated.data.id).not.toBe(a.data.id);

    const oldRow = db.prepare('SELECT vec_id, expired_at, updated_at FROM memories WHERE id = ?').get(a.data.id) as {
      vec_id: number; expired_at: string | null; updated_at: string;
    };
    const newRow = db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(updated.data.id) as { vec_id: number };
    const bAfterVecId = db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(b.data.id) as { vec_id: number };

    // old row keeps its own vector and is expired, not deleted
    expect(oldRow.vec_id).toBe(before.vec_id);
    expect(oldRow.expired_at).not.toBeNull();
    expect(oldRow.updated_at).not.toBe(before.updated_at);

    // new row gets a fresh vector
    expect(newRow.vec_id).not.toBeNull();
    expect(newRow.vec_id).not.toBe(before.vec_id);

    // cross-row isolation: memory b's vec_id survives a's update
    expect(bAfterVecId.vec_id).toBe(bBeforeVecId.vec_id);

    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(3);
    expect(vecRowCount()).toBe(3); // old-a vec kept + new-a vec inserted + b's vec unchanged
  });

  it('update-memory leaves vec_id untouched on category/metadata-only updates', async () => {
    const a = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    const before = db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(a.data.id) as { vec_id: number };

    await callTool(server, 'update-memory', { id: a.data.id, category: 'note' });

    const after = db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(a.data.id) as { vec_id: number };
    expect(after.vec_id).toBe(before.vec_id);
    expect(vecRowCount()).toBe(1);
  });

  it('expire-memory purge cleans up its memory_embedding_vec row', async () => {
    const a = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'Xylophone lessons on Tuesdays' });
    expect(vecRowCount()).toBe(1);

    const del = await callTool(server, 'expire-memory', { id: a.data.id, purge: true, confirm: true });
    expect(del.ok).toBe(true);
    expect(vecRowCount()).toBe(0);
  });

  it('rolls back the whole write group if the vec INSERT throws mid-transaction (atomicity)', async () => {
    // Regression test for the create-memory transaction wrap: before the
    // fix, INSERT memory / INSERT vec / UPDATE vec_id ran as three separate
    // auto-committed statements, so a vec-insert failure (dimension
    // mismatch, disk/lock error, etc.) left an orphaned `memories` row with
    // vec_id=NULL — invisible to KNN dedup, so a caller retry after the
    // error response would create an undetected semantic duplicate.
    //
    // We force that failure by stubbing out the exact prepared statement
    // create-memory uses to write the vector row (matched by SQL text) so it
    // throws, while every other prepared statement (including the dedup KNN
    // query, which needs a real matching-dimension vector to not throw
    // earlier and mask what we're testing) goes through untouched.
    const localDb = createTestDb();
    const realPrepare = localDb.prepare.bind(localDb);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (localDb as any).prepare = (sql: string, ...rest: unknown[]) => {
      if (sql === 'INSERT INTO memory_embedding_vec (vector) VALUES (?)') {
        return { run: () => { throw new Error('simulated vec insert failure'); } };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realPrepare as any)(sql, ...rest);
    };

    const localServer = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(localServer, new MemoryService(localDb, { embedder: fakeEmbedder }));

    const res = await callTool(localServer, 'create-memory', { evidence: EV, source: 'chat', content: 'Should never persist' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INTERNAL_ERROR');

    // Query through the REAL prepare (bypassing our stub) to confirm no
    // partial state survived the rollback.
    const memCount = (realPrepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    expect(memCount).toBe(0);
    const vecCount = (realPrepare('SELECT COUNT(*) as c FROM memory_embedding_vec').get() as { c: number }).c;
    expect(vecCount).toBe(0);

    localDb.close();
  });

  it('deleting the owning node NULLs memory node_id (SET NULL, not CASCADE); the vec row is unaffected', async () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('n1', 'n1.md', 'Node One')").run();

    const created = await callTool(server, 'create-memory', { evidence: EV,
      source: 'chat', content: 'Node-scoped fact', scope: 'node', node_id: 'n1',
    });
    expect(created.ok).toBe(true);
    const memId = created.data.id as number;
    const vecId = (db.prepare('SELECT vec_id FROM memories WHERE id = ?').get(memId) as { vec_id: number | null }).vec_id;
    expect(vecId).not.toBeNull();
    expect(vecRowCount()).toBe(1);

    // v3: foreign_keys=ON (set in createTestDb) + ON DELETE SET NULL on
    // memories.node_id means deleting the node NULLs the node_id but preserves the memory row.
    // (Data is never silently deleted; app-side expiration via executeDeletion happens separately.)
    db.prepare('DELETE FROM nodes WHERE id = ?').run('n1');
    const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(memId) as Record<string, unknown>;
    expect(mem).toBeDefined();
    expect(mem.node_id).toBeNull();

    // memory_embedding_vec is a vec0 virtual table with no FK support, so it's unaffected.
    // Its row persists until app-side expiration or the retention sweep.
    expect(vecRowCount()).toBe(1);
    expect(db.prepare('SELECT id FROM memory_embedding_vec WHERE id = ?').get(vecId)).toBeDefined();

    // The retention sweep can reclaim orphaned vec rows when their memories expire.
    // For now, the vec row is retained since the memory is still live.
    const result = runRetentionSweeps(db);
    expect(result.memoryEmbeddingVecOrphansDeleted).toBe(0);
    // This memory is not expired, so the vec row is not deleted.
    expect(vecRowCount()).toBe(1);
  });
});
