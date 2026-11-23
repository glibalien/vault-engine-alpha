// The model providers a Settings/Models/ catalog entry can name, and the facts
// every surface needs about each one: which wire API it speaks, where it lives,
// and which environment variable carries its key. Pure data, so the Engine,
// Curator, chat, the plugin and the installer all read the same table.

export const MODEL_PROVIDERS = ['fireworks', 'anthropic', 'openrouter', 'openai'] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** `openai-compat`: OpenAI Chat Completions wire format. `anthropic`: Messages API. */
export type ProviderApi = 'openai-compat' | 'anthropic';

export interface ProviderInfo {
  readonly id: ModelProvider;
  readonly label: string;
  readonly api: ProviderApi;
  /** API base URL as the provider's SDK expects it. */
  readonly baseURL: string;
  /** Environment variable that holds the provider's API key, in every service. */
  readonly apiKeyEnv: string;
  /** Request field that caps output tokens. OpenAI's reasoning models reject
   *  `max_tokens` and take `max_completion_tokens`. */
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** The provider's chat API takes a PDF as message input. */
  readonly pdfInput: boolean;
}

export const PROVIDERS = {
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks',
    api: 'openai-compat',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    maxTokensField: 'max_tokens',
    pdfInput: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    api: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    maxTokensField: 'max_tokens',
    pdfInput: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-compat',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    maxTokensField: 'max_tokens',
    pdfInput: false,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-compat',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    maxTokensField: 'max_completion_tokens',
    pdfInput: true,
  },
} as const satisfies { readonly [P in ModelProvider]: ProviderInfo & { readonly id: P } };

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** Hostname of the provider's API, e.g. for an outbound allowlist. */
export function providerHost(provider: ModelProvider): string {
  return new URL(PROVIDERS[provider].baseURL).host;
}
