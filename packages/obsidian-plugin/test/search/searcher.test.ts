import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EngineConnection } from '../../src/engine/transport.js';
import { makeEngineSearcher } from '../../src/search/searcher.js';

const SETTINGS = { engineUrl: 'http://e/mcp', token: 't', searchMode: 'hybrid' as const };

function textResult(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] } as CallToolResult;
}

function fakeConn(): EngineConnection {
  return {
    call: vi.fn(async () => textResult({ ok: true, data: { nodes: [], total: 0 }, warnings: [] })),
    close: vi.fn(async () => {}),
  } as unknown as EngineConnection;
}

describe('makeEngineSearcher', () => {
  it('connects once and reuses the connection across searches', async () => {
    const conn = fakeConn();
    const connect = vi.fn(async () => conn);
    const s = makeEngineSearcher(SETTINGS, connect);
    await s.search('a');
    await s.search('b');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith('http://e/mcp', 't');
    expect(conn.call).toHaveBeenCalledWith(expect.objectContaining({
      name: 'query-nodes',
      arguments: { query: 'a', search_mode: 'hybrid', limit: 100 },
    }));
  });

  it('returns ok:true with mapped hits from the engine', async () => {
    const conn = {
      call: vi.fn(async () =>
        textResult({ ok: true, data: { nodes: [{ id: 'n', file_path: 'p.md', title: 'P', types: ['note'], version: 1, field_count: 0, score: 1 }], total: 1 }, warnings: [] }),
      ),
      close: vi.fn(async () => {}),
    } as unknown as EngineConnection;
    const s = makeEngineSearcher(SETTINGS, async () => conn);
    const res = await s.search('q');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.hits.map((h) => h.title)).toEqual(['P']);
  });

  it('closes the connection it opened', async () => {
    const conn = fakeConn();
    const s = makeEngineSearcher(SETTINGS, async () => conn);
    await s.search('a');
    await s.close();
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('close() is a no-op when no search ever ran', async () => {
    const connect = vi.fn(async () => fakeConn());
    await makeEngineSearcher(SETTINGS, connect).close();
    expect(connect).not.toHaveBeenCalled();
  });

  it('surfaces a connection failure as ok:false and allows a later retry', async () => {
    let attempt = 0;
    const good = fakeConn();
    const connect = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('refused');
      return good;
    });
    const s = makeEngineSearcher(SETTINGS, connect);
    expect(await s.search('a')).toEqual({ ok: false, message: 'refused' });
    expect((await s.search('b')).ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
