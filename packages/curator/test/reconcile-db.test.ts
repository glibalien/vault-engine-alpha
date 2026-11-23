import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { ledgerVerdict, upsertVerdict, orderPair } from '../src/db/reconcile.js';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d);
  return d;
}

describe('reconcile_ledger (migration #8)', () => {
  it('migration creates the table and bumps user_version to at least 8', () => {
    const d = db();
    expect(d.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(8);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reconcile_ledger'").get()).toBeTruthy();
  });

  it('orderPair normalizes; verdicts round-trip regardless of argument order', () => {
    expect(orderPair(9, 3)).toEqual([3, 9]);
    const d = db();
    upsertVerdict(d, { idA: 9, idB: 3, updatedAtA: 'tb', updatedAtB: 'ta', verdict: 'distinct', adjudicatedAt: 'now' });
    // stored under (3,9) with the updated_ats swapped to match
    expect(ledgerVerdict(d, 3, 9)).toEqual({ verdict: 'distinct', updated_at_a: 'ta', updated_at_b: 'tb' });
    expect(ledgerVerdict(d, 9, 3)).toEqual({ verdict: 'distinct', updated_at_a: 'ta', updated_at_b: 'tb' });
  });

  it('upsert replaces the prior verdict for the same pair', () => {
    const d = db();
    upsertVerdict(d, { idA: 1, idB: 2, updatedAtA: 't1', updatedAtB: 't2', verdict: 'distinct', adjudicatedAt: 'x' });
    upsertVerdict(d, { idA: 1, idB: 2, updatedAtA: 't1b', updatedAtB: 't2b', verdict: 'duplicate', adjudicatedAt: 'y' });
    expect(ledgerVerdict(d, 1, 2)).toEqual({ verdict: 'duplicate', updated_at_a: 't1b', updated_at_b: 't2b' });
  });

  it('unknown pair returns undefined', () => {
    expect(ledgerVerdict(db(), 7, 8)).toBeUndefined();
  });
});
