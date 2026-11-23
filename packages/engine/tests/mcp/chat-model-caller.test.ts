/**
 * #532, for chat hosts: a host holds a service token, which the Engine trusts. When the
 * host marks a tool call as chosen by its chat model (`_meta`), the Engine applies the
 * chat-client memory rules to that call. Unmarked calls of the same token stay trusted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createHttpApp } from '../../src/transport/http.js';
import { createServer } from '../../src/mcp/server.js';
import { createAuthSchema } from '../../src/auth/schema.js';
import { hashToken } from '../../src/auth/provider.js';
import { CHAT_MODEL_META_KEY, chatClientEditor, toolCaller } from '../../src/auth/client-label.js';
import { MemoryService } from '../../src/memories/service.js';
import { registerMemoriesTools, reservedSourceRefusal } from '../../src/mcp/tools/memories.js';

const EV = { kind: 'conversation', ref: 'test#0' } as const;
const CHAT_CLIENT = '3f8a5c2e-0000-4000-8000-000000000000';
const MARK = { [CHAT_MODEL_META_KEY]: 'Obsidian chat' };

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe('toolCaller', () => {
  it('reads the client and the declared chat model', () => {
    expect(toolCaller({ authInfo: { clientId: 'service-plugin' }, _meta: MARK })).toEqual({ clientId: 'service-plugin', chatModel: 'Obsidian chat' });
    expect(toolCaller({ authInfo: { clientId: 'service-plugin' } })).toEqual({ clientId: 'service-plugin', chatModel: undefined });
    expect(toolCaller(undefined)).toEqual({ clientId: undefined, chatModel: undefined });
  });

  it('takes only a short, plain name', () => {
    expect(toolCaller({ _meta: { [CHAT_MODEL_META_KEY]: `owner"\n[memories] forged ${'x'.repeat(200)}` } }).chatModel)
      .toBe(`owner [memories] forged ${'x'.repeat(200)}`.slice(0, 60));
    for (const value of ['', '   ', 42, true, null, { name: 'x' }]) {
      expect(toolCaller({ _meta: { [CHAT_MODEL_META_KEY]: value } }).chatModel, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('uses the key chat hosts are told to use', () => {
    expect(CHAT_MODEL_META_KEY).toBe('vault-engine/chat-model');
  });
});

describe('chatClientEditor with a declared chat model', () => {
  it('names the chat, and the service token it came through', () => {
    expect(chatClientEditor({ clientId: 'service-plugin', chatModel: 'Obsidian chat' })).toBe('chat "Obsidian chat" (service-plugin)');
    expect(chatClientEditor({ clientId: undefined, chatModel: 'Obsidian chat' })).toBe('chat "Obsidian chat"');
  });

  it('records nothing for a trusted caller that declares none', () => {
    expect(chatClientEditor({ clientId: 'service-curator', chatModel: undefined })).toBeUndefined();
    expect(chatClientEditor({ clientId: undefined, chatModel: undefined })).toBeUndefined();
  });

  it('labels a signed-in client from its token, whatever it declares', () => {
    expect(chatClientEditor({ clientId: CHAT_CLIENT, chatModel: 'the owner' })).toBe('client 3f8a5c2e');
  });

  it('makes the reserved sources refuse a host\'s chat model too', () => {
    expect(reservedSourceRefusal('owner', { clientId: 'service-plugin', chatModel: 'Obsidian chat' })).toMatch(/reserved/);
    expect(reservedSourceRefusal('chat', { clientId: 'service-plugin', chatModel: 'Obsidian chat' })).toBeNull();
    expect(reservedSourceRefusal('owner', { clientId: 'service-plugin', chatModel: undefined })).toBeNull();
  });
});

describe('the memory tools, called by a host for its chat model', () => {
  const asHost = { authInfo: { token: 't', clientId: 'service-plugin', scopes: [] } };
  const asHostsModel = { ...asHost, _meta: MARK };

  function setup() {
    db = createTestDb();
    const server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, new MemoryService(db));
    const call = async (name: string, args: Record<string, unknown>, extra: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = (server as any)._registeredTools[name];
      return JSON.parse((await tool.handler(args, extra)).content[0].text);
    };
    return { call };
  }

  it('marks the model\'s edits and leaves the host\'s own unmarked', async () => {
    const { call } = setup();
    const created = await call('create-memory', { source: 'owner', scope: 'vault', content: 'Alpha ships in March', evidence: EV }, asHost);
    expect(created.ok).toBe(true);

    const byModel = await call('update-memory', { id: created.data.id, content: 'Alpha ships in April', evidence: EV }, asHostsModel);
    expect(byModel.data).toMatchObject({ source: 'owner', changed_by: 'chat "Obsidian chat" (service-plugin)' });

    const byHost = await call('update-memory', { id: byModel.data.id, content: 'Alpha ships in May', evidence: EV }, asHost);
    expect(byHost.data.changed_by).toBeNull();

    const retired = await call('expire-memory', { id: byHost.data.id, reason: 'contradicted' }, asHostsModel);
    expect(retired.data.changed_by).toBe('chat "Obsidian chat" (service-plugin)');
  });

  it('refuses the reserved sources to the model and not to the host', async () => {
    const { call } = setup();
    const refused = await call('create-memory', { source: 'owner', scope: 'vault', content: 'Alpha fact', evidence: EV }, asHostsModel);
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('reserved') } });
    expect((await call('create-memory', { source: 'chat', scope: 'vault', content: 'Alpha fact', evidence: EV }, asHostsModel)).ok).toBe(true);
    expect((await call('create-memory', { source: 'curator', scope: 'vault', content: 'Beta fact', evidence: EV }, asHost)).ok).toBe(true);
  });
});

describe('over HTTP', () => {
  const ACCEPT = 'application/json, text/event-stream';

  function rpc(res: request.Response): { result?: { content: Array<{ text: string }> } } {
    if (res.text.startsWith('{')) return JSON.parse(res.text);
    const data = res.text.split('\n').find((line) => line.startsWith('data: '));
    if (!data) throw new Error(`no message in response: ${res.text.slice(0, 200)}`);
    return JSON.parse(data.slice('data: '.length));
  }

  it('the mark on a real tools/call request reaches the tool', async () => {
    db = createTestDb();
    createAuthSchema(db);
    const database = db;
    const app = createHttpApp(() => createServer(database), {
      db: database, ownerPassword: 'chat-model-owner-password', issuerUrl: new URL('https://vault.example.test'),
    });
    const token = randomBytes(32).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    database.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, 'access', 'service-plugin', '', NULL, ?, ?, 0)
    `).run(hashToken(token), now, now + 3600);

    const init = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${token}`).send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'chat-model-caller', version: '0' } },
    });
    expect(init.status).toBe(200);
    const session = init.headers['mcp-session-id'] as string;
    const createOwnerMemory = async (meta?: Record<string, unknown>) => {
      const res = await request(app).post('/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${token}`).set('mcp-session-id', session).send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'create-memory',
          arguments: { source: 'owner', content: `Alpha fact ${meta ? 'by the model' : 'by the host'}`, evidence: EV },
          ...(meta ? { _meta: meta } : {}),
        },
      });
      expect(res.status).toBe(200);
      return JSON.parse(rpc(res).result!.content[0]!.text);
    };

    expect(await createOwnerMemory(MARK)).toMatchObject({ ok: false, error: { message: expect.stringContaining('reserved') } });
    expect((await createOwnerMemory()).ok).toBe(true);
  });
});
