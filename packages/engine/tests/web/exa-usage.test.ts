import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { ExaSearchProvider } from '../../src/web/provider.js';

function fakeFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

describe('ExaSearchProvider usage capture', () => {
  it('records the provider-reported dollars + request id', async () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const recorder = new UsageRecorder(db);
    const provider = new ExaSearchProvider('key', fakeFetch({
      requestId: 'req-42',
      costDollars: { total: 0.0125 },
      results: [{ title: 't', url: 'https://x', text: 'snippet' }],
    }), recorder);

    const results = await provider.search('test query', { numResults: 5 });
    expect(results).toHaveLength(1);

    const row = db.prepare('SELECT * FROM usage_events').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      provider: 'exa', service: 'engine', purpose: 'web-search',
      cost_usd: 0.0125, cost_basis: 'provider-reported',
      source_ref: 'test query', request_id: 'req-42',
    });
    db.close();
  });

  it('records unpriced — not a $0 provider-reported row — when Exa omits costDollars', async () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const recorder = new UsageRecorder(db);
    const provider = new ExaSearchProvider('key', fakeFetch({
      requestId: 'req-43',
      results: [{ title: 't', url: 'https://x', text: 'snippet' }],
    }), recorder);

    await provider.search('costless query', { numResults: 5 });

    const row = db.prepare('SELECT * FROM usage_events').get() as Record<string, unknown>;
    // A missing cost is unknown, not free. Recording `provider-reported` $0 makes
    // the ledger assert Exa told us it was free, which it never did.
    expect(row).toMatchObject({
      provider: 'exa', service: 'engine', purpose: 'web-search',
      cost_usd: 0, cost_basis: 'unpriced', request_id: 'req-43',
    });
    db.close();
  });

  it('records nothing without a recorder (and still parses)', async () => {
    const provider = new ExaSearchProvider('key', fakeFetch({ results: [] }));
    await expect(provider.search('q', { numResults: 1 })).resolves.toEqual([]);
  });
});
