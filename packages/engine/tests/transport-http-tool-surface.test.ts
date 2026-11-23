import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createHttpApp } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { createAuthSchema } from '../src/auth/schema.js';
import { hashToken } from '../src/auth/provider.js';
import { serviceClientId } from '../src/auth/service-client.js';
import { SERVICE_ONLY_TOOL_NAMES } from '../src/mcp/tool-surface.js';
import { createTestDb } from './helpers/db.js';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'surface-probe', version: '0.0.1' },
  },
};

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = createTestDb();
  createAuthSchema(db);
  app = createHttpApp(options => createServer(db, options), {
    db,
    ownerPassword: 'surface-owner-password',
    issuerUrl: new URL('https://vault.example.test'),
  });
});

/** Store an access token the way both the OAuth flow and issue-service-token.ts do. */
function issueAccessToken(clientId: string): string {
  const secret = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
    VALUES (?, 'access', ?, '', NULL, ?, ?, 0)
  `).run(hashToken(secret), clientId, now, now + 3600);
  return secret;
}

/** Streamable HTTP answers with one SSE `message` event per request. */
function rpcResult(text: string): { tools: Array<{ name: string }> } {
  const data = text.split('\n').find(line => line.startsWith('data: '));
  expect(data).toBeDefined();
  return (JSON.parse(data!.slice('data: '.length)) as { result: { tools: Array<{ name: string }> } }).result;
}

async function listToolNames(token: string): Promise<string[]> {
  const init = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(INITIALIZE_BODY);
  expect(init.status).toBe(200);
  const sessionId = init.headers['mcp-session-id'] as string;
  const list = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  expect(list.status).toBe(200);
  return rpcResult(list.text).tools.map(t => t.name);
}

describe('HTTP tool surface by client', () => {
  it('lists conversation tools to a service-token client', async () => {
    const names = await listToolNames(issueAccessToken(serviceClientId('vault-curator')));
    expect(names).toEqual(expect.arrayContaining(['list-conversations', 'get-conversation', 'query-nodes']));
  });

  it('hides service-only tools from an OAuth-registered client', async () => {
    const names = await listToolNames(issueAccessToken(randomUUID()));
    expect(names).toContain('query-nodes');
    expect(names.filter(name => SERVICE_ONLY_TOOL_NAMES.includes(name))).toEqual([]);
  });

  it('keeps each session on the surface it was created with', async () => {
    const service = await listToolNames(issueAccessToken(serviceClientId('obsidian-plugin')));
    const external = await listToolNames(issueAccessToken(randomUUID()));
    const serviceAgain = await listToolNames(issueAccessToken(serviceClientId('obsidian-plugin')));
    expect(external.length).toBeLessThan(service.length);
    expect(serviceAgain).toEqual(service);
  });
});
