// Resolves a `--models`/`--model` CLI ref against the sandboxed engine's
// model catalog (from BenchEngineClient.modelCatalog() — the vault copy
// carries the operator's real Settings/Models/ notes).
//
// This deliberately REIMPLEMENTS packages/curator/src/eval/model-ref.ts's
// `resolveCliModelRef` (~20 lines) rather than importing it. bench cannot
// import curator: the `bench-is-standalone-tool` dependency-cruiser rule in
// .dependency-cruiser.cjs forbids it (bench talks to the engine only over an
// MCP subprocess, never by importing another surface). Do NOT "fix" this
// duplication by adding that import — it will fail lint:deps in CI. If the
// resolution semantics ever need to change, change both copies.

import { resolveModelRef, type ModelCatalogEntry } from '@vault/settings-registry';

export interface ResolvedBenchModel {
  /** The ref exactly as given on the CLI — kept for report readability
   *  ("what the operator asked for" vs. what it resolved to). */
  ref: string;
  /** The resolved catalog entry, or a synthesized pass-through entry when
   *  the ref matched nothing (see below). */
  entry: ModelCatalogEntry;
  /** Non-null exactly when `entry` is a pass-through, not a catalog hit. */
  warning: string | null;
}

/**
 * Resolve one CLI model ref the way curator's `resolveCliModelRef` always
 * has: Settings/Models catalog title (bare or [[wikilinked]], ENABLED
 * entries only — resolveModelRef itself enforces that) first, then an
 * enabled entry's raw provider model id, else raw-id pass-through (routed to
 * fireworks, the dispatching client's default for an unrecognized id) with a
 * warning naming the ref. A disabled catalog entry is unresolvable by either
 * title or raw id, exactly like resolveModelRef's own title-only guarantee —
 * enforced here by falling through disabled rows in the raw-id search too.
 *
 * Prints the pass-through warning to console.warn (unless `quiet`) in
 * addition to returning it, mirroring resolveCliModelRef's own side effect —
 * a ref silently routing to the wrong provider is exactly the failure mode
 * that warning exists to catch.
 */
export function resolveBenchModelRef(
  catalog: ModelCatalogEntry[],
  ref: string,
  opts: { quiet?: boolean } = {},
): ResolvedBenchModel {
  const entry = resolveModelRef(catalog, ref) ?? catalog.find((e) => e.enabled && e.model === ref) ?? null;
  if (entry !== null) {
    return { ref, entry, warning: null };
  }

  const warning = `model ref "${ref}" is not an enabled Settings/Models entry — treating it as a raw fireworks model id`;
  if (opts.quiet !== true) {
    console.warn(`[bench] ${warning}`);
  }
  return {
    ref,
    entry: { title: ref, provider: 'fireworks', model: ref, enabled: true },
    warning,
  };
}
