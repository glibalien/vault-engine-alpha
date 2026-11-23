import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, hasProviderKey, mergeSettings, providerKeys } from '../src/settings.js';

describe('DEFAULT_SETTINGS', () => {
  it('defaults to a neutral local engine URL and an empty token', () => {
    expect(DEFAULT_SETTINGS.engineUrl).toBe('http://localhost:3334/mcp');
    expect(DEFAULT_SETTINGS.token).toBe('');
  });
  it('has no free-text model field (Phase 4: model comes from engine settings + the picker)', () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty('model');
  });
  it('defaults an empty Fireworks key and an empty Anthropic key', () => {
    expect(DEFAULT_SETTINGS.fireworksApiKey).toBe('');
    expect(DEFAULT_SETTINGS.anthropicApiKey).toBe('');
  });
  it('defaults the search mode to hybrid', () => {
    expect(DEFAULT_SETTINGS.searchMode).toBe('hybrid');
  });
  it('defaults the curator URL (with /mcp) and an empty curator token', () => {
    expect(DEFAULT_SETTINGS.curatorUrl).toBe('http://localhost:3335/mcp');
    expect(DEFAULT_SETTINGS.curatorToken).toBe('');
  });
});

describe('mergeSettings', () => {
  it('drops a stale retired `model` key from loaded data so it is not re-persisted', () => {
    const merged = mergeSettings({ model: 'accounts/fireworks/models/old', fireworksApiKey: 'fw-key' });
    expect(merged).not.toHaveProperty('model');
    expect(merged.fireworksApiKey).toBe('fw-key');
  });
  it('falls back to DEFAULT_SETTINGS for null/undefined loaded data', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
  it('preserves other stored keys untouched', () => {
    const merged = mergeSettings({ engineUrl: 'https://custom.example/mcp', anthropicApiKey: 'ant-key' });
    expect(merged.engineUrl).toBe('https://custom.example/mcp');
    expect(merged.anthropicApiKey).toBe('ant-key');
  });
});

describe('hasProviderKey', () => {
  // Phase 4: the picker lets a conversation route to either provider, so the chat gate
  // (ChatView.onOpen, main.ts#chatPing) no longer hard-requires Fireworks specifically —
  // either key alone is enough to use chat.
  it('true when only fireworksApiKey is set', () => {
    expect(hasProviderKey({ fireworksApiKey: 'fw-key', anthropicApiKey: '', openrouterApiKey: '', openaiApiKey: '' })).toBe(true);
  });
  it('true when only anthropicApiKey is set', () => {
    expect(hasProviderKey({ fireworksApiKey: '', anthropicApiKey: 'ant-key', openrouterApiKey: '', openaiApiKey: '' })).toBe(true);
  });
  it('true when only openrouterApiKey is set', () => {
    expect(hasProviderKey({ fireworksApiKey: '', anthropicApiKey: '', openrouterApiKey: 'or-key', openaiApiKey: '' })).toBe(true);
  });
  it('true when both are set', () => {
    expect(hasProviderKey({ fireworksApiKey: 'fw-key', anthropicApiKey: 'ant-key', openrouterApiKey: '', openaiApiKey: '' })).toBe(true);
  });
  it('true when only openaiApiKey is set', () => {
    expect(hasProviderKey({ fireworksApiKey: '', anthropicApiKey: '', openrouterApiKey: '', openaiApiKey: 'sk' })).toBe(true);
  });
  it('false when none are set', () => {
    expect(hasProviderKey({ fireworksApiKey: '', anthropicApiKey: '', openrouterApiKey: '', openaiApiKey: '' })).toBe(false);
  });
});

describe('providerKeys', () => {
  it('maps every key setting to its catalog provider', () => {
    expect(providerKeys({ fireworksApiKey: 'fw', anthropicApiKey: 'ak', openrouterApiKey: 'or', openaiApiKey: 'sk' }))
      .toEqual({ fireworks: 'fw', anthropic: 'ak', openrouter: 'or', openai: 'sk' });
  });
});
