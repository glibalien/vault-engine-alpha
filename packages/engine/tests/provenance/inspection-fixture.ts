import type Database from 'better-sqlite3';
import type { SourceKey } from '../../src/provenance/types.js';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../helpers/db.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import { observeNode } from '../../src/provenance/observations.js';
import { canonicalJson, digestJson } from '../../src/provenance/canonical.js';
import type {
  Contribution,
  PreparedReceipt,
} from '../../src/provenance/types.js';
import { bundleFixture } from './fixture.js';

export function inspectionFixture(bundle = bundleFixture('aé😀z')): {
  db: Database.Database;
  service: ProvenanceService;
  prepared: PreparedReceipt;
  inputId: string;
  source: SourceKey;
} {
  const db = createTestDb();
  db.prepare(
    "INSERT INTO nodes(id,file_path,body,content_hash) VALUES ('source','Source.md','PRIVATE SOURCE','one'),('home','Home.md','<!-- ve:managed:Now -->\nGenerated\n<!-- /ve:managed:Now -->','home')",
  ).run();
  const service = new ProvenanceService(db);
  bundle.items[0]!.observation = observeNode(db, 'source');
  bundle.items[0]!.origin = 'identified';
  const request = {
    attempt_key: randomUUID(),
    run_ref: randomUUID(),
    project_id: 'source',
    bundle,
    dry_run: false,
  };
  const prepared = service.prepare(request) as PreparedReceipt;
  const contribution: Contribution = [
    { name: 'Now', mode: 'replace', content: 'Generated' },
  ];
  db.transaction(() => {
    service.store.putPayload(
      prepared.derivation_id,
      'contribution',
      canonicalJson(contribution),
    );
    db.prepare(
      `INSERT INTO provenance_outputs(id,derivation_id,node_id,node_version,committed_at,operation_id,reconcile_key,request_digest,contribution_digest)
      VALUES ('output',?,'home',1,'2026-09-17T00:00:00Z','operation','reconcile','request',?)`,
    ).run(prepared.derivation_id, digestJson(contribution));
    db.prepare(
      "UPDATE provenance_derivations SET state='committed',reserved_remaining_bytes=0 WHERE id=?",
    ).run(prepared.derivation_id);
  })();
  const inputId = (
    db
      .prepare('SELECT id FROM provenance_inputs WHERE derivation_id=?')
      .get(prepared.derivation_id) as { id: string }
  ).id;
  return {
    db,
    service,
    prepared,
    inputId,
    source: bundle.items[0]!.observation!.source,
  };
}
