import { createHash } from 'node:crypto';
import type { WikiCatalogPage } from './digest.js';
import { mergeManagedSections } from './sections.js';
import type {
  ResolvedWikiReconcilePageOperation,
  WikiReconcileValidationMarker,
} from './reconcile-types.js';
import type {
  ValidatedWikiReconcilePlan,
  WikiReconcileNodeResult,
} from './reconcile.js';
import {
  catalogPageAfterWrite,
  type CatalogPagePatch,
} from './reconcile-model.js';
import { mergeLogEntry } from './reconcile-content.js';

export function previewTargetBody(input: {
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
  const sourceTitles = input.operation.sources
    .map(source => requiredPreviewPage(input.working, source.node_id).title);
  const targetTitle = input.operation.target.mode === 'new'
    ? input.operation.target.title
    : requiredPreviewPage(input.working, input.operation.target.node_id).title;
  return mergeManagedSections(withSections, {
    live: {},
    managed: [{ name: 'Log', mode: 'append', content: mergeLogEntry(input.plan, sourceTitles, targetTitle) }],
  }).body;
}

export function previewTargetPatch(
  operation: Exclude<ResolvedWikiReconcilePageOperation, { readonly op: 'retire' }>,
  analysis?: { readonly pinned: boolean; readonly origin: 'automatic' | 'requested' },
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

export function replacePreviewPage(input: {
  readonly working: Map<string, WikiCatalogPage>;
  readonly updated: Map<string, WikiReconcileNodeResult>;
  readonly current: WikiCatalogPage;
  readonly body: string;
  readonly patch: CatalogPagePatch;
}): void {
  const page = simulatedPage({
    id: input.current.id,
    title: input.current.title,
    filePath: input.current.file_path,
    version: input.current.version + 1,
    body: input.body,
    patch: input.patch,
  });
  input.working.set(page.id, page);
  input.updated.set(page.id, previewNodeResult(page));
}

export function simulatedPage(input: {
  readonly id: string;
  readonly title: string;
  readonly filePath: string;
  readonly version: number;
  readonly body: string;
  readonly patch: CatalogPagePatch;
}): WikiCatalogPage {
  const contentHash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return catalogPageAfterWrite({ ...input, contentHash });
}

export function resolvePreviewTarget(
  operation: Extract<ResolvedWikiReconcilePageOperation, { readonly op: 'merge' }>,
  working: ReadonlyMap<string, WikiCatalogPage>,
  targets: ReadonlyMap<string, WikiCatalogPage>,
): WikiCatalogPage {
  return operation.target.mode === 'existing'
    ? requiredPreviewPage(working, operation.target.node_id)
    : requiredPreviewPage(targets, operation.target.plan_key);
}

export function requiredPreviewPage(
  pages: ReadonlyMap<string, WikiCatalogPage>,
  key: string,
): WikiCatalogPage {
  const page = pages.get(key);
  if (page === undefined) throw new PreviewStateError(`Missing simulated wiki page ${key}`);
  return page;
}

export function previewMarkerSet(
  markers: readonly WikiReconcileValidationMarker[],
): ReadonlySet<string> {
  return new Set(markers.map(marker => `${marker.operation_index}:${marker.node_id}`));
}

export function previewNodeResult(page: WikiCatalogPage): WikiReconcileNodeResult {
  return { node_id: page.id, title: page.title, file_path: page.file_path, version: page.version };
}

export class PreviewStateError extends Error {
  readonly name = 'PreviewStateError';
}
