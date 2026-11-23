import { describe, expect, it, vi } from 'vitest';
import { HomeRefreshNotSentError, type HomeRefreshRequest } from '@vault/query-core';
import { connectEngine, EngineTransportError, type HttpPost, type HttpResponse } from '../../src/engine/transport.js';
import { makeHomeRefreshClient } from '../../src/provenance/home-refresh-client.js';
const env = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data }) }] });
const sse = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`;
const refreshTools = ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'];
const status = (requestId: string) => ({ request_id: requestId, phase: 'committed', message: 'Finished',
  created_at: '', updated_at: '', replaces_output_revision_id: 'old', output: null, usage: null });
const request: HomeRefreshRequest = { request_id: '12345678-1234-4234-9234-123456789abc', confirm_paid: true,
  guard: { version: 1, vault_namespace: 'vault', project_id: 'project', home_node_id: 'home', output_revision_id: 'old',
    home_version: 1, topology_hash: 'topology', configuration_digest: 'config', corrections_digest: 'corrections' } };
function makeMcpPost(toolCall: (message: { id: number; params: { name: string; arguments: Record<string, unknown> } }, session: string) => Promise<HttpResponse> | HttpResponse) {
  let sessionCount = 0;
  const calls: Array<{ method: string; session?: string; message?: { id?: number; method: string; params?: any } }> = [];
  const post: HttpPost = async req => {
    const session = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') { calls.push({ method: 'DELETE', session }); return { status: 200, headers: {}, text: '' }; }
    const message = JSON.parse(req.body) as { id?: number; method: string; params?: any };
    calls.push({ method: message.method, session, message });
    const headers = { 'content-type': 'text/event-stream' };
    if (message.method === 'initialize') {
      const id = `session-${++sessionCount}`;
      return { status: 200, headers: { ...headers, 'mcp-session-id': id }, text: sse({ jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'curator', version: '1' } } }) };
    }
    if (message.method === 'notifications/initialized') return { status: 202, headers: {}, text: '' };
    if (message.method === 'tools/list') return { status: 200, headers,
      text: sse({ jsonrpc: '2.0', id: message.id, result: { tools: refreshTools.map(name => ({ name })) } }) };
    if (message.method === 'tools/call') return toolCall(message as any, session!);
    throw Error(`Unexpected MCP method ${message.method}`);
  };
  return { post, calls };
}
const toolResult = (id: number, data: unknown): HttpResponse => ({ status: 200, headers: { 'content-type': 'text/event-stream' },
  text: sse({ jsonrpc: '2.0', id, result: env(data) }) });
it('identifies connection failure before refresh dispatch without leaking its cause', async () => {
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: async () => { throw Error('private connection details'); } });
  const error = await client.api.execute({} as any).catch(e => e);
  expect(error).toBeInstanceOf(HomeRefreshNotSentError);
  expect(error.message).not.toContain('private');
});
it('does not classify a lost refresh reply as unsent', async () => {
  const failure = Error('reply lost');
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: async () => ({ close: async () => {}, listTools: async () =>
      ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(name => ({ name })) as any,
    call: async () => { throw failure; } }) });
  await expect(client.api.execute({} as any)).rejects.toBe(failure);
});
it('reconnects after an expired cached session before retrying status', async () => {
  let statusCalls = 0;
  const { post, calls } = makeMcpPost((message, session) => {
    if (message.params.name === 'preview-wiki-refresh') return toolResult(message.id, { eligible: false, reasons: [], guard: null,
      model: null, sections: [], project_title: null, target_kind: 'home', page_title: null, page_path: null, home_title: null, home_path: null });
    if (message.params.name === 'wiki-refresh-status' && ++statusCalls === 1)
      return { status: 404, headers: { 'content-type': 'text/event-stream' },
        text: sse({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `expired ${session}` } }) };
    return toolResult(message.id, status(String(message.params.arguments.request_id)));
  });
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: (endpoint, token) => connectEngine(endpoint, token, post) });
  await client.api.preview('old');
  await expect(client.api.status(request.request_id)).rejects.toBeInstanceOf(EngineTransportError);
  await expect(client.api.status(request.request_id)).resolves.toMatchObject({ request_id: request.request_id });
  expect(calls.filter(call => call.method === 'initialize')).toHaveLength(2);
  expect(calls.filter(call => call.message?.params?.name === 'wiki-refresh-status').map(call => call.session))
    .toEqual(['session-1', 'session-2']);
  expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', session: 'session-1' }));
  await client.close();
});
it('reconnects after a lost execute reply and retries the exact UUID without claiming it was unsent', async () => {
  const dispatched: Array<{ session: string; arguments: Record<string, unknown> }> = [];
  const { post, calls } = makeMcpPost((message, session) => {
    dispatched.push({ session, arguments: message.params.arguments });
    if (dispatched.length === 1) throw Error('reply lost after dispatch');
    return toolResult(message.id, status(String(message.params.arguments.request_id)));
  });
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: (endpoint, token) => connectEngine(endpoint, token, post) });
  const error = await client.api.execute(request).catch(cause => cause);
  expect(error).toBeInstanceOf(EngineTransportError);
  expect(error).not.toBeInstanceOf(HomeRefreshNotSentError);
  await expect(client.api.execute(request)).resolves.toMatchObject({ request_id: request.request_id });
  expect(dispatched).toEqual([
    { session: 'session-1', arguments: request },
    { session: 'session-2', arguments: request },
  ]);
  expect(calls.filter(call => call.method === 'initialize')).toHaveLength(2);
  await client.close();
});
it('stops a closed cached client before refresh dispatch', async () => {
  const calls: string[] = [];
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: async () => ({ close: async () => {}, listTools: async () =>
      ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(name => ({ name })) as any,
    call: async request => {
      calls.push(request.name);
      return env({ eligible: false, reasons: [], guard: null, model: null, sections: [],
        project_title: null, target_kind: 'home', page_title: null, page_path: null, home_title: null, home_path: null });
    } }) });
  await client.api.preview('output');
  const pending = client.api.execute({} as any);
  const rejected = expect(pending).rejects.toBeInstanceOf(HomeRefreshNotSentError);
  await client.close();
  await rejected;
  expect(calls).toEqual(['preview-wiki-refresh']);
});
it('does not trust server error codes as proof of no dispatch', async () => {
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: async () => ({ close: async () => {}, listTools: async () =>
      ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(name => ({ name })) as any,
    call: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false,
      error: { code: 'NOT_SENT' } }) }] }) }) });
  const error = await client.api.execute({} as any).catch(e => e);
  expect(error).not.toBeInstanceOf(HomeRefreshNotSentError);
  expect(error).toMatchObject({ code: 'NOT_SENT' });
});
it.each(['GUARD_CONFLICT', 'READINESS_UNAVAILABLE', 'SHUTTING_DOWN', 'REFRESH_UNAVAILABLE'])('preserves %s without treating a server reply as unsent or exposing text', async code => {
  const call = vi.fn()
    .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false,
      error: { code, message: 'private server text' } }) }] })
    .mockResolvedValueOnce(env(status(request.request_id)));
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, listTools: async () =>
    refreshTools.map(name => ({ name })) as any, call }));
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect });
  const error = await client.api.execute({} as any).catch(e => e);
  expect(error).toMatchObject({ code });
  expect(error).not.toBeInstanceOf(HomeRefreshNotSentError);
  expect(error.message).not.toContain('private server text');
  await expect(client.api.status(request.request_id)).resolves.toMatchObject({ request_id: request.request_id });
  expect(connect).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
});
it('does not wait for failed-session teardown before allowing a reconnect', async () => {
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  const oldClose = vi.fn(() => closing);
  const oldConnection = { close: oldClose, listTools: async () => refreshTools.map(name => ({ name })) as any,
    call: vi.fn(async () => { throw new EngineTransportError('expired'); }) };
  const newConnection = { close: vi.fn(async () => {}), listTools: async () => refreshTools.map(name => ({ name })) as any,
    call: vi.fn(async ({ arguments: args }: any) => env(status(String(args.request_id)))) };
  const connect = vi.fn().mockResolvedValueOnce(oldConnection).mockResolvedValueOnce(newConnection);
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret', connect });
  const failed = client.api.status('expired').catch(error => error);
  let surfaced = false;
  void failed.then(() => { surfaced = true; });
  await vi.waitFor(() => expect(oldClose).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(surfaced).toBe(true);
  expect(await failed).toBeInstanceOf(EngineTransportError);
  await expect(client.api.status('fresh')).resolves.toMatchObject({ request_id: 'fresh' });
  expect(connect).toHaveBeenCalledTimes(2);
  finishClose();
  await client.close();
});
it('does not let a late failure from an old session clear its replacement', async () => {
  let rejectLate!: (error: Error) => void;
  const lateResult = new Promise<never>((_, reject) => { rejectLate = reject; });
  const oldClose = vi.fn(async () => {}), newClose = vi.fn(async () => {});
  const oldConnection = { close: oldClose, listTools: async () => refreshTools.map(name => ({ name })) as any,
    call: vi.fn(async ({ arguments: args }: any) => {
      if (args.request_id === 'late') return lateResult;
      throw new EngineTransportError('expired');
    }) };
  const newConnection = { close: newClose, listTools: async () => refreshTools.map(name => ({ name })) as any,
    call: vi.fn(async ({ arguments: args }: any) => env(status(String(args.request_id)))) };
  const connect = vi.fn().mockResolvedValueOnce(oldConnection).mockResolvedValueOnce(newConnection);
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret', connect });
  const late = client.api.status('late').catch(error => error);
  await expect(client.api.status('expire')).rejects.toBeInstanceOf(EngineTransportError);
  await expect(client.api.status('fresh')).resolves.toMatchObject({ request_id: 'fresh' });
  rejectLate(new EngineTransportError('late old failure'));
  expect(await late).toBeInstanceOf(EngineTransportError);
  await expect(client.api.status('still-fresh')).resolves.toMatchObject({ request_id: 'still-fresh' });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(oldClose).toHaveBeenCalledTimes(1);
  expect(newClose).not.toHaveBeenCalled();
  await client.close();
});
it('closes a connection that finishes opening after client close without caching it', async () => {
  let resolve!: (connection: any) => void;
  const opening = new Promise<any>(done => { resolve = done; });
  const close = vi.fn(async () => {});
  const connect = vi.fn(() => opening);
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret', connect });
  const preview = expect(client.api.preview('old')).rejects.toThrow('Refresh connection closed');
  await client.close();
  resolve({ close, listTools: async () => refreshTools.map(name => ({ name })) as any, call: vi.fn() });
  await preview;
  expect(close).toHaveBeenCalledTimes(1);
  await expect(client.api.status(request.request_id)).rejects.toThrow('Refresh connection closed');
  expect(connect).toHaveBeenCalledTimes(1);
});
it('connects lazily, discovers support, and only sends explicitly requested operations', async () => {
  const call = vi.fn(async () => env({ eligible: false, reasons: [], guard: null, model: null, sections: [],
    project_title: null, target_kind: 'home', page_title: null, page_path: null, home_title: null, home_path: null }));
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ call, close, listTools: async () =>
    ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(name => ({ name })) as any }));
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret', connect });
  expect(connect).not.toHaveBeenCalled();
  await client.api.preview('output');
  expect(call).toHaveBeenCalledWith({ name: 'preview-wiki-refresh', arguments: { output_revision_id: 'output' } });
  expect(JSON.stringify(call.mock.calls)).not.toContain('secret');
  await client.close(); expect(close).toHaveBeenCalledTimes(1);
});
it('rejects old Curator support and malformed replies without leaking text', async () => {
  const call = vi.fn(async () => env({ private: 'text' }));
  const client = makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: async () => ({ call, close: async () => {}, listTools: async () => [] }) });
  await expect(client.api.preview('output')).rejects.toThrow('Update Curator');
  expect(call).not.toHaveBeenCalled();
});

describe('a preview for a sub-page', () => {
  const guard = { version: 1, vault_namespace: 'vault', project_id: 'project', home_node_id: 'home', output_revision_id: 'output', home_version: 2,
    topology_hash: 'topology', configuration_digest: 'config', corrections_digest: 'corrections' };
  const base = { eligible: true, reasons: [], sections: ['Summary', 'Log'], target_kind: 'page', page_title: 'Page', page_path: 'Wikis/Page.md',
    project_title: 'Project', home_title: 'Home', home_path: 'Home.md', model: { ref: 'model', provider: 'openrouter', max_output_tokens: 2000 } };
  const clientReplying = (data: unknown) => makeHomeRefreshClient({ endpoint: 'https://curator.example/mcp', token: 'secret',
    connect: async () => ({ close: async () => {}, listTools: async () => ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(name => ({ name })) as any,
      call: async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data }) }] }) }) });
  it('is accepted with the page in its guard', async () => {
    const reply = { ...base, guard: { ...guard, page_node_id: 'page', page_version: 3 } };
    expect(await clientReplying(reply).api.preview('output')).toMatchObject({ target_kind: 'page', guard: { page_node_id: 'page', page_version: 3 } });
  });
  it.each([
    ['no page in its guard', { ...base, guard }],
    ['no version in its guard', { ...base, guard: { ...guard, page_node_id: 'page' } }],
    ['an unknown kind', { ...base, target_kind: 'other', guard: { ...guard, page_node_id: 'page', page_version: 3 } }],
    ['no kind at all', { ...base, target_kind: undefined, guard: { ...guard, page_node_id: 'page', page_version: 3 } }],
  ])('is refused with %s, since it could not be sent back as previewed', async (_label, reply) => {
    await expect(clientReplying(reply).api.preview('output')).rejects.toThrow('Invalid refresh preview');
  });
});
