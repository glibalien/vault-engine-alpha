import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';

describe('addUsageEvents', () => {
  it('creates the table + indexes and is idempotent', () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    addUsageEvents(db); // second run must be a no-op

    const cols = (db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual([
      'id', 'ts', 'provider', 'model', 'service', 'purpose',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
      'audio_seconds', 'cost_usd', 'cost_basis', 'pricing_json',
      'conversation_id', 'run_ref', 'source_ref', 'experiment', 'variant',
      'latency_ms', 'request_id', 'metadata_json', 'key_ref',
    ]);

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'",
    ).all() as Array<{ name: string }>).map((i) => i.name).sort();
    expect(indexes).toEqual([
      'idx_usage_events_conversation', 'idx_usage_events_experiment',
      'idx_usage_events_run_ref', 'idx_usage_events_ts',
    ]);
    db.close();
  });

  it('adds key_ref to a deployed ledger and keeps its rows (#345)', () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    db.exec('ALTER TABLE usage_events DROP COLUMN key_ref; ALTER TABLE provider_reconciliations DROP COLUMN key_ref');
    db.prepare(`INSERT INTO usage_events (ts, provider, service, purpose, cost_usd, cost_basis)
      VALUES ('2026-11-04T00:00:00.000Z', 'openrouter', 'curator', 'memory-sweep', 1, 'computed')`).run();

    addUsageEvents(db);

    expect(db.prepare('SELECT cost_usd, key_ref FROM usage_events').get()).toEqual({ cost_usd: 1, key_ref: null });
    const cols = (db.prepare('PRAGMA table_info(provider_reconciliations)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('key_ref');
    db.close();
  });
});
