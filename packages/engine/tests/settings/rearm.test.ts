import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_MODELS } from '@vault/settings-registry';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { resolveModel } from '../../src/mcp/tools/memory-consolidation.js';
import { resolveEngineModel, resolveEngineModelEntry } from '../../src/settings/models.js';

describe('consolidation model resolution', () => {
  it('accepts a literal or a getter', () => {
    expect(resolveModel('m1')).toBe('m1');
    let current = 'm1';
    const getter = () => current;
    expect(resolveModel(getter)).toBe('m1');
    current = 'm2';
    expect(resolveModel(getter)).toBe('m2');
  });
});

/** Minimal stand-in for ModelCatalog — the fallback chain only ever calls `.resolve()`. */
function fakeCatalog(entries: ModelCatalogEntry[]): { resolve(ref: unknown): ModelCatalogEntry | null } {
  return {
    resolve(ref: unknown): ModelCatalogEntry | null {
      const title = typeof ref === 'string' ? ref.trim().replace(/^\[\[(.*)\]\]$/, '$1').trim() : '';
      if (title === '') return null;
      return entries.find(e => e.enabled && e.title === title) ?? null;
    },
  };
}

describe('resolveEngineModel (fallback chain: stored ref -> registry default ref -> FALLBACK_MODELS)', () => {
  const qwenDefault: ModelCatalogEntry = {
    title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true,
  };
  const kimiCustom: ModelCatalogEntry = {
    title: 'Kimi K2.6', provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', enabled: true,
  };
  const claudeEntry: ModelCatalogEntry = {
    title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true,
  };

  it('resolves the stored ref directly when it is an enabled fireworks entry', () => {
    const catalog = fakeCatalog([qwenDefault, kimiCustom]);
    const result = resolveEngineModel(catalog, '[[Kimi K2.6]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    expect(result).toBe('accounts/fireworks/models/kimi-k2p6');
  });

  it('falls back to the registry default ref when the stored ref is dangling', () => {
    const catalog = fakeCatalog([qwenDefault]);
    const result = resolveEngineModel(catalog, '[[Deleted Model]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    expect(result).toBe('accounts/fireworks/models/qwen3p7-plus');
  });

  it('resolves an anthropic or openai entry for either key, since both run on every provider', () => {
    const gpt: ModelCatalogEntry = { title: 'GPT Vision', provider: 'openai', model: 'gpt-test', enabled: true, vision: true };
    const catalog = fakeCatalog([claudeEntry, gpt, qwenDefault]);
    expect(resolveEngineModelEntry(catalog, '[[Claude Sonnet 4.6]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus'))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(resolveEngineModelEntry(catalog, '[[GPT Vision]]', 'visionModel', 'Qwen 3.7 Plus'))
      .toEqual({ provider: 'openai', model: 'gpt-test' });
  });

  it('falls back to FALLBACK_MODELS when both the stored ref and the registry default dangle', () => {
    const catalog = fakeCatalog([]);
    const result = resolveEngineModel(catalog, '[[Deleted Model]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    expect(result).toBe(FALLBACK_MODELS['Qwen 3.7 Plus']!.model);
  });

  it('falls back to FALLBACK_MODELS when the registry default is not vision-capable', () => {
    const catalog = fakeCatalog([{ title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/text-only', enabled: true, vision: false }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveEngineModel(catalog, '[[Ghost]]', 'visionModel', 'Qwen 3.7 Plus');
    expect(result).toBe(FALLBACK_MODELS['Qwen 3.7 Plus']!.model);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a disabled entry never resolves, so it falls through the chain like a dangling ref', () => {
    const catalog = fakeCatalog([{ ...kimiCustom, enabled: false }, qwenDefault]);
    const result = resolveEngineModel(catalog, '[[Kimi K2.6]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    expect(result).toBe('accounts/fireworks/models/qwen3p7-plus');
  });

  // Boot-order divergence: the SAME ref resolves differently before vs after
  // Settings/Models seeding (first boot: catalog empty at the initial
  // buildExtractors call; seedModelsOnBoot populates it later the same boot).
  // This is WHY index.ts must initialize its lastVision tracking from the
  // value actually handed to buildExtractors, not from a fresh resolution
  // made after seeding — re-deriving would claim the post-seed answer while
  // the live extractor still runs the pre-seed one, and the first onChange
  // comparison would then see "no change" and skip the re-arm forever. The
  // capture itself is index.ts top-level wiring (unreachable from this
  // harness); this test pins the divergence that makes it load-bearing.
  it('resolution diverges across catalog seeding — pre-seed and post-seed answers differ for the same ref', () => {
    const ref = '[[Kimi K2.6]]';
    const preSeed = resolveEngineModel(fakeCatalog([]), ref, 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    const postSeed = resolveEngineModel(fakeCatalog([qwenDefault, kimiCustom]), ref, 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    expect(preSeed).toBe(FALLBACK_MODELS['Qwen 3.7 Plus']!.model);
    expect(postSeed).toBe('accounts/fireworks/models/kimi-k2p6');
    expect(preSeed).not.toBe(postSeed);
  });
});

describe('resolveEngineModelEntry (provider + vision-capability aware)', () => {
  const openrouterVision: ModelCatalogEntry = {
    title: 'GLM Vision', provider: 'openrouter', model: 'z-ai/glm-vision', enabled: true, vision: true,
  };
  const fireworksText: ModelCatalogEntry = {
    title: 'Text Only', provider: 'fireworks', model: 'accounts/fireworks/models/text-only', enabled: true, vision: false,
  };
  const openrouterText: ModelCatalogEntry = {
    title: 'OR Text', provider: 'openrouter', model: 'meta/llama-text', enabled: true, vision: true,
  };
  const qwenLegacy: ModelCatalogEntry = {
    // Legacy seed note: no explicit `vision` field, known-good by title.
    title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true,
  };

  it('accepts an openrouter vision:true entry for visionModel and reports its provider', () => {
    const catalog = fakeCatalog([openrouterVision]);
    expect(resolveEngineModelEntry(catalog, '[[GLM Vision]]', 'visionModel', 'Qwen 3.7 Plus'))
      .toEqual({ provider: 'openrouter', model: 'z-ai/glm-vision' });
  });

  it('rejects a vision:false entry for visionModel and continues the chain', () => {
    // Stored ref resolves to a non-vision model → dangling; registry default
    // ([[Qwen 3.7 Plus]]) is present and vision-capable via the legacy exception.
    const catalog = fakeCatalog([fireworksText, qwenLegacy]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveEngineModelEntry(catalog, '[[Text Only]]', 'visionModel', 'Qwen 3.7 Plus');
    expect(result).toEqual({ provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus' });
    expect(warn.mock.calls.some(c => String(c[0]).includes('non-vision-capable'))).toBe(true);
    warn.mockRestore();
  });

  it('honors the Qwen 3.7 Plus legacy vision exception (vision undefined) for visionModel', () => {
    const catalog = fakeCatalog([qwenLegacy]);
    expect(resolveEngineModelEntry(catalog, '[[Qwen 3.7 Plus]]', 'visionModel', 'Qwen 3.7 Plus'))
      .toEqual({ provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus' });
  });

  it('accepts an openrouter entry for memoryConsolidationModel and reports its provider', () => {
    const catalog = fakeCatalog([openrouterText, qwenLegacy]);
    const result = resolveEngineModelEntry(catalog, '[[OR Text]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus');
    expect(result).toEqual({ provider: 'openrouter', model: 'meta/llama-text' });
  });

  it('allows an openrouter entry for both visionModel and memoryConsolidationModel', () => {
    const catalog = fakeCatalog([openrouterVision]);
    expect(resolveEngineModelEntry(catalog, '[[GLM Vision]]', 'visionModel', 'Qwen 3.7 Plus').provider).toBe('openrouter');
    expect(resolveEngineModelEntry(catalog, '[[GLM Vision]]', 'memoryConsolidationModel', 'Qwen 3.7 Plus'))
      .toEqual({ provider: 'openrouter', model: 'z-ai/glm-vision' });
  });

  it('thin resolveEngineModel wrapper returns just the model id', () => {
    const catalog = fakeCatalog([openrouterVision]);
    expect(resolveEngineModel(catalog, '[[GLM Vision]]', 'visionModel', 'Qwen 3.7 Plus')).toBe('z-ai/glm-vision');
  });
});
