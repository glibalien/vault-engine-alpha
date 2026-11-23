/**
 * #340: an Auto Router call with no reported charge is estimated from recent charged calls to
 * it (charges over tokens), live when recorded and for past rows at Engine start.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import {
  backfillProviderPricedEstimates, chargedRate, CHARGED_SAMPLE, MIN_CHARGED_SAMPLE,
} from '../../src/usage/provider-priced-estimate.js';

const AUTO = 'openrouter/auto';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  addUsageEvents(db);
  return db;
}

/** A charged Auto Router call: `usd` for `tokens` tokens (split input/output). */
function charged(rec: UsageRecorder, usd: number, tokens = 1000) {
  return rec.recordOrThrow({
    provider: 'openrouter', service: 'curator', purpose: 'wiki-synthesis', model: AUTO,
    inputTokens: tokens - 100, outputTokens: 100, providerCostUsd: usd,
  });
}

/** Insert an uncharged row as the past ledger has them (unpriced at $0), bypassing estimation. */
function pastUncharged(db: Database.Database, tokens: number): number {
  return Number(db.prepare(`
    INSERT INTO usage_events (ts, provider, model, service, purpose, input_tokens, output_tokens, cost_usd, cost_basis)
    VALUES ('2026-09-20T00:00:00.000Z', 'openrouter', ?, 'curator', 'wiki-synthesis', ?, 0, 0, 'unpriced')
  `).run(AUTO, tokens).lastInsertRowid);
}

const row = (db: Database.Database, id: number) =>
  db.prepare('SELECT cost_usd, cost_basis, pricing_json FROM usage_events WHERE id = ?').get(id) as
    { cost_usd: number; cost_basis: string; pricing_json: string | null };

describe('live estimate', () => {
  it('prices an uncharged Auto Router call at the charged calls\' blended per-token rate', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    // 20 calls at $0.002 per 1,000 tokens → $2 per million tokens.
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.002);
    const r = rec.recordOrThrow({ provider: 'openrouter', service: 'chat-plugin', purpose: 'title-generation', model: AUTO,
      inputTokens: 400, outputTokens: 50, cacheReadTokens: 50 });
    expect(r.costBasis).toBe('computed');
    expect(r.costUsd).toBeCloseTo(0.001, 12); // 500 tokens × $2/M
    expect(JSON.parse(row(db, r.id).pricing_json!)).toEqual({
      estimated_from: 'charged-calls', usd_per_million_tokens: expect.closeTo(2, 9), sample_calls: MIN_CHARGED_SAMPLE,
    });
    db.close();
  });

  it('stays unpriced with fewer charged calls than the minimum, or with no tokens', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    for (let i = 0; i < MIN_CHARGED_SAMPLE - 1; i++) charged(rec, 0.002);
    expect(rec.recordOrThrow({ provider: 'openrouter', service: 'engine', purpose: 'vision-extraction', model: AUTO, inputTokens: 10 }))
      .toMatchObject({ costUsd: 0, costBasis: 'unpriced' });
    charged(rec, 0.002);
    expect(rec.recordOrThrow({ provider: 'openrouter', service: 'engine', purpose: 'vision-extraction', model: AUTO }))
      .toMatchObject({ costUsd: 0, costBasis: 'unpriced' });
    db.close();
  });

  it('uses only the latest charged calls, and never estimates a charged or a priced call', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    for (let i = 0; i < CHARGED_SAMPLE; i++) charged(rec, 0.1); // old and dear: $100/M
    for (let i = 0; i < CHARGED_SAMPLE; i++) charged(rec, 0.001); // latest: $1/M
    expect(chargedRate(db, AUTO)).toEqual({ usdPerMillionTokens: expect.closeTo(1, 9), sampleCalls: CHARGED_SAMPLE });
    expect(charged(rec, 0.5)).toMatchObject({ costUsd: 0.5, costBasis: 'provider-reported' });
    const sonnet = rec.recordOrThrow({ provider: 'anthropic', service: 'engine', purpose: 'vision-extraction',
      model: 'claude-sonnet-4-6', inputTokens: 100_000, outputTokens: 10_000 });
    expect(sonnet.costUsd).toBeCloseTo(0.45, 10);
    expect(JSON.parse(row(db, sonnet.id).pricing_json!)).not.toHaveProperty('estimated_from');
    db.close();
  });

  it('does not count estimated rows as charged calls', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.002);
    for (let i = 0; i < 50; i++) rec.recordOrThrow({ provider: 'openrouter', service: 'engine', purpose: 'vision-extraction', model: AUTO, inputTokens: 1000 });
    expect(chargedRate(db, AUTO)).toEqual({ usdPerMillionTokens: expect.closeTo(2, 9), sampleCalls: MIN_CHARGED_SAMPLE });
    db.close();
  });
});

describe('backfill of past uncharged rows', () => {
  it('prices each past row from the charged calls just before it, else just after', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    const older = pastUncharged(db, 2000); // before every charged call
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.003); // $3/M
    const middle = pastUncharged(db, 1000);
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.005); // $5/M
    const thin = pastUncharged(db, 0); // no tokens: stays unpriced

    const at = new Date('2026-11-08T12:00:00.000Z');
    const result = backfillProviderPricedEstimates(db, at);
    expect(result.rows).toBe(2);
    // older has no charged calls before it: it takes the 40 after it (20 at $3/M, 20 at $5/M),
    // so $4/M. middle takes the 20 just before it, at $3/M.
    expect(row(db, older)).toMatchObject({ cost_basis: 'computed' });
    expect(row(db, older).cost_usd).toBeCloseTo(0.008, 12);
    expect(row(db, middle).cost_usd).toBeCloseTo(0.003, 12);
    expect(result.usd).toBeCloseTo(0.011, 12);
    expect(JSON.parse(row(db, middle).pricing_json!)).toEqual({
      estimated_from: 'charged-calls', usd_per_million_tokens: expect.closeTo(3, 9), sample_calls: MIN_CHARGED_SAMPLE,
      backfilled_at: '2026-11-08T12:00:00.000Z',
    });
    expect(row(db, thin)).toMatchObject({ cost_usd: 0, cost_basis: 'unpriced' });
    db.close();
  });

  it('agrees with chargedRate for the same row', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    for (let i = 0; i < CHARGED_SAMPLE + 30; i++) charged(rec, 0.001 * (1 + (i % 7)), 800 + (i % 5) * 300);
    const past = pastUncharged(db, 1234);
    for (let i = 0; i < 40; i++) charged(rec, 0.02);
    const expected = chargedRate(db, AUTO, past)!;
    backfillProviderPricedEstimates(db);
    expect(row(db, past).cost_usd).toBeCloseTo((1234 * expected.usdPerMillionTokens) / 1_000_000, 12);
    expect(JSON.parse(row(db, past).pricing_json!).sample_calls).toBe(CHARGED_SAMPLE);
    db.close();
  });

  it('leaves rows it can\'t price for a later start, and reprices nothing twice', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    const past = pastUncharged(db, 1000);
    expect(backfillProviderPricedEstimates(db)).toEqual({ rows: 0, usd: 0 });
    expect(row(db, past).cost_basis).toBe('unpriced');
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.002);
    expect(backfillProviderPricedEstimates(db).rows).toBe(1);
    const once = row(db, past);
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.5);
    expect(backfillProviderPricedEstimates(db)).toEqual({ rows: 0, usd: 0 });
    expect(row(db, past)).toEqual(once);
    db.close();
  });

  it('touches only provider-priced models', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) charged(rec, 0.002);
    const other = rec.recordOrThrow({ provider: 'fireworks', service: 'curator', purpose: 'wiki-synthesis',
      model: 'accounts/fireworks/models/some-future-model', inputTokens: 1000 });
    expect(backfillProviderPricedEstimates(db).rows).toBe(0);
    expect(row(db, other.id)).toMatchObject({ cost_usd: 0, cost_basis: 'unpriced' });
    db.close();
  });
});
