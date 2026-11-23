import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { activeCorrections } from './control.js';
import { jsonDigest, type CorrectionInput } from '../provenance-evidence.js';

export function createProvenanceIdentity(db: Database.Database): void {
  db.exec('CREATE TABLE provenance_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),namespace TEXT NOT NULL)');
  db.prepare('INSERT INTO provenance_identity(singleton,namespace) VALUES (1,?)').run(randomUUID());
}

export function correctionInputs(db: Database.Database, projectTitle: string): CorrectionInput[] {
  return db.transaction(() => {
    const identity = db.prepare('SELECT namespace FROM provenance_identity WHERE singleton=1').get() as { namespace: string } | undefined;
    if (!identity) throw new Error('PROVENANCE_CORRECTION_IDENTITY_UNAVAILABLE');
    const at = new Date().toISOString();
    return activeCorrections(db, projectTitle).map(row => {
      const digest = jsonDigest({ id: row.id, note: row.note, status: row.status, created_at: row.created_at, resolved_at: row.resolved_at });
      return { note: row.note, observation: {
        source: { kind: 'curator_correction' as const, namespace: identity.namespace, native_id: String(row.id) },
        authority: 'caller' as const, observed_at: at, native_version: null, content_hash: digest,
        hash_semantics: 'caller_content_v1' as const, observation_projection: 'caller-content-v1' as const,
        observation_digest: digest, label: null, path: null,
      } };
    });
  }).deferred();
}

export function runLocalCorrections(notes: readonly string[], runRef: string): CorrectionInput[] {
  return notes.map((note, index) => {
    const digest = jsonDigest({ note });
    return { note, observation: { source: { kind: 'curator_correction', namespace: `run:${runRef}`, native_id: String(index) },
      authority: 'caller', observed_at: new Date().toISOString(), native_version: null, content_hash: digest,
      hash_semantics: 'caller_content_v1', observation_projection: 'caller-content-v1', observation_digest: digest, label: null, path: null } };
  });
}
