import { localDate } from './date-line.js';
import type { PlannerMemory, PlannerSource } from './prompts/topology.js';
import { targetKey } from './stage-checkpoints.js';
import type { EngineNode, ExistingWiki, Memory, NodeRef, TopologyAction, TopologyPlan } from './types.js';

/**
 * Which notes each project sub-page reads (#474 idea 3). The planner reads every note in full,
 * as before, and now names the sources each page's writer reads (`evidence_ids`, as topic
 * planners already did). Before, every page writer got every note and decided its content
 * alone: two writes from the same evidence came out at 3.2 KB and 5.6 KB with different risks.
 */

/** The notes a project planner can give a page: the build's reads, less the project note (every
 *  page gets it) and the wiki's own pages. */
export function plannerSources(nodes: readonly EngineNode[], rootId: string, wiki: ExistingWiki, timeZone?: string): PlannerSource[] {
  const excluded = new Set([rootId, wiki.home_id, ...wiki.subpages.map(page => page.id)]);
  return nodes.filter(node => !excluded.has(node.id)).map(node => {
    const mtime = node.metadata?.file_mtime;
    return { id: node.id, title: node.title ?? node.file_path ?? node.id, types: [...node.types],
      ...(typeof mtime === 'number' && Number.isFinite(mtime) ? { modified: localDate(mtime, timeZone) } : {}) };
  });
}

/** The memories a project planner can mark as a page's rules (#474 idea 4): the build's memories
 *  about the project. The owner's own memories already apply to every page. */
export function plannerMemories(memories: readonly Memory[]): PlannerMemory[] {
  return memories.filter(memory => memory.source !== 'owner')
    .map(memory => ({ id: memory.id, category: memory.category, text: memory.content.replace(/\s+/g, ' ').trim() }));
}

/** The page a writing action writes. */
function actionTarget(action: Exclude<TopologyAction, { op: 'keep' | 'retire' }>): NodeRef {
  return action.op === 'merge' ? action.target : action.op === 'create' ? { plan_key: action.plan_key } : { node_id: action.node_id };
}

/** The memories the planner marked as each planned page's rules, keyed like pageEvidenceIds. */
export function pageRuleIds(plan: TopologyPlan): Record<string, number[]> {
  const out: Record<string, number[]> = Object.create(null);
  for (const action of plan.actions) {
    if (action.op === 'keep' || action.op === 'retire' || !action.rule_ids || action.rule_ids.length === 0) continue;
    const key = targetKey(actionTarget(action));
    out[key] = [...new Set([...(out[key] ?? []), ...action.rule_ids])];
  }
  return out;
}

/**
 * The notes each planned page's writer reads, keyed by its target as `targetKey` writes it
 * (`node:<page id>` or `plan:<plan_key>`, so a plan key can't collide with a page id): the
 * project note, then the sources the planner named. A page the planner named
 * none for is left out, so its writer reads every note, as before. A merge into a planned create
 * reads what both name.
 */
export function pageEvidenceIds(plan: TopologyPlan, rootId: string): Record<string, string[]> {
  // Keyed by planner-chosen plan keys, so no inherited properties: "constructor" is a valid key.
  const out: Record<string, string[]> = Object.create(null);
  for (const action of plan.actions) {
    if (action.op === 'keep' || action.op === 'retire' || !action.evidence_ids || action.evidence_ids.length === 0) continue;
    const key = targetKey(actionTarget(action));
    out[key] = [...new Set([rootId, ...(out[key] ?? []), ...action.evidence_ids])];
  }
  return out;
}

/** The notes a written page read, or undefined when it read every note. A created page (or a
 *  merge into one) is found by its title, the only thing a write result shares with its create. */
export function writtenPageReads(page: { readonly node_id: string; readonly title: string }, plan: TopologyPlan,
  idsByTarget: Readonly<Record<string, readonly string[]>>): readonly string[] | undefined {
  const own = (key: string) => Object.hasOwn(idsByTarget, key) ? idsByTarget[key] : undefined;
  const byNode = own(targetKey({ node_id: page.node_id }));
  if (byNode) return byNode;
  const create = plan.actions.find(action => action.op === 'create' && action.title === page.title);
  return create?.op === 'create' ? own(targetKey({ plan_key: create.plan_key })) : undefined;
}

/**
 * The plan with each held page kept as it was (#474 idea 4): a page whose drafts both broke a
 * rule on what to say isn't written, and the rest of the build is. A refresh or reactivation
 * becomes a keep; a planned new page isn't created; a merge doesn't happen, so its target and
 * sources are all kept. Each kept page keeps its own scope.
 */
export function withHeldPages(plan: TopologyPlan, held: readonly { readonly target: NodeRef }[], wiki: ExistingWiki): TopologyPlan {
  if (held.length === 0) return plan;
  const heldKeys = new Set(held.map(page => targetKey(page.target)));
  const scopes = new Map(wiki.subpages.map(page => [page.id, page.wiki_scope]));
  const keep = (id: string, fallback: TopologyAction['scope']): TopologyAction => ({ op: 'keep', node_id: id, scope: scopes.get(id) ?? fallback });
  // A retired page whose replaced-by chain leads into a held merge was kept under the merge's new
  // scope, as a historical ancestor; with the merge cancelled that keep would read as a scope repair
  // and reactivate it, so it keeps its own scope.
  const heldMergePages = new Set(plan.actions.flatMap(action => action.op === 'merge' && heldKeys.has(targetKey(action.target))
    ? [...action.sources, ...('node_id' in action.target ? [action.target.node_id] : [])] : []));
  const replacedBy = new Map(wiki.subpages.map(page => [page.id, page.wiki_replaced_by?.id]));
  const leadsIntoHeldMerge = (id: string): boolean => {
    const seen = new Set([id]);
    for (let cursor = replacedBy.get(id); cursor !== undefined && !seen.has(cursor); cursor = replacedBy.get(cursor)) {
      if (heldMergePages.has(cursor)) return true;
      seen.add(cursor);
    }
    return false;
  };
  const droppedCreates = new Set(plan.actions.flatMap(action =>
    action.op === 'merge' && heldKeys.has(targetKey(action.target)) && 'plan_key' in action.target ? [action.target.plan_key]
      : action.op === 'create' && heldKeys.has(targetKey({ plan_key: action.plan_key })) ? [action.plan_key] : []));
  return { ...plan, actions: plan.actions.flatMap((action): TopologyAction[] => {
    switch (action.op) {
      case 'refresh':
      case 'reactivate':
        return heldKeys.has(targetKey({ node_id: action.node_id })) ? [keep(action.node_id, action.scope)] : [action];
      case 'create':
        return droppedCreates.has(action.plan_key) ? [] : [action];
      case 'merge':
        return heldKeys.has(targetKey(action.target))
          ? [...('node_id' in action.target ? [keep(action.target.node_id, action.scope)] : []), ...action.sources.map(id => keep(id, action.scope))]
          : [action];
      case 'keep':
        return heldMergePages.size > 0 && leadsIntoHeldMerge(action.node_id) ? [keep(action.node_id, action.scope)] : [action];
      default:
        return [action];
    }
  }) };
}

