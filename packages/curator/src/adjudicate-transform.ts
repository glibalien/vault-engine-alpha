import { wikiScopeComparisonKey } from './topology.js';
import type { AdjudicationMatrixVerdict, AdjudicationPair } from './adjudicate-matrix.js';
import type {
  AdjudicationVerdict,
  ExistingWiki,
  NodeRef,
  TopologyAction,
  TopologyPlan,
  TopologyResult,
  WikiCatalogPage,
} from './types.js';

type CreateAction = Extract<TopologyAction, { op: 'create' }>;

export type ExactMatchRewriteResult = {
  readonly plan: TopologyPlan;
  readonly verdicts: readonly AdjudicationVerdict[];
};

export type SemanticAdjudication = {
  readonly pairs: readonly AdjudicationPair[];
  readonly verdicts: readonly AdjudicationMatrixVerdict[];
};

export type CreateSkip = {
  readonly planKeys: readonly string[];
  readonly reason: string;
  readonly verdicts?: readonly AdjudicationMatrixVerdict[];
};

export function rewriteExactCreateMatches(
  plan: TopologyPlan,
  existingWiki: ExistingWiki,
): ExactMatchRewriteResult {
  const creates = createActions(plan);
  const groups = new Map<string, CreateAction[]>();
  for (const candidate of creates) {
    const key = wikiScopeComparisonKey(candidate.scope);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }

  let transformed = plan;
  const verdicts: AdjudicationVerdict[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => compareCodePoints(left.plan_key, right.plan_key));
    const survivor = group[0];
    if (survivor === undefined) continue;
    const members = group.map(candidate => candidate.plan_key);
    transformed = foldCreateGroup(transformed, members, survivor.plan_key);
    for (const candidate of group.slice(1)) {
      verdicts.push(exactVerdict(candidate.plan_key, { plan_key: survivor.plan_key }));
    }
  }

  const pagesByScope = canonicalPagesByScope(existingWiki.subpages);
  for (const candidate of createActions(transformed).sort((left, right) => compareCodePoints(left.plan_key, right.plan_key))) {
    const target = pagesByScope.get(wikiScopeComparisonKey(candidate.scope))?.[0];
    if (target === undefined) continue;
    transformed = rewriteCreateToExisting(transformed, candidate.plan_key, target);
    verdicts.push(exactVerdict(candidate.plan_key, { node_id: target.id }));
  }

  const pageById = new Map(existingWiki.subpages.map(page => [page.id, page]));
  for (const candidate of createActions(transformed).sort((left, right) => compareCodePoints(left.plan_key, right.plan_key))) {
    const merge = transformed.actions
      .filter((action): action is Extract<TopologyAction, { op: 'merge' }> => action.op === 'merge')
      .filter(action => wikiScopeComparisonKey(action.scope) === wikiScopeComparisonKey(candidate.scope))
      .sort((left, right) => compareCodePoints(refKey(left.target), refKey(right.target)))[0];
    if (merge === undefined) continue;
    if ('node_id' in merge.target) {
      const target = pageById.get(merge.target.node_id);
      if (target === undefined) continue;
      transformed = rewriteCreateToExisting(transformed, candidate.plan_key, target);
    } else {
      transformed = foldCreateGroup(transformed, [candidate.plan_key, merge.target.plan_key], merge.target.plan_key);
    }
    verdicts.push(exactVerdict(candidate.plan_key, merge.target));
  }
  return { plan: transformed, verdicts };
}

export function applySameScopeTransformations(
  plan: TopologyPlan,
  existingWiki: ExistingWiki,
  adjudication: SemanticAdjudication,
): TopologyPlan {
  const createKeys = createActions(plan).map(candidate => candidate.plan_key);
  const parent = new Map(createKeys.map(key => [key, key]));
  const pairById = new Map(adjudication.pairs.map(pair => [pair.pair_id, pair]));
  for (const verdict of adjudication.verdicts) {
    if (verdict.relation !== 'same-scope' || !('plan_key' in verdict.compared_to)) continue;
    union(parent, verdict.candidate_plan_key, verdict.compared_to.plan_key);
  }

  const groups = new Map<string, string[]>();
  for (const key of createKeys) {
    const root = findRoot(parent, key);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [key]);
    else group.push(key);
  }

  const targetIds = new Map<string, string[]>();
  for (const verdict of adjudication.verdicts) {
    if (verdict.relation !== 'same-scope' || !('node_id' in verdict.compared_to)) continue;
    const pair = pairById.get(verdict.pair_id);
    if (pair === undefined) continue;
    const root = findRoot(parent, pair.candidate_plan_key);
    const ids = targetIds.get(root);
    if (ids === undefined) targetIds.set(root, [verdict.compared_to.node_id]);
    else ids.push(verdict.compared_to.node_id);
  }

  const pages = new Map(existingWiki.subpages.map(page => [page.id, page]));
  let transformed = plan;
  for (const [root, memberKeys] of groups) {
    memberKeys.sort(compareCodePoints);
    const survivor = memberKeys[0];
    if (survivor === undefined) continue;
    transformed = foldCreateGroup(transformed, memberKeys, survivor);
    const targetId = targetIds.get(root)?.sort(compareCodePoints)[0];
    const target = targetId === undefined ? undefined : pages.get(targetId);
    if (target !== undefined) transformed = rewriteCreateToExisting(transformed, survivor, target);
  }
  return transformed;
}

export function dropCreateCandidates(
  plan: TopologyPlan,
  planKeys: readonly string[],
): TopologyPlan {
  const dropped = new Set(planKeys);
  return {
    ...plan,
    actions: plan.actions.filter(action => {
      if (action.op === 'create') return !dropped.has(action.plan_key);
      if (action.op === 'merge' && 'plan_key' in action.target) return !dropped.has(action.target.plan_key);
      return true;
    }),
  };
}

export function buildSkippedCreateResults(
  plan: TopologyPlan,
  skip: CreateSkip,
): readonly TopologyResult[] {
  const dropped = new Set(skip.planKeys);
  const verdictByKey = new Map((skip.verdicts ?? []).map(verdict => [verdict.candidate_plan_key, verdict]));
  return createActions(plan)
    .filter(candidate => dropped.has(candidate.plan_key))
    .map(candidate => ({
      action: 'ambiguous-create-skipped',
      plan_key: candidate.plan_key,
      title: candidate.title,
      scope: candidate.scope,
      reason: skip.reason,
      ...(verdictByKey.get(candidate.plan_key) === undefined ? {} : { verdict: verdictByKey.get(candidate.plan_key) }),
    }));
}

export function collectPinTransfers(
  plan: TopologyPlan,
  existingWiki: ExistingWiki,
): readonly { readonly source_node_id: string; readonly target: NodeRef }[] {
  const pinned = new Set(existingWiki.subpages.filter(page => page.wiki_pinned).map(page => page.id));
  return plan.actions.flatMap(action => action.op === 'merge'
    ? action.sources.filter(source => pinned.has(source)).map(source => ({ source_node_id: source, target: action.target }))
    : []);
}

function foldCreateGroup(plan: TopologyPlan, memberKeys: readonly string[], survivorKey: string): TopologyPlan {
  const members = new Set(memberKeys);
  const memberActions = createActions(plan)
    .filter(candidate => members.has(candidate.plan_key))
    .sort((left, right) => compareCodePoints(left.plan_key, right.plan_key));
  const briefs = memberActions.map(candidate => candidate.synthesis_brief);
  return {
    ...plan,
    actions: plan.actions.flatMap(action => {
      if (action.op === 'create' && members.has(action.plan_key)) {
        return action.plan_key === survivorKey ? [{ ...action, ...combinedEvidence(memberActions), synthesis_brief: briefs.join('\n\n') }] : [];
      }
      if (action.op === 'merge' && 'plan_key' in action.target && members.has(action.target.plan_key)) {
        return [{ ...action, target: { plan_key: survivorKey } }];
      }
      return [action];
    }),
  };
}

function rewriteCreateToExisting(plan: TopologyPlan, planKey: string, target: WikiCatalogPage): TopologyPlan {
  const candidate = createActions(plan).find(action => action.plan_key === planKey);
  if (candidate === undefined) return plan;
  const isMergeTarget = plan.actions.some(action => action.op === 'merge' && (
    ('plan_key' in action.target && action.target.plan_key === planKey)
    || ('node_id' in action.target && action.target.node_id === target.id)
  ));
  let replacedTerminal = false;
  const actions = plan.actions.flatMap(action => {
    if (action.op === 'create' && action.plan_key === planKey) return [];
    if (action.op === 'merge' && 'plan_key' in action.target && action.target.plan_key === planKey) {
      return [{ ...action, target: { node_id: target.id }, ...combinedEvidence([action, candidate]), synthesis_brief: `${action.synthesis_brief}\n\n${candidate.synthesis_brief}` }];
    }
    if (action.op === 'merge' && 'node_id' in action.target && action.target.node_id === target.id) {
      return [{ ...action, ...combinedEvidence([action, candidate]), synthesis_brief: `${action.synthesis_brief}\n\n${candidate.synthesis_brief}` }];
    }
    if ('node_id' in action && action.node_id === target.id) {
      if (isMergeTarget) return [];
      if (replacedTerminal) return [];
      replacedTerminal = true;
      return [existingRewrite(target, candidate, action)];
    }
    return [action];
  });
  if (!isMergeTarget && !replacedTerminal) actions.push(existingRewrite(target, candidate));
  return { ...plan, actions };
}

/** The existing page's action, rewritten to the create it absorbs. It keeps the create's sources,
 *  and the rules both marked (#474 idea 4): a rule marked only on the replaced action would
 *  otherwise be lost, since it isn't on the page yet. */
function existingRewrite(target: WikiCatalogPage, candidate: CreateAction, replaced?: TopologyAction): TopologyAction {
  const rules = [...new Set([...(candidate.rule_ids ?? []), ...(replaced && 'rule_ids' in replaced ? replaced.rule_ids ?? [] : [])])];
  const fields = { ...combinedEvidence([candidate]), ...(rules.length > 0 ? { rule_ids: rules } : {}) };
  return target.wiki_state === 'active'
    ? { op: 'refresh', node_id: target.id, scope: candidate.scope, synthesis_brief: candidate.synthesis_brief, ...fields }
    : { op: 'reactivate', node_id: target.id, scope: candidate.scope, synthesis_brief: candidate.synthesis_brief, ...fields };
}

function canonicalPagesByScope(pages: readonly WikiCatalogPage[]): ReadonlyMap<string, WikiCatalogPage[]> {
  const byScope = new Map<string, WikiCatalogPage[]>();
  for (const page of pages) {
    if (page.wiki_scope === undefined) continue;
    const key = wikiScopeComparisonKey(page.wiki_scope);
    const group = byScope.get(key);
    if (group === undefined) byScope.set(key, [page]);
    else group.push(page);
  }
  for (const group of byScope.values()) group.sort((left, right) => compareCodePoints(left.id, right.id));
  return byScope;
}

function createActions(plan: TopologyPlan): CreateAction[] {
  return plan.actions.filter((action): action is CreateAction => action.op === 'create');
}

function exactVerdict(candidatePlanKey: string, comparedTo: NodeRef): AdjudicationVerdict {
  return { candidate_plan_key: candidatePlanKey, compared_to: comparedTo, relation: 'same-scope', confidence: 1, evidence_ids: [], reason: 'Exact wiki-scope comparison-key match.' };
}

function refKey(ref: NodeRef): string {
  return 'node_id' in ref ? `node:${ref.node_id}` : `plan:${ref.plan_key}`;
}

function findRoot(parent: Map<string, string>, key: string): string {
  let cursor = key;
  while (parent.get(cursor) !== undefined && parent.get(cursor) !== cursor) cursor = parent.get(cursor) ?? cursor;
  return cursor;
}

function union(parent: Map<string, string>, left: string, right: string): void {
  if (!parent.has(left) || !parent.has(right)) return;
  const leftRoot = findRoot(parent, left);
  const rightRoot = findRoot(parent, right);
  const survivor = compareCodePoints(leftRoot, rightRoot) <= 0 ? leftRoot : rightRoot;
  parent.set(leftRoot, survivor);
  parent.set(rightRoot, survivor);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function combinedEvidence(actions: readonly TopologyAction[]): { evidence_ids?: string[]; rule_ids?: number[] } {
  const writing = actions.filter(a => 'synthesis_brief' in a);
  // A combined page keeps every rule any of its actions marked (#474 idea 4).
  const rules = [...new Set(writing.flatMap(a => 'rule_ids' in a ? a.rule_ids ?? [] : []))];
  const ruleIds = rules.length > 0 ? { rule_ids: rules } : {};
  if (writing.some(a => !('evidence_ids' in a) || a.evidence_ids === undefined)) return { evidence_ids: undefined, ...ruleIds };
  return { evidence_ids: [...new Set(writing.flatMap(a => 'evidence_ids' in a ? a.evidence_ids ?? [] : []))], ...ruleIds };
}
