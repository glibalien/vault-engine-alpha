import { findCommittedReplay } from '../../provenance/output-binding.js';
import { assertBatchBindings } from '../../provenance/batch-binding.js';
import { ProvenanceError } from '../../provenance/limits.js';
import { provenanceFailure } from './provenance.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WikiSectionError } from '../../wiki/section-integrity.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import {
  assertToolMutationFilePresent,
  ContentHashMismatchError,
  StaleNodeError,
} from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { getWikiBootstrapPlan, type BootstrapResult } from '../../wiki/bootstrap.js';
import { getWikiConfig, WIKIS_OFF_MESSAGE, type WikiConfig } from '../../wiki/config.js';
import { fetchExistingWiki } from '../../wiki/digest.js';
import { analyzeMerges, isReusableReconcile } from '../../wiki/reconcile-model.js';
import { validateWikiReconcilePlan } from '../../wiki/reconcile-plan.js';
import {
  THEMED_PAGE_KINDS,
  WIKI_ORIGINS,
  WIKI_STATES,
  type WikiReconcileInput,
  type WikiReconcileValidationIssue,
} from '../../wiki/reconcile-types.js';
import {
  executeWikiReconcile,
  WikiReconcileRollbackIncompleteError,
  type WikiReconcileResult,
} from '../../wiki/reconcile.js';
import { describePipelineError, fail, ok, type Issue } from './errors.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';
import { buildContentHashMismatchEnvelope } from './content-hash-helpers.js';

const TITLE_MAX_CHARS = 200;
const MESSAGE_MAX_CHARS = 500;

const scopeSchema = z.strictObject({
  v: z.literal(1),
  subject: z.string(),
  facet: z.string(),
  timeframe: z.string().optional(),
  geography: z.string().optional(),
  entities: z.array(z.string()).optional(),
  exclusions: z.array(z.string()).optional(),
});

const sectionSchema = z.strictObject({
  name: z.string(),
  mode: z.enum(['replace', 'append']),
  content: z.string(),
});

const targetSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('existing'),
    node_id: z.string(),
    expected_version: z.number().int(),
  }),
  z.strictObject({
    mode: z.literal('new'),
    plan_key: z.string(),
    title: z.string(),
  }),
]);

const provenanceSchema = z.strictObject({ derivation_id: z.string().uuid(), bundle_digest: z.string(), contribution_digest: z.string() });

const commonTargetFields = {
  provenance: provenanceSchema.optional(),
  target: targetSchema,
  scope: scopeSchema,
  kind: z.enum(THEMED_PAGE_KINDS),
  origin: z.enum(WIKI_ORIGINS),
  pinned: z.boolean(),
} as const;

const pageSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('upsert'),
    ...commonTargetFields,
    sections: z.array(sectionSchema).optional(),
  }),
  z.strictObject({
    op: z.literal('merge'),
    ...commonTargetFields,
    sources: z.array(z.strictObject({
      node_id: z.string(),
      expected_version: z.number().int(),
    })),
    reason: z.string(),
    sections: z.array(sectionSchema),
  }),
  z.strictObject({
    op: z.literal('retire'),
    node_id: z.string(),
    expected_version: z.number().int(),
    scope: scopeSchema,
    state: z.enum([WIKI_STATES.dormant, WIKI_STATES.retired]),
    reason: z.string(),
  }),
]);

export const wikiReconcileInputShape = {
  provenance_mode: z.literal('project-subpage-v1').optional(),
  home_refresh: z.strictObject({ home_node_id: z.string().min(1), expected_output_revision_id: z.string().min(1), expected_topology_hash: z.string().min(1) }).optional(),
  page_refresh: z.strictObject({ page_node_id: z.string().min(1), expected_output_revision_id: z.string().min(1), expected_topology_hash: z.string().min(1) }).optional(),
  project: z.string(),
  project_id: z.string().optional(),
  reconcile_key: z.string(),
  pages: z.array(pageSchema),
  home: z.strictObject({
    provenance: provenanceSchema.optional(),
    expected_version: z.number().int().optional(),
    sections: z.array(sectionSchema),
    evidence_hash: z.string(),
    curated_at: z.string(),
    refresh_live: z.literal(true),
    status: z.enum(['current', 'paused']).optional(),
    title_suffix: z.literal('Dossier').optional()
      .describe('Name a new home "<root> Dossier" instead of "<root> Wiki". An existing home keeps its title.'),
  }),
  dry_run: z.boolean().default(false),
} as const;

export type WikiReconcileToolDeps = {
  readonly db: Database.Database;
  readonly writeLock: WriteLockManager;
  readonly vaultPath: string;
  readonly syncLogger?: SyncLogger;
  readonly embeddingIndexer?: Pick<EmbeddingIndexer, 'enqueue'>;
  readonly execute?: typeof executeWikiReconcile;
};

export function registerWikiReconcile(server: McpServer, deps: WikiReconcileToolDeps): void {
  server.tool(
    'wiki-reconcile',
    'Deterministically apply one same-wiki reconciliation plan. Makes no semantic decisions, never deletes pages, supports dry-run preview, and records a successful batch as one undo operation.',
    wikiReconcileInputShape,
    async (params) => {
      const input: WikiReconcileInput = params;
      const config = getWikiConfig(deps.db);
      if (config.wikiType === null) return fail('INVALID_PARAMS', WIKIS_OFF_MESSAGE);
      const dryRun = params.dry_run ?? false;
      const bootstrapPlan = getWikiBootstrapPlan(deps.db, config);
      const envelopeWarnings = dryRun && requiresBootstrap(bootstrapPlan)
        ? [bootstrapWarning(bootstrapPlan)]
        : [];

      try {
        const replay = findCommittedReplay(deps.db, input);
        if (replay) return ok(boundResult(replay));
        const validation = validateWikiReconcilePlan(deps.db, config, input);
        if (!validation.ok) return validationFailure(validation.issues, envelopeWarnings);
        assertBatchBindings(deps.db, validation.plan);
        assertExistingWikiFilesPresent(deps.db, deps.vaultPath, config, validation);

        const result = await (deps.execute ?? executeWikiReconcile)({
          db: deps.db,
          config,
          writeLock: deps.writeLock,
          vaultPath: deps.vaultPath,
          ...(deps.syncLogger === undefined ? {} : { syncLogger: deps.syncLogger }),
          ...(deps.embeddingIndexer === undefined ? {} : { embeddingIndexer: deps.embeddingIndexer }),
        }, validation, { dryRun });
        const bounded = boundResult(result);
        return ok(bounded, [...envelopeWarnings, ...bounded.warnings.map(warning => ({
          code: warning.code,
          message: warning.message,
          severity: 'warning' as const,
          details: { node_id: warning.node_id },
        }))]);
      } catch (error) {
        if (error instanceof ProvenanceError) return provenanceFailure(error);
        if (error instanceof WikiSectionError) return fail('VALIDATION_FAILED', error.message, { warnings: envelopeWarnings });
        if (error instanceof ContentHashMismatchError) {
          return buildContentHashMismatchEnvelope(deps.db, error);
        }
        if (error instanceof StaleNodeError) return buildStaleNodeEnvelope(deps.db, error);
        if (error instanceof WikiReconcileRollbackIncompleteError) {
          return fail('UPSTREAM_ERROR', bound(`Wiki reconciliation rollback incomplete for operation ${error.operationId}`, MESSAGE_MAX_CHARS), {
            details: { operation_id: error.operationId, failures: error.failures.map(failure => bound(failure, MESSAGE_MAX_CHARS)) },
            warnings: envelopeWarnings,
          });
        }
        if (error instanceof PipelineError) {
          const described = describePipelineError(error);
          if (described !== null) return fail(described.code, described.message, {
            details: described.details,
            warnings: envelopeWarnings,
          });
        }
        return fail('INTERNAL_ERROR', bound(error instanceof Error ? error.message : String(error), MESSAGE_MAX_CHARS), {
          warnings: envelopeWarnings,
        });
      }
    },
  );
}

function assertExistingWikiFilesPresent(
  db: Database.Database,
  vaultPath: string,
  config: WikiConfig,
  validation: Extract<ReturnType<typeof validateWikiReconcilePlan>, { ok: true }>,
): void {
  const { plan } = validation;
  const nodeIds = new Set<string>();
  if (plan.home.node_id !== null) nodeIds.add(plan.home.node_id);
  for (const page of plan.pages) {
    if (page.op === 'retire') {
      nodeIds.add(page.node_id);
      continue;
    }
    if (page.target.mode === 'existing') nodeIds.add(page.target.node_id);
    if (page.op === 'merge') {
      for (const source of page.sources) nodeIds.add(source.node_id);
    }
  }

  // Merge execution also rewrites historical replacement ancestors. Match
  // that derived set without adding prerequisites to an already-reused plan.
  const catalog = fetchExistingWiki(db, plan.project.id, config);
  if (!isReusableReconcile(catalog, plan, validation.markers)) {
    for (const analysis of analyzeMerges(plan, catalog.subpages).values()) {
      for (const ancestorId of analysis.ancestorIds) nodeIds.add(ancestorId);
    }
  }

  for (const nodeId of nodeIds) {
    const node = db.prepare('SELECT file_path FROM nodes WHERE id = ?')
      .get(nodeId) as { file_path: string } | undefined;
    if (node === undefined) continue;
    assertToolMutationFilePresent(db, vaultPath, {
      source: 'tool',
      node_id: nodeId,
      file_path: node.file_path,
    });
  }
}

function validationFailure(issues: readonly WikiReconcileValidationIssue[], warnings: Issue[]) {
  const boundedIssues = issues.map(issue => ({
    ...issue,
    message: bound(issue.message, MESSAGE_MAX_CHARS),
    ...(issue.title === undefined ? {} : { title: bound(issue.title, TITLE_MAX_CHARS) }),
    ...(issue.target === undefined ? {} : { target: bound(issue.target, TITLE_MAX_CHARS) }),
  }));
  if (issues.some(issue => issue.code === 'RECONCILE_KEY_COLLISION')) {
    return fail('CONFLICT', 'reconcile_key is already paired with a different plan', {
      details: { issues: boundedIssues },
      warnings,
    });
  }
  if (issues.some(issue => issue.code === 'EXPECTED_VERSION_MISMATCH' || issue.code === 'HOME_EXPECTED_VERSION_MISMATCH')) {
    return fail('STALE_NODE', 'Wiki reconciliation plan contains stale node versions', {
      details: { issues: boundedIssues },
      warnings,
    });
  }
  return fail('VALIDATION_FAILED', 'Wiki reconciliation plan validation failed', {
    details: { issues: boundedIssues },
    warnings,
  });
}

function requiresBootstrap(plan: BootstrapResult): boolean {
  return plan.created_global_fields.length > 0
    || plan.created_schemas.length > 0
    || plan.added_schema_claims.length > 0;
}

function bootstrapWarning(plan: BootstrapResult): Issue {
  return {
    code: 'WIKI_SCHEMA_BOOTSTRAP_REQUIRED',
    message: 'Wiki schema bootstrap or upgrade would be required before commit',
    severity: 'warning',
    details: plan,
  };
}

function boundResult(result: WikiReconcileResult): WikiReconcileResult {
  return {
    ...result,
    created: result.created.map(node => ({ ...node, title: bound(node.title, TITLE_MAX_CHARS) })),
    updated: result.updated.map(node => ({ ...node, title: bound(node.title, TITLE_MAX_CHARS) })),
    mappings: result.mappings.map(mapping => ({
      ...mapping,
      target_title: bound(mapping.target_title, TITLE_MAX_CHARS),
    })),
    home: { ...result.home, title: bound(result.home.title, TITLE_MAX_CHARS) },
    warnings: result.warnings.map(warning => ({
      ...warning,
      message: bound(warning.message, MESSAGE_MAX_CHARS),
    })),
    preview: {
      ...result.preview,
      items: result.preview.items.map(item => ({
        ...item,
        target: bound(item.target, TITLE_MAX_CHARS),
        title: bound(item.title, TITLE_MAX_CHARS),
      })),
    },
  };
}

function bound(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
