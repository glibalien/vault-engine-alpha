import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthSchema } from '../src/auth/schema.js';
import { VaultOAuthProvider, hashToken } from '../src/auth/provider.js';
import { DEFAULT_SCOPES } from '../src/auth/scopes.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  createAuthSchema(db);
  return db;
}

async function registerClient(db: Database.Database): Promise<OAuthClientInformationFull> {
  const provider = new VaultOAuthProvider(db, 'owner-pw');
  return provider.clientsStore.registerClient!({
    redirect_uris: ['https://client.example.com/cb'] as unknown as URL[],
    client_name: 'test-client',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  } as unknown as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>);
}

// Minimal express Response stand-in capturing the redirect / rendered HTML.
function mockRes(password?: string) {
  const captured: { redirect?: string; html?: string; headers: Record<string, string>; locals: Record<string, unknown> } = { headers: {}, locals: {} };
  const res = {
    req: { body: password ? { password } : {} },
    locals: captured.locals,
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; },
    type() { return res; },
    send(html: string) { captured.html = html; },
    redirect(url: string) { captured.redirect = url; },
  };
  return { res: res as unknown as import('express').Response, captured };
}

describe('hashToken', () => {
  it('is deterministic SHA-256 hex', () => {
    const h = hashToken('abc');
    expect(h).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(h);
  });
});

describe('VaultOAuthProvider authorize', () => {
  it('renders the form (no redirect) when no password is posted', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const { res, captured } = mockRes();
    const params: AuthorizationParams = {
      redirectUri: 'https://client.example.com/cb',
      codeChallenge: 'challenge123',
      scopes: ['curate:read'],
    } as AuthorizationParams;
    await provider.authorize(client, params, res);
    expect(captured.redirect).toBeUndefined();
    expect(captured.html).toContain('Authorize - vault-curator');
    // Where access goes, and that the client's own name proves nothing.
    expect(captured.html).toContain('<strong>client.example.com</strong>');
    expect(captured.html).toContain('<code>https://client.example.com/cb</code>');
    expect(captured.html).toContain('The client calls itself &quot;test-client&quot;. Any client can register under any name');
    // Never inside another site's frame, never cached.
    expect(captured.headers).toMatchObject({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    });
  });

  it('rejects a wrong password (re-renders form with error, no code)', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const { res, captured } = mockRes('wrong');
    const params: AuthorizationParams = {
      redirectUri: 'https://client.example.com/cb',
      codeChallenge: 'challenge123',
    } as AuthorizationParams;
    await provider.authorize(client, params, res);
    expect(captured.redirect).toBeUndefined();
    expect(captured.html).toContain('Invalid password');
    // Marked, so the request log records the caller's address for this 200.
    expect(captured.locals).toEqual({ authFailure: 'invalid_password' });
    expect(db.prepare('SELECT COUNT(*) c FROM oauth_codes').get()).toEqual({ c: 0 });
  });

  it('issues a code on the correct password and exchanges it for tokens (PKCE round-trip)', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const { res, captured } = mockRes('owner-pw');
    const params: AuthorizationParams = {
      redirectUri: 'https://client.example.com/cb',
      codeChallenge: 'pkce-challenge',
      scopes: ['curate:trigger', 'curate:read'],
      state: 'xyz',
    } as AuthorizationParams;
    await provider.authorize(client, params, res);

    expect(captured.redirect).toBeDefined();
    const url = new URL(captured.redirect!);
    const code = url.searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('xyz');

    const challenge = await provider.challengeForAuthorizationCode(client, code);
    expect(challenge).toBe('pkce-challenge');

    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^[0-9a-f]{64}$/);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.scopes).toEqual(['curate:trigger', 'curate:read']);
    expect(info.clientId).toBe(client.client_id);

    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });

  it('grants DEFAULT_SCOPES when the client requests no scopes', async () => {
    // Clients like the claude.ai connector perform OAuth without requesting a
    // `scope` param. The password-gated owner approval should still mint the
    // curator's default scopes, otherwise the token is scopeless and every
    // withScope()-guarded tool (e.g. curate-project-wiki) returns FORBIDDEN.
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const { res, captured } = mockRes('owner-pw');
    await provider.authorize(client, {
      redirectUri: 'https://client.example.com/cb',
      codeChallenge: 'c',
      // no `scopes` — mirrors the claude.ai connector
    } as AuthorizationParams, res);
    const code = new URL(captured.redirect!).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.scopes).toEqual([...DEFAULT_SCOPES]);
  });
});

describe('VaultOAuthProvider refresh + revoke + verify', () => {
  it('rotates refresh tokens (old refresh revoked, new pair issued)', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const { res, captured } = mockRes('owner-pw');
    await provider.authorize(client, {
      redirectUri: 'https://client.example.com/cb',
      codeChallenge: 'c',
      scopes: ['curate:read'],
    } as AuthorizationParams, res);
    const code = new URL(captured.redirect!).searchParams.get('code')!;
    const first = await provider.exchangeAuthorizationCode(client, code);

    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!);
    expect(rotated.access_token).not.toBe(first.access_token);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);

    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow();
    const info = await provider.verifyAccessToken(rotated.access_token);
    expect(info.scopes).toEqual(['curate:read']);
  });

  it('revoking a refresh token cascades to the client access tokens', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const { res, captured } = mockRes('owner-pw');
    await provider.authorize(client, {
      redirectUri: 'https://client.example.com/cb',
      codeChallenge: 'c',
    } as AuthorizationParams, res);
    const code = new URL(captured.redirect!).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();

    await provider.revokeToken!(client, { token: tokens.refresh_token! });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it('rejects an invalid access token', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    await expect(provider.verifyAccessToken('deadbeef')).rejects.toThrow();
  });

  it('rejects an expired access token', async () => {
    const db = freshDb();
    const provider = new VaultOAuthProvider(db, 'owner-pw');
    const client = await registerClient(db);
    const raw = randomUUID();
    const past = Math.floor(Date.now() / 1000) - 10;
    db.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, 'access', ?, '', NULL, ?, ?, 0)
    `).run(hashToken(raw), client.client_id, past - 3600, past);
    await expect(provider.verifyAccessToken(raw)).rejects.toThrow();
  });
});
