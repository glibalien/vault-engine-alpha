import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { runUsageReport } from '../../src/usage/report.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  addUsageEvents(db);
  const rec = new UsageRecorder(db);
  // Two chat turns on one conversation (day 1), one on another (day 2):
  rec.recordOrThrow({ ts: '2026-07-01T10:00:00.000Z', provider: 'fireworks', service: 'chat-web', purpose: 'conversation', model: 'accounts/fireworks/models/qwen3p7-plus', inputTokens: 10_000, outputTokens: 1_000, conversationId: 'conv-A' });
  rec.recordOrThrow({ ts: '2026-07-01T12:00:00.000Z', provider: 'fireworks', service: 'chat-web', purpose: 'conversation', model: 'accounts/fireworks/models/qwen3p7-plus', inputTokens: 20_000, outputTokens: 2_000, conversationId: 'conv-A' });
  rec.recordOrThrow({ ts: '2026-07-02T01:00:00.000Z', provider: 'fireworks', service: 'chat-web', purpose: 'conversation', model: 'accounts/fireworks/models/qwen3p7-plus', inputTokens: 5_000, outputTokens: 500, conversationId: 'conv-B' });
  // A curator call, a deepgram call, and an unpriced model:
  rec.recordOrThrow({ ts: '2026-07-01T03:00:00.000Z', provider: 'anthropic', service: 'curator', purpose: 'wiki-synthesis', model: 'claude-sonnet-4-6', inputTokens: 50_000, outputTokens: 5_000 });
  rec.recordOrThrow({ ts: '2026-07-02T03:00:00.000Z', provider: 'deepgram', service: 'engine', purpose: 'audio-transcription', model: 'nova-3', audioSeconds: 300 });
  rec.recordOrThrow({ ts: '2026-07-02T04:00:00.000Z', provider: 'fireworks', service: 'curator', purpose: 'wiki-synthesis', model: 'mystery-model', inputTokens: 9_999 });
});

describe('runUsageReport', () => {
  it('groups by day+provider (UTC days)', () => {
    const res = runUsageReport(db, { groupBy: ['day', 'provider'] });
    const key = (g: Record<string, unknown>) => `${g.day}/${g.provider}`;
    const byKey = new Map(res.groups.map((g) => [key(g), g]));
    expect(byKey.get('2026-07-01/fireworks')).toMatchObject({ events: 2, input_tokens: 30_000 });
    expect(byKey.get('2026-07-01/anthropic')).toMatchObject({ events: 1 });
    expect(byKey.get('2026-07-02/deepgram')).toMatchObject({ events: 1, audio_seconds: 300 });
  });

  it('shifts day buckets with utcOffsetMinutes', () => {
    const utc = runUsageReport(db, { groupBy: ['day'], service: 'chat-web' });
    expect(utc.groups.map((g) => g.day).sort()).toEqual(['2026-07-01', '2026-07-02']);
    // 2026-07-02T01:00Z is still 2026-07-01 at UTC-4 (offset -240) → one bucket.
    const local = runUsageReport(db, { groupBy: ['day'], utcOffsetMinutes: -240, service: 'chat-web' });
    expect(local.groups.map((g) => g.day)).toEqual(['2026-07-01']);
  });

  it('groups by conversation sorted by cost desc', () => {
    const res = runUsageReport(db, { groupBy: ['conversation'], service: 'chat-web' });
    expect(res.groups[0]).toMatchObject({ conversation: 'conv-A', events: 2 });
    expect(res.groups[1]).toMatchObject({ conversation: 'conv-B', events: 1 });
  });

  it('filters by time range and service, and reports totals', () => {
    const res = runUsageReport(db, { since: '2026-07-02T00:00:00.000Z', service: 'chat-web' });
    expect(res.groups).toEqual([]); // no groupBy → groups empty, totals populated
    expect(res.totals).toMatchObject({ events: 1, input_tokens: 5_000 });
  });

  it('surfaces unpriced models in range', () => {
    const res = runUsageReport(db, {});
    expect(res.unpriced).toEqual([{ model: 'mystery-model', events: 1 }]);
    const none = runUsageReport(db, { until: '2026-07-01T23:59:59.000Z' });
    expect(none.unpriced).toEqual([]);
  });

  it('rejects unknown group_by dims before building SQL (runtime whitelist)', () => {
    expect(() =>
      runUsageReport(db, { groupBy: ['ts; DROP TABLE usage_events; --' as never] }),
    ).toThrow(/unknown group_by dimension/);
    // Table untouched — the malicious string never reached SQL text.
    expect(runUsageReport(db, {}).totals).toMatchObject({ events: 6 });
  });

  it('returns group_count for the FULL group population regardless of limit', () => {
    const res = runUsageReport(db, { groupBy: ['day', 'provider'], limit: 2 });
    expect(res.groups).toHaveLength(2);
    expect(res.group_count).toBe(4);
  });

  it('omits group_count when there is no grouping', () => {
    const res = runUsageReport(db, {});
    expect(res.group_count).toBeUndefined();
  });
});
