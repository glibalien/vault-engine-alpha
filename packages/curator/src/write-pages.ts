import type { AcceptedPageIndexEntry } from './page-synthesis.js';
import type { ExistingWiki, ThemedPageResult, TopologyPlan, TopologyResult } from './types.js';

type SkipGateInput = {
  readonly existingWiki: ExistingWiki;
  readonly evidenceHash: string;
  readonly force: boolean;
  readonly refreshDue: boolean;
};

export function shouldSkipReconciliation(input: SkipGateInput): boolean {
  const { existingWiki } = input;
  return !input.force
    && !input.refreshDue
    && existingWiki.home !== null
    && existingWiki.home.wiki_evidence_hash === input.evidenceHash
    && existingWiki.home.wiki_topology_hash === existingWiki.topology_hash
    && existingWiki.catalog_valid
    && existingWiki.subpages.every(page => page.wiki_scope !== undefined)
    && replacementGraphHealthy(existingWiki);
}

/** Only task evidence changed and the wiki is otherwise unchanged and healthy, so the
 *  Engine live sections can be re-rendered without synthesis. */
export function canRefreshLiveOnly(input: SkipGateInput & { readonly taskOnlyChange: boolean }): boolean {
  const { existingWiki } = input;
  return input.taskOnlyChange
    && !input.force
    && !input.refreshDue
    && existingWiki.home !== null
    && existingWiki.home.wiki_topology_hash === existingWiki.topology_hash
    && existingWiki.catalog_valid
    && existingWiki.subpages.every(page => page.wiki_scope !== undefined)
    && replacementGraphHealthy(existingWiki);
}

export function topologyToThemed(topology: readonly TopologyResult[]): ThemedPageResult[] {
  return topology.map(result => {
    switch (result.action) {
      case 'created':
        return { kind: result.kind ?? 'freeform', title: result.title, action: 'created', state: 'active' };
      case 'refreshed':
      case 'reactivated':
      case 'adopted':
      case 'merged-target':
        return { kind: result.kind ?? 'freeform', title: result.title, action: 'updated', state: 'active' };
      case 'dormant':
        return { kind: result.kind ?? 'freeform', title: result.title, action: 'dormant', state: 'dormant', ...(result.detail === undefined ? {} : { detail: result.detail }) };
      case 'retired':
      case 'merged-source':
        return { kind: result.kind ?? 'freeform', title: result.title, action: 'retired', state: 'retired', ...(result.detail === undefined ? {} : { detail: result.detail }) };
      case 'kept':
        return { kind: result.kind ?? 'freeform', title: result.title, action: 'skipped', state: 'active' };
      case 'ambiguous-create-skipped':
        return { kind: 'freeform', title: result.title, action: 'skipped', detail: result.reason };
      case 'preview':
        return { kind: 'freeform', title: result.title, action: 'preview' };
      case 'error':
        return { kind: 'freeform', title: result.title ?? result.node_id ?? '(unknown)', action: 'error', detail: result.detail };
      default:
        return assertNever(result);
    }
  });
}

export function acceptedPageIndex(plan: TopologyPlan, existingWiki: ExistingWiki): readonly AcceptedPageIndexEntry[] {
  const pages = new Map(existingWiki.subpages.map(page => [page.id, page]));
  const creates = new Map(plan.actions.flatMap(action => action.op === 'create' ? [[action.plan_key, action] as const] : []));
  const mergeCreateTargets = new Set(plan.actions.flatMap(action => action.op === 'merge' && 'plan_key' in action.target ? [action.target.plan_key] : []));
  const entries: AcceptedPageIndexEntry[] = [];
  for (const action of plan.actions) {
    switch (action.op) {
      case 'keep':
      case 'refresh':
      case 'reactivate':
      case 'retire': {
        const page = pages.get(action.node_id);
        if (page !== undefined) entries.push({ target: { node_id: page.id }, title: page.title, scope: action.scope, action: action.op });
        break;
      }
      case 'create':
        if (!mergeCreateTargets.has(action.plan_key)) entries.push({ target: { plan_key: action.plan_key }, title: action.title, scope: action.scope, action: action.op });
        break;
      case 'merge': {
        const title = 'node_id' in action.target
          ? pages.get(action.target.node_id)?.title
          : creates.get(action.target.plan_key)?.title;
        if (title !== undefined) entries.push({ target: action.target, title, scope: action.scope, action: action.op });
        break;
      }
      default:
        assertNever(action);
    }
  }
  return entries;
}

function replacementGraphHealthy(existingWiki: ExistingWiki): boolean {
  const pages = new Map(existingWiki.subpages.map(page => [page.id, page]));
  for (const page of existingWiki.subpages) {
    const replacementId = page.wiki_replaced_by?.id;
    if (page.wiki_replaced_by !== undefined && (replacementId === undefined || !pages.has(replacementId))) return false;
    const seen = new Set([page.id]);
    let cursor = replacementId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = pages.get(cursor)?.wiki_replaced_by?.id;
    }
  }
  return true;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected topology variant: ${JSON.stringify(value)}`);
}
