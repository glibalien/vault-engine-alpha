import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  addUsageEvents(db);
  return db;
}

describe('UsageRecorder', () => {
  it('computes token cost and snapshots the rates', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    const r = rec.recordOrThrow({
      provider: 'anthropic', service: 'engine', purpose: 'vision-extraction',
      model: 'claude-sonnet-4-6',
      inputTokens: 100_000, outputTokens: 10_000, cacheWriteTokens: 20_000, cacheReadTokens: 500_000,
      sourceRef: 'Attachments/scan.pdf', latencyMs: 1234,
    });
    expect(r.costBasis).toBe('computed');
    expect(r.costUsd).toBeCloseTo(0.675, 10);
    const row = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(r.id) as Record<string, unknown>;
    expect(row.provider).toBe('anthropic');
    expect(row.cost_basis).toBe('computed');
    expect(row.input_tokens).toBe(100_000);
    expect(JSON.parse(row.pricing_json as string)).toEqual({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
    expect(typeof row.ts).toBe('string');
    db.close();
  });

  it('records unknown models as unpriced with cost 0', () => {
    const rec = new UsageRecorder(freshDb());
    const r = rec.recordOrThrow({
      provider: 'fireworks', service: 'curator', purpose: 'wiki-synthesis',
      model: 'accounts/fireworks/models/some-future-model',
      inputTokens: 1000, outputTokens: 1000,
    });
    expect(r).toMatchObject({ costUsd: 0, costBasis: 'unpriced' });
  });

  it('records provider-reported dollars verbatim (Exa)', () => {
    const rec = new UsageRecorder(freshDb());
    const r = rec.recordOrThrow({
      provider: 'exa', service: 'engine', purpose: 'web-search',
      providerCostUsd: 0.0125, sourceRef: 'quarterly report deadlines', requestId: 'req-1',
    });
    expect(r).toMatchObject({ costUsd: 0.0125, costBasis: 'provider-reported' });
  });

  it('prices audio by duration', () => {
    const rec = new UsageRecorder(freshDb());
    const r = rec.recordOrThrow({
      provider: 'deepgram', service: 'engine', purpose: 'audio-transcription',
      model: 'nova-3', audioSeconds: 600,
    });
    expect(r.costBasis).toBe('computed');
    expect(r.costUsd).toBeCloseTo(0.043, 10);
  });

  it('honors a caller-supplied ts and stores metadata as JSON', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    const r = rec.recordOrThrow({
      provider: 'fireworks', service: 'chat-web', purpose: 'conversation',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      inputTokens: 10, ts: '2026-07-01T00:00:00.000Z', metadata: { backfill: true },
    });
    const row = db.prepare('SELECT ts, metadata_json FROM usage_events WHERE id = ?').get(r.id) as { ts: string; metadata_json: string };
    expect(row.ts).toBe('2026-07-01T00:00:00.000Z');
    expect(JSON.parse(row.metadata_json)).toEqual({ backfill: true });
    db.close();
  });

  describe('which key paid (#345)', () => {
    const keyOf = (db: Database.Database, id: number | undefined) =>
      (db.prepare('SELECT key_ref FROM usage_events WHERE id = ?').get(id) as { key_ref: string | null }).key_ref;

    it('stamps an in-process call with the Engine\'s own key, whichever service caused it', () => {
      const db = freshDb();
      const rec = new UsageRecorder(db);
      rec.setOwnKeyRef('openrouter', 'engine-key');
      const r = rec.record({ provider: 'openrouter', service: 'curator', purpose: 'memory-consolidation', model: 'm', providerCostUsd: 1 });
      expect(keyOf(db, r?.id)).toBe('engine-key');
    });

    it('leaves another provider\'s row and a caller\'s reported row to what they say', () => {
      const db = freshDb();
      const rec = new UsageRecorder(db);
      rec.setOwnKeyRef('openrouter', 'engine-key');
      const exa = rec.record({ provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 1 });
      expect(keyOf(db, exa?.id)).toBeNull();
      const reported = rec.recordOrThrow({ provider: 'openrouter', service: 'curator', purpose: 'memory-sweep', model: 'm', providerCostUsd: 1, keyRef: 'curator-key' });
      expect(keyOf(db, reported.id)).toBe('curator-key');
      const unknown = rec.recordOrThrow({ provider: 'openrouter', service: 'chat-plugin', purpose: 'conversation', model: 'm', providerCostUsd: 1 });
      expect(keyOf(db, unknown.id)).toBeNull();
    });
  });

  it('record() swallows failures (observer posture)', () => {
    const db = freshDb();
    db.exec('DROP TABLE usage_events');
    const rec = new UsageRecorder(db);
    expect(() => rec.record({
      provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 0.01,
    })).not.toThrow();
    db.close();
  });
});

describe('setCatalogPricing hook', () => {
  it('uses catalog pricing when the hook resolves the model, before the static table', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    rec.setCatalogPricing((model) => (model === 'some/openrouter-model' ? { input: 2, output: 10 } : null));
    const r = rec.recordOrThrow({
      provider: 'openrouter', service: 'engine', purpose: 'conversation',
      model: 'some/openrouter-model',
      inputTokens: 1_000_000, outputTokens: 1_000_000,
    });
    expect(r.costBasis).not.toBe('unpriced');
    expect(r.costUsd).toBeCloseTo(12, 10); // 1M*$2/Mtok + 1M*$10/Mtok
    const row = db.prepare('SELECT pricing_json FROM usage_events WHERE id = ?').get(r.id) as { pricing_json: string };
    // Missing cache rates default to the input rate (resolvePricing's no-surcharge guard).
    expect(JSON.parse(row.pricing_json)).toEqual({ input: 2, output: 10, cacheWrite: 2, cacheRead: 2 });
    db.close();
  });

  it('falls back to the static table when the hook returns null for the model', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    rec.setCatalogPricing(() => null);
    const r = rec.recordOrThrow({
      provider: 'anthropic', service: 'engine', purpose: 'conversation',
      model: 'claude-sonnet-4-6', inputTokens: 100_000, outputTokens: 10_000,
    });
    expect(r.costBasis).toBe('computed');
    expect(r.costUsd).toBeCloseTo(0.45, 10);
    db.close();
  });

  it('without setCatalogPricing ever called, behavior is unchanged (table-only path)', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    const r = rec.recordOrThrow({
      provider: 'anthropic', service: 'engine', purpose: 'conversation',
      model: 'claude-sonnet-4-6', inputTokens: 100_000, outputTokens: 10_000,
    });
    expect(r.costBasis).toBe('computed');
    expect(r.costUsd).toBeCloseTo(0.45, 10);
    db.close();
  });
});

describe('onRecorded observer', () => {
  const event = {
    provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 0.007,
  } as const;

  it('fires once per successful insert on both record paths', () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const rec = new UsageRecorder(db);
    let fired = 0;
    rec.onRecorded = () => { fired += 1; };
    rec.recordOrThrow(event);
    rec.record(event);
    expect(fired).toBe(2);
    db.close();
  });

  it('a throwing observer breaks neither path — events still land, return value intact', () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const rec = new UsageRecorder(db);
    rec.onRecorded = () => { throw new Error('observer boom'); };
    const recorded = rec.recordOrThrow(event); // must not throw
    expect(recorded.costBasis).toBe('provider-reported');
    rec.record(event); // must not throw
    const count = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it('does not fire when the insert fails', () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const rec = new UsageRecorder(db);
    let fired = 0;
    rec.onRecorded = () => { fired += 1; };
    db.exec('DROP TABLE usage_events');
    expect(() => rec.recordOrThrow(event)).toThrow(); // tool path propagates
    rec.record(event); // best-effort path swallows
    expect(fired).toBe(0);
    db.close();
  });
});
