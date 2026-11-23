import { describe, expect, it } from 'vitest';
import { validateDomainPatch, defaultsFor, descriptorsFor, seedFromEnv, DOMAINS } from '../src/index.js';

describe('chat domain', () => {
  it('is registered with 8 keys and the config.ts defaults', () => {
    expect(DOMAINS).toContain('chat');
    expect(descriptorsFor('chat')).toHaveLength(8);
    expect(defaultsFor('chat')).toEqual({
      defaultModel: '[[Qwen 3.7 Plus]]',
      titleModel: '[[GPT-OSS 120B]]',
      vizModel: '[[GPT-OSS 120B]]',
      maxSteps: 10,
      contextBudget: 32768,
      responseReserve: 4096,
      chatSystemPrompt: '',
      chatTieringNote: '',
    });
  });
  it('validates values', () => {
    expect(validateDomainPatch('chat', { maxSteps: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('chat', { defaultModel: '' }).issues).toHaveLength(1);
    expect(validateDomainPatch('chat', { maxSteps: 6, contextBudget: 16384 }).valid)
      .toEqual({ maxSteps: 6, contextBudget: 16384 });
    expect(validateDomainPatch('chat', { chatSystemPrompt: 'line 1\nline 2' }).issues).toHaveLength(0);
    expect(validateDomainPatch('chat', { chatSystemPrompt: 12 }).issues).toHaveLength(1);
  });
  it('seeds from the chat env vars', () => {
    expect(seedFromEnv('chat', {
      MODEL: 'accounts/fireworks/models/kimi-k2p6',
      TITLE_MODEL: 'GPT-OSS 120B',
      MAX_STEPS: '12',
      CONTEXT_BUDGET: 'garbage',   // unparseable → dropped
    })).toEqual({ defaultModel: 'accounts/fireworks/models/kimi-k2p6', titleModel: 'GPT-OSS 120B', maxSteps: 12 });
  });
  it('validates titleModel as a model-ref (empty string rejected)', () => {
    expect(validateDomainPatch('chat', { titleModel: '' }).issues).toHaveLength(1);
    expect(validateDomainPatch('chat', { titleModel: '[[GPT-OSS 120B]]' }).issues).toHaveLength(0);
  });
  it('validates vizModel as a model-ref (empty string rejected), and it has no env seed', () => {
    expect(validateDomainPatch('chat', { vizModel: '' }).issues).toHaveLength(1);
    expect(validateDomainPatch('chat', { vizModel: '[[GPT-OSS 120B]]' }).issues).toHaveLength(0);
    expect(seedFromEnv('chat', { VIZ_MODEL: 'nope' })).toEqual({});
  });
  it('every descriptor has a description and its default validates', () => {
    for (const d of descriptorsFor('chat')) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(validateDomainPatch('chat', { [d.key]: defaultsFor('chat')[d.key] }).issues).toEqual([]);
    }
  });
});
