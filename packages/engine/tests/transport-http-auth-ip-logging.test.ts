import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { addUndoTables } from '../src/db/migrate.js';
import { createAuthSchema } from '../src/auth/schema.js';

const OWNER_PASSWORD = 'ip-logging-owner-password';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let db: Database.Database;
let tmpDir: string;
let lines: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-ip-log-'));
  db = openDatabase(join(tmpDir, '.vault-engine', 'vault.db'));
  createSchema(db);
  addUndoTables(db);
  createAuthSchema(db);

  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

/** The single request-log line for a given method+path. */
function logLineFor(method: string, path: string): string {
  const match = lines.filter(line => line.includes(`[vault-engine] ${method} ${path} `));
  expect(match, `no log line for ${method} ${path} in:\n${lines.join('')}`).toHaveLength(1);
  return match[0];
}

async function registerClient(app: Express): Promise<string> {
  const res = await request(app).post('/register').send({
    redirect_uris: [CALLBACK],
    client_name: 'ip-log-probe',
    token_endpoint_auth_method: 'none',
  });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

function pkceChallenge(): string {
  return createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
}

function authorizeForm(app: Express, clientId: string, password: string) {
  return request(app).post('/authorize').type('form').send({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: 'code',
    code_challenge: pkceChallenge(),
    code_challenge_method: 'S256',
    password,
  });
}

describe('auth-failure IP logging', () => {
  it('logs the client IP when a bearer-protected route rejects the caller', async () => {
    const app = makeApp();

    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res.status).toBe(401);
    const line = logLineFor('POST', '/mcp');
    expect(line).toContain('auth-fail=unauthorized');
    expect(line).toMatch(/ip=\S+/);
  });

  it('logs the client IP when the owner password is wrong', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const res = await authorizeForm(app, clientId, 'not-the-owner-password');

    // A rejected password re-renders the form as 200 HTML, so status alone
    // cannot detect it — the provider must mark the response explicitly.
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invalid password');
    const line = logLineFor('POST', '/authorize');
    expect(line).toContain('auth-fail=invalid_password');
    expect(line).toMatch(/ip=\S+/);
  });

  it('prefers CF-Connecting-IP over the tunnel socket address', async () => {
    const app = makeApp();

    await request(app)
      .post('/mcp')
      .set('CF-Connecting-IP', '203.0.113.42')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(logLineFor('POST', '/mcp')).toContain('ip=203.0.113.42');
  });

  it('does not log an IP on a successful authorization', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const res = await authorizeForm(app, clientId, OWNER_PASSWORD);

    expect(res.status).toBe(302);
    const line = logLineFor('POST', '/authorize');
    expect(line).not.toContain('ip=');
    expect(line).not.toContain('auth-fail');
  });

  it('does not log an IP on unauthenticated discovery probes', async () => {
    const app = makeApp();

    const res = await request(app).get('/.well-known/oauth-protected-resource');

    expect(res.status).toBe(200);
    const line = logLineFor('GET', '/.well-known/oauth-protected-resource');
    expect(line).not.toContain('ip=');
  });

  it('does not log an IP on client registration', async () => {
    const app = makeApp();

    await registerClient(app);

    expect(logLineFor('POST', '/register')).not.toContain('ip=');
  });
});
