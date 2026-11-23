import type Database from 'better-sqlite3';
import { traversalCapacity, TRAVERSAL_LIMITS } from './input.js';
export interface TraversalRawEdge {
  source_id: string;
  target_id: string | null;
}
export function readTraversalEdges(
  db: Database.Database,
  frontier: readonly string[],
  field: string,
  direction: 'incoming' | 'outgoing',
  remaining: number,
): TraversalRawEdge[] {
  const column = direction === 'outgoing' ? 'source_id' : 'resolved_target_id';
  const result: TraversalRawEdge[] = [];
  for (let i = 0; i < frontier.length; i += 200) {
    const batch = frontier.slice(i, i + 200);
    const rows = db
      .prepare(
        // Keep dangling rows in the budget, but classify missing targets as unresolved.
        `SELECT r.source_id,n.id AS target_id FROM relationships r
      LEFT JOIN nodes n ON n.id=r.resolved_target_id
      WHERE r.rel_type=? AND r.${column} IN (${batch.map(() => '?').join(',')})
      ORDER BY r.source_id COLLATE BINARY,r.resolved_target_id COLLATE BINARY,r.target COLLATE BINARY LIMIT ?`,
      )
      .all(
        field,
        ...batch,
        remaining - result.length + 1,
      ) as TraversalRawEdge[];
    if (result.length + rows.length > remaining)
      traversalCapacity('relationships', TRAVERSAL_LIMITS.relationships + 1);
    result.push(...rows);
  }
  return result;
}
export function hasUnresolvedTraversalField(db: Database.Database, field: string): boolean {
  return !!db.prepare(`SELECT 1 FROM relationships r WHERE r.rel_type=?
    AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=r.resolved_target_id) LIMIT 1`).get(field);
}
