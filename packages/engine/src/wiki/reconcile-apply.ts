// allow: SIZE_OK — ordered reconciliation state machine; splitting would obscure mutation/rollback order.
import { settledWikiStatus } from './status.js';
import type { PipelineResult, ProposedMutation } from '../pipeline/types.js';
import type { WikiCatalogPage } from './digest.js';
import { requireWikiType } from './config.js';
import { computeWikiTopologyHash } from './topology.js';
import { mergeManagedSections } from './sections.js';
import type {
  ResolvedWikiReconcilePageOperation,
  WikiReconcileValidationMarker,
} from './reconcile-types.js';
import type {
  ValidatedWikiReconcilePlan,
  WikiReconcileDeps,
  WikiReconcileHomeResult,
  WikiReconcileMapping,
  WikiReconcileNodeResult,
  WikiReconcileWarning,
} from './reconcile.js';
import {
  analyzeMerges,
  catalogPageAfterWrite,
  loadStoredWikiNode,
  staleReplacementWarnings,
  type CatalogPagePatch,
  type MergeAnalysis,
  type StoredWikiNode,
} from './reconcile-model.js';
import { mergeLogEntry, reconcileStamp, retirementStatus } from './reconcile-content.js';
import { wikiTimeZone } from './today.js';
import {
  buildCurrentWikiDigest,
  buildWikiFilePath,
  buildWikiPageTitle,
  buildWikiTargetFields,
  renderWikiLiveSections,
} from './write-helpers.js';

export type TrackedWikiMutation = (mutation: ProposedMutation) => PipelineResult;

export type AppliedWikiReconcile = {
  readonly resolvedPageTargets: ReadonlyMap<number, { node_id: string; version: number }>;
  readonly created: readonly WikiReconcileNodeResult[];
  readonly updated: readonly WikiReconcileNodeResult[];
  readonly mappings: readonly WikiReconcileMapping[];
  readonly home: WikiReconcileHomeResult;
  readonly topologyHash: string;
  readonly warnings: readonly WikiReconcileWarning[];
  readonly changedNodeIds: readonly string[];
};

export function applyWikiReconcile(input: {
  readonly deps: WikiReconcileDeps;
  readonly validated: ValidatedWikiReconcilePlan;
  readonly catalogPages: readonly WikiCatalogPage[];
  readonly mutate: TrackedWikiMutation;
}): AppliedWikiReconcile {
  const { deps, validated, catalogPages, mutate } = input;
  const plan = validated.plan;
  const timeZone = wikiTimeZone(deps.db);
  const working = new Map(catalogPages.map(page => [page.id, page]));
  const analyses = analyzeMerges(plan, catalogPages);
  const targets = new Map<string, WikiCatalogPage>();
  const created: WikiReconcileNodeResult[] = [];
  const updated = new Map<string, WikiReconcileNodeResult>();
  const mappings: WikiReconcileMapping[] = [];
  const changedNodeIds = new Set<string>();
  const satisfied = markerSet(validated.markers);
  const homeTitle = buildWikiPageTitle(plan.project.title, 'home', undefined, plan.home.title_suffix);

  plan.pages.forEach((operation, operationIndex) => {
    if (operation.op === 'retire' || operation.target.mode !== 'new') return;
    const filePath = buildWikiFilePath(deps.config.wikiDir, operation.target.title);
    const body = targetBody({ plan, operation, working, currentBody: '' });
    const patch = targetPatch(operation, analyses.get(operationIndex));
    const fields = targetFields({
      currentFields: {},
      projectTarget: plan.project.file_path,
      homeTitle,
      operation,
      analysis: analyses.get(operationIndex),
    });
    const result = mutate({
      source: 'tool',
      node_id: null,
      file_path: filePath,
      title: operation.target.title,
      types: [requireWikiType(deps.config)],
      fields,
      body,
    });
    const page = pageFromResult({
      deps,
      result,
      title: operation.target.title,
      body,
      patch,
    });
    working.set(page.id, page);
    targets.set(operation.target.plan_key, page);
    created.push(nodeResult(page));
    changedNodeIds.add(page.id);
  });

  plan.pages.forEach((operation, operationIndex) => {
    switch (operation.op) {
      case 'upsert': {
        if (operation.target.mode === 'new') break;
        const current = requiredPage(working, operation.target.node_id);
        const stored = loadStoredWikiNode(deps.db, current.id);
        const body = mergeManagedSections(stored.body, {
          live: {},
          managed: [...(operation.sections ?? [])],
        }).body;
        writeExisting({
          deps,
          mutate,
          working,
          updated,
          changedNodeIds,
          stored,
          body,
          // A page refresh changes the page's text and nothing else. Rebuilding these fields
          // would re-derive its parent from the project's title, detaching it from a renamed home.
          fields: plan.page_refresh ? stored.fields : {
            ...stored.fields,
            ...targetFields({
              currentFields: stored.fields,
              projectTarget: plan.project.file_path,
              homeTitle,
              operation,
            }),
          },
          patch: targetPatch(operation),
          expectedVersion: operation.target.expected_version,
        });
        break;
      }
      case 'merge': {
        const analysis = requiredAnalysis(analyses, operationIndex);
        const target = resolveTarget(operation, working, targets);
        if (operation.target.mode === 'existing') {
          const stored = loadStoredWikiNode(deps.db, target.id);
          const body = targetBody({ plan, operation, working, currentBody: stored.body });
          writeExisting({
            deps,
            mutate,
            working,
            updated,
            changedNodeIds,
            stored,
            body,
            fields: targetFields({
              currentFields: stored.fields,
              projectTarget: plan.project.file_path,
              homeTitle,
              operation,
              analysis,
            }),
            patch: targetPatch(operation, analysis),
            expectedVersion: operation.target.expected_version,
          });
        }
        const currentTarget = operation.target.mode === 'existing'
          ? requiredPage(working, operation.target.node_id)
          : requiredPage(targets, operation.target.plan_key);
        for (const source of operation.sources) {
          mappings.push({
            source_node_id: source.node_id,
            target_node_id: currentTarget.id,
            target_title: currentTarget.title,
          });
          if (satisfied.has(`${operationIndex}:${source.node_id}`)) continue;
          const current = requiredPage(working, source.node_id);
          const stored = loadStoredWikiNode(deps.db, source.node_id);
          const body = mergeManagedSections(stored.body, {
            live: {},
            managed: [{
              name: 'Status',
              mode: 'replace',
              content: retirementStatus(plan, {
                state: 'retired',
                reason: operation.reason,
                targetTitle: currentTarget.title,
              }, timeZone),
            }],
          }).body;
          writeExisting({
            deps,
            mutate,
            working,
            updated,
            changedNodeIds,
            stored,
            body,
            fields: {
              ...stored.fields,
              wiki_for: plan.project.file_path,
              wiki_scope: operation.scope,
              wiki_state: 'retired',
              wiki_replaced_by: currentTarget.title,
              wiki_pinned: false,
            },
            patch: {
              scope: operation.scope,
              state: 'retired',
              ...(current.wiki_kind === undefined ? {} : { kind: current.wiki_kind }),
              origin: current.wiki_origin,
              pinned: false,
              replacedBy: { id: currentTarget.id, title: currentTarget.title },
            },
            expectedVersion: source.expected_version,
          });
        }
        for (const ancestorId of analysis.ancestorIds) {
          const current = requiredPage(working, ancestorId);
          const stored = loadStoredWikiNode(deps.db, ancestorId);
          writeExisting({
            deps,
            mutate,
            working,
            updated,
            changedNodeIds,
            stored,
            body: stored.body,
            fields: {
              ...stored.fields,
              wiki_for: plan.project.file_path,
              wiki_scope: operation.scope,
              wiki_replaced_by: currentTarget.title,
              wiki_pinned: false,
            },
            patch: {
              scope: operation.scope,
              state: current.wiki_state,
              ...(current.wiki_kind === undefined ? {} : { kind: current.wiki_kind }),
              origin: current.wiki_origin,
              pinned: false,
              replacedBy: { id: currentTarget.id, title: currentTarget.title },
            },
            expectedVersion: current.version,
          });
        }
        break;
      }
      case 'retire': {
        const current = requiredPage(working, operation.node_id);
        const stored = loadStoredWikiNode(deps.db, operation.node_id);
        if (stored.fields.wiki_pinned === true) {
          throw new WikiReconcilePinnedRetireError(operation.node_id);
        }
        const body = mergeManagedSections(stored.body, {
          live: {},
          managed: [{
            name: 'Status',
            mode: 'replace',
            content: retirementStatus(plan, {
              state: operation.state,
              reason: operation.reason,
            }, timeZone),
          }],
        }).body;
        writeExisting({
          deps,
          mutate,
          working,
          updated,
          changedNodeIds,
          stored,
          body,
          fields: {
            ...stored.fields,
            wiki_for: plan.project.file_path,
            wiki_scope: operation.scope,
            wiki_state: operation.state,
          },
          patch: {
            scope: operation.scope,
            state: operation.state,
            ...(current.wiki_kind === undefined ? {} : { kind: current.wiki_kind }),
            origin: current.wiki_origin,
            pinned: current.wiki_pinned,
            replacedBy: current.wiki_replaced_by ?? null,
          },
          expectedVersion: operation.expected_version,
        });
        break;
      }
      default:
        assertNever(operation);
    }
  });

  const resolvedPageTargets = new Map<number, { node_id: string; version: number }>();
  plan.pages.forEach((operation, index) => {
    if (operation.op === 'retire') return;
    const page = operation.target.mode === 'existing'
      ? requiredPage(working, operation.target.node_id) : requiredPage(targets, operation.target.plan_key);
    resolvedPageTargets.set(index, { node_id: page.id, version: nodeVersion(deps, page.id) });
  });
  const pages = [...working.values()];
  const topologyHash = computeWikiTopologyHash(pages);
  if (plan.page_refresh) {
    // Only the page changed. The home keeps its body, its live sections and its stamps.
    if (plan.home.node_id === null) throw new WikiReconcileApplyError('Page refresh requires an existing home');
    const home = loadStoredWikiNode(deps.db, plan.home.node_id);
    return {
      resolvedPageTargets, created, updated: [...updated.values()], mappings,
      home: { node_id: home.id, title: home.title, file_path: home.filePath, version: nodeVersion(deps, home.id), created: false },
      topologyHash, warnings: staleReplacementWarnings(pages), changedNodeIds: [...changedNodeIds],
    };
  }
  const digest = buildCurrentWikiDigest(deps.db, plan.project.id);
  const live = renderWikiLiveSections(deps.db, {
    config: deps.config,
    projectId: plan.project.id,
    digest: {
      ...digest,
      existing_wiki: {
        ...digest.existing_wiki,
        topology_hash: topologyHash,
        subpages: pages,
      },
    },
    target: 'home',
  });
  const storedHome = plan.home.node_id === null ? null : loadStoredWikiNode(deps.db, plan.home.node_id);
  const homeBody = mergeManagedSections(storedHome?.body ?? '', {
    live,
    managed: [...plan.home.sections],
  }).body;
  const homePath = storedHome?.filePath ?? buildWikiFilePath(deps.config.wikiDir, homeTitle);
  const homeResult = mutate({
    source: 'tool',
    node_id: storedHome?.id ?? null,
    file_path: homePath,
    title: storedHome?.title ?? homeTitle,
    types: storedHome?.types ? [...storedHome.types] : [requireWikiType(deps.config)],
    fields: {
      ...buildWikiTargetFields({
        currentFields: storedHome?.fields ?? {},
        projectTarget: plan.project.file_path,
        target: 'home',
      }),
      ...(plan.home_refresh ? {} : {
        wiki_evidence_hash: plan.home.evidence_hash,
        wiki_topology_hash: topologyHash,
        wiki_curated_at: plan.home.curated_at,
        wiki_status: settledWikiStatus(deps.db, deps.config, plan.project.id,
          builtWikiStatus(plan.home.status, storedHome?.fields.wiki_status), plan.home.evidence_hash),
      }),
      wiki_reconcile_key: reconcileStamp(plan),
    },
    body: homeBody,
    expectedVersion: storedHome === null ? undefined : plan.home.expected_version,
  });
  const homeVersion = nodeVersion(deps, homeResult.node_id);
  changedNodeIds.add(homeResult.node_id);
  return {
    resolvedPageTargets,
    created,
    updated: [...updated.values()],
    mappings,
    home: {
      node_id: homeResult.node_id,
      title: storedHome?.title ?? homeTitle,
      file_path: homeResult.file_path,
      version: homeVersion,
      created: storedHome === null,
    },
    topologyHash,
    warnings: staleReplacementWarnings(pages),
    changedNodeIds: [...changedNodeIds],
  };
}

/**
 * The status a build stamps on the home (#547): what the Curator says, else paused for a
 * paused wiki and current otherwise. `settledWikiStatus` then makes it behind (or
 * paused-behind) when the project's notes changed while the build ran.
 */
export function builtWikiStatus(requested: 'current' | 'paused' | undefined, stored: unknown): 'current' | 'paused' {
  if (requested !== undefined) return requested;
  return stored === 'paused' || stored === 'paused-behind' ? 'paused' : 'current';
}

function targetBody(input: {
  readonly plan: ValidatedWikiReconcilePlan['plan'];
  readonly operation: Exclude<ResolvedWikiReconcilePageOperation, { readonly op: 'retire' }>;
  readonly working: ReadonlyMap<string, WikiCatalogPage>;
  readonly currentBody: string;
}): string {
  const withSections = mergeManagedSections(input.currentBody, {
    live: {},
    managed: [...(input.operation.sections ?? [])],
  }).body;
  if (input.operation.op !== 'merge') return withSections;
  const sourceTitles = input.operation.sources.map(source => requiredPage(input.working, source.node_id).title);
  const targetTitleValue = input.operation.target.mode === 'new'
    ? input.operation.target.title
    : requiredPage(input.working, input.operation.target.node_id).title;
  return mergeManagedSections(withSections, {
    live: {},
    managed: [{ name: 'Log', mode: 'append', content: mergeLogEntry(input.plan, sourceTitles, targetTitleValue) }],
  }).body;
}

function targetFields(input: {
  readonly currentFields: Readonly<Record<string, unknown>>;
  readonly projectTarget: string;
  readonly homeTitle: string;
  readonly operation: Exclude<ResolvedWikiReconcilePageOperation, { readonly op: 'retire' }>;
  readonly analysis?: MergeAnalysis;
}): Record<string, unknown> {
  return {
    ...buildWikiTargetFields({
      currentFields: input.currentFields,
      projectTarget: input.projectTarget,
      target: 'subpage',
      parentTitle: input.homeTitle,
    }),
    wiki_scope: input.operation.scope,
    wiki_kind: input.operation.kind,
    wiki_origin: input.analysis?.origin ?? input.operation.origin,
    wiki_pinned: input.analysis?.pinned ?? input.operation.pinned,
    wiki_state: 'active',
    wiki_replaced_by: null,
  };
}

function targetPatch(
  operation: Exclude<ResolvedWikiReconcilePageOperation, { readonly op: 'retire' }>,
  analysis?: MergeAnalysis,
): CatalogPagePatch {
  return {
    scope: operation.scope,
    state: 'active',
    kind: operation.kind,
    origin: analysis?.origin ?? operation.origin,
    pinned: analysis?.pinned ?? operation.pinned,
    replacedBy: null,
  };
}

function writeExisting(input: {
  readonly deps: WikiReconcileDeps;
  readonly mutate: TrackedWikiMutation;
  readonly working: Map<string, WikiCatalogPage>;
  readonly updated: Map<string, WikiReconcileNodeResult>;
  readonly changedNodeIds: Set<string>;
  readonly stored: StoredWikiNode;
  readonly body: string;
  readonly fields: Record<string, unknown>;
  readonly patch: CatalogPagePatch;
  readonly expectedVersion: number;
}): void {
  const result = input.mutate({
    source: 'tool',
    node_id: input.stored.id,
    file_path: input.stored.filePath,
    title: input.stored.title,
    types: [...input.stored.types],
    fields: input.fields,
    body: input.body,
    expectedVersion: input.expectedVersion,
  });
  const page = pageFromResult({
    deps: input.deps,
    result,
    title: input.stored.title,
    body: input.body,
    patch: input.patch,
  });
  input.working.set(page.id, page);
  input.updated.set(page.id, nodeResult(page));
  input.changedNodeIds.add(page.id);
}

function pageFromResult(input: {
  readonly deps: WikiReconcileDeps;
  readonly result: PipelineResult;
  readonly title: string;
  readonly body: string;
  readonly patch: CatalogPagePatch;
}): WikiCatalogPage {
  return catalogPageAfterWrite({
    id: input.result.node_id,
    title: input.title,
    filePath: input.result.file_path,
    version: nodeVersion(input.deps, input.result.node_id),
    contentHash: input.result.rendered_hash,
    body: input.body,
    patch: input.patch,
  });
}

function resolveTarget(
  operation: Extract<ResolvedWikiReconcilePageOperation, { readonly op: 'merge' }>,
  working: ReadonlyMap<string, WikiCatalogPage>,
  targets: ReadonlyMap<string, WikiCatalogPage>,
): WikiCatalogPage {
  return operation.target.mode === 'existing'
    ? requiredPage(working, operation.target.node_id)
    : requiredPage(targets, operation.target.plan_key);
}

function requiredPage(pages: ReadonlyMap<string, WikiCatalogPage>, key: string): WikiCatalogPage {
  const page = pages.get(key);
  if (page === undefined) throw new WikiReconcileApplyError(`Missing wiki page ${key}`);
  return page;
}

function requiredAnalysis(analyses: ReadonlyMap<number, MergeAnalysis>, operationIndex: number): MergeAnalysis {
  const analysis = analyses.get(operationIndex);
  if (analysis === undefined) throw new WikiReconcileApplyError(`Missing merge analysis ${operationIndex}`);
  return analysis;
}

function markerSet(markers: readonly WikiReconcileValidationMarker[]): ReadonlySet<string> {
  return new Set(markers.map(marker => `${marker.operation_index}:${marker.node_id}`));
}

function nodeVersion(deps: WikiReconcileDeps, nodeId: string): number {
  const row = deps.db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined;
  if (row === undefined) throw new WikiReconcileApplyError(`Missing written wiki node ${nodeId}`);
  return row.version;
}

function nodeResult(page: WikiCatalogPage): WikiReconcileNodeResult {
  return { node_id: page.id, title: page.title, file_path: page.file_path, version: page.version };
}

function assertNever(value: never): never {
  throw new WikiReconcileApplyError(`Unexpected reconciliation variant: ${JSON.stringify(value)}`);
}

export class WikiReconcilePinnedRetireError extends Error {
  readonly name = 'WikiReconcilePinnedRetireError';

  constructor(readonly nodeId: string) {
    super(`Pinned page ${nodeId} cannot be independently retired`);
  }
}

class WikiReconcileApplyError extends Error {
  readonly name = 'WikiReconcileApplyError';
}
