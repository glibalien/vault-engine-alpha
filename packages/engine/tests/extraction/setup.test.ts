import { describe, it, expect } from 'vitest';
import { buildExtractors } from '../../src/extraction/setup.js';
import type { ModelVisionImageExtractor } from '../../src/extraction/extractors/model-vision.js';

describe('buildExtractors', () => {
  describe('always-on local extractors', () => {
    it('registers markdown, office, and unpdf with no env vars', () => {
      const { registry } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.active.map(e => e.id).sort()).toContain('markdown-read');
      expect(status.active.map(e => e.id).sort()).toContain('office-doc');
      expect(status.active.map(e => e.id).sort()).toContain('unpdf-text');
    });

    it('serves .pdf from unpdf (not any vision extractor)', () => {
      const { registry } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });
  });

  describe('deepgram', () => {
    it('registers when DEEPGRAM_API_KEY is set', () => {
      const { registry } = buildExtractors({ DEEPGRAM_API_KEY: 'dk_test' });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    });

    it('marks unavailable when DEEPGRAM_API_KEY is unset', () => {
      const { registry } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    });
  });

  describe('VISION_PROVIDER=gemini (default)', () => {
    it('with GEMINI_API_KEY: image extractor active, pdfFallback is gemini', () => {
      const { registry, pdfFallback } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'gemini-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('without GEMINI_API_KEY: image marked unavailable, pdfFallback is null', () => {
      const { registry, pdfFallback } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'gemini-vision-image')).toBe(true);
      expect(status.unavailable.some(e => e.id === 'gemini-vision-pdf')).toBe(true);
      expect(pdfFallback).toBeNull();
    });

    it('empty-string VISION_PROVIDER treated as gemini', () => {
      const { pdfFallback } = buildExtractors({ VISION_PROVIDER: '', GEMINI_API_KEY: 'g_test' });
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('whitespace VISION_PROVIDER treated as gemini', () => {
      const { pdfFallback } = buildExtractors({ VISION_PROVIDER: '   ', GEMINI_API_KEY: 'g_test' });
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });
  });

  describe('VISION_PROVIDER=claude', () => {
    it('with ANTHROPIC_API_KEY: image extractor active, pdfFallback is claude', () => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'claude-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('claude-vision-pdf');
    });

    it('without ANTHROPIC_API_KEY: image marked unavailable, pdfFallback is null', () => {
      const { registry, pdfFallback } = buildExtractors({ VISION_PROVIDER: 'claude' });
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'claude-vision-image')).toBe(true);
      expect(status.unavailable.some(e => e.id === 'claude-vision-pdf')).toBe(true);
      expect(pdfFallback).toBeNull();
    });

    it('is case-insensitive', () => {
      const { pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'CLAUDE',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      expect(pdfFallback?.id).toBe('claude-vision-pdf');
    });
  });

  describe('VISION_PROVIDER=model (fireworks arm)', () => {
    // Fireworks removed Document Inlining and OpenRouter routes are chat
    // endpoints — neither takes PDFs — so for these providers the scanned-PDF
    // fallback rides on GEMINI_API_KEY instead.
    it('with FIREWORKS_API_KEY + GEMINI_API_KEY: compat image active, pdfFallback is gemini', () => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'model',
        VISION_MODEL_PROVIDER: 'fireworks',
        FIREWORKS_API_KEY: 'fw_test',
        GEMINI_API_KEY: 'g_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'openai-compat-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('defaults VISION_MODEL_PROVIDER to fireworks when unset', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model',
        FIREWORKS_API_KEY: 'fw_test',
        VISION_MODEL: 'accounts/fireworks/models/custom',
      });
      const extractor = registry.getForExtension('.png') as ModelVisionImageExtractor;
      expect(extractor?.id).toBe('openai-compat-vision-image');
      expect(extractor?.provider).toBe('fireworks');
      expect(extractor?.model).toBe('accounts/fireworks/models/custom');
    });

    it('without FIREWORKS_API_KEY: image unavailable (missingKey FIREWORKS_API_KEY), gemini pdfFallback still works', () => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'model',
        VISION_MODEL_PROVIDER: 'fireworks',
        GEMINI_API_KEY: 'g_test',
      });
      const status = registry.getStatus();
      expect(
        status.unavailable.find(e => e.id === 'openai-compat-vision-image')?.missingKey,
      ).toBe('FIREWORKS_API_KEY');
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('legacy VISION_PROVIDER=qwen maps to the model arm (env back-compat)', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'qwen',
        FIREWORKS_API_KEY: 'fw_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'openai-compat-vision-image')).toBe(true);
    });

    it('is case-insensitive', () => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'MODEL',
        FIREWORKS_API_KEY: 'fw_test',
        GEMINI_API_KEY: 'g_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'openai-compat-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('never registers a vision pdf extractor into byExtension for .pdf', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model',
        FIREWORKS_API_KEY: 'fw_test',
        GEMINI_API_KEY: 'g_test',
      });
      expect(registry.getForExtension('.pdf')?.id).toBe('unpdf-text');
    });
  });

  describe('VISION_PROVIDER=model (openrouter arm)', () => {
    it('with VISION_MODEL_PROVIDER=openrouter + OPENROUTER_API_KEY: compat image active, usageProvider openrouter', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model',
        VISION_MODEL_PROVIDER: 'openrouter',
        VISION_MODEL: 'z-ai/glm-vision',
        OPENROUTER_API_KEY: 'or_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'openai-compat-vision-image')).toBe(true);
      const extractor = registry.getForExtension('.png') as ModelVisionImageExtractor;
      expect(extractor?.provider).toBe('openrouter');
      expect(extractor?.model).toBe('z-ai/glm-vision');
    });

    it('without OPENROUTER_API_KEY: image unavailable with missingKey OPENROUTER_API_KEY', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model',
        VISION_MODEL_PROVIDER: 'openrouter',
        VISION_MODEL: 'z-ai/glm-vision',
      });
      const status = registry.getStatus();
      expect(
        status.unavailable.find(e => e.id === 'openai-compat-vision-image')?.missingKey,
      ).toBe('OPENROUTER_API_KEY');
    });

    it('does NOT fall back to FIREWORKS_API_KEY when the openrouter key is missing', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model',
        VISION_MODEL_PROVIDER: 'openrouter',
        FIREWORKS_API_KEY: 'fw_test',   // present, but wrong provider — must not be used
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'openai-compat-vision-image')).toBe(false);
      expect(
        status.unavailable.find(e => e.id === 'openai-compat-vision-image')?.missingKey,
      ).toBe('OPENROUTER_API_KEY');
    });
  });

  describe('VISION_PROVIDER=model with a provider that takes PDFs', () => {
    it.each([
      ['anthropic', 'ANTHROPIC_API_KEY', 'claude-x', 'claude-vision'],
      ['openai', 'OPENAI_API_KEY', 'gpt-test', 'openai-compat-vision'],
    ] as const)('%s: the visionModel serves images and scanned PDFs', (provider, keyName, model, idPrefix) => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'model', VISION_MODEL_PROVIDER: provider, VISION_MODEL: model, [keyName]: 'k', GEMINI_API_KEY: 'g_test',
      });
      const extractor = registry.getForExtension('.png') as ModelVisionImageExtractor;
      expect([extractor?.id, extractor?.provider, extractor?.model]).toEqual([`${idPrefix}-image`, provider, model]);
      expect(pdfFallback?.id).toBe(`${idPrefix}-pdf`);
      expect((pdfFallback as unknown as { model: string }).model).toBe(model);
      expect(registry.getForExtension('.pdf')?.id).toBe('unpdf-text');
    });

    it.each([
      ['anthropic', 'ANTHROPIC_API_KEY', 'claude-vision'],
      ['openai', 'OPENAI_API_KEY', 'openai-compat-vision'],
    ] as const)('%s without its key: image and PDF unavailable, naming the key', (provider, keyName, idPrefix) => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'model', VISION_MODEL_PROVIDER: provider, VISION_MODEL: 'm', GEMINI_API_KEY: 'g_test',
      });
      const status = registry.getStatus();
      expect(status.unavailable.find(e => e.id === `${idPrefix}-image`)?.missingKey).toBe(keyName);
      expect(status.unavailable.find(e => e.id === `${idPrefix}-pdf`)?.missingKey).toBe(keyName);
      expect(pdfFallback).toBeNull();
    });

    it('lists the model\'s own PDF extractor as disabled when paid extraction is off', () => {
      const { registry } = buildExtractors(
        { VISION_PROVIDER: 'model', VISION_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }, undefined, undefined, false,
      );
      const disabled = registry.getStatus().disabled.map(e => e.id);
      expect(disabled).toEqual(expect.arrayContaining(['openai-compat-vision-image', 'openai-compat-vision-pdf']));
      expect(disabled).not.toContain('gemini-vision-pdf');
    });
  });

  describe('invalid VISION_PROVIDER', () => {
    it('throws for unknown provider', () => {
      expect(() => buildExtractors({ VISION_PROVIDER: 'bogus' })).toThrow(
        /VISION_PROVIDER/,
      );
    });
  });

  describe('existingRegistry (re-arm support)', () => {
    it('clears and repopulates the SAME registry instance rather than returning a fresh one', () => {
      const { registry: first } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      expect(first.getStatus().active.some(e => e.id === 'gemini-vision-image')).toBe(true);

      const { registry: second } = buildExtractors({}, undefined, first);

      expect(second).toBe(first);
      const status = second.getStatus();
      // gemini image was only active because GEMINI_API_KEY was set on the first
      // call — rebuilding without it must not leave the stale entry behind.
      expect(status.active.some(e => e.id === 'gemini-vision-image')).toBe(false);
      expect(status.unavailable.some(e => e.id === 'gemini-vision-image')).toBe(true);
      // Always-on extractors are re-registered fresh too, not just carried over.
      expect(status.active.some(e => e.id === 'markdown-read')).toBe(true);
    });

    it('model branch registers an extractor whose model is the passed VISION_MODEL', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model',
        FIREWORKS_API_KEY: 'fw_test',
        VISION_MODEL: 'accounts/fireworks/models/custom-model',
      });
      const extractor = registry.getForExtension('.png') as ModelVisionImageExtractor;
      expect(extractor?.id).toBe('openai-compat-vision-image');
      expect(extractor?.model).toBe('accounts/fireworks/models/custom-model');
    });

    it('rebuilding into the same instance with a new VISION_MODEL replaces the old extractor', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model', FIREWORKS_API_KEY: 'fw_test', VISION_MODEL: 'model-a',
      });
      buildExtractors(
        { VISION_PROVIDER: 'model', FIREWORKS_API_KEY: 'fw_test', VISION_MODEL: 'model-b' },
        undefined,
        registry,
      );

      const extractor = registry.getForExtension('.png') as ModelVisionImageExtractor;
      expect(extractor.model).toBe('model-b');
    });

    it('rebuilding from fireworks to openrouter swaps the provider in place', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'model', FIREWORKS_API_KEY: 'fw_test', VISION_MODEL: 'model-a',
      });
      expect((registry.getForExtension('.png') as ModelVisionImageExtractor).provider).toBe('fireworks');
      buildExtractors(
        { VISION_PROVIDER: 'model', VISION_MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or_test', VISION_MODEL: 'z-ai/glm-vision' },
        undefined,
        registry,
      );
      const extractor = registry.getForExtension('.png') as ModelVisionImageExtractor;
      expect(extractor.provider).toBe('openrouter');
      expect(extractor.model).toBe('z-ai/glm-vision');
    });
  });

  describe('latent-bug regression', () => {
    it('never registers gemini-vision-pdf into byExtension for .pdf', () => {
      const { registry } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).not.toBe('gemini-vision-pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });

    it('never registers claude-vision-pdf into byExtension for .pdf', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).not.toBe('claude-vision-pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });
  });

  describe('extractionEnabled off', () => {
    const ALL_KEYS = {
      DEEPGRAM_API_KEY: 'dk_test', GEMINI_API_KEY: 'g_test', ANTHROPIC_API_KEY: 'sk_test',
      FIREWORKS_API_KEY: 'fw_test', OPENROUTER_API_KEY: 'or_test',
    };

    it.each([
      ['gemini', ['deepgram-nova-3', 'gemini-vision-image', 'gemini-vision-pdf']],
      ['claude', ['deepgram-nova-3', 'claude-vision-image', 'claude-vision-pdf']],
      ['model', ['deepgram-nova-3', 'openai-compat-vision-image', 'gemini-vision-pdf']],
    ])('lists every paid %s extractor as disabled even with all keys set', (provider, ids) => {
      const { registry, pdfFallback } = buildExtractors({ ...ALL_KEYS, VISION_PROVIDER: provider }, undefined, undefined, false);
      const status = registry.getStatus();
      expect(status.active.map(e => e.id).sort()).toEqual(['markdown-read', 'office-doc', 'svg-text', 'unpdf-text']);
      expect(status.unavailable).toEqual([]);
      expect(status.disabled.map(e => e.id)).toEqual(ids);
      expect(pdfFallback).toBeNull();
      expect(registry.getForExtension('.png')).toBeNull();
      expect(registry.getDisabledReason('.png')).toContain('extractionEnabled is false');
      expect(registry.getForExtension('.mp3')).toBeNull();
      expect(registry.getForExtension('.pdf')?.id).toBe('unpdf-text');
      expect(registry.getDisabledReason('.pdf')).toBeNull();
    });

    it('turns paid extractors off when rebuilding an existing registry', () => {
      const { registry } = buildExtractors(ALL_KEYS);
      expect(registry.getForExtension('.png')?.id).toBe('gemini-vision-image');
      buildExtractors(ALL_KEYS, undefined, registry, false);
      expect(registry.getForExtension('.png')).toBeNull();
      expect(registry.getStatus().disabled.map(e => e.id)).toContain('gemini-vision-image');
      buildExtractors(ALL_KEYS, undefined, registry);
      expect(registry.getStatus().disabled).toEqual([]);
      expect(registry.getDisabledReason('.png')).toBeNull();
    });
  });
});
