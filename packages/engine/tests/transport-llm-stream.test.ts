import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { createLlmStreamHandler } from '../src/transport/llm-stream.js';

/** A web ReadableStream that emits the given string chunks then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function appWith(fetchImpl: typeof fetch) {
  const app = express();
  app.use(express.json());
  app.post('/llm/stream', createLlmStreamHandler({ fetchImpl, allowedHosts: ['upstream.test'] }));
  return app;
}

describe('createLlmStreamHandler', () => {
  it('treats an upstream redirect as an error, since only the requested host was checked', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response(streamOf([]), { status: 200 });
    }) as typeof fetch;

    await request(appWith(fetchImpl)).post('/llm/stream').send({ url: 'https://upstream.test/v1/chat', body: 'PAYLOAD' });

    expect(seen?.redirect).toBe('error');
  });

  it('forwards the envelope upstream and streams a 200 body back', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(streamOf(['data: a\n\n', 'data: b\n\n']), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const res = await request(appWith(fetchImpl))
      .post('/llm/stream')
      .send({ url: 'https://upstream.test/v1/chat', headers: { Authorization: 'Bearer FW' }, body: 'PAYLOAD' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toBe('data: a\n\ndata: b\n\n');
    expect(seen?.url).toBe('https://upstream.test/v1/chat');
    expect((seen?.init?.headers as Record<string, string>).Authorization).toBe('Bearer FW');
    expect(seen?.init?.body).toBe('PAYLOAD');
  });

  it('propagates an upstream error status and body (no silent empty 200)', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"bad key"}', { status: 401, headers: { 'content-type': 'application/json' } })
    ) as typeof fetch;

    const res = await request(appWith(fetchImpl))
      .post('/llm/stream')
      .send({ url: 'https://upstream.test/v1/chat', headers: {}, body: '{}' });

    expect(res.status).toBe(401);
    expect(res.text).toContain('bad key');
  });

  it('rejects a non-https upstream url with 403 (key would otherwise go plaintext)', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as typeof fetch;
    const res = await request(appWith(fetchImpl))
      .post('/llm/stream')
      .send({ url: 'http://upstream.test/v1/chat', headers: {}, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('rejects a non-allowlisted host with 403 (SSRF guard)', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 200 })) as typeof fetch;
    const res = await request(appWith(fetchImpl))
      .post('/llm/stream')
      .send({ url: 'https://evil.test/v1/chat', headers: {}, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('400s when url is missing or unparseable', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as typeof fetch;
    const app = appWith(fetchImpl);
    expect((await request(app).post('/llm/stream').send({ headers: {}, body: '{}' })).status).toBe(400);
    expect((await request(app).post('/llm/stream').send({ url: 'not a url', body: '{}' })).status).toBe(400);
  });

  it('aborts the upstream when the client disconnects', async () => {
    let captured: AbortSignal | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start() { /* never enqueues */ } }), { status: 200 });
    }) as typeof fetch;

    const handler = createLlmStreamHandler({ fetchImpl, allowedHosts: ['upstream.test'] });
    const req = { body: { url: 'https://upstream.test/v1/chat', headers: {}, body: '{}' } } as never;
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      status() { return res; },
      setHeader() { return res; },
      flushHeaders() {},
      write() { return true; },
      end() {},
    }) as never;

    void handler(req, res);
    await new Promise((r) => setTimeout(r, 0)); // let the handler reach fetchImpl
    expect(captured?.aborted).toBe(false);
    (res as unknown as EventEmitter).emit('close');
    expect(captured?.aborted).toBe(true);
  });

  it('default allowlist admits api.anthropic.com and forwards anthropic headers verbatim', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: unknown, init: unknown) => {
      seen.url = String(url);
      seen.init = init as RequestInit;
      return new Response('{"ok": true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const app = express().use(express.json()).post('/llm/stream', createLlmStreamHandler({ fetchImpl }));
    const res = await request(app).post('/llm/stream').send({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' },
      body: { model: 'claude-sonnet-4-6' },
    });
    expect(res.status).toBe(200);
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect((seen.init!.headers as Record<string, string>)['x-api-key']).toBe('sk-ant');
    expect((seen.init!.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('default allowlist admits openrouter.ai and forwards its headers verbatim', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: unknown, init: unknown) => {
      seen.url = String(url);
      seen.init = init as RequestInit;
      return new Response('{"ok": true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const app = express().use(express.json()).post('/llm/stream', createLlmStreamHandler({ fetchImpl }));
    const res = await request(app).post('/llm/stream').send({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer or-key' },
      body: { model: 'openai/gpt-4o' },
    });
    expect(res.status).toBe(200);
    expect(seen.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((seen.init!.headers as Record<string, string>).Authorization).toBe('Bearer or-key');
  });

  it('default allowlist admits the catalog provider hosts and refuses other hosts', async () => {
    const fetchImpl = (async () => new Response('{"ok": true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const app = express().use(express.json()).post('/llm/stream', createLlmStreamHandler({ fetchImpl }));

    // api.fireworks.ai should be allowed
    const fwRes = await request(app).post('/llm/stream').send({
      url: 'https://api.fireworks.ai/v1/chat',
      headers: {},
      body: {},
    });
    expect(fwRes.status).toBe(200);

    // so is every other catalog provider's host, OpenAI included
    const openaiRes = await request(app).post('/llm/stream').send({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {},
      body: {},
    });
    expect(openaiRes.status).toBe(200);

    // other hosts should be rejected
    const otherRes = await request(app).post('/llm/stream').send({
      url: 'https://api.mistral.ai/v1/chat',
      headers: {},
      body: {},
    });
    expect(otherRes.status).toBe(403);
  });
});

describe('upstream inactivity', () => {
  const LIMIT = 200;
  const enc = new TextEncoder();
  const relay = (fetchImpl: typeof fetch) => express().use(express.json())
    .post('/llm/stream', createLlmStreamHandler({ fetchImpl, allowedHosts: ['upstream.test'], inactivityMs: LIMIT }));
  const send = (app: express.Express) => request(app).post('/llm/stream').send({ url: 'https://upstream.test/v1/chat', body: '{}' });

  afterEach(() => { vi.useRealTimers(); });

  it('answers 504 when the upstream sends no response within the limit', async () => {
    // Like fetch, this upstream gives up only when the relay aborts it.
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;

    const res = await send(relay(fetchImpl));

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'upstream timed out' });
  });

  it('ends a stream that goes silent part way through', async () => {
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(enc.encode('data: a\n\n')); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

    const res = await send(relay(fetchImpl));

    expect(res.status).toBe(200);
    expect(res.text).toBe('data: a\n\n');
  });

  it('never cuts a stream that keeps sending, however long it runs', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => `data: ${i}\n\n`);
    const fetchImpl = (async () => {
      let i = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, LIMIT / 4));
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
          else controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const started = Date.now();
    const res = await send(relay(fetchImpl));

    expect(Date.now() - started).toBeGreaterThan(LIMIT);
    expect(res.status).toBe(200);
    expect(res.text).toBe(chunks.join(''));
  });

  it('leaves no timer behind on any way out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const upstreams: Array<() => Promise<Response>> = [
      async () => new Response(streamOf(['data: a\n\n']), { status: 200 }),
      async () => new Response('{"error":"bad key"}', { status: 401 }),
      async () => new Response(null, { status: 204 }),
      async () => { throw new Error('connect failed'); },
    ];
    for (const upstream of upstreams) {
      const res = await send(relay(upstream as unknown as typeof fetch));
      expect([200, 204, 401, 502]).toContain(res.status);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpApp } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/connection.js';
import { createSchema } from '../src/db/schema.js';
import { addUndoTables } from '../src/db/migrate.js';
import { createAuthSchema } from '../src/auth/schema.js';

describe('POST /llm/stream is bearer-authed in createHttpApp', () => {
  it('401s without a token when auth is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-engine-llm-auth-'));
    const db = openDatabase(join(dir, '.vault-engine', 'vault.db'));
    createSchema(db); addUndoTables(db); createAuthSchema(db);
    const app = createHttpApp(() => createServer(db), {
      db, ownerPassword: 'test-password', issuerUrl: new URL('https://vault.example.test'),
    });
    const res = await request(app).post('/llm/stream').send({ url: 'https://api.fireworks.ai/x', body: '{}' });
    expect(res.status).toBe(401);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
