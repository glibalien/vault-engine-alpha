import type Database from 'better-sqlite3';
import type { AppliedWikiReconcile } from '../wiki/reconcile-apply.js';
import type { ResolvedWikiReconcilePlan } from '../wiki/reconcile-types.js';
import type { WikiReconcileResult } from '../wiki/reconcile.js';
import { canonicalJson, digestJson } from './canonical.js';
import { producerForFlow } from './flow.js';
import { ProvenanceError } from './limits.js';
import { observeNode, validateObservations } from './observations.js';
import { assertHomeBinding, bindCommittedHome, normalizeContribution, outputCurrentness } from './output-binding.js';
import { requireActive } from './service.js';
import { ProvenanceStore } from './store.js';
import type { BundleV1, CaptureTarget, Json, OutputReceipt, StageRequest } from './types.js';

export type CapturedBatch = {
  /** Null for a page refresh, which publishes one page and no home. */
  home: StageRequest | null;
  pages: Array<{ operationIndex: number; target: CaptureTarget; staged: StageRequest }>;
};

/** Validate the complete frozen batch against the state before publication writes. */
export function assertBatchBindings(db: Database.Database, plan: ResolvedWikiReconcilePlan): CapturedBatch | null {
  return readBatch(db, plan, true);
}

function readBatch(db: Database.Database, plan: ResolvedWikiReconcilePlan, checkObservations: boolean): CapturedBatch | null {
  const hasPages = plan.pages.some(page => page.op !== 'retire' && page.provenance);
  if (!plan.home.provenance && !plan.page_refresh) {
    if (plan.provenance_mode || hasPages) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    return null;
  }
  const home = plan.page_refresh ? null : assertHomeBinding(db, plan)!;
  const store = new ProvenanceStore(db);
  const seenDerivations = new Set(home ? [home.derivation_id] : []);
  const seenTargets = new Set<string>();
  const readCapture = (id: string): Omit<BundleV1, 'provider_payload'> => {
    const text = store.payload(id, 'attribution');
    if (!text || !store.payload(id, 'request')) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
    const capture = JSON.parse(text) as Omit<BundleV1, 'provider_payload'>;
    if (checkObservations && (plan.provenance_mode || hasPages)) validateObservations(db, capture.items.flatMap(item => item.observation ? [item.observation] : []));
    return capture;
  };
  if (home) readCapture(home.derivation_id);
  const pages: CapturedBatch['pages'] = [];
  plan.pages.forEach((page, operationIndex) => {
    if (page.op === 'retire') return;
    const contentWriting = page.op === 'merge' || page.target.mode === 'new' || (page.sections?.length ?? 0) > 0;
    if (!page.provenance) {
      if (plan.provenance_mode && contentWriting) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
      return;
    }
    if (!contentWriting) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    const binding = page.provenance;
    const row = requireActive(store.get(binding.derivation_id), store.now());
    const target: CaptureTarget = page.target.mode === 'existing'
      ? { node_id: page.target.node_id } : { plan_key: page.target.plan_key };
    const targetKey = canonicalJson(target);
    if (seenDerivations.has(row.id) || seenTargets.has(targetKey)
      || row.producer !== producerForFlow('project-subpage-v1') || row.project_id !== plan.project.id
      || row.state !== 'result_staged' || row.bundle_digest !== binding.bundle_digest
      || (plan.page_refresh && plan.reconcile_key !== `wiki-reconcile:provenance-v1:${row.id}`)) {
      throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    }
    seenDerivations.add(row.id); seenTargets.add(targetKey);
    const capture = readCapture(row.id);
    if (!capture.target || canonicalJson(capture.target) !== targetKey) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    const text = store.payload(row.id, 'staged_result');
    if (!text) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
    const staged = JSON.parse(text) as StageRequest;
    if (staged.derivation_id !== row.id || staged.bundle_digest !== row.bundle_digest
      || binding.contribution_digest !== digestJson(staged.contribution)
      || canonicalJson(normalizeContribution(staged.contribution, 'project-subpage-v1'))
        !== canonicalJson(normalizeContribution(page.sections ?? [], 'project-subpage-v1'))) {
      throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    }
    pages.push({ operationIndex, target, staged });
  });
  return { home, pages };
}

/** Bind all final targets inside the existing publication transaction and rollback seam. */
export function bindCommittedBatch(db: Database.Database, plan: ResolvedWikiReconcilePlan, result: WikiReconcileResult,
  targets: AppliedWikiReconcile['resolvedPageTargets']): OutputReceipt[] {
  const store = new ProvenanceStore(db); store.requireTransaction();
  // Identity checks remain valid after writes; original input observations do not.
  const batch = readBatch(db, plan, false);
  if (!batch) return [];
  if (!plan.provenance_mode && batch.pages.length === 0) {
    const receipt = bindCommittedHome(db, plan, result);
    return receipt ? [receipt] : [];
  }
  if (!result.home.node_id || result.home.version === null || !result.operation_id || !plan.provenance_request_digest) {
    throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
  }
  const at = store.now().toISOString();
  const homeMember = batch.home ? [{ staged: batch.home, node_id: result.home.node_id, version: result.home.version,
    previousVersion: plan.home.expected_version, flow: 'project-home-v1' as const }] : [];
  const members = [...homeMember, ...batch.pages.map(page => {
    const target = targets.get(page.operationIndex);
    const operation = plan.pages[page.operationIndex]!;
    if (!target || operation.op === 'retire') throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
    if ('node_id' in page.target && page.target.node_id !== target.node_id) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    return { staged: page.staged, ...target, flow: 'project-subpage-v1' as const,
      previousVersion: operation.target.mode === 'existing' ? operation.target.expected_version : undefined };
  })];
  if (new Set(members.map(member => member.node_id)).size !== members.length) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  const receipts: OutputReceipt[] = members.map(member => {
    const predecessor = member.previousVersion === undefined ? undefined : db.prepare(`SELECT id,node_version FROM provenance_outputs
      WHERE node_id=? ORDER BY node_version DESC,committed_at DESC,id DESC LIMIT 1`).get(member.node_id) as { id: string; node_version: number } | undefined;
    if (predecessor && predecessor.node_version > member.previousVersion!) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    return { derivation_id: member.staged.derivation_id, output_revision_id: store.newId(), output_node_id: member.node_id,
      committed_node_version: member.version, committed_at: at, operation_id: result.operation_id!,
      reconcile_key: plan.reconcile_key, request_digest: plan.provenance_request_digest!,
      replaces_output_revision_id: predecessor?.id ?? null };
  });
  const replay = canonicalJson({ ...result, provenance_receipt: receipts[0], provenance_receipts: receipts } as unknown as Json);
  const bytes = Buffer.byteLength(replay, 'utf8');
  if (bytes > 65_536) throw new ProvenanceError('PROVENANCE_LIMIT');
  members.forEach((member, index) => {
    const receipt = receipts[index]!;
    const contribution = normalizeContribution(member.staged.contribution, member.flow);
    if (outputCurrentness(db, member.node_id, contribution) === 'changed') throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
    store.putPayload(member.staged.derivation_id, 'contribution', canonicalJson(contribution));
    const replayBytes = index === 0 ? bytes : 0;
    if (replayBytes > store.get(member.staged.derivation_id)!.reserved_remaining_bytes) throw new ProvenanceError('PROVENANCE_LIMIT');
    db.prepare(`INSERT INTO provenance_outputs(id,derivation_id,node_id,node_version,committed_at,operation_id,reconcile_key,
      request_digest,contribution_digest,post_commit_observation,replay_result,replaces_output_revision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.output_revision_id, receipt.derivation_id, member.node_id, member.version, at, result.operation_id, plan.reconcile_key,
      plan.provenance_request_digest, digestJson(contribution), canonicalJson(observeNode(db, member.node_id, at) as unknown as Json),
      index === 0 ? replay : null, receipt.replaces_output_revision_id,
    );
    db.prepare(`UPDATE provenance_derivations SET state='committed',committed_at=?,request_digest=?,reconcile_key=?,
      payload_bytes=payload_bytes+?,reserved_remaining_bytes=0 WHERE id=?`).run(at, plan.provenance_request_digest, plan.reconcile_key, replayBytes, receipt.derivation_id);
    db.prepare('INSERT OR IGNORE INTO provenance_flow_activations(project_id,flow,first_committed_at) VALUES (?,?,?)').run(plan.project.id, member.flow, at);
  });
  return receipts;
}

/** Record only prevalidated Engine inputs changed by this publication, before releasing reservations. */
export function recordBatchTransitions(db: Database.Database, derivationIds: readonly string[], changedNodeIds: readonly string[], at: string): void {
  const store = new ProvenanceStore(db); store.requireTransaction();
  const changed = new Set(changedNodeIds);
  for (const id of new Set(derivationIds)) {
    const derivation = requireActive(store.get(id), new Date(at));
    const observations = db.prepare(`SELECT o.id,s.native_id,o.expected_post_commit_observation
      FROM provenance_observations o JOIN provenance_sources s ON s.id=o.source_id
      WHERE o.derivation_id=? AND o.authority='engine' AND s.namespace=? AND s.kind='node'
        AND o.projection='node-token-v2' AND o.observation_digest IS NOT NULL`).all(id, store.namespace()) as
      Array<{ id: string; native_id: string; expected_post_commit_observation: string | null }>;
    const pending = observations.filter(row => changed.has(row.native_id)).map(row => ({
      ...row, token: canonicalJson(observeNode(db, row.native_id, at) as unknown as Json),
    }));
    let bytes = 0;
    for (const row of pending) {
      if (row.expected_post_commit_observation !== null) {
        if (row.expected_post_commit_observation !== row.token) throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
      } else bytes += Buffer.byteLength(row.token, 'utf8');
    }
    if (bytes > derivation.reserved_remaining_bytes) throw new ProvenanceError('PROVENANCE_LIMIT');
    for (const row of pending) {
      if (row.expected_post_commit_observation === null) db.prepare('UPDATE provenance_observations SET expected_post_commit_observation=? WHERE id=?').run(row.token, row.id);
    }
    db.prepare(`UPDATE provenance_derivations SET payload_bytes=payload_bytes+?,reserved_remaining_bytes=reserved_remaining_bytes-? WHERE id=?`).run(bytes, bytes, id);
  }
}

/** Erasing any member revokes the one retained batch replay, without erasing sibling inputs. */
export function invalidateBatchReplay(db: Database.Database, reconcileKey: string): void {
  const store = new ProvenanceStore(db); store.requireTransaction();
  const anchors = db.prepare(`SELECT id,derivation_id,length(CAST(replay_result AS BLOB)) AS bytes
    FROM provenance_outputs WHERE reconcile_key=? AND replay_result IS NOT NULL`).all(reconcileKey) as
    Array<{ id: string; derivation_id: string; bytes: number }>;
  for (const anchor of anchors) {
    db.prepare('UPDATE provenance_outputs SET replay_result=NULL WHERE id=?').run(anchor.id);
    db.prepare('UPDATE provenance_derivations SET payload_bytes=payload_bytes-? WHERE id=?').run(anchor.bytes, anchor.derivation_id);
  }
}
