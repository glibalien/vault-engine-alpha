import { describe, expect, it } from 'vitest';
import { isModelProvider, MODEL_PROVIDERS, PROVIDERS, providerHost, SEED_MODELS } from '../src/index.js';

describe('provider table', () => {
  it('describes every model provider under its own id', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...MODEL_PROVIDERS].sort());
    for (const provider of MODEL_PROVIDERS) expect(PROVIDERS[provider].id).toBe(provider);
  });

  it('gives each provider an https base URL and a distinct key variable', () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(new URL(PROVIDERS[provider].baseURL).protocol).toBe('https:');
    }
    const envs = MODEL_PROVIDERS.map(p => PROVIDERS[p].apiKeyEnv);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('keeps the hosts and key variables the services already use', () => {
    expect(MODEL_PROVIDERS.map(providerHost)).toEqual(['api.fireworks.ai', 'api.anthropic.com', 'openrouter.ai', 'api.openai.com']);
    expect(MODEL_PROVIDERS.map(p => PROVIDERS[p].apiKeyEnv))
      .toEqual(['FIREWORKS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']);
  });

  it('caps OpenAI output with max_completion_tokens and every other provider with max_tokens', () => {
    expect(Object.fromEntries(MODEL_PROVIDERS.map(p => [p, PROVIDERS[p].maxTokensField]))).toEqual({
      fireworks: 'max_tokens', anthropic: 'max_tokens', openrouter: 'max_tokens', openai: 'max_completion_tokens',
    });
  });

  it('marks Anthropic and OpenAI as taking PDF input', () => {
    expect(MODEL_PROVIDERS.filter(p => PROVIDERS[p].pdfInput)).toEqual(['anthropic', 'openai']);
  });

  it('recognizes only table providers', () => {
    expect(isModelProvider('openrouter')).toBe(true);
    expect(isModelProvider('google')).toBe(false);
    expect(isModelProvider(undefined)).toBe(false);
  });

  it('covers every seed model provider', () => {
    for (const seed of SEED_MODELS) expect(isModelProvider(seed.provider)).toBe(true);
  });
});
