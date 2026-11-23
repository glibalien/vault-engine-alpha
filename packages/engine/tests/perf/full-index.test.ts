import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';

const PERF_VAULT = process.env.VAULT_PERF_PATH?.trim();

describe('performance', () => {
  it('indexes the real vault in under 60 seconds', async () => {
    if (!PERF_VAULT) {
      console.log('Skipping: set VAULT_PERF_PATH to run this performance test');
      return;
    }

    const vaultPath = resolve(PERF_VAULT);
    if (!existsSync(vaultPath)) {
      console.log('Skipping: VAULT_PERF_PATH not found at', vaultPath);
      return;
    }

    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const start = Date.now();
    fullIndex(vaultPath, db);
    const elapsed = Date.now() - start;

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    console.log(`Indexed ${count} nodes in ${elapsed}ms`);

    expect(elapsed).toBeLessThan(60_000);
    expect(count).toBeGreaterThan(0);
    db.close();
  });
});
