import { createHash } from 'node:crypto';
import type { WikiReconcileInput, WikiReconcilePageOperation, WikiReconcileSection, WikiReconcileTarget } from './engine.js';
import type { ReconcileKeyInput, ReconcileWriteInput } from './reconcile-write.js';
import { sameWikiScope, serializeWikiScope } from './topology.js';
import type { NodeRef, PageSynthesisResult, ThemedPageKind, TopologyAction, WikiCatalogPage, WikiSections } from './types.js';
import { ReconcileInvariantError } from './reconcile-write-result.js';

export function buildReconcileKey(input: ReconcileKeyInput): string {
  const normalized = {
    v: 1,
    wiki_root_id: input.wikiRootId,
    evidence_hash: input.evidenceHash,
    topology_hash: input.topologyHash,
    actions: input.plan.actions.map(normalizeAction),
    ...(input.requestedPageRequestId === undefined ? {} : { requested_page_request_id: input.requestedPageRequestId }),
  };
  return `wiki-reconcile:v1:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function buildReconcilePayload(input: ReconcileWriteInput, reconcileKey: string): Omit<WikiReconcileInput, 'dry_run'> {
  const pages = new Map(input.existingWiki.subpages.map(page => [page.id, page]));
  const synthesized = new Map(input.synthesizedPages.map(result => [refKey(result.target), result]));
  const mergePlanTargets = new Set(input.plan.actions.flatMap(action =>
    action.op === 'merge' && 'plan_key' in action.target ? [action.target.plan_key] : [],
  ));
  const payload: Omit<WikiReconcileInput, 'dry_run'> = {
    project: input.project,
    project_id: input.wikiRootId,
    reconcile_key: reconcileKey,
    ...(input.provenanceMode ? { provenance_mode: input.provenanceMode } : {}),
    pages: input.plan.actions.flatMap(action => operation(action, { input, pages, synthesized, mergePlanTargets })),
    home: {
      ...(input.existingWiki.home === null ? {} : { expected_version: input.existingWiki.home.version }),
      sections: homeSections(input.homeSections),
      evidence_hash: input.evidenceHash,
      curated_at: input.curatedAt ?? new Date().toISOString(),
      refresh_live: true,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(input.homeStatus === undefined ? {} : { status: input.homeStatus }),
    },
  };
  if (input.provenanceMode && (!input.provenance || payload.pages.some(page =>
    page.op !== 'retire' && page.sections !== undefined && !page.provenance))) {
    throw new ReconcileInvariantError('Every writing page and home requires a staged capture.');
  }
  return payload;
}

type OperationState = {
  readonly input: ReconcileWriteInput;
  readonly pages: ReadonlyMap<string, WikiCatalogPage>;
  readonly synthesized: ReadonlyMap<string, PageSynthesisResult>;
  readonly mergePlanTargets: ReadonlySet<string>;
};

function operation(action: TopologyAction, state: OperationState): readonly WikiReconcilePageOperation[] {
  switch (action.op) {
    case 'keep': {
      const page = requiredPage(state.pages, action.node_id);
      if (isPathCompressionAncestor(action.node_id, state.input.plan.actions, state.pages)) return [];
      if (page.wiki_scope !== undefined && page.wiki_scope_error === undefined && sameWikiScope(page.wiki_scope, action.scope)) return [];
      return [{ op: 'upsert', target: existingTarget(page), scope: action.scope, ...metadata(page, { node_id: page.id }, state.input.requestedPage) }];
    }
    case 'refresh':
    case 'reactivate': {
      const page = requiredPage(state.pages, action.node_id);
      return [{ op: 'upsert', target: existingTarget(page), scope: action.scope, ...metadata(page, { node_id: page.id }, state.input.requestedPage), ...content(requiredSynthesis(state.synthesized, { node_id: page.id })) }];
    }
    case 'create':
      return state.mergePlanTargets.has(action.plan_key) ? [] : [{ op: 'upsert', target: { mode: 'new', plan_key: action.plan_key, title: action.title }, scope: action.scope, ...metadata(action, { plan_key: action.plan_key }, state.input.requestedPage), ...content(requiredSynthesis(state.synthesized, { plan_key: action.plan_key })) }];
    case 'merge': {
      const identity = targetIdentity(action.target, state.pages, state.input.plan.actions);
      return [{
        op: 'merge', target: reconcileTarget(action.target, identity),
        sources: action.sources.map(nodeId => {
          const page = requiredPage(state.pages, nodeId);
          return { node_id: page.id, expected_version: page.version };
        }),
        scope: action.scope, kind: identity.kind,
        origin: requested(action.target, state.input.requestedPage) ? 'requested' : identity.origin,
        pinned: requested(action.target, state.input.requestedPage) || identity.pinned,
        reason: action.reason, ...content(requiredSynthesis(state.synthesized, action.target)),
      }];
    }
    case 'retire': {
      const page = requiredPage(state.pages, action.node_id);
      return [{ op: 'retire', node_id: page.id, expected_version: page.version, scope: action.scope, state: action.state, reason: action.reason }];
    }
    default:
      return assertNever(action);
  }
}

type TargetIdentity = {
  readonly title: string;
  readonly kind: ThemedPageKind;
  readonly origin: 'automatic' | 'requested';
  readonly pinned: boolean;
  readonly page?: WikiCatalogPage;
};

function targetIdentity(ref: NodeRef, pages: ReadonlyMap<string, WikiCatalogPage>, actions: readonly TopologyAction[]): TargetIdentity {
  if ('node_id' in ref) {
    const page = requiredPage(pages, ref.node_id);
    return { title: page.title, kind: page.wiki_kind ?? 'freeform', origin: page.wiki_origin, pinned: page.wiki_pinned, page };
  }
  const create = actions.find((action): action is Extract<TopologyAction, { op: 'create' }> => action.op === 'create' && action.plan_key === ref.plan_key);
  if (create === undefined) throw new ReconcileInvariantError(`missing create ${ref.plan_key}`);
  return { title: create.title, kind: create.kind, origin: 'automatic', pinned: false };
}

function reconcileTarget(ref: NodeRef, identity: TargetIdentity): WikiReconcileTarget {
  if ('plan_key' in ref) return { mode: 'new', plan_key: ref.plan_key, title: identity.title };
  return existingTarget(requiredValue(identity.page, `missing target ${ref.node_id}`));
}

function metadata(source: WikiCatalogPage | Extract<TopologyAction, { op: 'create' }>, ref: NodeRef, request: ReconcileWriteInput['requestedPage']) {
  const isRequested = requested(ref, request);
  if ('id' in source) return { kind: source.wiki_kind ?? 'freeform', origin: isRequested ? 'requested' as const : source.wiki_origin, pinned: isRequested || source.wiki_pinned };
  return { kind: source.kind, origin: isRequested ? 'requested' as const : 'automatic' as const, pinned: isRequested };
}

export function isPathCompressionAncestor(nodeId: string, actions: readonly TopologyAction[], pages: ReadonlyMap<string, WikiCatalogPage>): boolean {
  const mergeSources = new Set(actions.flatMap(action => action.op === 'merge' ? action.sources : []));
  const seen = new Set([nodeId]);
  let cursor = pages.get(nodeId)?.wiki_replaced_by?.id;
  while (cursor !== undefined && !seen.has(cursor)) {
    if (mergeSources.has(cursor)) return true;
    seen.add(cursor);
    cursor = pages.get(cursor)?.wiki_replaced_by?.id;
  }
  return false;
}

function normalizeAction(action: TopologyAction): unknown {
  switch (action.op) {
    case 'keep': return { op: action.op, node_id: action.node_id, scope: serializeWikiScope(action.scope) };
    case 'refresh': case 'reactivate': return { op: action.op, node_id: action.node_id, scope: serializeWikiScope(action.scope), synthesis_brief: action.synthesis_brief };
    case 'create': return { op: action.op, plan_key: action.plan_key, title: action.title, kind: action.kind, scope: serializeWikiScope(action.scope), synthesis_brief: action.synthesis_brief };
    case 'merge': return { op: action.op, target: refKey(action.target), sources: [...action.sources], scope: serializeWikiScope(action.scope), reason: action.reason, synthesis_brief: action.synthesis_brief };
    case 'retire': return { op: action.op, node_id: action.node_id, scope: serializeWikiScope(action.scope), state: action.state, reason: action.reason };
    default: return assertNever(action);
  }
}

export function homeSections(sections: WikiSections): WikiReconcileSection[] {
  return [
    ...(sections.at_a_glance === undefined ? [] : [{ name: 'At a glance', mode: 'replace' as const, content: sections.at_a_glance }]),
    { name: 'Now', mode: 'replace', content: sections.now }, { name: 'Focus', mode: 'replace', content: sections.focus },
    { name: 'Open threads', mode: 'replace', content: sections.open_threads },
    ...(sections.sources === undefined ? [] : [{ name: 'Sources', mode: 'replace' as const, content: sections.sources }]),
    { name: 'Log', mode: 'append', content: sections.log_entry },
  ];
}

function content(result: PageSynthesisResult) {
  return { sections: synthesisSections(result), ...(result.provenance ? { provenance: result.provenance } : {}) };
}

export function synthesisSections(result: PageSynthesisResult): WikiReconcileSection[] {
  return [{ name: 'Summary', mode: 'replace', content: result.body }, ...(result.log_note === undefined ? [] : [{ name: 'Log', mode: 'append' as const, content: result.log_note }])];
}

function existingTarget(page: WikiCatalogPage): WikiReconcileTarget { return { mode: 'existing', node_id: page.id, expected_version: page.version }; }
function requested(ref: NodeRef, request: ReconcileWriteInput['requestedPage']): boolean { return request !== undefined && refKey(request.target) === refKey(ref); }
function requiredPage(pages: ReadonlyMap<string, WikiCatalogPage>, id: string): WikiCatalogPage { return requiredValue(pages.get(id), `missing catalog page ${id}`); }
function requiredSynthesis(results: ReadonlyMap<string, PageSynthesisResult>, ref: NodeRef): PageSynthesisResult { return requiredValue(results.get(refKey(ref)), `missing synthesized page ${refKey(ref)}`); }
function requiredValue<T>(value: T | undefined, detail: string): T { if (value === undefined) throw new ReconcileInvariantError(detail); return value; }
function refKey(ref: NodeRef): string { return 'node_id' in ref ? `node:${ref.node_id}` : `plan:${ref.plan_key}`; }
function assertNever(value: never): never { throw new ReconcileInvariantError(`Unsupported topology action: ${JSON.stringify(value)}`); }
