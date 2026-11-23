import { describe, it, expect } from 'vitest';
import { makeStreamingRelayFetch, relayUrlFromEngineUrl } from '../../src/llm/streaming-relay-fetch.js';

describe('relayUrlFromEngineUrl', () => {
  it('swaps a trailing /mcp for /llm/stream on the same origin', () => {
    expect(relayUrlFromEngineUrl('https://vault.example.test/mcp')).toBe('https://vault.example.test/llm/stream');
    expect(relayUrlFromEngineUrl('https://vault.example.test/mcp/')).toBe('https://vault.example.test/llm/stream');
    expect(relayUrlFromEngineUrl('http://localhost:3334/mcp')).toBe('http://localhost:3334/llm/stream');
  });
});

describe('makeStreamingRelayFetch', () => {
  it('POSTs the provider request as an envelope with the engine bearer token, returns the relay Response', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const streamBody = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: hi\n\n')); c.close(); },
    });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(streamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const f = makeStreamingRelayFetch({ relayUrl: 'https://e.test/llm/stream', token: 'ENG', fetchImpl });
    const res = await f('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer FW', 'content-type': 'application/json' }, body: 'PAYLOAD',
    });

    expect(seen?.url).toBe('https://e.test/llm/stream');
    expect((seen?.init?.headers as Record<string, string>).Authorization).toBe('Bearer ENG');
    const env = JSON.parse(seen?.init?.body as string) as { url: string; headers: Record<string, string>; body: string };
    expect(env.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(env.headers.Authorization).toBe('Bearer FW');
    expect(env.body).toBe('PAYLOAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: hi\n\n'); // body streamed through verbatim
  });

  it('forwards the abort signal to the relay fetch', async () => {
    let captured: AbortSignal | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const ctrl = new AbortController();
    const f = makeStreamingRelayFetch({ relayUrl: 'https://e.test/llm/stream', token: 'ENG', fetchImpl });
    await f('https://api.fireworks.ai/x', { method: 'POST', body: '{}', signal: ctrl.signal });
    expect(captured).toBe(ctrl.signal);
  });

  it('normalizes Headers and array header forms into the envelope', async () => {
    let env: { headers: Record<string, string> } | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      env = JSON.parse(init?.body as string);
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const f = makeStreamingRelayFetch({ relayUrl: 'https://e.test/llm/stream', token: 'ENG', fetchImpl });
    await f('https://api.fireworks.ai/x', { headers: new Headers({ a: 'b' }) });
    expect(env?.headers.a).toBe('b');
    await f('https://api.fireworks.ai/x', { headers: [['c', 'd']] });
    expect(env?.headers.c).toBe('d');
  });
});
