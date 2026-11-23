import { describe, expect, it } from 'vitest';
import {
  discoverAnthropicModels,
  discoverFireworksModels,
  discoverModels,
  discoverOpenAiModels,
  discoverOpenRouterModels,
  DiscoveryKeyMissingError,
} from '../../src/settings/discovery.js';

// ---- Fireworks fixtures --------------------------------------------------

const KIMI_DESCRIPTION = 'x'.repeat(350); // > 300 chars, exercises the ~300-char truncation

const fireworksPage1 = {
  models: [
    {
      name: 'accounts/fireworks/models/kimi-k2p6',
      displayName: 'Kimi K2p6',
      description: KIMI_DESCRIPTION,
      kind: 'HF_BASE_MODEL',
      state: 'READY',
      public: true,
      supportsImageInput: true,
      supportsTools: true,
      supportsServerless: true,
      contextLength: 128000,
      deprecationDate: null,
    },
    {
      name: 'accounts/fireworks/models/embed-1',
      displayName: 'Embed 1',
      description: 'an embedding model',
      kind: 'EMBEDDING_MODEL',
      state: 'READY',
      public: true,
      supportsImageInput: false,
      supportsTools: false,
      supportsServerless: true,
      contextLength: 8192,
      deprecationDate: null,
    },
    {
      name: 'accounts/fireworks/models/not-ready-1',
      displayName: 'Not Ready',
      description: 'still being staged',
      kind: 'HF_BASE_MODEL',
      state: 'CREATING',
      public: true,
      supportsImageInput: false,
      supportsTools: false,
      supportsServerless: true,
      contextLength: 4096,
      deprecationDate: null,
    },
    {
      name: 'accounts/fireworks/models/private-1',
      displayName: 'Private One',
      description: 'not publicly listed',
      kind: 'HF_BASE_MODEL',
      state: 'READY',
      public: false,
      supportsImageInput: false,
      supportsTools: false,
      supportsServerless: true,
      contextLength: 4096,
      deprecationDate: null,
    },
  ],
  nextPageToken: '2',
  totalSize: 5,
};

const fireworksPage2 = {
  models: [
    {
      name: 'accounts/fireworks/models/qwen3p7-plus',
      displayName: 'Qwen3.7 Plus',
      description: 'Qwen 3.7 Plus model',
      kind: 'HF_BASE_MODEL',
      state: 'READY',
      public: true,
      supportsImageInput: false,
      supportsTools: true,
      supportsServerless: false,
      contextLength: 131072,
      deprecationDate: { time: '2027-01-01T00:00:00Z' },
    },
  ],
  nextPageToken: '',
  totalSize: 5,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---- OpenRouter fixtures --------------------------------------------------

const CLAUDE_DESCRIPTION = 'y'.repeat(400); // > 300 chars, exercises OpenRouter description truncation too

const openRouterFixture = {
  data: [
    {
      id: 'anthropic/claude-sonnet-5',
      name: 'Anthropic: Claude Sonnet 5',
      description: CLAUDE_DESCRIPTION,
      context_length: 200000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning'],
      pricing: {
        prompt: '0.000002',
        completion: '0.00001',
        input_cache_read: '0.0000005',
        input_cache_write: '0.0000025',
      },
      expiration_date: null,
    },
    {
      id: 'vendor/image-gen',
      name: 'Vendor: Image Gen',
      description: 'Generates images, not text',
      context_length: 8192,
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      supported_parameters: [],
      pricing: { prompt: '0.000001', completion: '0.000002' },
      expiration_date: null,
    },
    {
      id: 'vendor/free-model',
      name: 'Vendor: Free Model',
      description: 'A free-tier model with unpriced pricing strings',
      context_length: 32000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: [],
      pricing: { prompt: 'not-a-number', completion: '0.000001' },
      expiration_date: '2026-08-01',
    },
    {
      id: 'vendor/no-colon',
      name: 'NoColonName',
      description: 'A model whose name has no vendor prefix',
      context_length: 16000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000002' },
      expiration_date: null,
    },
    {
      id: 'vendor/partial-cache-price',
      name: 'Vendor: Partial Cache Price',
      description: 'Valid prompt/completion but a malformed cache-read price string',
      context_length: 64000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: [],
      pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: 'garbage', input_cache_write: '0.0000005' },
      expiration_date: null,
    },
  ],
};

describe('discoverFireworksModels', () => {
  it('paginates until nextPageToken is empty, filtering to public READY HF_BASE_MODEL entries', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url.includes('pageToken=2')) return jsonResponse(fireworksPage2);
      return jsonResponse(fireworksPage1);
    }) as typeof fetch;

    const result = await discoverFireworksModels('fw-test-key', fetchImpl);

    // pagination happened exactly twice, page size passed, auth header sent
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toContain('pageSize=200');
    expect(seen[0]!.url).not.toContain('pageToken');
    expect(seen[1]!.url).toContain('pageToken=2');
    expect(seen[0]!.headers.Authorization).toBe('Bearer fw-test-key');

    // kind/state/public filtering: embedding, non-ready, and non-public models dropped
    expect(result).toHaveLength(2);
    const byModel = new Map(result.map((m) => [m.model, m]));
    expect(byModel.has('accounts/fireworks/models/embed-1')).toBe(false);
    expect(byModel.has('accounts/fireworks/models/not-ready-1')).toBe(false);
    expect(byModel.has('accounts/fireworks/models/private-1')).toBe(false);

    const kimi = byModel.get('accounts/fireworks/models/kimi-k2p6');
    expect(kimi).toBeDefined();
    expect(kimi).toMatchObject({
      provider: 'fireworks',
      displayName: 'Kimi K2p6',
      vision: true,
      tools: true,
      contextLength: 128000,
      pricing: null,
      serverless: true,
      deprecated: false,
    });
    expect(kimi!.description.length).toBe(300);
    expect(kimi!.description).toBe(KIMI_DESCRIPTION.slice(0, 300));

    const qwen = byModel.get('accounts/fireworks/models/qwen3p7-plus');
    expect(qwen).toBeDefined();
    expect(qwen).toMatchObject({
      provider: 'fireworks',
      displayName: 'Qwen3.7 Plus',
      vision: false,
      tools: true,
      contextLength: 131072,
      pricing: null,
      serverless: false, // non-serverless kept — the serverless FILTER lives in the tool, not here
      deprecated: true, // deprecationDate is non-null
    });
  });

  it('maps a falsy contextLength to null', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        models: [
          {
            name: 'accounts/fireworks/models/no-context',
            displayName: 'No Context',
            description: 'no context length reported',
            kind: 'HF_BASE_MODEL',
            state: 'READY',
            public: true,
            supportsImageInput: false,
            supportsTools: false,
            supportsServerless: true,
            contextLength: 0,
            deprecationDate: null,
          },
        ],
        nextPageToken: '',
        totalSize: 1,
      })) as typeof fetch;

    const result = await discoverFireworksModels('fw-test-key', fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]!.contextLength).toBeNull();
  });

  it('stops paginating at a 10-page cap even if nextPageToken keeps coming back', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ models: [], nextPageToken: String(calls + 1), totalSize: 0 });
    }) as typeof fetch;

    await discoverFireworksModels('fw-test-key', fetchImpl);
    expect(calls).toBe(10);
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 401)) as typeof fetch;
    await expect(discoverFireworksModels('bad-key', fetchImpl)).rejects.toThrow('fireworks models API HTTP 401');
  });
});

describe('discoverOpenRouterModels', () => {
  it('filters by output modality and maps flags, pricing, deprecation, and displayName', async () => {
    const seen: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: init?.headers });
      return jsonResponse(openRouterFixture);
    }) as typeof fetch;

    const result = await discoverOpenRouterModels(fetchImpl);

    // no auth header sent
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(seen[0]!.headers).toBeUndefined();

    // output-modality filter: the image-output model is dropped, the rest kept
    expect(result).toHaveLength(4);
    const byModel = new Map(result.map((m) => [m.model, m]));
    expect(byModel.has('vendor/image-gen')).toBe(false);

    const claude = byModel.get('anthropic/claude-sonnet-5');
    expect(claude).toBeDefined();
    expect(claude).toMatchObject({
      provider: 'openrouter',
      displayName: 'Claude Sonnet 5', // "Anthropic: " prefix stripped
      vision: true,
      tools: true,
      contextLength: 200000,
      serverless: true,
      deprecated: false,
    });
    expect(claude!.pricing).toEqual({ input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 });
    // truncation applies to OpenRouter descriptions too, same as Fireworks
    expect(claude!.description.length).toBe(300);
    expect(claude!.description).toBe(CLAUDE_DESCRIPTION.slice(0, 300));

    const free = byModel.get('vendor/free-model');
    expect(free).toBeDefined();
    expect(free!.pricing).toBeNull(); // prompt price string doesn't parse -> whole pricing is null
    expect(free!.deprecated).toBe(true); // non-null expiration_date
    expect(free!.vision).toBe(false);
    expect(free!.tools).toBe(false);

    const noColon = byModel.get('vendor/no-colon');
    expect(noColon).toBeDefined();
    expect(noColon!.displayName).toBe('NoColonName'); // no vendor prefix to strip

    const partialCache = byModel.get('vendor/partial-cache-price');
    expect(partialCache).toBeDefined();
    // prompt/completion parse fine -> pricing object present; malformed cacheRead is independently omitted
    expect(partialCache!.pricing).toEqual({ input: 1, output: 2, cacheWrite: 0.5 });
    expect(partialCache!.pricing).not.toHaveProperty('cacheRead');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 500)) as typeof fetch;
    await expect(discoverOpenRouterModels(fetchImpl)).rejects.toThrow('openrouter models API HTTP 500');
  });
});

describe('discoverAnthropicModels', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('pages by after_id, sends the key headers, and maps capabilities, context and deprecation', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const pages = [
      { data: [{ id: 'claude-a', display_name: 'Claude A', max_input_tokens: 200_000, capabilities: { image_input: { supported: true } }, deprecated_at: null }], has_more: true, last_id: 'claude-a' },
      { data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', capabilities: { image_input: { supported: false } }, deprecated_at: '2026-12-01T00:00:00Z' }], has_more: false, last_id: 'claude-sonnet-4-6' },
    ];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      headers.push(init?.headers as Record<string, string>);
      return json(pages[urls.length - 1]);
    }) as typeof fetch;

    const models = await discoverAnthropicModels('ak', fetchImpl);
    expect(urls[0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(urls[1]).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a');
    expect(headers[0]).toEqual({ 'x-api-key': 'ak', 'anthropic-version': '2023-06-01' });
    expect(models).toEqual([
      { provider: 'anthropic', model: 'claude-a', displayName: 'Claude A', description: '', vision: true, tools: true,
        contextLength: 200_000, pricing: null, serverless: true, deprecated: false },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', description: '', vision: false, tools: true,
        contextLength: null, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, serverless: true, deprecated: true },
    ]);
  });

  it('throws on an HTTP failure', async () => {
    await expect(discoverAnthropicModels('ak', (async () => new Response('', { status: 401 })) as typeof fetch))
      .rejects.toThrow('anthropic models API HTTP 401');
  });
});

describe('discoverOpenAiModels', () => {
  it('keeps text chat models, infers image input by family, and prices exact table ids', async () => {
    let auth = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization!;
      return new Response(JSON.stringify({ data: [
        { id: 'gpt-5.6-luna' }, { id: 'gpt-4.1-mini' }, { id: 'o3-mini' }, { id: 'o4-mini', shutdown_date: '2027-01-01' },
        { id: 'gpt-6.1-terra' },
        { id: 'gpt-5-pro' }, { id: 'gpt-5.4-pro-2026-03-05' }, { id: 'gpt-5.3-codex' }, { id: 'gpt-4o-audio-preview' },
        { id: 'gpt-realtime' }, { id: 'gpt-image-1' }, { id: 'text-embedding-3-small' }, { id: 'tts-1' },
        { id: 'gpt-3.5-turbo-instruct' }, { id: 'o4-mini-deep-research' },
      ] }), { status: 200 });
    }) as typeof fetch;

    const models = await discoverOpenAiModels('sk', fetchImpl);
    expect(auth).toBe('Bearer sk');
    expect(models.map(m => [m.model, m.vision, m.deprecated])).toEqual([
      ['gpt-5.6-luna', true, false], ['gpt-4.1-mini', true, false], ['o3-mini', false, false], ['o4-mini', true, true],
      ['gpt-6.1-terra', true, false],
    ]);
    expect(models[0]!.pricing).toEqual({ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 });
    expect(models[1]!.pricing).toBeNull();
  });
});

describe('discoverModels', () => {
  it.each([
    ['fireworks', 'FIREWORKS_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ] as const)('needs the %s key on the engine', async (provider, envVar) => {
    const fetchImpl = (async () => { throw new Error('must not fetch'); }) as typeof fetch;
    await expect(discoverModels(provider, { [envVar]: '  ' }, fetchImpl)).rejects.toBeInstanceOf(DiscoveryKeyMissingError);
    await expect(discoverModels(provider, {}, fetchImpl)).rejects.toThrow(`${envVar} not configured on the engine`);
  });

  it('lists openrouter without a key', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await expect(discoverModels('openrouter', {}, fetchImpl)).resolves.toEqual([]);
  });
});
