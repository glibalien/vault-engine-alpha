import { describe, expect, it, vi } from 'vitest';
import { buildRuntimeConfig, CuratorSettingsClient } from '../src/settings.js';
import { projectTypeOf, vaultOf } from '../src/config.js';
import type { EngineSettingsApi } from '../src/settings.js';
import type { BootstrapConfig } from '../src/config.js';
import type { SettingsDomainPayload, ModelsDomainPayload } from '../src/engine.js';
import { defaultsFor, FALLBACK_MODELS, SEED_MODELS } from '@vault/settings-registry';
import type { CuratorSettings, ModelCatalogEntry, VaultSettings } from '@vault/settings-registry';
import { CAPTURE_COVERAGE_SYSTEM_PROMPT } from '../src/conversation-capture-prompts.js';

/** get-settings' return shape — a helper so fakes don't fight TS's union
 *  inference over the two branches' differing keys (curator-only vs. +models). */
type GetSettingsResult = { domains: Record<string, SettingsDomainPayload | ModelsDomainPayload> };

const DEFAULTS = defaultsFor('curator') as unknown as CuratorSettings;
it('maps wiki stage overrides into runtime config', () => {
  expect(buildRuntimeConfig(bootstrap(), { ...DEFAULTS, wikiPageMaxTokens: 8000, wikiHomeMaxTokens: 0, wikiPageReasoningEffort: 'low' }, CATALOG))
    .toMatchObject({ wikiPlanningMaxTokens: 24000, wikiPageMaxTokens: 8000, wikiHomeMaxTokens: 0, wikiPageReasoningEffort: 'low' });
});
it('resolves per-stage wiki models across providers and routes each one', () => {
  const catalog: ModelCatalogEntry[] = [
    ...CATALOG,
    { title: 'Router Planner', provider: 'openrouter', model: 'z-ai/glm-5.2', enabled: true },
    { title: 'Cheap Pages', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-flash', enabled: true },
  ];
  const cfg = buildRuntimeConfig(bootstrap(), {
    ...DEFAULTS, wikiPlanningModel: '[[Router Planner]]', wikiPageModel: '[[Cheap Pages]]', wikiHomeModel: null,
  }, catalog);
  expect(cfg).toMatchObject({ wikiPlanningModel: 'z-ai/glm-5.2',
    wikiPageModel: 'accounts/fireworks/models/deepseek-v4-flash', wikiHomeModel: null });
  expect(cfg.modelProviders).toMatchObject({ 'z-ai/glm-5.2': 'openrouter',
    'accounts/fireworks/models/deepseek-v4-flash': 'fireworks', [cfg.model]: 'anthropic' });
});
it('prices each routed model from its catalog note first, then the static table', () => {
  const catalog: ModelCatalogEntry[] = [
    ...CATALOG,
    { title: 'Priced Router', provider: 'openrouter', model: 'vendor/priced', enabled: true, pricing: { input: 0.5, output: 2 } },
    { title: 'Unpriced Router', provider: 'openrouter', model: 'vendor/unpriced', enabled: true },
  ];
  const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, wikiPlanningModel: '[[Priced Router]]',
    wikiPageModel: '[[Unpriced Router]]', dailyBudgetCents: 75 }, catalog);
  expect(cfg.dailyBudgetCents).toBe(75);
  // The day's ceiling for on-demand runs comes through with its default: five dollars (#644).
  expect(cfg.runDailyBudgetCents).toBe(500);
  expect(cfg.modelPricing?.['vendor/priced']).toEqual({ input: 0.5, output: 2, cacheRead: 0.5, cacheWrite: 0.5 });
  expect(cfg.modelPricing?.['vendor/unpriced']).toBeNull();
  expect(cfg.modelPricing?.[cfg.model]).toMatchObject({ input: 3, output: 15 });
});
it('falls a dangling per-stage wiki model back to the shared model without changing provider', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, wikiPageModel: '[[Missing Page Model]]' }, CATALOG);
    expect(cfg.wikiPageModel).toBe(cfg.model);
    expect(cfg.modelProviders[cfg.model]).toBe('anthropic');
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
it('maps topic budgets and rejects incompatible excerpt limits', () => {
  expect(buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG)).toMatchObject({
    topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576 });
  expect(() => buildRuntimeConfig(bootstrap(), { ...DEFAULTS, topicPageRequestMaxBytes: 100 }, CATALOG)).toThrow(/topic/i);
});
const bootstrap = (): BootstrapConfig => ({
  engineUrl: 'http://e', engineToken: 't', experiment: null, variant: null,
  llmKeys: { keys: { anthropic: 'ak', fireworks: 'fw' }, baseURLs: {} },
  oauthOwnerPassword: undefined, oauthIssuerUrl: undefined,
  curatorPort: 3335, curatorDbPath: ':memory:', memorySweepSince: null, conversationSweepSince: null,
});

const CATALOG: ModelCatalogEntry[] = [
  { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
  { title: 'DeepSeek v4 Pro', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-pro', enabled: true },
  { title: 'Disabled Model', provider: 'fireworks', model: 'accounts/fireworks/models/disabled-x', enabled: false },
  { title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true },
  { title: 'GPT-OSS 120B', provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true },
  { title: 'Coverage Model', provider: 'fireworks', model: 'provider/coverage-model', enabled: true },
];

describe('buildRuntimeConfig — organization path exclusions', () => {
  it('always includes the Engine-designated settings folder plus configured exclusions', () => {
    const settings = {
      ...DEFAULTS,
      orgTypeExcludePaths: [' Templates/ ', 'SystemConfig\\Generated\\', 'SystemConfig'],
    } as CuratorSettings;

    const cfg = buildRuntimeConfig(bootstrap(), settings, CATALOG, { settingsDir: ' ./SystemConfig/ ' });

    expect(cfg.orgTypeExcludePaths)
      .toEqual(['SystemConfig', 'Templates', 'SystemConfig/Generated']);
  });
});

describe('buildRuntimeConfig — model resolution', () => {
  it('fails closed before building routes when enabled catalog aliases disagree on provider', () => {
    const marker = 'SECRET-DYNAMIC-MODEL-ID';
    const ambiguousCatalog: ModelCatalogEntry[] = [
      ...CATALOG,
      { title: 'Provider Alias A', provider: 'anthropic', model: marker, enabled: true },
      { title: 'Provider Alias B', provider: 'fireworks', model: marker, enabled: true },
    ];

    expect(() => buildRuntimeConfig(bootstrap(), DEFAULTS, ambiguousCatalog)).toThrow(
      'Enabled model catalog contains an ambiguous provider mapping.',
    );
    try {
      buildRuntimeConfig(bootstrap(), DEFAULTS, ambiguousCatalog);
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it('allows enabled aliases when the raw id keeps one provider', () => {
    const catalog: ModelCatalogEntry[] = [
      ...CATALOG,
      { title: 'GPT-OSS Alias', provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true },
    ];

    expect(buildRuntimeConfig(bootstrap(), DEFAULTS, catalog).modelProviders)
      .toEqual(buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG).modelProviders);
  });

  it.each([
    ['home', { model: '[[Conflicting Route]]' }],
    ['strict field guess', { fieldGuessModel: '[[Conflicting Route]]' }],
    ['memory override', { memorySweepModel: '[[Conflicting Route]]' }],
    ['conversation override', { conversationSweepModel: '[[Conflicting Route]]' }],
    ['conversation capture coverage override', { conversationCaptureCoverageModel: '[[Conflicting Route]]' }],
    ['topic early refresh assessment override', { topicEarlyRefreshAssessmentModel: '[[Conflicting Route]]' }],
    ['organization override', { orgSweepModel: '[[Conflicting Route]]' }],
    ['journal override', { journalModel: '[[Conflicting Route]]' }],
    ['reconcile override', { reconcileModel: '[[Conflicting Route]]' }],
    ['wiki planning override', { wikiPlanningModel: '[[Conflicting Route]]' }],
    ['wiki page override', { wikiPageModel: '[[Conflicting Route]]' }],
    ['wiki home override', { wikiHomeModel: '[[Conflicting Route]]' }],
  ] satisfies Array<[string, Partial<CuratorSettings>]>)('rejects a %s route before provider-map overwrite', (_label, override) => {
    const rawModel = 'claude-sonnet-4-6';
    const catalog: ModelCatalogEntry[] = [
      ...CATALOG,
      { title: 'Conflicting Route', provider: 'fireworks', model: rawModel, enabled: true },
    ];

    expect(() => buildRuntimeConfig(bootstrap(), { ...DEFAULTS, ...override }, catalog)).toThrow(
      'Enabled model catalog contains an ambiguous provider mapping.',
    );
  });

  it('rejects a resolved override that conflicts with the hardcoded home fallback', () => {
    const catalog: ModelCatalogEntry[] = [{
      title: 'Conflicting Route', provider: 'fireworks', model: 'claude-sonnet-4-6', enabled: true,
    }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      model: '[[Missing Home]]',
      memorySweepModel: '[[Conflicting Route]]',
      fieldGuessModel: '[[Missing Field Guess]]',
    }, catalog)).toThrow('Resolved model routes contain an ambiguous provider mapping.');
    warn.mockRestore();
  });

  it('resolves the home model ref to its catalog entry\'s raw id + provider', () => {
    const cfg = buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG);
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.modelProviders).toEqual({
      'claude-sonnet-4-6': 'anthropic',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
  });

  it('resolves a non-default ref to its own provider', () => {
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[DeepSeek v4 Pro]]' }, CATALOG);
    expect(cfg.model).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
  });

  it('a disabled catalog entry is unresolvable — treated as dangling, falls back to the registry default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Disabled Model]]' }, CATALOG);
    expect(cfg.model).toBe('claude-sonnet-4-6');
    warn.mockRestore();
  });

  it('falls back to the registry default ref when the stored ref is dangling, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Ghost Model 1]]' }, CATALOG);
    expect(cfg.model).toBe('claude-sonnet-4-6');   // registry default '[[Claude Sonnet 4.6]]' resolves
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Ghost Model 1');
    warn.mockRestore();
  });

  it('falls all the way to FALLBACK_MODELS when even the registry default ref dangles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Ghost Model 2]]' }, []);
    expect(cfg.model).toBe(FALLBACK_MODELS['Claude Sonnet 4.6']!.model);
    expect(cfg.modelProviders[cfg.model]).toBe(FALLBACK_MODELS['Claude Sonnet 4.6']!.provider);
    warn.mockRestore();
  });

  it('warns only once for the same still-dangling value across consecutive builds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Ghost Model 3]]' }, CATALOG);
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Ghost Model 3]]' }, CATALOG);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('null sweep models stay null (core falls back to `model` at call sites) and are absent from modelProviders', () => {
    const cfg = buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG);
    expect(cfg.memorySweepModel).toBeNull();
    expect(cfg.orgSweepModel).toBeNull();
    expect(cfg.conversationSweepModel).toBeNull();
    expect(cfg.conversationCaptureModel).toBeNull();
    expect(cfg.conversationCaptureCoverageModel).toBeNull();
    expect(cfg.topicEarlyRefreshAssessmentModel).toBeNull();
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(Object.keys(cfg.modelProviders)).toEqual([
      'claude-sonnet-4-6',
      'accounts/fireworks/models/gpt-oss-120b',
    ]);
  });

  it('maps topic early refresh assessment settings and resolves its optional model route', () => {
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      topicEarlyRefreshEnabled: true,
      topicEarlyRefreshAssessmentModel: '[[DeepSeek v4 Pro]]',
      topicEarlyRefreshAssessmentMaxTokens: 1777,
      topicEarlyRefreshAssessmentCap: 4,
    }, CATALOG);
    expect(cfg.topicEarlyRefreshEnabled).toBe(true);
    expect(cfg.topicEarlyRefreshAssessmentModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.topicEarlyRefreshAssessmentMaxTokens).toBe(1777);
    expect(cfg.topicEarlyRefreshAssessmentCap).toBe(4);
    expect(cfg.modelProviders['accounts/fireworks/models/deepseek-v4-pro']).toBe('fireworks');
  });

  it('falls back to the resolved home model for a dangling topic early refresh assessment model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      model: '[[DeepSeek v4 Pro]]',
      topicEarlyRefreshAssessmentModel: '[[Ghost Early Refresh Model]]',
    }, CATALOG);
    expect(cfg.topicEarlyRefreshAssessmentModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
    warn.mockRestore();
  });

  it('resolves a non-null sweep override and adds it to modelProviders alongside the home model', () => {
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, memorySweepModel: '[[DeepSeek v4 Pro]]' }, CATALOG);
    expect(cfg.memorySweepModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'claude-sonnet-4-6': 'anthropic',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
    });
  });

  it('a dangling sweep override falls back to the RESOLVED HOME model (not the home default), modelProviders unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Home is a NON-default Fireworks model; the sweep ref dangles. Pre-fix the
    // sweep walked the home-DEFAULT chain to '[[Claude Sonnet 4.6]]' (anthropic) —
    // a provider jump that throws on a Fireworks-only install. Fix 3: it must land
    // on the already-resolved home model (same id + provider), which is exactly
    // what a null sweep ref would have produced at the call site.
    const cfg = buildRuntimeConfig(
      bootstrap(),
      { ...DEFAULTS, model: '[[DeepSeek v4 Pro]]', orgSweepModel: '[[Ghost Model 4]]' },
      CATALOG,
    );
    expect(cfg.orgSweepModel).toBe('accounts/fireworks/models/deepseek-v4-pro');   // home id, NOT claude
    // modelProviders is unchanged from the home-only case: no anthropic entry added.
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a dangling memorySweepModel also falls back to the resolved home model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(
      bootstrap(),
      { ...DEFAULTS, model: '[[DeepSeek v4 Pro]]', memorySweepModel: '[[Ghost Model 6]]' },
      CATALOG,
    );
    expect(cfg.memorySweepModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
    warn.mockRestore();
  });

  it('resolves a non-null conversationSweepModel override and adds it to modelProviders alongside the home model', () => {
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, conversationSweepModel: '[[DeepSeek v4 Pro]]' }, CATALOG);
    expect(cfg.conversationSweepModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'claude-sonnet-4-6': 'anthropic',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
    });
  });

  it('resolves a non-null conversation capture model override and adds its provider', () => {
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      conversationCaptureModel: '[[DeepSeek v4 Pro]]',
    }, CATALOG);
    expect(cfg.conversationCaptureModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'claude-sonnet-4-6': 'anthropic',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
    });
  });

  it('falls back to the resolved home model for a dangling conversation capture model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      model: '[[DeepSeek v4 Pro]]',
      conversationCaptureModel: '[[Ghost Capture Model]]',
    }, CATALOG);
    expect(cfg.conversationCaptureModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
    warn.mockRestore();
  });

  it('resolves a non-null conversation capture coverage model independently and adds its provider', () => {
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      conversationCaptureCoverageModel: '[[Coverage Model]]',
    }, CATALOG);
    expect(cfg.conversationCaptureCoverageModel).toBe('provider/coverage-model');
    expect(cfg.modelProviders).toEqual({
      'claude-sonnet-4-6': 'anthropic',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
      'provider/coverage-model': 'fireworks',
    });
  });

  it('falls back to the resolved home model for a dangling conversation capture coverage model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      model: '[[DeepSeek v4 Pro]]',
      conversationCaptureCoverageModel: '[[Ghost Coverage Model]]',
    }, CATALOG);
    expect(cfg.conversationCaptureCoverageModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
    warn.mockRestore();
  });

  it('a dangling conversationSweepModel also falls back to the resolved home model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = buildRuntimeConfig(
      bootstrap(),
      { ...DEFAULTS, model: '[[DeepSeek v4 Pro]]', conversationSweepModel: '[[Ghost Model 7]]' },
      CATALOG,
    );
    expect(cfg.conversationSweepModel).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(cfg.modelProviders).toEqual({
      'accounts/fireworks/models/deepseek-v4-pro': 'fireworks',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    });
    warn.mockRestore();
  });

  it('re-warns for a value that dangles, is fixed, then dangles again (warn slot resets on a successful resolve)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Ghost Model 5]]' }, CATALOG);    // dangles → warn #1
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[DeepSeek v4 Pro]]' }, CATALOG);  // resolves → resets slot
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, model: '[[Ghost Model 5]]' }, CATALOG);    // dangles again → warn #2
    expect(warn.mock.calls.filter(call => String(call[0]).includes('Ghost Model 5'))).toHaveLength(2);
    warn.mockRestore();
  });
});

describe('buildRuntimeConfig — strict field guess settings', () => {
  it('resolves the default GPT-OSS catalog reference and records its provider', () => {
    expect(DEFAULTS.fieldGuessModel).toBe('[[GPT-OSS 120B]]');
    expect(DEFAULTS.fieldGuessCap).toBe(25);
    expect(DEFAULTS.fieldGuessMaxTokens).toBe(2000);

    const cfg = buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG);
    expect(cfg.fieldGuessModel).toBe('accounts/fireworks/models/gpt-oss-120b');
    expect(cfg.fieldGuessModelError).toBeNull();
    expect(cfg.fieldGuessCap).toBe(25);
    expect(cfg.fieldGuessMaxTokens).toBe(2000);
    expect(cfg.modelProviders['accounts/fireworks/models/gpt-oss-120b']).toBe('fireworks');
  });

  it('preserves cap zero as the settings-note kill switch', () => {
    const cfg = buildRuntimeConfig(bootstrap(), { ...DEFAULTS, fieldGuessCap: 0 }, CATALOG);
    expect(cfg.fieldGuessCap).toBe(0);
  });

  it.each([
    ['dangling', '[[Gone]]'],
    ['disabled', '[[Disabled Model]]'],
    ['deleted', '[[Deleted Model]]'],
  ])('does not fall back when the field guess model is %s', (_case, ref) => {
    const cfg = buildRuntimeConfig(
      bootstrap(),
      { ...DEFAULTS, model: '[[DeepSeek v4 Pro]]', fieldGuessModel: ref },
      CATALOG,
    );
    expect(cfg.fieldGuessModel).toBeNull();
    expect(cfg.fieldGuessModelError).toBe(
      'Field guess model does not resolve to an enabled Settings/Models entry.',
    );
    expect(cfg.fieldGuessModelError).not.toContain(ref);
    expect(cfg.modelProviders).toEqual({ 'accounts/fireworks/models/deepseek-v4-pro': 'fireworks' });
  });
});

describe('buildRuntimeConfig — §6 automation knobs (Task 4)', () => {
  const buildRuntimeConfigUnderTest = (over: Partial<CuratorSettings>) =>
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, ...over }, CATALOG);

  it('maps the §4 automation knobs into Config (defaults: armed)', () => {
    const cfg = buildRuntimeConfigUnderTest({ reverifyEnabled: true, reconcileEnabled: true, reconcilePairCap: 10, reconcileModel: null });
    expect(cfg.reverifyEnabled).toBe(true);
    expect(cfg.reconcileEnabled).toBe(true);
    expect(cfg.reconcilePairCap).toBe(10);
    expect(cfg.reconcileModel).toBeNull();
  });

  it('resolves reconcileModel through the catalog like the other sweep model-refs', () => {
    const cfg = buildRuntimeConfigUnderTest({ reconcileModel: '[[Qwen 3.7 Plus]]' });
    expect(cfg.reconcileModel).toBe('accounts/fireworks/models/qwen3p7-plus');
  });
});

describe('buildRuntimeConfig — scheduled wiki reconciliation mode', () => {
  const buildRuntimeConfigUnderTest = (over: Partial<CuratorSettings>) =>
    buildRuntimeConfig(bootstrap(), { ...DEFAULTS, ...over }, CATALOG);

  it('exposes the exact configured wiki reconciliation mode', () => {
    expect(buildRuntimeConfigUnderTest({ wikiReconciliationMode: 'live' }).wikiReconciliationMode).toBe('live');
  });
});

describe('buildRuntimeConfig — reasoningEffort + passthrough', () => {
  it('maps conversation capture defaults, prompt fallbacks, and overrides', () => {
    const fallback = buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG);
    expect(fallback).toMatchObject({
      conversationCaptureMode: 'off',
      conversationCaptureSettleHours: 6,
      conversationCaptureInitialLookbackDays: 7,
      conversationCaptureMinAssistantChars: 500,
      conversationCaptureEvaluationCap: 10,
      conversationCaptureArtifactCap: 3,
      conversationCaptureWriteCap: 5,
      conversationCaptureModel: null,
      conversationCapturePlannerMaxTokens: 4000,
      conversationCaptureCoverageModel: null,
      conversationCaptureCoverageMaxTokens: 2000,
      conversationCaptureComposerMaxTokens: 6000,
    });
    expect(fallback.curatorConversationCapturePlannerPrompt).not.toBe('');
    expect(fallback.curatorConversationCaptureCoveragePrompt).toBe(CAPTURE_COVERAGE_SYSTEM_PROMPT);
    expect(fallback.curatorConversationCaptureComposerPrompt).not.toBe('');

    const override = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      conversationCaptureMode: 'preview',
      conversationCaptureSettleHours: 0,
      conversationCaptureInitialLookbackDays: 0,
      conversationCaptureMinAssistantChars: 0,
      conversationCaptureEvaluationCap: 12,
      conversationCaptureArtifactCap: 4,
      conversationCaptureWriteCap: 6,
      conversationCapturePlannerMaxTokens: 512,
      conversationCaptureCoverageModel: '[[Coverage Model]]',
      conversationCaptureCoverageMaxTokens: 1536,
      conversationCaptureComposerMaxTokens: 768,
      curatorConversationCapturePlannerPrompt: 'Custom planner prompt',
      curatorConversationCaptureCoveragePrompt: 'Operator coverage policy',
      curatorConversationCaptureComposerPrompt: 'Custom composer prompt',
    }, CATALOG);
    expect(override).toMatchObject({
      conversationCaptureMode: 'preview',
      conversationCaptureSettleHours: 0,
      conversationCaptureInitialLookbackDays: 0,
      conversationCaptureMinAssistantChars: 0,
      conversationCaptureEvaluationCap: 12,
      conversationCaptureArtifactCap: 4,
      conversationCaptureWriteCap: 6,
      conversationCapturePlannerMaxTokens: 512,
      conversationCaptureCoverageModel: 'provider/coverage-model',
      conversationCaptureCoverageMaxTokens: 1536,
      conversationCaptureComposerMaxTokens: 768,
      curatorConversationCapturePlannerPrompt: 'Custom planner prompt',
      curatorConversationCaptureCoveragePrompt: 'Operator coverage policy',
      curatorConversationCaptureComposerPrompt: 'Custom composer prompt',
    });
  });

  it('round-trips semantic reconciliation prompt overrides', () => {
    const cfg = buildRuntimeConfig(bootstrap(), {
      ...DEFAULTS,
      curatorTopologyPrompt: 'topology override',
      curatorCreateAdjudicationPrompt: 'adjudication override',
      curatorPagePrompt: 'page override',
    }, CATALOG);
    expect({
      topology: cfg.curatorTopologyPrompt,
      adjudication: cfg.curatorCreateAdjudicationPrompt,
      page: cfg.curatorPagePrompt,
    }).toEqual({ topology: 'topology override', adjudication: 'adjudication override', page: 'page override' });
  });

  it('threads reasoningEffort as a plain field ("" = undefined)', () => {
    expect(buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG).reasoningEffort).toBeUndefined();
    expect(buildRuntimeConfig(bootstrap(), { ...DEFAULTS, reasoningEffort: 'none' }, CATALOG).reasoningEffort).toBe('none');
  });

  it('derives cadence ms and tz fallback and maps the automatic page caps', () => {
    const lowCaps = { ...DEFAULTS, topicWebCadence: '24h', archetypeTotalCap: 1, archetypeKindCap: 1, wikiPageCreatesPerRun: 0 };
    const cfg = buildRuntimeConfig(bootstrap(), lowCaps, CATALOG);
    expect(cfg.topicWebCadenceMs).toBe(24 * 60 * 60 * 1000);
    expect(cfg).not.toHaveProperty('archetypeCaps');
    expect(cfg).toMatchObject({ archetypeTotalCap: 1, archetypeKindCap: 1, wikiPageCreatesPerRun: 0 });
    expect(buildRuntimeConfig(bootstrap(), DEFAULTS, CATALOG))
      .toMatchObject({ archetypeTotalCap: 6, archetypeKindCap: 2, wikiPageCreatesPerRun: 3 });
    expect(cfg.curatorTz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);   // '' sentinel
    expect(buildRuntimeConfig(bootstrap(), { ...DEFAULTS, tz: 'Europe/Berlin' }, CATALOG).curatorTz).toBe('Europe/Berlin');
    expect(cfg.curatorSweepAt).toBe('05:00');
    expect(cfg.memorySweepSince).toBeNull();
    expect(cfg.engineUrl).toBe('http://e');
    expect(cfg.llmKeys).toEqual(bootstrap().llmKeys);
  });
});

type Payload = { effective: Record<string, unknown>; stored: Record<string, unknown>; version: number; seeded: boolean; issues: unknown[] };
type ModelsPayload = { catalog: ModelCatalogEntry[]; providers: Record<string, boolean>; version: number; issues: unknown[] };

const MODELS_PAYLOAD: ModelsPayload = {
  catalog: [{ title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true }],
  providers: { anthropic: true, fireworks: false },
  version: 1,
  issues: [],
};

function fakeApi(initial: Payload): { updates: Array<Record<string, unknown>>; api: EngineSettingsApi } {
  const updates: Array<Record<string, unknown>> = [];
  let d = initial;
  return {
    updates,
    api: {
      getSettings: async (domain?: string): Promise<GetSettingsResult> => domain === 'curator'
        ? { domains: { curator: d } }
        : { domains: { curator: d, models: MODELS_PAYLOAD } },
      updateSettings: async (_dom: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        d = { ...d, seeded: true, stored: { ...d.stored, ...patch } };
        return { warnings: [] };
      },
    },
  };
}
const payload = (over: Partial<Payload> = {}): Payload =>
  ({ effective: DEFAULTS as unknown as Record<string, unknown>, stored: {}, version: 0, seeded: false, issues: [], ...over });

describe('CuratorSettingsClient.seedIfNeeded', () => {
  it('does not seed deprecated cap aliases from env', async () => {
    const f = fakeApi(payload());
    const c = new CuratorSettingsClient(f.api, {
      CURATOR_THEMED_PAGE_CAP: '9',
      CURATOR_ARCHETYPE_TOTAL_CAP: '8',
      CURATOR_ARCHETYPE_KIND_CAP: '7',
    } as NodeJS.ProcessEnv, () => {});
    await c.seedIfNeeded();
    expect(f.updates[0]).toEqual({});
  });
  it('treats defined-but-empty ORG_MOVE_PATHS/_PIN as explicit empty lists', async () => {
    const f = fakeApi(payload());
    const c = new CuratorSettingsClient(f.api, { CURATOR_ORG_MOVE_PATHS: '', CURATOR_ORG_MOVE_PIN: '' } as NodeJS.ProcessEnv, () => {});
    await c.seedIfNeeded();
    expect(f.updates[0]).toEqual({ orgMovePaths: [], orgMovePin: [] });
  });
  it('drops seed keys already stored (pre-boot file edits win) and skips seeded domains', async () => {
    const f = fakeApi(payload({ stored: { meetingReads: 20 } }));
    const c = new CuratorSettingsClient(f.api, { CURATOR_MEETING_READS: '5', CURATOR_NOTE_READS: '4' } as NodeJS.ProcessEnv, () => {});
    await c.seedIfNeeded();
    expect(f.updates[0]).toEqual({ noteReads: 4 });
    const f2 = fakeApi(payload({ seeded: true }));
    const c2 = new CuratorSettingsClient(f2.api, { CURATOR_NOTE_READS: '4' } as NodeJS.ProcessEnv, () => {});
    await c2.seedIfNeeded();
    expect(f2.updates).toHaveLength(0);
  });
  it('still seeds the active statuses and project status field from env, through their old curator keys', async () => {
    const env = { CURATOR_ACTIVE_STATUSES: 'open, next', CURATOR_PROJECT_STATUS_FIELD: 'stage' } as NodeJS.ProcessEnv;
    const f = fakeApi(payload());
    await new CuratorSettingsClient(f.api, env, () => {}).seedIfNeeded();
    expect(f.updates[0]).toEqual({ activeStatuses: ['open', 'next'], projectStatusField: 'stage' });
    // A value Engine already stores (reported under the old name) beats env, as before.
    const f2 = fakeApi(payload({ stored: { activeStatuses: ['open'] } }));
    await new CuratorSettingsClient(f2.api, env, () => {}).seedIfNeeded();
    expect(f2.updates[0]).toEqual({ projectStatusField: 'stage' });
    // A seeded domain ignores them, and they are named as ignored.
    const warnings: string[] = [];
    const f3 = fakeApi(payload({ seeded: true }));
    const c3 = new CuratorSettingsClient(f3.api, env, m => warnings.push(m));
    await c3.seedIfNeeded();
    c3.warnStaleEnv();
    expect(f3.updates).toHaveLength(0);
    expect(warnings.filter(w => w.includes('is set but ignored')).map(w => w.split(' ')[1])).toEqual(
      expect.arrayContaining(['CURATOR_ACTIVE_STATUSES', 'CURATOR_PROJECT_STATUS_FIELD']));
  });
  it('a lazy seed that writes the active statuses is in the settings it returns', async () => {
    const VAULT = defaultsFor('vault') as unknown as VaultSettings;
    let calls = 0;
    const api: EngineSettingsApi = {
      getSettings: async (): Promise<GetSettingsResult> => {
        calls++;
        const seeded = calls > 1;
        return { domains: {
          curator: payload({ effective: { ...DEFAULTS } as unknown as Record<string, unknown>, seeded }),
          models: MODELS_PAYLOAD,
          vault: payload({ effective: { ...VAULT, projectActiveStatuses: seeded ? ['open', 'next'] : VAULT.projectActiveStatuses } as unknown as Record<string, unknown> }),
        } } as unknown as GetSettingsResult;
      },
      updateSettings: async () => ({ warnings: [] }),
    };
    const result = await new CuratorSettingsClient(api, { CURATOR_ACTIVE_STATUSES: 'open,next' } as NodeJS.ProcessEnv, () => {}).effective();
    expect(calls).toBe(2);
    expect(result.vault.projectActiveStatuses).toEqual(['open', 'next']);
  });
  it('is throw-safe when the engine is down', async () => {
    const c = new CuratorSettingsClient(
      { getSettings: async () => { throw new Error('down'); }, updateSettings: async () => ({ warnings: [] }) },
      {} as NodeJS.ProcessEnv, () => {});
    await expect(c.seedIfNeeded()).resolves.toBeUndefined();
  });
});

describe('CuratorSettingsClient.registerPromptDefaults', () => {
  it('registers semantic reconciliation and conversation capture prompt defaults', async () => {
    let registered: Record<string, string> = {};
    const api: EngineSettingsApi = {
      getSettings: async () => ({ domains: {} }),
      updateSettings: async () => ({ warnings: [] }),
      registerPromptDefaults: async (_domain, defaults) => {
        registered = defaults;
        return { warnings: [] };
      },
    };

    await new CuratorSettingsClient(api, {} as NodeJS.ProcessEnv, () => {}).registerPromptDefaults();

    expect(Object.keys(registered)).toEqual(expect.arrayContaining([
      'curatorTopologyPrompt', 'curatorCreateAdjudicationPrompt', 'curatorPagePrompt',
      'curatorConversationCapturePlannerPrompt', 'curatorConversationCaptureCoveragePrompt',
      'curatorConversationCaptureComposerPrompt',
    ]));
    expect(Object.values(registered).every(value => value.length > 0)).toBe(true);
  });
});

describe('CuratorSettingsClient.seedIfNeeded — seed-drop delta logging', () => {
  it('warns when an env var fails registry validation and is dropped before seeding', async () => {
    const f = fakeApi(payload());
    const warnings: string[] = [];
    const c = new CuratorSettingsClient(f.api, { CURATOR_MEETING_READS: 'abc' } as NodeJS.ProcessEnv, m => warnings.push(m));
    await c.seedIfNeeded();
    expect(f.updates).toEqual([{}]);   // nothing valid to seed, but the (empty) patch still submits
    expect(warnings.some(w => w.includes('CURATOR_MEETING_READS is set but its value failed validation and was NOT seeded'))).toBe(true);
  });

  it('does not misreport a key skipped only because a pre-boot file edit already stored it', async () => {
    const f = fakeApi(payload({ stored: { meetingReads: 20 } }));
    const warnings: string[] = [];
    const c = new CuratorSettingsClient(f.api, { CURATOR_MEETING_READS: '5' } as NodeJS.ProcessEnv, m => warnings.push(m));
    await c.seedIfNeeded();
    expect(warnings.some(w => w.includes('CURATOR_MEETING_READS'))).toBe(false);
  });
});

describe('CuratorSettingsClient — raw-id model-ref seed translation (controller-added scope)', () => {
  const CATALOG_WITH_DEEPSEEK: ModelCatalogEntry[] = [
    { title: 'DeepSeek v4 Pro', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-pro', enabled: true },
  ];

  function fakeApiWithCatalog(initial: Payload, catalog: ModelCatalogEntry[]): { updates: Array<Record<string, unknown>>; api: EngineSettingsApi } {
    const updates: Array<Record<string, unknown>> = [];
    let d = initial;
    return {
      updates,
      api: {
        getSettings: async (): Promise<GetSettingsResult> =>
          ({ domains: { curator: d, models: { catalog, providers: {}, version: 1, issues: [] } } }),
        updateSettings: async (_dom: string, patch: Record<string, unknown>) => {
          updates.push(patch);
          d = { ...d, seeded: true, stored: { ...d.stored, ...patch } };
          return { warnings: [] };
        },
      },
    };
  }

  it('translates a raw provider id matching a catalog entry into a [[Title]] ref before submitting', async () => {
    const f = fakeApiWithCatalog(payload(), CATALOG_WITH_DEEPSEEK);
    const c = new CuratorSettingsClient(f.api, { CURATOR_MODEL: 'accounts/fireworks/models/deepseek-v4-pro' } as NodeJS.ProcessEnv, () => {});
    await c.seedIfNeeded();
    expect(f.updates[0]).toEqual({ model: '[[DeepSeek v4 Pro]]' });
  });

  it('translates and seeds field-guess env values only while the settings domain is unseeded', async () => {
    const fieldGuessCatalog: ModelCatalogEntry[] = [
      ...CATALOG_WITH_DEEPSEEK,
      { title: 'GPT-OSS 120B', provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true },
    ];
    const env = {
      CURATOR_FIELD_GUESS_MODEL: 'accounts/fireworks/models/gpt-oss-120b',
      CURATOR_FIELD_GUESS_CAP: '0',
      CURATOR_FIELD_GUESS_MAX_TOKENS: '2500',
    } as NodeJS.ProcessEnv;
    const fresh = fakeApiWithCatalog(payload(), fieldGuessCatalog);
    await new CuratorSettingsClient(fresh.api, env, () => {}).seedIfNeeded();
    expect(fresh.updates).toEqual([{
      fieldGuessModel: '[[GPT-OSS 120B]]',
      fieldGuessCap: 0,
      fieldGuessMaxTokens: 2500,
    }]);

    const seeded = fakeApiWithCatalog(payload({ seeded: true }), fieldGuessCatalog);
    await new CuratorSettingsClient(seeded.api, env, () => {}).seedIfNeeded();
    expect(seeded.updates).toHaveLength(0);
  });

  it('leaves an unmatched raw id as-is and logs the drop when the engine rejects it', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const d = payload();
    const warnings: string[] = [];
    const api: EngineSettingsApi = {
      getSettings: async (): Promise<GetSettingsResult> =>
        ({ domains: { curator: d, models: { catalog: CATALOG_WITH_DEEPSEEK, providers: {}, version: 1, issues: [] } } }),
      updateSettings: async (_dom: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        return { warnings: [{ code: 'SETTINGS_MODEL_REF_UNRESOLVED', severity: 'warning', field: 'model', message: 'model does not resolve to an enabled Settings/Models entry' }] };
      },
    };
    const c = new CuratorSettingsClient(api, { CURATOR_MODEL: 'accounts/fireworks/models/unknown-x' } as NodeJS.ProcessEnv, m => warnings.push(m));
    await c.seedIfNeeded();
    expect(updates[0]).toEqual({ model: 'accounts/fireworks/models/unknown-x' });   // left untranslated — no catalog match
    expect(warnings.some(w => w.includes('CURATOR_MODEL is set but its value failed validation and was NOT seeded'))).toBe(true);
  });
});

describe('CuratorSettingsClient.effective', () => {
  it('serves fetched settings + catalog in one call, then last-known on failure, defaults + SEED_MODELS before any success', async () => {
    let fail = false;
    const d = payload({ effective: { ...DEFAULTS, noteReads: 4 } as unknown as Record<string, unknown>, seeded: true });
    const api: EngineSettingsApi = {
      getSettings: async (domain?: string): Promise<GetSettingsResult> => {
        if (fail) throw new Error('down');
        return domain === 'curator' ? { domains: { curator: d } } : { domains: { curator: d, models: MODELS_PAYLOAD } };
      },
      updateSettings: async () => ({ warnings: [] }),
    };
    const c = new CuratorSettingsClient(api, {} as NodeJS.ProcessEnv, () => {});
    const first = await c.effective();
    expect(first.settings.noteReads).toBe(4);
    expect(first.catalog).toEqual(MODELS_PAYLOAD.catalog);
    fail = true;
    const second = await c.effective();
    expect(second.settings.noteReads).toBe(4);   // last-known
    expect(second.catalog).toEqual(MODELS_PAYLOAD.catalog);   // last-known catalog too
    const cold = new CuratorSettingsClient({ getSettings: async () => { throw new Error('down'); }, updateSettings: async () => ({ warnings: [] }) }, {} as NodeJS.ProcessEnv, () => {});
    const coldResult = await cold.effective();
    expect(coldResult.settings.noteReads).toBe(6);        // registry defaults
    expect(coldResult.catalog).toEqual(SEED_MODELS);      // SEED_MODELS pre-success fallback
  });
});

describe('Engine vault map', () => {
  const VAULT = defaultsFor('vault') as unknown as VaultSettings;

  it('reads the vault domain from the same settings fetch, keeping the last known on failure', async () => {
    let fail = false;
    const d = payload({ effective: { ...DEFAULTS } as unknown as Record<string, unknown>, seeded: true });
    const api: EngineSettingsApi = {
      getSettings: async (): Promise<GetSettingsResult> => {
        if (fail) throw new Error('down');
        return { domains: { curator: d, models: MODELS_PAYLOAD,
          vault: payload({ effective: { ...VAULT, projectType: 'initiative', wikiDir: 'Curator Wikis' } as unknown as Record<string, unknown> }) } } as unknown as GetSettingsResult;
      },
      updateSettings: async () => ({ warnings: [] }),
    };
    const c = new CuratorSettingsClient(api, {} as NodeJS.ProcessEnv, () => {});
    expect((await c.effective()).vault).toMatchObject({ projectType: 'initiative', wikiDir: 'Curator Wikis' });
    expect((await c.effectiveStrict()).vault.wikiDir).toBe('Curator Wikis');
    fail = true;
    expect((await c.effective()).vault.projectType).toBe('initiative');
  });

  it('reads an older Engine\'s wiki and curator keys when it reports no vault domain', async () => {
    const api: EngineSettingsApi = {
      getSettings: async (): Promise<GetSettingsResult> => ({ domains: {
        curator: payload({ effective: { ...DEFAULTS, activeStatuses: ['live'], projectStatusField: 'stage' } as unknown as Record<string, unknown>, seeded: true }),
        models: MODELS_PAYLOAD,
        wiki: payload({ effective: { projectType: 'initiative', wikiDir: 'W' } }),
      } }) as unknown as GetSettingsResult,
      updateSettings: async () => ({ warnings: [] }),
    };
    const { vault } = await new CuratorSettingsClient(api, {} as NodeJS.ProcessEnv, () => {}).effective();
    expect(vault).toMatchObject({ projectType: 'initiative', wikiDir: 'W', projectActiveStatuses: ['live'], projectStatusField: 'stage' });
  });

  it('builds the run config\'s names from the vault map, keeping none', () => {
    const config = buildRuntimeConfig(bootstrap(), DEFAULTS as CuratorSettings, CATALOG, { vault: {
      ...VAULT, projectType: null, projectStatusField: null, projectActiveStatuses: ['live'], wikiDir: 'W', topicDir: 'Subjects',
    } });
    expect(config).toMatchObject({
      projectType: null, projectStatusField: null, activeStatuses: ['live'], wikiDir: 'W', topicDir: 'Subjects',
    });
    expect(config.vault?.projectType).toBeNull();
    expect(projectTypeOf(config)).toBeNull();
    const fallback = buildRuntimeConfig(bootstrap(), DEFAULTS as CuratorSettings, CATALOG);
    expect(fallback).toMatchObject({
      projectType: 'project', projectStatusField: 'status', activeStatuses: ['open', 'in-progress'], wikiDir: 'Wikis', topicDir: null,
    });
    expect(projectTypeOf({})).toBe('project');
    expect(vaultOf({})).toEqual(VAULT);
  });
});

describe('CuratorSettingsClient.effective — lazy re-seed (deploy-race coverage)', () => {
  it('seeds exactly once when the fetched payload reports seeded:false, and the returned settings reflect the re-fetch', async () => {
    const updates: Array<Record<string, unknown>> = [];
    let getCalls = 0;
    const preSeed = payload({ effective: { ...DEFAULTS, noteReads: 4 } as unknown as Record<string, unknown>, seeded: false });
    const postSeed = payload({ effective: { ...DEFAULTS, noteReads: 5 } as unknown as Record<string, unknown>, seeded: true, stored: { noteReads: 5 } });
    const api: EngineSettingsApi = {
      getSettings: async () => {
        getCalls++;
        return { domains: { curator: getCalls === 1 ? preSeed : postSeed, models: MODELS_PAYLOAD } };
      },
      updateSettings: async (_dom: string, patch: Record<string, unknown>) => { updates.push(patch); return { warnings: [] }; },
    };
    const c = new CuratorSettingsClient(api, { CURATOR_NOTE_READS: '5' } as NodeJS.ProcessEnv, () => {});

    const result = await c.effective();
    expect(updates).toEqual([{ noteReads: 5 }]);
    expect(getCalls).toBe(2);              // fetch, seed, re-fetch
    expect(result.settings.noteReads).toBe(5);      // reflects the re-fetch, not the pre-seed 4
    expect(result.catalog).toEqual(MODELS_PAYLOAD.catalog);

    // A subsequent effective() sees seeded:true and submits nothing more.
    const result2 = await c.effective();
    expect(updates).toHaveLength(1);
    expect(result2.settings.noteReads).toBe(5);
  });

  it('seeds lazily via effective() once the engine recovers after a seedIfNeeded() that hit connection-refused at boot', async () => {
    let up = false;
    const updates: Array<Record<string, unknown>> = [];
    let d = payload({ seeded: false });
    const api: EngineSettingsApi = {
      getSettings: async (domain?: string): Promise<GetSettingsResult> => {
        if (!up) throw new Error('connect ECONNREFUSED');
        return domain === 'curator' ? { domains: { curator: d } } : { domains: { curator: d, models: MODELS_PAYLOAD } };
      },
      updateSettings: async (_dom: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        d = { ...d, seeded: true, stored: { ...d.stored, ...patch } };
        return { warnings: [] };
      },
    };
    const c = new CuratorSettingsClient(api, { CURATOR_NOTE_READS: '4' } as NodeJS.ProcessEnv, () => {});

    await c.seedIfNeeded();               // engine still booting: throw-safe, nothing submitted
    expect(updates).toHaveLength(0);

    up = true;                            // engine now reachable, domain still unseeded
    await c.effective();                  // lazy path fires
    expect(updates).toEqual([{ noteReads: 4 }]);
  });
});

describe('CuratorSettingsClient.warnStaleEnv', () => {
  it('warns for live env seeds and identifies the dead cap alias as an uncapped no-op', async () => {
    const warnings: string[] = [];
    const f = fakeApi(payload({ seeded: true }));
    const c = new CuratorSettingsClient(f.api,
      { CURATOR_NOTE_READS: '4', CURATOR_THEMED_PAGE_CAP: '9', ENGINE_URL: 'x' } as NodeJS.ProcessEnv,
      m => warnings.push(m));
    await c.seedIfNeeded();   // seeded:true payload confirms seeding without submitting
    c.warnStaleEnv();
    // noteReads is shown in the Wikis note (#746).
    expect(warnings.filter(w => w.includes('Settings/Curator/Wikis.md'))).toHaveLength(1);
    expect(warnings.some(w => w.includes('CURATOR_THEMED_PAGE_CAP is dead') && w.includes('uncapped'))).toBe(true);
    expect(warnings.some(w => w.includes('ENGINE_URL'))).toBe(false);
    expect(warnings.find(w => w.includes('CURATOR_NOTE_READS'))).toContain('Remove it from curator.env.');
  });

  it('does not advise removal until a seed is confirmed — the var may be the only record of the operator\'s intent', () => {
    const warnings: string[] = [];
    const c = new CuratorSettingsClient(fakeApi(payload()).api,
      { CURATOR_NOTE_READS: '4', CURATOR_THEMED_PAGE_CAP: '9' } as NodeJS.ProcessEnv,
      m => warnings.push(m));
    c.warnStaleEnv();   // no seedIfNeeded()/effective() call yet — unconfirmed
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('Remove it'))).toBe(false);
    expect(warnings.find(w => w.includes('CURATOR_NOTE_READS'))).toContain('Settings/Curator/Wikis.md');
    expect(warnings.find(w => w.includes('CURATOR_NOTE_READS'))).toContain('keep it until seeding is confirmed');
    expect(warnings.find(w => w.includes('CURATOR_THEMED_PAGE_CAP'))).toContain('uncapped');
  });

  it('flags CURATOR_PROVIDER as dead regardless of seed-confirmation state — it never seeds anything', () => {
    const warnings: string[] = [];
    const c = new CuratorSettingsClient(fakeApi(payload()).api,
      { CURATOR_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv,
      m => warnings.push(m));
    c.warnStaleEnv();
    expect(warnings.some(w => w.includes('CURATOR_PROVIDER is dead') && w.includes("model's Settings/Models entry"))).toBe(true);
  });
});
