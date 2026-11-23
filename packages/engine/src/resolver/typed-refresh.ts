import type Database from 'better-sqlite3';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { listGlobalFields } from '../global-fields/crud.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { deriveReferenceContexts } from '../pipeline/relationships.js';
import type { ReferenceDiagnostic } from '../pipeline/diagnostics.js';
import { candidateKeysForNode, targetMatchesKeys } from './candidate-keys.js';
import { anchoredLinkName } from './resolve.js';
import { buildReferenceCatalog, resolveRelationship, type ReferenceRequest, type Resolution } from './relationship-policy.js';

export interface NodeResolutionIdentity {
  id: string;
  file_path: string;
  title: string | null;
  types: readonly string[];
}
export type ReferenceChange =
  | { kind: 'node'; before: NodeResolutionIdentity | null; after: NodeResolutionIdentity | null }
  | { kind: 'field'; names: readonly string[] };
export interface TypedRefreshStats {
  scanned: number;
  changed: number;
  /**
   * Edges a node lifecycle change unbound: resolved before this refresh, unresolved after
   * (for example a second same-title target). Reported to the caller as inbound warnings.
   */
  unbound?: ReferenceDiagnostic[];
}

// Match the shared derivation's scalar/list value shapes as well as field
// context. Parser fallback links inside malformed values remain unconstrained,
// even when the global definition happens to be a typed reference.
export const TYPED_REFERENCE_EDGE_SQL = `EXISTS (
  SELECT 1 FROM global_fields gf
  WHERE gf.name = relationships.rel_type AND relationships.context = gf.name
    AND gf.reference_target IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM node_fields nf
      WHERE nf.node_id = relationships.source_id AND nf.field_name = gf.name
        AND ((gf.field_type = 'reference' AND nf.value_text = relationships.target AND nf.value_json IS NULL)
          OR (gf.field_type = 'list' AND gf.list_item_type = 'reference'
            AND EXISTS (SELECT 1 FROM json_each(
              CASE WHEN json_valid(nf.value_json) AND json_type(nf.value_json) = 'array'
                THEN nf.value_json ELSE '[]' END
            ) item WHERE item.type = 'text' AND item.value = relationships.target)))
    )
)`;

export function readNodeResolutionIdentity(db: Database.Database, id: string): NodeResolutionIdentity | null {
  const row = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(id) as Omit<NodeResolutionIdentity, 'types'> | undefined;
  if (!row) return null;
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type').all(id) as Array<{ schema_type: string }>).map(row => row.schema_type);
  return { ...row, types };
}

interface Edge { id: number; source_id: string; target: string; rel_type: string; resolved_target_id: string | null; requiredType: string }
function assertTransaction(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('Typed reference refresh requires an owning write transaction');
}
function typedEdges(db: Database.Database): Edge[] {
  return db.prepare(`SELECT relationships.id, source_id, target, rel_type, resolved_target_id,
    gf.reference_target AS requiredType FROM relationships
    JOIN global_fields gf ON gf.name = relationships.rel_type
    WHERE ${TYPED_REFERENCE_EDGE_SQL}`).all() as Edge[];
}
function refreshEdges(db: Database.Database, edges: Edge[], options: { collectUnbound?: boolean } = {}): TypedRefreshStats {
  if (edges.length === 0) return { scanned: 0, changed: 0, ...(options.collectUnbound ? { unbound: [] } : {}) };
  const catalog = buildReferenceCatalog(db);
  const update = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
  const cache = new Map<string, { request: ReferenceRequest; resolution: Resolution }>();
  const unbound: ReferenceDiagnostic[] = [];
  let changed = 0;
  for (const edge of edges) {
    const key = JSON.stringify([edge.target, edge.rel_type, edge.requiredType]);
    if (!cache.has(key)) {
      const request: ReferenceRequest = { rawTarget: edge.target,
        context: { origin: 'field', field: edge.rel_type, requiredType: edge.requiredType } };
      cache.set(key, { request, resolution: resolveRelationship(catalog, request, 2) });
    }
    const { request, resolution } = cache.get(key)!;
    const targetId = resolution.status === 'resolved' ? resolution.targetId : null;
    if (targetId !== edge.resolved_target_id) {
      update.run(targetId, edge.id); changed++;
      if (options.collectUnbound && targetId === null) unbound.push({ sourceId: edge.source_id, request, resolution });
    }
  }
  return { scanned: edges.length, changed, ...(options.collectUnbound ? { unbound } : {}) };
}

/** Refresh only the derived index, never source fields, versions, files or embeddings. */
export function refreshTypedReferences(db: Database.Database, change: ReferenceChange): TypedRefreshStats {
  assertTransaction(db);
  if (readReferencePolicyVersion(db) !== 2) return { scanned: 0, changed: 0 };
  if (change.kind === 'field') return refreshFields(db, change.names);
  const identities = [change.before, change.after].filter((node): node is NodeResolutionIdentity => node !== null);
  if (change.before && change.after && change.before.file_path === change.after.file_path
    && change.before.title === change.after.title
    && [...change.before.types].sort().join('\0') === [...change.after.types].sort().join('\0')) {
    return { scanned: 0, changed: 0 };
  }
  const keys = identities.map(candidateKeysForNode);
  const ids = new Set(identities.map(node => node.id));
  const affected = typedEdges(db).filter(edge => {
    if (edge.resolved_target_id !== null && ids.has(edge.resolved_target_id)) return true;
    const target = edge.target.endsWith('.md') ? edge.target.slice(0, -3) : edge.target;
    // A link to a heading or block names the note before its `#` (#613).
    const name = anchoredLinkName(edge.target);
    return keys.some(key => edge.target === key.file_path || edge.target === key.pathStem || edge.target === key.title
      || target.normalize('NFC').toLowerCase() === key.basenameNfcLower
      || (name !== null && targetMatchesKeys(name, key)));
  });
  return refreshEdges(db, affected, { collectUnbound: true });
}

/** Caller runs this after the complete index, including offline deletions. */
export function reconcileTypedReferences(db: Database.Database): TypedRefreshStats {
  assertTransaction(db);
  if (readReferencePolicyVersion(db) !== 2) return { scanned: 0, changed: 0 };
  return refreshEdges(db, typedEdges(db));
}

interface FieldRow {
  node_id: string; field_name: string; value_text: string | null; value_number: number | null;
  value_date: string | null; value_json: string | null; value_raw_text: string | null;
}
function refreshFields(db: Database.Database, names: readonly string[]): TypedRefreshStats {
  const globalFields = new Map(listGlobalFields(db).map(field => [field.name, field]));
  const catalog = buildReferenceCatalog(db);
  const deleteEdge = db.prepare('DELETE FROM relationships WHERE id = ?');
  const insertEdge = db.prepare('INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)');
  const updateEdge = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
  let scanned = 0;
  let changed = 0;
  for (const name of new Set(names)) {
    const existing = db.prepare('SELECT id, source_id, target, resolved_target_id FROM relationships WHERE rel_type = ? AND context = ?').all(name, name) as Array<{ id: number; source_id: string; target: string; resolved_target_id: string | null }>;
    const byKey = new Map(existing.map(edge => [JSON.stringify([edge.source_id, edge.target]), edge]));
    const rows = db.prepare('SELECT node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE field_name = ?').all(name) as FieldRow[];
    for (const row of rows) {
      const fields = { [name]: reconstructValue(row) };
      const raw = row.value_raw_text === null ? {} : { [name]: row.value_raw_text };
      for (const edge of deriveReferenceContexts(fields, '', globalFields, raw)) {
        const resolution = resolveRelationship(catalog, { rawTarget: edge.target, context: edge.referenceContext }, 2);
        const targetId = resolution.status === 'resolved' ? resolution.targetId : null;
        const key = JSON.stringify([row.node_id, edge.target]);
        const old = byKey.get(key);
        scanned++;
        if (!old) { changed += insertEdge.run(row.node_id, edge.target, edge.rel_type, edge.context, targetId).changes; }
        else if (old.resolved_target_id !== targetId) { updateEdge.run(targetId, old.id); changed++; }
        byKey.delete(key);
      }
    }
    for (const old of byKey.values()) { deleteEdge.run(old.id); scanned++; changed++; }
  }
  return { scanned, changed };
}
