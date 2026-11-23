import { fireworksPricingResolver } from '../../src/settings/fireworks-pricing.js';
import { ratePage } from '../helpers/fireworks-pricing.js';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { registerAddModel } from '../../src/mcp/tools/add-model.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let writeLock: WriteLockManager; let service: SettingsService;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  service = new SettingsService(db, { settingsDir: 'Settings' });
});
afterEach(() => cleanup());

const noteDeps = () => ({ db, writeLock, vaultPath, service });

function modelNote(title: string, fields: Record<string, unknown>): void {
  executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: `Settings/Models/${title}.md`,
    title, types: [], fields, body: 'seeded for test',
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// OpenRouter fixture: one vision+tools model with pricing, one plain model.
const OPENROUTER_FIXTURE = {
  data: [
    {
      id: 'vendor/fancy-vision', name: 'Vendor: Fancy Vision', description: 'a fancy vision model',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.0000005', completion: '0.0000015', input_cache_read: '0.00000005' },
      expiration_date: null,
    },
    {
      id: 'vendor/plain', name: 'Vendor: Plain', description: 'a plain model', context_length: 8000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: [], pricing: { prompt: '0.000001', completion: '0.000002' }, expiration_date: null,
    },
  ],
};
const openRouterFetch = (): typeof fetch => (async () => jsonResponse(OPENROUTER_FIXTURE)) as typeof fetch;

const FIREWORKS_FIXTURE = {
  models: [
    {
      name: 'accounts/fireworks/models/alpha', displayName: 'Alpha Model', description: 'a',
      kind: 'HF_BASE_MODEL', state: 'READY', public: true,
      supportsImageInput: false, supportsTools: true, supportsServerless: true,
      contextLength: 32000, deprecationDate: null,
    },
  ],
  nextPageToken: '', totalSize: 1,
};
const fireworksFetch = (): typeof fetch => (async () => jsonResponse(FIREWORKS_FIXTURE)) as typeof fetch;

const ANTHROPIC_FIXTURE = {
  data: [{
    id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000,
    capabilities: { image_input: { supported: true } }, deprecated_at: null, lifecycle: 'active',
  }],
  has_more: false, last_id: 'claude-sonnet-4-6',
};
const OPENAI_FIXTURE = { data: [{ id: 'gpt-test-chat', shutdown_date: null }, { id: 'gpt-6-luna', shutdown_date: null }] };
const keyedFetch = (body: unknown, seen: Array<{ url: string; headers: Record<string, string> }>): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return jsonResponse(body);
  }) as typeof fetch;

interface HandlerOpts {
  env?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  catalog?: ModelCatalog;
  onCatalogChange?: () => void;
}
function handler(opts: HandlerOpts) {
  const captured: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  const fake = {
    tool: (name: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured[name] = (args) => Promise.resolve(h(args));
    },
  } as unknown as McpServer;
  const catalog = opts.catalog ?? new ModelCatalog(db, { settingsDir: 'Settings' });
  registerAddModel(fake, {
    catalog, noteDeps: noteDeps(), env: opts.env ?? {},
    fetchImpl: opts.fetchImpl, onCatalogChange: opts.onCatalogChange,
  });
  return { fn: captured['add-model']!, catalog };
}

const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

describe('add-model', () => {
  it('happy path: mints a Models/ note, catalog immediately resolves it, version bumped, onCatalogChange fired', async () => {
    let catalogChanges = 0;
    const { fn, catalog } = handler({ fetchImpl: openRouterFetch(), onCatalogChange: () => { catalogChanges++; } });
    const versionBefore = catalog.version();

    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/fancy-vision' }));
    expect(r.ok).toBe(true);
    expect(r.data.title).toBe('Fancy Vision');
    expect(r.data.entry).toMatchObject({
      title: 'Fancy Vision', provider: 'openrouter', model: 'vendor/fancy-vision', enabled: true,
      vision: true, tools: true, contextLength: 1_000_000,
      pricing: { input: 0.5, output: 1.5, cacheRead: 0.05 },
    });

    // Immediately resolvable through the live catalog.
    expect(catalog.resolve('Fancy Vision')!.model).toBe('vendor/fancy-vision');
    expect(catalog.version()).toBeGreaterThan(versionBefore);
    expect(catalogChanges).toBeGreaterThanOrEqual(1);

    // The note actually exists on disk with capability frontmatter.
    const raw = readFileSync(join(vaultPath, 'Settings/Models/Fancy Vision.md'), 'utf8');
    expect(raw).toContain('provider: openrouter');
    expect(raw).toContain('vision: true');
  });

  it('respects an explicit title and enabled:false', async () => {
    const { fn, catalog } = handler({ fetchImpl: openRouterFetch() });
    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/plain', title: 'My Plain', enabled: false }));
    expect(r.ok).toBe(true);
    expect(r.data.title).toBe('My Plain');
    // Disabled entries exist but do not resolve.
    expect(catalog.resolve('My Plain')).toBeNull();
    expect(catalog.entries().find(e => e.title === 'My Plain')!.enabled).toBe(false);
  });

  it('sanitizes a display name with filename-hostile characters', async () => {
    const fixture = {
      data: [{
        id: 'vendor/slashy', name: 'Vendor: A/B: C#D', description: 'x', context_length: 8000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: [], pricing: { prompt: '0', completion: '0' }, expiration_date: null,
      }],
    };
    const { fn } = handler({ fetchImpl: (async () => jsonResponse(fixture)) as typeof fetch });
    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/slashy' }));
    expect(r.ok).toBe(true);
    expect(r.data.title).toBe('A-B- C-D');
  });

  it('fails NOT_FOUND for a model id absent from the provider catalog', async () => {
    const { fn } = handler({ fetchImpl: openRouterFetch() });
    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/does-not-exist' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.message).toMatch(/openrouter/);
  });

  it('fails CONFLICT when the same model id is already in the catalog', async () => {
    modelNote('Preexisting', { provider: 'openrouter', model: 'vendor/fancy-vision', enabled: true });
    const { fn } = handler({ fetchImpl: openRouterFetch(), catalog: new ModelCatalog(db, { settingsDir: 'Settings' }) });
    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/fancy-vision' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.message).toContain('Preexisting');   // names the existing title
  });

  it('fails CONFLICT when the target title is already taken', async () => {
    modelNote('Fancy Vision', { provider: 'fireworks', model: 'accounts/fireworks/models/other', enabled: true });
    const { fn } = handler({ fetchImpl: openRouterFetch(), catalog: new ModelCatalog(db, { settingsDir: 'Settings' }) });
    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/fancy-vision' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('CONFLICT');
  });

  it('fails CONFLICT, leaving the note and the catalog alone, when an unindexed note holds the path', async () => {
    let catalogChanges = 0;
    const { fn, catalog } = handler({ fetchImpl: openRouterFetch(), onCatalogChange: () => { catalogChanges++; } });
    const versionBefore = catalog.version();
    const notePath = join(vaultPath, 'Settings/Models/Fancy Vision.md');
    mkdirSync(join(vaultPath, 'Settings/Models'), { recursive: true });
    writeFileSync(notePath, 'saved before Engine indexed it\n');

    const r = parse(await fn({ provider: 'openrouter', model: 'vendor/fancy-vision' }));

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('CONFLICT');
    expect(readFileSync(notePath, 'utf8')).toBe('saved before Engine indexed it\n');
    expect(catalog.version()).toBe(versionBefore);
    expect(catalogChanges).toBe(0);
  });

  it('fails INVALID_PARAMS for fireworks without an API key (mirrors discover-models)', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse(FIREWORKS_FIXTURE); }) as typeof fetch;
    const { fn } = handler({ env: {}, fetchImpl });
    const r = parse(await fn({ provider: 'fireworks', model: 'accounts/fireworks/models/alpha' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_PARAMS');
    expect(called).toBe(false);
  });

  it('maps a discovery HTTP failure to UPSTREAM_ERROR', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 500)) as typeof fetch;
    const { fn } = handler({ env: { FIREWORKS_API_KEY: 'key' }, fetchImpl });
    const r = parse(await fn({ provider: 'fireworks', model: 'accounts/fireworks/models/alpha' }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('UPSTREAM_ERROR');
  });

  it('fireworks happy path stores capability booleans (no pricing)', async () => {
    const { fn, catalog } = handler({ env: { FIREWORKS_API_KEY: 'key' }, fetchImpl: fireworksFetch() });
    const r = parse(await fn({ provider: 'fireworks', model: 'accounts/fireworks/models/alpha' }));
    expect(r.ok).toBe(true);
    expect(r.data.entry).toMatchObject({ provider: 'fireworks', tools: true, vision: false, contextLength: 32000 });
    expect(r.data.entry.pricing).toBeUndefined();
    expect(catalog.resolve('Alpha Model')!.model).toBe('accounts/fireworks/models/alpha');
  });

  it('revalidates cached Fireworks pricing and persists the fresh rates through the model note', async () => {
    const model = 'accounts/fireworks/models/alpha';
    let rates = '$2 / $0.25 / $6';
    let pageCalls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).startsWith('https://api.fireworks.ai/')) return jsonResponse(FIREWORKS_FIXTURE);
      pageCalls++;
      return new Response(ratePage(model, rates));
    };
    await fireworksPricingResolver(fetchImpl).resolve(model);
    rates = '$3 / $0.5 / $9';
    const { fn, catalog } = handler({ env: { FIREWORKS_API_KEY: 'key' }, fetchImpl });
    const r = parse(await fn({ provider: 'fireworks', model }));
    expect(r.ok).toBe(true);
    expect(pageCalls).toBe(2);
    expect(catalog.resolve('Alpha Model')!.pricing).toEqual({ input: 3, output: 9, cacheRead: 0.5 });
    expect(readFileSync(join(vaultPath, 'Settings/Models/Alpha Model.md'), 'utf8')).toContain('price_input: 3');
  });

  it('allows adding an unpriced model when its pricing page is unavailable', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).startsWith('https://api.fireworks.ai/')) return jsonResponse(FIREWORKS_FIXTURE);
      throw new Error('Pricing source down');
    };
    const { fn, catalog } = handler({ env: { FIREWORKS_API_KEY: 'key' }, fetchImpl });
    const r = parse(await fn({ provider: 'fireworks', model: 'accounts/fireworks/models/alpha' }));
    expect(r.ok).toBe(true);
    expect(catalog.resolve('Alpha Model')!.pricing).toBeUndefined();
  });

  it('adds an anthropic model with its listed capabilities and the static list price', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const { fn, catalog } = handler({ env: { ANTHROPIC_API_KEY: 'ak' }, fetchImpl: keyedFetch(ANTHROPIC_FIXTURE, seen) });
    const r = parse(await fn({ provider: 'anthropic', model: 'claude-sonnet-4-6', title: 'Claude Sonnet Test' }));
    expect(r.ok).toBe(true);
    expect(seen[0]!.url).toContain('https://api.anthropic.com/v1/models');
    expect(seen[0]!.headers['x-api-key']).toBe('ak');
    expect(catalog.resolve('Claude Sonnet Test')).toMatchObject({
      provider: 'anthropic', model: 'claude-sonnet-4-6', vision: true, contextLength: 1_000_000,
      pricing: { input: 3, output: 15 },
    });
  });

  it('adds an openai model with the pricing and vision arguments overriding discovery', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const { fn, catalog } = handler({ env: { OPENAI_API_KEY: 'sk' }, fetchImpl: keyedFetch(OPENAI_FIXTURE, seen) });
    const r = parse(await fn({
      provider: 'openai', model: 'gpt-test-chat', title: 'GPT Test',
      vision: false, pricing: { input: 1.25, output: 10, cache_read: 0.125 },
    }));
    expect(r.ok).toBe(true);
    expect(seen[0]!.headers.Authorization).toBe('Bearer sk');
    const entry = catalog.resolve('GPT Test')!;
    expect(entry).toMatchObject({ provider: 'openai', model: 'gpt-test-chat', vision: false });
    expect(entry.pricing).toEqual({ input: 1.25, output: 10, cacheRead: 0.125 });
    const raw = readFileSync(join(vaultPath, 'Settings/Models/GPT Test.md'), 'utf8');
    expect(raw).toContain('provider: openai');
    expect(raw).toContain('price_input: 1.25');
  });

  it('takes an openai model\'s price from the static table when it has one', async () => {
    const { fn, catalog } = handler({ env: { OPENAI_API_KEY: 'sk' }, fetchImpl: keyedFetch(OPENAI_FIXTURE, []) });
    expect(parse(await fn({ provider: 'openai', model: 'gpt-6-luna', title: 'GPT-6 Luna' })).ok).toBe(true);
    expect(catalog.resolve('GPT-6 Luna')).toMatchObject({ vision: true, pricing: { input: 0.1, output: 0.5 } });
  });

  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ] as const)('fails INVALID_PARAMS for %s without its key on the engine', async (provider, envVar) => {
    const { fn } = handler({ fetchImpl: keyedFetch({}, []) });
    const r = parse(await fn({ provider, model: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'INVALID_PARAMS', message: `${envVar} not configured on the engine` });
  });
});
