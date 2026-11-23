import { binaryCompare } from '../summaries/evaluate.js';
import type { TraversalEdge } from './types.js';
/** Tarjan components on the bounded returned graph, never on uninspected adjacency. */
export function cyclicComponents(
  nodeIds: readonly string[],
  edges: readonly TraversalEdge[],
): string[][] {
  const neighbors = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const selfLoops = new Set<string>();
  for (const edge of edges) {
    neighbors.get(edge.source_id)!.push(edge.target_id);
    if (edge.source_id === edge.target_id) selfLoops.add(edge.source_id);
  }
  const index = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>(),
    result: string[][] = [];
  let next = 0;
  const visit = (id: string): void => {
    index.set(id, next);
    low.set(id, next++);
    stack.push(id);
    active.add(id);
    for (const neighbor of neighbors.get(id)!) {
      if (!index.has(neighbor)) {
        visit(neighbor);
        low.set(id, Math.min(low.get(id)!, low.get(neighbor)!));
      } else if (active.has(neighbor))
        low.set(id, Math.min(low.get(id)!, index.get(neighbor)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      members.push(member);
    } while (member !== id);
    if (members.length > 1 || selfLoops.has(id))
      result.push(members.sort(binaryCompare));
  };
  for (const id of nodeIds) if (!index.has(id)) visit(id);
  return result.sort((a, b) => binaryCompare(a[0], b[0]));
}
