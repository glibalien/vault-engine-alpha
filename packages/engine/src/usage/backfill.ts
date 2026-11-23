import type Database from 'better-sqlite3';
import { estimateCostUsd, pricingFor } from '@vault/pricing';

export interface BackfillEra {
  /** ISO timestamp this era starts at (inclusive). Eras must cover every run. */
  since: string;
  provider: 'anthropic' | 'fireworks';
  model: string;
}

export interface BackfillStats {
  inserted: number;
  skipped: number;
  unpriced: number;
}

interface RunRow {
  id: number;
  ts: string;
  project: string;
  trigger: string;
  outcome: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  duration_ms: number;
}

/**
 * One-time curator-runs → usage_events backfill. Historical runs carry no
 * model column, so the caller supplies eras (time ranges → provider/model,
 * from the known prod model history); costs are recomputed from tokens ×
 * @vault/pricing — which fixes the null-cost deepseek-v4-pro era. Idempotent:
 * rows are keyed run_ref='curator-run-<id>' and skipped when present.
 * Backfilled rows are per-RUN (not per-call), flagged in metadata_json.
 */
export function backfillRuns(
  curatorDb: Database.Database,
  engineDb: Database.Database,
  eras: BackfillEra[],
): BackfillStats {
  // Compare via Date.parse, not raw string ordering: CLI-supplied era strings
  // are typically second-precision while run timestamps carry milliseconds,
  // and lexical comparison of ISO strings with mismatched precision/format
  // (e.g. no trailing Z) can misorder them even though they're both valid ISO
  // 8601. Numeric epoch comparison is precision-agnostic.
  const sorted = [...eras].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const eraFor = (ts: string): BackfillEra => {
    const tsMs = Date.parse(ts);
    let match: BackfillEra | undefined;
    for (const era of sorted) {
      if (Date.parse(era.since) <= tsMs) match = era;
    }
    if (!match) throw new Error(`run at ${ts} predates the first era (${sorted[0]?.since ?? 'none'})`);
    return match;
  };

  const runs = curatorDb.prepare(
    'SELECT id, ts, project, "trigger", outcome, input_tokens, output_tokens, cache_read, cache_write, cost_usd, duration_ms FROM runs WHERE dry_run = 0 ORDER BY id',
  ).all() as RunRow[];

  const exists = engineDb.prepare('SELECT 1 FROM usage_events WHERE run_ref = ?');
  const insert = engineDb.prepare(`
    INSERT INTO usage_events (
      ts, provider, model, service, purpose,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, cost_basis, pricing_json, run_ref, source_ref, latency_ms, metadata_json
    ) VALUES (?, ?, ?, 'curator', 'wiki-synthesis', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stats: BackfillStats = { inserted: 0, skipped: 0, unpriced: 0 };
  for (const run of runs) {
    const ref = `curator-run-${run.id}`;
    if (exists.get(ref)) {
      stats.skipped += 1;
      continue;
    }
    const era = eraFor(run.ts);
    const cost = estimateCostUsd(era.model, {
      input: run.input_tokens, output: run.output_tokens,
      cacheWrite: run.cache_write, cacheRead: run.cache_read,
    });
    const priced = cost !== null;
    if (!priced) stats.unpriced += 1;
    // Unpriced rows always record cost 0 (spec: "unpriced records raw units
    // with cost 0" — totals must undercount, never overcount, on unknown
    // models). The historical recorded cost is not discarded — it survives in
    // metadata_json so no information is lost.
    const metadata: Record<string, unknown> = {
      backfill: true, granularity: 'run', trigger: run.trigger, outcome: run.outcome,
    };
    if (!priced && run.cost_usd !== null) metadata.recorded_cost_usd = run.cost_usd;
    insert.run(
      run.ts, era.provider, era.model,
      run.input_tokens, run.output_tokens, run.cache_read, run.cache_write,
      priced ? cost : 0,
      priced ? 'computed' : 'unpriced',
      priced ? JSON.stringify(pricingFor(era.model)) : null,
      ref, run.project, run.duration_ms,
      JSON.stringify(metadata),
    );
    stats.inserted += 1;
  }
  return stats;
}
