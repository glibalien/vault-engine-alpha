import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, type Issue } from './errors.js';
import { runUsageReport, type UsageGroupDim } from '../../usage/report.js';

const DIMS = ['day', 'provider', 'model', 'service', 'purpose', 'conversation', 'experiment', 'variant',
  'sweep', 'run', 'source', 'stage', 'target', 'outcome', 'reported_model', 'cost_basis'] as const;

const paramsShape = {
  group_by: z.array(z.enum(DIMS)).default([])
    .describe('Composable grouping dimensions, e.g. ["day","provider"] for daily spend per provider or ["conversation"] for a per-conversation cost leaderboard'),
  since: z.string().optional().describe('ISO 8601 lower bound (inclusive)'),
  until: z.string().optional().describe('ISO 8601 upper bound (inclusive)'),
  utc_offset_minutes: z.number().int().min(-840).max(840).default(0)
    .describe('Shift "day" bucketing to local days (e.g. -240 for EDT); default 0 = UTC days'),
  provider: z.string().optional(),
  service: z.string().optional(),
  model: z.string().optional(),
  purpose: z.string().optional(),
  experiment: z.string().optional(),
  conversation_id: z.string().optional(),
  sweep_ref: z.string().optional(),
  run_ref: z.string().optional(),
  source_ref: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(1000).default(100),
};

export function registerUsageReport(server: McpServer, db: Database.Database): void {
  server.tool(
    'usage-report',
    'Aggregate recorded spend by day/provider/model or sweep/run/source/stage/call outcome. Returns provider_reported_usd, estimated_usd, unpriced_events and incomplete_usage_events separately. confirmed_usd is what the provider log later confirmed for confirmed_events of these calls (Deepgram today), against confirmed_ledger_usd recorded for the same calls; cost_usd is unchanged by confirmation. cost_usd is a known subtotal combining actual charges and estimates, not a complete bill. Unknown events are not free. outcome is a call outcome, not proof of publication. Totals cover the full filtered range even when groups are limited; offset paginates groups. Warns with UNPRICED_MODELS for unavailable pricing. When no filter but time and provider openrouter is set, reconciliation compares OpenRouter-reported spend for its daily reading intervals in range (provider_usd) with the ledger total over the same hours, leaving out rows paid with another key (ledger_usd, gap_usd); the 5.5% OpenRouter credit-purchase fee is in neither.',
    paramsShape,
    async (params) => {
      const result = runUsageReport(db, {
        groupBy: params.group_by as UsageGroupDim[],
        since: params.since,
        until: params.until,
        utcOffsetMinutes: params.utc_offset_minutes,
        provider: params.provider,
        service: params.service,
        model: params.model,
        purpose: params.purpose,
        experiment: params.experiment,
        conversationId: params.conversation_id,
        limit: params.limit,
        offset: params.offset,
        sweepRef: params.sweep_ref,
        runRef: params.run_ref,
        sourceRef: params.source_ref,
      });
      const warnings: Issue[] = [];
      if (result.unpriced.length > 0) {
        const providerPriced = result.unpriced.filter((u) => u.provider_priced);
        warnings.push({
          code: 'UNPRICED_MODELS',
          severity: 'warning',
          message: `${result.unpriced.reduce((n, u) => n + u.events, 0)} event(s) in range have no pricing row — cost_usd totals undercount. Models: ${result.unpriced.map((u) => u.model ?? '(none)').join(', ')}`
            + (providerPriced.length > 0
              ? `. ${providerPriced.map((u) => u.model).join(', ')} has no rate of its own: those calls reported no provider charge and the ledger had too few charged calls to estimate them from (the Engine retries at its next start); a pricing row can't fix them.`
              : ''),
          details: { unpriced: result.unpriced },
        });
      }
      return ok({
        groups: result.groups,
        ...(result.group_count !== undefined ? { group_count: result.group_count } : {}),
        totals: result.totals,
        ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}),
      }, warnings);
    },
  );
}
