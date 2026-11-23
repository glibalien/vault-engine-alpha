import type Database from 'better-sqlite3';
import { digestJson } from './canonical.js';
import { ProvenanceError } from './limits.js';
import { ProvenanceStore } from './store.js';
import { observationSchema } from './validation.js';
import type { Json, SourceObservation } from './types.js';

function changed(): never { throw new ProvenanceError('PROVENANCE_OBSERVATION_CHANGED'); }

export function observeNode(db: Database.Database, nodeId: string, observedAt = new Date().toISOString()): SourceObservation {
  const node = db.prepare('SELECT id,version,content_hash,title,file_path FROM nodes WHERE id=?').get(nodeId) as
    { id: string; version: number; content_hash: string | null; title: string | null; file_path: string } | undefined;
  if (!node) return changed();
  return {
    source: { namespace: new ProvenanceStore(db).namespace(), kind: 'node', native_id: node.id },
    authority: 'engine', observed_at: observedAt, native_version: node.version, content_hash: node.content_hash,
    hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2',
    observation_digest: digestJson({ id: node.id, version: node.version, content_hash: node.content_hash, title: node.title, file_path: node.file_path }),
    label: node.title, path: node.file_path,
  };
}

export function observeMemory(db: Database.Database, memoryId: number, observedAt = new Date().toISOString()): SourceObservation {
  const memory = db.prepare(`SELECT id,source,scope,node_id,content,category,valid_at,invalid_at,
    expired_at,superseded_by,evidence_kind,evidence_node_id,evidence_hash,evidence_ref FROM memories WHERE id=?`).get(memoryId) as Record<string, Json> | undefined;
  if (!memory) return changed();
  const digest = digestJson(memory);
  return {
    source: { namespace: new ProvenanceStore(db).namespace(), kind: 'memory', native_id: String(memoryId) },
    authority: 'engine', observed_at: observedAt, native_version: null, content_hash: digest,
    hash_semantics: 'selected_projection_v1', observation_projection: 'memory-content-v1',
    observation_digest: digest, label: null, path: null,
  };
}

/** Validates freshness and identity, not claim-level support or excerpt entailment. */
export function validateObservations(db: Database.Database, observations: SourceObservation[]): void {
  for (const observation of observations) {
    if (!observationSchema.safeParse(observation).success) changed();
    const { source } = observation;
    if (source.kind === 'node' || source.kind === 'memory') {
      if (observation.authority !== 'engine' || source.namespace !== new ProvenanceStore(db).namespace()) changed();
      if (source.kind === 'memory' && !/^[1-9][0-9]*$/.test(source.native_id)) changed();
      const actual = source.kind === 'node' ? observeNode(db, source.native_id) : observeMemory(db, Number(source.native_id));
      if (actual.observation_digest !== observation.observation_digest
        || actual.observation_projection !== observation.observation_projection
        || actual.hash_semantics !== observation.hash_semantics
        || actual.content_hash !== observation.content_hash || actual.native_version !== observation.native_version) changed();
    } else if (observation.authority !== 'caller' || observation.observation_projection !== 'caller-content-v1'
      || observation.hash_semantics !== 'caller_content_v1') changed();
  }
}

/** Enumerates represented node IDs only. Aggregates remain explicitly opaque. */
export function observeEvidenceNodes(db: Database.Database, evidence: unknown, selectedIds?: readonly string[]): {
  nodes: Record<string, SourceObservation>; truncated: boolean; aggregate_coverage: 'opaque';
} {
  const ids = new Set<string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string') ids.add(record.id);
    Object.values(record).forEach(visit);
  }
  visit(evidence);
  if (selectedIds && selectedIds.length > 512) throw new ProvenanceError('PROVENANCE_LIMIT');
  const selected = selectedIds ? [...new Set(selectedIds)].filter(id => ids.has(id)) : [...ids].sort().slice(0, 512);
  const nodes: Record<string, SourceObservation> = Object.create(null);
  const at = new Date().toISOString();
  for (const id of selected) {
    if (db.prepare('SELECT id FROM nodes WHERE id=?').get(id)) nodes[id] = observeNode(db, id, at);
  }
  return { nodes, truncated: ids.size > Object.keys(nodes).length, aggregate_coverage: 'opaque' };
}
