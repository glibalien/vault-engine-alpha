import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { readReferencePolicyVersion, REFERENCE_POLICY_VERSION_KEY } from '../db/reference-policy-version.js';
import { buildReferenceCatalog, resolveRelationship, type ReferenceCatalog, type ReferencePolicyVersion } from './relationship-policy.js';
import { TYPED_REFERENCE_EDGE_SQL } from './typed-refresh.js';

export interface ReferenceActivationCounts {
  scanned: number; unchanged: number; changed: number;
  newly_resolved: number; newly_unresolved: number; redirected: number;
}
export interface ReferenceActivationChange {
  source_id: string; field: string; raw_target: string;
  before_id: string | null; after_id: string | null;
  reason: 'resolved' | 'missing' | 'type_mismatch' | 'ambiguous';
}
export interface ReferenceActivationPreview {
  format_version: 1; from_policy: ReferencePolicyVersion; to_policy: 2; fingerprint: string;
  counts: ReferenceActivationCounts; changes: ReferenceActivationChange[];
  truncated: boolean; omitted_changes: number;
}
export interface ReferenceActivationReceipt {
  format_version: 1; from_policy: ReferencePolicyVersion; to_policy: 2; fingerprint: string;
  counts: ReferenceActivationCounts; noop: boolean;
}
interface Edge {
  id: number; source_id: string; target: string; rel_type: string;
  resolved_target_id: string | null; required_type: string;
}
const EDGE_SELECT = `SELECT relationships.id, source_id, target, rel_type, resolved_target_id,
  gf.reference_target AS required_type FROM relationships
  JOIN global_fields gf ON gf.name = relationships.rel_type
  WHERE ${TYPED_REFERENCE_EDGE_SQL}`;
const EDGE_SQL = `${EDGE_SELECT} ORDER BY source_id, rel_type, target`;

/** Hash the full semantic input, independent of bounded examples and physical edge IDs. */
function fingerprint(db: Database.Database): string {
  const hash = createHash('sha256');
  const sections = [
    ['policy', `SELECT key, value FROM meta WHERE key = '${REFERENCE_POLICY_VERSION_KEY}'`],
    ['nodes', 'SELECT id, file_path, title FROM nodes ORDER BY id'],
    ['types', 'SELECT node_id, schema_type FROM node_types ORDER BY node_id, schema_type'],
    ['fields', 'SELECT * FROM global_fields ORDER BY name'],
    ['values', 'SELECT * FROM node_fields ORDER BY node_id, field_name'],
    ['edges', 'SELECT source_id, rel_type, target, context, resolved_target_id FROM relationships ORDER BY source_id, rel_type, target'],
  ];
  hash.update('reference-activation-v1-to-policy-2\n');
  for (const [section, sql] of sections) {
    hash.update(`${section}\n`);
    for (const row of db.prepare(sql).iterate()) hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest('hex');
}
function resolveEdge(catalog: ReferenceCatalog, edge: Edge) {
  return resolveRelationship(catalog, { rawTarget: edge.target,
    context: { origin: 'field', field: edge.rel_type, requiredType: edge.required_type } }, 2);
}
function previewSnapshot(db: Database.Database, catalog: ReferenceCatalog): ReferenceActivationPreview {
  const from_policy = readReferencePolicyVersion(db);
  const counts: ReferenceActivationCounts = { scanned: 0, unchanged: 0, changed: 0, newly_resolved: 0, newly_unresolved: 0, redirected: 0 };
  const changes: ReferenceActivationChange[] = [];
  let detailBytes = 2; // JSON array brackets, including commas below.
  for (const edge of db.prepare(EDGE_SQL).iterate() as IterableIterator<Edge>) {
    const result = resolveEdge(catalog, edge);
    const after_id = result.status === 'resolved' ? result.targetId : null;
    counts.scanned++;
    if (after_id === edge.resolved_target_id) { counts.unchanged++; continue; }
    counts.changed++;
    if (edge.resolved_target_id === null) counts.newly_resolved++;
    else if (after_id === null) counts.newly_unresolved++;
    else counts.redirected++;
    const change: ReferenceActivationChange = {
      source_id: edge.source_id, field: edge.rel_type, raw_target: edge.target,
      before_id: edge.resolved_target_id, after_id,
      reason: result.status === 'resolved' ? 'resolved' : result.reason,
    };
    const bytes = Buffer.byteLength(JSON.stringify(change), 'utf8') + (changes.length ? 1 : 0);
    if (changes.length < 50 && detailBytes + bytes <= 32 * 1024) {
      changes.push(change); detailBytes += bytes;
    }
  }
  return { format_version: 1, from_policy, to_policy: 2, fingerprint: fingerprint(db), counts, changes,
    truncated: counts.changed > changes.length, omitted_changes: counts.changed - changes.length };
}

export function previewReferenceActivation(db: Database.Database): ReferenceActivationPreview {
  if (db.inTransaction) throw new Error('Reference activation preview requires its own read transaction');
  return db.transaction(() => previewSnapshot(db, buildReferenceCatalog(db)))();
}

export function applyReferenceActivation(db: Database.Database, expectedFingerprint: string): ReferenceActivationReceipt {
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('Invalid preview fingerprint');
  if (db.inTransaction) throw new Error('Reference activation requires its own IMMEDIATE transaction');
  return db.transaction((): ReferenceActivationReceipt => {
    const catalog = buildReferenceCatalog(db);
    const preview = previewSnapshot(db, catalog);
    if (preview.fingerprint !== expectedFingerprint) throw new Error('Stale reference activation preview; request a fresh preview');
    const noop = preview.from_policy === 2 && preview.counts.changed === 0;
    if (!noop) {
      const update = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
      // better-sqlite3 forbids writes while an iterator is active. Keyset batches
      // bound edge memory without depending on mutable bindings or physical IDs.
      let cursor: [string, string, string] | undefined;
      for (;;) {
        const edges = (cursor
          ? db.prepare(`${EDGE_SELECT} AND (source_id, rel_type, target) > (?, ?, ?) ORDER BY source_id, rel_type, target LIMIT 500`).all(...cursor)
          : db.prepare(`${EDGE_SQL} LIMIT 500`).all()) as Edge[];
        if (edges.length === 0) break;
        for (const edge of edges) {
          const result = resolveEdge(catalog, edge);
          const target = result.status === 'resolved' ? result.targetId : null;
          if (target !== edge.resolved_target_id) update.run(target, edge.id);
        }
        const last = edges[edges.length - 1];
        cursor = [last.source_id, last.rel_type, last.target];
      }
      db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(REFERENCE_POLICY_VERSION_KEY, '2');
    }
    // Verify actual stored bindings before committing, including already-v2 calls.
    const verified = previewSnapshot(db, catalog);
    if (verified.from_policy !== 2 || verified.counts.changed !== 0 || verified.counts.scanned !== preview.counts.scanned) {
      throw new Error('Reference activation verification failed');
    }
    return { format_version: 1, fingerprint: preview.fingerprint, from_policy: preview.from_policy,
      to_policy: 2, counts: preview.counts, noop };
  }).immediate();
}
