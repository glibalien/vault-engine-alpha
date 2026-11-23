import { describe, expect, it, vi } from 'vitest';
import { makeRequestWikiPageHandler } from '../src/tools/request-wiki-page.js';

// The handler is a thin scope-guarded shim over core.requestWikiPage — mock the core.
vi.mock('../src/core.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core.js')>();
  return {
    ...mod,
    requestWikiPage: vi.fn(async () => ({
      ok: true, request_id: 1, status: 'fulfilled',
      page: { node_id: 'n1', title: 'Demo — X' },
      resolvedTo: { nodeId: 'n1', title: 'Demo — X', action: 'refreshed' },
    })),
  };
});
import { requestWikiPage } from '../src/core.js';

const deps = {} as Parameters<typeof makeRequestWikiPageHandler>[0];

describe('request-wiki-page tool', () => {
  it('rejects a bearer without curate:trigger', async () => {
    const handler = makeRequestWikiPageHandler(deps);
    const res = await handler(
      { project: 'Demo', title: 'X', mode: 'immediate' },
      { authInfo: { scopes: ['curate:read'] } },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('FORBIDDEN');
    expect(requestWikiPage).not.toHaveBeenCalled();
  });

  it('passes args + clientId through and returns the core payload', async () => {
    const handler = makeRequestWikiPageHandler(deps);
    const res = await handler(
      { project: 'Demo', title: 'X', brief: 'b', mode: 'next-run' },
      { authInfo: { scopes: ['curate:trigger'], clientId: 'client-9' } },
    );
    expect(requestWikiPage).toHaveBeenCalledWith(deps, {
      project: 'Demo', title: 'X', brief: 'b', mode: 'next-run', requestedBy: 'client-9',
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text).resolvedTo).toEqual({
      nodeId: 'n1', title: 'Demo — X', action: 'refreshed',
    });
  });

  it('passes requestedBy: undefined when the bearer carries no clientId', async () => {
    const handler = makeRequestWikiPageHandler(deps);
    await handler(
      { project: 'Demo', title: 'X', mode: 'immediate' },
      { authInfo: { scopes: ['curate:trigger'] } },
    );
    expect(requestWikiPage).toHaveBeenCalledWith(deps, {
      project: 'Demo', title: 'X', mode: 'immediate', requestedBy: undefined,
    });
  });

  it('marks the result isError when core returns ok:false', async () => {
    vi.mocked(requestWikiPage).mockResolvedValueOnce({ ok: false, error: { code: 'UNKNOWN_PROJECT', message: 'nope' } });
    const handler = makeRequestWikiPageHandler(deps);
    const res = await handler(
      { project: 'Nope', title: 'X', mode: 'immediate' },
      { authInfo: { scopes: ['curate:trigger'] } },
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error.code).toBe('UNKNOWN_PROJECT');
  });
});
