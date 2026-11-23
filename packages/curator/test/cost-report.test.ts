import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createJournalTable, insertJournalEvent } from '../src/db/journal.js';
import { makeCuratorCostReportHandler } from '../src/tools/curator-cost-report.js';

const db = new Database(':memory:'); createJournalTable(db);
afterEach(() => db.exec('DELETE FROM journal_events'));
const rows = [
  { run: 'published', events: 2, cost_usd: 0.5, provider_reported_usd: 0.5, estimated_usd: 0, unpriced_events: 0 },
  { run: 'failed', events: 1, cost_usd: 0.2, provider_reported_usd: 0.2, estimated_usd: 0, unpriced_events: 0 },
  { run: 'absent', events: 1, cost_usd: 0, provider_reported_usd: 0, estimated_usd: 0, unpriced_events: 1 },
];
function summary(run: string, outcome: string, dry = false) {
  insertJournalEvent(db, { ts: '2026-09-27T10:00:00Z', run_ref: run, trigger: 'scheduled', function: 'wiki-curation',
    kind: 'summary', action: null, node_id: null, target: null, detail: JSON.stringify({ stats: { outcome } }), dry_run: dry ? 1 : 0 });
}
const auth = { authInfo: { scopes: ['curate:read'] } };
it('joins exact run references to outcomes without equating returned calls with publication', async () => {
  summary('published', 'written'); summary('failed', 'error');
  const engine = { usageReport: vi.fn().mockResolvedValue({ data: { groups: rows, group_count: 3, totals: { events: 4, cost_usd: 0.7 } }, warnings: [] }) };
  const handler = makeCuratorCostReportHandler({ engine, db });
  const result = JSON.parse((await handler({ sweep_ref: 's1', limit: 1000 }, auth)).content[0]!.text);
  expect(engine.usageReport.mock.calls[0]![0]).toMatchObject({ service: 'curator', sweep_ref: 's1' });
  expect(engine.usageReport.mock.calls[0]![0]).not.toHaveProperty('since');
  expect(result.data.groups.map((r: any) => r.wiki_run_outcome)).toEqual(['written', 'error', 'unknown']);
  expect(result.data.by_wiki_outcome).toEqual(expect.arrayContaining([
    expect.objectContaining({ outcome: 'error', provider_reported_usd: 0.2 }),
    expect.objectContaining({ outcome: 'unknown', unpriced_events: 1 }),
  ]));
  expect(result.data.truncated).toBe(false);
});
it('does not label dry-runs, contradictory summaries or absent journal data as published', async () => {
  summary('published', 'written', true);
  summary('failed', 'error'); summary('failed', 'written');
  const engine = { usageReport: vi.fn().mockResolvedValue({ data: { groups: rows, group_count: 4, totals: { events: 5 } }, warnings: [] }) };
  const result = JSON.parse((await makeCuratorCostReportHandler({ engine, db })({ limit: 3 }, auth)).content[0]!.text);
  expect(result.data.groups.map((r: any) => r.wiki_run_outcome)).toEqual(['dry-run', 'unknown', 'unknown']);
  expect(result.data.truncated).toBe(true);
  expect(result.data.outcome_totals_complete).toBe(false);
});
it('requires read scope and never dispatches a provider call', async () => {
  const engine = { usageReport: vi.fn() };
  const result = await makeCuratorCostReportHandler({ engine, db })({ limit: 1000 }, {});
  expect(result.isError).toBe(true); expect(engine.usageReport).not.toHaveBeenCalled();
});
it.each([
  ['2026-09-27T10:00:00Z', '2026-09-27T10:00:00.000Z', '2026-09-27T10:00:00.000Z'],
  ['2026-09-27T10:00:00.000Z', '2026-09-27T10:00:00Z', '2026-09-27T10:00:00.000Z'],
  ['2026-09-27T10:00:00.1Z', '2026-09-27T10:00:00.10Z', '2026-09-27T10:00:00.100Z'],
])('accepts equivalent bounds %s and %s', async (since, until, canonical) => {
  const engine = { usageReport: vi.fn().mockResolvedValue({ data: { groups: [], group_count: 0, totals: {} }, warnings: [] }) };
  const result = JSON.parse((await makeCuratorCostReportHandler({ engine })({ since, until, limit: 1000 }, auth)).content[0]!.text);
  expect(result.ok).toBe(true);
  expect(engine.usageReport).toHaveBeenCalledWith(expect.objectContaining({ since: canonical, until: canonical }));
  expect(result.data.filters).toMatchObject({ since: canonical, until: canonical });
});
it('includes both boundary events when Engine applies textual timestamp predicates', async () => {
  const ledger = new Database(':memory:');
  try {
    ledger.exec(`CREATE TABLE usage_events (ts TEXT, cost_usd REAL);
      INSERT INTO usage_events VALUES ('2026-09-27T10:00:00.000Z', 0.2), ('2026-09-27T10:00:00.100Z', 0.3),
        ('2026-09-27T09:59:59.999Z', 10), ('2026-09-27T10:00:00.101Z', 10)`);
    const engine = { usageReport: vi.fn(async ({ since, until }: { since?: string; until?: string }) => ({
      data: { groups: [], group_count: 0, totals: ledger.prepare(
        'SELECT COUNT(*) AS events, SUM(cost_usd) AS cost_usd FROM usage_events WHERE ts >= ? AND ts <= ?',
      ).get(since, until) as { events: number; cost_usd: number } }, warnings: [],
    })) };
    const result = JSON.parse((await makeCuratorCostReportHandler({ engine })({ sweep_ref: 's1',
      since: '2026-09-27T10:00:00Z', until: '2026-09-27T10:00:00.1Z', limit: 1000 }, auth)).content[0]!.text);
    expect(result.ok).toBe(true);
    expect(result.data.totals).toEqual({ events: 2, cost_usd: 0.5 });
  } finally { ledger.close(); }
});
it('rejects a chronologically reversed range before querying Engine', async () => {
  const engine = { usageReport: vi.fn() };
  const result = await makeCuratorCostReportHandler({ engine })({
    since: '2026-09-27T10:00:00.1Z', until: '2026-09-27T10:00:00Z', limit: 1000,
  }, auth);
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text).error.code).toBe('INVALID_RANGE');
  expect(engine.usageReport).not.toHaveBeenCalled();
});
