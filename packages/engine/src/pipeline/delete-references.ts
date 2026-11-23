import type Database from 'better-sqlite3';

/** Natural key of a relationship row: UNIQUE(source_id, target, rel_type). */
export type ReferenceKey = [source_id: string, target: string, rel_type: string];

/**
 * Incoming edges a deletion can affect: raw title/path matches plus edges
 * bound to the node by any resolver tier. The node's own outgoing edges are
 * excluded because they disappear with it. Keys rather than row ids survive a
 * later batch op re-deriving the source node's relationships.
 */
export function captureDeletionReferences(
  db: Database.Database,
  node: { node_id: string; title: string; file_path: string },
): ReferenceKey[] {
  const rows = db.prepare(`
    SELECT source_id, target, rel_type FROM relationships
    WHERE source_id != ? AND (target = ? OR target = ? OR resolved_target_id = ?)
  `).all(node.node_id, node.title, node.file_path, node.node_id) as Array<{ source_id: string; target: string; rel_type: string }>;
  return rows.map(row => [row.source_id, row.target, row.rel_type]);
}

/**
 * Counts captured edges that are still present and unresolved in the current
 * (post-deletion) state. Typed-reference policy decides whether a namesake
 * survivor picks up the binding; this reads the stored outcome rather than
 * re-deriving it.
 */
export function countUnresolvedReferences(db: Database.Database, keys: readonly ReferenceKey[]): number {
  if (keys.length === 0) return 0;
  return (db.prepare(`
    SELECT COUNT(*) AS c FROM relationships r
    JOIN json_each(?) k
      ON r.source_id = json_extract(k.value, '$[0]')
     AND r.target = json_extract(k.value, '$[1]')
     AND r.rel_type = json_extract(k.value, '$[2]')
    WHERE r.resolved_target_id IS NULL
  `).get(JSON.stringify(keys)) as { c: number }).c;
}
