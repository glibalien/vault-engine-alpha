// packages/engine/src/mcp/tools/discover-models.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import type { ModelCatalog } from '../../settings/models.js';
import { MODEL_PROVIDERS } from '@vault/settings-registry';
import { discoverModels, DiscoveryKeyMissingError } from '../../settings/discovery.js';
import { fireworksPricingResolver } from '../../settings/fireworks-pricing.js';
import type { DiscoveredModel } from '../../settings/discovery.js';

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/**
 * Registered only when `ctx.modelCatalog` exists (see registerAllTools). Fetches
 * a live provider catalog (any catalog provider, via the discovery module), filters/sorts it, and marks each result `inCatalog` against the
 * existing Settings/Models/ notes so a caller can tell what add-model (mints
 * the note) would actually be adding.
 */
export function registerDiscoverModels(
  server: McpServer,
  catalog: ModelCatalog,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  server.tool(
    'discover-models',
    "Discover models from a provider's live catalog (fireworks, openrouter, anthropic or openai) as candidates to add via add-model (which mints the Settings/Models/ note). Every provider but OpenRouter needs its API key on the Engine. Fireworks defaults to serverless-only models (usable immediately, no dedicated deployment); pass include_non_serverless: true to also see models Fireworks doesn't flag serverless — that flag is known-unreliable, so some genuinely-serverless models only surface with the escape hatch. Anthropic and OpenAI list no prices: results carry a price only when the suite's static table knows the exact id. OpenAI lists no capabilities, so its vision flag is inferred from the model family, and only text chat models are listed. Filter with query (case-insensitive substring over the display name and model id) and/or vision (vision-capable only). Each result carries inCatalog: true if a Settings/Models/ note already references its model id.",
    {
      provider: z.enum(MODEL_PROVIDERS),
      query: z.string().optional().describe('Case-insensitive substring match over displayName + model id'),
      vision: z.boolean().optional().describe('true = only vision-capable models'),
      include_non_serverless: z.boolean().optional().describe('Fireworks only: include models the API does not flag serverless (the flag is known-unreliable)'),
      limit: z.number().optional().describe('Max results (default 30, clamped to 1..100)'),
    },
    async ({ provider, query, vision, include_non_serverless, limit }) => {
      let models: DiscoveredModel[];
      try {
        models = await discoverModels(provider, env, fetchImpl);
        if (provider === 'fireworks' && !include_non_serverless) models = models.filter(m => m.serverless);
      } catch (err) {
        if (err instanceof DiscoveryKeyMissingError) return fail('INVALID_PARAMS', err.message);
        return fail('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err));
      }

      try {
        if (query !== undefined && query.trim() !== '') {
          const q = query.trim().toLowerCase();
          models = models.filter(m => m.displayName.toLowerCase().includes(q) || m.model.toLowerCase().includes(q));
        }
        if (vision) models = models.filter(m => m.vision);

        const catalogModelIds = new Set(catalog.entries().map(e => e.model));
        const withInCatalog = models.map(m => ({ ...m, inCatalog: catalogModelIds.has(m.model) }));

        withInCatalog.sort((a, b) => {
          if (a.inCatalog !== b.inCatalog) return a.inCatalog ? 1 : -1;
          return a.displayName.localeCompare(b.displayName);
        });

        const total_before_limit = withInCatalog.length;
        const clampedLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);

        const visible = withInCatalog.slice(0, clampedLimit);
        const enriched = provider === 'fireworks'
          ? await Promise.all(visible.map(async m => ({
            ...m, pricing: await fireworksPricingResolver(fetchImpl).resolve(m.model),
          })))
          : visible;
        return ok({ models: enriched, total_before_limit });
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
