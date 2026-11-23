import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/issue-service-token.ts', import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(dbPath: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    env: { PATH: process.env.PATH, VAULT_PATH: join(dbPath, '..'), DB_PATH: dbPath },
    encoding: 'utf8',
  });
}

describe('scripts/issue-service-token.ts', () => {
  it('issues tokens, and --revoke revokes every token of that client only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-token-script-'));
    dirs.push(dir);
    const dbPath = join(dir, 'vault.db');
    for (const name of ['installer', 'installer', 'vault-curator']) {
      expect(run(dbPath, ['--name', name, '--ttl-days', '1']).stdout).toMatch(/Authorization: Bearer [0-9a-f]{64}/);
    }

    const revoked = run(dbPath, ['--name', 'installer', '--revoke']);
    const again = run(dbPath, ['--name', 'installer', '--revoke']);

    expect(revoked.status).toBe(0);
    expect(revoked.stdout).toContain('Revoked 2 tokens for client_id=service-installer');
    expect(revoked.stdout).not.toMatch(/Bearer/);
    expect(again.stdout).toContain('Revoked 0 tokens for client_id=service-installer');
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT client_id, revoked FROM oauth_tokens ORDER BY client_id').all()).toEqual([
        { client_id: 'service-installer', revoked: 1 },
        { client_id: 'service-installer', revoked: 1 },
        { client_id: 'service-vault-curator', revoked: 0 },
      ]);
    } finally {
      db.close();
    }
  }, 60_000);

  it('does not create a missing database to revoke from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-script-missing-'));
    dirs.push(dir);
    const dbPath = join(dir, 'missing.db');

    const result = run(dbPath, ['--name', 'installer', '--revoke']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`No database at ${dbPath}; nothing to revoke.`);
    expect(existsSync(dbPath)).toBe(false);
  }, 60_000);

  it('--revoke-sign-ins revokes every sign-in token and keeps service tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-token-script-sign-ins-'));
    dirs.push(dir);
    const dbPath = join(dir, 'vault.db');
    expect(run(dbPath, ['--name', 'installer', '--ttl-days', '1']).status).toBe(0);

    // Two chat clients that signed in, one of them with a token already revoked, and an
    // authorization code approved but not yet exchanged.
    const seed = new Database(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const token = seed.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, ?, ?, '', NULL, ?, ?, ?)
    `);
    token.run('hash-a-access', 'access', '3f8a5c2e-0000-4000-8000-000000000000', now, now + 3600, 0);
    token.run('hash-a-refresh', 'refresh', '3f8a5c2e-0000-4000-8000-000000000000', now, now + 86400, 0);
    token.run('hash-b-refresh', 'refresh', '7d1b9a40-0000-4000-8000-000000000000', now, now + 86400, 0);
    token.run('hash-b-old', 'refresh', '7d1b9a40-0000-4000-8000-000000000000', now, now + 86400, 1);
    seed.prepare(`
      INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
      VALUES ('pending-code', '7d1b9a40-0000-4000-8000-000000000000', 'https://chat.example/callback', 'challenge', '', NULL, NULL, ?, ?)
    `).run(now, now + 600);
    seed.close();

    const revoked = run(dbPath, ['--revoke-sign-ins']);
    const again = run(dbPath, ['--revoke-sign-ins']);

    expect(revoked.status).toBe(0);
    expect(revoked.stdout).toContain('Revoked 3 sign-in tokens of 2 clients and deleted 1 pending authorization code. Service tokens are unchanged.');
    expect(revoked.stdout).not.toMatch(/Bearer/);
    expect(again.stdout).toContain('Revoked 0 sign-in tokens of 0 clients and deleted 0 pending authorization codes.');
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT client_id, type, revoked FROM oauth_tokens ORDER BY client_id, token').all()).toEqual([
        { client_id: '3f8a5c2e-0000-4000-8000-000000000000', type: 'access', revoked: 1 },
        { client_id: '3f8a5c2e-0000-4000-8000-000000000000', type: 'refresh', revoked: 1 },
        { client_id: '7d1b9a40-0000-4000-8000-000000000000', type: 'refresh', revoked: 1 },
        { client_id: '7d1b9a40-0000-4000-8000-000000000000', type: 'refresh', revoked: 1 },
        { client_id: 'service-installer', type: 'access', revoked: 0 },
      ]);
      expect(db.prepare('SELECT COUNT(*) AS c FROM oauth_codes').get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  it('--revoke-sign-ins does not create a missing database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-script-missing-'));
    dirs.push(dir);
    const dbPath = join(dir, 'missing.db');

    const result = run(dbPath, ['--revoke-sign-ins']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`No database at ${dbPath}; nothing to revoke.`);
    expect(existsSync(dbPath)).toBe(false);
  }, 60_000);
});
