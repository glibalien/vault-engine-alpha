import { describe, expect, it, vi } from 'vitest';
import { resolveWikiOutputPolicy, resolveWikiStagePolicy, bindWikiStageClient, withWikiCallContext, resolvedWikiOutputPolicySchema, wikiOutputPolicyHash } from '../src/wiki-output-policy.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type OpenAI from 'openai';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';
const config = (patch: Partial<Config> = {}) => ({ model: 'auto', homeMaxTokens: 100000,
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
  wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
  ...patch }) as Config;
const client = () => new OpenAiCompatLlmClient({} as OpenAI, {provider:'openrouter',fireworksExtensions:false,reasoningEffort:'high'});
it('resolves each stage and freezes nested configuration', () => {
  const p = resolveWikiOutputPolicy(config({wikiPlanningMaxTokens:24000,wikiPageMaxTokens:32000,wikiHomeMaxTokens:16000,
    wikiPlanningReasoningEffort:'medium',wikiPageReasoningEffort:'low',wikiHomeReasoningEffort:'low'}), client());
  expect([p.planning.maxTokens,p.page.maxTokens,p.home.maxTokens]).toEqual([24000,32000,16000]);
  expect([p.planning.configuration.reasoningEffort,p.page.configuration.reasoningEffort,p.home.configuration.reasoningEffort]).toEqual(['medium','low','low']);
  expect(() => { (p.page.configuration as {reasoningEffort:string}).reasoningEffort='high'; }).toThrow();
});
it('inherits actual adapter configuration and can explicitly omit effort', () => {
  const p = resolveWikiOutputPolicy(config({reasoningEffort:'low'}),client());
  expect(p.page).toEqual({model:'auto',maxTokens:100000,configuration:{provider:'openrouter',reasoningEffort:'high'}});
  expect(resolveWikiStagePolicy(client(),'auto',16000,'provider-default').configuration.reasoningEffort).toBeNull();
});
it.each([null,-1,1.5,NaN,Infinity])('rejects invalid cap %s before dispatch', cap => {
  expect(() => resolveWikiOutputPolicy(config({wikiPageMaxTokens:cap as number}),client())).toThrow();
});
it('rejects unsupported configuration, native effort and corrupt snapshots', () => {
  const native = {configurationFor:()=>({provider:'anthropic',reasoningEffort:null}),withConfiguration:vi.fn(),structuredCall:vi.fn()} as LlmClient;
  expect(()=>resolveWikiStagePolicy(native,'claude',16000,'low')).toThrow('WIKI_OUTPUT_REASONING_UNSUPPORTED');
  expect(native.structuredCall).not.toHaveBeenCalled();
  expect(()=>resolveWikiOutputPolicy(config(),{structuredCall:vi.fn()})).toThrow('WIKI_OUTPUT_CONFIGURATION_UNSUPPORTED');
  expect(()=>resolveWikiStagePolicy(client(),'auto',16000,'bogus' as 'low')).toThrow();
  const p=resolveWikiOutputPolicy(config(),client());
  expect(resolvedWikiOutputPolicySchema.safeParse({...p,version:2}).success).toBe(false);
  expect(resolvedWikiOutputPolicySchema.safeParse({...p,page:undefined}).success).toBe(false);
});
it('binds request reasoning without leaking observer context or mutating the base client',async()=>{
  const base=client(), p=resolveWikiOutputPolicy(config({wikiPageReasoningEffort:'low'}),base);
  const llm=withWikiCallContext(bindWikiStageClient(base,p.page),{stage:'page',attempt:0,policyVersion:1,...p.page});
  const req={model:'auto',maxTokens:32000,system:'system',user:'evidence',toolName:'emit',toolDescription:'emit',schema:{}};
  const preview=await llm.previewStructuredCall!(req);
  expect(preview.payload).toMatchObject({max_tokens:32000,reasoning_effort:'low'});
  expect(preview.payload).not.toHaveProperty('wikiContext');
  expect(base.configurationFor('auto').reasoningEffort).toBe('high');
});
it('routes each stage to its own model and that model\'s provider configuration', () => {
  const dispatching = {
    configurationFor: (model: string) => model.startsWith('accounts/fireworks/')
      ? { provider: 'fireworks' as const, reasoningEffort: null } : { provider: 'openrouter' as const, reasoningEffort: 'high' },
    withConfiguration: vi.fn(), structuredCall: vi.fn(),
  } as unknown as LlmClient;
  const p = resolveWikiOutputPolicy(config({ wikiPlanningModel: 'anthropic/strong-planner',
    wikiPageModel: 'accounts/fireworks/models/cheap-pages', wikiHomeModel: null }), dispatching);
  expect([p.planning.model, p.page.model, p.home.model]).toEqual(['anthropic/strong-planner', 'accounts/fireworks/models/cheap-pages', 'auto']);
  expect([p.planning.configuration.provider, p.page.configuration.provider, p.home.configuration.provider])
    .toEqual(['openrouter', 'fireworks', 'openrouter']);
  expect(dispatching.structuredCall).not.toHaveBeenCalled();
});
it('reads checkpoints frozen before per-stage models with the shared model, and stays strict', () => {
  const p = resolveWikiOutputPolicy(config(), client());
  const legacy = { ...p, planning: { maxTokens: p.planning.maxTokens, configuration: p.planning.configuration },
    page: { maxTokens: p.page.maxTokens, configuration: p.page.configuration },
    home: { maxTokens: p.home.maxTokens, configuration: p.home.configuration } };
  const parsed = resolvedWikiOutputPolicySchema.parse(JSON.parse(JSON.stringify(legacy)));
  expect([parsed.planning.model, parsed.page.model, parsed.home.model]).toEqual(['auto', 'auto', 'auto']);
  expect(resolvedWikiOutputPolicySchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  expect(resolvedWikiOutputPolicySchema.safeParse({ ...p, page: { ...p.page, extra: true } }).success).toBe(false);
});

describe('reasoning budgets (#429)', () => {
  const fireworks = () => new OpenAiCompatLlmClient({} as OpenAI, { provider: 'fireworks' });
  const capped = (patch: Partial<Config> = {}) => config({ wikiPlanningMaxTokens: 24000, wikiPageMaxTokens: 32000,
    wikiHomeMaxTokens: 16000, ...patch });
  const req = { model: 'auto', maxTokens: 32000, system: 'system', user: 'evidence', toolName: 'emit', toolDescription: 'emit', schema: {} };

  it('leaves a policy without budgets, and its hash, exactly as before', () => {
    const p = resolveWikiOutputPolicy(capped({ wikiPlanningReasoningBudget: 0, wikiPageReasoningBudget: 0, wikiHomeReasoningBudget: 0 }), client());
    // Config from before #429 has no budget keys at all.
    const older = resolveWikiOutputPolicy(capped(), client());
    expect(JSON.stringify(p.page)).toBe('{"model":"auto","maxTokens":32000,"configuration":{"provider":"openrouter","reasoningEffort":"high"}}');
    expect(wikiOutputPolicyHash(p)).toBe(wikiOutputPolicyHash(older));
    expect(p.page.configuration).not.toHaveProperty('reasoningBudget');
  });

  it('replaces the inherited effort with the budget for that stage only, and changes the hash', async () => {
    const before = resolveWikiOutputPolicy(capped(), client());
    const p = resolveWikiOutputPolicy(capped({ wikiPageReasoningBudget: 6000 }), client());
    expect(p.page.configuration).toEqual({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 6000 });
    expect(p.planning.configuration).toEqual({ provider: 'openrouter', reasoningEffort: 'high' });
    expect(p.home.configuration).toEqual({ provider: 'openrouter', reasoningEffort: 'high' });
    expect(wikiOutputPolicyHash(p)).not.toBe(wikiOutputPolicyHash(before));
    const preview = await bindWikiStageClient(client(), p.page).previewStructuredCall!(req);
    expect(preview.payload).toMatchObject({ max_tokens: 32000, reasoning: { max_tokens: 6000 } });
    expect(preview.payload).not.toHaveProperty('reasoning_effort');
  });

  it('accepts provider-default beside a budget', () => {
    expect(resolveWikiStagePolicy(client(), 'auto', 16000, 'provider-default', 4000).configuration)
      .toEqual({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 4000 });
  });

  it.each(['none', 'low', 'medium', 'high'] as const)('refuses a budget beside the explicit effort %s', effort => {
    expect(() => resolveWikiOutputPolicy(capped({ wikiHomeReasoningEffort: effort, wikiHomeReasoningBudget: 4000 }), client()))
      .toThrow(`WIKI_OUTPUT_POLICY_INVALID: a reasoning budget replaces the reasoning effort; set the stage's effort to inherit or provider-default, not ${effort}`);
  });

  it.each([16000, 20000])('refuses a home budget of %i that leaves the answer no room under the 16000 cap', budget => {
    expect(() => resolveWikiOutputPolicy(capped({ wikiHomeReasoningBudget: budget }), client()))
      .toThrow(`WIKI_OUTPUT_POLICY_INVALID: a reasoning budget of ${budget} must be below the stage's output cap of 16000`);
    expect(resolveWikiOutputPolicy(capped({ wikiHomeReasoningBudget: 15999 }), client()).home.configuration.reasoningBudget).toBe(15999);
  });

  it('checks the budget against the inherited cap when the stage cap is 0', () => {
    expect(() => resolveWikiOutputPolicy(config({ homeMaxTokens: 4000, wikiPageReasoningBudget: 4000 }), client()))
      .toThrow('below the stage\'s output cap of 4000');
  });

  it.each([-1, 1.5, NaN, Infinity])('refuses an invalid budget %s', budget => {
    expect(() => resolveWikiOutputPolicy(capped({ wikiPageReasoningBudget: budget }), client())).toThrow('WIKI_OUTPUT_POLICY_INVALID');
  });

  it('refuses a budget for a provider that cannot honor it, before any call', () => {
    const native = { configurationFor: () => ({ provider: 'anthropic', reasoningEffort: null }), withConfiguration: vi.fn(), structuredCall: vi.fn() } as LlmClient;
    expect(() => resolveWikiStagePolicy(native, 'claude', 16000, 'inherit', 4000))
      .toThrow('WIKI_OUTPUT_REASONING_UNSUPPORTED: anthropic models can\'t take a reasoning budget');
    expect(() => resolveWikiStagePolicy(fireworks(), 'accounts/fireworks/models/x', 16000, 'provider-default', 4000))
      .toThrow('WIKI_OUTPUT_REASONING_UNSUPPORTED: fireworks');
    expect(native.structuredCall).not.toHaveBeenCalled();
    expect(native.withConfiguration).not.toHaveBeenCalled();
  });

  it('does not inherit a budget from an already-bound client', () => {
    const bound = client().withConfiguration({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: 2000 });
    expect(resolveWikiStagePolicy(bound, 'auto', 16000, 'inherit').configuration).toEqual({ provider: 'openrouter', reasoningEffort: null });
  });

  it('takes none as an effort, except on native Anthropic', () => {
    expect(resolveWikiStagePolicy(client(), 'auto', 16000, 'none').configuration).toEqual({ provider: 'openrouter', reasoningEffort: 'none' });
    const native = { configurationFor: () => ({ provider: 'anthropic', reasoningEffort: null }), withConfiguration: vi.fn(), structuredCall: vi.fn() } as LlmClient;
    expect(() => resolveWikiStagePolicy(native, 'claude', 16000, 'none')).toThrow('WIKI_OUTPUT_REASONING_UNSUPPORTED');
  });

  it('round-trips a frozen budget, still reads records without one, and refuses impossible stored budgets', () => {
    const p = resolveWikiOutputPolicy(capped({ wikiPageReasoningBudget: 6000 }), client());
    expect(resolvedWikiOutputPolicySchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const plain = resolveWikiOutputPolicy(capped(), client());
    expect(resolvedWikiOutputPolicySchema.parse(JSON.parse(JSON.stringify(plain)))).toEqual(plain);
    const legacy = { ...p, page: { maxTokens: 32000, configuration: p.page.configuration } };
    expect(resolvedWikiOutputPolicySchema.parse(JSON.parse(JSON.stringify(legacy))).page.configuration.reasoningBudget).toBe(6000);
    for (const page of [
      { ...p.page, maxTokens: 6000 },
      { ...p.page, configuration: { ...p.page.configuration, reasoningEffort: 'low' } },
      { ...p.page, configuration: { provider: 'fireworks', reasoningEffort: null, reasoningBudget: 6000 } },
      { ...p.page, configuration: { ...p.page.configuration, reasoningBudget: 0 } },
      { maxTokens: 6000, configuration: p.page.configuration },
    ]) expect(resolvedWikiOutputPolicySchema.safeParse({ ...p, page }).success).toBe(false);
  });
});
