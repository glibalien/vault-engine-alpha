import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { resolveBenchModelRef } from './model-refs.js';

const CATALOG: ModelCatalogEntry[] = [
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
  {
    title: 'Qwen 3.7 Plus',
    provider: 'fireworks',
    model: 'accounts/fireworks/models/qwen3p7-plus',
    enabled: true,
  },
  // Disabled entry — deliberately unresolvable by either title or raw id (mirrors
  // resolveModelRef's own "disabled entries are deliberately unresolvable" rule).
  {
    title: 'Retired Model',
    provider: 'fireworks',
    model: 'accounts/fireworks/models/retired-model',
    enabled: false,
  },
];

describe('resolveBenchModelRef', () => {
  it('resolves a catalog title hit (bare)', () => {
    const resolved = resolveBenchModelRef(CATALOG, 'Claude Sonnet 4.6');
    expect(resolved.entry).toEqual(CATALOG[0]);
    expect(resolved.warning).toBeNull();
    expect(resolved.ref).toBe('Claude Sonnet 4.6');
  });

  it('resolves a catalog title hit given as a [[wikilink]]', () => {
    const resolved = resolveBenchModelRef(CATALOG, '[[Qwen 3.7 Plus]]');
    expect(resolved.entry).toEqual(CATALOG[1]);
    expect(resolved.warning).toBeNull();
  });

  it('resolves an enabled raw model id when no title matches', () => {
    const resolved = resolveBenchModelRef(CATALOG, 'accounts/fireworks/models/qwen3p7-plus');
    expect(resolved.entry).toEqual(CATALOG[1]);
    expect(resolved.warning).toBeNull();
  });

  it('does not match a disabled entry by title', () => {
    const resolved = resolveBenchModelRef(CATALOG, 'Retired Model');
    expect(resolved.entry.enabled).toBe(true); // synthesized pass-through entry, not the disabled catalog row
    expect(resolved.entry.model).toBe('Retired Model');
    expect(resolved.warning).not.toBeNull();
  });

  it('does not match a disabled entry by raw id', () => {
    const resolved = resolveBenchModelRef(CATALOG, 'accounts/fireworks/models/retired-model');
    expect(resolved.entry.model).toBe('accounts/fireworks/models/retired-model');
    expect(resolved.entry.enabled).toBe(true); // pass-through, not the disabled catalog row
    expect(resolved.entry.provider).toBe('fireworks'); // pass-through default, per curator's convention
    expect(resolved.warning).toContain('accounts/fireworks/models/retired-model');
  });

  it('passes an unknown ref through as a raw fireworks model id with a warning naming the ref', () => {
    const resolved = resolveBenchModelRef(CATALOG, 'vendor/mystery-model');
    expect(resolved.entry).toEqual({
      title: 'vendor/mystery-model',
      provider: 'fireworks',
      model: 'vendor/mystery-model',
      enabled: true,
    });
    expect(resolved.warning).toContain('vendor/mystery-model');
  });

  it('logs the pass-through warning to console.warn when not suppressed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveBenchModelRef(CATALOG, 'vendor/mystery-model');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('vendor/mystery-model');
    warn.mockRestore();
  });

  it('never logs to console.warn on a title or raw-id hit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveBenchModelRef(CATALOG, 'Claude Sonnet 4.6');
    resolveBenchModelRef(CATALOG, 'accounts/fireworks/models/qwen3p7-plus');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
