import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { orgLedgerHash, upsertOrgLedger } from '../src/db/org-sweep.js';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d);
  return d;
}

describe('org_sweep_ledger', () => {
  it('migration #6 creates the table; unseen node has no hash', () => {
    const d = db();
    expect(d.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(6);
    expect(orgLedgerHash(d, 'n1')).toBeUndefined();
  });

  it('upsert stores and overwrites the hash for a node', () => {
    const d = db();
    upsertOrgLedger(d, 'n1', 'hash-a', '2026-07-10T00:00:00.000Z');
    expect(orgLedgerHash(d, 'n1')).toBe('hash-a');
    upsertOrgLedger(d, 'n1', 'hash-b', '2026-07-11T00:00:00.000Z');
    expect(orgLedgerHash(d, 'n1')).toBe('hash-b');
  });
});
