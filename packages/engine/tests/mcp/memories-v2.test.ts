import { createProviderClients } from '@vault/llm';
import { describe, it, expect, vi } from 'vitest';
import { decideTier, MEMORY_NEAR_DUP, MEMORY_UNRELATED } from '../../src/mcp/tools/memories.js';
import { makeMemoriesServer, callTool } from './memories.test.js';
import type { Embedder } from '../../src/search/embedder.js';
import {
  ConsolidationError,
  createConsolidator,
  type ConsolidationVerdict,
  type MemoryConsolidator,
} from '../../src/mcp/tools/memory-consolidation.js';

/** P2 enforcement: create-memory requires evidence. Tests not about evidence use this stamp. */
const EV = { kind: 'conversation', ref: 'test#0' } as const;

const cand = (id: number, distance: number) => ({
  id,
  content: `m${id}`,
  category: null,
  valid_at: null,
  distance,
});

describe('decideTier', () => {
  it('no candidates -> add', () => {
    expect(decideTier([]).tier).toBe('add');
  });

  it('nearest below NEAR_DUP -> duplicate', () => {
    expect(decideTier([cand(1, MEMORY_NEAR_DUP - 0.01)]).tier).toBe('duplicate');
  });

  it('nearest above UNRELATED -> add', () => {
    expect(decideTier([cand(1, MEMORY_UNRELATED + 0.01)]).tier).toBe('add');
  });

  it('nearest in the gray band -> gray, filtered to in-band candidates', () => {
    const d = decideTier([cand(1, 0.2), cand(2, 0.3), cand(3, 0.9)]);
    expect(d.tier).toBe('gray');
    if (d.tier === 'gray') expect(d.candidates.map((c) => c.id)).toEqual([1, 2]);
  });
});

function vec(x0: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = x0;
  v[1] = Math.sqrt(Math.max(0, 1 - x0 * x0));
  return v;
}

function fakeEmbedder(map: Record<string, Float32Array>): Embedder {
  return {
    isReady: () => true,
    async embedQuery(text: string) {
      return map[text] ?? vec(0);
    },
    async embedDocument(text: string) {
      return [map[text] ?? vec(0)];
    },
  };
}

function fakeConsolidator(verdict: ConsolidationVerdict): MemoryConsolidator & { calls: number } {
  const consolidator: MemoryConsolidator & { calls: number } = {
    calls: 0,
    async consolidate() {
      consolidator.calls += 1;
      return verdict;
    },
  };
  return consolidator;
}

describe('create-memory usage attribution (#298)', () => {
  it("passes the caller's usage attribution to the consolidator", async () => {
    const seen: unknown[] = [];
    const consolidator: MemoryConsolidator = {
      async consolidate(_input, attribution) {
        seen.push(attribution);
        return { operation: 'noop', target_id: 1, reason: 'dup' };
      },
    };
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ base: vec(1), similar: vec(0.8), again: vec(0.8) }),
      consolidator,
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'base' });
    const res = await callTool(server, 'create-memory', {
      evidence: EV, source: 'curator', content: 'similar',
      usage: { service: 'curator', run_ref: 'run-7', source_ref: 'memory-sweep' },
    });
    expect(res.data.operation).toBe('noop');
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'again' });
    // A Curator run paid from its own limit says so (#659).
    await callTool(server, 'create-memory', {
      evidence: EV, source: 'curator', content: 'again',
      usage: { service: 'curator', run_ref: 'run-8', source_ref: 'memory-extraction-run', purpose: 'memory-consolidation-run' },
    });
    expect(seen).toEqual([
      { service: 'curator', runRef: 'run-7', sourceRef: 'memory-sweep', conversationId: undefined, purpose: undefined },
      undefined,
      { service: 'curator', runRef: 'run-8', sourceRef: 'memory-extraction-run', conversationId: undefined, purpose: 'memory-consolidation-run' },
    ]);
    db.close();
  });

  it("reports the consolidation call's cost when one was made, so a capped caller can count it", async () => {
    const consolidator: MemoryConsolidator = {
      async consolidate() { return { operation: 'add', reason: 'new', costUsd: 0.004 }; },
    };
    const { server, db } = makeMemoriesServer({ embedder: fakeEmbedder({ base: vec(1), similar: vec(0.8), far: vec(0) }), consolidator });
    const first = await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'base' });
    expect(first.data).not.toHaveProperty('consolidation_cost_usd'); // nothing similar: no model call
    const gray = await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'similar' });
    expect(gray.data.consolidation_cost_usd).toBe(0.004);
    db.close();
  });

  it('reports a billed but unusable consolidation answer as its cost, falling back to add', async () => {
    const consolidator: MemoryConsolidator = {
      async consolidate() { throw new ConsolidationError('no JSON object in consolidation response', 0.002); },
    };
    const { server, db } = makeMemoriesServer({ embedder: fakeEmbedder({ base: vec(1), similar: vec(0.8) }), consolidator });
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'base' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'similar' });
    expect(res.data).toMatchObject({ operation: 'add', consolidation_cost_usd: 0.002 });
    db.close();
  });

  it('rejects a usage service the ledger does not know', async () => {
    const { server, db } = makeMemoriesServer({});
    await expect(callTool(server, 'create-memory', {
      evidence: EV, source: 'curator', content: 'x', usage: { service: 'someone-else' },
    })).rejects.toThrow();
    db.close();
  });
});

describe('create-memory tiering: add / noop', () => {
  it('unrelated distance -> add without calling the consolidator', async () => {
    const consolidator = fakeConsolidator({ operation: 'noop', target_id: 1, reason: 'x' });
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ apple: vec(1), zebra: vec(0) }),
      consolidator,
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'apple' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'zebra' });
    expect(res.data.operation).toBe('add');
    expect(consolidator.calls).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('gray-zone noop -> nothing inserted, returns existing id', async () => {
    const consolidator = fakeConsolidator({ operation: 'noop', target_id: 1, reason: 'dup' });
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ base: vec(1), similar: vec(0.8) }),
      consolidator,
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'base' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'similar' });
    expect(res.data.operation).toBe('noop');
    expect(res.data.id).toBe(1);
    expect(consolidator.calls).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('missing selected-provider credentials fail safely to add in the gray zone', async () => {
    const consolidator = createConsolidator(
      createProviderClients({ fireworks: 'fw-key' }, { createOpenAi: vi.fn() }),
      { provider: 'openrouter', model: 'openrouter/auto' },
      undefined,
    );
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ base: vec(1), similar: vec(0.8) }),
      consolidator,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'base' });
      const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'similar' });

      expect(res.data.operation).toBe('add');
      expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OPENROUTER_API_KEY'));
    } finally {
      warn.mockRestore();
      db.close();
    }
  });
});

describe('create-memory: update + contradict', () => {
  it("update -> versions the target (new row + supersede), doesn't rewrite in place", async () => {
    const consolidator = fakeConsolidator({ operation: 'update', target_id: 1, reason: 'refine' });
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ base: vec(1), 'refined more detail': vec(0.8) }),
      consolidator,
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'base' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'refined more detail' });
    expect(res.data.operation).toBe('update');
    expect(res.data.id).not.toBe(1);
    const rows = db.prepare('SELECT content FROM memories').all() as { content: string }[];
    expect(rows).toHaveLength(2);
    const old = db.prepare('SELECT expired_at, superseded_by FROM memories WHERE id = 1').get() as {
      expired_at: string | null; superseded_by: number | null;
    };
    expect(old.expired_at).not.toBeNull();
    expect(old.superseded_by).toBe(res.data.id);
    db.close();
  });

  it('contradict -> inserts new as current, invalidates the loser (not deleted)', async () => {
    const consolidator = fakeConsolidator({
      operation: 'contradict',
      target_id: 1,
      valid_at: '2026-03-01T00:00:00.000Z',
      reason: 'changed',
    });
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ 'stakeholder is Alex': vec(1), 'stakeholder is Sam': vec(0.8) }),
      consolidator,
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'stakeholder is Alex' });
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'stakeholder is Sam' });
    expect(res.data.operation).toBe('contradict');
    expect(res.data.superseded).toEqual([{ id: 1, content: 'stakeholder is Alex', reason: 'changed' }]);
    const loser = db.prepare('SELECT expired_at, invalid_at, superseded_by FROM memories WHERE id=1').get() as {
      expired_at: string | null;
      invalid_at: string | null;
      superseded_by: number | null;
    };
    expect(loser.expired_at).not.toBeNull();
    expect(loser.invalid_at).toBe('2026-03-01T00:00:00.000Z');
    expect(loser.superseded_by).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('contradict where the loser is already expired -> falls back to add (concurrency guard)', async () => {
    const consolidator = fakeConsolidator({ operation: 'contradict', target_id: 1, reason: 'race' });
    const { server, db } = makeMemoriesServer({
      embedder: fakeEmbedder({ a: vec(1), b: vec(0.8) }),
      consolidator,
    });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'a' });
    db.prepare("UPDATE memories SET expired_at='2026-01-01T00:00:00.000Z' WHERE id=1").run();
    const res = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'b' });
    expect(res.data.operation).toBe('add');
    expect(res.data.superseded).toEqual([]);
    db.close();
  });
});

describe('bi-temporal reads', () => {
  async function withSupersession() {
    const consolidator = fakeConsolidator({
      operation: 'contradict',
      target_id: 1,
      valid_at: '2026-03-01T00:00:00.000Z',
      reason: 'changed',
    });
    const ctx = makeMemoriesServer({
      embedder: fakeEmbedder({ 'stakeholder is Alex': vec(1), 'stakeholder is Sam': vec(0.8) }),
      consolidator,
    });
    await callTool(ctx.server, 'create-memory', { evidence: EV, source: 'chat', content: 'stakeholder is Alex' });
    ctx.db.prepare(
      "UPDATE memories SET created_at='2026-01-01T00:00:00.000Z', updated_at='2026-01-01T00:00:00.000Z', valid_at='2026-01-01T00:00:00.000Z' WHERE id=1",
    ).run();
    await callTool(ctx.server, 'create-memory', { evidence: EV, source: 'chat', content: 'stakeholder is Sam' });
    return ctx;
  }

  it('list-memories default excludes superseded memories', async () => {
    const { server, db } = await withSupersession();
    const res = await callTool(server, 'list-memories', { source: 'chat' });
    expect(res.data.memories.map((m: { content: string }) => m.content)).toEqual(['stakeholder is Sam']);
    db.close();
  });

  it('include_superseded=true returns the retracted memory too', async () => {
    const { server, db } = await withSupersession();
    const res = await callTool(server, 'list-memories', { source: 'chat', include_superseded: true });
    expect(res.data.memories).toHaveLength(2);
    db.close();
  });

  it('as_of before the change returns the old belief', async () => {
    const { server, db } = await withSupersession();
    const res = await callTool(server, 'list-memories', {
      source: 'chat',
      as_of: '2026-02-01T00:00:00.000Z',
      include_superseded: true,
    });
    expect(res.data.memories.map((m: { content: string }) => m.content)).toEqual(['stakeholder is Alex']);
    db.close();
  });

  it('get-memory include_lineage walks the supersession chain', async () => {
    const { server, db } = await withSupersession();
    const res = await callTool(server, 'get-memory', { id: 2, include_lineage: true });
    expect(res.data.lineage.map((m: { id: number }) => m.id)).toEqual([1, 2]);
    db.close();
  });
});
