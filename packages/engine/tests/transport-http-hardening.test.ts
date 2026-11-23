/**
 * What a caller without a token can make the HTTP transport do, and what one client can do
 * with another client's session: bodies read before auth, text written into the log, error
 * responses, stored registrations, session use, how long an unused session is kept, and HEAD.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHttpApp, type HttpAppOptions } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/connection.js';
import { createSchema } from '../src/db/schema.js';
import {
  addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addGlobalFieldUndoSnapshots, addUiHints,
  upgradeToMemories, upgradeToMemoriesV2, upgradeToMemoriesV3,
} from '../src/db/migrate.js';
import { createAuthSchema } from '../src/auth/schema.js';
import { hashToken } from '../src/auth/provider.js';
import { MAX_CLIENT_METADATA_CHARS } from '../src/auth/store.js';
import { ownerPasswordWarning } from '../src/auth/env.js';

let db: Database.Database;
let tmpDir: string;
let app: Express;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-hardening-'));
  db = openDatabase(join(tmpDir, '.vault-engine', 'vault.db'));
  createSchema(db);
  addUndoTables(db);
  createAuthSchema(db);
  addNodeTypesSortOrder(db);
  addSchemaUndoSnapshots(db);
  addGlobalFieldUndoSnapshots(db);
  addUiHints(db);
  upgradeToMemories(db);
  upgradeToMemoriesV2(db);
  upgradeToMemoriesV3(db);
  app = createHttpApp(() => createServer(db), authConfig());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const authConfig = () => ({
  db, ownerPassword: 'hardening-owner-password', issuerUrl: new URL('https://vault.example.test'),
});

/** A valid access token for the given client id. */
function tokenFor(clientId: string): string {
  const token = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
    VALUES (?, 'access', ?, '', NULL, ?, ?, 0)
  `).run(hashToken(token), clientId, now, now + 3600);
  return token;
}

const ACCEPT = 'application/json, text/event-stream';
const initialize = (padding = '') => ({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hardening', version: '0', padding } },
});
const OVER_DEFAULT_LIMIT = 'x'.repeat(200_000);

/** Runs `act` and returns what it wrote to the request log. */
async function logged(act: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await act(); } finally { process.stderr.write = original; }
  return lines.join('').split('\n').filter(Boolean);
}

describe('request bodies', () => {
  it('rejects a tokenless /mcp request without reading its body', async () => {
    const lines = await logged(async () => {
      const res = await request(app).post('/mcp').set('Accept', ACCEPT).send(initialize(OVER_DEFAULT_LIMIT));
      expect(res.status).toBe(401);
    });
    // Unread, so the body's method never reaches the log either.
    expect(lines.some(line => line.includes('MCP '))).toBe(false);
  });

  it('reads a body over the default limit once the request holds a token', async () => {
    const res = await request(app).post('/mcp').set('Accept', ACCEPT)
      .set('Authorization', `Bearer ${tokenFor('service-hardening')}`).send(initialize(OVER_DEFAULT_LIMIT));
    expect(res.status).toBe(200);
  });

  it('keeps the default limit on the routes anyone can reach', async () => {
    const res = await request(app).post('/register')
      .send({ redirect_uris: ['https://client.example/cb'], client_name: OVER_DEFAULT_LIMIT });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 0 });
  });
});

describe('client registration', () => {
  it('refuses metadata larger than a client could need, and stores nothing', async () => {
    const res = await request(app).post('/register').send({
      redirect_uris: ['https://client.example/cb'],
      client_name: 'n'.repeat(MAX_CLIENT_METADATA_CHARS),
      token_endpoint_auth_method: 'none',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 0 });
  });

  it('still registers an ordinary client', async () => {
    const res = await request(app).post('/register').send({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude', token_endpoint_auth_method: 'none',
    });
    expect(res.status).toBe(201);
  });
});

describe('error responses', () => {
  it('answers malformed JSON with a status and no stack trace', async () => {
    const res = await request(app).post('/register').set('Content-Type', 'application/json').send('{');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
    expect(res.text).not.toMatch(/node_modules|\.js:\d+|\bat /);
  });
});

describe('request log', () => {
  it('writes only name characters from a method or tool name', async () => {
    const token = tokenFor('service-hardening');
    const forged = 'x 200 1ms\n[vault-engine] POST /authorize 302 3ms';
    const lines = await logged(async () => {
      await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: forged });
      await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `query-nodes\n${'y'.repeat(200)}` } });
    });
    const requests = lines.filter(line => line.startsWith('[vault-engine] POST'));
    expect(requests).toHaveLength(2);
    expect(requests.every(line => line.startsWith('[vault-engine] POST /mcp MCP '))).toBe(true);
    expect(requests[0]).toContain('MCP x?200?1ms??vault-engine??POST?/authorize?302?3ms');
    expect(requests[1]).toMatch(/MCP tools\/call:query-nodes\?y{52} \d{3} /);
  });
});

describe('sessions', () => {
  it('belong to the client that opened them', async () => {
    const owner = `Bearer ${tokenFor('service-one')}`;
    const other = `Bearer ${tokenFor('service-two')}`;
    const opened = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', owner).send(initialize());
    expect(opened.status).toBe(200);
    const sessionId = opened.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();
    const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

    // Another client holding the session id gets nothing from it and cannot end it.
    const borrowed = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', other)
      .set('Mcp-Session-Id', sessionId).send(listTools);
    expect(borrowed.status).toBe(404);
    const ended = await request(app).delete('/mcp').set('Authorization', other).set('Mcp-Session-Id', sessionId);
    expect(ended.status).toBe(404);

    // The session is still its owner's, under a second token of the same client too.
    const sameClient = `Bearer ${tokenFor('service-one')}`;
    for (const authorization of [owner, sameClient]) {
      const res = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', authorization)
        .set('Mcp-Session-Id', sessionId).send(listTools);
      expect(res.status).toBe(200);
    }
    const closed = await request(app).delete('/mcp').set('Authorization', owner).set('Mcp-Session-Id', sessionId);
    expect(closed.status).toBe(200);
  });
});

describe('unused sessions', () => {
  const HOUR = 60 * 60 * 1000;
  const SWEEP = 5 * 60 * 1000;
  const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  let clock: number;
  let token: string;

  beforeEach(() => {
    clock = 1_000_000;
    token = `Bearer ${tokenFor('service-idle')}`;
    // Only the sweep's timer is faked; requests run on real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  const appWith = (options: HttpAppOptions = {}) =>
    createHttpApp(() => createServer(db), authConfig(), undefined, { now: () => clock, ...options });

  async function open(target: Express | Server): Promise<string> {
    const res = await request(target).post('/mcp').set('Accept', ACCEPT).set('Authorization', token).send(initialize());
    expect(res.status).toBe(200);
    return res.headers['mcp-session-id'] as string;
  }

  const use = (target: Express | Server, sessionId: string) => request(target).post('/mcp').set('Accept', ACCEPT)
    .set('Authorization', token).set('Mcp-Session-Id', sessionId).send(listTools);

  it('closes a session unused for longer than the limit, which then reads as missing', async () => {
    const idleApp = appWith();
    const sessionId = await open(idleApp);
    const close = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    clock += 24 * HOUR - 1;
    vi.advanceTimersByTime(SWEEP);
    expect(close).not.toHaveBeenCalled();

    clock += 2;
    vi.advanceTimersByTime(SWEEP);
    const res = await use(idleApp, sessionId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps sweeping when a transport fails to close', async () => {
    const idleApp = appWith();
    const first = await open(idleApp);
    const second = await open(idleApp);
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'close').mockImplementation(() => { throw new Error('close failed'); });

    clock += 25 * HOUR;
    expect(() => vi.advanceTimersByTime(SWEEP)).not.toThrow();
    expect((await use(idleApp, first)).status).toBe(404);
    expect((await use(idleApp, second)).status).toBe(404);
  });

  it('counts idle time from the last request, not from when the session opened', async () => {
    const idleApp = appWith();
    const sessionId = await open(idleApp);

    clock += 20 * HOUR;
    expect((await use(idleApp, sessionId)).status).toBe(200);
    clock += 20 * HOUR;
    vi.advanceTimersByTime(SWEEP);
    expect((await use(idleApp, sessionId)).status).toBe(200);

    clock += 24 * HOUR + 1;
    vi.advanceTimersByTime(SWEEP);
    expect((await use(idleApp, sessionId)).status).toBe(404);
  });

  it('past the cap, closes the least recently used idle session', async () => {
    const cappedApp = appWith({ maxSessions: 2 });
    const a = await open(cappedApp);
    clock += 1;
    const b = await open(cappedApp);
    clock += 1;
    expect((await use(cappedApp, a)).status).toBe(200);
    clock += 1;
    const c = await open(cappedApp);

    expect((await use(cappedApp, b)).status).toBe(404);
    expect((await use(cappedApp, a)).status).toBe(200);
    expect((await use(cappedApp, c)).status).toBe(200);
  });

  it('never closes a session with a request in flight, such as an open event stream', async () => {
    const server = createNodeHttpServer(appWith({ maxSessions: 2 }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stream = new AbortController();
    try {
      const streaming = await open(server);
      const opened = await fetch(`${base}/mcp`, {
        headers: { Accept: 'text/event-stream', Authorization: token, 'Mcp-Session-Id': streaming },
        signal: stream.signal,
      });
      expect(opened.status).toBe(200);

      // Idle past the limit by its last request, but the stream is still open.
      clock += 25 * HOUR;
      vi.advanceTimersByTime(SWEEP);
      // The least recently used session, but busy, so the cap closes the idle one instead.
      const idle = await open(server);
      clock += 1;
      await open(server);
      expect((await use(server, idle)).status).toBe(404);
      expect((await use(server, streaming)).status).toBe(200);

      // Once the stream closes, the session ages like any other.
      stream.abort();
      await vi.waitFor(async () => {
        clock += 25 * HOUR;
        vi.advanceTimersByTime(SWEEP);
        expect((await use(server, streaming)).status).toBe(404);
      });
    } finally {
      stream.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('HEAD /mcp', () => {
  it('answers without a token', async () => {
    const res = await request(app).head('/mcp');
    expect(res.status).toBe(200);
    expect(res.headers['mcp-protocol-version']).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('never reaches a session, even with its id', async () => {
    const token = `Bearer ${tokenFor('service-head')}`;
    const opened = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', token).send(initialize());
    const sessionId = opened.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();
    const handled = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest');

    for (const res of [
      await request(app).head('/mcp').set('Mcp-Session-Id', sessionId),
      await request(app).head('/mcp').set('Mcp-Session-Id', sessionId).set('Authorization', token),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers['mcp-protocol-version']).toBe(LATEST_PROTOCOL_VERSION);
    }
    expect(handled).not.toHaveBeenCalled();
  });
});

describe('ownerPasswordWarning', () => {
  it('warns about a short password and says nothing about a long one', () => {
    expect(ownerPasswordWarning('short')).toContain('OAUTH_OWNER_PASSWORD is 5 characters long');
    expect(ownerPasswordWarning('x'.repeat(19))).toBeDefined();
    expect(ownerPasswordWarning('x'.repeat(20))).toBeUndefined();
  });
});
