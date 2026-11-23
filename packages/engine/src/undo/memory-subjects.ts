// src/undo/memory-subjects.ts
//
// Memory subjects an operation moves (#554, Codex on #691).
//
// A merge points the subjects linked to a merged note at the kept note, and drops one of two
// subjects when a memory names both notes. Undo restores notes from their snapshots, which hold
// no memory rows, so before it changes anything the merge records each subject linked to a
// merged note, and a restore puts it back: the link to its old note, and a dropped row again.
// The memories' own `node_id` and `evidence_node_id` are not recorded here: the merge moves them
// too, and undo has never moved those back (#645).

import type Database from 'better-sqlite3';

function hasTable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'undo_memory_subjects'").get() !== undefined;
}

/**
 * Record, under an operation, every subject linked to one of `mergedIds`, and what the merge
 * will leave of it: linked to `keptId`, or dropped. The merge moves the notes' subjects in
 * `mergedIds` order (`moveSubjects`), and drops a note's subject where the memory already names
 * the kept note, which a subject of an earlier merged note has come to do by then (Codex, #691).
 * Runs before the operation changes anything.
 */
export function captureMemorySubjects(db: Database.Database, operationId: string, keptId: string, mergedIds: readonly string[]): void {
  if (mergedIds.length === 0 || !hasTable(db)) return;
  mergedIds.forEach((id, index) => {
    const before = [keptId, ...mergedIds.slice(0, index)];
    db.prepare(`
      INSERT OR IGNORE INTO undo_memory_subjects (operation_id, memory_id, name, name_key, node_id, set_by, created_at, kept_id, dropped)
      SELECT ?, s.memory_id, s.name, s.name_key, s.node_id, s.set_by, s.created_at, ?,
        EXISTS (SELECT 1 FROM memory_subjects k WHERE k.memory_id = s.memory_id AND k.node_id IN (${before.map(() => '?').join(', ')}))
      FROM memory_subjects s WHERE s.node_id = ?
    `).run(operationId, keptId, ...before, id);
  });
}

/**
 * Put back each subject an operation recorded that is still as the operation left it: one it
 * linked to the kept note is linked to its old note again, while it still points at the kept
 * note; one it dropped is added again, while the memory still has no subject of that name. A
 * subject edited since (pointed at another note, removed, added again) is left as it is, and so
 * is a memory purged since (Codex, #691). Runs after the operation's notes are restored, in the
 * same transaction. Returns how many it put back.
 */
export function restoreMemorySubjects(db: Database.Database, operationId: string): number {
  if (!hasTable(db)) return 0;
  const rows = db.prepare(
    'SELECT memory_id, name, name_key, node_id, set_by, created_at, kept_id, dropped FROM undo_memory_subjects WHERE operation_id = ?',
  ).all(operationId) as Array<{
    memory_id: number; name: string; name_key: string; node_id: string; set_by: string; created_at: string; kept_id: string; dropped: number;
  }>;
  const memory = db.prepare('SELECT 1 FROM memories WHERE id = ?');
  const current = db.prepare('SELECT node_id FROM memory_subjects WHERE memory_id = ? AND name_key = ?');
  const relink = db.prepare('UPDATE memory_subjects SET node_id = ? WHERE memory_id = ? AND name_key = ? AND node_id = ?');
  const insert = db.prepare(
    'INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const touch = db.prepare('UPDATE memories SET updated_at = ? WHERE id = ? AND updated_at < ?');
  const now = new Date().toISOString();
  let restored = 0;
  for (const row of rows) {
    if (memory.get(row.memory_id) === undefined) continue;
    const present = current.get(row.memory_id, row.name_key) as { node_id: string | null } | undefined;
    if (row.dropped) {
      if (present !== undefined) continue;
      insert.run(row.memory_id, row.name, row.name_key, row.node_id, row.set_by, row.created_at);
    } else if (present?.node_id === row.kept_id) {
      relink.run(row.node_id, row.memory_id, row.name_key, row.kept_id);
    } else {
      continue;
    }
    touch.run(now, row.memory_id, now);
    restored++;
  }
  return restored;
}
