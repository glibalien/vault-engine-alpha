import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalJson, digestJson } from './canonical.js';
import { DEFAULT_PROVENANCE_LIMITS, ProvenanceError, type ProvenanceLimits } from './limits.js';
import { validateObservations } from './observations.js';
import { textHashOf } from '../notes/text-hash.js';
import { normalizeContribution } from './output-binding.js';
import { ProvenanceStore, type DerivationRow } from './store.js';
import { prepareSchema, stageSchema, validateBundle } from './validation.js';
import type { AttemptSummary, Json, PreparePreview, PrepareRequest, PreparedReceipt, ProvenanceBinding, ProvenanceFlow, StageRequest, TransitionRequest } from './types.js';

export const transitionSchema = z.object({
  derivation_id: z.string().uuid(), action: z.enum(['mark-sent', 'fail', 'abandon', 'renew']),
  expected_state: z.enum(['prepared', 'result_staged', 'failed', 'abandoned']),
}).strict();

export function receipt(row: DerivationRow): PreparedReceipt {
  return { derivation_id: row.id, bundle_digest: row.bundle_digest, state: row.state,
    availability: row.availability, lease_expires_at: row.lease_expires_at };
}

export function requireActive(row: DerivationRow | undefined, now: Date): DerivationRow {
  if (!row) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  if (row.availability === 'purged') throw new ProvenanceError('PROVENANCE_REVOKED');
  if (row.availability === 'expired' || row.lease_expires_at <= now.toISOString()) throw new ProvenanceError('PROVENANCE_LEASE_EXPIRED');
  if (row.state !== 'prepared' && row.state !== 'result_staged') throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  return row;
}

export class ProvenanceService {
  readonly store: ProvenanceStore;
  constructor(readonly db: Database.Database, readonly limits: () => ProvenanceLimits = () => DEFAULT_PROVENANCE_LIMITS, now: () => Date = () => new Date()) {
    this.store = new ProvenanceStore(db, now);
  }

  expireLeases(): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE provenance_derivations SET state='abandoned',terminal_at=lease_expires_at,reserved_remaining_bytes=0
        WHERE state IN ('prepared','result_staged') AND availability='retained' AND lease_expires_at <= ?`).run(this.store.now().toISOString());
    }).immediate();
  }

  lookupAttempt(key: string, flow: ProvenanceFlow = 'project-home-v1'): AttemptSummary | null {
    const row = this.store.byAttempt(key, flow);
    if (!row) return null;
    const output = this.db.prepare(`SELECT derivation_id,id AS output_revision_id,node_id AS output_node_id,
      node_version AS committed_node_version,committed_at,operation_id,reconcile_key,request_digest,replaces_output_revision_id
      FROM provenance_outputs WHERE derivation_id=?`).get(row.id) as AttemptSummary['output'] | undefined;
    return { ...receipt(row), output: output ?? null };
  }

  prepare(request: PrepareRequest): PreparedReceipt | PreparePreview {
    if (!prepareSchema.safeParse(request).success) throw new ProvenanceError('PROVENANCE_LIMIT');
    // Frozen retries are independent of subsequently lowered settings.
    const flow = request.flow ?? 'project-home-v1';
    const checked = validateBundle(request.bundle, DEFAULT_PROVENANCE_LIMITS, flow);
    if (!request.dry_run) this.expireLeases();
    const prepare = (): PreparedReceipt | PreparePreview => {
      const existing = this.store.byAttempt(request.attempt_key, flow);
      if (existing && !request.dry_run) {
        if (existing.availability !== 'retained') return receipt(existing);
        if (existing.bundle_digest !== checked.digest || existing.run_ref !== request.run_ref
          || existing.project_id !== request.project_id || existing.predecessor_id !== (request.predecessor_attempt_id ?? null)) {
          throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
        }
        return receipt(existing);
      }
      const limits = this.limits(); const validated = validateBundle(request.bundle, limits, flow);
      validateObservations(this.db, request.bundle.items.flatMap(item => item.observation ? [item.observation] : []));
      if (!this.db.prepare('SELECT id FROM nodes WHERE id=?').get(request.project_id)) throw new ProvenanceError('PROVENANCE_OBSERVATION_CHANGED');
      if (this.store.usedBytes() + limits.totalBytes > limits.capacityBytes) throw new ProvenanceError('PROVENANCE_CAPACITY');
      if (request.dry_run) return { dry_run: true, bundle_digest: checked.digest, payload_bytes: validated.payloadBytes, reserved_bytes: limits.totalBytes, item_count: request.bundle.items.length };
      if (request.predecessor_attempt_id && !this.store.get(request.predecessor_attempt_id)) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
      const row = this.store.reserve({ ...request, flow, bundle_digest: checked.digest, predecessor_id: request.predecessor_attempt_id }, limits);
      this.db.prepare('UPDATE provenance_derivations SET dependency_coverage=?,omissions_json=? WHERE id=?').run(request.bundle.dependency_coverage, JSON.stringify(request.bundle.omissions), row.id);
      const { provider_payload, ...attribution } = request.bundle;
      this.store.putPayload(row.id, 'request', canonicalJson(provider_payload));
      this.store.putPayload(row.id, 'attribution', canonicalJson(attribution as unknown as Json));
      for (const item of request.bundle.items) {
        let observationId: string | null = null;
        if (item.observation) {
          const o = item.observation; observationId = this.store.newId();
          const sourceId = this.store.ensureSource(o.source);
          // The observations were checked against the vault above, so the note's text hash now is its
          // text hash as observed (#332).
          const textHash = o.source.kind === 'node' && o.authority === 'engine' ? textHashOf(this.db, o.source.native_id) : null;
          this.db.prepare(`INSERT INTO provenance_observations(id,source_id,derivation_id,native_version,content_hash,
            hash_semantics,projection,observation_digest,observed_at,authority,label,path,text_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            observationId, sourceId, row.id, o.native_version, o.content_hash, o.hash_semantics,
            o.observation_projection, o.observation_digest, o.observed_at, o.authority, o.label, o.path, textHash,
          );
        }
        this.db.prepare(`INSERT INTO provenance_inputs(id,derivation_id,item_key,observation_id,role,selection,spans,coverage,
          upstream_derivation_id,original_bytes,retained_bytes,input_digest,truncated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          this.store.newId(), row.id, item.key, observationId, item.role, item.selection, canonicalJson(item.spans),
          item.origin, item.upstream_derivation_id, item.original_bytes, item.retained_bytes, item.input_digest, item.truncated ? 1 : 0,
        );
      }
      return receipt(this.store.get(row.id)!);
    };
    return request.dry_run ? this.db.transaction(prepare).deferred() : this.db.transaction(prepare).immediate();
  }

  stage(request: StageRequest): ProvenanceBinding {
    if (!stageSchema.safeParse(request).success) throw new ProvenanceError('PROVENANCE_LIMIT');
    this.expireLeases();
    return this.db.transaction(() => {
      const row = requireActive(this.store.get(request.derivation_id), this.store.now());
      if (row.bundle_digest !== request.bundle_digest) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
      const flow: ProvenanceFlow = row.producer === 'curator-subpage-v1' ? 'project-subpage-v1' : 'project-home-v1';
      const normalized = flow === 'project-subpage-v1' ? normalizeContribution(request.contribution, flow) : request.contribution;
      if (flow === 'project-subpage-v1') {
        const keys = Object.keys(request.validated_sections);
        const summary = normalized.find(section => section.name === 'Summary');
        const log = normalized.find(section => section.name === 'Log');
        if (!summary || keys.some(key => key !== 'body' && key !== 'log_note')
          || typeof request.validated_sections.body !== 'string'
          || summary.content !== request.validated_sections.body.trim()
          || (log?.content ?? null) !== (request.validated_sections.log_note?.trim() || null)) {
          throw new ProvenanceError('PROVENANCE_LIMIT');
        }
      }
      const staged = { ...request, contribution: normalized };
      const encoded = canonicalJson(staged as unknown as Json);
      const existing = this.store.payload(row.id, 'staged_result');
      const binding = { derivation_id: row.id, bundle_digest: request.bundle_digest, contribution_digest: digestJson(normalized) };
      if (existing !== null) {
        if (existing !== encoded) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
        return binding;
      }
      const contributionBytes = Buffer.byteLength(canonicalJson(normalized));
      if (contributionBytes > this.limits().outputBytes || Buffer.byteLength(encoded) + contributionBytes > row.reserved_remaining_bytes) {
        throw new ProvenanceError('PROVENANCE_LIMIT');
      }
      this.store.putPayload(row.id, 'staged_result', encoded);
      this.db.prepare("UPDATE provenance_derivations SET state='result_staged' WHERE id=?").run(row.id);
      return binding;
    }).immediate();
  }

  transition(request: TransitionRequest): PreparedReceipt {
    if (!transitionSchema.safeParse(request).success) throw new ProvenanceError('PROVENANCE_LIMIT');
    this.expireLeases();
    return this.db.transaction(() => {
      const row = this.store.get(request.derivation_id);
      if (!row) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
      if (row.availability !== 'retained') throw new ProvenanceError('PROVENANCE_REVOKED');
      const terminal = request.action === 'fail' ? 'failed' : request.action === 'abandon' ? 'abandoned' : null;
      if (terminal && row.state === terminal) return receipt(row);
      requireActive(row, this.store.now());
      if (row.state !== request.expected_state) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
      const at = this.store.now();
      if (terminal) {
        this.db.prepare('UPDATE provenance_derivations SET state=?,terminal_at=?,reserved_remaining_bytes=0 WHERE id=?').run(terminal, at.toISOString(), row.id);
      } else if (request.action === 'mark-sent') {
        this.db.prepare('UPDATE provenance_derivations SET sent_at=COALESCE(sent_at,?) WHERE id=?').run(at.toISOString(), row.id);
      } else {
        this.db.prepare('UPDATE provenance_derivations SET lease_expires_at=? WHERE id=?').run(new Date(at.getTime() + this.limits().leaseHours * 3_600_000).toISOString(), row.id);
      }
      return receipt(this.store.get(row.id)!);
    }).immediate();
  }
}
