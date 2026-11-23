import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidateBatchReplay } from './batch-binding.js';
import { digestJson, digestText } from './canonical.js';
import { ProvenanceError } from './limits.js';
import type { Json, PurgePreview, PurgeReceipt, PurgeScope } from './types.js';

export const purgeScopeSchema = z.union([
  z.object({ source_ids: z.array(z.string().uuid()).min(1).max(50) }).strict(),
  z.object({ derivation_ids: z.array(z.string().uuid()).min(1).max(100) }).strict(),
]);
export const purgeSchema = z.object({ scope: purgeScopeSchema, dry_run: z.boolean().default(true),
  scope_token: z.string().max(128).optional(), confirm: z.boolean().optional() }).strict();

/** Logical erasure of a complete composite bundle; no node/filesystem changes. */
export function clearDerivation(db: Database.Database, id: string, availability: 'expired' | 'purged', at: string): void {
  if (!db.inTransaction) throw new Error('Provenance erasure requires a transaction');
  const output = db.prepare('SELECT reconcile_key FROM provenance_outputs WHERE derivation_id=?').get(id) as { reconcile_key: string } | undefined;
  if (output) invalidateBatchReplay(db, output.reconcile_key);
  db.prepare('UPDATE provenance_payloads SET text=NULL,digest=NULL,bytes=0 WHERE derivation_id=?').run(id);
  db.prepare(`UPDATE provenance_observations SET native_version=NULL,content_hash=NULL,observation_digest=NULL,
    hash_semantics=NULL,projection=NULL,label=NULL,path=NULL,expected_post_commit_observation=NULL,text_hash=NULL WHERE derivation_id=?`).run(id);
  db.prepare(`UPDATE provenance_inputs SET item_key=NULL,selection=NULL,spans=NULL,upstream_derivation_id=NULL,
    original_bytes=NULL,retained_bytes=NULL,input_digest=NULL,truncated=NULL WHERE derivation_id=?`).run(id);
  db.prepare(`UPDATE provenance_outputs SET request_digest=NULL,contribution_digest=NULL,post_commit_observation=NULL,replay_result=NULL
    WHERE derivation_id=?`).run(id);
  db.prepare(`UPDATE provenance_derivations SET availability=?,bundle_digest=NULL,request_digest=NULL,omissions_json=NULL,payload_bytes=0,reserved_remaining_bytes=0,
    state=CASE WHEN state IN ('prepared','result_staged') THEN 'abandoned' ELSE state END,
    terminal_at=COALESCE(terminal_at,?) WHERE id=?`).run(availability, at, id);
  // Engine node/memory native IDs are opaque identifiers. Caller component keys
  // can contain labels; discard those once no retained capture needs their identity.
  db.prepare(`UPDATE provenance_sources SET namespace='purged',native_id=id
    WHERE kind NOT IN ('node','memory') AND id IN (SELECT source_id FROM provenance_observations WHERE derivation_id=?)
    AND NOT EXISTS (SELECT 1 FROM provenance_observations o JOIN provenance_derivations d ON d.id=o.derivation_id
      WHERE o.source_id=provenance_sources.id AND d.availability='retained')`).run(id);
}

function preview(db: Database.Database, scope: PurgeScope): PurgePreview {
  if (!purgeScopeSchema.safeParse(scope).success) throw new ProvenanceError('PROVENANCE_LIMIT');
  const sourceIds = 'source_ids' in scope ? [...new Set(scope.source_ids)].sort() : [];
  const ids = 'derivation_ids' in scope ? [...new Set(scope.derivation_ids)].sort() : sourceIds;
  const where = sourceIds.length > 0
    ? `d.id IN (SELECT o.derivation_id FROM provenance_observations o WHERE o.source_id IN (${ids.map(() => '?').join(',')}))`
    : `d.id IN (${ids.map(() => '?').join(',')})`;
  const filter = `FROM provenance_derivations d WHERE ${where} AND d.availability<>'purged'`;
  const rows = db.prepare(`SELECT d.id,d.state,d.availability,d.payload_bytes,d.bundle_digest,d.request_digest,d.sent_at,d.lease_expires_at ${filter} ORDER BY d.id LIMIT 101`).all(...ids) as Array<{ id: string; payload_bytes: number }>;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${filter}`).get(...ids) as { n: number }).n;
  const selected = rows.slice(0, 100);
  // A selected sibling invalidates its home anchor replay, but not the anchor's
  // independent request/input payloads. Include this extra erasure in confirmation.
  const selectedIds = new Set(selected.map(row => row.id));
  const anchors = selected.length ? db.prepare(`SELECT o.id,o.derivation_id,o.replay_result
    FROM provenance_outputs o WHERE o.replay_result IS NOT NULL AND o.reconcile_key IN
      (SELECT reconcile_key FROM provenance_outputs WHERE derivation_id IN (${selected.map(() => '?').join(',')}))
    ORDER BY o.id`).all(...selectedIds) as Array<{ id: string; derivation_id: string; replay_result: string }> : [];
  const replayEffects = anchors.map(row => ({ id: row.id, derivation_id: row.derivation_id,
    bytes: Buffer.byteLength(row.replay_result, 'utf8'), digest: digestText(row.replay_result) }));
  const siblingBytes = replayEffects.reduce((sum, row) => sum + (selectedIds.has(row.derivation_id) ? 0 : row.bytes), 0);
  return { dry_run: true, scope_token: digestJson({ scope: 'source_ids' in scope ? { source_ids: sourceIds } : { derivation_ids: ids }, total, rows: selected, replayEffects } as unknown as Json),
    derivation_ids: selected.map(r => r.id), source_ids: sourceIds, payload_bytes: selected.reduce((n, r) => n + r.payload_bytes, siblingBytes),
    truncated: total > 100, composite_loss: true };
}
export function previewProvenancePurge(db: Database.Database, scope: PurgeScope): PurgePreview {
  return db.transaction(() => preview(db, scope)).deferred();
}

export function commitProvenancePurge(db: Database.Database, request: { scope: PurgeScope; scope_token: string; confirm: true }, now = new Date()): PurgeReceipt {
  if (request.confirm !== true) throw new ProvenanceError('PROVENANCE_LIMIT');
  return db.transaction(() => {
    // A lost reply can retry an already recorded confirmation without erasing new captures.
    const previous = db.prepare('SELECT * FROM provenance_purge_receipts WHERE scope_token=?').get(request.scope_token) as
      (Omit<PurgeReceipt, 'source_ids' | 'derivation_ids'> & { source_ids: string; derivation_ids: string }) | undefined;
    if (previous) return { ...previous, source_ids: JSON.parse(previous.source_ids), derivation_ids: JSON.parse(previous.derivation_ids) };
    const current = preview(db, request.scope);
    if (current.scope_token !== request.scope_token) throw new ProvenanceError('PURGE_SCOPE_CHANGED');
    const at = now.toISOString();
    for (const id of current.derivation_ids) clearDerivation(db, id, 'purged', at);
    const receipt: PurgeReceipt = { id: randomUUID(), scope_token: request.scope_token, committed_at: at, source_ids: current.source_ids, derivation_ids: current.derivation_ids };
    db.prepare('INSERT INTO provenance_purge_receipts(id,scope_token,committed_at,source_ids,derivation_ids) VALUES (?,?,?,?,?)').run(receipt.id, receipt.scope_token, at, JSON.stringify(receipt.source_ids), JSON.stringify(receipt.derivation_ids));
    return receipt;
  }).immediate();
}
