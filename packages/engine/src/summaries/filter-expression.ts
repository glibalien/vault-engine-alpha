import type { FilterExpression } from '../filters/expression.js';
import type { DateWindow, SummaryFilter, SummaryFilterLeaf } from './types.js';
export type SummaryFilterNode = {
  kind: 'true';
} | {
  kind: 'static';
  filter: SummaryFilterLeaf;
} | {
  kind: 'date';
  field: string;
  window: DateWindow;
  path: string;
} | {
  kind: 'all' | 'any';
  children: SummaryFilterNode[];
};
function conjunction(children: SummaryFilterNode[]): SummaryFilterNode {
  return children.length === 0 ? { kind: 'true' } : children.length === 1 ? children[0] : { kind: 'all', children };
}
function leafNode(leaf: SummaryFilterLeaf, path: string): SummaryFilterNode {
  const children: SummaryFilterNode[] = [];
  for (const [key, value] of Object.entries(leaf)) {
    if (value === undefined)
      continue;
    if (key === 'fields') {
      for (const [field, predicate] of Object.entries(leaf.fields ?? {}))
        children.push('date_window' in predicate
          ? { kind: 'date', field, window: predicate.date_window, path: `${path}.fields.${field}` }
          : { kind: 'static', filter: { fields: { [field]: predicate } } });
    }
    else
      children.push({ kind: 'static', filter: { [key]: value } });
  }
  return conjunction(children);
}
function expressionNode(expression: FilterExpression<SummaryFilterLeaf>, path: string): SummaryFilterNode {
  if ('all' in expression)
    return { kind: 'all', children: expression.all.map((c, i) => expressionNode(c, `${path}.all[${i}]`)) };
  if ('any' in expression)
    return { kind: 'any', children: expression.any.map((c, i) => expressionNode(c, `${path}.any[${i}]`)) };
  return leafNode(expression, path);
}
export function normalizeSummaryFilter(filter: SummaryFilter): SummaryFilterNode {
  const { where, ...flat } = filter;
  return conjunction([leafNode(flat, 'filter'), ...(where ? [expressionNode(where, 'filter.where')] : [])]);
}
export function projectStatic(node: SummaryFilterNode): SummaryFilterNode {
  if (node.kind === 'date')
    return { kind: 'true' };
  if (node.kind === 'all' || node.kind === 'any')
    return { ...node, children: node.children.map(projectStatic) };
  return node;
}
export function evaluateFilterSet(node: SummaryFilterNode, universe: ReadonlySet<string>, matchAtom: (atom: Extract<SummaryFilterNode, {
  kind: 'static' | 'date';
}>, universe: ReadonlySet<string>) => ReadonlySet<string>): Set<string> {
  if (node.kind === 'true')
    return new Set(universe);
  if (node.kind === 'static' || node.kind === 'date')
    return new Set([...matchAtom(node, universe)].filter(id => universe.has(id)));
  const children = node.children.map(child => evaluateFilterSet(child, universe, matchAtom));
  return node.kind === 'all' ? new Set([...universe].filter(id => children.every(set => set.has(id)))) : new Set(children.flatMap(set => [...set]));
}
export interface TemporalGate {
  atom: Extract<SummaryFilterNode, {
    kind: 'date';
  }>;
  gate: SummaryFilterNode;
}
/** An OR adds no gate; AND siblings contribute their conservative static projection. */
export function temporalValidationGates(node: SummaryFilterNode): TemporalGate[] {
  const gates: TemporalGate[] = [];
  function visit(current: SummaryFilterNode, ancestors: SummaryFilterNode[]): void {
    if (current.kind === 'date') {
      gates.push({ atom: current, gate: conjunction(ancestors) });
      return;
    }
    if (current.kind === 'all' || current.kind === 'any')
      current.children.forEach((child, i) => visit(child, current.kind === 'all' ? [...ancestors, ...current.children.filter((_, j) => j !== i).map(projectStatic)] : ancestors));
  }
  visit(node, []);
  return gates;
}
