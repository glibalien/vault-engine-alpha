import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Opens the curator's SQLite DB (its first DB — holds OAuth tables now and the
 * `runs` table in step 7). Mirrors the engine's connection.ts minus sqlite-vec:
 * the curator never stores vectors.
 */
export function openCuratorDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
