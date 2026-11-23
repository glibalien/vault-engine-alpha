import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveCliModelRef, shortModelLabel } from '../../src/eval/model-ref.js';
import type { ModelCatalogEntry, ModelProvider } from '@vault/settings-registry';

const CATALOG: ModelCatalogEntry[] = [
  { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true },
  { title: 'DeepSeek v4 Pro', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-pro', enabled: true },
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
  { title: 'Old Model', provider: 'fireworks', model: 'accounts/fireworks/models/old', enabled: false },
];

function makeRegister(): { calls: Array<[string, ModelProvider]>; fn: (m: string, p: ModelProvider) => void } {
  const calls: Array<[string, ModelProvider]> = [];
  return { calls, fn: (m, p) => calls.push([m, p]) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shortModelLabel', () => {
  it('returns the trailing path segment for slash ids', () => {
    expect(shortModelLabel('accounts/fireworks/models/qwen3p7-plus')).toBe('qwen3p7-plus');
  });

  it('returns the id unchanged when it has no slash', () => {
    expect(shortModelLabel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('resolveCliModelRef', () => {
  it('resolves a catalog title to its model id and title label, and registers the provider', () => {
    const reg = makeRegister();
    const r = resolveCliModelRef(CATALOG, 'Qwen 3.7 Plus', { flagName: '--models', registerProvider: reg.fn });
    expect(r).toEqual({ model: 'accounts/fireworks/models/qwen3p7-plus', label: 'Qwen 3.7 Plus' });
    expect(reg.calls).toEqual([['accounts/fireworks/models/qwen3p7-plus', 'fireworks']]);
  });

  it('resolves a [[wikilink]] title the same way', () => {
    const reg = makeRegister();
    const r = resolveCliModelRef(CATALOG, '[[Claude Sonnet 4.6]]', { flagName: '--models', registerProvider: reg.fn });
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(reg.calls).toEqual([['claude-sonnet-4-6', 'anthropic']]);
  });

  it('resolves a raw id of an enabled catalog entry (provider registered, label = title)', () => {
    const reg = makeRegister();
    const r = resolveCliModelRef(CATALOG, 'accounts/fireworks/models/deepseek-v4-pro', { flagName: '--models', registerProvider: reg.fn });
    expect(r).toEqual({ model: 'accounts/fireworks/models/deepseek-v4-pro', label: 'DeepSeek v4 Pro' });
    expect(reg.calls).toHaveLength(1);
  });

  it('passes an unmatched ref through as a raw id with a warning and no provider registration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = makeRegister();
    const r = resolveCliModelRef(CATALOG, 'accounts/fireworks/models/brand-new', { flagName: '--models', registerProvider: reg.fn });
    expect(r).toEqual({ model: 'accounts/fireworks/models/brand-new', label: 'brand-new' });
    expect(reg.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('--models');
  });

  it('does not resolve disabled catalog entries (falls through to raw-id pass-through)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = makeRegister();
    const r = resolveCliModelRef(CATALOG, 'Old Model', { flagName: '--models', registerProvider: reg.fn });
    expect(r).toEqual({ model: 'Old Model', label: 'Old Model' });
    expect(reg.calls).toHaveLength(0);
  });

  it('suppresses the warning when quiet: true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = makeRegister();
    resolveCliModelRef(CATALOG, 'nope', { flagName: '--judge-model', registerProvider: reg.fn, quiet: true });
    expect(warn).not.toHaveBeenCalled();
  });
});
