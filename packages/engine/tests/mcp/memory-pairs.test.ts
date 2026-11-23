import { describe, it, expect } from 'vitest';
import { computeNearPairs } from '../../src/mcp/tools/memory-pairs.js';
import { MEMORY_NEAR_DUP, MEMORY_UNRELATED, MEMORY_RECONCILE_REPORT_FAR } from '../../src/mcp/tools/memories.js';
import { makeMemoriesServer, callTool } from './memories.test.js';
import type { Embedder } from '../../src/search/embedder.js';

/** P2 enforcement: create-memory requires evidence. Tests not about evidence use this stamp. */
const EV = { kind: 'conversation', ref: 'test#0' } as const;

/** Embeds text as a unit vector at an angle parsed from a leading "@<deg> " tag. */
function angleEmbedder(): Embedder {
  const embed = (text: string): Float32Array => {
    const m = /^@(\d+) /.exec(text);
    const rad = ((m ? Number(m[1]) : 90) * Math.PI) / 180;
    const v = new Float32Array(256);
    v[0] = Math.cos(rad);
    v[1] = Math.sin(rad);
    return v;
  };
  return {
    isReady: () => true,
    async embedQuery(text: string) { return embed(text); },
    async embedDocument(text: string) { return [embed(text)]; },
  };
}

// cosine distance between @0 and @<deg> = 1 - cos(deg). Band [0.06, 0.35]:
//   @20 → 1 - cos(20°) ≈ 0.060  (just inside near edge)
//   @30 → 1 - cos(30°) ≈ 0.134  (mid band)
//   @80 → 1 - cos(80°) ≈ 0.826  (far outside)
describe('list-memory-near-pairs', () => {
  it('returns live cross-source pairs inside the band, distance ascending', async () => {
    const { server, db } = makeMemoriesServer({ embedder: angleEmbedder() });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@0 anchor fact' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: '@30 mid-band cousin' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@80 unrelated fact' });
    const res = await callTool(server, 'list-memory-near-pairs', {});
    expect(res.ok).toBe(true);
    expect(res.data.pairs).toHaveLength(1);
    expect(res.data.pairs[0].a.content).toBe('@0 anchor fact');
    expect(res.data.pairs[0].b.content).toBe('@30 mid-band cousin');
    expect(res.data.pairs[0].distance).toBeCloseTo(0.134, 2);
    expect(res.data.total_in_band).toBe(1);
    db.close();
  });

  it('gives each member the date of its source note, or null without a dated note (#351)', async () => {
    const { server, db } = makeMemoriesServer({ embedder: angleEmbedder() });
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('dated', 'dated.md', 'Dated');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_date) VALUES ('dated', 'date', '2026-09-01')").run();
    await callTool(server, 'create-memory', { evidence: { kind: 'note', node_id: 'dated', hash: 'h' }, source: 'curator', content: '@0 anchor fact' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@30 mid-band cousin' });
    const res = await callTool(server, 'list-memory-near-pairs', {});
    expect(res.data.pairs).toHaveLength(1);
    expect(res.data.pairs[0].a).toMatchObject({ content: '@0 anchor fact', note_date: '2026-09-01' });
    expect(res.data.pairs[0].b).toMatchObject({ content: '@30 mid-band cousin', note_date: null });
    db.close();
  });

  it('excludes expired members and respects limit while reporting total_in_band', async () => {
    const { server, db } = makeMemoriesServer({ embedder: angleEmbedder() });
    const a = await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@0 anchor fact' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@20 close cousin' });
    // Different source than '@20 close cousin': create-memory's own dedup gate
    // hard-rejects same-source inserts within MEMORY_NEAR_DUP (their 10° gap →
    // distance ≈0.015 is below it) — a live same-source pair that close can
    // never exist. A distinct source sidesteps that gate (dedup candidates are
    // filtered to matching source) without changing the cosine math below;
    // computeNearPairs is explicitly cross-source anyway.
    await callTool(server, 'create-memory', { evidence: EV, source: 'other', content: '@30 mid cousin' });
    // three pairs exist (0-20, 0-30, 20-30 → 1-cos(10°)≈0.015 is BELOW near, so 2 pairs)
    const limited = await callTool(server, 'list-memory-near-pairs', { limit: 1 });
    expect(limited.data.pairs).toHaveLength(1);
    expect(limited.data.total_in_band).toBe(2);
    await callTool(server, 'expire-memory', { id: a.data.id, reason: 'x' });
    const afterExpiry = await callTool(server, 'list-memory-near-pairs', {});
    expect(afterExpiry.data.total_in_band).toBe(0);
    db.close();
  });

  it('counts live-but-unembedded memories as skipped', async () => {
    const { server, db } = makeMemoriesServer({}); // no embedder → no vectors
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: 'no vector here' });
    const res = await callTool(server, 'list-memory-near-pairs', {});
    expect(res.data.pairs).toHaveLength(0);
    expect(res.data.skipped_unembedded).toBe(1);
    db.close();
  });

  it('rejects near >= far with INVALID_PARAMS', async () => {
    const { server, db } = makeMemoriesServer({});
    const res = await callTool(server, 'list-memory-near-pairs', { near: 0.4, far: 0.3 });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_PARAMS');
    db.close();
  });
});

describe('computeNearPairs (pure)', () => {
  it('limit 0 counts without returning pairs', async () => {
    const { server, db } = makeMemoriesServer({ embedder: angleEmbedder() });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@0 anchor fact' });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@30 mid cousin' });
    const r = computeNearPairs(db, { near: 0.06, far: 0.35, limit: 0 });
    expect(r.total_in_band).toBe(1);
    expect(r.pairs).toHaveLength(0);
    expect(r.considered).toBe(2);
    db.close();
  });
});

describe('vault-doctor reporting band (J3.1)', () => {
  it('reports on a band narrower than the dedup ceiling, and leaves the ceiling alone', () => {
    expect(MEMORY_RECONCILE_REPORT_FAR).toBe(0.15);
    expect(MEMORY_RECONCILE_REPORT_FAR).toBeLessThan(MEMORY_UNRELATED);
    // MUST stay 0.35. decideTier treats nearest > MEMORY_UNRELATED as "unrelated -> add",
    // so narrowing this instead of adding a separate reporting constant would silently
    // change which memories get created.
    expect(MEMORY_UNRELATED).toBe(0.35);
  });

  it('excludes a merely-adjacent pair that the old 0.35 band counted as backlog', async () => {
    const { server, db } = makeMemoriesServer({ embedder: angleEmbedder() });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@0 anchor fact' });
    // 1 - cos(45°) ≈ 0.293: comfortably inside the old band, nowhere near a duplicate.
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: '@45 topically adjacent' });

    const oldBand = computeNearPairs(db, { near: MEMORY_NEAR_DUP, far: MEMORY_UNRELATED, limit: 0 });
    const reportBand = computeNearPairs(db, { near: MEMORY_NEAR_DUP, far: MEMORY_RECONCILE_REPORT_FAR, limit: 0 });

    expect(oldBand.total_in_band).toBe(1);
    expect(reportBand.total_in_band).toBe(0);
    db.close();
  });

  it('still counts a genuine near-duplicate pair', async () => {
    const { server, db } = makeMemoriesServer({ embedder: angleEmbedder() });
    await callTool(server, 'create-memory', { evidence: EV, source: 'chat', content: '@0 anchor fact' });
    // 1 - cos(30°) ≈ 0.134 — inside 0.15, a real reconciliation candidate.
    await callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: '@30 near duplicate' });

    const reportBand = computeNearPairs(db, { near: MEMORY_NEAR_DUP, far: MEMORY_RECONCILE_REPORT_FAR, limit: 0 });
    expect(reportBand.total_in_band).toBe(1);
    db.close();
  });
});
