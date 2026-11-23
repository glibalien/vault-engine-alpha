import { describe, it, expect } from 'vitest';
import { bearerHeaders, parseMcpBody, connectEngine, type HttpPost } from '../../src/engine/transport.js';

const sse = (obj: unknown): string => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;

interface Recorded { url: string; method: string; headers: Record<string, string>; body: string }

/** A fake engine: replies to each MCP method with a finite SSE body, like the real one. */
function makeFakePost(overrides?: { toolsCall?: () => { status: number; headers: Record<string, string>; text: string } }): {
  post: HttpPost;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const post: HttpPost = async (req) => {
    calls.push(req);
    if (req.method === 'DELETE') return { status: 200, headers: {}, text: '' };
    const msg = JSON.parse(req.body) as { id?: number; method: string };
    const ct = { 'content-type': 'text/event-stream' };
    switch (msg.method) {
      case 'initialize':
        return { status: 200, headers: { ...ct, 'mcp-session-id': 'sess-123' }, text: sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'e', version: '1' } } }) };
      case 'notifications/initialized':
        return { status: 202, headers: {}, text: '' };
      case 'tools/list':
        return { status: 200, headers: ct, text: sse({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'query-nodes', description: 'd', inputSchema: { type: 'object' } }] } }) };
      case 'tools/call':
        if (overrides?.toolsCall) return overrides.toolsCall();
        return { status: 200, headers: ct, text: sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) };
      default:
        return { status: 200, headers: {}, text: '' };
    }
  };
  return { post, calls };
}

describe('bearerHeaders', () => {
  it('returns Authorization for a token, nothing for empty', () => {
    expect(bearerHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
    expect(bearerHeaders('')).toEqual({});
  });
});

describe('parseMcpBody', () => {
  it('extracts the JSON-RPC message from a finite SSE body', () => {
    const out = parseMcpBody(sse({ jsonrpc: '2.0', id: 1, result: { ok: true } }), 'text/event-stream');
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('extracts multiple events from one body', () => {
    const body = sse({ id: 1, result: { a: 1 } }) + sse({ id: 2, result: { b: 2 } });
    const out = parseMcpBody(body, 'text/event-stream');
    expect(out.map((m) => m.id)).toEqual([1, 2]);
  });

  it('ignores SSE comment / keep-alive lines', () => {
    const body = `: keep-alive\n\n` + sse({ id: 3, result: {} });
    expect(parseMcpBody(body, 'text/event-stream').map((m) => m.id)).toEqual([3]);
  });

  it('parses a plain JSON body', () => {
    expect(parseMcpBody('{"id":4,"result":{}}', 'application/json')).toEqual([{ id: 4, result: {} }]);
  });

  it('returns [] for an empty or unparseable body', () => {
    expect(parseMcpBody('', 'text/event-stream')).toEqual([]);
    expect(parseMcpBody('   ', null)).toEqual([]);
    expect(parseMcpBody('not json', 'application/json')).toEqual([]);
  });
});

describe('connectEngine (requestUrl-style, injected post)', () => {
  it('sends a call\'s _meta beside its arguments, and nothing when there is none', async () => {
    const { post, calls } = makeFakePost();
    const conn = await connectEngine('https://x/mcp', 'tok', post);
    await conn.call({ name: 'update-memory', arguments: { id: 1 }, _meta: { 'vault-engine/chat-model': 'Obsidian chat' } });
    await conn.call({ name: 'query-nodes', arguments: {} });
    const sent = calls.map((c) => JSON.parse(c.body) as { method: string; params?: Record<string, unknown> }).filter((m) => m.method === 'tools/call');
    expect(sent.map((m) => m.params)).toEqual([
      { name: 'update-memory', arguments: { id: 1 }, _meta: { 'vault-engine/chat-model': 'Obsidian chat' } },
      { name: 'query-nodes', arguments: {} },
    ]);
  });

  it('handshakes, captures + resends the session id, and sends the bearer', async () => {
    const { post, calls } = makeFakePost();
    await connectEngine('https://x/mcp', 'tok', post);
    // initialize first, then notifications/initialized
    expect(JSON.parse(calls[0].body).method).toBe('initialize');
    expect(JSON.parse(calls[1].body).method).toBe('notifications/initialized');
    // session id from the initialize response rides the next request
    expect(calls[1].headers['mcp-session-id']).toBe('sess-123');
    // bearer on every request
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers.Accept).toContain('text/event-stream');
  });

  it('listTools maps the engine tool list', async () => {
    const { post } = makeFakePost();
    const conn = await connectEngine('https://x/mcp', 'tok', post);
    const tools = await conn.listTools();
    expect(tools).toEqual([{ name: 'query-nodes', description: 'd', inputSchema: { type: 'object' } }]);
  });

  it('call returns the CallToolResult', async () => {
    const { post } = makeFakePost();
    const conn = await connectEngine('https://x/mcp', 'tok', post);
    const res = await conn.call({ name: 'query-nodes', arguments: { limit: 1 } });
    expect(res.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
  });

  it('throws on a JSON-RPC error reply', async () => {
    const { post } = makeFakePost({ toolsCall: () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, text: sse({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'boom' } }) }) });
    const conn = await connectEngine('https://x/mcp', 'tok', post);
    await expect(conn.call({ name: 'query-nodes', arguments: {} })).rejects.toThrow(/boom/);
  });

  it('throws on an HTTP error status', async () => {
    const { post } = makeFakePost({ toolsCall: () => ({ status: 401, headers: { 'content-type': 'application/json' }, text: '{"error":{"code":-32000,"message":"unauthorized"}}' }) });
    const conn = await connectEngine('https://x/mcp', 'tok', post);
    await expect(conn.call({ name: 'query-nodes', arguments: {} })).rejects.toThrow(/HTTP 401/);
  });

  it('close issues a DELETE carrying the session id', async () => {
    const { post, calls } = makeFakePost();
    const conn = await connectEngine('https://x/mcp', 'tok', post);
    await conn.close();
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del?.headers['mcp-session-id']).toBe('sess-123');
  });
});
