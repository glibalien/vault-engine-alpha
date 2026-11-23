import type Database from 'better-sqlite3';
import { textHashOf } from '../notes/text-hash.js';
import { observeMemory, observeNode } from './observations.js';
import { ProvenanceStore } from './store.js';
import { observationSchema } from './validation.js';
import type { Comparison, SourceObservation } from './types.js';
export type ComparisonCandidate = {
  kind: string | null;
  native_id: string | null;
  namespace: string | null;
  observation_digest: string | null;
  projection: string | null;
  authority: string | null;
  post_commit_observation: string | null;
  expected_post_commit_observation?: string | null;
  output_node_id: string;
  /** The note's text hash when it was observed (#332); null for observations from before. */
  text_hash?: string | null;
  /** Its title and path when it was observed. */
  label?: string | null;
  path?: string | null;
};
export function compareInput(
  db: Database.Database,
  row: ComparisonCandidate,
): Comparison {
  if (!row.observation_digest || row.authority !== 'engine')
    return 'comparison_unknown';
  try {
    if (row.namespace !== new ProvenanceStore(db).namespace()) return 'comparison_unknown';
    const exists =
      row.kind === 'node'
        ? db.prepare('SELECT id FROM nodes WHERE id=?').get(row.native_id!)
        : row.kind === 'memory'
          ? db
              .prepare('SELECT id FROM memories WHERE id=?')
              .get(Number(row.native_id!))
          : null;
    if (row.kind !== 'node' && row.kind !== 'memory')
      return 'comparison_unknown';
    if (!exists) return 'missing';
    const current =
      row.kind === 'node'
        ? observeNode(db, row.native_id!)
        : observeMemory(db, Number(row.native_id!));
    // Earlier node tokens did not cover labels/paths; do not infer a change (or
    // no change) by comparing digests from different projections.
    if (current.observation_projection !== row.projection)
      return 'comparison_unknown';
    if (current.observation_digest === row.observation_digest)
      return 'unchanged';
    // New per-input transitions cover all deliberately changed inputs. Old outputs
    // retain their narrower self-transition fallback when no per-input token exists.
    const expected = row.expected_post_commit_observation ??
      (row.kind === 'node' && row.native_id === row.output_node_id ? row.post_commit_observation : null);
    if (expected && matchesExpectedTransition(expected, current)) return 'expected_self_transition';
    // A note that only gained or lost links around its words (the link sweep) reads as before (#332).
    if (row.kind === 'node' && row.text_hash && current.label === row.label && current.path === row.path
      && textHashOf(db, row.native_id!) === row.text_hash) return 'unchanged';
    return 'changed';
  } catch {
    return 'unavailable';
  }
}

function matchesExpectedTransition(text: string, current: SourceObservation): boolean {
  try {
    const parsed = observationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return false;
    const token = parsed.data;
    return token.authority === 'engine'
      && token.source.namespace === current.source.namespace
      && token.source.kind === current.source.kind && token.source.native_id === current.source.native_id
      && token.observation_projection === current.observation_projection
      && token.observation_digest === current.observation_digest;
  } catch { return false; }
}
