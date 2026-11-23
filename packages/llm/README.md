# @vault/llm

`@vault/llm` gives the Node services (Engine and Curator) one way to reach a model
provider. A `Settings/Models/` catalog entry names its provider; this package turns that
provider into a configured SDK client, normalizes the token usage it reports, and offers a
provider-neutral single-turn call.

What each provider is (its wire API, base URL and key variable) lives in the `PROVIDERS`
table in `@vault/settings-registry`, so chat, the Obsidian plugin and the installer read
the same facts without pulling in the SDKs.

## API

- `providerKeysFromEnv(env)` reads each provider's key from its table variable
  (`FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`). Blank
  values count as unset.
- `createProviderClients(keys, options?)` returns a `ProviderClients`: `has(provider)`,
  `openAiCompat(provider)` and `anthropic()`. Each SDK client is built on first use and
  reused. A missing key throws `MissingProviderKeyError`, naming the provider, its key
  variable and, when given, the model. `options.baseURLs` overrides a provider's base URL;
  `options.createOpenAi` and `options.createAnthropic` replace the SDK constructors in tests.
- `complete(clients, request)` sends one non-streaming call to any provider and returns
  `{ text, usage, truncated }`, plus `providerCostUsd`, `requestId` and `reportedModel`
  when the response carries them. The user message is a string or ordered parts (text,
  image, PDF). `json: true` asks for a JSON object where the provider has a JSON mode
  (OpenAI-compatible providers); otherwise the prompt must ask for JSON and the caller
  parses leniently. The output cap goes in the provider's `maxTokensField` (OpenAI takes
  `max_completion_tokens`). PDF input works where the provider table sets `pdfInput`
  (Anthropic and OpenAI).
- `openAiCompatUsage(usage, provider)` and `anthropicUsage(usage)` convert provider usage
  to `@vault/pricing`'s `TokenUsage`, in which `input` excludes cached tokens.
  Cache writes reported by OpenRouter and OpenAI are counted as `cacheWrite`.

Curator's structured synthesis calls keep their own adapters in `packages/curator/src/llm/`,
because provenance capture depends on their exact request payloads. They take their SDK
clients and usage normalization from this package.

## Boundaries

This package may depend only on `@vault/settings-registry`, `@vault/pricing` and the
provider SDKs (`.dependency-cruiser.cjs`, rule `llm-is-shared-server-library`). It is for
Node services. Chat streams through the AI SDK in `@vault/chat-core` and reads only the
provider table.

## Development

```bash
npm run build -w @vault/llm
npm test -w @vault/llm
```
