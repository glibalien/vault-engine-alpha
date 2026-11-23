import { resolveModel, type ProviderKeys } from '@vault/chat-core';
import type { LanguageModel } from 'ai';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { makeStreamingRelayFetch, relayUrlFromEngineUrl } from './streaming-relay-fetch.js';

/**
 * Build a LanguageModel for any catalog entry that streams through the engine
 * relay (`POST /llm/stream`) — replaces the old Fireworks-only
 * `makeFireworksModel`; the LLM path now generalizes to any provider in the
 * model catalog via chat-core's `resolveModel` (which dispatches per-model and
 * throws loudly if this surface lacks the entry's provider key).
 *
 * Obsidian's `requestUrl` is buffered-only, so the LLM bytes are streamed via
 * the engine (a Node process) instead — see streaming-relay-fetch.ts. `relay`
 * carries the engine URL + bearer token. `fetchImpl` is a test seam, mirroring
 * `makeStreamingRelayFetch`'s own.
 */
export function makeRelayModel(
  entry: ModelCatalogEntry,
  keys: ProviderKeys,
  relay: { engineUrl: string; token: string },
  fetchImpl?: typeof globalThis.fetch,
): LanguageModel {
  const fetch = makeStreamingRelayFetch({
    relayUrl: relayUrlFromEngineUrl(relay.engineUrl),
    token: relay.token,
    fetchImpl,
  });
  return resolveModel(entry, keys, { fetch });
}
