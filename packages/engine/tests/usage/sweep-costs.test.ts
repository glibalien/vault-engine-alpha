import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { runUsageReport } from '../../src/usage/report.js';
import { recordUsageParamsShape } from '../../src/mcp/tools/record-usage.js';
import { z } from 'zod';

const db = new Database(':memory:');
addUsageEvents(db);
afterEach(() => db.exec('DELETE FROM usage_events'));

it('accepts only finite nonnegative provider charges through the existing MCP contract', () => {
  const input = { provider: 'openrouter', service: 'curator', purpose: 'wiki-synthesis', provider_cost_usd: 0.12 };
  expect(z.object(recordUsageParamsShape).parse(input)).toHaveProperty('provider_cost_usd', 0.12);
  for (const bad of [-1, Infinity, NaN]) {
    expect(z.object(recordUsageParamsShape).safeParse({ ...input, provider_cost_usd: bad }).success).toBe(false);
  }
});

it('separates actual, estimated and unknown spending and retains unattributed events', () => {
  const recorder = new UsageRecorder(db);
  const base = { provider: 'openrouter' as const, service: 'curator' as const, purpose: 'wiki-synthesis' as const,
    model: 'openrouter/auto', runRef: 'r1', sourceRef: 'Project', metadata: {
      curator_usage: { version: 1, sweep_ref: 's1', outcome: 'failed', reported_model: 'resolved', stage: 'page', usage_complete: true },
    } };
  recorder.recordOrThrow({ ...base, providerCostUsd: 0.25 });
  recorder.recordOrThrow({ ...base, providerCostUsd: 0 });
  recorder.recordOrThrow({ ...base });
  recorder.recordOrThrow({ provider: 'anthropic', service: 'curator', purpose: 'journal', model: 'claude-sonnet-4-6', inputTokens: 1000 });
  // Legacy or malformed metadata must not make reporting fail.
  db.prepare("UPDATE usage_events SET metadata_json = 'broken' WHERE purpose = 'journal'").run();
  const result = runUsageReport(db, { service: 'curator', groupBy: ['sweep', 'run', 'source', 'stage', 'outcome', 'reported_model'], limit: 1 });
  expect(result.group_count).toBe(2);
  expect(result.groups[0]).toMatchObject({ sweep: 's1', run: 'r1', source: 'Project', stage: 'page', outcome: 'failed', reported_model: 'resolved', events: 3 });
  expect(result.totals).toMatchObject({ events: 4, provider_reported_usd: 0.25, provider_reported_events: 2,
    estimated_events: 1, unpriced_events: 1 });
  expect(result.totals.estimated_usd).toBeCloseTo(0.003);
  expect(runUsageReport(db, { sweepRef: 's1' }).totals.events).toBe(3);
  expect(runUsageReport(db, { runRef: 'missing' }).totals.events).toBe(0);
});

it("counts only the Curator's own reports as incomplete usage, not the Engine's consolidation calls (#319)", () => {
  const recorder = new UsageRecorder(db);
  const curator = { provider: 'openrouter' as const, service: 'curator' as const, model: 'openrouter/auto' };
  const marker = (complete: boolean) => ({ curator_usage: { version: 1, usage_complete: complete } });
  recorder.recordOrThrow({ ...curator, purpose: 'memory-sweep', providerCostUsd: 0.01, metadata: marker(true) });
  recorder.recordOrThrow({ ...curator, purpose: 'memory-sweep', providerCostUsd: 0.01, metadata: marker(false) });
  // A Curator report from before the marker existed is still unknown.
  recorder.recordOrThrow({ ...curator, purpose: 'reconcile', inputTokens: 100 });
  // Memory consolidation the Engine ran for the Curator's create-memory: filed under the
  // Curator's budget, recorded by the Engine with full token counts and no Curator marker.
  recorder.recordOrThrow({ ...curator, purpose: 'memory-consolidation', inputTokens: 1000, outputTokens: 50 });
  recorder.recordOrThrow({ ...curator, purpose: 'memory-consolidation', inputTokens: 1000, outputTokens: 50 });

  expect(runUsageReport(db, { service: 'curator' }).totals).toMatchObject({ events: 5, incomplete_usage_events: 2 });
  const byPurpose = runUsageReport(db, { service: 'curator', groupBy: ['purpose'] }).groups;
  expect(byPurpose.find(g => g.purpose === 'memory-consolidation')).toMatchObject({ events: 2, incomplete_usage_events: 0 });
});
