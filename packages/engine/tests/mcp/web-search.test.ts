// packages/engine/tests/mcp/web-search.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWebSearch } from '../../src/mcp/tools/web-search.js';
import { WebError } from '../../src/web/errors.js';
import type { WebSearchProvider, WebSearchResult } from '../../src/web/provider.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}
const envelope = async (s: McpServer, name: string, args: Record<string, unknown>) =>
  JSON.parse((await callTool(s, name, args)).content[0].text);

function fakeProvider(opts: {
  results?: WebSearchResult[];
  record?: (q: string, numResults: number) => void;
  throwErr?: unknown;
}): WebSearchProvider {
  return {
    name: 'fake',
    async search(query, o) {
      opts.record?.(query, o.numResults);
      if (opts.throwErr) throw opts.throwErr;
      return opts.results ?? [];
    },
  };
}

describe('web-search tool', () => {
  it('maps provider results into the envelope', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerWebSearch(server, fakeProvider({ results: [{ title: 'T', url: 'https://x', snippet: 's', published: '2026-01-01' }] }));
    const out = await envelope(server, 'web-search', { query: 'hello' });
    expect(out.ok).toBe(true);
    expect(out.data.results[0].title).toBe('T');
  });

  it('clamps num_results to 1..10', async () => {
    const seen: number[] = [];
    const server = new McpServer({ name: 't', version: '0' });
    registerWebSearch(server, fakeProvider({ record: (_q, n) => seen.push(n) }));
    await envelope(server, 'web-search', { query: 'x', num_results: 0 });
    await envelope(server, 'web-search', { query: 'x', num_results: 99 });
    await envelope(server, 'web-search', { query: 'x' });
    expect(seen).toEqual([1, 10, 5]);
  });

  it('rejects an empty query with INVALID_PARAMS (provider not called)', async () => {
    let called = false;
    const server = new McpServer({ name: 't', version: '0' });
    registerWebSearch(server, fakeProvider({ record: () => { called = true; } }));
    const out = await envelope(server, 'web-search', { query: '   ' });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('INVALID_PARAMS');
    expect(called).toBe(false);
  });

  it('maps a provider WebError to the matching fail code', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerWebSearch(server, fakeProvider({ throwErr: new WebError('UPSTREAM_ERROR', 'Exa search failed: HTTP 500') }));
    const out = await envelope(server, 'web-search', { query: 'x' });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('UPSTREAM_ERROR');
  });
});
