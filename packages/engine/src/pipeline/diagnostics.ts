import type Database from 'better-sqlite3';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { listGlobalFields } from '../global-fields/crud.js';
import { deriveReferenceContexts } from './relationships.js';
import { buildReferenceCatalog, resolveRelationship, type Candidate, type ReferenceCatalog } from '../resolver/relationship-policy.js';
import { candidateKeysForNode } from '../resolver/candidate-keys.js';
import { TYPED_REFERENCE_EDGE_SQL } from '../resolver/typed-refresh.js';
import type { ValidationResult } from '../validation/types.js';
import type { ReferenceRequest, Resolution } from '../resolver/relationship-policy.js';

// Private catalog identity for a node that does not exist yet. Warning adapters
// expose it as an explicitly proposed candidate with no persisted ID.
export const PROPOSED_REFERENCE_NODE_ID = '<proposed-node>';

/** Internal resolution evidence; MCP adapters decide how to present it. */
export interface ReferenceDiagnostic {
  /** Present only for inspection; never used to repair the stored index. */
  storedTargetId?: string | null;
  opIndex?: number;
  sourceId: string | null;
  request: ReferenceRequest;
  resolution: Resolution;
}

function referenceCatalogForProposal(db: Database.Database, sourceId: string | null, proposed?: Omit<Candidate, 'id'>) {
  const catalog = buildReferenceCatalog(db);
  if (proposed) {
    const candidate: Candidate = { ...proposed, id: sourceId ?? PROPOSED_REFERENCE_NODE_ID };
    const keys = candidateKeysForNode(candidate);
    for (const [map, key] of [
      [catalog.byPath, keys.file_path], [catalog.byTitle, keys.title], [catalog.byBasename, keys.basename],
      [catalog.byLower, keys.basenameLower], [catalog.byNfcLower, keys.basenameNfcLower],
    ] as const) {
      // The catalog is fresh and private to this preview; replace the source's old identity.
      const mutable = map as Map<string, readonly Candidate[]>;
      if (sourceId !== null) for (const [name, entries] of mutable) mutable.set(name, entries.filter(entry => entry.id !== sourceId));
      if (key !== null) mutable.set(key, [...(mutable.get(key) ?? []), candidate]);
    }
  }
  return catalog;
}

/** Inspect persisted typed edges after a composed operation, or overlay only its proposed identity. */
export function* collectStoredReferenceDiagnostics(
  db: Database.Database, sourceId?: string, proposed?: Omit<Candidate, 'id'>,
  /** A catalog of the current state to reuse across sources; ignored with `proposed`. */
  shared?: ReferenceCatalog,
): Iterable<ReferenceDiagnostic> {
  if (readReferencePolicyVersion(db) !== 2) return;
  const catalog = shared !== undefined && proposed === undefined
    ? shared
    : referenceCatalogForProposal(db, sourceId ?? null, proposed);
  const rows = db.prepare(`SELECT relationships.source_id, relationships.target, relationships.rel_type,
    gf.reference_target AS required_type FROM relationships
    JOIN global_fields gf ON gf.name = relationships.rel_type
    WHERE ${TYPED_REFERENCE_EDGE_SQL}${sourceId === undefined ? '' : ' AND relationships.source_id = ?'}
    ORDER BY relationships.id`).iterate(...(sourceId === undefined ? [] : [sourceId])) as Iterable<{
      source_id: string; target: string; rel_type: string; required_type: string;
    }>;
  for (const row of rows) {
    const request: ReferenceRequest = { rawTarget: row.target,
      context: { origin: 'field', field: row.rel_type, requiredType: row.required_type } };
    const resolution = resolveRelationship(catalog, request, 2);
    if (resolution.status === 'unresolved') yield { sourceId: row.source_id, request, resolution };
  }
}

/**
 * Other nodes' typed references that a composed operation left unresolved, judged by the
 * stored final state: a reference a later step resolved again drops out (#112). Each is
 * matched by source, field and raw target, and keeps the first operation index seen.
 * Sources in `skip` are left out, since their own diagnostics are already reported.
 */
export function* recheckInboundDiagnostics(
  db: Database.Database, inbound: Iterable<ReferenceDiagnostic>, skip: ReadonlySet<string> = new Set(),
): Iterable<ReferenceDiagnostic> {
  const key = (diagnostic: ReferenceDiagnostic) => JSON.stringify([diagnostic.request.context.field, diagnostic.request.rawTarget]);
  const bySource = new Map<string, Map<string, number | undefined>>();
  for (const diagnostic of inbound) {
    if (diagnostic.sourceId === null || skip.has(diagnostic.sourceId)) continue;
    const keys = bySource.get(diagnostic.sourceId) ?? new Map<string, number | undefined>();
    if (!keys.has(key(diagnostic))) keys.set(key(diagnostic), diagnostic.opIndex);
    bySource.set(diagnostic.sourceId, keys);
  }
  if (bySource.size === 0) return;
  // One catalog of the final state serves every source.
  const catalog = buildReferenceCatalog(db);
  for (const [sourceId, keys] of bySource) {
    for (const diagnostic of collectStoredReferenceDiagnostics(db, sourceId, undefined, catalog)) {
      if (!keys.has(key(diagnostic))) continue;
      const opIndex = keys.get(key(diagnostic));
      yield opIndex === undefined ? diagnostic : { ...diagnostic, opIndex };
    }
  }
}

/** Read-only preview of the same derived field references used by applied writes. */
export function collectReferenceDiagnostics(
  db: Database.Database, sourceId: string | null, fields: Record<string, unknown>, body: string,
  rawFields: Record<string, string> = {}, proposed?: Omit<Candidate, 'id'>,
): ReferenceDiagnostic[] {
  if (readReferencePolicyVersion(db) !== 2) return [];
  const catalog = referenceCatalogForProposal(db, sourceId, proposed);
  const definitions = new Map(listGlobalFields(db).map(field => [field.name, field]));
  return deriveReferenceContexts(fields, body, definitions, rawFields).flatMap(edge => {
    const request = { rawTarget: edge.target, context: edge.referenceContext };
    const resolution = resolveRelationship(catalog, request, 2);
    return resolution.status === 'unresolved' ? [{ sourceId, request, resolution }] : [];
  });
}

export function validatedReferenceFields(validation: ValidationResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validation.coerced_state).map(([name, value]) => [name, value.value]));
}
