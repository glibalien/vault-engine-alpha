import type Database from 'better-sqlite3';
import { listGlobalFields } from '../global-fields/crud.js';
import { deriveReferenceContexts } from '../pipeline/relationships.js';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { anchorNamingKeys, candidateKeysForNode } from './candidate-keys.js';
import { buildReferenceCatalog, resolveRelationship, type Candidate, type ReferenceCatalog, type ReferenceRequest } from './relationship-policy.js';
import { readNodeResolutionIdentity, TYPED_REFERENCE_EDGE_SQL, type NodeResolutionIdentity } from './typed-refresh.js';

export interface TypedReferenceOccurrence {
  sourceId: string;
  field: string;
  rawTarget: string;
  targetId: string;
}

/**
 * The renamed note's name with an anchor put back (#613), checked against the catalog after the
 * rename: a typed reference whose whole text would name another note (one called `Beta#Goals`)
 * takes the new vault path instead, which only the renamed note answers to.
 */
function anchoredReplacement(
  name: string, anchor: string, next: NodeResolutionIdentity,
  proposed: ReferenceCatalog, context: ReferenceRequest['context'],
): string {
  if (anchor === '') return name;
  const text = name + anchor;
  const resolution = resolveRelationship(proposed, { rawTarget: text, context }, 2);
  return resolution.status === 'resolved' && resolution.targetId === next.id ? text : next.file_path + anchor;
}

/** Overlay one proposed identity without mutating the live database/catalog. */
function proposedCatalog(catalog: ReferenceCatalog, next: NodeResolutionIdentity): ReferenceCatalog {
  const keys = candidateKeysForNode(next);
  function replace(index: ReadonlyMap<string, readonly Candidate[]>, key: string | null) {
    const result = new Map<string, readonly Candidate[]>();
    for (const [name, candidates] of index) result.set(name, candidates.filter(candidate => candidate.id !== next.id));
    if (key !== null) result.set(key, [...(result.get(key) ?? []), next]);
    return result;
  }
  return {
    byPath: replace(catalog.byPath, keys.file_path),
    byTitle: replace(catalog.byTitle, keys.title),
    byBasename: replace(catalog.byBasename, keys.basename),
    byLower: replace(catalog.byLower, keys.basenameLower),
    byNfcLower: replace(catalog.byNfcLower, keys.basenameNfcLower),
  };
}

/** Plan from stored bindings before the target identity or inbound edges change. */
export function planTypedReferenceRename(
  db: Database.Database,
  targetId: string,
  next: NodeResolutionIdentity,
): readonly { occurrence: TypedReferenceOccurrence; replacement: string }[] {
  if (readReferencePolicyVersion(db) !== 2) return [];
  const rows = db.prepare(`SELECT source_id AS sourceId, rel_type AS field,
    target AS rawTarget, resolved_target_id AS targetId, gf.reference_target AS requiredType
    FROM relationships JOIN global_fields gf ON gf.name = relationships.rel_type
    WHERE resolved_target_id = ? AND ${TYPED_REFERENCE_EDGE_SQL}`).all(targetId) as Array<TypedReferenceOccurrence & { requiredType: string }>;
  if (rows.length === 0) return [];
  const catalog = buildReferenceCatalog(db);
  const proposed = proposedCatalog(catalog, next);
  const before = readNodeResolutionIdentity(db, targetId);
  const beforeKeys = before ? candidateKeysForNode(before) : null;
  return rows.map(({ requiredType, ...occurrence }) => {
    const context = { origin: 'field' as const, field: occurrence.field, requiredType };
    const prior = resolveRelationship(catalog, { rawTarget: occurrence.rawTarget, context }, 2);
    const titled = next.title === null ? null : resolveRelationship(proposed, { rawTarget: next.title, context }, 2);
    // A link to a heading or block in the note keeps its anchor (#613).
    const anchor = beforeKeys ? anchorNamingKeys(occurrence.rawTarget, beforeKeys) : '';
    const replacement = anchoredReplacement(prior.tier !== 1 && titled?.status === 'resolved' && titled.targetId === targetId
      ? next.title! : next.file_path, anchor, next, proposed, context);
    return { occurrence, replacement };
  }).filter(change => change.replacement !== change.occurrence.rawTarget);
}

/** Preview the target's own typed fields after pending edits and the governed rename.
 * Other sources still use the stored-tuple planner; no database writes are needed here.
 */
export function previewTypedRenameFields(
  db: Database.Database,
  next: NodeResolutionIdentity,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (readReferencePolicyVersion(db) !== 2) return fields;
  const before = readNodeResolutionIdentity(db, next.id);
  if (!before || (before.file_path === next.file_path && before.title === next.title)) return fields;
  const catalog = buildReferenceCatalog(db);
  const beforeRename = proposedCatalog(catalog, { ...before, types: next.types });
  const afterRename = proposedCatalog(catalog, next);
  const definitions = new Map(listGlobalFields(db).map(field => [field.name, field]));
  const replacements = new Map<string, Map<string, string>>();
  for (const edge of deriveReferenceContexts(fields, '', definitions, {})) {
    const context = edge.referenceContext;
    if (context.origin !== 'field' || context.requiredType === null) continue;
    const prior = resolveRelationship(beforeRename, { rawTarget: edge.target, context }, 2);
    if (prior.status !== 'resolved' || prior.targetId !== next.id) continue;
    const titled = next.title === null ? null : resolveRelationship(afterRename, { rawTarget: next.title, context }, 2);
    const replacement = anchoredReplacement(prior.tier !== 1 && titled?.status === 'resolved' && titled.targetId === next.id
      ? next.title! : next.file_path, anchorNamingKeys(edge.target, candidateKeysForNode(before)), next, afterRename, context);
    const values = replacements.get(edge.rel_type) ?? new Map<string, string>();
    values.set(edge.target, replacement);
    replacements.set(edge.rel_type, values);
  }
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => {
    const replace = (item: unknown) => typeof item === 'string' ? replacements.get(name)?.get(item) ?? item : item;
    return [name, Array.isArray(value) ? value.map(replace) : replace(value)];
  }));
}
