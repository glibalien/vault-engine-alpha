/** Engine-owned read-filter structure. Leaf semantics belong to each host. */
export type FilterExpression<L> = L | {
  all: FilterExpression<L>[];
} | {
  any: FilterExpression<L>[];
};
export type FilterProfile = 'query' | 'query-target' | 'summary' | 'fields';
export interface FilterScope {
  filter: unknown;
  profile: FilterProfile;
  path: string;
}
export interface ExpressionLeaf<L> {
  leaf: L;
  path: string;
}
export class FilterExpressionError extends Error {
  readonly code = 'INVALID_PARAMS';
  constructor(message: string, public readonly path: string, public readonly reason: string, public readonly limit?: number) { super(message); }
  get details(): Record<string, unknown> { return { path: this.path, reason: this.reason, ...(this.limit === undefined ? {} : { limit: this.limit }) }; }
}
const limits = { depth: 4, nodes: 64, atoms: 128, operands: 512, bytes: 16384 } as const;
const summaryKeys = ['node_ids', 'without_node_ids', 'types', 'without_types', 'fields', 'title_eq', 'title_contains', 'path_prefix'];
const targetKeys = [...summaryKeys, 'without_fields', 'references', 'without_titles', 'without_title_contains', 'without_path_prefix', 'path_dir', 'modified_since', 'created_since'];
const queryKeys = [...targetKeys, 'full_text', 'full_text_words', 'link_counts', 'join_filters', 'without_joins'];
const profiles = { query: queryKeys, 'query-target': targetKeys, summary: summaryKeys, fields: ['fields'] };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function error(path: string, reason: string, limit?: number): never {
  throw new FilterExpressionError(`Invalid filter expression at ${path}: ${reason}${limit === undefined ? '' : ` (limit ${limit})`}.`, path, reason, limit);
}
/** Only filter positions are traversed; literal field contents cannot become syntax. */
export function hasFilterExpression(filter: unknown): boolean {
  if (!object(filter))
    return false;
  if (Object.hasOwn(filter, 'where'))
    return true;
  return ['join_filters', 'without_joins'].some(key => Array.isArray(filter[key]) && filter[key].some((join: unknown) => object(join) && object(join.target) && Object.hasOwn(join.target, 'where')));
}
export function* walkExpressionLeaves<L>(expression: FilterExpression<L>, path: string): Iterable<ExpressionLeaf<L>> {
  const node = expression as Record<string, unknown>;
  const group = Object.hasOwn(node, 'all') ? 'all' : Object.hasOwn(node, 'any') ? 'any' : undefined;
  if (!group) {
    yield { leaf: expression as L, path };
    return;
  }
  for (const [i, child] of (node[group] as FilterExpression<L>[]).entries())
    yield* walkExpressionLeaves(child, `${path}.${group}[${i}]`);
}
export function* filterLeaves<L extends object>(filter: L & {
  where?: FilterExpression<L>;
}): Iterable<L> {
  const { where, ...flat } = filter;
  yield flat as L;
  if (where !== undefined)
    for (const entry of walkExpressionLeaves(where, 'where'))
      yield entry.leaf;
}
/** Preflight before recursive Zod parsing/SQL. Repetitions count, shared references are not cycles. */
export function assertExpressionBudget(scopes: readonly FilterScope[]): void {
  if (!scopes.some(scope => hasFilterExpression(scope.filter)))
    return;
  const count = { nodes: 0, atoms: 0, operands: 0, bytes: 0 };
  const add = (key: keyof typeof count, n: number, path: string) => { count[key] += n; if (count[key] > limits[key])
    error(path, key, limits[key]); };
  type Frame = FilterScope & {
    expression: boolean;
    depth: number;
    ancestors: ReadonlySet<object>;
    covered: boolean;
  };
  const stack: Frame[] = scopes.map(s => ({ ...s, expression: false, depth: 0, ancestors: new Set(), covered: false }));
  const byteRoots: unknown[] = [];
  const operands = (value: unknown, path: string): void => {
    const pending = [value];
    while (pending.length) {
      const v = pending.pop();
      if (Array.isArray(v)) {
        if (v.length > 512)
          error(path, 'operands', 512);
        if (v.some(item => item !== null && typeof item === 'object'))
          error(path, 'non-scalar operand');
        pending.push(...v);
      }
      else if (object(v))
        error(path, 'non-scalar operand');
      else if (v !== undefined)
        add('operands', 1, path);
    }
  };
  while (stack.length) {
    const frame = stack.pop()!;
    const { filter, profile, path, expression, depth, ancestors, covered } = frame;
    if (!object(filter)) {
      if (expression)
        error(path, 'shape');
      continue;
    }
    if (ancestors.has(filter))
      error(path, 'cycle');
    const nextAncestors = new Set(ancestors).add(filter);
    const group = Object.hasOwn(filter, 'all') ? 'all' : Object.hasOwn(filter, 'any') ? 'any' : undefined;
    if (expression)
      add('nodes', 1, path);
    if (group) {
      if (!expression || Object.keys(filter).length !== 1)
        error(path, 'mixed group');
      if (depth + 1 > limits.depth)
        error(path, 'depth', limits.depth);
      const children = filter[group];
      if (!Array.isArray(children) || children.length < 2 || children.length > 8)
        error(path, 'fanout', 8);
      children.forEach((child, i) => stack.push({ filter: child, profile, path: `${path}.${group}[${i}]`, expression: true, depth: depth + 1, ancestors: nextAncestors, covered }));
      continue;
    }
    let leafAtoms = 0;
    for (const [key, value] of Object.entries(filter)) {
      const at = `${path}.${key}`;
      if (key === 'where') {
        if (expression)
          error(at, 'nested where');
        if (!covered)
          byteRoots.push(value);
        stack.push({ filter: value, profile, path: at, expression: true, depth, ancestors: nextAncestors, covered: true });
        continue;
      }
      if (!profiles[profile].includes(key)) {
        if (expression)
          error(at, 'unsupported leaf key');
        continue;
      }
      if (value === undefined)
        continue;
      if (key === 'join_filters' || key === 'without_joins') {
        if (!Array.isArray(value))
          error(at, 'join shape');
        for (const [i, join] of value.entries()) {
          if (!object(join))
            error(at, 'join shape');
          leafAtoms++;
          add('atoms', 1, at);
          operands(join.rel_type, at);
          if (join.target !== undefined)
            stack.push({ filter: join.target, profile: 'query-target', path: `${at}[${i}].target`, expression: false, depth, ancestors: nextAncestors, covered });
        }
      }
      else if (key === 'link_counts') {
        if (!object(value))
          error(at, 'link_counts shape');
        operands(value.rel_type, at);
        for (const kind of ['incoming', 'outgoing', 'unresolved']) {
          const predicate = value[kind];
          if (predicate === undefined)
            continue;
          if (!object(predicate))
            error(`${at}.${kind}`, 'predicate shape');
          for (const operand of Object.values(predicate)) {
            leafAtoms++;
            add('atoms', 1, `${at}.${kind}`);
            operands(operand, `${at}.${kind}`);
          }
        }
      }
      else if (key === 'fields') {
        if (!object(value))
          error(at, 'fields shape');
        for (const [name, predicate] of Object.entries(value)) {
          if (!object(predicate))
            error(at, 'predicate shape');
          for (const [op, operand] of Object.entries(predicate)) {
            leafAtoms++;
            add('atoms', 1, `${at}.${name}`);
            if ((op === 'in_group' || op === 'is_unclassified') && object(operand)) {
              const keys = op === 'in_group' ? ['schema','group'] : ['schema'];
              if (Object.keys(operand).length !== keys.length || keys.some(key=>typeof operand[key] !== 'string') || Object.keys(operand).some(key=>!keys.includes(key))) error(at, 'classification operand shape');
              for (const val of Object.values(operand)) operands(val, at);
            }
            else if (op === 'date_window' && object(operand))
              for (const val of Object.values(operand))
                operands(val, at);
            else
              operands(operand, at);
          }
        }
      }
      else {
        const n = (key === 'types' || key === 'without_types') && Array.isArray(value) ? value.length : 1;
        leafAtoms += n;
        add('atoms', n, at);
        if (key === 'references' && object(value))
          for (const val of [value.target,value.rel_type])
            operands(val, at);
        else
          operands(value, at);
      }
    }
    if (expression && leafAtoms === 0)
      error(path, 'empty leaf');
  }
  for (const root of byteRoots) {
    let json: string | undefined;
    try {
      json = JSON.stringify(root);
    }
    catch {
      error('where', 'cycle');
    }
    if (json === undefined)
      error('where', 'shape');
    add('bytes', new TextEncoder().encode(json).byteLength, 'where');
  }
}
