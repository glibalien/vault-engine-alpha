import type { EngineNode, ExistingWiki } from '../src/types.js';
import type { SourceObservation } from '../src/provenance-types.js';

export const scope = { v: 1 as const, subject: 'Atlas', facet: 'Decisions' };
export function observedNode(id: string, body = 'Repeated é 😀 "quote" \\ path\nRepeated é 😀 "quote"', version = 7): EngineNode {
  const observation: SourceObservation = { source: { kind: 'node', namespace: 'vault', native_id: id }, authority: 'engine',
    observed_at: '2026-09-25T23:59:59Z', native_version: version, content_hash: 'hash-' + version,
    hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2', observation_digest: 'digest-' + id + version,
    label: 'Repeated é 😀 "quote"', path: `${id}.md` };
  return { id, title: observation.label, file_path: observation.path!, body, types: ['note'], fields: {}, version,
    metadata: { content_hash: observation.content_hash }, provenance_observation: observation };
}
export const wiki: ExistingWiki = { home_id: 'home', home: { id: 'home', version: 1 }, catalog_valid: true, topology_hash: 'topology', subpages: ['target', 'source'].map(id => ({
  id, title: 'Old catalog title', file_path: `${id}.md`, version: 1, content_hash: 'old', wiki_state: 'active',
  wiki_kind: 'freeform', wiki_origin: 'automatic', wiki_scope: scope, wiki_pinned: false,
})) };
