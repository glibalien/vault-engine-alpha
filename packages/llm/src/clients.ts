import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { PROVIDERS, type ModelProvider } from '@vault/settings-registry';

/** API keys by provider. A missing or blank key means the provider is unavailable. */
export type ProviderKeys = Partial<Record<ModelProvider, string>>;

/** Providers that speak the OpenAI Chat Completions wire format. */
export type OpenAiCompatProvider = {
  [P in ModelProvider]: (typeof PROVIDERS)[P]['api'] extends 'openai-compat' ? P : never
}[ModelProvider];

export interface ProviderClientOptions {
  /** Per-provider base URL overrides; the provider table's URL is the default. */
  baseURLs?: Partial<Record<ModelProvider, string>>;
  /** SDK constructors, injectable for tests. */
  createOpenAi?: (options: { apiKey: string; baseURL: string }) => OpenAI;
  createAnthropic?: (options: { apiKey: string; baseURL?: string }) => Anthropic;
}

/** Thrown when a call needs a provider whose key is not configured. */
export class MissingProviderKeyError extends Error {
  override readonly name = 'MissingProviderKeyError';
  readonly provider: ModelProvider;
  readonly envVar: string;

  constructor(provider: ModelProvider, model?: string) {
    const envVar = PROVIDERS[provider].apiKeyEnv;
    super(model === undefined
      ? `the ${provider} API key (${envVar}) is not set`
      : `model "${model}" needs the ${provider} API key (${envVar}) — not set`);
    this.provider = provider;
    this.envVar = envVar;
  }
}

/**
 * One SDK client per provider, built on first use from the configured keys.
 * Every LLM call in Engine and Curator gets its client here, so keys, base
 * URLs and the missing-key failure are decided in one place.
 */
export interface ProviderClients {
  /** True when the provider's key is configured. */
  has(provider: ModelProvider): boolean;
  /** Client for an OpenAI-compatible provider. Throws {@link MissingProviderKeyError}. */
  openAiCompat(provider: OpenAiCompatProvider, model?: string): OpenAI;
  /** Anthropic client. Throws {@link MissingProviderKeyError}. */
  anthropic(model?: string): Anthropic;
}

export function isOpenAiCompatProvider(provider: ModelProvider): provider is OpenAiCompatProvider {
  return PROVIDERS[provider].api === 'openai-compat';
}

export function createProviderClients(keys: ProviderKeys, options: ProviderClientOptions = {}): ProviderClients {
  const createOpenAi = options.createOpenAi ?? (o => new OpenAI(o));
  const createAnthropic = options.createAnthropic ?? (o => new Anthropic(o));
  const openAiClients = new Map<OpenAiCompatProvider, OpenAI>();
  let anthropicClient: Anthropic | undefined;

  const keyFor = (provider: ModelProvider): string | undefined => {
    const key = keys[provider]?.trim();
    return key ? key : undefined;
  };

  return {
    has: provider => keyFor(provider) !== undefined,

    openAiCompat(provider, model) {
      const existing = openAiClients.get(provider);
      if (existing) return existing;
      const apiKey = keyFor(provider);
      if (!apiKey) throw new MissingProviderKeyError(provider, model);
      const baseURL = options.baseURLs?.[provider] ?? PROVIDERS[provider].baseURL;
      const client = createOpenAi({ apiKey, baseURL });
      openAiClients.set(provider, client);
      return client;
    },

    anthropic(model) {
      if (anthropicClient) return anthropicClient;
      const apiKey = keyFor('anthropic');
      if (!apiKey) throw new MissingProviderKeyError('anthropic', model);
      // No baseURL unless overridden: the SDK's own default (and its
      // ANTHROPIC_BASE_URL env handling) stays in force.
      const baseURL = options.baseURLs?.anthropic;
      anthropicClient = createAnthropic(baseURL === undefined ? { apiKey } : { apiKey, baseURL });
      return anthropicClient;
    },
  };
}

/** Read each provider's key from its environment variable in the provider table. */
export function providerKeysFromEnv(env: Record<string, string | undefined>): ProviderKeys {
  const keys: ProviderKeys = {};
  for (const info of Object.values(PROVIDERS)) {
    const value = env[info.apiKeyEnv]?.trim();
    if (value) keys[info.id] = value;
  }
  return keys;
}
