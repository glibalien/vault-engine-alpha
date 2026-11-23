import type Database from 'better-sqlite3';
import { isProviderPricedModel } from '@vault/pricing';

/**
 * Estimates for calls to a model with no rate of its own (OpenRouter's Auto Router,
 * `isProviderPricedModel`) that arrived without the provider's charge (#340).
 *
 * The estimate is the blended rate of recent calls to the same model that did carry a charge:
 * their charges over their tokens, applied to this call's tokens. Per token rather than per call,
 * because one call can be a short title and the next a whole wiki page.
 */

/** How many charged calls the rate is taken from. */
export const CHARGED_SAMPLE = 200;
/** Fewer charged calls than this and the call stays unpriced: a handful can't give a fair rate. */
export const MIN_CHARGED_SAMPLE = 20;

export interface ChargedRate {
  usdPerMillionTokens: number;
  sampleCalls: number;
}

const TOKENS = `(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
  + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0))`;

/** Every token a row recorded, in all four buckets. */
export function totalTokens(e: { inputTokens?: number | undefined; outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }): number {
  return (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0);
}

/**
 * The rate of the latest charged calls to `model`, or, with `nearId`, of the charged calls just
 * before that row, else just after it (a backfilled row older than every charged call).
 * Null when there aren't enough.
 */
export function chargedRate(db: Database.Database, model: string, nearId?: number): ChargedRate | null {
  const sample = (where: string, order: 'ASC' | 'DESC', ...bindings: unknown[]): ChargedRate | null => {
    const row = db.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(tokens), 0) AS tokens FROM (
        SELECT cost_usd, ${TOKENS} AS tokens FROM usage_events
        WHERE model = ? AND cost_basis = 'provider-reported' AND ${TOKENS} > 0 ${where}
        ORDER BY id ${order} LIMIT ?
      )
    `).get(model, ...bindings, CHARGED_SAMPLE) as { calls: number; usd: number; tokens: number };
    if (row.calls < MIN_CHARGED_SAMPLE || row.tokens <= 0) return null;
    return { usdPerMillionTokens: (row.usd / row.tokens) * 1_000_000, sampleCalls: row.calls };
  };
  if (nearId === undefined) return sample('', 'DESC');
  return sample('AND id < ?', 'DESC', nearId) ?? sample('AND id > ?', 'ASC', nearId);
}

/** What an estimated row's `pricing_json` records about where its cost came from. */
export function estimatePricingJson(rate: ChargedRate, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    estimated_from: 'charged-calls',
    usd_per_million_tokens: rate.usdPerMillionTokens,
    sample_calls: rate.sampleCalls,
    ...extra,
  });
}

/** A charged call's id, charge and tokens, for windows over them in id order. */
interface Charged { id: number; usd: number; tokens: number }

/** The same rate as `chargedRate(db, model, nearId)`, over charged rows already loaded in id
 *  order, so a backfill of many rows reads the ledger once. */
function nearestRate(charged: readonly Charged[], prefix: { usd: number[]; tokens: number[] }, nearId: number): ChargedRate | null {
  // First charged row at or after nearId.
  let lo = 0;
  let hi = charged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (charged[mid]!.id < nearId) lo = mid + 1; else hi = mid;
  }
  const window = (from: number, to: number): ChargedRate | null => {
    const calls = to - from;
    const tokens = prefix.tokens[to]! - prefix.tokens[from]!;
    if (calls < MIN_CHARGED_SAMPLE || tokens <= 0) return null;
    return { usdPerMillionTokens: ((prefix.usd[to]! - prefix.usd[from]!) / tokens) * 1_000_000, sampleCalls: calls };
  };
  const after = charged[lo]?.id === nearId ? lo + 1 : lo;
  return window(Math.max(0, lo - CHARGED_SAMPLE), lo) ?? window(after, Math.min(charged.length, after + CHARGED_SAMPLE));
}

/**
 * Price past uncharged rows of every provider-priced model in the ledger (#340's backfill), each
 * from the charged calls nearest it. Rows that still can't be estimated stay unpriced and are
 * tried again at the next start. Runs at every Engine start; a row is repriced once, since it is
 * no longer unpriced afterwards.
 */
export function backfillProviderPricedEstimates(db: Database.Database, now = new Date()): { rows: number; usd: number } {
  const candidates = (db.prepare(`
    SELECT id, model, ${TOKENS} AS tokens FROM usage_events
    WHERE cost_basis = 'unpriced' AND model IS NOT NULL AND ${TOKENS} > 0
    ORDER BY id
  `).all() as Array<{ id: number; model: string; tokens: number }>)
    .filter(r => isProviderPricedModel(r.model));
  if (candidates.length === 0) return { rows: 0, usd: 0 };
  const chargedOf = db.prepare(`
    SELECT id, cost_usd AS usd, ${TOKENS} AS tokens FROM usage_events
    WHERE model = ? AND cost_basis = 'provider-reported' AND ${TOKENS} > 0
    ORDER BY id
  `);
  const byModel = new Map<string, { charged: Charged[]; prefix: { usd: number[]; tokens: number[] } }>();
  const samplesFor = (model: string) => {
    let entry = byModel.get(model);
    if (!entry) {
      const charged = chargedOf.all(model) as Charged[];
      const prefix = { usd: [0], tokens: [0] };
      for (const c of charged) {
        prefix.usd.push(prefix.usd[prefix.usd.length - 1]! + c.usd);
        prefix.tokens.push(prefix.tokens[prefix.tokens.length - 1]! + c.tokens);
      }
      entry = { charged, prefix };
      byModel.set(model, entry);
    }
    return entry;
  };
  const update = db.prepare(`
    UPDATE usage_events SET cost_usd = ?, cost_basis = 'computed', pricing_json = ?
    WHERE id = ? AND cost_basis = 'unpriced'
  `);
  const at = now.toISOString();
  return db.transaction(() => {
    let rows = 0;
    let usd = 0;
    for (const c of candidates) {
      const { charged, prefix } = samplesFor(c.model);
      const rate = nearestRate(charged, prefix, c.id);
      if (rate === null) continue;
      const cost = (c.tokens * rate.usdPerMillionTokens) / 1_000_000;
      const changed = update.run(cost, estimatePricingJson(rate, { backfilled_at: at }), c.id).changes;
      rows += changed;
      if (changed > 0) usd += cost;
    }
    return { rows, usd };
  })();
}
