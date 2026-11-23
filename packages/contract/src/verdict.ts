// The one function two consumers share: the bench harness scores candidate
// models with it offline; the Phase-3 Auto-mode router escalates with it at
// runtime. It must stay a pure predicate over the wire envelope — no I/O,
// no dependencies — so both consumers are provably acting on the same signal.

import type { Envelope } from './index.js';

export type Verdict = 'PASS' | 'WEAK' | 'FAIL';

/**
 * Per-tool key in `data` holding the primary result collection. Only tools
 * listed here can be WEAK (ok:true but empty). Everything else is PASS on
 * ok:true — e.g. get-node returns embeds: [] legitimately and must never
 * read as WEAK. Keys verified against the engine tool sources 2026-08-01.
 *
 * Doc-filtered `list-boards` / `list-conversations` calls (`doc_node_id`)
 * return the same payload shapes, so one entry covers both. Because `verdict()`
 * is not only the bench's scorer but also the runtime Auto-mode escalation
 * predicate, a tool missing from this map is not merely mis-reported — it
 * silently stops being an escalation trigger at runtime.
 */
export const EMPTY_COLLECTION_KEYS: Readonly<Record<string, string>> = {
  'query-nodes': 'nodes',
  'web-search': 'results',
  'list-memories': 'memories',
  'list-transcripts': 'transcripts',
  'list-boards': 'boards',
  'list-conversations': 'conversations',
};

export function verdict(toolName: string, envelope: Envelope<unknown>): Verdict {
  if (!envelope.ok) return 'FAIL';
  const key = EMPTY_COLLECTION_KEYS[toolName];
  if (key !== undefined) {
    const data = envelope.data as Record<string, unknown> | null | undefined;
    const collection = data !== null && data !== undefined ? data[key] : undefined;
    if (Array.isArray(collection) && collection.length === 0) return 'WEAK';
  }
  return 'PASS';
}

export type DryRunVerdict = 'VALID' | 'INVALID';

/**
 * Verdict for a no-commit write validation (dry_run / validate-node).
 * Engine dry-runs report validation failures as ok:true + error-severity
 * warnings, so ok alone is not the signal.
 */
export function dryRunVerdict(envelope: Envelope<unknown>): DryRunVerdict {
  if (!envelope.ok) return 'INVALID';
  return envelope.warnings.some((w) => w.severity === 'error') ? 'INVALID' : 'VALID';
}
