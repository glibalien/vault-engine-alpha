import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { runUsageReport } from '../../src/usage/report.js';
import {
  confirmDeepgramCosts, deepgramRequestUsd, formatDeepgramConfirmResult, startDeepgramConfirmations,
} from '../../src/usage/deepgram-confirm.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  addUsageEvents(db);
});
afterEach(() => db.close());

function transcription(requestId: string | undefined, ts: string, audioSeconds = 600): number {
  new UsageRecorder(db).recordOrThrow({
    provider: 'deepgram', model: 'nova-3', service: 'engine', purpose: 'audio-transcription', audioSeconds,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const id = (db.prepare('SELECT MAX(id) AS id FROM usage_events').get() as { id: number }).id;
  db.prepare('UPDATE usage_events SET ts = ? WHERE id = ?').run(ts, id);
  return id;
}

type Route = (url: string) => { status: number; body?: unknown } | Error;
function fakeFetch(route: Route) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Token dg-key');
    const r = route(url);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const projects = (...ids: string[]) => ({ status: 200, body: { projects: ids.map(project_id => ({ project_id, name: 'p' })) } });
const charged = (usd: number) => ({ status: 200, body: { request: { request_id: 'x', response: { details: { usd } }, code: 200 } } });
const confirmations = () => db.prepare('SELECT usage_event_id, status, confirmed_cost_usd, attempts FROM usage_confirmations ORDER BY usage_event_id').all();

describe('deepgramRequestUsd', () => {
  it('reads the current envelope and the older top-level shape, and nothing else', () => {
    expect(deepgramRequestUsd({ request: { response: { details: { usd: 0.0428 } } } })).toBe(0.0428);
    expect(deepgramRequestUsd({ response: { details: { usd: 0 } } })).toBe(0);
    for (const body of [null, 'x', {}, { request: { response: null } }, { request: { response: { details: { usd: -1 } } } },
      { response: { details: { usd: 'NaN' } } }]) {
      expect(deepgramRequestUsd(body)).toBeUndefined();
    }
  });
});

describe('confirmDeepgramCosts', () => {
  it('records the charge beside the ledger row and reports both, leaving cost_usd alone', async () => {
    const a = transcription('req-a', hoursAgo(30));
    const b = transcription('req-b', hoursAgo(5));
    const estimate = (db.prepare('SELECT cost_usd FROM usage_events WHERE id = ?').get(a) as { cost_usd: number }).cost_usd;
    const { fetch, calls } = fakeFetch(url => url.endsWith('/projects') ? projects('proj-1')
      : url.endsWith('/requests/req-a') ? charged(0.031) : charged(0.012));

    const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
    expect(r).toMatchObject({ checked: 2, confirmed: 2, pending: 0, notFound: 0 });
    expect(r.confirmedUsd).toBeCloseTo(0.043);
    expect(calls).toContain('https://api.deepgram.com/v1/projects/proj-1/requests/req-a');
    expect(confirmations()).toEqual([
      { usage_event_id: a, status: 'confirmed', confirmed_cost_usd: 0.031, attempts: 1 },
      { usage_event_id: b, status: 'confirmed', confirmed_cost_usd: 0.012, attempts: 1 },
    ]);
    expect((db.prepare('SELECT cost_usd FROM usage_events WHERE id = ?').get(a) as { cost_usd: number }).cost_usd).toBe(estimate);

    const totals = runUsageReport(db, {}).totals;
    expect(totals.confirmed_events).toBe(2);
    expect(totals.confirmed_usd).toBeCloseTo(0.043);
    expect(totals.confirmed_ledger_usd).toBeCloseTo(totals.cost_usd as number);
    const grouped = runUsageReport(db, { groupBy: ['provider'] }).groups[0];
    expect(grouped).toMatchObject({ provider: 'deepgram', confirmed_events: 2 });

    // Confirmed rows are never looked up again.
    const again = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
    expect(again.checked).toBe(0);
  });

  it('skips rows without a request id, outside the 90-day log, or too fresh to be logged', async () => {
    transcription(undefined, hoursAgo(30));
    transcription('old', hoursAgo(24 * 95));
    transcription('fresh', new Date(NOW.getTime() - 60_000).toISOString());
    const { fetch, calls } = fakeFetch(() => projects('proj-1'));
    const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
    expect(r.checked).toBe(0);
    expect(calls).toEqual([]);
  });

  it('marks requests with no cost yet as pending and retries them after a day, up to five lookups', async () => {
    const id = transcription('req-p', hoursAgo(30));
    const { fetch } = fakeFetch(url => url.endsWith('/projects') ? projects('proj-1')
      : { status: 200, body: { request: { request_id: 'req-p', response: null } } });
    let now = NOW;
    expect((await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => now })).pending).toBe(1);
    // Not again within the retry window.
    expect((await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => now })).checked).toBe(0);
    for (let day = 1; day <= 6; day += 1) {
      now = new Date(NOW.getTime() + day * 86_400_000);
      await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => now });
    }
    expect(confirmations()).toEqual([{ usage_event_id: id, status: 'pending', confirmed_cost_usd: null, attempts: 5 }]);
  });

  it('tries each project the key sees, then records not_found', async () => {
    const found = transcription('in-second', hoursAgo(30));
    const missing = transcription('nowhere', hoursAgo(29));
    const { fetch, calls } = fakeFetch(url => {
      if (url.endsWith('/projects')) return projects('p1', 'p2');
      if (url.includes('/projects/p2/requests/in-second')) return charged(0.02);
      return { status: 404, body: { err_msg: 'not found' } };
    });
    const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
    expect(r).toMatchObject({ checked: 2, confirmed: 1, notFound: 1 });
    // After a match the matching project is tried first.
    expect(calls.filter(u => u.includes('/requests/nowhere'))).toEqual([
      'https://api.deepgram.com/v1/projects/p2/requests/nowhere',
      'https://api.deepgram.com/v1/projects/p1/requests/nowhere',
    ]);
    expect(confirmations()).toEqual([
      { usage_event_id: found, status: 'confirmed', confirmed_cost_usd: 0.02, attempts: 1 },
      { usage_event_id: missing, status: 'not_found', confirmed_cost_usd: null, attempts: 1 },
    ]);
  });

  it('stops without recording on an auth failure, a rate limit or a network error', async () => {
    transcription('req-a', hoursAgo(30));
    transcription('req-b', hoursAgo(29));
    const cases: Array<[Route, RegExp]> = [
      [url => url.endsWith('/projects') ? { status: 403 } : charged(1), /DEEPGRAM_API_KEY cannot read usage.*usage:read and billing:read/],
      [url => url.endsWith('/projects') ? projects('p1') : { status: 429 }, /HTTP 429/],
      [url => url.endsWith('/projects') ? projects('p1') : { status: 503 }, /HTTP 503/],
      [url => url.endsWith('/projects') ? projects('p1') : new TypeError('fetch failed'), /fetch failed/],
      [() => ({ status: 200, body: { projects: [] } }), /no Deepgram project/],
    ];
    for (const [route, reason] of cases) {
      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch: fakeFetch(route).fetch, now: () => NOW });
      expect(r.checked).toBe(0);
      expect(r.stopped).toMatch(reason);
      expect(confirmations()).toEqual([]);
    }
  });

  describe('a key that can read requests but not their charges (#344)', () => {
    /** What a Member-role key got from production: full details, no `usd`. */
    const noUsd = { status: 200, body: { request_id: 'x', response: { code: 200, completed: 'c', details: { duration: 60, tier: 't' } } } };

    const route = (hidden: (url: string) => boolean) => fakeFetch(url => (url.endsWith('/projects') ? projects('p1') : hidden(url) ? noUsd : charged(0.12)));
    const after = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

    it('names the key and what it may lack, and spends no lookup', async () => {
      const first = transcription('req-1', hoursAgo(48));
      const second = transcription('req-2', hoursAgo(47));
      const { fetch } = route(() => true);

      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });

      expect(r).toMatchObject({ checked: 2, confirmed: 0, pending: 2, notFound: 0 });
      expect(r.stopped).toBe('no charge visible on 2 requests; DEEPGRAM_API_KEY may be missing the billing:read scope');
      expect(confirmations()).toEqual([
        { usage_event_id: first, status: 'pending', confirmed_cost_usd: null, attempts: 0 },
        { usage_event_id: second, status: 'pending', confirmed_cost_usd: null, attempts: 0 },
      ]);
    });

    it('never gives up on those rows, and confirms them once the key is fixed', async () => {
      const id = transcription('req-1', hoursAgo(48));
      const hiddenKey = route(() => true);
      for (let day = 0; day < 7; day += 1) {
        await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch: hiddenKey.fetch, now: () => after(day * 24) });
      }

      const fixedKey = route(() => false);
      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch: fixedKey.fetch, now: () => after(7 * 24) });

      expect(r).toMatchObject({ checked: 1, confirmed: 1 });
      expect(r.stopped).toBeUndefined();
      expect(confirmations()).toEqual([{ usage_event_id: id, status: 'confirmed', confirmed_cost_usd: 0.12, attempts: 1 }]);
    });

    it('still reports the key after it replaces one that could see charges', async () => {
      transcription('old', hoursAgo(50));
      const newer = transcription('newer', hoursAgo(48));
      await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch: route(url => url.endsWith('/newer')).fetch, now: () => NOW, batchLimit: 1 });

      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch: route(() => true).fetch, now: () => after(1), batchLimit: 1 });

      expect(r.stopped).toMatch(/billing:read/);
      expect(confirmations()).toContainEqual({ usage_event_id: newer, status: 'pending', confirmed_cost_usd: null, attempts: 0 });
    });

    it('visits a batch at a time, so rows with no charge cannot keep it from newer ones', async () => {
      const older = transcription('older', hoursAgo(48));
      const newer = transcription('newer', hoursAgo(47));
      const { fetch } = route(url => url.endsWith('/older'));

      const first = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW, batchLimit: 1 });
      expect(first.stopped).toMatch(/no charge visible on 1 request;/);

      // A day on, the row never visited goes first, even though the older one is due again.
      const second = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => after(24), batchLimit: 1 });
      expect(second).toMatchObject({ checked: 1, confirmed: 1 });
      expect(second.stopped).toBeUndefined();

      expect(confirmations()).toEqual([
        { usage_event_id: older, status: 'pending', confirmed_cost_usd: null, attempts: 0 },
        { usage_event_id: newer, status: 'confirmed', confirmed_cost_usd: 0.12, attempts: 1 },
      ]);
    });

    it('keeps a visit when a later lookup stops the run', async () => {
      const hidden = transcription('hidden', hoursAgo(48));
      transcription('limited', hoursAgo(47));
      const { fetch } = fakeFetch(url => (url.endsWith('/projects') ? projects('p1') : url.endsWith('/hidden') ? noUsd : { status: 429 }));

      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });

      expect(r.stopped).toBe('HTTP 429');
      expect(confirmations()).toEqual([{ usage_event_id: hidden, status: 'pending', confirmed_cost_usd: null, attempts: 0 }]);
    });

    it('does not blame the key when it saw a charge in the same run', async () => {
      const odd = transcription('odd', hoursAgo(48));
      const fine = transcription('fine', hoursAgo(47));
      const { fetch } = route(url => url.endsWith('/odd'));

      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });

      expect(r).toMatchObject({ checked: 2, confirmed: 1, pending: 1, notFound: 0 });
      expect(r.stopped).toBeUndefined();
      expect(confirmations()).toEqual([
        { usage_event_id: odd, status: 'pending', confirmed_cost_usd: null, attempts: 0 },
        { usage_event_id: fine, status: 'confirmed', confirmed_cost_usd: 0.12, attempts: 1 },
      ]);
    });

    it('still reads a request with no details yet as pending, not as a key problem', async () => {
      transcription('req-1', hoursAgo(48));
      const { fetch } = fakeFetch(url => (url.endsWith('/projects') ? projects('p1') : { status: 200, body: { request: { response: null } } }));
      const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
      expect(r).toMatchObject({ checked: 1, pending: 1 });
      expect(r.stopped).toBeUndefined();
    });
  });

  it('stops, without spending a lookup, when a response body never arrives intact', async () => {
    transcription('req-a', hoursAgo(30));
    const route: Route = url => url.endsWith('/projects') ? projects('p1') : { status: 200, body: undefined };
    const { fetch } = fakeFetch(route);
    const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
    expect(r.checked).toBe(0);
    expect(r.stopped).toMatch(/unreadable response/);
    expect(confirmations()).toEqual([]);
  });

  it('keeps the rows it finished before a mid-run stop', async () => {
    const a = transcription('req-a', hoursAgo(30));
    transcription('req-b', hoursAgo(29));
    const { fetch } = fakeFetch(url => url.endsWith('/projects') ? projects('p1')
      : url.endsWith('/req-a') ? charged(0.01) : { status: 500 });
    const r = await confirmDeepgramCosts(db, { apiKey: 'dg-key', fetch, now: () => NOW });
    expect(r).toMatchObject({ checked: 1, confirmed: 1, stopped: 'HTTP 500' });
    expect(confirmations()).toEqual([{ usage_event_id: a, status: 'confirmed', confirmed_cost_usd: 0.01, attempts: 1 }]);
    expect(formatDeepgramConfirmResult(r)).toBe('[usage] deepgram confirmations: checked 1, confirmed 1 ($0.0100 charged vs '
      + `$${r.estimatedUsd.toFixed(4)} estimated), pending 0, not found 0; stopped: HTTP 500`);
    expect(r.estimatedUsd).toBeGreaterThan(0);
  });
});

describe('startDeepgramConfirmations', () => {
  afterEach(() => vi.useRealTimers());

  it('runs after the initial delay, then on each interval, and logs only runs that did something', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    transcription('req-a', hoursAgo(30));
    const lines: string[] = [];
    const { fetch, calls } = fakeFetch(url => url.endsWith('/projects') ? projects('p1') : charged(0.01));
    const onChanged = vi.fn();
    const handle = startDeepgramConfirmations(db, {
      apiKey: 'dg-key', fetch, initialDelayMs: 1_000, intervalMs: 10_000, log: l => lines.push(l), onChanged,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/confirmed 1/);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toHaveLength(1); // nothing left to check
    expect(onChanged).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
