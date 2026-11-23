import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { makeTurnResolver, type TurnSettingsClient } from '../../src/chat/turn-resolution.js';

const qwen: ModelCatalogEntry = { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true };
const claude: ModelCatalogEntry = { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true };

function fakeClient(overrides: Partial<TurnSettingsClient> = {}): TurnSettingsClient {
  return {
    resolveRef: async () => null,
    resolvedDefault: async () => qwen,
    effective: async () => ({ settings: { maxSteps: 12 } }),
    ...overrides,
  };
}

const makeModel = (entry: ModelCatalogEntry) => entry.model as unknown as LanguageModel;
const keys = { fireworks: 'fw-key', anthropic: 'ant-key' };

describe('makeTurnResolver', () => {
  it('no override → surface default with live maxSteps', async () => {
    const r = makeTurnResolver({ settingsClient: fakeClient(), keys, makeModel });
    const t = await r.turn();
    expect(t.entry).toEqual(qwen);
    expect(t.maxSteps).toBe(12);
    expect(t.model).toBe(qwen.model);
  });

  it('picker selection resolves strictly and wins over the default', async () => {
    const resolveRef = vi.fn(async (ref: string) => (ref === claude.title ? claude : null));
    const r = makeTurnResolver({ settingsClient: fakeClient({ resolveRef }), keys, makeModel });
    r.onModelRefChange(claude.title);
    const t = await r.turn();
    expect(t.entry).toEqual(claude);
    expect(resolveRef).toHaveBeenCalledWith(claude.title, expect.anything());
  });

  it('a dangling ref degrades to the default and warns ONCE per distinct value, re-warning after a clean resolve', async () => {
    let resolvable = false;
    const client = fakeClient({ resolveRef: async () => (resolvable ? claude : null) });
    const warn = vi.fn();
    const r = makeTurnResolver({ settingsClient: client, keys, makeModel, warn });
    r.onModelRefChange('Ghost Model');

    expect((await r.turn()).entry).toEqual(qwen); // degraded, not blocked
    await r.turn();
    expect(warn).toHaveBeenCalledTimes(1); // deduped while it stays stale

    resolvable = true; // ref heals (note restored / key re-added)
    await r.turn();
    expect(warn).toHaveBeenCalledTimes(1);

    resolvable = false; // dangles again → re-warn (single-slot dedup cleared by the clean resolve)
    await r.turn();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('clearing the selection (null) skips resolveRef entirely', async () => {
    const resolveRef = vi.fn(async () => claude);
    const r = makeTurnResolver({ settingsClient: fakeClient({ resolveRef }), keys, makeModel });
    r.onModelRefChange(claude.title);
    r.onModelRefChange(null);
    expect((await r.turn()).entry).toEqual(qwen);
    expect(resolveRef).not.toHaveBeenCalled();
  });
});
