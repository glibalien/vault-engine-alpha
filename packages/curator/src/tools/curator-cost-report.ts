import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import { withScope } from '../auth/with-scope.js';

export const curatorCostReportInput = {
  sweep_ref: z.string().min(1).max(200).optional().describe('Exact sweep ID from a previous report; omit to list the time window'),
  since: z.string().datetime().optional().describe('Inclusive UTC start; defaults to 24 hours ago unless sweep_ref is supplied'),
  until: z.string().datetime().optional().describe('Inclusive UTC end; defaults to now unless sweep_ref is supplied'),
  limit: z.number().int().min(1).max(1000).default(1000),
};
type Args = { sweep_ref?: string; since?: string; until?: string; limit: number };
type Deps = { engine: Pick<Engine, 'usageReport'>; db?: Database.Database };

/** Publication is established only by an unambiguous exact-run summary. No title/time heuristic. */
function wikiOutcome(db: Database.Database | undefined, run: unknown): string {
  if (!db || typeof run !== 'string') return 'unknown';
  try {
    const rows = db.prepare(`SELECT detail, dry_run FROM journal_events WHERE run_ref = ?
      AND kind = 'summary' AND "function" IN ('wiki-curation', 'topic-curation')`).all(run) as Array<{ detail: string; dry_run: number }>;
    if (rows.length === 0) return 'unknown';
    const outcomes = new Set(rows.map(row => {
      const value: unknown = JSON.parse(row.detail)?.stats?.outcome;
      if (row.dry_run) return 'dry-run';
      if (value === 'written' || value === 'error' || value === 'dry-run') return value;
      if (typeof value === 'string' && (value === 'skipped' || value.startsWith('skipped_'))) return 'skipped';
      return 'unknown';
    }));
    return outcomes.size === 1 ? [...outcomes][0]! : 'unknown';
  } catch { return 'unknown'; }
}

export function makeCuratorCostReportHandler(deps: Deps) {
  return withScope<Args>('curate:read', async args => {
    const now = new Date();
    const bounds = args.sweep_ref ? {} : {
      since: new Date(now.getTime() - 86_400_000).toISOString(), until: now.toISOString(),
    };
    // Match ledger timestamps before comparing bounds or Engine's textual filtering.
    const filters = { ...bounds, ...(args.since ? { since: new Date(args.since).toISOString() } : {}),
      ...(args.until ? { until: new Date(args.until).toISOString() } : {}), ...(args.sweep_ref ? { sweep_ref: args.sweep_ref } : {}) };
    if (filters.since && filters.until && filters.since > filters.until) return {
      isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false,
        error: { code: 'INVALID_RANGE', message: 'since must be at or before until' } }) }],
    };
    try {
      const { data, warnings } = await deps.engine.usageReport({ ...filters, service: 'curator', limit: args.limit,
        group_by: ['sweep', 'run', 'source', 'purpose', 'provider', 'stage', 'target', 'outcome', 'model', 'reported_model'] });
      const outcomes = new Map<unknown, string>();
      const groups = data.groups.map(group => {
        if (!outcomes.has(group.run)) outcomes.set(group.run, wikiOutcome(deps.db, group.run));
        return { ...group, wiki_run_outcome: outcomes.get(group.run)! };
      });
      const sums = new Map<string, Record<string, number | string>>();
      for (const group of groups) {
        const row: Record<string, unknown> = group;
        const outcome = group.wiki_run_outcome;
        const sum = sums.get(outcome) ?? { outcome, events: 0, provider_reported_usd: 0, estimated_usd: 0,
          unpriced_events: 0, incomplete_usage_events: 0 };
        for (const key of ['events', 'provider_reported_usd', 'estimated_usd', 'unpriced_events', 'incomplete_usage_events']) {
          if (typeof row[key] === 'number') sum[key] = Number(sum[key]) + row[key];
        }
        sums.set(outcome, sum);
      }
      const truncated = data.group_count === undefined || data.group_count > groups.length;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: {
        filters, totals: data.totals, groups, group_count: data.group_count, truncated,
        by_wiki_outcome: [...sums.values()], outcome_totals_complete: !truncated,
        coverage: 'Recorded Curator calls only. Actual charges and estimates are separate; unpriced events are unknown, not free. Missing responses or failed ledger writes may be absent. Returned calls do not prove publication; written runs do not certify prose quality. Outcome subtotals cover returned groups only.',
      }, warnings }) }] };
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false,
        error: { code: 'COST_REPORT_UNAVAILABLE', message: 'Engine usage reporting is unavailable; ensure Engine supports sweep cost dimensions.' } }) }] };
    }
  });
}
