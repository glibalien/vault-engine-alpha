import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createHttpApp } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/connection.js';
import { createSchema } from '../src/db/schema.js';
import {
  addUndoTables,
  addNodeTypesSortOrder,
  addSchemaUndoSnapshots,
  addGlobalFieldUndoSnapshots,
  addUiHints,
  upgradeToMemories,
  upgradeToMemoriesV2,
  upgradeToMemoriesV3,
} from '../src/db/migrate.js';
import { createAuthSchema } from '../src/auth/schema.js';
import { hashToken, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '../src/auth/provider.js';

const OWNER_PASSWORD = 'audit-owner-password';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-auth-audit-'));
  db = openDatabase(join(tmpDir, '.vault-engine', 'vault.db'));
  createSchema(db);
  addUndoTables(db);
  createAuthSchema(db);
  // registerAllTools (invoked by createServer, which this audit test calls for
  // real via /mcp) always registers the memories tools, which eagerly
  // db.prepare() against memory_embedding_vec etc. at registration time — the
  // sibling transport-http-auth.test.ts never triggers serverFactory() (its one
  // /mcp call is unauthenticated and short-circuits at 401), so it never needed
  // these. Mirrors the full-server DB setup in tests/helpers/db.ts.
  addNodeTypesSortOrder(db);
  addSchemaUndoSnapshots(db);
  addGlobalFieldUndoSnapshots(db);
  addUiHints(db);
  upgradeToMemories(db);
  upgradeToMemoriesV2(db);
  upgradeToMemoriesV3(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp(): Express {
  return createHttpApp(() => createServer(db), {
    db,
    ownerPassword: OWNER_PASSWORD,
    issuerUrl: new URL('https://vault.example.test'),
  });
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(app: Express): Promise<string> {
  const res = await request(app).post('/register').send({
    redirect_uris: [CALLBACK],
    client_name: 'audit-probe',
    token_endpoint_auth_method: 'none',
  });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** POST the password form (all hidden fields the real form carries) and return the auth code. */
async function getAuthCode(
  app: Express,
  clientId: string,
  challenge: string,
  password: string,
): Promise<request.Response> {
  return request(app).post('/authorize').type('form').send({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    password,
  });
}

async function exchangeCode(
  app: Express,
  clientId: string,
  code: string,
  verifier: string,
): Promise<request.Response> {
  return request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CALLBACK,
  });
}

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'audit-probe', version: '0.0.1' },
  },
};

describe('OAuth audit: happy path (A3, A9)', () => {
  it('DCR -> form -> password -> PKCE exchange -> authed MCP access; tokens hashed at rest', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { verifier, challenge } = pkcePair();

    // Authorize form renders on GET (no password yet)
    const form = await request(app).get('/authorize').query({
      client_id: clientId,
      redirect_uri: CALLBACK,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(form.status).toBe(200);
    expect(form.text).toContain('name="password"');

    // Correct password -> 302 with code
    const authed = await getAuthCode(app, clientId, challenge, OWNER_PASSWORD);
    expect(authed.status).toBe(302);
    const code = new URL(authed.headers.location).searchParams.get('code');
    expect(code).toBeTruthy();

    // PKCE token exchange
    const tokens = await exchangeCode(app, clientId, code as string, verifier);
    expect(tokens.status).toBe(200);
    expect(tokens.body.access_token).toBeTruthy();
    expect(tokens.body.refresh_token).toBeTruthy();
    expect(tokens.body.expires_in).toBe(ACCESS_TOKEN_TTL);

    // A9: hashed at rest — cleartext never stored, rows are 64-char sha256 hex
    const stored = db.prepare('SELECT token, type, expires_at, created_at FROM oauth_tokens').all() as
      Array<{ token: string; type: string; expires_at: number; created_at: number }>;
    expect(stored.length).toBe(2);
    for (const row of stored) {
      expect(row.token).not.toBe(tokens.body.access_token);
      expect(row.token).not.toBe(tokens.body.refresh_token);
      expect(row.token).toMatch(/^[0-9a-f]{64}$/);
    }
    const access = stored.find((r) => r.type === 'access');
    const refresh = stored.find((r) => r.type === 'refresh');
    expect(access!.expires_at - access!.created_at).toBe(ACCESS_TOKEN_TTL);
    expect(refresh!.expires_at - refresh!.created_at).toBe(REFRESH_TOKEN_TTL);
    expect(db.prepare('SELECT token FROM oauth_tokens WHERE token = ?').get(hashToken(tokens.body.access_token))).toBeTruthy();

    // Authed MCP access works: initialize, then tools/list on the session
    const init = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE_BODY);
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    const list = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    expect(list.text).toContain('query-nodes');

    // Wrong password re-renders the form with an error, no redirect, no code
    const denied = await getAuthCode(app, clientId, challenge, 'not-the-password');
    expect(denied.status).toBe(200);
    expect(denied.text).toContain('Invalid password');
    expect(denied.headers.location).toBeUndefined();
  });
});

describe('OAuth audit: adversarial (A1, A3, A4, A5, A6, A7, A9)', () => {
  it('A1: 6th password POST inside the window is rate-limited with 429', async () => {
    const app = makeApp(); // fresh app = fresh limiter bucket
    const clientId = await registerClient(app);
    const { challenge } = pkcePair();
    for (let i = 0; i < 5; i++) {
      const res = await getAuthCode(app, clientId, challenge, 'wrong-password');
      expect(res.status).toBe(200); // form re-rendered with error
    }
    const sixth = await getAuthCode(app, clientId, challenge, 'wrong-password');
    expect(sixth.status).toBe(429);
    // and the limit also blocks a correct-password attempt in the same window
    const evenCorrect = await getAuthCode(app, clientId, challenge, OWNER_PASSWORD);
    expect(evenCorrect.status).toBe(429);
  });

  it('A3: non-code grant types are rejected at the token endpoint', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const res = await request(app).post('/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: clientId,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.access_token).toBeUndefined();
  });

  it('A3: token exchange with a wrong PKCE verifier fails', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { challenge } = pkcePair();
    const authed = await getAuthCode(app, clientId, challenge, OWNER_PASSWORD);
    const code = new URL(authed.headers.location).searchParams.get('code') as string;
    const res = await exchangeCode(app, clientId, code, randomBytes(32).toString('base64url'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.access_token).toBeUndefined();
  });

  it('A4: sessionless GET/HEAD /mcp leak no tool or vault data', async () => {
    const app = makeApp();
    const get = await request(app).get('/mcp').set('Accept', 'application/json, text/event-stream');
    // Adjusted from the brief's `>=400` assumption to observed behavior: the
    // conditional auth middleware in http.ts *intentionally* exempts
    // sessionless GET /mcp from bearerAuth ("skip HEAD and sessionless GET
    // (protocol discovery)") and the handler responds 200 with an empty body
    // (content-length 0) -- it never touches serverFactory/sessions. The
    // security property under audit is the no-data-leak checks below, which
    // still hold; the status-code assumption was simply wrong.
    expect(get.status).toBe(200);
    expect(get.text ?? '').toBe('');
    expect(get.text ?? '').not.toContain('query-nodes');
    const head = await request(app).head('/mcp');
    expect(head.text ?? '').toBe('');
  });

  it('A5: authorization-server metadata exposes endpoints only', async () => {
    const app = makeApp();
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.authorization_endpoint).toBeTruthy();
    expect(res.body.token_endpoint).toBeTruthy();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('/home/');
  });

  it('A6: a DCR-registered client with no token gets 401 and no data', async () => {
    const app = makeApp();
    await registerClient(app);
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE_BODY);
    expect(res.status).toBe(401);
    expect(res.text ?? '').not.toContain('query-nodes');
  });

  it('A7: /attachments and /llm/stream are bearer-gated', async () => {
    const app = makeApp();
    // makeApp() (Task 1 helper, reused verbatim, NOT modified here) omits the
    // AttachmentConfig, so createHttpApp never registers the /attachments
    // route at all on `app` -- a bare status assertion there would pass even
    // if bearerAuth were deleted from the route entirely, because the request
    // never reaches it (Express 404s on its own before any middleware runs).
    // To genuinely exercise the gate, mount a second app, local to this test,
    // with a real AttachmentConfig rooted in the test's tmpDir so the route
    // is actually registered and the request actually reaches bearerAuth.
    const attachApp = createHttpApp(() => createServer(db), {
      db,
      ownerPassword: OWNER_PASSWORD,
      issuerUrl: new URL('https://vault.example.test'),
    }, { vaultPath: tmpDir, dir: 'Attachments' });
    const att = await request(attachApp).get('/attachments/some-ref.png');
    // requireBearerAuth (mounted unconditionally ahead of the handler) throws
    // InvalidTokenError for a missing Authorization header, which resolves to
    // exactly this: 401 + a WWW-Authenticate header. Asserting both means the
    // probe fails specifically if the gate is weakened or removed -- a route
    // that fell back to "missing" (bare 404, no WWW-Authenticate) would fail
    // this assertion, not silently pass it.
    expect(att.status).toBe(401);
    expect(att.headers['www-authenticate']).toBeTruthy();
    const llm = await request(app).post('/llm/stream').send({ url: 'https://api.anthropic.com/v1/messages', headers: {}, body: {} });
    expect(llm.status).toBe(401);
  });

  it('A9: authorize with an unregistered redirect_uri is rejected, no code issued', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { challenge } = pkcePair();
    const res = await request(app).post('/authorize').type('form').send({
      client_id: clientId,
      redirect_uri: 'https://evil.example/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      password: OWNER_PASSWORD,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toMatchObject({ n: 0 });
  });

  it('A9: a revoked access token is rejected on /mcp', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { verifier, challenge } = pkcePair();
    const authed = await getAuthCode(app, clientId, challenge, OWNER_PASSWORD);
    const code = new URL(authed.headers.location).searchParams.get('code') as string;
    const tokens = await exchangeCode(app, clientId, code, verifier);
    db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token = ?').run(hashToken(tokens.body.access_token));
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE_BODY);
    expect(res.status).toBe(401);
  });

  it('A9: token exchange with a mismatched redirect_uri is rejected', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { verifier, challenge } = pkcePair();
    const authed = await getAuthCode(app, clientId, challenge, OWNER_PASSWORD);
    const code = new URL(authed.headers.location).searchParams.get('code') as string;
    const res = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: 'https://evil.example/cb',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.access_token).toBeUndefined();
  });
});

describe('OAuth audit: the approval page says where access goes', () => {
  /** Anyone can register a client under any name; only its redirect URI is beyond its control. */
  async function approvalPage(app: Express, registration: Record<string, unknown>): Promise<request.Response> {
    const registered = await request(app).post('/register').send({ token_endpoint_auth_method: 'none', ...registration });
    expect(registered.status).toBe(201);
    return request(app).get('/authorize').query({
      client_id: registered.body.client_id,
      response_type: 'code',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
    });
  }

  it('names the redirect host and marks the client name as unverified', async () => {
    const page = await approvalPage(makeApp(), { redirect_uris: ['https://elsewhere.example/cb'], client_name: 'Claude' });

    expect(page.status).toBe(200);
    expect(page.text).toContain('<strong>elsewhere.example</strong>');
    expect(page.text).toContain('<code>https://elsewhere.example/cb</code>');
    expect(page.text).toContain('The client calls itself &quot;Claude&quot;. Any client can register under any name');
    expect(page.text).toContain('It registered less than a minute ago.');
  });

  it('escapes what the client registered', async () => {
    const page = await approvalPage(makeApp(), {
      redirect_uris: ['https://elsewhere.example/cb?x=<b>'],
      client_name: '<script>alert(1)</script>',
    });

    expect(page.text).not.toContain('<script>');
    expect(page.text).not.toContain('<b>');
    expect(page.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('cannot be framed or cached, on the form and on a wrong password', async () => {
    const app = makeApp();
    const form = await approvalPage(app, { redirect_uris: [CALLBACK], client_name: 'audit-probe' });
    const clientId = await registerClient(app);
    const denied = await getAuthCode(app, clientId, pkcePair().challenge, 'not-the-password');

    for (const res of [form, denied]) {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('logs each grant with its destination, and nothing for a wrong password', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await getAuthCode(app, clientId, pkcePair().challenge, 'not-the-password');
      expect(lines.filter(line => line.includes('authorization granted'))).toEqual([]);

      const granted = await getAuthCode(app, clientId, pkcePair().challenge, OWNER_PASSWORD);
      expect(granted.status).toBe(302);
    } finally {
      process.stderr.write = original;
    }
    const grants = lines.filter(line => line.includes('authorization granted'));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('destination=claude.ai');
    expect(grants[0]).toContain('client_name="audit-probe"');
    expect(grants[0]).toContain(`client_id=${clientId}`);
  });
});
