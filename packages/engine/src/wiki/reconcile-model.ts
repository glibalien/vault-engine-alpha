import type Database from 'better-sqlite3';
import { extractManagedSection } from './sections.js';
import { parseWikiScope } from './scope.js';
import type {
  ProjectDigest,
  WikiCatalogPage,
  WikiOrigin,
} from './digest.js';
import type {
  ResolvedWikiReconcilePlan,
  WikiReconcileTarget,
  WikiReconcileValidationMarker,
} from './reconcile-types.js';
import type {
  WikiReconcileMapping,
  WikiReconcilePreview,
  WikiReconcileWarning,
} from './reconcile.js';
import { loadWikiNodeFields } from './write-helpers.js';
import { reconcileStamp } from './reconcile-content.js';

const PREVIEW_LIMIT = 50;
const PREVIEW_TITLE_LIMIT = 160;

export type StoredWikiNode = {
  readonly id: string;
  readonly title: string;
  readonly filePath: string;
  readonly body: string;
  readonly version: number;
  readonly types: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
};

export type MergeAnalysis = {
  readonly ancestorIds: readonly string[];
  readonly pinned: boolean;
  readonly origin: WikiOrigin;
};

export type CatalogPagePatch = {
  readonly scope: string;
  readonly state: WikiCatalogPage['wiki_state'];
  readonly kind?: WikiCatalogPage['wiki_kind'];
  readonly origin: WikiCatalogPage['wiki_origin'];
  readonly pinned: boolean;
  readonly replacedBy: WikiCatalogPage['wiki_replaced_by'] | null;
};

export function loadStoredWikiNode(db: Database.Database, nodeId: string): StoredWikiNode {
  const row = db.prepare('SELECT id, title, file_path, body, version FROM nodes WHERE id = ?')
    .get(nodeId) as {
      id: string;
      title: string | null;
      file_path: string;
      body: string | null;
      version: number;
    } | undefined;
  if (row === undefined) throw new WikiReconcileStateError(`Wiki node ${nodeId} disappeared after validation`);
  const types = (db.prepare(
    'SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type',
  ).all(nodeId) as Array<{ schema_type: string }>).map(item => item.schema_type);
  return {
    id: row.id,
    title: row.title ?? row.file_path.replace(/\.md$/u, ''),
    filePath: row.file_path,
    body: row.body ?? '',
    version: row.version,
    types,
    fields: loadWikiNodeFields(db, nodeId),
  };
}

export function analyzeMerges(
  plan: ResolvedWikiReconcilePlan,
  pages: readonly WikiCatalogPage[],
): ReadonlyMap<number, MergeAnalysis> {
  const pageById = new Map(pages.map(page => [page.id, page]));
  const analyses = new Map<number, MergeAnalysis>();
  plan.pages.forEach((operation, operationIndex) => {
    if (operation.op !== 'merge') return;
    const sourceIds = new Set(operation.sources.map(source => source.node_id));
    const ancestorIds = pages
      .filter(page => !sourceIds.has(page.id) && chainTraversesSource(page, sourceIds, pageById))
      .map(page => page.id);
    const target = operation.target.mode === 'existing'
      ? pageById.get(operation.target.node_id)
      : undefined;
    const transferPages = [
      ...(target === undefined ? [] : [target]),
      ...operation.sources.flatMap(source => {
        const page = pageById.get(source.node_id);
        return page === undefined ? [] : [page];
      }),
      ...ancestorIds.flatMap(nodeId => {
        const page = pageById.get(nodeId);
        return page === undefined ? [] : [page];
      }),
    ];
    analyses.set(operationIndex, {
      ancestorIds,
      pinned: operation.pinned || transferPages.some(page => page.wiki_pinned),
      origin: operation.origin === 'requested' || transferPages.some(page => page.wiki_origin === 'requested')
        ? 'requested'
        : 'automatic',
    });
  });
  return analyses;
}

export function catalogPageAfterWrite(input: {
  readonly id: string;
  readonly title: string;
  readonly filePath: string;
  readonly version: number;
  readonly contentHash: string;
  readonly body: string;
  readonly patch: CatalogPagePatch;
}): WikiCatalogPage {
  const scope = parseWikiScope(input.patch.scope);
  if (!scope.ok) throw new WikiReconcileStateError(`Executor received non-canonical scope: ${scope.code}`);
  const summary = extractManagedSection(input.body, 'Summary', 1200);
  return {
    id: input.id,
    title: input.title,
    file_path: input.filePath,
    version: input.version,
    content_hash: input.contentHash,
    wiki_state: input.patch.state,
    ...(input.patch.kind === undefined ? {} : { wiki_kind: input.patch.kind }),
    wiki_origin: input.patch.origin,
    wiki_scope: scope.scope,
    ...(input.patch.replacedBy === null ? {} : { wiki_replaced_by: input.patch.replacedBy }),
    wiki_pinned: input.patch.pinned,
    ...(summary === undefined ? {} : { summary }),
  };
}

export function buildReconcilePreview(
  plan: ResolvedWikiReconcilePlan,
  pages: readonly WikiCatalogPage[],
): WikiReconcilePreview {
  const pageById = new Map(pages.map(page => [page.id, page]));
  const items = plan.pages.slice(0, PREVIEW_LIMIT).map(operation => {
    switch (operation.op) {
      case 'upsert':
        return {
          op: operation.op,
          target: targetKey(operation.target),
          title: targetTitle(operation.target, pageById).slice(0, PREVIEW_TITLE_LIMIT),
        };
      case 'merge':
        return {
          op: operation.op,
          target: targetKey(operation.target),
          title: targetTitle(operation.target, pageById).slice(0, PREVIEW_TITLE_LIMIT),
          source_count: operation.sources.length,
        };
      case 'retire':
        return {
          op: operation.op,
          target: operation.node_id,
          title: (pageById.get(operation.node_id)?.title ?? operation.node_id).slice(0, PREVIEW_TITLE_LIMIT),
          state: operation.state,
        };
      default:
        return assertNever(operation);
    }
  });
  return { total: plan.pages.length, items, truncated: plan.pages.length > PREVIEW_LIMIT };
}

export function staleReplacementWarnings(pages: readonly WikiCatalogPage[]): WikiReconcileWarning[] {
  return pages
    .filter(page => page.wiki_state === 'active' && page.wiki_replaced_by?.id !== undefined)
    .map(page => ({
      code: 'STALE_ACTIVE_REPLACEMENT',
      message: `Page ${page.title} is stored active but resolves to replacement ${page.wiki_replaced_by?.title ?? ''}`,
      node_id: page.id,
    }));
}

export function isReusableReconcile(
  catalog: ProjectDigest['existing_wiki'],
  plan: ResolvedWikiReconcilePlan,
  markers: readonly WikiReconcileValidationMarker[],
): boolean {
  const home = catalog.home;
  if (
    home?.wiki_reconcile_key !== reconcileStamp(plan)
    || home.wiki_topology_hash !== catalog.topology_hash
    || home.wiki_evidence_hash !== plan.home.evidence_hash
    || home.wiki_curated_at !== plan.home.curated_at
  ) return false;
  const markedSources = new Set(markers.map(marker => `${marker.operation_index}:${marker.node_id}`));
  return plan.pages.every((operation, operationIndex) =>
    operation.op !== 'merge'
    || operation.sources.every(source => markedSources.has(`${operationIndex}:${source.node_id}`)));
}

export function reuseMappings(
  plan: ResolvedWikiReconcilePlan,
  pages: readonly WikiCatalogPage[],
): WikiReconcileMapping[] {
  const pageById = new Map(pages.map(page => [page.id, page]));
  return plan.pages.flatMap(operation => {
    if (operation.op !== 'merge' || operation.target.mode !== 'existing') return [];
    const target = pageById.get(operation.target.node_id);
    if (target === undefined) return [];
    return operation.sources.map(source => ({
      source_node_id: source.node_id,
      target_node_id: target.id,
      target_title: target.title,
    }));
  });
}

function chainTraversesSource(
  page: WikiCatalogPage,
  sourceIds: ReadonlySet<string>,
  pageById: ReadonlyMap<string, WikiCatalogPage>,
): boolean {
  const visited = new Set<string>();
  let current = page.wiki_replaced_by?.id;
  while (current !== undefined && !visited.has(current)) {
    if (sourceIds.has(current)) return true;
    visited.add(current);
    current = pageById.get(current)?.wiki_replaced_by?.id;
  }
  return false;
}

function targetKey(target: WikiReconcileTarget): string {
  switch (target.mode) {
    case 'existing':
      return target.node_id;
    case 'new':
      return `plan:${target.plan_key}`;
    default:
      return assertNever(target);
  }
}

function targetTitle(
  target: WikiReconcileTarget,
  pageById: ReadonlyMap<string, WikiCatalogPage>,
): string {
  switch (target.mode) {
    case 'existing':
      return pageById.get(target.node_id)?.title ?? target.node_id;
    case 'new':
      return target.title;
    default:
      return assertNever(target);
  }
}

function assertNever(value: never): never {
  throw new WikiReconcileStateError(`Unexpected reconciliation variant: ${JSON.stringify(value)}`);
}

export class WikiReconcileStateError extends Error {
  readonly name = 'WikiReconcileStateError';
}
