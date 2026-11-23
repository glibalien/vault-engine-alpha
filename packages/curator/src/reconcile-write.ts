import type { ProvenanceBinding } from './provenance-types.js';
import type { Issue } from '@vault/contract';
import { EngineError, type WikiReconcileInput, type WikiReconcileResult } from './engine.js';
import { buildReconcileKey, buildReconcilePayload } from './reconcile-write-plan.js';
import { assertCreatedTargets, ReconcileInvariantError, translateReconcileResult } from './reconcile-write-result.js';
import type { ExistingWiki, NodeRef, PageSynthesisResult, TopologyPlan, TopologyResult, WikiSections } from './types.js';

type ReconcileEngine = {
  readonly wikiReconcile: (input: WikiReconcileInput) => Promise<{ readonly data: WikiReconcileResult; readonly warnings: Issue[] }>;
};

export type ReconcileWriteInput = {
  readonly provenance?: ProvenanceBinding;
  readonly provenanceMode?: 'project-subpage-v1';
  readonly engine: ReconcileEngine;
  readonly project: string;
  readonly wikiRootId: string;
  readonly evidenceHash: string;
  readonly existingWiki: ExistingWiki;
  readonly plan: TopologyPlan;
  readonly synthesizedPages: readonly PageSynthesisResult[];
  readonly homeSections: WikiSections;
  readonly dryRun: boolean;
  readonly curatedAt?: string;
  readonly requestedPage?: { readonly requestId: string; readonly target: NodeRef };
  /** The home's `wiki_status` once this build is stamped (#547). */
  readonly homeStatus?: 'current' | 'paused';
};

export type ReconcileKeyInput = {
  readonly wikiRootId: string;
  readonly evidenceHash: string;
  readonly topologyHash: string;
  readonly plan: TopologyPlan;
  readonly requestedPageRequestId?: string;
};

export type ReconcileWriteResult = {
  readonly reconcileKey: string;
  readonly data: WikiReconcileResult;
  readonly topology: readonly TopologyResult[];
  readonly mappings: WikiReconcileResult['mappings'];
  readonly topologyHash: string;
  readonly homeOutcome: WikiReconcileResult['home'];
  readonly warnings: readonly (Issue | WikiReconcileResult['warnings'][number])[];
};

export { buildReconcileKey, ReconcileInvariantError };

export class ReconciliationExecutionError extends Error {
  override readonly name = 'ReconciliationExecutionError';
  readonly code: string | undefined;

  constructor(readonly phase: 'preview' | 'commit', cause: unknown) {
    super(`${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.code = cause instanceof EngineError ? cause.code : undefined;
  }
}

export async function executeReconciliation(input: ReconcileWriteInput): Promise<ReconcileWriteResult> {
  const reconcileKey = input.provenance ? `wiki-reconcile:provenance-v1:${input.provenance.derivation_id}` : buildReconcileKey({
    wikiRootId: input.wikiRootId,
    evidenceHash: input.evidenceHash,
    topologyHash: input.existingWiki.topology_hash,
    plan: input.plan,
    ...(input.requestedPage === undefined ? {} : { requestedPageRequestId: input.requestedPage.requestId }),
  });
  const payload = buildReconcilePayload(input, reconcileKey);
  let preview;
  try {
    preview = await input.engine.wikiReconcile({ ...payload, dry_run: true });
  } catch (error) {
    throw new ReconciliationExecutionError('preview', error);
  }
  if (preview.data.dry_run !== true) throw new ReconcileInvariantError('Engine preview returned the wrong response mode.');
  assertCreatedTargets(preview.data, payload.pages);
  if (input.dryRun) {
    return translateReconcileResult(input, reconcileKey, preview.data, preview.warnings, [], payload.pages);
  }

  let committed;
  try {
    committed = await input.engine.wikiReconcile({ ...payload, dry_run: false });
  } catch (error) {
    throw new ReconciliationExecutionError('commit', error);
  }
  if (committed.data.dry_run !== false) throw new ReconcileInvariantError('Engine commit returned the wrong response mode.');
  assertCreatedTargets(committed.data, payload.pages);
  return translateReconcileResult(
    input,
    reconcileKey,
    committed.data,
    [...preview.warnings, ...committed.warnings],
    preview.data.warnings,
    payload.pages,
  );
}
