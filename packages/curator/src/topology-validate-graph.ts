import { wikiScopeComparisonKey } from './topology.js';
import type { NodeRef, TopologyAction, WikiCatalogPage, WikiScopeV1 } from './types.js';
import type { TopologyPlanIssue } from './topology-validate.js';

export function validatePathCompressionAcknowledgments(
  actions: readonly TopologyAction[],
  pages: readonly WikiCatalogPage[],
): readonly TopologyPlanIssue[] {
  const replacement = new Map(pages.flatMap(page => page.wiki_replaced_by?.id === undefined ? [] : [[page.id, page.wiki_replaced_by.id]]));
  const sourceScope = new Map<string, WikiScopeV1>();
  for (const action of actions) if (action.op === 'merge') for (const source of action.sources) sourceScope.set(source, action.scope);

  const issues: TopologyPlanIssue[] = [];
  for (const action of actions) {
    if (action.op !== 'keep') continue;
    const finalScope = compressionTargetScope(action.node_id, replacement, sourceScope);
    if (finalScope !== undefined && wikiScopeComparisonKey(action.scope) !== wikiScopeComparisonKey(finalScope)) {
      issues.push({
        code: 'PATH_COMPRESSION_PLAN_CONFLICT',
        message: `Keep scope for "${action.node_id}" does not match its final merge target scope.`,
        node_id: action.node_id,
      });
    }
  }
  return issues;
}

export function validateReplacementCycles(
  actions: readonly TopologyAction[],
  pages: readonly WikiCatalogPage[],
): readonly TopologyPlanIssue[] {
  const knownIds = new Set(pages.map(page => page.id));
  const current = new Map<string, string>();
  for (const page of pages) {
    const replacementId = page.wiki_replaced_by?.id;
    if (replacementId !== undefined && knownIds.has(replacementId)) current.set(`node:${page.id}`, `node:${replacementId}`);
  }
  const overlaid = new Map(current);
  for (const action of actions) {
    if (action.op !== 'merge') continue;
    const target = refKey(action.target);
    for (const source of action.sources) overlaid.set(`node:${source}`, target);
  }

  const currentCycles = findCycles(current);
  return [...findCycles(overlaid)]
    .filter(cycle => !currentCycles.has(cycle))
    .map(cycle => ({ code: 'NEW_REPLACEMENT_CYCLE', message: `Plan introduces replacement cycle ${cycle}.` }));
}

function compressionTargetScope(
  start: string,
  replacement: ReadonlyMap<string, string>,
  sourceScope: ReadonlyMap<string, WikiScopeV1>,
): WikiScopeV1 | undefined {
  const visited = new Set<string>([start]);
  let cursor = replacement.get(start);
  while (cursor !== undefined && !visited.has(cursor)) {
    const scope = sourceScope.get(cursor);
    if (scope !== undefined) return scope;
    visited.add(cursor);
    cursor = replacement.get(cursor);
  }
  return undefined;
}

function findCycles(edges: ReadonlyMap<string, string>): ReadonlySet<string> {
  const cycles = new Set<string>();
  for (const start of [...edges.keys()].sort()) {
    const path: string[] = [];
    const indexByNode = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !indexByNode.has(cursor)) {
      indexByNode.set(cursor, path.length);
      path.push(cursor);
      cursor = edges.get(cursor);
    }
    if (cursor === undefined) continue;
    const cycleStart = indexByNode.get(cursor);
    if (cycleStart !== undefined) cycles.add(canonicalCycle(path.slice(cycleStart)));
  }
  return cycles;
}

function canonicalCycle(nodes: readonly string[]): string {
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)].join(' -> '));
  rotations.sort();
  return rotations[0] ?? '';
}

function refKey(ref: NodeRef): string {
  return 'node_id' in ref ? `node:${ref.node_id}` : `plan:${ref.plan_key}`;
}
