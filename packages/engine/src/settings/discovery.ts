// packages/engine/src/settings/discovery.ts
import { pricingForExact } from '@vault/pricing';
import { PROVIDERS, type ModelEntryPricing, type ModelProvider } from '@vault/settings-registry';

/** A model surfaced by a provider's discovery API, normalized to a common shape. */
export interface DiscoveredModel {
  provider: ModelProvider;
  model: string; // full provider id (accounts/fireworks/models/x | vendor/slug | claude-… | gpt-…)
  displayName: string;
  description: string;
  vision: boolean;
  tools: boolean;
  contextLength: number | null;
  pricing: ModelEntryPricing | null; // Fireworks is enriched after tool filtering/limiting
  serverless: boolean; // fireworks flag; always true for the other providers
  deprecated: boolean;
}

const FIREWORKS_MODELS_URL = 'https://api.fireworks.ai/v1/accounts/fireworks/models';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const ANTHROPIC_PAGE_SIZE = 1000;
const FIREWORKS_PAGE_SIZE = 200;
const MAX_PAGES = 10; // safety cap against a misbehaving/looping upstream
const DESCRIPTION_MAX_CHARS = 300;
const PRICE_PER_TOKEN_TO_PER_MTOK = 1_000_000;
const PRICE_DECIMALS = 6;

function truncateDescription(description: string): string {
  return description.slice(0, DESCRIPTION_MAX_CHARS);
}

function roundPrice(n: number): number {
  const factor = 10 ** PRICE_DECIMALS;
  return Math.round(n * factor) / factor;
}

// ---- Fireworks ------------------------------------------------------------

interface FireworksModel {
  name: string;
  displayName?: string;
  description?: string;
  kind: string;
  state: string;
  public: boolean;
  supportsImageInput?: boolean;
  supportsTools?: boolean;
  supportsServerless?: boolean;
  contextLength?: number;
  deprecationDate?: unknown;
}

interface FireworksModelsResponse {
  models?: FireworksModel[];
  nextPageToken?: string;
  totalSize?: number;
}

function mapFireworksModel(m: FireworksModel): DiscoveredModel {
  return {
    provider: 'fireworks',
    model: m.name,
    displayName: m.displayName ?? m.name,
    description: truncateDescription(m.description ?? ''),
    vision: Boolean(m.supportsImageInput),
    tools: Boolean(m.supportsTools),
    contextLength: m.contextLength || null,
    pricing: null,
    serverless: Boolean(m.supportsServerless),
    deprecated: m.deprecationDate != null,
  };
}

/**
 * Fetches every page of the Fireworks control-plane model list and maps the
 * chat-capable subset (`kind === 'HF_BASE_MODEL'`, `state === 'READY'`,
 * `public`) to {@link DiscoveredModel}. Embedding/image-gen kinds and
 * non-serverless-vs-serverless distinctions are NOT filtered here — the
 * serverless escape-hatch filter lives in the MCP tool, not this module.
 * Paginates via `nextPageToken` up to a 10-page safety cap. Throws on any
 * non-2xx response.
 */
export async function discoverFireworksModels(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DiscoveredModel[]> {
  const results: DiscoveredModel[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(FIREWORKS_MODELS_URL);
    url.searchParams.set('pageSize', String(FIREWORKS_PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`fireworks models API HTTP ${res.status}`);
    const body = (await res.json()) as FireworksModelsResponse;

    for (const m of body.models ?? []) {
      if (m.kind !== 'HF_BASE_MODEL') continue;
      if (m.state !== 'READY') continue;
      if (!m.public) continue;
      results.push(mapFireworksModel(m));
    }

    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }

  return results;
}

// ---- OpenRouter -------------------------------------------------------------

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
  pricing?: OpenRouterPricing;
  expiration_date?: string | null;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

const VENDOR_PREFIX = /^[^:]+:\s*/;

function stripVendorPrefix(name: string): string {
  return name.replace(VENDOR_PREFIX, '');
}

/** ×1e6 (per-token USD -> per-Mtok USD), rounded to 6 decimals; NaN if unparseable. */
function perMtok(raw: string | undefined): number {
  return parseFloat(raw ?? '') * PRICE_PER_TOKEN_TO_PER_MTOK;
}

/** Whole pricing is null if prompt or completion doesn't parse; cache fields are optional/independent. */
function mapOpenRouterPricing(pricing: OpenRouterPricing | undefined): ModelEntryPricing | null {
  const input = perMtok(pricing?.prompt);
  const output = perMtok(pricing?.completion);
  if (Number.isNaN(input) || Number.isNaN(output)) return null;

  const result: ModelEntryPricing = { input: roundPrice(input), output: roundPrice(output) };
  const cacheRead = perMtok(pricing?.input_cache_read);
  if (!Number.isNaN(cacheRead)) result.cacheRead = roundPrice(cacheRead);
  const cacheWrite = perMtok(pricing?.input_cache_write);
  if (!Number.isNaN(cacheWrite)) result.cacheWrite = roundPrice(cacheWrite);
  return result;
}

function mapOpenRouterModel(m: OpenRouterModel): DiscoveredModel {
  const inputModalities = m.architecture?.input_modalities ?? [];
  return {
    provider: 'openrouter',
    model: m.id,
    displayName: stripVendorPrefix(m.name),
    description: truncateDescription(m.description ?? ''),
    vision: inputModalities.includes('image'),
    tools: (m.supported_parameters ?? []).includes('tools'),
    contextLength: m.context_length ?? null,
    pricing: mapOpenRouterPricing(m.pricing),
    serverless: true,
    deprecated: m.expiration_date != null,
  };
}

/**
 * Fetches the OpenRouter model list (no auth required) and maps every model
 * whose `architecture.output_modalities` includes `'text'` to
 * {@link DiscoveredModel}. Throws on any non-2xx response.
 */
export async function discoverOpenRouterModels(fetchImpl: typeof fetch = globalThis.fetch): Promise<DiscoveredModel[]> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`openrouter models API HTTP ${res.status}`);
  const body = (await res.json()) as OpenRouterModelsResponse;

  const results: DiscoveredModel[] = [];
  for (const m of body.data ?? []) {
    const outputModalities = m.architecture?.output_modalities ?? [];
    if (!outputModalities.includes('text')) continue;
    results.push(mapOpenRouterModel(m));
  }
  return results;
}

/** The static list price for an exact model id, for providers whose model list
 *  carries no prices (Anthropic, OpenAI). */
function staticPricing(model: string): ModelEntryPricing | null {
  const row = pricingForExact(model);
  return row ? { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite } : null;
}

// ---- Anthropic ------------------------------------------------------------

interface AnthropicModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  capabilities?: { image_input?: { supported?: boolean } };
  deprecated_at?: string | null;
  lifecycle?: string;
}

interface AnthropicModelsResponse {
  data?: AnthropicModel[];
  has_more?: boolean;
  last_id?: string | null;
}

function mapAnthropicModel(m: AnthropicModel): DiscoveredModel {
  return {
    provider: 'anthropic',
    model: m.id,
    displayName: m.display_name ?? m.id,
    description: '',
    // Every current Claude model takes images; the list reports it per model.
    vision: m.capabilities?.image_input?.supported ?? true,
    tools: true,
    contextLength: m.max_input_tokens ?? null,
    pricing: staticPricing(m.id),
    serverless: true,
    deprecated: m.deprecated_at != null || m.lifecycle === 'deprecated',
  };
}

/** Fetches Anthropic's model list (paged by `after_id`). Throws on any non-2xx response. */
export async function discoverAnthropicModels(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DiscoveredModel[]> {
  const results: DiscoveredModel[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(ANTHROPIC_MODELS_URL);
    url.searchParams.set('limit', String(ANTHROPIC_PAGE_SIZE));
    if (afterId) url.searchParams.set('after_id', afterId);
    const res = await fetchImpl(url.toString(), { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(`anthropic models API HTTP ${res.status}`);
    const body = (await res.json()) as AnthropicModelsResponse;
    for (const m of body.data ?? []) results.push(mapAnthropicModel(m));
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }
  return results;
}

// ---- OpenAI ---------------------------------------------------------------

interface OpenAiModel {
  id: string;
  shutdown_date?: string | null;
}

interface OpenAiModelsResponse {
  data?: OpenAiModel[];
}

/** Text chat models. The list also holds audio, image, embedding and moderation
 *  models, and Responses-only ones (pro, codex, deep research) that Curator and
 *  Engine, which call Chat Completions, cannot use. */
const OPENAI_CHAT_MODEL = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|deep-research|computer-use|-pro(?:-|$))/;
/** OpenAI's list reports no capabilities, so image input is inferred for the
 *  families that take it; add-model's `vision` argument corrects a wrong guess. */
const OPENAI_IMAGE_INPUT = /^(gpt-4o|gpt-4\.1|gpt-[5-9]|chatgpt-4o|o1(?!-mini)|o3(?!-mini)|o4)/;

function mapOpenAiModel(m: OpenAiModel): DiscoveredModel {
  return {
    provider: 'openai',
    model: m.id,
    displayName: m.id,
    description: '',
    vision: OPENAI_IMAGE_INPUT.test(m.id),
    tools: true,
    contextLength: null,
    pricing: staticPricing(m.id),
    serverless: true,
    deprecated: m.shutdown_date != null,
  };
}

/** Fetches OpenAI's model list and keeps the text chat models. Throws on any non-2xx response. */
export async function discoverOpenAiModels(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DiscoveredModel[]> {
  const res = await fetchImpl(OPENAI_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`openai models API HTTP ${res.status}`);
  const body = (await res.json()) as OpenAiModelsResponse;
  return (body.data ?? [])
    .filter(m => OPENAI_CHAT_MODEL.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
    .map(mapOpenAiModel);
}

// ---- Any provider ---------------------------------------------------------

/** Discovery needs the provider's key on the Engine and it is not set. */
export class DiscoveryKeyMissingError extends Error {
  override readonly name = 'DiscoveryKeyMissingError';
  constructor(readonly envVar: string) {
    super(`${envVar} not configured on the engine`);
  }
}

/**
 * The live model list for one catalog provider, using the key the Engine holds
 * for it (OpenRouter's list needs none). Throws {@link DiscoveryKeyMissingError}
 * when the key is missing, and an Error on an upstream failure.
 */
export async function discoverModels(
  provider: ModelProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DiscoveredModel[]> {
  if (provider === 'openrouter') return discoverOpenRouterModels(fetchImpl);
  const envVar = PROVIDERS[provider].apiKeyEnv;
  const apiKey = env[envVar]?.trim();
  if (!apiKey) throw new DiscoveryKeyMissingError(envVar);
  switch (provider) {
    case 'fireworks': return discoverFireworksModels(apiKey, fetchImpl);
    case 'anthropic': return discoverAnthropicModels(apiKey, fetchImpl);
    case 'openai': return discoverOpenAiModels(apiKey, fetchImpl);
  }
}
