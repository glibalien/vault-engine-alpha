/**
 * #340: the Auto Router estimate backfill runs on a server start only. `--normalize` (live or
 * --dry-run) is a one-shot maintenance mode, and --dry-run promises no writes.
 */
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUsageEvents, ensureMetaTable } from '../../src/db/migrate.js';
import { MIN_CHARGED_SAMPLE } from '../../src/usage/provider-priced-estimate.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('--normalize --dry-run leaves an eligible uncharged Auto Router row unpriced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-estimate-startup-')); dirs.push(dir);
  const path = join(dir, 'vault.db');
  const db = new Database(path);
  createSchema(db); ensureMetaTable(db); addUsageEvents(db);
  const insert = db.prepare(`
    INSERT INTO usage_events (ts, provider, model, service, purpose, input_tokens, output_tokens, cost_usd, cost_basis)
    VALUES ('2026-10-01T00:00:00.000Z', 'openrouter', 'openrouter/auto', 'curator', 'wiki-synthesis', 900, 100, ?, ?)
  `);
  for (let i = 0; i < MIN_CHARGED_SAMPLE; i++) insert.run(0.002, 'provider-reported');
  const uncharged = Number(insert.run(0, 'unpriced').lastInsertRowid);
  db.close();

  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), path, '--normalize', '--dry-run'], {
    cwd: process.cwd(), env: { ...process.env, VAULT_PATH: dir, DOTENV_CONFIG_QUIET: 'true' }, encoding: 'utf8', timeout: 60_000,
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).not.toMatch(/estimated \d+ uncharged Auto Router/);
  const after = new Database(path, { readonly: true });
  expect(after.prepare('SELECT cost_usd, cost_basis, pricing_json FROM usage_events WHERE id = ?').get(uncharged))
    .toEqual({ cost_usd: 0, cost_basis: 'unpriced', pricing_json: null });
  after.close();
});
