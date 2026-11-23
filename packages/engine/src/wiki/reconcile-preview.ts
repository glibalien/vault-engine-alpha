import type { WikiCatalogPage } from './digest.js';
import { computeWikiTopologyHash } from './topology.js';
import { mergeManagedSections } from './sections.js';
import type {
  WikiReconcileDeps,
  WikiReconcileHomeResult,
  WikiReconcileMapping,
  WikiReconcileNodeResult,
  WikiReconcileWarning,
  ValidatedWikiReconcilePlan,
} from './reconcile.js';
import {
  analyzeMerges,
  loadStoredWikiNode,
  staleReplacementWarnings,
} from './reconcile-model.js';
import { retirementStatus } from './reconcile-content.js';
import { wikiTimeZone } from './today.js';
import {
  previewMarkerSet,
  previewNodeResult,
  previewTargetBody,
  previewTargetPatch,
  replacePreviewPage,
  requiredPreviewPage,
  resolvePreviewTarget,
  simulatedPage,
  PreviewStateError,
} from './reconcile-preview-model.js';
import {
  buildCurrentWikiDigest,
  buildWikiFilePath,
  buildWikiPageTitle,
  renderWikiLiveSections,
} from './write-helpers.js';

export type WikiReconcileSimulation = {
  readonly created: readonly WikiReconcileNodeResult[];
  readonly updated: readonly WikiReconcileNodeResult[];
  readonly mappings: readonly WikiReconcileMapping[];
  readonly home: WikiReconcileHomeResult;
  readonly topologyHash: string;
  readonly warnings: readonly WikiReconcileWarning[];
};

export function simulateWikiReconcile(
  deps: WikiReconcileDeps,
  validated: ValidatedWikiReconcilePlan,
  catalogPages: readonly WikiCatalogPage[],
): WikiReconcileSimulation {
  const plan = validated.plan;
  const working = new Map(catalogPages.map(page => [page.id, page]));
  const analyses = analyzeMerges(plan, catalogPages);
  const targets = new Map<string, WikiCatalogPage>();
  const created: WikiReconcileNodeResult[] = [];
  const updated = new Map<string, WikiReconcileNodeResult>();
  const mappings: WikiReconcileMapping[] = [];
  const satisfied = previewMarkerSet(validated.markers);
  const homeTitle = buildWikiPageTitle(plan.project.title, 'home', undefined, plan.home.title_suffix);
  const timeZone = wikiTimeZone(deps.db);

  plan.pages.forEach((operation, operationIndex) => {
    if (operation.op === 'retire' || operation.target.mode !== 'new') return;
    const id = `plan:${operation.target.plan_key}`;
    const filePath = buildWikiFilePath(deps.config.wikiDir, operation.target.title);
    const body = previewTargetBody({ plan, operation, working, currentBody: '' });
    const patch = previewTargetPatch(operation, analyses.get(operationIndex));
    const page = simulatedPage({ id, title: operation.target.title, filePath, version: 1, body, patch });
    working.set(id, page);
    targets.set(operation.target.plan_key, page);
    created.push(previewNodeResult(page));
  });

  plan.pages.forEach((operation, operationIndex) => {
    switch (operation.op) {
      case 'upsert': {
        if (operation.target.mode === 'new') break;
        const current = requiredPreviewPage(working, operation.target.node_id);
        const stored = loadStoredWikiNode(deps.db, current.id);
        const body = mergeManagedSections(stored.body, {
          live: {},
          managed: [...(operation.sections ?? [])],
        }).body;
        replacePreviewPage({ working, updated, current, body, patch: previewTargetPatch(operation) });
        break;
      }
      case 'merge': {
        const target = resolvePreviewTarget(operation, working, targets);
        if (operation.target.mode === 'existing') {
          const stored = loadStoredWikiNode(deps.db, target.id);
          const body = previewTargetBody({ plan, operation, working, currentBody: stored.body });
          replacePreviewPage({
            working,
            updated,
            current: target,
            body,
            patch: previewTargetPatch(operation, analyses.get(operationIndex)),
          });
        }
        for (const source of operation.sources) {
          mappings.push({
            source_node_id: source.node_id,
            target_node_id: target.id,
            target_title: target.title,
          });
          if (satisfied.has(`${operationIndex}:${source.node_id}`)) continue;
          const current = requiredPreviewPage(working, source.node_id);
          const stored = loadStoredWikiNode(deps.db, current.id);
          const body = mergeManagedSections(stored.body, {
            live: {},
            managed: [{
              name: 'Status',
              mode: 'replace',
              content: retirementStatus(plan, {
                state: 'retired',
                reason: operation.reason,
                targetTitle: target.title,
              }, timeZone),
            }],
          }).body;
          replacePreviewPage({ working, updated, current, body, patch: {
            scope: operation.scope,
            state: 'retired',
            ...(current.wiki_kind === undefined ? {} : { kind: current.wiki_kind }),
            origin: current.wiki_origin,
            pinned: false,
            replacedBy: { id: target.id, title: target.title },
          } });
        }
        for (const ancestorId of analyses.get(operationIndex)?.ancestorIds ?? []) {
          const current = requiredPreviewPage(working, ancestorId);
          const stored = loadStoredWikiNode(deps.db, current.id);
          replacePreviewPage({ working, updated, current, body: stored.body, patch: {
            scope: operation.scope,
            state: current.wiki_state,
            ...(current.wiki_kind === undefined ? {} : { kind: current.wiki_kind }),
            origin: current.wiki_origin,
            pinned: false,
            replacedBy: { id: target.id, title: target.title },
          } });
        }
        break;
      }
      case 'retire': {
        const current = requiredPreviewPage(working, operation.node_id);
        const stored = loadStoredWikiNode(deps.db, current.id);
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
        replacePreviewPage({ working, updated, current, body, patch: {
          scope: operation.scope,
          state: operation.state,
          ...(current.wiki_kind === undefined ? {} : { kind: current.wiki_kind }),
          origin: current.wiki_origin,
          pinned: current.wiki_pinned,
          replacedBy: current.wiki_replaced_by ?? null,
        } });
        break;
      }
      default:
        throw new PreviewStateError(`Unexpected preview variant: ${JSON.stringify(operation)}`);
    }
  });

  const pages = [...working.values()];
  const topologyHash = computeWikiTopologyHash(pages);
  if (plan.page_refresh) {
    // As in publication, the home isn't written, so its version stands and its text isn't merged.
    if (plan.home.node_id === null) throw new PreviewStateError('Page refresh requires an existing home');
    const stored = loadStoredWikiNode(deps.db, plan.home.node_id);
    return {
      created,
      updated: [...updated.values()],
      mappings,
      home: { node_id: stored.id, title: stored.title, file_path: stored.filePath, version: stored.version, created: false },
      topologyHash,
      warnings: staleReplacementWarnings(pages),
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
  const home = plan.home.node_id === null ? null : loadStoredWikiNode(deps.db, plan.home.node_id);
  mergeManagedSections(home?.body ?? '', { live, managed: [...plan.home.sections] });
  return {
    created,
    updated: [...updated.values()],
    mappings,
    home: {
      node_id: home?.id ?? null,
      title: home?.title ?? homeTitle,
      file_path: home?.filePath ?? buildWikiFilePath(deps.config.wikiDir, homeTitle),
      version: home === null ? 1 : home.version + 1,
      created: home === null,
    },
    topologyHash,
    warnings: staleReplacementWarnings(pages),
  };
}
