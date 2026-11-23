/**
 * #533: a rotated refresh token or an exchanged authorization code presented again signs
 * that client out, except within the leeway, where two racing requests are only refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { createAuthSchema } from '../src/auth/schema.js';
import { REUSE_LEEWAY_SECONDS, VaultOAuthProvider, hashToken } from '../src/auth/provider.js';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const db = new Database(':memory:');
  createAuthSchema(db);
  const provider = new VaultOAuthProvider(db, 'reuse-owner-password');
  const logged: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  });
  return { db, provider, logged };
}

function register(provider: VaultOAuthProvider): OAuthClientInformationFull {
  return provider.clientsStore.registerClient!({
    redirect_uris: ['https://client.example.com/cb'] as unknown as URL[],
    client_name: 'test-client',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  } as unknown as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) as OAuthClientInformationFull;
}

/** Approves a client with the owner password and returns its authorization code. */
async function approve(provider: VaultOAuthProvider, client: OAuthClientInformationFull): Promise<string> {
  let redirect = '';
  const res = {
    req: { body: { password: 'reuse-owner-password' } },
    locals: {},
    setHeader() { /* not needed here */ },
    type() { return res; },
    send() { /* not needed here */ },
    redirect(url: string) { redirect = url; },
  };
  await provider.authorize(client, {
    redirectUri: 'https://client.example.com/cb', codeChallenge: 'challenge', scopes: ['curate:read'],
  } as AuthorizationParams, res as unknown as import('express').Response);
  return new URL(redirect).searchParams.get('code')!;
}

async function signIn(provider: VaultOAuthProvider, client: OAuthClientInformationFull) {
  return provider.exchangeAuthorizationCode(client, await approve(provider, client));
}

const live = (provider: VaultOAuthProvider, accessToken: string) =>
  provider.verifyAccessToken(accessToken).then(() => true, () => false);
const pastLeeway = () => Math.floor(Date.now() / 1000) - REUSE_LEEWAY_SECONDS - 1;
const reuseLines = (logged: string[]) => logged.filter((line) => line.includes('presented again'));

describe('a rotated refresh token presented again', () => {
  it('is only refused within the leeway: two requests refreshing at once', async () => {
    const { provider, logged } = setup();
    const client = register(provider);
    const first = await signIn(provider, client);
    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!);

    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(/Invalid or expired refresh token/);

    expect(await live(provider, rotated.access_token)).toBe(true);
    await expect(provider.exchangeRefreshToken(client, rotated.refresh_token!)).resolves.toBeTruthy();
    expect(reuseLines(logged)).toEqual([]);
  });

  it('signs the client out after the leeway, and leaves other clients alone', async () => {
    const { db, provider, logged } = setup();
    const client = register(provider);
    const other = register(provider);
    const first = await signIn(provider, client);
    const bystander = await signIn(provider, other);
    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!);
    db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token = ?').run(pastLeeway(), hashToken(first.refresh_token!));

    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(/Invalid or expired refresh token/);

    // Whoever rotated the token, the thief or the client, is cut off with the rest.
    expect(await live(provider, rotated.access_token)).toBe(false);
    await expect(provider.exchangeRefreshToken(client, rotated.refresh_token!)).rejects.toThrow();
    expect(await live(provider, bystander.access_token)).toBe(true);
    await expect(provider.exchangeRefreshToken(other, bystander.refresh_token!)).resolves.toBeTruthy();
    // Three were live: the first access token, and the pair the rotation issued.
    expect(reuseLines(logged)).toEqual([
      expect.stringContaining(`refresh token presented again: revoked 3 tokens of client_id=${client.client_id}`),
    ]);
    expect(await live(provider, first.access_token)).toBe(false);
  });

  it('counts as reuse when the row was revoked before the time was recorded', async () => {
    const { db, provider } = setup();
    const client = register(provider);
    const first = await signIn(provider, client);
    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!);
    db.prepare('UPDATE oauth_tokens SET revoked_at = NULL WHERE token = ?').run(hashToken(first.refresh_token!));

    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow();
    expect(await live(provider, rotated.access_token)).toBe(false);
  });

  it('is only refused once it has also expired, however long ago it was rotated', async () => {
    const { db, provider, logged } = setup();
    const client = register(provider);
    const first = await signIn(provider, client);
    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!);
    db.prepare('UPDATE oauth_tokens SET revoked_at = ?, expires_at = ? WHERE token = ?')
      .run(pastLeeway(), Math.floor(Date.now() / 1000) - 1, hashToken(first.refresh_token!));

    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(/Invalid or expired refresh token/);

    expect(await live(provider, rotated.access_token)).toBe(true);
    expect(reuseLines(logged)).toEqual([]);
  });

  it('does not sign anyone out for an unknown token, an expired one, or another client\'s', async () => {
    const { db, provider, logged } = setup();
    const client = register(provider);
    const other = register(provider);
    const tokens = await signIn(provider, client);
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token = ?').run(pastLeeway(), hashToken(tokens.refresh_token!));

    await expect(provider.exchangeRefreshToken(client, 'f'.repeat(64))).rejects.toThrow();
    // Another client presenting this client's old token learns nothing and changes nothing.
    await expect(provider.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow();
    expect(await live(provider, rotated.access_token)).toBe(true);

    db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE token = ?').run(Math.floor(Date.now() / 1000) - 1, hashToken(rotated.refresh_token!));
    await expect(provider.exchangeRefreshToken(client, rotated.refresh_token!)).rejects.toThrow(/Invalid or expired refresh token/);
    expect(await live(provider, rotated.access_token)).toBe(true);
    expect(reuseLines(logged)).toEqual([]);
  });

  it('records when a token was revoked, on rotation and on an explicit revoke', async () => {
    const { db, provider } = setup();
    const client = register(provider);
    const tokens = await signIn(provider, client);
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    await provider.revokeToken!(client, { token: rotated.refresh_token! });

    const rows = db.prepare('SELECT revoked, revoked_at FROM oauth_tokens WHERE client_id = ? AND revoked = 1').all(client.client_id) as Array<{ revoked_at: number | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => typeof row.revoked_at === 'number')).toBe(true);
  });
});

describe('an authorization code exchanged again', () => {
  it('is only refused within the leeway: a retry after a lost response', async () => {
    const { provider, logged } = setup();
    const client = register(provider);
    const code = await approve(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // The code is still there for the PKCE check, which is what gates the second exchange.
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe('challenge');
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid or expired authorization code/);

    expect(await live(provider, tokens.access_token)).toBe(true);
    expect(reuseLines(logged)).toEqual([]);
  });

  it('signs the client out after the leeway', async () => {
    const { db, provider, logged } = setup();
    const client = register(provider);
    const code = await approve(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code = ?').run(pastLeeway(), code);

    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid or expired authorization code/);

    expect(await live(provider, tokens.access_token)).toBe(false);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
    expect(reuseLines(logged)).toEqual([
      expect.stringContaining(`authorization code presented again: revoked 2 tokens of client_id=${client.client_id}`),
    ]);
  });

  it('does not sign the client out when another client presents its used code', async () => {
    const { db, provider } = setup();
    const client = register(provider);
    const other = register(provider);
    const code = await approve(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code = ?').run(pastLeeway(), code);

    await expect(provider.exchangeAuthorizationCode(other, code)).rejects.toThrow(/different client/);
    expect(await live(provider, tokens.access_token)).toBe(true);
  });
});

describe('the columns', () => {
  it('are added once to tables that predate them, leaving existing rows as they were', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_id_issued_at INTEGER NOT NULL, client_secret TEXT, client_secret_expires_at INTEGER, metadata TEXT NOT NULL);
      CREATE TABLE oauth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '', resource TEXT, state TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, type TEXT NOT NULL, client_id TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '', resource TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      INSERT INTO oauth_tokens (token, type, client_id, created_at, expires_at, revoked) VALUES ('old-hash', 'refresh', 'service-curator', 1, 9999999999, 0);
    `);

    createAuthSchema(db);
    createAuthSchema(db);

    expect(db.prepare('SELECT token, revoked, revoked_at FROM oauth_tokens').all()).toEqual([{ token: 'old-hash', revoked: 0, revoked_at: null }]);
    expect((db.prepare('PRAGMA table_info(oauth_codes)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('used_at');
  });
});
