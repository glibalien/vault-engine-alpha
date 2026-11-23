import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MODELS,
  modelProviderConflicts,
  normalizeModelRef,
  resolveModelRef,
  SEED_MODELS,
  validateValue,
} from '../src/index.js';
import type { ModelCatalogEntry, SettingDescriptor } from '../src/index.js';

const CATALOG: ModelCatalogEntry[] = [
  { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true },
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
  { title: 'Old Model', provider: 'fireworks', model: 'accounts/fireworks/models/old', enabled: false },
];

describe('normalizeModelRef', () => {
  it.each([
    ['[[Qwen 3.7 Plus]]', 'Qwen 3.7 Plus'],
    ['Qwen 3.7 Plus', 'Qwen 3.7 Plus'],
    ['  [[Qwen 3.7 Plus]]  ', 'Qwen 3.7 Plus'],
    ['', ''],
    [null, ''],
    [42, ''],
  ])('%j → %j', (input, expected) => expect(normalizeModelRef(input)).toBe(expected));
});

describe('resolveModelRef', () => {
  it('resolves with and without brackets', () => {
    expect(resolveModelRef(CATALOG, '[[Claude Sonnet 4.6]]')!.model).toBe('claude-sonnet-4-6');
    expect(resolveModelRef(CATALOG, 'Qwen 3.7 Plus')!.provider).toBe('fireworks');
  });
  it('returns null for unknown, disabled, and non-string refs', () => {
    expect(resolveModelRef(CATALOG, '[[Nope]]')).toBeNull();
    expect(resolveModelRef(CATALOG, '[[Old Model]]')).toBeNull();   // disabled = unresolvable
    expect(resolveModelRef(CATALOG, null)).toBeNull();
  });
});

describe('modelProviderConflicts', () => {
  it('rejects one enabled raw model id assigned to different providers without disclosing the id', () => {
    const marker = 'SECRET-DYNAMIC-MODEL-ID';
    const conflicts = modelProviderConflicts([
      { title: 'Primary', provider: 'anthropic', model: marker, enabled: true },
      { title: 'Secondary', provider: 'fireworks', model: marker, enabled: true },
    ]);

    expect(conflicts).toEqual([{ code: 'AMBIGUOUS_MODEL_PROVIDER' }]);
    expect(JSON.stringify(conflicts)).not.toContain(marker);
  });

  it('allows same-provider aliases and ignores disabled cross-provider aliases', () => {
    expect(modelProviderConflicts([
      { title: 'Primary', provider: 'fireworks', model: 'shared', enabled: true },
      { title: 'Alias', provider: 'fireworks', model: 'shared', enabled: true },
      { title: 'Disabled Other', provider: 'anthropic', model: 'shared', enabled: false },
    ])).toEqual([]);
  });
});

describe('seed + fallback consistency', () => {
  it('every seed model has a matching hardcoded fallback and is enabled', () => {
    expect(SEED_MODELS).toHaveLength(5);
    for (const m of SEED_MODELS) {
      expect(m.enabled).toBe(true);
      expect(FALLBACK_MODELS[m.title]).toEqual({ provider: m.provider, model: m.model });
    }
  });
});

describe('openrouter provider + capability/pricing fields', () => {
  it('resolves an openrouter entry with capability fields', () => {
    const catalog: ModelCatalogEntry[] = [{
      title: 'Claude Sonnet 5 (OR)', provider: 'openrouter', model: 'anthropic/claude-sonnet-5',
      enabled: true, vision: true, tools: true, contextLength: 1_000_000,
      pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    }];
    const hit = resolveModelRef(catalog, '[[Claude Sonnet 5 (OR)]]');
    expect(hit?.provider).toBe('openrouter');
    expect(hit?.pricing?.input).toBe(2);
  });
});

describe('model-ref kind (shape only)', () => {
  const d = (type: SettingDescriptor['type']): SettingDescriptor =>
    ({ key: 'k', domain: 'engine', type, default: null, reload: 'next-use', description: 'test descriptor' });
  it('accepts bracketed and bare non-empty refs; rejects empty/non-strings', () => {
    expect(validateValue(d({ kind: 'model-ref' }), '[[Qwen 3.7 Plus]]')).toBeNull();
    expect(validateValue(d({ kind: 'model-ref' }), 'Qwen 3.7 Plus')).toBeNull();
    expect(validateValue(d({ kind: 'model-ref' }), '')).not.toBeNull();
    expect(validateValue(d({ kind: 'model-ref' }), '[[]]')).not.toBeNull();
    expect(validateValue(d({ kind: 'model-ref' }), 7)).not.toBeNull();
    expect(validateValue(d({ kind: 'model-ref' }), null)).not.toBeNull();
    expect(validateValue(d({ kind: 'model-ref', nullable: true }), null)).toBeNull();
  });
});
