// packages/engine/src/web/setup.ts
import { ExaSearchProvider, type WebSearchProvider } from './provider.js';
import type { UsageRecorder } from '../usage/recorder.js';

export interface BuiltWebSearch {
  provider: WebSearchProvider | null;
}

/** Build the web-search provider from env, mirroring buildExtractors' key-gated shape.
 *  Returns { provider: null } when EXA_API_KEY is unset — fetch-url stays available regardless. */
export function buildWebSearch(
  env: Record<string, string | undefined>,
  usageRecorder?: UsageRecorder,
): BuiltWebSearch {
  const key = env.EXA_API_KEY;
  if (key && key.trim()) {
    return { provider: new ExaSearchProvider(key, undefined, usageRecorder) };
  }
  console.warn('[web-search] EXA_API_KEY unset; web-search tool disabled (fetch-url remains available)');
  return { provider: null };
}
