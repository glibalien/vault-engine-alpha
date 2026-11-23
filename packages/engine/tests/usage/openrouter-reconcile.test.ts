import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { providerKeyRef } from '@vault/llm';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { runUsageReport } from '../../src/usage/report.js';
import {
  formatReconcileOutcome, openRouterKeyUsage, readingDue, reconcileOpenRouter, reconciliationIntervals,
  reconciliationSummary, startOpenRouterReconciliation,
} from '../../src/usage/openrouter-reconcile.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  addUsageEvents(db);
});
afterEach(() => db.close());

const at = (iso: string) => () => new Date(iso);

function keyFetch(...usages: Array<number | { status: number } | Error>) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: (init?.headers as Record<string, string>).Authorization });
    const next = usages[Math.min(i++, usages.length - 1)]!;
    if (next instanceof Error) throw next;
    if (typeof next === 'object') return new Response('{}', { status: next.status });
    return new Response(JSON.stringify({ data: { label: 'masked', usage: next, limit: null } }), { status: 200 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function openRouterCall(ts: string, service: 'engine' | 'curator' | 'chat-plugin', usd: number | null) {
  new UsageRecorder(db).recordOrThrow({
    ts, provider: 'openrouter', service, purpose: 'wiki-synthesis', model: 'mystery/model',
    ...(usd === null ? { inputTokens: 10 } : { providerCostUsd: usd }),
  });
}

describe('openRouterKeyUsage / providerKeyRef', () => {
  it('reads the running usage figure and nothing else', () => {
    expect(openRouterKeyUsage({ data: { usage: 12.5 } })).toBe(12.5);
    for (const body of [null, {}, { data: {} }, { data: { usage: -1 } }, { data: { usage: '3' } }]) {
      expect(openRouterKeyUsage(body)).toBeUndefined();
    }
  });
  it('fingerprints the key without storing it', () => {
    expect(providerKeyRef('sk-or-secret')).toMatch(/^[0-9a-f]{16}$/);
    expect(providerKeyRef('sk-or-secret')).not.toContain('secret');
    expect(providerKeyRef('sk-or-other')).not.toBe(providerKeyRef('sk-or-secret'));
  });
});

describe('readingDue', () => {
  it('reads at the first tick after midnight UTC once 20 hours have passed, or after 26 hours at any tick', () => {
    expect(readingDue(new Date('2026-11-04T00:10:00Z'), null)).toBe(true);
    expect(readingDue(new Date('2026-11-04T00:10:00Z'), '2026-11-03T04:00:00Z')).toBe(true); // 20h10m, midnight hour
    expect(readingDue(new Date('2026-11-04T00:10:00Z'), '2026-11-03T05:00:00Z')).toBe(false); // 19h10m
    expect(readingDue(new Date('2026-11-04T13:00:00Z'), '2026-11-03T12:00:00Z')).toBe(false); // 25h, not midnight
    expect(readingDue(new Date('2026-11-04T14:00:00Z'), '2026-11-03T12:00:00Z')).toBe(true); // 26h
  });
});

describe('reconcileOpenRouter', () => {
  it('compares the usage delta with the ledger over exactly the interval between readings', async () => {
    const { fetch, calls } = keyFetch(10, 10.75);
    expect(await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-03T00:05:00.000Z') }))
      .toEqual({ status: 'first-reading', usage_usd: 10 });
    expect(calls[0]).toEqual({ url: 'https://openrouter.ai/api/v1/key', auth: 'Bearer k1' });

    openRouterCall('2026-11-03T00:04:59.000Z', 'curator', 5); // before the first reading: not counted
    openRouterCall('2026-11-03T08:00:00.000Z', 'curator', 0.4);
    openRouterCall('2026-11-03T09:00:00.000Z', 'engine', 0.1);
    openRouterCall('2026-11-03T10:00:00.000Z', 'chat-plugin', null); // unpriced: $0 in the ledger
    openRouterCall('2026-11-04T00:05:00.000Z', 'curator', 0.05); // exactly at the second reading: counted
    openRouterCall('2026-11-04T00:05:01.000Z', 'curator', 9); // after it: not counted

    const out = await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-04T00:05:00.000Z') });
    expect(out.status).toBe('reconciled');
    if (out.status !== 'reconciled') return;
    expect(out.interval).toMatchObject({
      start_at: '2026-11-03T00:05:00.000Z', end_at: '2026-11-04T00:05:00.000Z',
      ledger_events: 4, ledger_unpriced_events: 1,
      ledger_by_service: { 'chat-plugin': 0, curator: 0.45, engine: 0.1 },
    });
    expect(out.interval.provider_usd).toBeCloseTo(0.75);
    expect(out.interval.ledger_usd).toBeCloseTo(0.55);
    expect(out.interval.gap_usd).toBeCloseTo(0.2);
    expect(formatReconcileOutcome(out)).toMatch(/OpenRouter \$0\.7500, ledger \$0\.5500 \(4 calls, 1 unpriced\), gap \$0\.2000/);

    const stored = db.prepare('SELECT * FROM provider_reconciliations').all() as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.ledger_by_service_json as string)).toEqual({ 'chat-plugin': 0, curator: 0.45, engine: 0.1 });
    // The ledger is never touched.
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n).toBe(6);
  });

  it('skips a reading that is not due, and takes one when forced', async () => {
    const { fetch, calls } = keyFetch(1, 1.5);
    await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-03T00:05:00.000Z') });
    expect(await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-03T06:00:00.000Z') })).toEqual({ status: 'skipped' });
    expect(calls).toHaveLength(1);
    const forced = await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-03T06:00:00.000Z'), force: true });
    expect(forced.status).toBe('reconciled');
  });

  it('never pairs readings from different keys, and starts a fresh baseline at once after a switch', async () => {
    await reconcileOpenRouter(db, { apiKey: 'k1', fetch: keyFetch(50).fetch, now: at('2026-11-03T00:05:00.000Z') });
    // A switch to k2 six hours later is read straight away, not at the next midnight.
    const other = await reconcileOpenRouter(db, { apiKey: 'k2', fetch: keyFetch(2).fetch, now: at('2026-11-03T06:00:00.000Z') });
    expect(other).toEqual({ status: 'first-reading', usage_usd: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_reconciliations').get()).toEqual({ n: 0 });
  });

  it('does not bridge back to an earlier key across readings of another (A, B, B, A)', async () => {
    await reconcileOpenRouter(db, { apiKey: 'kA', fetch: keyFetch(10).fetch, now: at('2026-11-01T00:05:00.000Z') });
    await reconcileOpenRouter(db, { apiKey: 'kB', fetch: keyFetch(0).fetch, now: at('2026-11-01T03:00:00.000Z') });
    openRouterCall('2026-11-01T12:00:00.000Z', 'curator', 1);
    await reconcileOpenRouter(db, { apiKey: 'kB', fetch: keyFetch(1).fetch, now: at('2026-11-02T00:05:00.000Z') });
    const back = await reconcileOpenRouter(db, { apiKey: 'kA', fetch: keyFetch(10).fetch, now: at('2026-11-02T06:00:00.000Z') });
    expect(back).toEqual({ status: 'first-reading', usage_usd: 10 });
    const all = reconciliationSummary(db);
    expect(all.intervals).toBe(1);
    expect(all.provider_usd).toBeCloseTo(1);
    expect(all.ledger_usd).toBeCloseTo(1);
  });

  it('records no interval when the running usage goes down', async () => {
    const { fetch } = keyFetch(5, 4);
    await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-03T00:05:00.000Z') });
    const out = await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-04T00:05:00.000Z') });
    expect(out).toEqual({ status: 'usage-went-down', usage_usd: 4, previous_usd: 5 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_reconciliations').get()).toEqual({ n: 0 });
  });

  it('stores nothing when the reading fails', async () => {
    for (const [answer, reason] of [[{ status: 401 }, /key rejected/], [{ status: 503 }, /HTTP 503/],
      [new TypeError('fetch failed'), /fetch failed/]] as const) {
      const out = await reconcileOpenRouter(db, { apiKey: 'k1', fetch: keyFetch(answer).fetch, now: at('2026-11-03T00:05:00.000Z') });
      expect(out.status).toBe('failed');
      if (out.status === 'failed') expect(out.reason).toMatch(reason);
    }
    const noUsage = vi.fn(async () => new Response('{"data":{}}', { status: 200 })) as unknown as typeof fetch;
    expect(await reconcileOpenRouter(db, { apiKey: 'k1', fetch: noUsage, now: at('2026-11-03T00:05:00.000Z') }))
      .toEqual({ status: 'failed', reason: 'no usage figure in the response' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_usage_readings').get()).toEqual({ n: 0 });
  });
});

describe('reconciliation in reports', () => {
  async function twoIntervals() {
    const { fetch } = keyFetch(10, 11, 13);
    await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-01T00:05:00.000Z') });
    openRouterCall('2026-11-01T12:00:00.000Z', 'curator', 0.9);
    await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-02T00:05:00.000Z') });
    openRouterCall('2026-11-02T12:00:00.000Z', 'curator', 1.5);
    await reconcileOpenRouter(db, { apiKey: 'k1', fetch, now: at('2026-11-03T00:05:00.000Z') });
  }

  it('attributes each interval to the UTC day it mostly covers', async () => {
    await twoIntervals();
    const all = reconciliationSummary(db);
    expect(all).toMatchObject({ intervals: 2, first_start: '2026-11-01T00:05:00.000Z', last_end: '2026-11-03T00:05:00.000Z' });
    expect(all.provider_usd).toBeCloseTo(3);
    expect(all.ledger_usd).toBeCloseTo(2.4);
    expect(all.gap_usd).toBeCloseTo(0.6);
    const second = reconciliationSummary(db, '2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.999Z');
    expect(second.intervals).toBe(1);
    expect(second.provider_usd).toBeCloseTo(2);
  });

  it('counts a row that lands inside an interval after it was stored', async () => {
    await twoIntervals();
    // A call that started before the second reading and finished after it is recorded late,
    // timestamped at its start.
    openRouterCall('2026-11-02T00:04:00.000Z', 'curator', 0.1);
    const first = reconciliationSummary(db, '2026-11-01T00:00:00.000Z', '2026-11-01T23:59:59.999Z');
    expect(first.ledger_usd).toBeCloseTo(1.0);
    expect(first.gap_usd).toBeCloseTo(0);
    const rows = reconciliationIntervals(db);
    expect(rows[0]).toMatchObject({ ledger_events: 2, ledger_by_service: { curator: expect.closeTo(1.0) } });
    expect(rows[0]!.gap_usd).toBeCloseTo(0);
    // The stored figure stays the one at the reading.
    expect((db.prepare('SELECT ledger_usd FROM provider_reconciliations ORDER BY start_at LIMIT 1').get() as { ledger_usd: number }).ledger_usd)
      .toBeCloseTo(0.9);
  });

  it('usage-report includes it only when every OpenRouter row is in scope', async () => {
    await twoIntervals();
    expect(runUsageReport(db, { since: '2026-11-01T00:00:00.000Z' }).reconciliation).toMatchObject({ intervals: 2 });
    expect(runUsageReport(db, { provider: 'openrouter' }).reconciliation).toMatchObject({ intervals: 2 });
    expect(runUsageReport(db, { service: 'curator' }).reconciliation).toBeUndefined();
    expect(runUsageReport(db, { provider: 'deepgram' }).reconciliation).toBeUndefined();
    expect(runUsageReport(db, { since: '2026-12-01T00:00:00.000Z' }).reconciliation).toBeUndefined();
  });
});

describe('with separate keys (#345)', () => {
  const ENGINE_KEY = 'sk-or-engine';
  const ENGINE_REF = providerKeyRef(ENGINE_KEY);
  const CURATOR_REF = providerKeyRef('sk-or-curator');
  const call = (ts: string, usd: number, keyRef?: string, service: 'curator' | 'chat-plugin' = 'curator') =>
    new UsageRecorder(db).recordOrThrow({ ts, provider: 'openrouter', service, purpose: 'wiki-synthesis', model: 'm', providerCostUsd: usd, keyRef });
  const reconcile = async (keyFirst = 100, keySecond = 101.0088) => {
    const f = keyFetch(keyFirst, keySecond);
    await reconcileOpenRouter(db, { apiKey: ENGINE_KEY, fetch: f.fetch, now: at('2026-11-04T00:35:00.000Z') });
    return reconcileOpenRouter(db, { apiKey: ENGINE_KEY, fetch: f.fetch, now: at('2026-11-05T00:35:00.000Z') });
  };

  it('compares the key only with the rows it paid for, whichever service caused them', async () => {
    call('2026-11-04T10:00:00.000Z', 1.0088, ENGINE_REF);
    call('2026-11-04T11:00:00.000Z', 2.9856, CURATOR_REF);
    const outcome = await reconcile();
    expect(outcome.status).toBe('reconciled');
    if (outcome.status !== 'reconciled') return;
    expect(outcome.interval.ledger_usd).toBeCloseTo(1.0088, 8);
    expect(outcome.interval.gap_usd).toBeCloseTo(0, 8);
    expect(outcome.interval.ledger_events).toBe(1);
    expect(outcome.interval.ledger_other_keys_usd).toBeCloseTo(2.9856, 8);
    expect(formatReconcileOutcome(outcome)).toContain('$2.9856 on other keys left out');
  });

  it('applies the same split in reports, including a row that lands after the reading', async () => {
    call('2026-11-04T10:00:00.000Z', 1, ENGINE_REF);
    call('2026-11-04T11:00:00.000Z', 2, CURATOR_REF);
    await reconcile(100, 101.5);
    call('2026-11-04T12:00:00.000Z', 0.5, ENGINE_REF);
    call('2026-11-04T13:00:00.000Z', 4, CURATOR_REF);
    const summary = reconciliationSummary(db);
    expect(summary.ledger_usd).toBeCloseTo(1.5, 8);
    expect(summary.gap_usd).toBeCloseTo(0, 8);
    const [interval] = reconciliationIntervals(db);
    expect(interval).toMatchObject({ ledger_events: 2, ledger_other_keys_usd: 6 });
    expect(interval!.ledger_usd).toBeCloseTo(1.5, 8);
  });

  it('keeps a single comparison when every service shares the key', async () => {
    call('2026-11-04T10:00:00.000Z', 1, ENGINE_REF);
    call('2026-11-04T11:00:00.000Z', 0.0088, ENGINE_REF);
    const outcome = await reconcile();
    expect(outcome).toMatchObject({ status: 'reconciled', interval: { ledger_events: 2, ledger_other_keys_usd: 0 } });
    expect(formatReconcileOutcome(outcome)).not.toContain('left out');
  });

  it('keeps a row with no fingerprint in the comparison, since it may be this key\'s', async () => {
    call('2026-11-04T10:00:00.000Z', 1, ENGINE_REF);
    call('2026-11-04T11:00:00.000Z', 0.25, undefined, 'chat-plugin');
    const outcome = await reconcile();
    expect(outcome).toMatchObject({ status: 'reconciled', interval: { ledger_events: 2, ledger_other_keys_usd: 0 } });
    if (outcome.status === 'reconciled') expect(outcome.interval.ledger_usd).toBeCloseTo(1.25, 8);
  });

  it('compares an interval stored before keys were recorded with every row, as it did', () => {
    db.prepare(`INSERT INTO provider_reconciliations
      (provider, start_at, end_at, provider_usd, ledger_usd, gap_usd, ledger_events, ledger_unpriced_events, ledger_by_service_json)
      VALUES ('openrouter', '2026-11-04T00:00:00.000Z', '2026-11-05T00:00:00.000Z', 3, 3, 0, 2, 0, '{}')`).run();
    call('2026-11-04T10:00:00.000Z', 1, ENGINE_REF);
    call('2026-11-04T11:00:00.000Z', 2, CURATOR_REF);
    expect(reconciliationSummary(db).ledger_usd).toBeCloseTo(3, 8);
    expect(reconciliationIntervals(db)[0]).toMatchObject({ ledger_events: 2, ledger_other_keys_usd: 0 });
  });
});

describe('startOpenRouterReconciliation', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks after the initial delay and hourly, reading only when due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T22:00:00.000Z'));
    const { fetch, calls } = keyFetch(1, 1.25);
    const lines: string[] = [];
    const onChanged = vi.fn();
    const handle = startOpenRouterReconciliation(db, {
      apiKey: 'k1', fetch, initialDelayMs: 60_000, tickMs: 3_600_000, log: l => lines.push(l), onChanged,
    });
    await vi.advanceTimersByTimeAsync(60_000); // 22:01: first reading
    expect(calls).toHaveLength(1);
    expect(lines[0]).toMatch(/first reading/);
    await vi.advanceTimersByTimeAsync(3_600_000 * 2); // 23:01, 00:01: too soon (2h)
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000 * 24); // through the next midnight hour, 26h+ on
    expect(calls).toHaveLength(2);
    expect(lines[1]).toMatch(/gap/);
    expect(onChanged).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
