import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { backfillRuns } from '../../src/usage/backfill.js';

function curatorDbWithRuns(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project TEXT NOT NULL,
      "trigger" TEXT NOT NULL, dry_run INTEGER NOT NULL, outcome TEXT NOT NULL,
      evidence_hash TEXT, wiki_curated_at TEXT, home_written INTEGER NOT NULL,
      spine_written INTEGER NOT NULL, spine_total INTEGER NOT NULL,
      themed_created INTEGER NOT NULL, themed_retired INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      cost_usd REAL, duration_ms INTEGER NOT NULL, error TEXT
    )`);
  const ins = db.prepare(`
    INSERT INTO runs (ts, project, "trigger", dry_run, outcome, home_written, spine_written, spine_total,
      themed_created, themed_retired, input_tokens, output_tokens, cache_read, cache_write, cost_usd, duration_ms)
    VALUES (?, ?, 'scheduled', ?, 'written', 1, 0, 0, 0, 0, ?, ?, 0, 0, ?, 1000)`);
  ins.run('2026-06-20T05:00:00.000Z', 'Proj A', 0, 100_000, 10_000, 0.45);
  ins.run('2026-07-01T05:00:00.000Z', 'Proj A', 0, 200_000, 20_000, null); // deepseek era, unpriced at the time
  ins.run('2026-07-02T05:00:00.000Z', 'Proj B', 1, 1, 1, null);            // dry run — must be skipped
  return db;
}

const ERAS = [
  { since: '2026-01-01T00:00:00.000Z', provider: 'anthropic' as const, model: 'claude-sonnet-4-6' },
  { since: '2026-06-29T00:00:00.000Z', provider: 'fireworks' as const, model: 'accounts/fireworks/models/deepseek-v4-pro' },
];

describe('backfillRuns', () => {
  it('copies real runs with recomputed costs per era, skipping dry runs', () => {
    const curator = curatorDbWithRuns();
    const engine = new Database(':memory:');
    addUsageEvents(engine);

    const stats = backfillRuns(curator, engine, ERAS);
    expect(stats).toEqual({ inserted: 2, skipped: 0, unpriced: 0 });

    const rows = engine.prepare('SELECT * FROM usage_events ORDER BY ts').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // Anthropic-era run: (100k*3 + 10k*15)/1M = 0.45
    expect(rows[0]).toMatchObject({
      provider: 'anthropic', model: 'claude-sonnet-4-6', service: 'curator', purpose: 'wiki-synthesis',
      run_ref: 'curator-run-1', source_ref: 'Proj A', cost_basis: 'computed', latency_ms: 1000,
    });
    expect(rows[0]!.cost_usd).toBeCloseTo(0.45, 10);
    // Deepseek-era run recomputed: (200k*1.74 + 20k*3.48)/1M = 0.4176
    expect(rows[1]).toMatchObject({ provider: 'fireworks', run_ref: 'curator-run-2', cost_basis: 'computed' });
    expect(rows[1]!.cost_usd).toBeCloseTo(0.4176, 10);
    expect(JSON.parse(rows[1]!.metadata_json as string)).toMatchObject({ backfill: true, granularity: 'run' });
  });

  it('is idempotent — a second pass inserts nothing', () => {
    const curator = curatorDbWithRuns();
    const engine = new Database(':memory:');
    addUsageEvents(engine);
    backfillRuns(curator, engine, ERAS);
    const again = backfillRuns(curator, engine, ERAS);
    expect(again).toEqual({ inserted: 0, skipped: 2, unpriced: 0 });
    expect((engine.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n).toBe(2);
  });

  it('throws when a run predates the first era', () => {
    const curator = curatorDbWithRuns();
    const engine = new Database(':memory:');
    addUsageEvents(engine);
    expect(() => backfillRuns(curator, engine, [ERAS[1]!])).toThrow(/predates/);
  });

  it('unpriced rows (unknown model) always record cost 0, never the historical run cost', () => {
    const curator = curatorDbWithRuns(); // includes a row with cost_usd 0.45
    const engine = new Database(':memory:');
    addUsageEvents(engine);

    const unknownEra = [{ since: '2026-01-01T00:00:00.000Z', provider: 'anthropic' as const, model: 'not-a-real-model' }];
    const stats = backfillRuns(curator, engine, unknownEra);
    expect(stats.unpriced).toBe(2); // all 2 non-dry-run rows land on the unknown-model era

    const rows = engine.prepare('SELECT * FROM usage_events ORDER BY ts').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.cost_usd).toBe(0);
      expect(row.cost_basis).toBe('unpriced');
      expect(row.pricing_json).toBeNull();
    }
    // The first run had a historical cost_usd of 0.45 — preserved in metadata, not the cost column.
    const meta0 = JSON.parse(rows[0]!.metadata_json as string);
    expect(meta0.recorded_cost_usd).toBe(0.45);
    // The second run had a historical cost_usd of null — no recorded_cost_usd key at all.
    const meta1 = JSON.parse(rows[1]!.metadata_json as string);
    expect(meta1.recorded_cost_usd).toBeUndefined();
  });
});
