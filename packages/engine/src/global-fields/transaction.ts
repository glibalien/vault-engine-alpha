import type Database from 'better-sqlite3';

/** Commit a field mutation and its node projections together, or restore both. */
export function withGlobalFieldTransaction<T>(
  db: Database.Database,
  mutate: (fsRollback: { push(undo: () => void): void }) => T,
): T {
  const fsUndos: Array<() => void> = [];
  try {
    return db.transaction(() => mutate(fsUndos))();
  } catch (err) {
    // SQLite has rolled back. The pipeline callbacks restore only bytes still
    // owned by this attempt, leaving concurrent edits and renames untouched.
    for (let i = fsUndos.length - 1; i >= 0; i--) {
      try {
        fsUndos[i]!();
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error(`[global-field] filesystem rollback failed: ${message}`);
      }
    }
    throw err;
  }
}
