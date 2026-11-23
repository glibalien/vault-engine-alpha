import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { MemoryService, getMemoryRow } from '../../src/memories/service.js';
import { registerMemoriesTools, reservedSourceRefusal } from '../../src/mcp/tools/memories.js';
import type { Embedder } from '../../src/search/embedder.js';

// #300: memory record gaps — vector backfill, reactivation/edit history, conversation refs,
// reserved sources.

const EV = { kind: 'conversation', ref: 'test#0' } as const;

/** One-hot on the first character: same first letter = distance 0, different = orthogonal. */
function oneHotEmbedder(): Embedder & { calls: number } {
  const embedder = {
    calls: 0,
    async embedDocument(text: string) {
      return [await embedder.embedQuery(text)];
    },
    async embedQuery(text: string) {
      embedder.calls += 1;
      const v = new Float32Array(256);
      v[(text.charCodeAt(0) || 0) % 256] = 1;
      return v;
    },
    isReady: () => true,
  };
  return embedder;
}

function failingEmbedder(): Embedder & { calls: number } {
  const embedder = {
    calls: 0,
    async embedDocument(): Promise<Float32Array[]> {
      throw new Error('embedder down');
    },
    async embedQuery(): Promise<Float32Array> {
      embedder.calls += 1;
      throw new Error('embedder down');
    },
    isReady: () => false,
  };
  return embedder;
}

async function createOk(service: MemoryService, content: string, extra: Record<string, unknown> = {}): Promise<number> {
  const { result } = await service.create({ source: 'chat', scope: 'vault', content, evidence: EV, ...extra } as Parameters<MemoryService['create']>[0]);
  if (!result.ok) throw new Error(`create failed: ${result.error.message}`);
  return result.data.id;
}

describe('vector backfill (#300 item 3)', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  it('embeds live memories created without an embedder, and leaves expired ones alone', async () => {
    const plain = new MemoryService(db);
    const a = await createOk(plain, 'Alpha fact');
    const b = await createOk(plain, 'Beta fact');
    const gone = await createOk(plain, 'Gamma fact');
    await plain.expire({ id: gone, reason: 'deleted' });
    expect(getMemoryRow(db, a)!.vec_id).toBeNull();

    const embedder = oneHotEmbedder();
    const service = new MemoryService(db, { embedder });
    const result = await service.backfillVectors({ batchSize: 1 });

    expect(result).toEqual({ embedded: 2, failed: 0, remaining: 0 });
    expect(getMemoryRow(db, a)!.vec_id).not.toBeNull();
    expect(getMemoryRow(db, b)!.vec_id).not.toBeNull();
    expect(getMemoryRow(db, gone)!.vec_id).toBeNull();
    const pairs = service.nearPairs({ near: 0, far: 1, limit: 10 });
    expect(pairs.result.ok && pairs.result.data.skipped_unembedded).toBe(0);
  });

  it('lets vector dedup see a backfilled memory', async () => {
    await createOk(new MemoryService(db), 'Alpha fact');
    const service = new MemoryService(db, { embedder: oneHotEmbedder() });
    await service.backfillVectors();
    const { result } = await service.create({ source: 'chat', scope: 'vault', content: 'Another alpha-initial fact', evidence: EV });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('DUPLICATE_MEMORY');
  });

  it('is a no-op with nothing to embed or no embedder', async () => {
    const withEmbedder = new MemoryService(db, { embedder: oneHotEmbedder() });
    await createOk(withEmbedder, 'Alpha fact');
    expect(await withEmbedder.backfillVectors()).toEqual({ embedded: 0, failed: 0, remaining: 0 });

    await createOk(new MemoryService(db), 'Beta fact');
    expect(await new MemoryService(db).backfillVectors()).toEqual({ embedded: 0, failed: 0, remaining: 1 });
  });

  it('stops after three consecutive embed failures', async () => {
    const plain = new MemoryService(db);
    for (const c of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) await createOk(plain, `${c} fact`);
    const embedder = failingEmbedder();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await new MemoryService(db, { embedder }).backfillVectors();
    warn.mockRestore();
    expect(embedder.calls).toBe(3);
    expect(result).toEqual({ embedded: 0, failed: 3, remaining: 5 });
  });
});

describe('memory history (#300 item 1)', () => {
  let db: Database.Database;
  let service: MemoryService;
  beforeEach(() => {
    db = createTestDb();
    service = new MemoryService(db);
  });
  afterEach(() => db.close());

  it('keeps the expiry a reactivation clears', async () => {
    const loser = await createOk(service, 'Alpha fact');
    const winner = await createOk(service, 'Beta fact');
    await service.expire({ id: loser, reason: 'contradicted', superseded_by: winner, invalid_at: '2026-01-02T00:00:00.000Z' });
    const expired = getMemoryRow(db, loser)!;

    const { result } = await service.expire({ id: loser, reason: 'owner restored it', reactivate: true });
    expect(result.ok).toBe(true);

    const got = service.get({ id: loser, include_history: true });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.expired_at).toBeNull();
    expect(got.data.history).toEqual([{
      changed_at: expect.any(String),
      change: 'reactivated',
      reason: 'owner restored it',
      previous: {
        expired_at: expired.expired_at,
        expire_reason: 'contradicted',
        superseded_by: winner,
        invalid_at: '2026-01-02T00:00:00.000Z',
      },
    }]);
  });

  it('keeps the category and metadata an in-place edit replaces, and skips no-op edits', async () => {
    const id = await createOk(service, 'Alpha fact', { category: 'fact', metadata: { tag: 'a' } });
    await service.update({ id, category: 'preference' });
    await service.update({ id, metadata: { tag: 'b' } });
    await service.update({ id, category: 'preference', metadata: { tag: 'b' } });

    const got = service.get({ id, include_history: true });
    if (!got.ok) throw new Error('get failed');
    expect(got.data.history?.map(h => [h.change, h.previous])).toEqual([
      ['edited', { category: 'fact' }],
      ['edited', { metadata: { tag: 'a' } }],
    ]);
  });

  it('records edits to an expired memory too', async () => {
    const id = await createOk(service, 'Alpha fact', { category: 'fact' });
    await service.expire({ id, reason: 'deleted' });
    await service.update({ id, category: 'note' });
    const got = service.get({ id, include_history: true });
    if (!got.ok) throw new Error('get failed');
    expect(got.data.history).toHaveLength(1);
    expect(got.data.history![0]!.previous).toEqual({ category: 'fact' });
  });

  it('omits history unless asked, and a purge deletes it', async () => {
    const id = await createOk(service, 'Alpha fact', { category: 'fact' });
    await service.update({ id, category: 'note' });
    const plain = service.get({ id });
    expect(plain.ok && 'history' in plain.data).toBe(false);

    const { result } = await service.delete({ id, purge: true, confirm: true });
    expect(result.ok).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS c FROM memory_history WHERE memory_id = ?').get(id) as { c: number }).c).toBe(0);
  });

  it('embeds a reactivated memory that was retired without a vector', async () => {
    const id = await createOk(service, 'Alpha fact');
    await service.expire({ id, reason: 'deleted' });
    const withEmbedder = new MemoryService(db, { embedder: oneHotEmbedder() });
    await withEmbedder.expire({ id, reason: 'restored', reactivate: true });
    expect(getMemoryRow(db, id)!.vec_id).not.toBeNull();
  });

  describe('a change while the reactivation embed is in flight', () => {
    /** An embedder that runs `during` before it answers, standing in for a concurrent request. */
    function interleaving(during: () => Promise<void>): Embedder {
      const inner = oneHotEmbedder();
      return { ...inner, embedQuery: async (text: string) => { await during(); return inner.embedQuery(text); } };
    }

    it('a purge wins: NOT_FOUND, and no history row is left behind', async () => {
      const id = await createOk(service, 'Alpha fact');
      await service.expire({ id, reason: 'deleted' });
      const racing = new MemoryService(db, { embedder: interleaving(async () => {
        await service.delete({ id, purge: true, confirm: true });
      }) });
      const { result } = await racing.expire({ id, reason: 'restored', reactivate: true });
      expect(!result.ok && result.error.code).toBe('NOT_FOUND');
      expect((db.prepare('SELECT COUNT(*) AS c FROM memory_history').get() as { c: number }).c).toBe(0);
    });

    it('a version superseded meanwhile stays retired (CONFLICT)', async () => {
      const id = await createOk(service, 'Alpha fact');
      await service.expire({ id, reason: 'deleted' });
      const racing = new MemoryService(db, { embedder: interleaving(async () => {
        await service.expire({ id, reason: 'restored', reactivate: true });
        await service.update({ id, content: 'Alpha fact, revised', evidence: EV });
      }) });
      const { result } = await racing.expire({ id, reason: 'restored twice', reactivate: true });
      expect(!result.ok && result.error.code).toBe('CONFLICT');
      const row = getMemoryRow(db, id)!;
      expect(row.expire_reason).toBe('superseded-by-update');
      expect(row.superseded_by).not.toBeNull();
    });

    it('a concurrent reactivation: already_live, one history row', async () => {
      const id = await createOk(service, 'Alpha fact');
      await service.expire({ id, reason: 'deleted' });
      const racing = new MemoryService(db, { embedder: interleaving(async () => {
        await service.expire({ id, reason: 'first', reactivate: true });
      }) });
      const { result } = await racing.expire({ id, reason: 'second', reactivate: true });
      expect(result.ok && result.data.already_live).toBe(true);
      const got = service.get({ id, include_history: true });
      expect(got.ok && got.data.history?.map(h => h.reason)).toEqual(['first']);
    });
  });

  it('still reactivates when that embed fails', async () => {
    const id = await createOk(service, 'Alpha fact');
    await service.expire({ id, reason: 'deleted' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await new MemoryService(db, { embedder: failingEmbedder() }).expire({ id, reason: 'restored', reactivate: true });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const row = getMemoryRow(db, id)!;
    expect(row.expired_at).toBeNull();
    expect(row.vec_id).toBeNull();
  });
});

describe('conversation refs in either format (#300 item 5)', () => {
  let db: Database.Database;
  let service: MemoryService;
  beforeEach(() => {
    db = createTestDb();
    service = new MemoryService(db);
  });
  afterEach(() => db.close());

  it('evidence_conversation matches the bare id and <id>#<message>, nothing else', async () => {
    const bare = await createOk(service, 'Alpha fact', { evidence: { kind: 'conversation', ref: 'conv-1' } });
    const indexed = await createOk(service, 'Beta fact', { evidence: { kind: 'conversation', ref: 'conv-1#4' } });
    await createOk(service, 'Gamma fact', { evidence: { kind: 'conversation', ref: 'conv-10#1' } });
    await createOk(service, 'Delta fact', { evidence: { kind: 'conversation', ref: 'conv-1x' } });
    await createOk(service, 'Epsilon fact', { evidence: { kind: 'curation-run', ref: 'conv-1' } });

    const res = service.list({ evidence_conversation: 'conv-1', limit: 50, offset: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.memories.map(m => m.id).sort()).toEqual([bare, indexed].sort());
    expect(res.data.total).toBe(2);

    const exact = service.list({ evidence_ref: 'conv-1', limit: 50, offset: 0 });
    expect(exact.ok && exact.data.memories.map(m => m.content).sort()).toEqual(['Alpha fact', 'Epsilon fact']);
  });

  it('is exposed on list-memories', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, service);
    await createOk(service, 'Alpha fact', { evidence: { kind: 'conversation', ref: 'conv-1#2' } });
    const res = await callTool(server, 'list-memories', { evidence_conversation: 'conv-1' });
    expect(res.ok).toBe(true);
    expect(res.data.memories).toHaveLength(1);
  });
});

describe('reserved memory sources (#300 item 6)', () => {
  it('refuses curator and owner from an OAuth-flow client only', () => {
    const oauth = '3f8a5c2e-0000-4000-8000-000000000000';
    expect(reservedSourceRefusal('curator', oauth)).toMatch(/reserved/);
    expect(reservedSourceRefusal('owner', oauth)).toMatch(/reserved/);
    expect(reservedSourceRefusal('chat', oauth)).toBeNull();
    expect(reservedSourceRefusal('claude', oauth)).toBeNull();
    expect(reservedSourceRefusal('curator', 'service-curator')).toBeNull();
    expect(reservedSourceRefusal('owner', 'service-any')).toBeNull();
    expect(reservedSourceRefusal('curator', undefined)).toBeNull();
  });

  it('create-memory enforces it from the request auth and writes nothing', async () => {
    const db = createTestDb();
    const service = new MemoryService(db);
    const server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, service);
    const oauth = { authInfo: { token: 't', clientId: '3f8a5c2e-0000-4000-8000-000000000000', scopes: [] } };

    const refused = await callTool(server, 'create-memory', { source: 'curator', content: 'Alpha fact', evidence: EV }, oauth);
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe('INVALID_PARAMS');
    expect((db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c).toBe(0);

    const allowed = await callTool(server, 'create-memory', { source: 'claude', content: 'Alpha fact', evidence: EV }, oauth);
    expect(allowed.ok).toBe(true);
    const service2 = await callTool(server, 'create-memory', { source: 'curator', content: 'Beta fact', evidence: EV },
      { authInfo: { token: 't', clientId: 'service-curator', scopes: [] } });
    expect(service2.ok).toBe(true);
    const local = await callTool(server, 'create-memory', { source: 'owner', content: 'Gamma fact', evidence: EV });
    expect(local.ok).toBe(true);
    db.close();
  });
});

// Mirrors tests/mcp/memories.test.ts callTool, plus the request `extra` (auth).
async function callTool(server: McpServer, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = tool.callback ? await tool.callback(parsed, extra) : await tool.handler(parsed, extra);
  return JSON.parse(result.content[0].text);
}
