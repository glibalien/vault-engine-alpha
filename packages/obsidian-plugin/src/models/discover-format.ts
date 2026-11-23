// Pure, Obsidian-free helpers for the Discover/Manage models modal. Kept in a
// separate module (no `obsidian` import) so they are trivially unit-testable and
// reusable by both the modal and the engine-call service.

import type { ModelProvider } from '@vault/settings-registry';

/** One row of the `discover-models` tool result (`ok({ models: [...] })`). */
export interface DiscoveredModelRow {
  provider: ModelProvider;
  model: string; // full provider id
  displayName: string;
  description: string;
  vision: boolean;
  tools: boolean;
  contextLength: number | null;
  pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
  serverless: boolean;
  deprecated: boolean;
  inCatalog: boolean;
}

/** A catalog entry as shown in Manage mode (subset of ModelCatalogEntry). */
export interface CatalogEntry {
  title: string;
  provider: ModelProvider;
  enabled: boolean;
}

/** The three item shapes a single modal renders across its modes. */
export type DiscoverItem =
  | { kind: 'provider'; provider: ModelProvider }
  | { kind: 'remote'; m: DiscoveredModelRow }
  | { kind: 'catalog'; title: string; enabled: boolean; provider: ModelProvider };

/** Compact context-window label: 2000000 → "2M", 1500000 → "1.5M", 200000 → "200k", 512 → "512".
 *  Million-scale windows are ordinary now, and "1000k ctx" reads as a rendering bug. */
export function formatContextLength(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

/**
 * Detail line for a discovered (remote) model row — only the segments that
 * exist, joined by " · ":
 *   `<model id> · 👁 vision · 🔧 tools · <ctx> ctx · $<in>/$<out> per Mtok (or 'no list price') · ✓ in catalog`
 */
export function remoteDetailLine(row: DiscoveredModelRow): string {
  const segs: string[] = [row.model];
  if (row.vision) segs.push('👁 vision');
  if (row.tools) segs.push('🔧 tools');
  if (row.contextLength != null) segs.push(`${formatContextLength(row.contextLength)} ctx`);
  // Anthropic and OpenAI list no prices; an unpriced model is refused by a capped
  // Curator budget until its note gets price_input/price_output.
  segs.push(row.pricing ? `$${row.pricing.input}/$${row.pricing.output} per Mtok` : 'no list price');
  if (row.inCatalog) segs.push('✓ in catalog');
  return segs.join(' · ');
}

/** Single-line label for a catalog entry: `title — provider · enabled|disabled`. */
export function catalogDetailLine(entry: { title: string; provider: ModelProvider; enabled: boolean }): string {
  return `${entry.title} — ${entry.provider} · ${entry.enabled ? 'enabled' : 'disabled'}`;
}

/**
 * The two tool-call argument objects for toggling a catalog entry's `enabled`:
 * `get-node` resolves the note id from its path in `<settingsDir>/Models/` (the
 * settings folder Engine reports; `Settings` by default), then `update-node` sets
 * `enabled` to the flipped value (node_id is merged in at call time from the
 * get-node result). Pure so the path + flip logic is testable without an engine.
 */
export function toggleArgs(
  title: string,
  currentEnabled: boolean,
  settingsDir = 'Settings',
): { getNode: { file_path: string }; setFields: { enabled: boolean } } {
  return {
    getNode: { file_path: `${settingsDir}/Models/${title}.md` },
    setFields: { enabled: !currentEnabled },
  };
}
