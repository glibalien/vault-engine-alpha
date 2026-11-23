import { describe, it, expect } from 'vitest';
import { providerForModel } from '../src/llm/provider-for-model.js';

const CATALOG = {
  'accounts/fireworks/models/qwen3p7-plus': 'fireworks',
  'claude-sonnet-4-6': 'anthropic',
  'moonshotai/kimi-k2': 'openrouter',
} as const;

describe('providerForModel', () => {
  it('routes a catalog-resolved model to its own provider', () => {
    const providerFor = providerForModel({ ...CATALOG });
    expect(providerFor('moonshotai/kimi-k2')).toBe('openrouter');
    expect(providerFor('claude-sonnet-4-6')).toBe('anthropic');
    expect(providerFor('accounts/fireworks/models/qwen3p7-plus')).toBe('fireworks');
  });

  it('infers fireworks from an un-catalogued fireworks model id (the eval --models axis)', () => {
    const providerFor = providerForModel({});
    expect(providerFor('accounts/fireworks/models/kimi-k2p6')).toBe('fireworks');
  });

  it('infers anthropic from an un-catalogued claude- model id', () => {
    const providerFor = providerForModel({});
    expect(providerFor('claude-haiku-4-5')).toBe('anthropic');
  });

  it('infers openai from an un-catalogued gpt- model id, but not from an OpenRouter openai/ id', () => {
    const providerFor = providerForModel({});
    expect(providerFor('gpt-5-mini')).toBe('openai');
    expect(() => providerFor('openai/gpt-5-mini')).toThrow(/openai\/gpt-5-mini/);
  });

  it('throws rather than silently billing an unrecognisable model to fireworks', () => {
    // The bug this replaces: `?? 'fireworks'` attributed every unknown model —
    // including OpenRouter-routed ones — to Fireworks in the spend ledger.
    const providerFor = providerForModel({});
    expect(() => providerFor('moonshotai/kimi-k2')).toThrow(/moonshotai\/kimi-k2/);
  });

  it('names the setting to fix in the thrown message', () => {
    const providerFor = providerForModel({});
    expect(() => providerFor('some/unknown-model')).toThrow(/Settings\/Models/);
  });
});
