import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFetchUrl } from '../../src/mcp/tools/fetch-url.js';
import type { LookupFn } from '../../src/web/fetch-url.js';

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}
const envelope = async (s: McpServer, name: string, args: Record<string, unknown>) =>
  JSON.parse((await callTool(s, name, args)).content[0].text);

describe('fetch-url tool', () => {
  it('returns ok with readable content on success', async () => {
    const fakeFetch = (async () =>
      new Response('<html><script>x()</script><body><p>Hello <b>world</b></p></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    const server = new McpServer({ name: 't', version: '0' });
    registerFetchUrl(server, fakeFetch, publicLookup);
    const out = await envelope(server, 'fetch-url', { url: 'https://example.com/a' });
    expect(out.ok).toBe(true);
    expect(out.data.content).toContain('Hello world');
    expect(out.data.content).not.toContain('x()');
  });

  it('maps a private host to INVALID_PARAMS', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerFetchUrl(server); // textual guard rejects 127.* before any DNS/fetch
    const out = await envelope(server, 'fetch-url', { url: 'http://127.0.0.1:3334/mcp' });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('INVALID_PARAMS');
    expect(out.error.message).toMatch(/private/i);
  });

  it('maps a non-200 response to UPSTREAM_ERROR', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const server = new McpServer({ name: 't', version: '0' });
    registerFetchUrl(server, fakeFetch, publicLookup);
    const out = await envelope(server, 'fetch-url', { url: 'https://example.com/a' });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('UPSTREAM_ERROR');
  });
});
