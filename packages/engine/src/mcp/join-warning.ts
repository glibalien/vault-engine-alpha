// Shared CROSS_NODE_FILTER_UNRESOLVED computation.
//
// Both `query-nodes` and `update-node` query mode accept join_filters/without_joins,
// and both must warn when unresolved edges could have changed the result. This lived
// as two byte-identical 40-line copies (query-nodes.ts / update-node.ts) that differed
// only in how they spelled the parameter type — exactly the shape where the two drift
// apart and one surface silently stops warning.

import type Database from 'better-sqlite3';
import type { JoinFilter } from './query-builder.js';
import type { Issue } from './tools/errors.js';

/**
 * Warn when a query has join targets AND unresolved edges exist that could have
 * affected it. Unresolved edges are invisible to a join with a target, so a filtered
 * result may be silently short.
 *
 * Scope note: the count is vault-wide per rel_type, not narrowed to the edges this
 * query actually touched — so a handful of genuinely-pending references make it fire
 * on every join over that rel_type. Scoping it to query-affected edges is tracked as
 * backlog item F5; the current behaviour is preserved here verbatim.
 */
export function computeJoinWarning(
  db: Database.Database,
  joinFilters: JoinFilter[] | undefined,
  withoutJoins: JoinFilter[] | undefined,
): Issue | undefined {
  const needsCheck =
    (joinFilters?.some(f => f.target !== undefined) ?? false) ||
    (withoutJoins?.some(f => f.target !== undefined) ?? false);

  if (!needsCheck) return undefined;

  // Collect rel_types that appeared in filters-with-target; missing rel_type means "any".
  const relTypes = new Set<string>();
  let anyRelType = false;
  for (const f of [...(joinFilters ?? []), ...(withoutJoins ?? [])]) {
    if (f.target === undefined) continue;
    if (f.rel_type === undefined) { anyRelType = true; break; }
    const types = Array.isArray(f.rel_type) ? f.rel_type : [f.rel_type];
    for (const t of types) relTypes.add(t);
  }

  let sql = 'SELECT COUNT(*) AS n FROM relationships WHERE resolved_target_id IS NULL';
  const p: unknown[] = [];
  if (!anyRelType && relTypes.size > 0) {
    const placeholders = Array.from(relTypes, () => '?').join(', ');
    sql += ` AND rel_type IN (${placeholders})`;
    p.push(...relTypes);
  }
  const { n } = db.prepare(sql).get(...p) as { n: number };
  if (n > 0) {
    const edges = anyRelType ? ['(any rel_type)'] : Array.from(relTypes);
    return {
      code: 'CROSS_NODE_FILTER_UNRESOLVED',
      severity: 'warning',
      message: `Could not resolve cross-node filter edges: ${edges.join(', ')}`,
      details: { edges },
    };
  }
  return undefined;
}
