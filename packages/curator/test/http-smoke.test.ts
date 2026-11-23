import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { openCuratorDb } from '../src/db/connection.js';
import { createAuthSchema } from '../src/auth/schema.js';
import { runMigrations } from '../src/db/migrate.js';
import { hashToken } from '../src/auth/provider.js';
import { createHttpApp, type HttpAppOptions } from '../src/transport/http.js';
import { buildAuthConfig, stubServerFactory } from '../src/server-bootstrap.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'curator-smoke-'));
  const dbPath = join(dir, 'curator.db');
  db = openCuratorDb(dbPath);
  createAuthSchema(db);
  runMigrations(db);

  const issuerUrl = new URL('http://127.0.0.1:3335');
  const app = createHttpApp(stubServerFactory(), buildAuthConfig(db, 'owner-pw', issuerUrl));

  await new Promise<void>((resolveListen) => {
    httpServer = createNodeHttpServer(app);
    httpServer.listen(0, '127.0.0.1', () => resolveListen());
  });
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => httpServer.close(() => res()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('curator HTTP transport (stub server)', () => {
  it('serves protected-resource metadata at the legacy root endpoint', async () => {
    const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body['authorization_servers']).toContain('http://127.0.0.1:3335/');
  });

  it('serves the path-specific protected-resource metadata for /mcp', async () => {
    const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
  });

  it('401s a bearerless /mcp POST with a WWW-Authenticate header', async () => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBeTruthy();
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('accepts a minted bearer token and calls the stub ping tool', async () => {
    const secret = randomBytes(32).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO oauth_clients (client_id, client_id_issued_at, client_secret, client_secret_expires_at, metadata)
      VALUES ('service-smoke', ?, NULL, NULL, ?)
      ON CONFLICT(client_id) DO NOTHING
    `).run(now, JSON.stringify({ client_id: 'service-smoke', client_name: 'smoke' }));
    db.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, 'access', 'service-smoke', 'curate:trigger curate:read', NULL, ?, ?, 0)
    `).run(hashToken(secret), now, now + 3600);

    const client = new Client({ name: 'smoke-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('ping');

      const result = await client.callTool({ name: 'ping', arguments: {} });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.find((c) => c.type === 'text')?.text).toBe('pong');
    } finally {
      await transport.close();
    }
  });
});

describe('curator HTTP transport: what a caller without a token, or with another client\'s session, can do', () => {
  function tokenFor(clientId: string): string {
    const secret = randomBytes(32).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, 'access', ?, 'curate:trigger curate:read', NULL, ?, ?, 0)
    `).run(hashToken(secret), clientId, now, now + 3600);
    return secret;
  }

  /** Runs `act` and returns what it wrote to the request log. */
  async function logged(act: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await act(); } finally { process.stderr.write = original; }
    return lines.join('').split('\n').filter(Boolean);
  }

  const mcp = (token: string, body: unknown, sessionId?: string, method = 'POST') => fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  };

  it('logs a wrong owner password with its path, reason and address', async () => {
    const registered = await fetch(`${baseUrl}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example.com/cb'], client_name: 'smoke', token_endpoint_auth_method: 'none' }),
    });
    const { client_id: clientId } = await registered.json() as { client_id: string };
    const lines = await logged(async () => {
      const res = await fetch(`${baseUrl}/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, redirect_uri: 'https://client.example.com/cb', response_type: 'code',
          code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', password: 'not-the-password',
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Invalid password');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[vault-curator\] POST \/authorize 200 \d+ms auth-fail=invalid_password ip=\S+$/);
  });

  it('logs a rejected /mcp request under its own path', async () => {
    const lines = await logged(() => fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[vault-curator\] POST \/mcp MCP tools\/list 401 \d+ms auth-fail=unauthorized ip=\S+$/);
  });

  it('writes only name characters from a method name into the log', async () => {
    const token = tokenFor('service-log');
    const lines = await logged(() => mcp(token, { jsonrpc: '2.0', id: 1, method: 'x 200 1ms\n[vault-curator] POST /authorize 302 3ms' }));
    const requests = lines.filter(line => line.startsWith('[vault-curator] POST'));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('POST /mcp MCP x?200?1ms??vault-curator??POST?/authorize?302?3ms');
  });

  it('keeps a session to the client that opened it', async () => {
    const owner = tokenFor('service-one');
    const other = tokenFor('service-two');
    const opened = await mcp(owner, initialize);
    expect(opened.status).toBe(200);
    const sessionId = opened.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();
    const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

    expect((await mcp(other, listTools, sessionId)).status).toBe(404);
    expect((await mcp(other, undefined, sessionId, 'DELETE')).status).toBe(404);
    expect((await mcp(owner, listTools, sessionId)).status).toBe(200);
    expect((await mcp(owner, undefined, sessionId, 'DELETE')).status).toBe(200);
  });

  it('answers malformed JSON with a status and no stack trace', async () => {
    const res = await fetch(`${baseUrl}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Bad request' });
    expect(text).not.toMatch(/node_modules|\.js:\d+|\bat /);
  });

  it('refuses registration metadata larger than a client could need', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number };
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example.com/cb'], client_name: 'n'.repeat(20_000), token_endpoint_auth_method: 'none' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_client_metadata');
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual(before);
  });
});

describe('curator HTTP transport: unused sessions and HEAD', () => {
  const HOUR = 60 * 60 * 1000;
  const SWEEP = 5 * 60 * 1000;
  const issuerUrl = new URL('http://127.0.0.1:3335');
  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  };
  const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  let clock: number;
  let token: string;
  let servers: Server[];

  beforeEach(() => {
    clock = 1_000_000;
    servers = [];
    const now = Math.floor(Date.now() / 1000);
    token = randomBytes(32).toString('hex');
    db.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, 'access', 'service-idle', 'curate:trigger curate:read', NULL, ?, ?, 0)
    `).run(hashToken(token), now, now + 3600);
    // Only the sweep's timer is faked; requests run on real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  /** A server over its own app, with the test clock. Returns its base URL. */
  async function start(options: HttpAppOptions = {}): Promise<string> {
    const server = createNodeHttpServer(createHttpApp(stubServerFactory(), buildAuthConfig(db, 'owner-pw', issuerUrl), { now: () => clock, ...options }));
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (base: string, body: unknown, sessionId?: string) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  async function open(base: string): Promise<string> {
    const res = await post(base, initialize);
    expect(res.status).toBe(200);
    await res.text();
    return res.headers.get('mcp-session-id') as string;
  }
  async function use(base: string, sessionId: string): Promise<number> {
    const res = await post(base, listTools, sessionId);
    await res.text();
    return res.status;
  }

  it('closes a session unused for longer than the limit, which then reads as missing', async () => {
    const base = await start();
    const sessionId = await open(base);
    const close = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    clock += 24 * HOUR - 1;
    vi.advanceTimersByTime(SWEEP);
    expect(close).not.toHaveBeenCalled();

    clock += 2;
    vi.advanceTimersByTime(SWEEP);
    const res = await post(base, listTools, sessionId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Session not found' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps sweeping when a transport fails to close', async () => {
    const base = await start();
    const first = await open(base);
    const second = await open(base);
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'close').mockImplementation(() => { throw new Error('close failed'); });

    clock += 25 * HOUR;
    expect(() => vi.advanceTimersByTime(SWEEP)).not.toThrow();
    expect(await use(base, first)).toBe(404);
    expect(await use(base, second)).toBe(404);
  });

  it('counts idle time from the last request, not from when the session opened', async () => {
    const base = await start();
    const sessionId = await open(base);

    clock += 20 * HOUR;
    expect(await use(base, sessionId)).toBe(200);
    clock += 20 * HOUR;
    vi.advanceTimersByTime(SWEEP);
    expect(await use(base, sessionId)).toBe(200);

    clock += 24 * HOUR + 1;
    vi.advanceTimersByTime(SWEEP);
    expect(await use(base, sessionId)).toBe(404);
  });

  it('past the cap, closes the least recently used idle session', async () => {
    const base = await start({ maxSessions: 2 });
    const a = await open(base);
    clock += 1;
    const b = await open(base);
    clock += 1;
    expect(await use(base, a)).toBe(200);
    clock += 1;
    const c = await open(base);

    expect(await use(base, b)).toBe(404);
    expect(await use(base, a)).toBe(200);
    expect(await use(base, c)).toBe(200);
  });

  it('never closes a session with a request in flight, such as an open event stream', async () => {
    const base = await start({ maxSessions: 2 });
    const stream = new AbortController();
    try {
      const streaming = await open(base);
      const opened = await fetch(`${base}/mcp`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': streaming },
        signal: stream.signal,
      });
      expect(opened.status).toBe(200);

      // Idle past the limit by its last request, but the stream is still open.
      clock += 25 * HOUR;
      vi.advanceTimersByTime(SWEEP);
      // The least recently used session, but busy, so the cap closes the idle one instead.
      const idle = await open(base);
      clock += 1;
      await open(base);
      expect(await use(base, idle)).toBe(404);
      expect(await use(base, streaming)).toBe(200);

      // Once the stream closes, the session ages like any other.
      stream.abort();
      await vi.waitFor(async () => {
        clock += 25 * HOUR;
        vi.advanceTimersByTime(SWEEP);
        expect(await use(base, streaming)).toBe(404);
      });
    } finally {
      stream.abort();
    }
  });

  it('answers HEAD /mcp without a token and never hands it to a session', async () => {
    const base = await start();
    const sessionId = await open(base);
    const handled = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest');

    const variants: Array<Record<string, string>> = [
      {}, { 'Mcp-Session-Id': sessionId }, { 'Mcp-Session-Id': sessionId, Authorization: `Bearer ${token}` },
    ];
    for (const headers of variants) {
      const res = await fetch(`${base}/mcp`, { method: 'HEAD', headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-protocol-version')).toBe(LATEST_PROTOCOL_VERSION);
    }
    expect(handled).not.toHaveBeenCalled();
  });
});
