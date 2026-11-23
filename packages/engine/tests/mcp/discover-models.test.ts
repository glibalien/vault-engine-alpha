import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ratePage } from '../helpers/fireworks-pricing.js';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { registerDiscoverModels } from '../../src/mcp/tools/discover-models.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void; let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
});
afterEach(() => cleanup());

function modelNote(title: string, fields: Record<string, unknown>): void {
  executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: `Settings/Models/${title}.md`,
    title, types: [], fields, body: 'seeded for test',
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fireworksModel(overrides: Partial<{
  name: string; displayName: string; supportsImageInput: boolean; supportsTools: boolean;
  supportsServerless: boolean; contextLength: number;
}>) {
  return {
    name: overrides.name,
    displayName: overrides.displayName,
    description: 'a test model',
    kind: 'HF_BASE_MODEL',
    state: 'READY',
    public: true,
    supportsImageInput: overrides.supportsImageInput ?? false,
    supportsTools: overrides.supportsTools ?? true,
    supportsServerless: overrides.supportsServerless ?? true,
    contextLength: overrides.contextLength ?? 32000,
    deprecationDate: null,
  };
}

// Alpha/Zeta serverless, no vision; Beta non-serverless, vision; Gamma serverless
// + vision, seeded into the catalog by the 'inCatalog' tests.
const FIREWORKS_FIXTURE = {
  models: [
    fireworksModel({ name: 'accounts/fireworks/models/alpha', displayName: 'Alpha Model', supportsServerless: true, supportsImageInput: false }),
    fireworksModel({ name: 'accounts/fireworks/models/beta', displayName: 'Beta Model', supportsServerless: false, supportsImageInput: true }),
    fireworksModel({ name: 'accounts/fireworks/models/gamma', displayName: 'Gamma Model', supportsServerless: true, supportsImageInput: true }),
    fireworksModel({ name: 'accounts/fireworks/models/zeta', displayName: 'Zeta Model', supportsServerless: true, supportsImageInput: false }),
  ],
  nextPageToken: '',
  totalSize: 4,
};

function fireworksFetch(): typeof fetch {
  return (async () => jsonResponse(FIREWORKS_FIXTURE)) as typeof fetch;
}

function handler(env: Record<string, string | undefined>, fetchImpl: typeof fetch, catalog?: ModelCatalog) {
  const captured: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  const fake = {
    tool: (name: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured[name] = (args) => Promise.resolve(h(args));
    },
  } as unknown as McpServer;
  const cat = catalog ?? new ModelCatalog(db, { settingsDir: 'Settings' });
  registerDiscoverModels(fake, cat, env, fetchImpl);
  return captured['discover-models']!;
}

const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

describe('discover-models', () => {
  it('fails with a closed-union code when FIREWORKS_API_KEY is not configured', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse(FIREWORKS_FIXTURE); }) as typeof fetch;
    const h = handler({}, fetchImpl);
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_PARAMS');
    expect(r.error.message).toBe('FIREWORKS_API_KEY not configured on the engine');
    expect(called).toBe(false);
  });

  it('treats a blank FIREWORKS_API_KEY the same as missing', async () => {
    const h = handler({ FIREWORKS_API_KEY: '   ' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_PARAMS');
  });

  it('defaults to serverless-only fireworks models, sorted by displayName', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.ok).toBe(true);
    expect(r.data.total_before_limit).toBe(3);
    expect(r.data.models.map((m: { displayName: string }) => m.displayName)).toEqual(['Alpha Model', 'Gamma Model', 'Zeta Model']);
    expect(r.data.models.every((m: { serverless: boolean }) => m.serverless)).toBe(true);
  });

  it('include_non_serverless lifts the serverless filter', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks', include_non_serverless: true }));
    expect(r.ok).toBe(true);
    expect(r.data.total_before_limit).toBe(4);
    expect(r.data.models.map((m: { displayName: string }) => m.displayName).sort())
      .toEqual(['Alpha Model', 'Beta Model', 'Gamma Model', 'Zeta Model']);
  });

  it('marks inCatalog against a seeded catalog note (matches by model id)', async () => {
    modelNote('Gamma Existing', { provider: 'fireworks', model: 'accounts/fireworks/models/gamma', enabled: true });
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch(), catalog);
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.ok).toBe(true);
    const byName = new Map(r.data.models.map((m: { displayName: string; inCatalog: boolean }) => [m.displayName, m.inCatalog]));
    expect(byName.get('Alpha Model')).toBe(false);
    expect(byName.get('Zeta Model')).toBe(false);
    expect(byName.get('Gamma Model')).toBe(true);
    // inCatalog sorts last, even though 'Gamma Model' would otherwise sort before 'Zeta Model'
    expect(r.data.models.map((m: { displayName: string }) => m.displayName)).toEqual(['Alpha Model', 'Zeta Model', 'Gamma Model']);
  });

  it('a disabled catalog entry still counts as inCatalog (any entry, not just enabled)', async () => {
    modelNote('Gamma Disabled', { provider: 'fireworks', model: 'accounts/fireworks/models/gamma', enabled: false });
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch(), catalog);
    const r = parse(await h({ provider: 'fireworks' }));
    const gamma = r.data.models.find((m: { displayName: string }) => m.displayName === 'Gamma Model');
    expect(gamma.inCatalog).toBe(true);
  });

  it('query filters case-insensitively over displayName and model id', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks', query: 'ALPHA' }));
    expect(r.ok).toBe(true);
    expect(r.data.total_before_limit).toBe(1);
    expect(r.data.models.map((m: { displayName: string }) => m.displayName)).toEqual(['Alpha Model']);
  });

  it('vision filters to vision-capable models only, applied after the serverless default', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks', vision: true }));
    expect(r.ok).toBe(true);
    // Beta has vision but is non-serverless (filtered by default) — only Gamma remains
    expect(r.data.total_before_limit).toBe(1);
    expect(r.data.models.map((m: { displayName: string }) => m.displayName)).toEqual(['Gamma Model']);
  });

  it('vision + include_non_serverless surfaces the non-serverless vision model too', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks', vision: true, include_non_serverless: true }));
    expect(r.data.models.map((m: { displayName: string }) => m.displayName).sort())
      .toEqual(['Beta Model', 'Gamma Model']);
  });

  it('clamps limit to 1..100 and reports total_before_limit independent of the clamp', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const zero = parse(await h({ provider: 'fireworks', limit: 0 }));
    expect(zero.data.models).toHaveLength(1);
    expect(zero.data.total_before_limit).toBe(3);
    expect(zero.data.models[0].displayName).toBe('Alpha Model');

    const two = parse(await h({ provider: 'fireworks', limit: 2 }));
    expect(two.data.models).toHaveLength(2);
    expect(two.data.total_before_limit).toBe(3);

    const big = parse(await h({ provider: 'fireworks', limit: 500 }));
    expect(big.data.models).toHaveLength(3); // only 3 available even though clamp allows up to 100
  });

  it('defaults limit to 30 when omitted', async () => {
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch());
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.data.models).toHaveLength(3); // fewer than the default 30, so nothing truncated
  });

  it('maps discovery HTTP failures to a closed-union error code', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 500)) as typeof fetch;
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fetchImpl);
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('UPSTREAM_ERROR');
    expect(r.error.message).toMatch(/HTTP 500/);
  });

  it('maps unexpected post-processing errors (e.g. a catalog read failure) to INTERNAL_ERROR', async () => {
    const brokenCatalog = { entries: () => { throw new Error('catalog boom'); } } as unknown as ModelCatalog;
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fireworksFetch(), brokenCatalog);
    const r = parse(await h({ provider: 'fireworks' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INTERNAL_ERROR');
    expect(r.error.message).toBe('catalog boom');
  });

  it('openrouter needs no API key and is never serverless-filtered', async () => {
    const openRouterFixture = {
      data: [
        {
          id: 'vendor/one', name: 'Vendor: One', description: 'first', context_length: 8000,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: [], pricing: { prompt: '0.000001', completion: '0.000002' }, expiration_date: null,
        },
      ],
    };
    const fetchImpl = (async () => jsonResponse(openRouterFixture)) as typeof fetch;
    const h = handler({}, fetchImpl); // no FIREWORKS_API_KEY at all
    const r = parse(await h({ provider: 'openrouter' }));
    expect(r.ok).toBe(true);
    expect(r.data.models).toHaveLength(1);
    expect(r.data.models[0]).toMatchObject({ displayName: 'One', serverless: true, inCatalog: false });
  });

  it('enriches only filtered, sorted, limited results and leaves existing notes untouched', async () => {
    modelNote('Gamma Existing', { provider: 'fireworks', model: 'accounts/fireworks/models/gamma', enabled: true, price_input: 99, price_output: 99 });
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
    const path = join(vaultPath, 'Settings/Models/Gamma Existing.md');
    const before = readFileSync(path, 'utf8');
    const entriesBefore = catalog.entries();
    const version = catalog.version();
    const pages: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://api.fireworks.ai/')) return jsonResponse(FIREWORKS_FIXTURE);
      pages.push(u);
      return new Response(ratePage(`accounts/fireworks/models/${u.split('/').at(-1)}`));
    };
    const h = handler({ FIREWORKS_API_KEY: 'key' }, fetchImpl, catalog);
    const filtered = parse(await h({ provider: 'fireworks', vision: true, query: 'model', limit: 1 }));
    expect(filtered.data.models).toHaveLength(1);
    expect(filtered.data.models[0]).toMatchObject({ model: 'accounts/fireworks/models/gamma', inCatalog: true, pricing: { input: 2, output: 6, cacheRead: 0.25 } });
    expect(pages).toEqual(['https://fireworks.ai/models/fireworks/gamma']);
    const limited = parse(await h({ provider: 'fireworks', limit: 1 }));
    expect(limited.data.total_before_limit).toBe(3);
    expect(pages).toEqual(['https://fireworks.ai/models/fireworks/gamma', 'https://fireworks.ai/models/fireworks/alpha']);
    await h({ provider: 'fireworks', query: 'nothing' });
    expect(pages).toHaveLength(2);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(catalog.entries()).toEqual(entriesBefore);
    expect(catalog.version()).toBe(version);
  });
});
