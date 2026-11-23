import { describe, expect, it, vi } from 'vitest';
import { descriptorsFor } from '@vault/settings-registry';
import { loadBootstrapConfig } from '../src/config.js';

const base = {
  ENGINE_URL: 'http://localhost:3334',
  ENGINE_TOKEN: 'tok',
};

describe('loadBootstrapConfig', () => {
  it('parses bootstrap fields only', () => {
    const cfg = loadBootstrapConfig({ ...base, ANTHROPIC_API_KEY: 'sk-test', CURATOR_NOTE_READS: '9' } as NodeJS.ProcessEnv);
    expect(cfg.engineUrl).toBe(base.ENGINE_URL);
    expect(cfg.curatorPort).toBe(3335);
    expect('noteReads' in cfg).toBe(false);
    expect('model' in cfg).toBe(false);
    expect('llm' in cfg).toBe(false);
  });

  it('never throws for missing provider keys — no provider is required at bootstrap', () => {
    const cfg = loadBootstrapConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.llmKeys.keys).toEqual({});
  });

  it('ignores CURATOR_PROVIDER entirely — no validation, never surfaces on the result', () => {
    expect(() => loadBootstrapConfig({ ...base, CURATOR_PROVIDER: 'bogus' } as NodeJS.ProcessEnv)).not.toThrow();
    const cfg = loadBootstrapConfig({ ...base, CURATOR_PROVIDER: 'bogus', ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    expect(cfg).not.toHaveProperty('llm');
    expect(cfg).not.toHaveProperty('provider');
  });

  it('still requires ENGINE_URL and ENGINE_TOKEN', () => {
    expect(() => loadBootstrapConfig({ ENGINE_TOKEN: 'tok' } as NodeJS.ProcessEnv)).toThrow(/ENGINE_URL/);
    expect(() => loadBootstrapConfig({ ENGINE_URL: 'http://x' } as NodeJS.ProcessEnv)).toThrow(/ENGINE_TOKEN/);
  });

  it('wires llmKeys via loadLlmKeys — base-url trailing slash stripped, no warn when a key is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadBootstrapConfig({
      ...base, OPENAI_COMPAT_API_KEY: 'fw', OPENAI_COMPAT_BASE_URL: 'https://example.com/v1///',
    } as NodeJS.ProcessEnv);
    expect(cfg.llmKeys).toEqual({
      keys: { fireworks: 'fw' },
      baseURLs: { fireworks: 'https://example.com/v1' },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns (never throws) when neither provider key is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => loadBootstrapConfig({ ...base } as NodeJS.ProcessEnv)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('trims experiment/variant, mapping blank or unset to null', () => {
    const cfg = loadBootstrapConfig({
      ...base, ANTHROPIC_API_KEY: 'sk-test', CURATOR_EXPERIMENT: '  exp-a  ', CURATOR_VARIANT: '   ',
    } as NodeJS.ProcessEnv);
    expect(cfg.experiment).toBe('exp-a');
    expect(cfg.variant).toBeNull();
    const unset = loadBootstrapConfig({ ...base, ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    expect(unset.experiment).toBeNull();
    expect(unset.variant).toBeNull();
  });
});

describe('conversation sweep settings', () => {
  const byKey = new Map(descriptorsFor('curator').map(d => [d.key, d]));

  it('registers all eight descriptors with the specified defaults', () => {
    expect(byKey.get('conversationSweepEnabled')?.default).toBe(false);
    expect(byKey.get('conversationSweepSettleHours')?.default).toBe(6);
    expect(byKey.get('conversationSweepMinUserChars')?.default).toBe(300);
    expect(byKey.get('conversationSweepCap')?.default).toBe(5);
    expect(byKey.get('conversationSweepPerConversationCap')?.default).toBe(2);
    expect(byKey.get('conversationSweepMaxTokens')?.default).toBe(4000);
    expect(byKey.get('conversationSweepModel')?.default).toBeNull();
    expect(byKey.get('curatorConversationSweepPrompt')?.default).toBe('');
  });

  it('minUserChars allows 0 (the n() helper would force min 1)', () => {
    expect(byKey.get('conversationSweepMinUserChars')?.type).toEqual({ kind: 'int', min: 0 });
  });

  it('the prompt override has no envSeed', () => {
    expect(byKey.get('curatorConversationSweepPrompt')?.envSeed).toBeUndefined();
  });

  it('conversationSweepSince is a bootstrap env override, null by default', () => {
    // loadBootstrapConfig requires ENGINE_URL/ENGINE_TOKEN (see `required()` in
    // src/config.ts) — adapted from the brief's bare `{}` to this file's `base`
    // fixture so the assertions below exercise conversationSweepSince, not the
    // unrelated required-var precondition.
    expect(loadBootstrapConfig({ ...base } as NodeJS.ProcessEnv).conversationSweepSince).toBeNull();
    expect(
      loadBootstrapConfig({ ...base, CURATOR_CONVERSATION_SWEEP_SINCE: '2026-08-01T00:00:00.000Z' } as unknown as NodeJS.ProcessEnv)
        .conversationSweepSince,
    ).toBe('2026-08-01T00:00:00.000Z');
    expect(() =>
      loadBootstrapConfig({ ...base, CURATOR_CONVERSATION_SWEEP_SINCE: 'not-a-date' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ISO timestamp/);
  });
});

describe('field guess settings', () => {
  const byKey = new Map(descriptorsFor('curator').map(d => [d.key, d]));

  it('registers the strict model reference, call cap, and token cap', () => {
    expect(byKey.get('fieldGuessModel')).toMatchObject({
      type: { kind: 'model-ref' },
      default: '[[GPT-OSS 120B]]',
      envSeed: { var: 'CURATOR_FIELD_GUESS_MODEL' },
    });
    expect(byKey.get('fieldGuessCap')).toMatchObject({
      type: { kind: 'int', min: 0 },
      default: 25,
      envSeed: { var: 'CURATOR_FIELD_GUESS_CAP' },
    });
    expect(byKey.get('fieldGuessMaxTokens')).toMatchObject({
      type: { kind: 'int', min: 1 },
      default: 2000,
      envSeed: { var: 'CURATOR_FIELD_GUESS_MAX_TOKENS' },
    });
  });
});
