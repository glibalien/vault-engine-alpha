import type { LanguageModel } from 'ai';
import {
  interpretVizSpec, fetchVizVocabulary, usageEventArgs, providerAvailability,
  type EngineCall, type ProviderKeys, type VizVaultNames, type VizVocabulary,
} from '@vault/chat-core';
import { resolveModelRef, type ModelCatalogEntry } from '@vault/settings-registry';
import type { ChatSettings } from '@vault/settings-registry';
import type { BoardCardSpec, VizSpec } from '@vault/viz-ui';

export interface BoardInterpreterDeps {
  engineCall: EngineCall;
  effective: () => Promise<{ settings: ChatSettings; catalog: ModelCatalogEntry[] }>;
  keys: ProviderKeys;
  makeModel: (entry: ModelCatalogEntry) => LanguageModel;
  recordUsage: (args: Record<string, unknown>) => void;
  log: (msg: string) => void;
  /** The vault map's names the prompt examples use, read when a request is interpreted.
   *  Absent: the map's defaults, today's names. */
  vault?: () => VizVaultNames;
}

/**
 * Strict chat.vizModel resolution (no fallback model — mirrors runTitleFlow's strictness, but
 * here failure is a visible composer error, not a mechanical fallback). Shared by every pipeline
 * that touches the LLM (the phase-1 viz interpreter here, and pipelines.ts's board path).
 * Two distinct user actions get two distinct messages: an unresolvable/disabled ref means pick a
 * different model in Settings/Chat.md; a resolvable one just needs its provider's API key added
 * to the plugin settings — conflating them sent users to the wrong place.
 */
export async function resolveVizModel(deps: Pick<BoardInterpreterDeps, 'effective' | 'keys'>):
  Promise<{ ok: true; entry: ModelCatalogEntry } | { ok: false; error: string }> {
  const { settings, catalog } = await deps.effective();
  const entry = resolveModelRef(catalog, settings.vizModel);
  if (!entry) return { ok: false, error: `viz model ${settings.vizModel} is not in the model catalog (or is disabled) — set chat.vizModel in Settings/Chat.md to an enabled catalog model` };
  if (!providerAvailability(deps.keys)[entry.provider]) return { ok: false, error: `viz model ${settings.vizModel} needs a ${entry.provider} API key — add it in the plugin settings` };
  return { ok: true, entry };
}

/** Lazily-cached vocabulary fetch, shared by the viz interpreter and the board pipeline.
 *  A failed fetch clears the cache so the next submit retries. The schemas are cached; the vault
 *  map's names are taken fresh on every call (deps.vault). */
export function makeVocabFetcher(deps: Pick<BoardInterpreterDeps, 'engineCall' | 'vault'>): () => Promise<VizVocabulary> {
  let p: Promise<VizVocabulary> | null = null;
  return async () => {
    if (!p) p = fetchVizVocabulary(deps.engineCall).catch((err: unknown) => { p = null; throw err; });
    const vocab = await p;
    return deps.vault ? { ...vocab, vault: deps.vault() } : vocab;
  };
}

/**
 * Composes the phase-1 viz interpreter fn: strict model resolution via resolveVizModel, lazily
 * cached vocabulary, chat-core interpretation, fire-and-forget viz-interpret spend record. Its
 * spec type is widened to BoardCardSpec (the phase-2 board card union) purely so pipelines.ts —
 * which dispatches all composer tools, including this one — has one uniform return type; the
 * value itself is always a VizSpec, unchanged.
 */
export function makeBoardInterpreter(deps: BoardInterpreterDeps, getVocab: () => Promise<VizVocabulary> = makeVocabFetcher(deps)) {
  return async (text: string, current?: VizSpec): Promise<{ ok: true; spec: BoardCardSpec } | { ok: false; error: string }> => {
    try {
      const resolved = await resolveVizModel(deps);
      if (!resolved.ok) return resolved;
      const entry = resolved.entry;

      let vocab: VizVocabulary;
      try { vocab = await getVocab(); }
      catch (err) {
        return { ok: false as const, error: `could not load the vault vocabulary: ${err instanceof Error ? err.message : String(err)}` };
      }

      const start = Date.now();
      const result = await interpretVizSpec({
        text, vocab, model: deps.makeModel(entry),
        ...(current !== undefined ? { current: current as never } : {}),
      });
      const latencyMs = Date.now() - start;
      if (!result.ok) return result;

      try {
        const args = usageEventArgs({
          model: entry.model, provider: entry.provider, service: 'chat-plugin',
          purpose: 'viz-interpret', totalUsage: result.usage, latencyMs, billing: result.billing,
        });
        if (args) deps.recordUsage(args);
      } catch (err) {
        deps.log(`viz-interpret usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true as const, spec: result.spec as unknown as BoardCardSpec };
    } catch (err) {
      // Belt-and-braces outer catch (mirrors runTitleFlow): every step above has its own
      // handling, so this only fires on something unexpected — the composer must never
      // see a rejected promise, only a visible error.
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
