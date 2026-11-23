/** Synthetic, disposable local benchmark; no provider calls or production paths.
 * Measures the provenance commit phase, excluding wiki/filesystem reconciliation.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createTestDb } from '../packages/engine/tests/helpers/db.js';
import { bundleFixture } from '../packages/engine/tests/provenance/fixture.js';
import { ProvenanceService } from '../packages/engine/src/provenance/service.js';
import { observeNode } from '../packages/engine/src/provenance/observations.js';
import { inputDigest } from '../packages/engine/src/provenance/validation.js';
import { canonicalJson } from '../packages/engine/src/provenance/canonical.js';
import { bindCommittedHome } from '../packages/engine/src/provenance/output-binding.js';
import { findAffectedOutputs } from '../packages/engine/src/provenance/impact.js';
import type { PreparedReceipt, StageRequest, Json } from '../packages/engine/src/provenance/types.js';
import type { ResolvedWikiReconcilePlan } from '../packages/engine/src/wiki/reconcile-types.js';
import type { WikiReconcileResult } from '../packages/engine/src/wiki/reconcile.js';

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median_ms: +sorted[Math.floor(sorted.length / 2)]!.toFixed(3), p95_ms: +sorted[Math.ceil(sorted.length * .95) - 1]!.toFixed(3) };
}
for (const target of [100 * 1024, 2 * 1024 * 1024]) {
  const directory = mkdtempSync(join(tmpdir(), 'provenance-capacity-')); const path = join(directory, 'synthetic.db');
  const seed = createTestDb();
  seed.prepare("INSERT INTO nodes(id,file_path,body,content_hash) VALUES ('source','Source.md','Synthetic','h'),('home','Home.md','<!-- ve:managed:Now -->\nSummary\n<!-- /ve:managed:Now -->','home')").run();
  await seed.backup(path); seed.close();
  const db = new Database(path); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
  const baselineBytes = statSync(path).size;
  const service = new ProvenanceService(db);
  const prepare: number[] = []; const stage: number[] = []; const commit: number[] = [];
  try {
    for (let count = 1; count <= 100; count++) {
      const bundle = bundleFixture('x'.repeat(target === 102400 ? 30000 : 650000));
      const observation = observeNode(db, 'source'); const bytes = Buffer.byteLength(bundle.decoded_fields.evidence!);
      bundle.items = [];
      for (let start = 0; start < bytes; start += 250000) {
        const end = Math.min(bytes, start + 250000); const spans = [{ field: 'evidence', start, end }];
        bundle.items.push({ key: String(start), observation, role: 'source_material', upstream_derivation_id: null,
          selection: 'synthetic:v1', spans, original_bytes: bytes, retained_bytes: end - start,
          input_digest: inputDigest(spans, bundle.decoded_fields), truncated: bytes > end - start, origin: 'identified' });
      }
      let at = performance.now();
      const receipt = service.prepare({ attempt_key: randomUUID(), run_ref: randomUUID(), project_id: 'source', bundle, dry_run: false }) as PreparedReceipt;
      prepare.push(performance.now() - at);
      const staged: StageRequest = { derivation_id: receipt.derivation_id, bundle_digest: receipt.bundle_digest!, validated_sections: { now: '' },
        contribution: [{ name: 'Now', mode: 'replace', content: 'Summary' }], generated_at: '2026-09-17T00:00:00Z', log_stamp: '2026-09-17' };
      const result = { home: { node_id: 'home', version: 1 }, operation_id: 'operation' } as WikiReconcileResult;
      const overhead = service.store.get(receipt.derivation_id)!.payload_bytes + Buffer.byteLength(canonicalJson(staged as unknown as Json))
        + Buffer.byteLength(canonicalJson(staged.contribution)) + Buffer.byteLength(canonicalJson(result as unknown as Json));
      if (overhead > target) throw new Error('Synthetic fixture exceeds target');
      staged.validated_sections.now = 'y'.repeat(target - overhead);
      at = performance.now(); const binding = service.stage(staged); stage.push(performance.now() - at);
      const plan = { project: { id: 'source' }, home: { provenance: binding, sections: staged.contribution },
        reconcile_key: `wiki-reconcile:provenance-v1:${receipt.derivation_id}`, provenance_request_digest: 'synthetic' } as unknown as ResolvedWikiReconcilePlan;
      at = performance.now(); db.transaction(() => bindCommittedHome(db, plan, result)).immediate(); commit.push(performance.now() - at);
      if (![1, 20, 100].includes(count)) continue;
      db.prepare("UPDATE nodes SET version=2 WHERE id='source'").run();
      const impacts: number[] = [];
      for (let sample = 0; sample < 20; sample++) { at = performance.now(); findAffectedOutputs(db, { sources: [observation.source], limit: 100 }); impacts.push(performance.now() - at); }
      db.prepare("UPDATE nodes SET version=1 WHERE id='source'").run();
      const logical = (db.prepare('SELECT SUM(payload_bytes) AS n FROM provenance_derivations').get() as { n: number }).n;
      if (logical !== target * count) throw new Error('Unexpected logical size');
      const wal = statSync(path + '-wal').size;
      db.pragma('wal_checkpoint(PASSIVE)');
      const indexBytes = (db.prepare("SELECT COALESCE(SUM(pgsize),0) AS n FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'provenance_%')").get() as { n: number }).n;
      console.log(JSON.stringify({ target_bytes: target, revisions: count, logical_bytes: logical, baseline_db_bytes: baselineBytes,
        db_bytes: statSync(path).size, index_bytes: indexBytes, wal_bytes_before_checkpoint: wal,
        prepare: distribution(prepare), stage: distribution(stage), commit: distribution(commit), impact: distribution(impacts) }));
    }
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT i.id,out.id FROM provenance_sources s
      JOIN provenance_observations obs ON obs.source_id=s.id JOIN provenance_inputs i ON i.observation_id=obs.id
      JOIN provenance_outputs out ON out.derivation_id=i.derivation_id WHERE s.namespace=? AND s.kind=? AND s.native_id=?
      ORDER BY out.committed_at,out.id,i.id LIMIT 1001`).all(service.store.namespace(), 'node', 'source');
    console.log(JSON.stringify({ query_plan: plan }));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}
