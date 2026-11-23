import type Database from 'better-sqlite3';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { SqliteClientsStore } from './store.js';
import { markAuthFailure } from '../transport/auth-log.js';

export const ACCESS_TOKEN_TTL = 3600;       // 1 hour
export const REFRESH_TOKEN_TTL = 2592000;   // 30 days
const AUTH_CODE_TTL = 600;                  // 10 minutes
/**
 * A rotated refresh token or an exchanged authorization code presented again is the
 * standard sign that a copy was stolen, and the answer is to sign that client out. Two
 * requests racing (two tabs refreshing at once, a retry after a lost response) present
 * the same value moments apart, so within this long of the first use a repeat is only refused.
 */
export const REUSE_LEEWAY_SECONDS = 60;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifyPassword(input: string, expected: string): boolean {
  const inputHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strips control characters and caps the length, for text that reaches the log. */
function logSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
}

/**
 * Where an approval sends access. The redirect URI is the one fact on the page the
 * client cannot dress up: anyone can register a client under any name, but the
 * authorization code only ever goes to a registered redirect URI.
 */
export function describeDestination(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return redirectUri;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `an app registered for ${url.protocol}// links`;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return loopback ? `an app on this computer (${url.host})` : url.host;
}

/** "3 minutes ago" for a registration time in epoch seconds; undefined when unknown. */
export function describeAge(issuedAt: number | undefined, nowSeconds: number): string | undefined {
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return undefined;
  const seconds = Math.max(0, nowSeconds - issuedAt);
  if (seconds < 60) return 'less than a minute ago';
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return plural(Math.floor(seconds / 3600), 'hour');
  return plural(Math.floor(seconds / 86400), 'day');
}

function renderAuthForm(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  error?: string,
): string {
  const scope = params.scopes?.join(' ') ?? '';
  const registered = describeAge(client.client_id_issued_at, Math.floor(Date.now() / 1000));
  return `<!DOCTYPE html>
<html>
<head><title>Authorize - vault-engine</title></head>
<body>
  <h1>Authorize</h1>
  <p>Approving gives every tool on this vault, read and write, to: <strong>${escapeHtml(describeDestination(params.redirectUri))}</strong></p>
  <p>Your browser will be sent to <code>${escapeHtml(params.redirectUri)}</code>. Approve only a connection you started yourself.</p>
  <p>${client.client_name
    ? `The client calls itself &quot;${escapeHtml(client.client_name)}&quot;. Any client can register under any name, so the name proves nothing.`
    : 'The client gave no name.'}${registered ? ` It registered ${escapeHtml(registered)}.` : ''} Client ID: ${escapeHtml(client.client_id)}</p>
  ${error ? `<p style="color:red">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="response_type" value="code">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="S256">
    ${params.state ? `<input type="hidden" name="state" value="${escapeHtml(params.state)}">` : ''}
    ${scope ? `<input type="hidden" name="scope" value="${escapeHtml(scope)}">` : ''}
    ${params.resource ? `<input type="hidden" name="resource" value="${escapeHtml(params.resource.toString())}">` : ''}
    <label>Password: <input type="password" name="password" required autofocus></label>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}

// Row type interfaces used by later tasks
interface CodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  state: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

interface TokenRow {
  token: string;
  type: string;
  client_id: string;
  scopes: string;
  resource: string | null;
  created_at: number;
  expires_at: number;
  revoked: number;
  revoked_at: number | null;
}

export class VaultOAuthProvider implements OAuthServerProvider {
  private readonly store: SqliteClientsStore;

  constructor(
    private readonly db: Database.Database,
    private readonly ownerPassword: string,
  ) {
    this.store = new SqliteClientsStore(db);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.store;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const password = (res.req as { body?: Record<string, string> })?.body?.password;

    // The page asks for the owner password, so it must never render inside another
    // site's frame, and no cache should keep it.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');

    if (!password) {
      res.type('html').send(renderAuthForm(client, params));
      return;
    }

    if (!verifyPassword(password, this.ownerPassword)) {
      // Re-rendering the form is a 200, so the request log can't tell this apart
      // from a first visit by status alone — mark it so the caller's IP is recorded.
      markAuthFailure(res, 'invalid_password');
      res.type('html').send(renderAuthForm(client, params, 'Invalid password'));
      return;
    }

    const code = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      params.scopes?.join(' ') ?? '',
      params.resource?.toString() ?? null,
      params.state ?? null,
      now,
      now + AUTH_CODE_TTL,
    );

    // A grant is the one event worth a line of its own: it says who now holds access.
    process.stderr.write(
      `[vault-engine] authorization granted: destination=${logSafe(describeDestination(params.redirectUri))} `
      + `client_name=${JSON.stringify(logSafe(client.client_name ?? ''))} client_id=${logSafe(client.client_id)}\n`,
    );

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT code_challenge FROM oauth_codes WHERE code = ? AND client_id = ? AND expires_at > ?',
    ).get(authorizationCode, client.client_id, now) as { code_challenge: string } | undefined;

    if (!row) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT * FROM oauth_codes WHERE code = ? AND expires_at > ?',
    ).get(authorizationCode, now) as CodeRow | undefined;

    if (!row) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (row.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri && row.redirect_uri !== redirectUri) {
      throw new InvalidGrantError('Redirect URI mismatch');
    }
    // A caller only gets here with the code's PKCE verifier, so a second exchange is the
    // client retrying or someone who holds everything the client held.
    if (row.used_at !== null) {
      this.signOutOnReuse(row.client_id, row.used_at, now, 'authorization code');
      throw new InvalidGrantError('Invalid or expired authorization code');
    }

    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const scopes = row.scopes;
    const tokenResource = resource?.toString() ?? row.resource;

    const exchangeTransaction = this.db.transaction(() => {
      // Single-use. The row stays until it expires so a second exchange can be recognized.
      const marked = this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code = ? AND used_at IS NULL')
        .run(now, authorizationCode);
      if (marked.changes !== 1) throw new InvalidGrantError('Invalid or expired authorization code');

      // Generate tokens
      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'access', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(accessToken), client.client_id, scopes, tokenResource, now, now + ACCESS_TOKEN_TTL);

      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'refresh', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(refreshToken), client.client_id, scopes, tokenResource, now, now + REFRESH_TOKEN_TTL);
    });
    exchangeTransaction();

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE token = ? AND type = \'refresh\'',
    ).get(tokenHash) as TokenRow | undefined;

    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    // Expiry first: a token past its lifetime is refused and nothing else, rotated or not.
    if (row.expires_at <= now) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (row.revoked !== 0) {
      this.signOutOnReuse(row.client_id, row.revoked_at, now, 'refresh token');
      throw new InvalidGrantError('Invalid or expired refresh token');
    }

    const newAccessToken = randomBytes(32).toString('hex');
    const newRefreshToken = randomBytes(32).toString('hex');
    const tokenResource = resource?.toString() ?? row.resource;

    const refreshTransaction = this.db.transaction(() => {
      // Revoke old refresh token
      this.db.prepare('UPDATE oauth_tokens SET revoked = 1, revoked_at = ? WHERE token = ?').run(now, tokenHash);

      // Generate new tokens
      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'access', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(newAccessToken), client.client_id, row.scopes, tokenResource, now, now + ACCESS_TOKEN_TTL);

      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'refresh', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(newRefreshToken), client.client_id, row.scopes, tokenResource, now, now + REFRESH_TOKEN_TTL);
    });
    refreshTransaction();

    return {
      access_token: newAccessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: newRefreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE token = ? AND type = \'access\' AND revoked = 0 AND expires_at > ?',
    ).get(tokenHash, now) as TokenRow | undefined;

    if (!row) {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(' ').filter(Boolean) : [],
      expiresAt: row.expires_at,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);

    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE token = ?',
    ).get(tokenHash) as TokenRow | undefined;

    if (!row || row.client_id !== client.client_id) return;

    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1, revoked_at = ? WHERE token = ? AND revoked = 0').run(now, tokenHash);

    // Cascade: revoking a refresh token also revokes all access tokens for the client
    if (row.type === 'refresh') {
      this.db.prepare(
        'UPDATE oauth_tokens SET revoked = 1, revoked_at = ? WHERE client_id = ? AND type = \'access\' AND revoked = 0',
      ).run(now, client.client_id);
    }
  }

  /**
   * A single-use value was presented a second time. Past the leeway that is treated as
   * theft: every live token of the client is revoked, so whoever holds a copy is cut off
   * and the client signs in again. `firstUsedAt` is null for a row revoked before the time
   * was recorded, or by a script, which is never a race.
   */
  private signOutOnReuse(clientId: string, firstUsedAt: number | null, now: number, what: string): void {
    if (firstUsedAt !== null && now - firstUsedAt <= REUSE_LEEWAY_SECONDS) return;
    const revoked = this.db.prepare(
      'UPDATE oauth_tokens SET revoked = 1, revoked_at = ? WHERE client_id = ? AND revoked = 0',
    ).run(now, clientId).changes;
    process.stderr.write(
      `[vault-engine] ${what} presented again: revoked ${revoked} token${revoked === 1 ? '' : 's'} of `
      + `client_id=${logSafe(clientId)}, which has to sign in again\n`,
    );
  }
}
