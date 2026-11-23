import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import { observeNode } from '../../src/provenance/observations.js';
import { previewProvenancePurge, commitProvenancePurge } from '../../src/provenance/purge.js';
import { runProvenanceRetention } from '../../src/provenance/retention.js';
import { inspectProvenance } from '../../src/provenance/inspect.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../../src/provenance/limits.js';
import type { PreparedReceipt } from '../../src/provenance/types.js';
import { bundleFixture } from './fixture.js';
import { textHashOf } from '../../src/notes/text-hash.js';

const dbs: ReturnType<typeof createTestDb>[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() {
  const db = createTestDb(); dbs.push(db);
  db.prepare("INSERT INTO nodes(id,file_path,title,body,content_hash) VALUES ('source','PRIVATE LABEL.md','PRIVATE LABEL','Current published text','sourcehash')").run();
  let date = new Date('2026-09-17T00:00:00Z');
  const service = new ProvenanceService(db, () => DEFAULT_PROVENANCE_LIMITS, () => date);
  const bundle = bundleFixture('PRIVATE CAPTURE');
  bundle.items[0]!.observation = observeNode(db, 'source'); bundle.items[0]!.origin = 'identified';
  const request = { attempt_key: randomUUID(), run_ref: randomUUID(), project_id: 'source', bundle, dry_run: false };
  const prepared = service.prepare(request) as PreparedReceipt;
  const source = db.prepare('SELECT id FROM provenance_sources').get() as { id: string };
  return { db, service, request, prepared, source, date, advance: (days: number) => { date = new Date(date.getTime() + days * 86400000); return date; } };
}
describe('explicit composite purge and retention', () => {
  it('previews and clears the whole composite bundle, without touching published notes', () => {
    const f = fixture(); const scope = { source_ids: [f.source.id] };
    const preview = previewProvenancePurge(f.db, scope);
    expect(preview.derivation_ids).toEqual([f.prepared.derivation_id]);
    expect(preview.composite_loss).toBe(true);
    expect(f.service.store.usedBytes()).toBeGreaterThan(0);
    // The capture keeps the note's text hash until it is erased (#332).
    expect(f.db.prepare('SELECT text_hash FROM provenance_observations').all()).toEqual([{ text_hash: textHashOf(f.db, 'source') }]);
    const receipt = commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true });
    expect(receipt.derivation_ids).toEqual(preview.derivation_ids);
    expect(f.db.prepare('SELECT text_hash FROM provenance_observations').all()).toEqual([{ text_hash: null }]);
    expect(f.service.store.usedBytes()).toBe(0);
    expect(f.service.prepare(f.request)).toMatchObject({ availability: 'purged', bundle_digest: null });
    for (const table of ['provenance_payloads', 'provenance_observations', 'provenance_inputs', 'provenance_derivations', 'provenance_purge_receipts']) {
      const text = JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all());
      expect(text).not.toContain('PRIVATE'); expect(text).not.toContain('sourcehash');
    }
    expect(f.db.prepare("SELECT body FROM nodes WHERE id='source'").get()).toEqual({ body: 'Current published text' });
    expect(inspectProvenance(f.db, { select: 'status' })).toMatchObject({ purge_restore_verification: 'unverified' });
  });
  it('rejects stale scope when another dependent capture appears', () => {
    const f = fixture(); const scope = { source_ids: [f.source.id] };
    const preview = previewProvenancePurge(f.db, scope);
    f.service.prepare({ ...f.request, attempt_key: randomUUID() });
    expect(() => commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true })).toThrow('PURGE_SCOPE_CHANGED');
    expect(f.service.store.usedBytes()).toBeGreaterThan(0);
  });
  it('abandons at lease expiry and expires failed payloads only after seven terminal days', () => {
    const f = fixture();
    runProvenanceRetention(f.db, DEFAULT_PROVENANCE_LIMITS, f.advance(1));
    expect(f.service.lookupAttempt(f.request.attempt_key)).toMatchObject({ state: 'abandoned', availability: 'retained' });
    runProvenanceRetention(f.db, DEFAULT_PROVENANCE_LIMITS, f.advance(6));
    expect(f.service.lookupAttempt(f.request.attempt_key)?.availability).toBe('retained');
    runProvenanceRetention(f.db, DEFAULT_PROVENANCE_LIMITS, f.advance(1));
    expect(f.service.lookupAttempt(f.request.attempt_key)?.availability).toBe('expired');
    expect(f.db.prepare('SELECT text_hash FROM provenance_observations').all()).toEqual([{ text_hash: null }]);
    expect(f.service.store.usedBytes()).toBe(0);
    expect(f.service.prepare(f.request)).toMatchObject({ availability: 'expired' });
  });
  it('requires another preview to purge more than 100 dependent bundles', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.service.prepare({ ...f.request, attempt_key: randomUUID() });
    const scope = { source_ids: [f.source.id] }; const preview = previewProvenancePurge(f.db, scope);
    expect(preview.truncated).toBe(true); expect(preview.derivation_ids).toHaveLength(100);
    const receipt = commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true });
    expect(commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true })).toEqual(receipt);
    expect(previewProvenancePurge(f.db, scope).derivation_ids).toHaveLength(1);
  });
  it('reports an older restored backup as unverified and accepts replay of opaque purge scope', async () => {
    const f = fixture(); const dir = mkdtempSync(join(tmpdir(), 'provenance-restore-'));
    try {
      const path = join(dir, 'backup.db'); await f.db.backup(path);
      const scope = { derivation_ids: [f.prepared.derivation_id] }; const preview = previewProvenancePurge(f.db, scope);
      const receipt = commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true });
      const restored = new Database(path);
      try {
        expect(inspectProvenance(restored, { select: 'status' })).toMatchObject({ purge_restore_verification: 'unverified' });
        expect(new ProvenanceService(restored).lookupAttempt(f.request.attempt_key)?.availability).toBe('retained');
        const restoredScope = { derivation_ids: receipt.derivation_ids };
        const fresh = previewProvenancePurge(restored, restoredScope);
        commitProvenancePurge(restored, { scope: restoredScope, scope_token: fresh.scope_token, confirm: true });
        expect(new ProvenanceService(restored).lookupAttempt(f.request.attempt_key)?.availability).toBe('purged');
      } finally { restored.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('never automatically expires committed captures', () => {
    const f = fixture();
    f.db.prepare("UPDATE provenance_derivations SET state='committed',reserved_remaining_bytes=0 WHERE id=?").run(f.prepared.derivation_id);
    runProvenanceRetention(f.db, DEFAULT_PROVENANCE_LIMITS, f.advance(1000));
    expect(f.service.lookupAttempt(f.request.attempt_key)?.availability).toBe('retained');
    expect(f.service.store.usedBytes()).toBeGreaterThan(0);
  });
});
