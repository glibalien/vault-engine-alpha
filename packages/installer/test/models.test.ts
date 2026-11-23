import { descriptorsFor, SEED_MODELS } from '@vault/settings-registry';
import { describe, expect, it } from 'vitest';
import type { Answers } from '../src/answers.js';
import { builtInModels, modelRoles, runModelsStage, type ModelsPlan } from '../src/models.js';
import { createScriptedPrompter } from '../src/prompter.js';
import type { ProviderId, ProviderKey } from '../src/providers.js';
import { Secret } from '../src/secret.js';
import { replayPrompter } from './helpers.js';

function key(provider: ProviderId): ProviderKey {
  return { provider, source: 'entered', secret: new Secret(`key-${provider}`), check: 'valid', detail: 'accepted' };
}

async function headless(providers: ProviderId[], models: Answers['models'] = {}, curatorInstalled = true) {
  const lines: string[] = [];
  const prompter = createScriptedPrompter({ version: 1, vault: { path: '/v' }, models }, line => lines.push(line));
  const plan = await runModelsStage({ prompter, keys: providers.map(key), curatorInstalled });
  return { plan, lines };
}

function role(plan: ModelsPlan, id: string) {
  const assignment = plan.assignments.find(candidate => candidate.role.id === id);
  if (!assignment) throw new Error(`no role ${id}`);
  return { model: assignment.model?.title ?? null, off: assignment.off };
}

describe('model roles', () => {
  it('covers every model setting in the engine, chat, and curator domains', () => {
    const registry = (['engine', 'chat', 'curator'] as const).flatMap(domain =>
      descriptorsFor(domain).filter(descriptor => descriptor.type.kind === 'model-ref').map(descriptor => `${domain}.${descriptor.key}`));

    expect(modelRoles().map(candidate => candidate.id)).toEqual(registry);
    expect(registry).toEqual(expect.arrayContaining(['curator.fieldGuessModel', 'chat.titleModel', 'chat.vizModel']));
  });

  it('offers every seed model and only priced models', () => {
    const models = builtInModels();

    expect(models.map(model => model.title)).toEqual(expect.arrayContaining(SEED_MODELS.map(model => model.title)));
    expect(models.filter(model => !model.seeded).map(model => model.title))
      .toEqual(['DeepSeek V4 Flash', 'Minimax M3', 'GLM 5.2', 'MiMo-V2.5', 'MiMo-V2.5-Pro', 'GPT-6.1 Terra', 'GPT-6 Luna']);
    expect(models.every(model => model.pricing.input > 0 && model.pricing.output > 0)).toBe(true);
  });
});

describe('runModelsStage', () => {
  it('fills every model setting in use on an Anthropic-only install, Engine memory consolidation included', async () => {
    const { plan } = await headless(['anthropic']);

    expect(plan.visionProvider).toBe('claude');
    expect(role(plan, 'curator.model')).toEqual({ model: 'Claude Sonnet 4.6', off: null });
    expect(role(plan, 'chat.titleModel')).toEqual({ model: 'Claude Sonnet 4.6', off: null });
    expect(role(plan, 'curator.fieldGuessModel')).toEqual({ model: 'Claude Sonnet 4.6', off: null });
    expect(role(plan, 'curator.wikiPageModel')).toEqual({ model: null, off: null });
    expect(role(plan, 'engine.memoryConsolidationModel')).toEqual({ model: 'Claude Sonnet 4.6', off: null });
    expect(role(plan, 'engine.visionModel')).toEqual({ model: null, off: 'images use Claude' });
    // Every non-nullable setting is either set or explained.
    for (const assignment of plan.assignments.filter(candidate => !candidate.role.nullable)) {
      expect(assignment.model !== null || assignment.off !== null).toBe(true);
    }
    expect(plan.additions).toEqual([]);
  });

  it('fills every model setting on an OpenAI-only install with the GPT-6 models and adds them to the catalog', async () => {
    const balanced = (await headless(['openai'])).plan;
    const lowCost = (await headless(['openai'], { preset: 'low-cost' })).plan;

    expect(balanced.visionProvider).toBe('model');
    expect(role(balanced, 'curator.model')).toEqual({ model: 'GPT-6.1 Terra', off: null });
    expect(role(balanced, 'chat.titleModel')).toEqual({ model: 'GPT-6 Luna', off: null });
    expect(role(balanced, 'engine.memoryConsolidationModel')).toEqual({ model: 'GPT-6 Luna', off: null });
    expect(role(balanced, 'engine.visionModel')).toEqual({ model: 'GPT-6 Luna', off: null });
    expect(balanced.additions.map(model => model.title).sort()).toEqual(['GPT-6 Luna', 'GPT-6.1 Terra']);
    expect(role(lowCost, 'curator.model').model).toBe('GPT-6 Luna');
    for (const assignment of balanced.assignments.filter(candidate => !candidate.role.nullable)) {
      expect(assignment.model !== null || assignment.off !== null).toBe(true);
    }
  });

  it('picks balanced and low-cost models on Fireworks and adds unseeded ones to the catalog', async () => {
    const balanced = (await headless(['fireworks'])).plan;
    const lowCost = (await headless(['fireworks'], { preset: 'low-cost' })).plan;

    expect(balanced.visionProvider).toBe('model');
    expect(role(balanced, 'curator.model').model).toBe('Kimi K2.6');
    expect(role(balanced, 'chat.vizModel').model).toBe('GPT-OSS 120B');
    expect(role(balanced, 'engine.memoryConsolidationModel').model).toBe('GPT-OSS 120B');
    expect(role(balanced, 'engine.visionModel')).toEqual({ model: 'Minimax M3', off: null });
    expect(balanced.additions.map(model => model.title)).toEqual(['Minimax M3']);
    expect(role(lowCost, 'curator.model').model).toBe('DeepSeek V4 Flash');
    expect(lowCost.additions.map(model => model.title)).toEqual(['Minimax M3', 'DeepSeek V4 Flash']);
  });

  it('never gives Engine an Anthropic model or image vision a model without vision', async () => {
    const { plan } = await headless(['anthropic', 'fireworks', 'openrouter'], { preset: 'balanced', vision_provider: 'model' });

    for (const assignment of plan.assignments.filter(candidate => candidate.role.domain === 'engine')) {
      expect(assignment.model?.provider).not.toBe('anthropic');
    }
    expect(plan.assignments.find(candidate => candidate.role.id === 'engine.visionModel')?.model?.vision).toBe(true);
    expect(role(plan, 'curator.model').model).toBe('Claude Sonnet 4.6');
  });

  it('turns off Curator roles when Curator is not installed, and everything without a model key', async () => {
    const noCurator = (await headless(['openrouter'], {}, false)).plan;
    const noKeys = (await headless([])).plan;

    expect(role(noCurator, 'curator.model')).toEqual({ model: null, off: 'Curator is not installed' });
    expect(role(noCurator, 'chat.defaultModel').model).toBe('GLM 5.2');
    expect(noKeys.visionProvider).toBe('off');
    expect(role(noKeys, 'chat.defaultModel').off).toMatch(/needs an Anthropic, Fireworks, or OpenRouter key/);
  });

  it('applies custom role choices, custom models, and inheritance from an answers file', async () => {
    const { plan } = await headless(['fireworks'], {
      preset: 'custom',
      vision_provider: 'off',
      custom_models: [{ title: 'Kimi K3', provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' }],
      roles: { 'curator.model': 'Kimi K3', 'curator.wikiPageModel': 'GPT-OSS 120B', 'curator.wikiPlanningModel': null },
    });

    expect(role(plan, 'curator.model').model).toBe('Kimi K3');
    expect(role(plan, 'curator.wikiPageModel').model).toBe('GPT-OSS 120B');
    expect(role(plan, 'curator.wikiPlanningModel')).toEqual({ model: null, off: null });
    expect(role(plan, 'chat.defaultModel').model).toBe('Kimi K2.6');
    expect(plan.additions.map(model => model.title)).toEqual(['Kimi K3']);
  });

  it.each([
    [{ roles: { 'curator.nope': 'GPT-OSS 120B' } }, /curator.nope is not a model role/],
    [{ roles: { 'curator.model': 'Claude Sonnet 4.6' } }, /Claude Sonnet 4.6 is not a model curator.model can use/],
    [{ roles: { 'curator.model': null } }, /curator.model needs a model/],
    [{ custom_models: [{ title: 'Mystery', provider: 'fireworks' as const, model: 'accounts/fireworks/models/mystery-1' }] },
      /No price is known for accounts\/fireworks\/models\/mystery-1/],
    [{ custom_models: [{ title: 'Big OSS', provider: 'fireworks' as const, model: 'accounts/fireworks/models/gpt-oss-120b' }] },
      /already in the catalog as GPT-OSS 120B/],
    [{ custom_models: [{ title: 'gpt-oss 120b', provider: 'fireworks' as const, model: 'accounts/fireworks/models/kimi-k3' }] },
      /already has a model titled GPT-OSS 120B/],
    [{ custom_models: [{ title: 'GLM', provider: 'openrouter' as const, model: 'z-ai/glm-5.2' }] }, /served by OpenRouter, which has no key/],
    // add-model would store these titles differently, so a [[title]] reference would dangle.
    [{ custom_models: [{ title: 'Kimi K3 #1', provider: 'fireworks' as const, model: 'accounts/fireworks/models/kimi-k3' }] },
      /add-model would save "Kimi K3 #1" as "Kimi K3 -1"/],
    [{ custom_models: [{ title: 'Kimi  K3', provider: 'fireworks' as const, model: 'accounts/fireworks/models/kimi-k3' }] },
      /add-model would save "Kimi  K3" as "Kimi K3"/],
    // A family estimate (DeepSeek V4 Pro's rates) is not a list price for this model.
    [{ custom_models: [{ title: 'DeepSeek V9', provider: 'fireworks' as const, model: 'accounts/fireworks/models/deepseek-v9' }] },
      /No price is known for accounts\/fireworks\/models\/deepseek-v9/],
  ])('rejects invalid custom answers: %j', async (answers, message) => {
    await expect(headless(['fireworks'], { preset: 'custom', vision_provider: 'off', ...answers })).rejects.toThrow(message);
  });

  it.each([
    [{ title: 'Qwen 3.7 Plus', provider: 'openrouter' as const, model: 'z-ai/glm-5.2-custom' }, /already has a model titled Qwen 3.7 Plus/],
    [{ title: 'Cheap OSS', provider: 'openrouter' as const, model: 'accounts/fireworks/models/gpt-oss-120b' }, /already in the catalog as GPT-OSS 120B/],
  ])('reserves every seed model, even one whose provider has no key: %j', async (custom, message) => {
    await expect(headless(['openrouter'], { preset: 'custom', vision_provider: 'off', custom_models: [custom] })).rejects.toThrow(message);
  });

  it('ignores, with a warning, a role choice for a role that is off', async () => {
    const { plan, lines } = await headless(['fireworks', 'gemini'], {
      preset: 'custom',
      vision_provider: 'gemini',
      roles: { 'engine.visionModel': 'Minimax M3' },
    });

    expect(role(plan, 'engine.visionModel')).toEqual({ model: null, off: 'images use Gemini' });
    expect(lines).toContain('Warning: Ignoring the model for engine.visionModel: images use Gemini.');
  });

  it('offers only vision providers the keys allow', async () => {
    await expect(headless(['fireworks'], { vision_provider: 'gemini' })).rejects.toThrow(/must be one of: model, off/);
  });

  it('adds another model interactively, asking for Curator writing first', async () => {
    const { prompter, asked } = replayPrompter({
      'models.vision_provider': ['off'],
      'models.preset': ['custom'],
      'models.roles': ['__other__'],
      'models.custom_models': ['fireworks', 'accounts/fireworks/models/kimi-k3', 'Kimi K3'],
    });

    const plan = await runModelsStage({ prompter, keys: [key('fireworks')], curatorInstalled: true });

    expect(role(plan, 'curator.model').model).toBe('Kimi K3');
    expect(role(plan, 'curator.wikiHomeModel')).toEqual({ model: null, off: null });
    expect(asked.filter(id => id === 'models.roles')).toHaveLength(6);
    expect(plan.additions.map(model => model.title)).toEqual(['Kimi K3']);
  });
});
