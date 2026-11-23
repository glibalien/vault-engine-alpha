import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openCuratorDb } from '../src/db/connection.js';
import { createAuthSchema } from '../src/auth/schema.js';
import { runMigrations } from '../src/db/migrate.js';
import { hashToken } from '../src/auth/provider.js';
import { createHttpApp } from '../src/transport/http.js';
import { buildAuthConfig, curatorServerFactory } from '../src/server-bootstrap.js';
import { CurationQueue } from '../src/queue.js';
import type Database from 'better-sqlite3';

// Hermetic: short-circuit the curation so the server smoke test exercises only
// OAuth + scope + tool dispatch + response mapping (no live engine / no LLM).
vi.mock('../src/core.js', () => ({
  triggerCuration: vi.fn(async (_deps: unknown, args: { project?: string | null; dryRun: boolean }) => [
    { project: args.project ?? 'all', outcome: 'written', detail: 'mocked', dryRun: args.dryRun },
  ]),
  reconcileWikiPages: vi.fn(async (_deps: unknown, args: { wiki: string; dryRun: boolean }) => ({
    ok: true, wiki: args.wiki, dry_run: args.dryRun, result: { project: args.wiki, outcome: 'written', dryRun: args.dryRun },
  })),
}));

let dir: string;
let db: Database.Database;
let httpServer: Server;
let baseUrl: string;

function mintToken(scopes: string): string {
  const secret = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const clientId = `service-${scopes.replace(/[^a-z]/g, '')}`;
  db.prepare(`
    INSERT INTO oauth_clients (client_id, client_id_issued_at, client_secret, client_secret_expires_at, metadata)
    VALUES (?, ?, NULL, NULL, ?) ON CONFLICT(client_id) DO NOTHING
  `).run(clientId, now, JSON.stringify({ client_name: 'smoke' }));
  db.prepare(`
    INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
    VALUES (?, 'access', ?, ?, NULL, ?, ?, 0)
  `).run(hashToken(secret), clientId, scopes, now, now + 3600);
  return secret;
}

async function callCurate(secret: string) {
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  try {
    return await client.callTool({ name: 'curate-project-wiki', arguments: { project: 'Demo', dry_run: true } });
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'curator-server-smoke-'));
  db = openCuratorDb(join(dir, 'curator.db'));
  createAuthSchema(db);
  runMigrations(db);
  const issuerUrl = new URL('http://127.0.0.1:3335');
  const deps = {
    engine: { usageReport: async () => ({ data: { groups: [], group_count: 0,
      totals: { events: 0, provider_reported_usd: 0, estimated_usd: 0, unpriced_events: 0 } }, warnings: [] }) }, llm: {},
    config: { curatorSweepAt: '05:00', curatorTz: 'UTC', staleProjectDays: 14, staleSkipStatuses: [] },
    queue: new CurationQueue(), db,
  } as never;
  const app = createHttpApp(curatorServerFactory(async () => deps, new Date()), buildAuthConfig(db, 'owner-pw', issuerUrl));
  await new Promise<void>((res) => { httpServer = createNodeHttpServer(app); httpServer.listen(0, '127.0.0.1', () => res()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => httpServer.close(() => res()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('curator MCP server (real factory)', () => {
  it('lists curate-project-wiki', async () => {
    const secret = mintToken('curate:trigger curate:read');
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('curate-project-wiki');
      expect(names).toContain('request-wiki-page');
      expect(names).toContain('create-or-update-wiki');
      expect(names).toContain('propose-topic-wiki');
      expect(names).toContain('reconcile-wiki-pages');
      expect(names).toContain('curator-cost-report');
      expect(names).toEqual(expect.arrayContaining(['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status']));
      expect(names).not.toContain('create-wiki');
      const createOrUpdate = tools.tools.find(tool => tool.name === 'create-or-update-wiki');
      expect(createOrUpdate?.description).toMatch(/stable input.*anchor/i);
      expect(createOrUpdate?.description).toMatch(/omit.*preserv/i);
      expect(createOrUpdate?.description).toMatch(/empty.*clear/i);
      expect(createOrUpdate?.description).toMatch(/non-empty.*replace/i);
      expect(createOrUpdate?.description).toMatch(/forc.*curation/i);
      expect(createOrUpdate?.description).toMatch(/queues that build and replies at once/);
      // Scheduled refresh and sweep retries are promised only while wiki reconciliation is live (#544).
      expect(createOrUpdate?.description).toMatch(/scheduled refresh, which runs only while curator-status shows wiki_reconciliation_mode "live"/);
      const curate = tools.tools.find(tool => tool.name === 'curate-project-wiki');
      expect(curate?.description).toMatch(/only while curator-status shows wiki_reconciliation_mode "live", so otherwise rebuild it later with force: true/);
      expect(curate?.description).not.toMatch(/the next sweep then retries/);
      expect(createOrUpdate?.inputSchema).toMatchObject({
        type: 'object',
        properties: { source_node_ids: { type: 'array' } },
      });
    } finally {
      await transport.close();
    }
  });

  it.each([['curate:read', true], ['curate:trigger', false]])('cost report enforces %s over real MCP', async (scope, allowed) => {
    const client = new Client({ name: 'cost-smoke', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${mintToken(scope)}` } },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'curator-cost-report', arguments: {} });
      const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(body.ok).toBe(allowed);
      if (allowed) expect(body.data.totals.events).toBe(0);
      else expect(body.error.code).toBe('FORBIDDEN');
    } finally { await transport.close(); }
  });

  it('reconcile-wiki-pages requires curate:trigger over the wire', async () => {
    const secret = mintToken('curate:read');
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'reconcile-wiki-pages', arguments: { wiki: 'Demo' } });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.find(item => item.type === 'text')?.text).toContain('FORBIDDEN');
    } finally {
      await transport.close();
    }
  });

  it('a curate:trigger token can curate (dry-run)', async () => {
    const result = await callCurate(mintToken('curate:trigger'));
    const content = result.content as Array<{ type: string; text?: string }>;
    const textItem = content.find((c) => c.type === 'text');
    expect(textItem).toBeDefined();
    const body = JSON.parse(textItem!.text!);
    expect(body.mode).toBe('project');
    expect(body.results[0].outcome).toBe('written');
    expect(body.dry_run).toBe(true);
  });

  it('a curate:read-only token is rejected (scope enforcement over the wire)', async () => {
    const result = await callCurate(mintToken('curate:read'));
    const content = result.content as Array<{ type: string; text?: string }>;
    const textItem = content.find((c) => c.type === 'text');
    expect(textItem).toBeDefined();
    expect(textItem!.text!).toContain('FORBIDDEN');
  });

  it('curator-status responds to a curate:read token', async () => {
    const secret = mintToken('curate:read');
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'curator-status', arguments: { limit: 5, window_hours: 24 } });
      const content = result.content as Array<{ type: string; text?: string }>;
      const body = JSON.parse(content.find((c) => c.type === 'text')!.text!);
      expect(Array.isArray(body.recent_runs)).toBe(true);
      expect(body.server).toBeDefined();
      expect(body.queue).toBeDefined();
    } finally {
      await transport.close();
    }
  });

  it('curator-status rejects a curate:trigger-only token', async () => {
    const secret = mintToken('curate:trigger');
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'curator-status', arguments: {} });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.find((c) => c.type === 'text')!.text!).toContain('FORBIDDEN');
    } finally {
      await transport.close();
    }
  });

  it('a revoked token is rejected at connect time', async () => {
    const secret = mintToken('curate:trigger');
    // Revoke the token in the DB before using it.
    db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token = ?').run(hashToken(secret));

    // The SDK POSTs to /mcp for MCP initialize; a revoked token gets a 401 back
    // (verifyAccessToken throws InvalidTokenError → auth middleware → 401).
    // With no authProvider configured, the transport surfaces this as a rejection
    // at client.connect() time (StreamableHTTPError or similar).
    await expect(callCurate(secret)).rejects.toBeDefined();
  });
});
