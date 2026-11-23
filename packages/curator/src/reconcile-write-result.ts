import type { Issue } from '@vault/contract';
import type { OutputReceipt } from './provenance-types.js';
import type { WikiReconcilePageOperation, WikiReconcileResult } from './engine.js';
import type { ReconcileWriteInput, ReconcileWriteResult } from './reconcile-write.js';
import { sameWikiScope } from './topology.js';
import type { NodeRef, ThemedPageKind, TopologyAction, TopologyResult, WikiCatalogPage, WikiScopeV1 } from './types.js';

export class ReconcileInvariantError extends Error {
  override readonly name = 'ReconcileInvariantError';
}

export function assertCreatedTargets(data: WikiReconcileResult, operations: readonly WikiReconcilePageOperation[]): void {
  const allowed = new Set(operations.flatMap(operation => operation.op !== 'retire' && operation.target.mode === 'new' ? [operation.target.title] : []));
  if (data.created.some(node => !allowed.has(node.title)) || data.created.length > allowed.size) {
    throw new ReconcileInvariantError('Engine created a target that the accepted plan did not mark as new.');
  }
}

export function translateReconcileResult(
  input: ReconcileWriteInput,
  reconcileKey: string,
  data: WikiReconcileResult,
  warnings: readonly Issue[],
  previewWarnings: WikiReconcileResult['warnings'] = [],
  operations: readonly WikiReconcilePageOperation[] = [],
): ReconcileWriteResult {
  const capturedTargets = validateCapturedReceipts(input, reconcileKey, data, operations);
  return {
    reconcileKey,
    data,
    topology: topologyResults(input, data, capturedTargets),
    mappings: data.mappings,
    topologyHash: data.topology_hash,
    homeOutcome: data.home,
    warnings: [...warnings, ...previewWarnings, ...data.warnings],
  };
}

export function validateCapturedReceipts(input: Pick<ReconcileWriteInput, 'provenanceMode' | 'dryRun' | 'provenance'>, reconcileKey: string, data: WikiReconcileResult,
  operations: readonly WikiReconcilePageOperation[]): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  if (!input.provenanceMode || input.dryRun) return targets;
  const invalid = (): never => { throw new ReconcileInvariantError('Engine returned an incomplete or inconsistent captured batch.'); };
  const receipts = data.provenance_receipts ?? invalid();
  const capturedOperations = operations.filter((operation): operation is Exclude<WikiReconcilePageOperation, { op: 'retire' }> =>
    operation.op !== 'retire' && operation.sections !== undefined);
  const homeBinding = input.provenance ?? invalid();
  const homeReceipt = data.provenance_receipt ?? invalid();
  if (receipts.length !== capturedOperations.length + 1
    || !data.operation_id || data.reconcile_key !== reconcileKey) invalid();
  const bindings = [homeBinding, ...capturedOperations.map(operation => operation.provenance)];
  if (bindings.some(binding => !binding)) invalid();
  const seenDerivations = new Set<string>();
  const seenNodes = new Set<string>();
  const seenOutputs = new Set<string>();
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index]!;
    if (receipt.derivation_id !== bindings[index]!.derivation_id || receipt.reconcile_key !== reconcileKey
      || receipt.operation_id !== data.operation_id || !receipt.request_digest
      || receipt.request_digest !== homeReceipt.request_digest
      || seenDerivations.has(receipt.derivation_id) || seenNodes.has(receipt.output_node_id)
      || seenOutputs.has(receipt.output_revision_id)) invalid();
    seenDerivations.add(receipt.derivation_id);
    seenNodes.add(receipt.output_node_id);
    seenOutputs.add(receipt.output_revision_id);
    if (index === 0) {
      if (!sameReceipt(receipt, homeReceipt)
        || receipt.output_node_id !== data.home.node_id || receipt.committed_node_version !== data.home.version) invalid();
      continue;
    }
    const operation = capturedOperations[index - 1]!;
    const match = [...data.created, ...data.updated].find(node => node.node_id === receipt.output_node_id
      && node.version === receipt.committed_node_version);
    if (!match) invalid();
    if (operation.target.mode === 'existing') {
      if (operation.target.node_id !== receipt.output_node_id) invalid();
    } else {
      const target = operation.target;
      if (!data.created.some(node => node.node_id === receipt.output_node_id && node.version === receipt.committed_node_version
        && node.title === target.title)) invalid();
      targets.set(`plan:${target.plan_key}`, receipt.output_node_id);
    }
    if (operation.op === 'merge' && operation.sources.some(source => !data.mappings.some(mapping =>
      mapping.source_node_id === source.node_id && mapping.target_node_id === receipt.output_node_id))) invalid();
  }
  return targets;
}

function sameReceipt(left: OutputReceipt, right: OutputReceipt): boolean {
  return left.derivation_id === right.derivation_id && left.output_revision_id === right.output_revision_id
    && left.output_node_id === right.output_node_id && left.committed_node_version === right.committed_node_version
    && left.committed_at === right.committed_at && left.operation_id === right.operation_id
    && left.reconcile_key === right.reconcile_key && left.request_digest === right.request_digest
    && (left.replaces_output_revision_id ?? null) === (right.replaces_output_revision_id ?? null);
}

function topologyResults(input: ReconcileWriteInput, data: WikiReconcileResult, capturedTargets: ReadonlyMap<string, string>): TopologyResult[] {
  const pages = new Map(input.existingWiki.subpages.map(page => [page.id, page]));
  const results: TopologyResult[] = [];
  for (const action of input.plan.actions) results.push(...actionResults(action, input.plan.actions, pages, data, capturedTargets));
  return results;
}

function actionResults(
  action: TopologyAction,
  actions: readonly TopologyAction[],
  pages: ReadonlyMap<string, WikiCatalogPage>,
  data: WikiReconcileResult,
  capturedTargets: ReadonlyMap<string, string>,
): readonly TopologyResult[] {
  switch (action.op) {
    case 'keep': {
      const page = requiredPage(pages, action.node_id);
      const adopted = !isPathCompressionAncestor(page.id, actions, pages)
        && (page.wiki_scope === undefined || page.wiki_scope_error !== undefined || !sameWikiScope(page.wiki_scope, action.scope));
      return [stable(adopted ? 'adopted' : 'kept', page, action.scope)];
    }
    case 'refresh':
    case 'reactivate':
      return [stable(action.op === 'refresh' ? 'refreshed' : 'reactivated', requiredPage(pages, action.node_id), action.scope)];
    case 'create': {
      const created = capturedTargets.has(`plan:${action.plan_key}`) ? undefined : data.created.find(node => node.title === action.title);
      return [{ action: 'created', node_id: capturedTargets.get(`plan:${action.plan_key}`) ?? created?.node_id ?? `plan:${action.plan_key}`, title: action.title, scope: action.scope, kind: action.kind }];
    }
    case 'merge': {
      const identity = targetIdentity(action.target, pages, actions);
      const targetId = 'node_id' in action.target
        ? action.target.node_id
        : capturedTargets.get(`plan:${action.target.plan_key}`)
          ?? data.mappings.find(mapping => action.sources.includes(mapping.source_node_id))?.target_node_id ?? `plan:${action.target.plan_key}`;
      return [
        { action: 'merged-target', node_id: targetId, title: identity.title, scope: action.scope, ...(identity.kind === undefined ? {} : { kind: identity.kind }), source_node_ids: [...action.sources] },
        ...action.sources.map(sourceId => {
          const source = requiredPage(pages, sourceId);
          return { ...stableBase(source, action.scope), action: 'merged-source' as const, target_node_id: targetId, target_title: identity.title };
        }),
      ];
    }
    case 'retire':
      return [{ ...stableBase(requiredPage(pages, action.node_id), action.scope), action: action.state, detail: action.reason }];
    default:
      return assertNever(action);
  }
}

function targetIdentity(ref: NodeRef, pages: ReadonlyMap<string, WikiCatalogPage>, actions: readonly TopologyAction[]): { readonly title: string; readonly kind?: ThemedPageKind } {
  if ('node_id' in ref) {
    const page = requiredPage(pages, ref.node_id);
    return { title: page.title, ...(page.wiki_kind === undefined ? {} : { kind: page.wiki_kind }) };
  }
  const create = actions.find(action => action.op === 'create' && action.plan_key === ref.plan_key);
  if (create?.op !== 'create') throw new ReconcileInvariantError(`missing create ${ref.plan_key}`);
  return { title: create.title, kind: create.kind };
}

function stable(action: 'kept' | 'adopted' | 'refreshed' | 'reactivated', page: WikiCatalogPage, scope: WikiScopeV1): TopologyResult {
  return { ...stableBase(page, scope), action };
}

function stableBase(page: WikiCatalogPage, scope: WikiScopeV1) {
  return { node_id: page.id, title: page.title, scope, ...(page.wiki_kind === undefined ? {} : { kind: page.wiki_kind }) };
}

function isPathCompressionAncestor(nodeId: string, actions: readonly TopologyAction[], pages: ReadonlyMap<string, WikiCatalogPage>): boolean {
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

function requiredPage(pages: ReadonlyMap<string, WikiCatalogPage>, nodeId: string): WikiCatalogPage {
  const page = pages.get(nodeId);
  if (page === undefined) throw new ReconcileInvariantError(`missing catalog page ${nodeId}`);
  return page;
}

function assertNever(value: never): never {
  throw new ReconcileInvariantError(`Unsupported topology action: ${JSON.stringify(value)}`);
}
