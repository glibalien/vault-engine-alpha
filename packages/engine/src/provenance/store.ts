import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { digestText } from './canonical.js';
import { producerForFlow } from './flow.js';
import { ProvenanceError, type ProvenanceLimits } from './limits.js';
import type { PreparedReceipt, ProvenanceFlow, SourceKey } from './types.js';

export interface DerivationRow {
  id: string; producer: string; attempt_key: string; run_ref: string; project_id: string;
  bundle_digest: string | null; state: PreparedReceipt['state']; availability: PreparedReceipt['availability'];
  created_at: string; lease_expires_at: string; sent_at: string | null; terminal_at: string | null;
  committed_at: string | null; predecessor_id: string | null; payload_bytes: number;
  reserved_remaining_bytes: number; reserved_limit: number; request_digest: string | null; reconcile_key: string | null;
}
export type PayloadKind = 'request' | 'attribution' | 'staged_result' | 'contribution';

/** Internal persistence seam. Every mutation joins an owning domain transaction. */
export class ProvenanceStore {
  constructor(readonly db: Database.Database, readonly now: () => Date = () => new Date(), readonly newId: () => string = randomUUID) {}

  requireTransaction(): void { if (!this.db.inTransaction) throw new Error('Provenance write requires a transaction'); }
  namespace(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='provenance_vault_namespace'").get() as { value: string } | undefined;
    if (!row) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
    return row.value;
  }
  get(id: string): DerivationRow | undefined {
    return this.db.prepare('SELECT * FROM provenance_derivations WHERE id=?').get(id) as DerivationRow | undefined;
  }
  byAttempt(key: string, flow: ProvenanceFlow = 'project-home-v1'): DerivationRow | undefined {
    return this.db.prepare('SELECT * FROM provenance_derivations WHERE producer=? AND attempt_key=?').get(producerForFlow(flow), key) as DerivationRow | undefined;
  }
  usedBytes(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(payload_bytes + reserved_remaining_bytes),0) AS total FROM provenance_derivations').get() as { total: number }).total;
  }
  ensureSource(source: SourceKey): string {
    this.requireTransaction();
    const existing = this.db.prepare('SELECT id FROM provenance_sources WHERE namespace=? AND kind=? AND native_id=?').get(source.namespace, source.kind, source.native_id) as { id: string } | undefined;
    if (existing) return existing.id;
    const live = source.kind === 'node' && source.namespace === this.namespace()
      && this.db.prepare('SELECT id FROM nodes WHERE id=?').get(source.native_id) ? source.native_id : null;
    const id = this.newId();
    this.db.prepare('INSERT INTO provenance_sources(id,namespace,kind,native_id,live_node_id) VALUES (?,?,?,?,?)').run(id, source.namespace, source.kind, source.native_id, live);
    return id;
  }
  reserve(input: { attempt_key: string; run_ref: string; project_id: string; bundle_digest: string; predecessor_id?: string; flow?: ProvenanceFlow }, limits: ProvenanceLimits): DerivationRow {
    this.requireTransaction();
    if (this.usedBytes() + limits.totalBytes > limits.capacityBytes) throw new ProvenanceError('PROVENANCE_CAPACITY');
    const id = this.newId(); const now = this.now();
    this.db.prepare(`INSERT INTO provenance_derivations
      (id,producer,attempt_key,run_ref,project_id,bundle_digest,state,availability,created_at,lease_expires_at,predecessor_id,payload_bytes,reserved_remaining_bytes,reserved_limit)
      VALUES (?, ?,?,?,?,?,'prepared','retained',?,?,?,0,?,?)`).run(
      id, producerForFlow(input.flow ?? 'project-home-v1'), input.attempt_key, input.run_ref, input.project_id, input.bundle_digest,
      now.toISOString(), new Date(now.getTime() + limits.leaseHours * 3_600_000).toISOString(),
      input.predecessor_id ?? null, limits.totalBytes, limits.totalBytes,
    );
    return this.get(id)!;
  }
  payload(id: string, kind: PayloadKind): string | null {
    return (this.db.prepare('SELECT text FROM provenance_payloads WHERE derivation_id=? AND kind=?').get(id, kind) as { text: string } | undefined)?.text ?? null;
  }
  putPayload(id: string, kind: PayloadKind, text: string): void {
    this.requireTransaction();
    const row = this.get(id);
    if (!row || row.availability !== 'retained') throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
    const existing = this.payload(id, kind);
    if (existing !== null) {
      if (existing !== text) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
      return;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    // New payloads require reserved space; terminal rows cannot grow opportunistically.
    if (bytes > row.reserved_remaining_bytes) throw new ProvenanceError('PROVENANCE_LIMIT');
    this.db.prepare('INSERT INTO provenance_payloads(id,derivation_id,kind,text,bytes,digest) VALUES (?,?,?,?,?,?)').run(this.newId(), id, kind, text, bytes, digestText(text));
    this.db.prepare('UPDATE provenance_derivations SET payload_bytes=payload_bytes+?,reserved_remaining_bytes=reserved_remaining_bytes-? WHERE id=?').run(bytes, bytes, id);
  }
  releaseReservation(id: string): void {
    this.requireTransaction();
    this.db.prepare('UPDATE provenance_derivations SET reserved_remaining_bytes=0 WHERE id=?').run(id);
  }
}
