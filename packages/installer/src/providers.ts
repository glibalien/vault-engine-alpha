import type { AnswerId } from './answers.js';
import type { Host } from './host.js';
import { withSpinner, type Prompter } from './prompter.js';
import { Secret } from './secret.js';

export type ProviderId = 'anthropic' | 'fireworks' | 'openrouter' | 'openai' | 'gemini' | 'deepgram' | 'exa';

/** Providers whose keys Curator and chat use for model calls. */
export const MODEL_PROVIDERS = ['anthropic', 'fireworks', 'openrouter', 'openai'] as const satisfies readonly ProviderId[];

/** Keys that make Engine extract attachments automatically, so they wait for consent. */
export const EXTRACTION_PROVIDERS = ['gemini', 'deepgram'] as const satisfies readonly ProviderId[];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** The variable the installer looks for in its own environment. */
  envVar: string;
  /** What the key adds, short enough for one line of the tick-list. */
  unlocks: string;
  /** The provider's own page for creating an API key. */
  keyPage: string;
  /** Where the key goes: Engine's and Curator's env files, by variable name. */
  engineEnv: string | null;
  curatorEnv: string | null;
  /** A free metadata request that needs a valid key; null when the provider has none. */
  check: {
    url: string;
    headers(key: string): Record<string, string>;
    /** Statuses that mean the key itself was refused. */
    rejected: number[];
  } | null;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    unlocks: 'Claude models; also reads images and scanned PDFs',
    keyPage: 'https://platform.claude.com/settings/keys',
    engineEnv: 'ANTHROPIC_API_KEY',
    curatorEnv: 'ANTHROPIC_API_KEY',
    check: {
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
      rejected: [401, 403],
    },
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    envVar: 'FIREWORKS_API_KEY',
    unlocks: 'Low-cost open models; also reads images',
    keyPage: 'https://app.fireworks.ai/settings/users/api-keys',
    engineEnv: 'FIREWORKS_API_KEY',
    curatorEnv: 'OPENAI_COMPAT_API_KEY',
    // The same listing Engine's discover-models reads.
    check: {
      url: 'https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=1',
      headers: bearer,
      rejected: [401, 403],
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    unlocks: 'Many companies\' models, one key; also reads images',
    keyPage: 'https://openrouter.ai/keys',
    engineEnv: 'OPENROUTER_API_KEY',
    curatorEnv: 'OPENROUTER_API_KEY',
    check: { url: 'https://openrouter.ai/api/v1/key', headers: bearer, rejected: [401, 403] },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    unlocks: 'GPT models; also reads images and scanned PDFs',
    keyPage: 'https://platform.openai.com/api-keys',
    engineEnv: 'OPENAI_API_KEY',
    curatorEnv: 'OPENAI_API_KEY',
    // The same listing Engine's discover-models reads.
    check: { url: 'https://api.openai.com/v1/models', headers: bearer, rejected: [401, 403] },
  },
  {
    id: 'gemini',
    label: 'Gemini',
    envVar: 'GEMINI_API_KEY',
    unlocks: 'Extra: reads the text in images and scanned PDFs',
    keyPage: 'https://aistudio.google.com/apikey',
    engineEnv: 'GEMINI_API_KEY',
    curatorEnv: null,
    // Google answers an unknown key with 400 API_KEY_INVALID.
    check: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      headers: key => ({ 'x-goog-api-key': key }),
      rejected: [400, 401, 403],
    },
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    envVar: 'DEEPGRAM_API_KEY',
    unlocks: 'Extra: turns audio recordings into text',
    keyPage: 'https://console.deepgram.com/signup?jump=keys',
    engineEnv: 'DEEPGRAM_API_KEY',
    curatorEnv: null,
    check: {
      url: 'https://api.deepgram.com/v1/projects',
      headers: key => ({ Authorization: `Token ${key}` }),
      rejected: [401, 403],
    },
  },
  {
    id: 'exa',
    label: 'Exa',
    envVar: 'EXA_API_KEY',
    unlocks: 'Extra: lets your AI assistants search the web',
    keyPage: 'https://dashboard.exa.ai/api-keys',
    engineEnv: 'EXA_API_KEY',
    curatorEnv: null,
    // Exa's only key-bearing endpoints are paid searches.
    check: null,
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find(provider => provider.id === id) as ProviderInfo;
}

export type KeyCheck = 'valid' | 'unreachable' | 'unchecked';

export interface ProviderKey {
  provider: ProviderId;
  /** `env:NAME` when the key came from the environment, else `entered`. */
  source: string;
  secret: Secret;
  check: KeyCheck;
  detail: string;
}

const CHECK_TIMEOUT_MS = 10_000;

const isModelProvider = (id: ProviderId): boolean => (MODEL_PROVIDERS as readonly string[]).includes(id);

/** What goes missing without a model provider's key; broken into lines the terminal won't wrap. */
export const NO_MODEL_KEY_WARNING = [
  'Without a key from Anthropic, Fireworks, OpenRouter, or OpenAI, Curator',
  'can\'t keep wikis up to date and chat has no AI model to answer with.',
  'Your notes are still organized and searchable, and you can add a key later.',
].join('\n');

/** Stage 4a: which provider keys the services get, each checked with a free request. */
export async function runProvidersStage(input: {
  host: Host;
  prompter: Prompter;
  checkKeys: boolean;
}): Promise<ProviderKey[]> {
  const { host, prompter } = input;
  prompter.note(
    [
      'An API key is like a password: it lets Vault use your account with an',
      'AI company. One key from Anthropic, Fireworks, OpenRouter, or OpenAI is',
      'enough to give Curator (it keeps wikis up to date) and chat an AI model.',
      'Gemini, Deepgram, and Exa add extra features. Every key is optional, and',
      'you can add one later.',
      '',
      'Cost: checking a key is free. Nothing that costs money runs until you set',
      'Curator\'s daily limit (the next step) and answer the attachment question',
      'later.',
      '',
      'Where to create a key:',
      ...PROVIDERS.map(provider => `  ${provider.label.padEnd(11)} ${provider.keyPage}`),
      '',
      'Keys are saved only in private files on this computer.',
    ].join('\n'),
    'AI services',
  );
  // A headless run takes its keys from the answers file, so it asks for every key and
  // the file's `providers` entries decide which are added.
  const chosen = prompter.interactive ? await pickProviders(host, prompter) : PROVIDERS;
  const keys: ProviderKey[] = [];
  for (const provider of chosen) {
    const key = await askKey(host, prompter, provider, input.checkKeys);
    if (key) keys.push(key);
  }
  // The tick-list has already warned when no model provider was ticked.
  if (chosen.some(provider => isModelProvider(provider.id)) && !keys.some(key => isModelProvider(key.provider))) {
    prompter.warn(NO_MODEL_KEY_WARNING);
  }
  return keys;
}

/**
 * The interactive tick-list: which services the user has a key for. Keys already in the
 * environment start ticked. Ticking no model provider explains what won't work and
 * offers the list again.
 */
export async function pickProviders(host: Host, prompter: Prompter): Promise<ProviderInfo[]> {
  let ticked = PROVIDERS.filter(provider => envHasKey(host, provider)).map(provider => provider.id as string);
  let found = ticked.length > 0 ? ' Keys already on this computer are ticked.' : '';
  for (;;) {
    const answer = await prompter.multiselect({
      id: 'providers',
      message: `Which of these do you have a key for? Tick each one with Space, then press Enter.${found}`,
      options: PROVIDERS.map(provider => ({ value: provider.id, label: `${provider.label.padEnd(11)} ${provider.unlocks}` })),
      initialValues: ticked,
    });
    const chosen = PROVIDERS.filter(provider => answer.includes(provider.id));
    if (chosen.some(provider => isModelProvider(provider.id))) return chosen;
    prompter.warn(NO_MODEL_KEY_WARNING);
    if (!await prompter.confirm({ message: 'Go back to the list and tick one?', initialValue: false })) return chosen;
    // The list comes back as the user left it.
    ticked = answer;
    found = '';
  }
}

function envHasKey(host: Host, provider: ProviderInfo): boolean {
  return Boolean(host.env(provider.envVar)?.trim());
}

/** One provider's key, asked again while it is empty or refused; null when skipped. */
export async function askKey(
  host: Host,
  prompter: Prompter,
  provider: ProviderInfo,
  checkKeys: boolean,
): Promise<ProviderKey | null> {
  const id = `providers.${provider.id}` as AnswerId;
  for (;;) {
    const answer = await prompter.secret({
      id,
      message: `${provider.label} API key`,
      envVar: provider.envVar,
      envPresent: envHasKey(host, provider),
    });
    if (answer === null) return null;
    const value = answer.source === 'env' ? host.env(answer.name)?.trim() ?? '' : answer.value.trim();
    if (value === '') {
      prompter.rejectAnswer(id, `${answer.source === 'env' ? answer.name : 'The key'} is empty or not set.`);
      continue;
    }
    const result = checkKeys
      ? await withSpinner(prompter, `Checking the ${provider.label} key…`, () => checkKey(host, provider, value), done =>
        done.status === 'valid' ? `${provider.label} accepted the key.` : `${provider.label} key: ${done.detail}.`)
      : { status: 'unchecked' as const, detail: 'not checked (--skip-network-check)' };
    if (result.status === 'rejected') {
      prompter.rejectAnswer(id, `${provider.label} refused this key (${result.detail}).`);
      continue;
    }
    if (result.status === 'unreachable') {
      prompter.warn(`The ${provider.label} key could not be checked (${result.detail}); verification checks it again.`);
    }
    return {
      provider: provider.id,
      source: answer.source === 'env' ? `env:${answer.name}` : 'entered',
      secret: new Secret(value),
      check: result.status,
      detail: result.detail,
    };
  }
}

/** One free request with the key; only the status code is read. */
export async function checkKey(
  host: Host,
  provider: ProviderInfo,
  key: string,
): Promise<{ status: KeyCheck | 'rejected'; detail: string }> {
  if (!provider.check) return { status: 'unchecked', detail: `${provider.label} has no free endpoint to check a key` };
  const status = await host.httpStatus(provider.check.url, provider.check.headers(key), CHECK_TIMEOUT_MS);
  if (status === null) return { status: 'unreachable', detail: 'no response' };
  if (status >= 200 && status < 300) return { status: 'valid', detail: 'accepted' };
  if (provider.check.rejected.includes(status)) return { status: 'rejected', detail: `HTTP ${status}` };
  return { status: 'unreachable', detail: `HTTP ${status}` };
}

export function hasKey(keys: readonly ProviderKey[], provider: ProviderId): boolean {
  return keys.some(key => key.provider === provider);
}
