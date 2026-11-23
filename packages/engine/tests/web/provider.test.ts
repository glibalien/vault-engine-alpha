// packages/engine/tests/web/provider.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExaSearchProvider } from '../../src/web/provider.js';
import { buildWebSearch } from '../../src/web/setup.js';
import { WebError } from '../../src/web/errors.js';

describe('ExaSearchProvider', () => {
  it('posts to Exa and maps results', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://x', text: 'snippet text', publishedDate: '2026-01-01' }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new ExaSearchProvider('exa-key', fakeFetch);
    const results = await provider.search('vault engines', { numResults: 5 });
    expect(results[0]).toEqual({ title: 'T', url: 'https://x', snippet: 'snippet text', published: '2026-01-01' });
    expect(requests[0]?.url).toBe('https://api.exa.ai/search');
    expect((requests[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('exa-key');
    expect(JSON.parse(String(requests[0]?.init.body)).numResults).toBe(5);
  });

  it('omits published when Exa returns none', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://x', text: 's' }] }), { status: 200 })) as typeof fetch;
    const results = await new ExaSearchProvider('k', fakeFetch).search('q', { numResults: 3 });
    expect('published' in results[0]!).toBe(false);
  });

  it('maps a non-200 Exa response to UPSTREAM_ERROR', async () => {
    const fakeFetch = (async () => new Response('sad', { status: 500 })) as typeof fetch;
    await expect(new ExaSearchProvider('k', fakeFetch).search('q', { numResults: 5 })).rejects.toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
  });

  it('maps a network error to UPSTREAM_ERROR', async () => {
    const fakeFetch = (async () => { throw new Error('boom'); }) as typeof fetch;
    const promise = new ExaSearchProvider('k', fakeFetch).search('q', { numResults: 5 });
    await expect(promise).rejects.toBeInstanceOf(WebError);
    await expect(new ExaSearchProvider('k', fakeFetch).search('q', { numResults: 5 })).rejects.toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
  });
});

describe('buildWebSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a null provider without EXA_API_KEY', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildWebSearch({}).provider).toBeNull();
    expect(buildWebSearch({ EXA_API_KEY: '   ' }).provider).toBeNull();
  });
  it('returns an ExaSearchProvider with EXA_API_KEY', () => {
    expect(buildWebSearch({ EXA_API_KEY: 'exa-key' }).provider).toBeInstanceOf(ExaSearchProvider);
  });
});
