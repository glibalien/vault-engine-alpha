// src/undo/link-bindings.ts
//
// Links an operation binds to another note without writing the link's own note (#665).
//
// A merge deletes the notes it folds away. A link whose text already names the kept note (two
// notes with one title, `[[Sam Ortiz]]`) is then bound to the kept note, and its own note is
// not written. Undo restores notes from their snapshots, and that note has none, so nothing
// recorded where its link was bound: the recreated note takes only links bound to nothing,
// and the link stayed on the kept note. So before it changes anything, the operation records
// the note each such link is bound to, and a restore binds it there again once the notes are
// back.

import type Database from 'better-sqlite3';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { TYPED_REFERENCE_EDGE_SQL } from '../resolver/typed-refresh.js';

function hasTable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'undo_link_bindings'").get() !== undefined;
}

/**
 * Record, under an operation, the binding of every link now bound to one of `noteIds`. Runs
 * before the operation changes anything; a link recorded twice keeps its first binding.
 */
export function captureLinkBindings(db: Database.Database, operationId: string, noteIds: readonly string[]): void {
  if (noteIds.length === 0 || !hasTable(db)) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO undo_link_bindings (operation_id, source_id, target, rel_type, bound_to)
    SELECT ?, source_id, target, rel_type, resolved_target_id FROM relationships WHERE resolved_target_id = ?
  `);
  for (const id of noteIds) insert.run(operationId, id);
}

/**
 * Bind each link an operation recorded to the note it was bound to before it, where that note
 * exists again and the link is still there (same note, target and kind). Runs after the
 * operation's notes are restored, in the same transaction. Returns how many links it bound.
 *
 * Under reference policy 2 a typed reference (a field whose definition names the kind of note
 * it takes) is left out: restoring a note recomputes those against the field's definition as
 * it is now, which may have changed since the operation, so an old binding could break it
 * (Codex, #680). Policy 1 has no kind requirement, so every recorded link is bound back.
 */
export function restoreLinkBindings(db: Database.Database, operationId: string): number {
  if (!hasTable(db)) return 0;
  const rows = db.prepare('SELECT source_id, target, rel_type, bound_to FROM undo_link_bindings WHERE operation_id = ?')
    .all(operationId) as Array<{ source_id: string; target: string; rel_type: string; bound_to: string }>;
  const typed = readReferencePolicyVersion(db) === 2 ? `AND NOT (${TYPED_REFERENCE_EDGE_SQL})` : '';
  const bind = db.prepare(`
    UPDATE relationships SET resolved_target_id = @bound_to
    WHERE source_id = @source_id AND target = @target AND rel_type = @rel_type
      AND resolved_target_id IS NOT @bound_to
      AND EXISTS (SELECT 1 FROM nodes WHERE id = @bound_to)
      ${typed}
  `);
  let bound = 0;
  for (const row of rows) bound += bind.run(row).changes;
  return bound;
}
