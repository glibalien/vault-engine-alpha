import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { PluginSettingsClient } from '../../src/engine/settings-client.js';

function textResult(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] } as CallToolResult;
}

const CATALOG: ModelCatalogEntry[] = [
  { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true },
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
];

function envelope(defaultModel: string, catalog: ModelCatalogEntry[] = CATALOG): CallToolResult {
  return textResult({
    ok: true,
    data: {
      domains: {
        chat: {
          effective: { defaultModel, maxSteps: 10, contextBudget: 32768, responseReserve: 4096 },
          stored: {}, version: 1, seeded: true, issues: [],
        },
        models: { catalog, providers: {}, version: 1, issues: [] },
      },
    },
  });
}

describe('PluginSettingsClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('effective() fetches settings + catalog via one omit-domain get-settings call', async () => {
    const call = vi.fn(async () => envelope('[[Claude Sonnet 4.6]]'));
    const client = new PluginSettingsClient(call);
    const { settings, catalog } = await client.effective();
    expect(call).toHaveBeenCalledWith({ name: 'get-settings', arguments: {} });
    expect(settings.defaultModel).toBe('[[Claude Sonnet 4.6]]');
    expect(settings.maxSteps).toBe(10);
    expect(catalog).toEqual(CATALOG);
  });

  it('reports the settings folder Engine names, and Settings for an Engine that names none (#449)', async () => {
    const withDir = (settingsDir: string) => {
      const body = JSON.parse((envelope('[[Qwen 3.7 Plus]]').content[0] as { text: string }).text);
      return textResult({ ...body, data: { ...body.data, settingsDir } });
    };
    expect((await new PluginSettingsClient(vi.fn(async () => withDir('Config'))).effective()).settingsDir).toBe('Config');
    expect((await new PluginSettingsClient(vi.fn(async () => envelope('[[Qwen 3.7 Plus]]'))).effective()).settingsDir).toBe('Settings');
    expect((await new PluginSettingsClient(vi.fn(async () => { throw new Error('down'); })).effective()).settingsDir).toBe('Settings');
  });

  it('serves registry defaults + SEED_MODELS before the first successful fetch (sync construction)', () => {
    // No await — just verifying the constructor doesn't need a round-trip to exist.
    const call = vi.fn(async () => envelope('[[Qwen 3.7 Plus]]'));
    expect(() => new PluginSettingsClient(call)).not.toThrow();
  });

  it('TTL: does not refetch within 30s, refetches once the window elapses', async () => {
    const call = vi.fn(async () => envelope('[[Claude Sonnet 4.6]]'));
    const client = new PluginSettingsClient(call);
    await client.effective();
    expect(call).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_000);
    await client.effective();
    expect(call).toHaveBeenCalledTimes(1); // still inside the TTL window

    vi.advanceTimersByTime(2_000);
    await client.effective();
    expect(call).toHaveBeenCalledTimes(2); // window elapsed
  });

  it('serves the last-known snapshot when a refresh fails, and arms the TTL anyway', async () => {
    const call = vi.fn(async () => envelope('[[Claude Sonnet 4.6]]'));
    const client = new PluginSettingsClient(call);
    await client.effective(); // primes the snapshot

    call.mockImplementationOnce(async () => { throw new Error('engine unreachable'); });
    vi.advanceTimersByTime(31_000);
    const { settings } = await client.effective();
    expect(settings.defaultModel).toBe('[[Claude Sonnet 4.6]]'); // last-known, not cleared

    // The failed refresh still armed the TTL — no hammering on the next call.
    vi.advanceTimersByTime(1_000);
    await client.effective();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('resolvedDefault: resolves the stored default when its provider is available', async () => {
    const call = vi.fn(async () => envelope('[[Claude Sonnet 4.6]]'));
    const client = new PluginSettingsClient(call);
    const entry = await client.resolvedDefault({ fireworks: true, anthropic: true, openrouter: false, openai: false });
    expect(entry.title).toBe('Claude Sonnet 4.6');
  });

  it('resolvedDefault: falls back to the registry default when the stored default’s provider is unavailable', async () => {
    const call = vi.fn(async () => envelope('[[Claude Sonnet 4.6]]'));
    const client = new PluginSettingsClient(call);
    const entry = await client.resolvedDefault({ fireworks: true, anthropic: false, openrouter: false, openai: false });
    expect(entry.title).toBe('Qwen 3.7 Plus'); // registry default '[[Qwen 3.7 Plus]]', fireworks available
  });

  it('resolvedDefault: falls back to the FALLBACK synthetic entry when nothing in the catalog resolves', async () => {
    const call = vi.fn(async () => envelope('[[Claude Sonnet 4.6]]', []));
    const client = new PluginSettingsClient(call);
    const entry = await client.resolvedDefault({ fireworks: false, anthropic: false, openrouter: false, openai: false });
    expect(entry.title).toBe('Qwen 3.7 Plus');
    expect(entry.model).toBe('accounts/fireworks/models/qwen3p7-plus');
    expect(entry.provider).toBe('fireworks');
  });

  it('resolvedDefault (Finding 1): default + registry default both unavailable (no fireworks key) → falls to the first enabled+available catalog entry, not the synthetic Qwen fallback', async () => {
    // CATALOG = [Qwen 3.7 Plus (fireworks), Claude Sonnet 4.6 (anthropic)]. '[[Ghost Model]]' dangles
    // (no catalog entry); the registry default '[[Qwen 3.7 Plus]]' resolves but fireworks is
    // unavailable here — mirrors the web's equivalent Finding 1 test in settings.test.ts.
    const call = vi.fn(async () => envelope('[[Ghost Model]]'));
    const client = new PluginSettingsClient(call);
    const entry = await client.resolvedDefault({ fireworks: false, anthropic: true, openrouter: false, openai: false });
    expect(entry).toEqual({ title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true });
  });

  it('resolvedDefault (Finding 1): NO enabled+available catalog entry at all → the synthetic FALLBACK entry is still returned', async () => {
    const call = vi.fn(async () => envelope('[[Ghost Model]]'));
    const client = new PluginSettingsClient(call);
    const entry = await client.resolvedDefault({ fireworks: false, anthropic: false, openrouter: false, openai: false });
    expect(entry.title).toBe('Qwen 3.7 Plus');
    expect(entry.model).toBe('accounts/fireworks/models/qwen3p7-plus');
    expect(entry.provider).toBe('fireworks');
  });

  it('resolvedDefault (Finding 2): dangling default warns exactly once across repeated calls; a clean resolve resets the slot, a new distinct dangling value warns again', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let defaultModel = '[[Ghost]]';
    const call = vi.fn(async () => envelope(defaultModel));
    const client = new PluginSettingsClient(call);

    await client.resolvedDefault({ fireworks: true, anthropic: true, openrouter: false, openai: false }); // '[[Ghost]]' dangles → warn #1
    await client.resolvedDefault({ fireworks: true, anthropic: true, openrouter: false, openai: false }); // still within TTL, same value → suppressed
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('Ghost')).length).toBe(1);

    defaultModel = '[[Qwen 3.7 Plus]]';
    vi.advanceTimersByTime(31_000);
    await client.resolvedDefault({ fireworks: true, anthropic: true, openrouter: false, openai: false }); // clean resolve → resets the warn slot

    defaultModel = '[[Ghost]]';
    vi.advanceTimersByTime(31_000);
    await client.resolvedDefault({ fireworks: true, anthropic: true, openrouter: false, openai: false }); // dangles again → warn #2 (would stay 1 without the reset)
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('Ghost')).length).toBe(2);

    warnSpy.mockRestore();
  });

  it('resolveRef: STRICT — null when the ref is unresolved or its provider unavailable, else the entry', async () => {
    const call = vi.fn(async () => envelope('[[Qwen 3.7 Plus]]'));
    const client = new PluginSettingsClient(call);
    expect(await client.resolveRef('Nonexistent Title', { fireworks: true, anthropic: true, openrouter: false, openai: false })).toBeNull();
    expect(await client.resolveRef('[[Claude Sonnet 4.6]]', { fireworks: true, anthropic: false, openrouter: false, openai: false })).toBeNull();
    const ok = await client.resolveRef('[[Claude Sonnet 4.6]]', { fireworks: true, anthropic: true, openrouter: false, openai: false });
    expect(ok?.title).toBe('Claude Sonnet 4.6');
  });
});
