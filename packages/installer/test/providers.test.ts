import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AnswersError, AnswersSchema, type Answers } from '../src/answers.js';
import type { Host } from '../src/host.js';
import { createScriptedPrompter, type MultiselectQuestion } from '../src/prompter.js';
import { NO_MODEL_KEY_WARNING, PROVIDERS, runProvidersStage } from '../src/providers.js';
import { Secret } from '../src/secret.js';
import { fakeHost, replayPrompter } from './helpers.js';

function scripted(providers: Answers['providers']) {
  const lines: string[] = [];
  const prompter = createScriptedPrompter({ version: 1, vault: { path: '/v' }, providers }, line => lines.push(line));
  return { prompter, lines };
}

function hostWithEnv(env: Record<string, string>, httpStatus: Host['httpStatus'] = async () => 200): Host {
  return fakeHost({ env: name => env[name], httpStatus });
}

describe('runProvidersStage', () => {
  it('reads env:NAME keys headlessly and checks each with a free request', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const host = hostWithEnv(
      { MY_ANTHROPIC: 'sk-ant-secret', FW: ' fw-secret ', EXA_KEY: 'exa-secret' },
      async (url, headers) => { calls.push({ url, headers }); return 200; },
    );
    const { prompter } = scripted({ anthropic: 'env:MY_ANTHROPIC', fireworks: 'env:FW', exa: 'env:EXA_KEY' });

    const keys = await runProvidersStage({ host, prompter, checkKeys: true });

    expect(keys.map(key => [key.provider, key.source, key.check])).toEqual([
      ['anthropic', 'env:MY_ANTHROPIC', 'valid'],
      ['fireworks', 'env:FW', 'valid'],
      ['exa', 'env:EXA_KEY', 'unchecked'],
    ]);
    expect(keys.map(key => key.secret.reveal())).toEqual(['sk-ant-secret', 'fw-secret', 'exa-secret']);
    // Exa has no free endpoint, so it is never called.
    expect(calls).toEqual([
      {
        url: 'https://api.anthropic.com/v1/models?limit=1',
        headers: { 'x-api-key': 'sk-ant-secret', 'anthropic-version': '2023-06-01' },
      },
      {
        url: 'https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=1',
        headers: { Authorization: 'Bearer fw-secret' },
      },
    ]);
  });

  it('stops a headless run when a provider refuses the key or the variable is unset', async () => {
    const refused = scripted({ gemini: 'env:GEMINI_API_KEY' });
    const unset = scripted({ deepgram: 'env:NOT_SET' });
    const host = hostWithEnv({ GEMINI_API_KEY: 'bad' }, async () => 400);

    await expect(runProvidersStage({ host, prompter: refused.prompter, checkKeys: true }))
      .rejects.toThrow(/Gemini refused this key \(HTTP 400\)/);
    await expect(runProvidersStage({ host, prompter: unset.prompter, checkKeys: true }))
      .rejects.toThrow(/NOT_SET is empty or not set/);
  });

  it('keeps a key that could not be checked, with a warning', async () => {
    const statuses: Record<string, number | null> = { 'openrouter.ai': 503, 'api.deepgram.com': null };
    const host = hostWithEnv(
      { OPENROUTER_API_KEY: 'or', DEEPGRAM_API_KEY: 'dg' },
      async url => { const host = new URL(url).host; return host in statuses ? statuses[host] as number | null : 200; },
    );
    const { prompter, lines } = scripted({ openrouter: 'env:OPENROUTER_API_KEY', deepgram: 'env:DEEPGRAM_API_KEY' });

    const keys = await runProvidersStage({ host, prompter, checkKeys: true });

    expect(keys.map(key => [key.provider, key.check, key.detail])).toEqual([
      ['openrouter', 'unreachable', 'HTTP 503'],
      ['deepgram', 'unreachable', 'no response'],
    ]);
    expect(lines).toContainEqual(expect.stringContaining('Warning: The OpenRouter key could not be checked (HTTP 503)'));
  });

  it('makes no request when checks are skipped', async () => {
    let requests = 0;
    const host = hostWithEnv({ ANTHROPIC_API_KEY: 'a' }, async () => { requests++; return 200; });
    const { prompter } = scripted({ anthropic: 'env:ANTHROPIC_API_KEY' });

    const keys = await runProvidersStage({ host, prompter, checkKeys: false });

    expect(requests).toBe(0);
    expect(keys[0]).toMatchObject({ provider: 'anthropic', check: 'unchecked' });
  });

  it('asks again after a refused key, offers the environment, and lets a ticked key be skipped', async () => {
    const host = hostWithEnv({ FIREWORKS_API_KEY: 'from-env' }, async (_url, headers) =>
      headers['x-api-key'] === 'good' || headers.Authorization === 'Bearer from-env' ? 200 : 401);
    const { prompter, rejections } = replayPrompter({
      providers: [['anthropic', 'fireworks', 'openrouter']],
      'providers.anthropic': [{ source: 'entered', value: 'bad' }, { source: 'entered', value: 'good' }],
      'providers.fireworks': [{ source: 'env', name: 'FIREWORKS_API_KEY' }],
    });
    const asked: Array<{ id: string; envPresent: boolean }> = [];
    const secret = prompter.secret.bind(prompter);
    prompter.secret = async question => { asked.push({ id: question.id, envPresent: question.envPresent }); return secret(question); };

    const keys = await runProvidersStage({ host, prompter, checkKeys: true });

    expect(keys.map(key => [key.provider, key.source, key.secret.reveal()])).toEqual([
      ['anthropic', 'entered', 'good'],
      ['fireworks', 'env:FIREWORKS_API_KEY', 'from-env'],
    ]);
    expect(rejections).toEqual(['Anthropic refused this key (HTTP 401).']);
    expect(asked.find(question => question.id === 'providers.fireworks')?.envPresent).toBe(true);
    // OpenRouter was ticked, then skipped at its prompt.
    expect(asked.find(question => question.id === 'providers.openrouter')?.envPresent).toBe(false);
  });

  it('shows a tick-list first, with keys found on this computer ticked, and asks only for the ticked keys', async () => {
    const host = hostWithEnv({ OPENROUTER_API_KEY: 'or-env', DEEPGRAM_API_KEY: ' dg-env ', EXA_API_KEY: '  ' });
    const { prompter, asked } = replayPrompter({
      'providers.openrouter': [{ source: 'env', name: 'OPENROUTER_API_KEY' }],
      'providers.deepgram': [{ source: 'env', name: 'DEEPGRAM_API_KEY' }],
    });
    const lists: MultiselectQuestion[] = [];
    const notes: string[] = [];
    const multiselect = prompter.multiselect.bind(prompter);
    prompter.multiselect = async question => { lists.push(question); return multiselect(question); };
    prompter.note = message => { notes.push(message); };

    const keys = await runProvidersStage({ host, prompter, checkKeys: true });

    expect(lists).toHaveLength(1);
    const [list] = lists as [MultiselectQuestion];
    expect(list.message).toContain('Which of these do you have a key for?');
    expect(list.message).toContain('Keys already on this computer are ticked.');
    // A blank variable does not count as a key.
    expect(list.initialValues).toEqual(['openrouter', 'deepgram']);
    // Every line says what the service adds.
    expect(list.options.map(option => option.value)).toEqual(PROVIDERS.map(provider => provider.id));
    for (const provider of PROVIDERS) {
      expect(list.options.find(option => option.value === provider.id)?.label).toContain(provider.unlocks);
    }
    expect(asked).toEqual(['providers', 'providers.openrouter', 'providers.deepgram']);
    expect(keys.map(key => [key.provider, key.source, key.secret.reveal()])).toEqual([
      ['openrouter', 'env:OPENROUTER_API_KEY', 'or-env'],
      ['deepgram', 'env:DEEPGRAM_API_KEY', 'dg-env'],
    ]);
    // The note says where to create each key, and what costs money.
    const [note] = notes as [string];
    for (const provider of PROVIDERS) expect(note).toContain(provider.keyPage);
    expect(note).toContain('Cost: checking a key is free.');
  });

  it('says what will not work when no model service is ticked, and goes back to the list on request', async () => {
    const host = hostWithEnv({ GEMINI_API_KEY: 'gm', ANTHROPIC_API_KEY: 'an' });
    const { prompter, asked } = replayPrompter({
      providers: [['gemini'], ['gemini', 'anthropic']],
      'providers.gemini': [{ source: 'env', name: 'GEMINI_API_KEY' }],
      'providers.anthropic': [{ source: 'env', name: 'ANTHROPIC_API_KEY' }],
    }, [true]);
    const lists: MultiselectQuestion[] = [];
    const warnings: string[] = [];
    const multiselect = prompter.multiselect.bind(prompter);
    prompter.multiselect = async question => { lists.push(question); return multiselect(question); };
    prompter.warn = message => { warnings.push(message); };

    const keys = await runProvidersStage({ host, prompter, checkKeys: true });

    // The list comes back as the user left it.
    expect(lists.map(list => list.initialValues)).toEqual([['anthropic', 'gemini'], ['gemini']]);
    expect(lists.map(list => list.message.includes('Keys already on this computer are ticked.'))).toEqual([true, false]);
    expect(warnings).toEqual([NO_MODEL_KEY_WARNING]);
    expect(asked).toEqual(['providers', 'providers', 'providers.anthropic', 'providers.gemini']);
    expect(keys.map(key => key.provider)).toEqual(['anthropic', 'gemini']);
  });

  it('carries on without a model key when the user declines to go back, warning once', async () => {
    const { prompter, asked } = replayPrompter({
      providers: [['exa']],
      'providers.exa': [{ source: 'entered', value: 'exa-key' }],
    }, [false]);
    const warnings: string[] = [];
    prompter.warn = message => { warnings.push(message); };

    const keys = await runProvidersStage({ host: hostWithEnv({}), prompter, checkKeys: true });

    expect(asked).toEqual(['providers', 'providers.exa']);
    expect(keys.map(key => [key.provider, key.check])).toEqual([['exa', 'unchecked']]);
    expect(warnings).toEqual([NO_MODEL_KEY_WARNING]);
  });

  it('warns after the prompts when a ticked model key was skipped', async () => {
    const { prompter, asked } = replayPrompter({ providers: [['openai', 'deepgram']] });
    const warnings: string[] = [];
    prompter.warn = message => { warnings.push(message); };

    const keys = await runProvidersStage({ host: hostWithEnv({}), prompter, checkKeys: true });

    expect(asked).toEqual(['providers', 'providers.openai', 'providers.deepgram']);
    expect(keys).toEqual([]);
    expect(warnings).toEqual([NO_MODEL_KEY_WARNING]);
  });

  it('shows no tick-list headlessly: the answers file names the keys', async () => {
    const { prompter } = scripted({ deepgram: 'env:DEEPGRAM_API_KEY' });
    const lists: string[] = [];
    prompter.multiselect = async question => { lists.push(question.id); return []; };

    const keys = await runProvidersStage({ host: hostWithEnv({ DEEPGRAM_API_KEY: 'dg', ANTHROPIC_API_KEY: 'an' }), prompter, checkKeys: true });

    expect(lists).toEqual([]);
    // A key in the environment is not used unless the answers file names it.
    expect(keys.map(key => key.provider)).toEqual(['deepgram']);
  });

  it('reads an OpenAI key headlessly and checks it against the model list', async () => {
    const calls: string[] = [];
    const { prompter } = scripted({ openai: 'env:OPENAI_API_KEY' });
    const host = hostWithEnv({ OPENAI_API_KEY: 'sk-test' }, async url => { calls.push(url); return 200; });

    const keys = await runProvidersStage({ host, prompter, checkKeys: true });

    expect(keys.map(key => [key.provider, key.source, key.check])).toEqual([['openai', 'env:OPENAI_API_KEY', 'valid']]);
    expect(calls).toEqual(['https://api.openai.com/v1/models']);
  });

  it('warns when no key lets Curator or chat call a model', async () => {
    const { prompter, lines } = scripted({ exa: 'env:EXA_API_KEY' });

    await runProvidersStage({ host: hostWithEnv({ EXA_API_KEY: 'x' }), prompter, checkKeys: true });

    expect(lines).toContainEqual(`Warning: ${NO_MODEL_KEY_WARNING}`);
  });
});

describe('answers file keys', () => {
  it('accepts only env:NAME references', () => {
    const literal = AnswersSchema.safeParse({ version: 1, vault: { path: '/v' }, providers: { anthropic: 'sk-ant-123' } });
    const reference = AnswersSchema.safeParse({ version: 1, vault: { path: '/v' }, providers: { anthropic: 'env:KEY', exa: null } });

    expect(literal.success).toBe(false);
    expect(reference.success).toBe(true);
  });

  it('refuses a literal key that reaches the scripted prompter', async () => {
    const prompter = createScriptedPrompter(
      { version: 1, vault: { path: '/v' }, providers: { anthropic: 'sk-ant-123' } } as unknown as Answers,
      () => {},
    );

    await expect(prompter.secret({ id: 'providers.anthropic', message: 'Anthropic API key', envVar: 'X', envPresent: false }))
      .rejects.toThrow(AnswersError);
  });
});

describe('Secret', () => {
  it('never prints its value', () => {
    const secret = new Secret('sk-very-secret');

    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(String(secret)).toBe('[redacted]');
    expect(`${secret}`).toBe('[redacted]');
    expect(inspect({ secret })).not.toContain('sk-very-secret');
    expect(secret.reveal()).toBe('sk-very-secret');
  });
});
