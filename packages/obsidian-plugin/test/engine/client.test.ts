import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { unwrapEnvelope, makeEngineClient } from '../../src/engine/client.js';
import { bearerHeaders } from '../../src/engine/transport.js';

function textResult(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] } as CallToolResult;
}

describe('bearerHeaders', () => {
  it('builds an Authorization header from a token', () => {
    expect(bearerHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
  it('omits the header when the token is empty', () => {
    expect(bearerHeaders('')).toEqual({});
  });
});

describe('unwrapEnvelope', () => {
  it('parses the envelope from the first text block', () => {
    expect(unwrapEnvelope(textResult({ ok: true, data: { node_count: 5 } })))
      .toEqual({ ok: true, data: { node_count: 5 } });
  });
  it('throws when there is no text content', () => {
    expect(() => unwrapEnvelope({ content: [] } as unknown as CallToolResult)).toThrow();
  });
});

describe('makeEngineClient', () => {
  it('calls vault-stats with empty args and unwraps the result', async () => {
    const call = vi.fn(async () => textResult({ ok: true, data: { node_count: 7 } }));
    const env = await makeEngineClient(call).vaultStats();
    expect(call).toHaveBeenCalledWith({ name: 'vault-stats', arguments: {} });
    expect(env).toEqual({ ok: true, data: { node_count: 7 } });
  });
  it('passes query args verbatim to query-nodes', async () => {
    const call = vi.fn(async () => textResult({ ok: true, data: { nodes: [], total: 0 } }));
    await makeEngineClient(call).queryNodes({ limit: 25, sort_by: 'file_mtime' });
    expect(call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { limit: 25, sort_by: 'file_mtime' } });
  });
});
