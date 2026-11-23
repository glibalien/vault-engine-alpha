// packages/engine/src/mcp/tools/add-model.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MODEL_PROVIDERS, type ModelCatalogEntry } from '@vault/settings-registry';
import { ok, fail } from './errors.js';
import type { ModelCatalog } from '../../settings/models.js';
import type { NoteWriterDeps } from '../../settings/note.js';
import { writeModelNoteIfAbsent } from '../../settings/note.js';
import { discoverModels, DiscoveryKeyMissingError } from '../../settings/discovery.js';
import { fireworksPricingResolver } from '../../settings/fireworks-pricing.js';
import type { DiscoveredModel } from '../../settings/discovery.js';

export interface AddModelDeps {
  catalog: ModelCatalog;
  noteDeps: NoteWriterDeps;
  env: Record<string, string | undefined>;
  onCatalogChange?: () => void;
  fetchImpl?: typeof fetch;
}

// Characters that are unsafe (or Obsidian-wikilink-hostile) in a note filename.
const FILENAME_HOSTILE = /[\\/:#^|[\]]/g;

/** Default title from a display name: filename-hostile chars → '-', whitespace collapsed. */
function sanitizeTitle(name: string): string {
  return name.replace(FILENAME_HOSTILE, '-').replace(/\s+/g, ' ').trim();
}

/** Map a DiscoveredModel to a ModelCatalogEntry — capability booleans always,
 *  contextLength/pricing only when the provider surfaced them. */
function toCatalogEntry(discovered: DiscoveredModel, title: string, enabled: boolean): ModelCatalogEntry {
  return {
    title,
    provider: discovered.provider,
    model: discovered.model,
    enabled,
    vision: discovered.vision,
    tools: discovered.tools,
    ...(discovered.contextLength !== null ? { contextLength: discovered.contextLength } : {}),
    ...(discovered.pricing !== null ? { pricing: discovered.pricing } : {}),
  };
}

/**
 * Registered only when both `modelCatalog` and `settingsNoteDeps` exist (see
 * registerAllTools). Re-runs Task 7's provider discovery, finds the exact model
 * id, mints a `Settings/Models/<Title>.md` note (via `writeModelNoteIfAbsent`,
 * carrying capabilities + pricing from discovery), then explicitly invalidates +
 * bumps the catalog and fires `onCatalogChange` so the new model is immediately
 * resolvable and any catalog-dependent subsystem (e.g. vision) re-arms. Mirrors
 * discover-models' env/key handling: every provider but OpenRouter needs its key
 * on the Engine (INVALID_PARAMS if missing); a discovery HTTP failure maps to UPSTREAM_ERROR.
 */
export function registerAddModel(server: McpServer, deps: AddModelDeps): void {
  const { catalog, noteDeps, env, onCatalogChange } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  server.tool(
    'add-model',
    "Add a model to the catalog by minting a Settings/Models/<Title>.md note. Give the exact provider model id (from discover-models); capabilities are pulled from the provider's live catalog. Fireworks pricing is revalidated against its public model page, with exact static fallback; Anthropic and OpenAI list no prices, so their price comes from the static table or the pricing argument. Pass pricing (USD per million tokens) to set or override a price, and vision to correct the image-input flag. Unavailable prices do not block addition. Fails if the id is unknown to the provider, or if that model id / title is already in the catalog. Optional title (defaults to the sanitized display name) and enabled (default true — disabled models are catalogued but do not resolve).",
    {
      provider: z.enum(MODEL_PROVIDERS),
      model: z.string().describe('The full provider model id, e.g. accounts/fireworks/models/x, vendor/slug, claude-… or gpt-…'),
      title: z.string().optional().describe('Catalog title + note filename (defaults to the sanitized display name)'),
      enabled: z.boolean().optional().describe('Whether the model resolves (default true)'),
      vision: z.boolean().optional().describe('Override the discovered image-input flag (OpenAI lists no capabilities, so its flag is inferred)'),
      pricing: z.object({
        input: z.number().finite().nonnegative(),
        output: z.number().finite().nonnegative(),
        cache_read: z.number().finite().nonnegative().optional(),
        cache_write: z.number().finite().nonnegative().optional(),
      }).strict().optional().describe('USD per million tokens. Overrides the discovered price; needed for models with no known list price, since a capped Curator budget refuses unpriced models'),
    },
    async ({ provider, model, title, enabled, vision, pricing }) => {
      // ── Re-run discovery for the provider (mirror discover-models) ──────────
      let models: DiscoveredModel[];
      try {
        models = await discoverModels(provider, env, fetchImpl);
      } catch (err) {
        if (err instanceof DiscoveryKeyMissingError) return fail('INVALID_PARAMS', err.message);
        return fail('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err));
      }

      try {
        const discovered = models.find(m => m.model === model);
        if (!discovered) {
          return fail('NOT_FOUND', `model not found in ${provider} catalog — check the id from discover-models`);
        }

        const resolvedTitle = sanitizeTitle(title ?? discovered.displayName);
        if (resolvedTitle === '') return fail('INVALID_PARAMS', 'resolved title is empty after sanitization — pass an explicit title');

        // Revalidate only the selected identity, bypassing completed discovery cache.
        // Keep this await before collision checks so no async pricing gap separates
        // those checks from the synchronous mutation pipeline.
        if (provider === 'fireworks') {
          discovered.pricing = await fireworksPricingResolver(fetchImpl).resolve(model, true);
        }
        if (vision !== undefined) discovered.vision = vision;
        if (pricing !== undefined) {
          discovered.pricing = {
            input: pricing.input,
            output: pricing.output,
            ...(pricing.cache_read !== undefined ? { cacheRead: pricing.cache_read } : {}),
            ...(pricing.cache_write !== undefined ? { cacheWrite: pricing.cache_write } : {}),
          };
        }

        // ── Collision gate (against the live catalog + the target note path) ──
        const entries = catalog.entries();
        const byModelId = entries.find(e => e.model === discovered.model);
        if (byModelId) {
          return fail('CONFLICT', `model id ${discovered.model} is already in the catalog as "${byModelId.title}" — edit that note instead`);
        }
        if (entries.some(e => e.title === resolvedTitle)) {
          return fail('CONFLICT', `a catalog entry titled "${resolvedTitle}" already exists — pass a different title`);
        }
        const notePath = `${noteDeps.service.settingsDir}/Models/${resolvedTitle}.md`;
        const nodeExists = noteDeps.db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(notePath);
        if (nodeExists) {
          return fail('CONFLICT', `a note already exists at ${notePath} — pass a different title`);
        }

        // ── Mint the note through the single mutation pipeline ────────────────
        const entry = toCatalogEntry(discovered, resolvedTitle, enabled ?? true);
        const written = writeModelNoteIfAbsent(noteDeps, entry);
        if (!written) {
          // Raced with a concurrent create between the checks above and the write.
          return fail('CONFLICT', `a note already exists at ${notePath} — pass a different title`);
        }

        // ── Explicitly refresh the catalog so the new model resolves NOW ──────
        // (The general tool-path seam also fires via executeMutation, so this is
        // belt-and-braces — a second invalidate/bump is harmless and keeps the
        // tool self-contained in contexts where the seam isn't wired, e.g. tests.)
        catalog.invalidate();
        catalog.bumpVersion();
        onCatalogChange?.();

        const assembled = catalog.entries().find(e => e.title === resolvedTitle) ?? entry;
        return ok({ title: resolvedTitle, entry: assembled });
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
