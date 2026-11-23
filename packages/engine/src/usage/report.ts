import type Database from 'better-sqlite3';
import { isProviderPricedModel } from '@vault/pricing';
import { COST_SUMS, SWEEP_COLUMN, STAGE_COLUMN, OUTCOME_COLUMN, REPORTED_MODEL_COLUMN, usageMetadata } from './cost-columns.js';
import { reconciliationSummary, type ReconciliationSummary } from './openrouter-reconcile.js';

export type UsageGroupDim =
  | 'day' | 'provider' | 'model' | 'service' | 'purpose'
  | 'conversation' | 'experiment' | 'variant' | 'sweep' | 'run' | 'source' | 'stage' | 'target' | 'outcome' | 'reported_model' | 'cost_basis';

export interface UsageReportParams {
  groupBy?: UsageGroupDim[] | undefined;
  since?: string | undefined;
  until?: string | undefined;
  utcOffsetMinutes?: number | undefined;
  provider?: string | undefined;
  service?: string | undefined;
  model?: string | undefined;
  purpose?: string | undefined;
  experiment?: string | undefined;
  conversationId?: string | undefined;
  limit?: number | undefined;
  sweepRef?: string | undefined;
  runRef?: string | undefined;
  sourceRef?: string | undefined;
  offset?: number | undefined;
}

export interface UsageReportResult {
  groups: Array<Record<string, unknown>>;
  /** Total distinct groups for the same filters+dims, un-LIMITed. Absent when groupBy is empty. */
  group_count?: number;
  totals: Record<string, unknown>;
  /** `provider_priced`: a model with no rate of its own (OpenRouter's Auto Router), whose rows
   *  lack the provider's charge and couldn't yet be estimated from charged calls; a price row
   *  can't fix them (#340). */
  unpriced: Array<{ model: string | null; events: number; provider_priced?: true }>;
  /** OpenRouter's own figure against the ledger for the intervals in range (#328). Present only
   *  when there are some and the filters leave every OpenRouter row in: no filter other than the
   *  time range and provider 'openrouter'. */
  reconciliation?: ReconciliationSummary;
}

/** Simple column dims; 'day' is handled specially (date() with an offset modifier). */
const GROUP_COLS: Record<Exclude<UsageGroupDim, 'day'>, string> = {
  provider: 'provider',
  model: 'model',
  service: 'service',
  purpose: 'purpose',
  conversation: 'conversation_id',
  experiment: 'experiment',
  variant: 'variant',
  sweep: SWEEP_COLUMN,
  run: 'run_ref',
  source: 'source_ref',
  stage: STAGE_COLUMN,
  target: usageMetadata('$.wiki_call.target'),
  outcome: OUTCOME_COLUMN,
  reported_model: REPORTED_MODEL_COLUMN,
  cost_basis: 'cost_basis',
};

const SUMS = `
  COUNT(*) AS events,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(audio_seconds), 0) AS audio_seconds,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  MIN(ts) AS first_ts, MAX(ts) AS last_ts,
  COALESCE(SUM(${usageMetadata('$.curator_usage.reasoning_tokens')}), 0) AS reasoning_tokens,
  COALESCE(SUM(${usageMetadata('$.curator_usage.reasoning_tokens')} IS NOT NULL), 0) AS reasoning_known_events,
  COALESCE(SUM(${usageMetadata('$.curator_usage.response_count')}), 0) AS observed_responses,
  ${COST_SUMS}`;

export function runUsageReport(db: Database.Database, params: UsageReportParams): UsageReportResult {
  const conditions: string[] = [];
  const filterBindings: unknown[] = [];
  if (params.since !== undefined) { conditions.push('ts >= ?'); filterBindings.push(params.since); }
  if (params.until !== undefined) { conditions.push('ts <= ?'); filterBindings.push(params.until); }
  const eqFilters: Array<[string, string | undefined]> = [
    ['provider', params.provider], ['service', params.service], ['model', params.model],
    ['purpose', params.purpose], ['experiment', params.experiment], ['conversation_id', params.conversationId],
    [SWEEP_COLUMN, params.sweepRef], ['run_ref', params.runRef], ['source_ref', params.sourceRef],
  ];
  for (const [col, val] of eqFilters) {
    if (val !== undefined) { conditions.push(`${col} = ?`); filterBindings.push(val); }
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const dims = [...new Set(params.groupBy ?? [])];
  // The TypeScript union is erased at runtime — re-validate every dim against
  // the fixed whitelist BEFORE any of these strings reach SQL text (the SELECT
  // alias and GROUP BY clause are built from them).
  for (const dim of dims) {
    if (dim !== 'day' && !Object.hasOwn(GROUP_COLS, dim)) {
      throw new Error(`unknown group_by dimension: ${dim}`);
    }
  }
  const selectBindings: unknown[] = [];
  const selectParts: string[] = [];
  for (const dim of dims) {
    if (dim === 'day') {
      selectParts.push('date(ts, ?) AS day');
      selectBindings.push(`${params.utcOffsetMinutes ?? 0} minutes`);
    } else {
      selectParts.push(`${GROUP_COLS[dim]} AS ${dim}`);
    }
  }

  const limit = Math.min(params.limit ?? 100, 1000);
  let groups: Array<Record<string, unknown>> = [];
  let group_count: number | undefined;
  if (dims.length > 0) {
    const sql = `
      SELECT ${selectParts.join(', ')}, ${SUMS}
      FROM usage_events ${where}
      GROUP BY ${dims.join(', ')}
      ORDER BY cost_usd DESC, events DESC, ${dims.join(', ')}
      LIMIT ? OFFSET ?`;
    groups = db.prepare(sql).all(...selectBindings, ...filterBindings, limit, Math.max(0, params.offset ?? 0)) as Array<Record<string, unknown>>;
    group_count = (db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${selectParts.join(', ')} FROM usage_events ${where} GROUP BY ${dims.join(', ')}
      )`).get(...selectBindings, ...filterBindings) as { n: number }).n;
  }

  const totals = db.prepare(`SELECT ${SUMS} FROM usage_events ${where}`)
    .get(...filterBindings) as Record<string, unknown>;

  const unpricedWhere = conditions.length > 0
    ? `WHERE cost_basis = 'unpriced' AND ${conditions.join(' AND ')}`
    : `WHERE cost_basis = 'unpriced'`;
  const unpriced = (db.prepare(`
    SELECT model, COUNT(*) AS events FROM usage_events ${unpricedWhere} GROUP BY model ORDER BY events DESC
  `).all(...filterBindings) as Array<{ model: string | null; events: number }>)
    .map(u => (u.model !== null && isProviderPricedModel(u.model) ? { ...u, provider_priced: true as const } : u));

  const narrowed = [params.service, params.model, params.purpose, params.experiment, params.conversationId,
    params.sweepRef, params.runRef, params.sourceRef].some(v => v !== undefined);
  const reconciliation = !narrowed && (params.provider === undefined || params.provider === 'openrouter')
    ? reconciliationSummary(db, params.since, params.until) : undefined;

  return {
    groups, ...(group_count !== undefined ? { group_count } : {}), totals, unpriced,
    ...(reconciliation && reconciliation.intervals > 0 ? { reconciliation } : {}),
  };
}
