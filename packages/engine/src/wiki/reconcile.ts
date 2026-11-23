import { assertBatchBindings, bindCommittedBatch, recordBatchTransitions } from '../provenance/batch-binding.js';
import { assertHomeRefresh, assertPageRefresh } from '../provenance/home-refresh.js';
import type { OutputCurrentness, OutputReceipt } from '../provenance/types.js';
import type Database from 'better-sqlite3';
import { executeMutation } from '../pipeline/execute.js';
import type { PipelineResult, ProposedMutation } from '../pipeline/types.js';
import { readFileOrNull } from '../pipeline/file-writer.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { createOperation, discardOperation, finalizeOperation } from '../undo/operation.js';
import type { WikiConfig } from './config.js';
import { fetchExistingWiki } from './digest.js';
import type { WikiReconcileValidationResult } from './reconcile-types.js';
import {
  buildReconcilePreview,
  isReusableReconcile,
  loadStoredWikiNode,
  reuseMappings,
  staleReplacementWarnings,
} from './reconcile-model.js';
import { simulateWikiReconcile } from './reconcile-preview.js';
import { applyWikiReconcile } from './reconcile-apply.js';
import { ensureWikiSchema } from './bootstrap.js';
import { assertWikiSectionStructure } from './section-integrity.js';

export type ValidatedWikiReconcilePlan = Extract<WikiReconcileValidationResult, { readonly ok: true }>;

export type WikiReconcileDeps = {
  readonly db: Database.Database;
  readonly config: WikiConfig;
  readonly writeLock: WriteLockManager;
  readonly vaultPath: string;
  readonly syncLogger?: SyncLogger;
  readonly embeddingIndexer?: Pick<EmbeddingIndexer, 'enqueue'>;
  readonly mutate?: typeof executeMutation;
};

export type WikiReconcileNodeResult = {
  readonly node_id: string;
  readonly title: string;
  readonly file_path: string;
  readonly version: number;
};

export type WikiReconcileMapping = {
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly target_title: string;
};

export type WikiReconcileHomeResult = {
  readonly node_id: string | null;
  readonly title: string;
  readonly file_path: string;
  readonly version: number | null;
  readonly created: boolean;
};

export type WikiReconcileWarning = {
  readonly code: 'STALE_ACTIVE_REPLACEMENT';
  readonly message: string;
  readonly node_id: string;
};

export type WikiReconcilePreviewItem = {
  readonly op: 'upsert' | 'merge' | 'retire';
  readonly target: string;
  readonly title: string;
  readonly source_count?: number;
  readonly state?: 'dormant' | 'retired';
};

export type WikiReconcilePreview = {
  readonly total: number;
  readonly items: readonly WikiReconcilePreviewItem[];
  readonly truncated: boolean;
};

export type WikiReconcileResult = {
  readonly provenance_receipt?: OutputReceipt;
  readonly provenance_receipts?: OutputReceipt[];
  readonly current_outputs?: Record<string, OutputCurrentness>;
  readonly current_output?: 'matches' | 'changed' | 'missing' | 'unknown';
  readonly operation_id: string | null;
  readonly reconcile_key: string;
  readonly plan_digest: string;
  readonly reused: boolean;
  readonly dry_run: boolean;
  readonly created: readonly WikiReconcileNodeResult[];
  readonly updated: readonly WikiReconcileNodeResult[];
  readonly mappings: readonly WikiReconcileMapping[];
  readonly home: WikiReconcileHomeResult;
  readonly topology_hash: string;
  readonly warnings: readonly WikiReconcileWarning[];
  readonly preview: WikiReconcilePreview;
};

export class WikiReconcileRollbackIncompleteError extends Error {
  readonly name = 'WikiReconcileRollbackIncompleteError';

  constructor(
    readonly operationId: string,
    readonly failures: readonly string[],
    options?: ErrorOptions,
  ) {
    super(`Wiki reconciliation rollback incomplete for operation ${operationId}`, options);
  }
}

export async function executeWikiReconcile(
  deps: WikiReconcileDeps,
  validated: ValidatedWikiReconcilePlan,
  options: { readonly dryRun: boolean },
): Promise<WikiReconcileResult> {
  const plan = validated.plan;
  assertHomeRefresh(deps.db, plan);
  assertPageRefresh(deps.db, plan);
  const capturedBatch = assertBatchBindings(deps.db, plan);
  const catalog = fetchExistingWiki(deps.db, plan.project.id, deps.config);
  const preview = buildReconcilePreview(plan, catalog.subpages);
  if (!capturedBatch && !plan.home_refresh && !plan.page_refresh && isReusableReconcile(catalog, plan, validated.markers)) {
    if (catalog.home === null) throw new WikiReconcileExecutionError('Reusable reconciliation has no home');
    const home = loadStoredWikiNode(deps.db, catalog.home.id);
    // Stamps identify a prior application; later owner edits must still have
    // valid section boundaries before reuse can report success without writing.
    assertWikiSectionStructure(home.body);
    return {
      operation_id: null,
      reconcile_key: plan.reconcile_key,
      plan_digest: plan.plan_digest,
      reused: true,
      dry_run: options.dryRun,
      created: [],
      updated: [],
      mappings: reuseMappings(plan, catalog.subpages),
      home: {
        node_id: home.id,
        title: home.title,
        file_path: home.filePath,
        version: home.version,
        created: false,
      },
      topology_hash: catalog.topology_hash,
      warnings: staleReplacementWarnings(catalog.subpages),
      preview,
    };
  }
  if (options.dryRun) {
    const simulated = simulateWikiReconcile(deps, validated, catalog.subpages);
    return {
      operation_id: null,
      reconcile_key: plan.reconcile_key,
      plan_digest: plan.plan_digest,
      reused: false,
      dry_run: true,
      created: simulated.created,
      updated: simulated.updated,
      mappings: simulated.mappings,
      home: simulated.home,
      topology_hash: simulated.topologyHash,
      warnings: simulated.warnings,
      preview,
    };
  }

  const operationId = createOperation(deps.db, {
    source_tool: 'wiki-reconcile',
    description: `wiki-reconcile: ${plan.project.title} (${plan.pages.length} page operations)`,
  });
  const rollbackEntries: RollbackEntry[] = [];
  const mutation = deps.mutate ?? executeMutation;
  let provenanceReceipts: OutputReceipt[] = [];
  const transaction = deps.db.transaction(() => {
    assertHomeRefresh(deps.db, plan);
    assertPageRefresh(deps.db, plan);
    const batch = assertBatchBindings(deps.db, plan);
    ensureWikiSchema(deps.db, deps.config, operationId);
    const applied = applyWikiReconcile({
      deps,
      validated,
      catalogPages: catalog.subpages,
      mutate: proposed => trackedMutation({ deps, operationId, mutation, rollbackEntries, proposed }),
    });
    if (batch) recordBatchTransitions(deps.db,
      [...(batch.home ? [batch.home.derivation_id] : []), ...batch.pages.map(page => page.staged.derivation_id)],
      applied.changedNodeIds, new Date().toISOString());
    provenanceReceipts = bindCommittedBatch(deps.db, plan, {
      operation_id: operationId, reconcile_key: plan.reconcile_key, plan_digest: plan.plan_digest,
      reused: false, dry_run: false, created: applied.created, updated: applied.updated,
      mappings: applied.mappings, home: applied.home, topology_hash: applied.topologyHash,
      warnings: applied.warnings, preview,
    }, applied.resolvedPageTargets);
    return applied;
  });

  let applied: ReturnType<typeof applyWikiReconcile>;
  try {
    applied = transaction();
  } catch (error) {
    const failures = rollbackFilesystem(rollbackEntries);
    if (failures.length > 0) {
      finalizeOperation(deps.db, operationId);
      throw new WikiReconcileRollbackIncompleteError(operationId, failures, { cause: error });
    }
    discardOperation(deps.db, operationId);
    throw error;
  }

  finalizeOperation(deps.db, operationId);
  for (const nodeId of new Set(applied.changedNodeIds)) {
    deps.embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
  }
  return {
    ...(provenanceReceipts.length ? { provenance_receipt: provenanceReceipts[0],
      ...(plan.provenance_mode || capturedBatch?.pages.length ? { provenance_receipts: provenanceReceipts } : {}) } : {}),
    operation_id: operationId,
    reconcile_key: plan.reconcile_key,
    plan_digest: plan.plan_digest,
    reused: false,
    dry_run: false,
    created: applied.created,
    updated: applied.updated,
    mappings: applied.mappings,
    home: applied.home,
    topology_hash: applied.topologyHash,
    warnings: applied.warnings,
    preview,
  };
}

type RollbackEntry = {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly restore: () => void;
};

function trackedMutation(input: {
  readonly deps: WikiReconcileDeps;
  readonly operationId: string;
  readonly mutation: typeof executeMutation;
  readonly rollbackEntries: RollbackEntry[];
  readonly proposed: ProposedMutation;
}): PipelineResult {
  const path = safeVaultPath(input.deps.vaultPath, input.proposed.file_path);
  const before = readFileOrNull(path);
  return input.mutation(
    input.deps.db,
    input.deps.writeLock,
    input.deps.vaultPath,
    // Reconcile preserves human text around the sections it writes, and its
    // rollback tracks only this file: no link rewriting, no inbound repairs.
    { ...input.proposed, canonicalizeLinks: false },
    input.deps.syncLogger,
    { operation_id: input.operationId },
    {
      push: restore => input.rollbackEntries.push({
        path,
        before,
        after: readFileOrNull(path),
        restore,
      }),
    },
  );
}

function rollbackFilesystem(entries: readonly RollbackEntry[]): string[] {
  const failures: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const current = readFileOrNull(entry.path);
    if (current !== entry.after) {
      failures.push(`Concurrent file change blocked restore: ${entry.path}`);
      continue;
    }
    try {
      entry.restore();
      if (readFileOrNull(entry.path) !== entry.before) {
        failures.push(`File restore did not reproduce original bytes: ${entry.path}`);
      }
    } catch (error) {
      failures.push(`File restore failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

class WikiReconcileExecutionError extends Error {
  readonly name = 'WikiReconcileExecutionError';
}
