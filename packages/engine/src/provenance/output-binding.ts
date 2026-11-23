import type Database from 'better-sqlite3';
import { canonicalJson, digestJson } from './canonical.js';
import { ProvenanceError } from './limits.js';
import { observeNode } from './observations.js';
import { requireActive } from './service.js';
import { ProvenanceStore } from './store.js';
import type { Contribution, Json, OutputReceipt, ProvenanceFlow, StageRequest } from './types.js';
import type { ResolvedWikiReconcilePlan, WikiReconcileInput } from '../wiki/reconcile-types.js';
import type { WikiReconcileResult } from '../wiki/reconcile.js';
import { extractManagedSection } from '../wiki/sections.js';
import { assertWikiSectionStructure, WikiSectionError } from '../wiki/section-integrity.js';

export function reconcileRequestDigest(input: WikiReconcileInput): string {
  if (!input.project_id) throw new ProvenanceError('PROVENANCE_LIMIT');
  const { dry_run: _dryRun, ...request } = input;
  // Syntactically parsed wire input; omission and explicit empty values remain distinct.
  return digestJson(request as unknown as Json);
}

export function normalizeContribution(sections: readonly Contribution[number][], flow: ProvenanceFlow = 'project-home-v1'): Contribution {
  const names = new Set<string>();
  const allowed = flow === 'project-subpage-v1' ? ['Summary', 'Log'] : ['At a glance', 'Now', 'Focus', 'Open threads', 'Sources', 'Log'];
  if (flow === 'project-subpage-v1' && (sections.length < 1 || sections.length > 2
    || !sections.some(section => section.name === 'Summary'))) throw new ProvenanceError('PROVENANCE_LIMIT');
  return sections.map(section => {
    if (names.has(section.name) || !allowed.includes(section.name)
      || section.mode !== (section.name === 'Log' ? 'append' : 'replace')) throw new ProvenanceError('PROVENANCE_LIMIT');
    names.add(section.name);
    return { ...section, content: section.content.trim() };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function assertHomeBinding(db: Database.Database, plan: ResolvedWikiReconcilePlan): StageRequest | null {
  const binding = plan.home.provenance;
  if (!binding) return null;
  const store = new ProvenanceStore(db); const row = requireActive(store.get(binding.derivation_id), store.now());
  if (row.producer !== 'curator-home-v1' || row.state !== 'result_staged' || row.project_id !== plan.project.id
    || row.bundle_digest !== binding.bundle_digest || plan.reconcile_key !== `wiki-reconcile:provenance-v1:${row.id}`) {
    throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  }
  const stagedText = store.payload(row.id, 'staged_result');
  if (!stagedText) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  const staged = JSON.parse(stagedText) as StageRequest;
  if (binding.contribution_digest !== digestJson(staged.contribution)
    || canonicalJson(normalizeContribution(staged.contribution)) !== canonicalJson(normalizeContribution(plan.home.sections))) {
    throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  }
  return staged;
}

export type OutputCurrentness = 'matches' | 'changed' | 'missing' | 'unknown';
export function outputCurrentness(db: Database.Database, nodeId: string, contribution: Contribution | null): OutputCurrentness {
  const node = db.prepare('SELECT body FROM nodes WHERE id=?').get(nodeId) as { body: string | null } | undefined;
  if (!node) return 'missing';
  if (!contribution) return 'unknown';
  try { assertWikiSectionStructure(node.body ?? ''); }
  catch (error) {
    if (error instanceof WikiSectionError) return 'unknown';
    throw error;
  }
  let ambiguous = false;
  for (const section of contribution) {
    const text = extractManagedSection(node.body ?? '', section.name, Number.MAX_SAFE_INTEGER);
    if (text === undefined) return 'changed';
    if (section.mode === 'replace') { if (text !== section.content.trim()) return 'changed'; }
    else {
      const expected = section.content.trim();
      if (!expected) { ambiguous = true; continue; }
      let matches = 0; let from = 0;
      for (;;) {
        const offset = text.indexOf(expected, from);
        if (offset < 0) break;
        const end = offset + expected.length;
        if ((offset === 0 || text.slice(offset - 2, offset) === '\n\n')
          && (end === text.length || text.slice(end, end + 2) === '\n\n')) matches++;
        from = offset + 1;
      }
      if (matches === 0) return 'changed';
      if (matches > 1) ambiguous = true;
    }
  }
  return ambiguous ? 'unknown' : 'matches';
}

export function findCommittedReplay(db: Database.Database, input: WikiReconcileInput): WikiReconcileResult | null {
  const pageOperation = input.page_refresh ? input.pages[0] : undefined;
  const primary = input.home.provenance ?? (pageOperation && pageOperation.op !== 'retire' ? pageOperation.provenance : undefined);
  if (!primary) return null;
  const store = new ProvenanceStore(db); const row = store.get(primary.derivation_id);
  if (row?.availability === 'purged') throw new ProvenanceError('PROVENANCE_REVOKED');
  if (!row || row.state !== 'committed') return null;
  if (row.request_digest !== reconcileRequestDigest(input) || row.project_id !== input.project_id
    || row.reconcile_key !== input.reconcile_key) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  const output = db.prepare('SELECT * FROM provenance_outputs WHERE derivation_id=?').get(row.id) as OutputRow | undefined;
  if (!output?.replay_result) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  const stored = JSON.parse(output.replay_result) as WikiReconcileResult;
  if (stored.provenance_receipts) {
    const outputs = db.prepare('SELECT * FROM provenance_outputs WHERE reconcile_key=?').all(input.reconcile_key) as OutputRow[];
    const expected = [...(input.home.provenance ? [input.home.provenance.derivation_id] : []), ...input.pages.flatMap(page => page.op !== 'retire' && page.provenance ? [page.provenance.derivation_id] : [])];
    if (outputs.length !== expected.length || stored.provenance_receipts.length !== expected.length
      || new Set(expected).size !== expected.length) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
    const currentOutputs: Record<string, OutputCurrentness> = {};
    stored.provenance_receipts.forEach((receipt, index) => {
      const member = outputs.find(candidate => candidate.id === receipt.output_revision_id);
      const capture = store.get(receipt.derivation_id);
      if (capture?.availability === 'purged') throw new ProvenanceError('PROVENANCE_REVOKED');
      if (!member || !capture || capture.availability !== 'retained' || capture.state !== 'committed'
        || capture.producer !== (index === 0 && input.home.provenance ? 'curator-home-v1' : 'curator-subpage-v1')
        || capture.project_id !== input.project_id || capture.request_digest !== row.request_digest
        || capture.reconcile_key !== input.reconcile_key || receipt.derivation_id !== expected[index]
        || member.operation_id !== output.operation_id || member.request_digest !== row.request_digest
        || canonicalJson(outputReceipt(member) as unknown as Json) !== canonicalJson(receipt as unknown as Json)
        || !store.payload(capture.id, 'request') || !store.payload(capture.id, 'attribution') || !store.payload(capture.id, 'staged_result')) {
        throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
      }
      const text = store.payload(capture.id, 'contribution');
      if (!text) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
      currentOutputs[member.id] = outputCurrentness(db, member.node_id, JSON.parse(text) as Contribution);
    });
    return { ...stored, dry_run: input.dry_run ?? false, reused: true, current_outputs: currentOutputs,
      current_output: currentOutputs[output.id], provenance_receipt: outputReceipt(output) };
  }
  if (row.availability !== 'retained') throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  const contribution = store.payload(row.id, 'contribution');
  return {
    ...JSON.parse(output.replay_result) as WikiReconcileResult,
    dry_run: input.dry_run ?? false, reused: true, provenance_receipt: outputReceipt(output),
    current_output: outputCurrentness(db, output.node_id, contribution ? JSON.parse(contribution) as Contribution : null),
  };
}

interface OutputRow {
  replaces_output_revision_id?: string | null;
  id: string; derivation_id: string; node_id: string; node_version: number; committed_at: string;
  operation_id: string; reconcile_key: string; request_digest: string | null; replay_result: string | null;
}
export function outputReceipt(output: OutputRow): OutputReceipt {
  return { replaces_output_revision_id: output.replaces_output_revision_id ?? null, derivation_id: output.derivation_id, output_revision_id: output.id, output_node_id: output.node_id,
    committed_node_version: output.node_version, committed_at: output.committed_at, operation_id: output.operation_id,
    reconcile_key: output.reconcile_key, request_digest: output.request_digest };
}

/** Runs only inside wiki-reconcile's transaction, after its governed home mutation. */
export function bindCommittedHome(db: Database.Database, plan: ResolvedWikiReconcilePlan, result: WikiReconcileResult): OutputReceipt | null {
  const store = new ProvenanceStore(db); store.requireTransaction();
  const staged = assertHomeBinding(db, plan);
  if (!staged) return null;
  if (!result.home.node_id || result.home.version === null || !result.operation_id || !plan.provenance_request_digest) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  const contribution = normalizeContribution(staged.contribution);
  if (outputCurrentness(db, result.home.node_id, contribution) === 'changed') throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  const id = store.newId(); const at = store.now().toISOString();
  const row = store.get(staged.derivation_id)!;
  store.putPayload(row.id, 'contribution', canonicalJson(contribution));
  const replay = canonicalJson(result as unknown as Json);
  const bytes = Buffer.byteLength(replay);
  if (bytes > 64 * 1024 || bytes > store.get(row.id)!.reserved_remaining_bytes) throw new ProvenanceError('PROVENANCE_LIMIT');
  db.prepare(`INSERT INTO provenance_outputs(id,derivation_id,node_id,node_version,committed_at,operation_id,
    reconcile_key,request_digest,contribution_digest,post_commit_observation,replay_result) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, row.id, result.home.node_id, result.home.version, at, result.operation_id, plan.reconcile_key,
    plan.provenance_request_digest, digestJson(contribution), canonicalJson(observeNode(db, result.home.node_id, at) as unknown as Json), replay,
  );
  if (plan.home_refresh) db.prepare('UPDATE provenance_outputs SET replaces_output_revision_id=? WHERE id=?')
    .run(plan.home_refresh.expected_output_revision_id, id);
  db.prepare(`UPDATE provenance_derivations SET state='committed',committed_at=?,request_digest=?,reconcile_key=?,
    payload_bytes=payload_bytes+?,reserved_remaining_bytes=0 WHERE id=?`).run(at, plan.provenance_request_digest, plan.reconcile_key, bytes, row.id);
  db.prepare("INSERT OR IGNORE INTO provenance_flow_activations(project_id,flow,first_committed_at) VALUES (?,'project-home-v1',?)").run(plan.project.id, at);
  return { replaces_output_revision_id: plan.home_refresh?.expected_output_revision_id ?? null,
    derivation_id: row.id, output_revision_id: id, output_node_id: result.home.node_id,
    committed_node_version: result.home.version, committed_at: at, operation_id: result.operation_id,
    reconcile_key: plan.reconcile_key, request_digest: plan.provenance_request_digest };
}
