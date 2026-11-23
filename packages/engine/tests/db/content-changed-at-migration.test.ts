import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { upgradeForContentChangedAt } from '../../src/db/migrate.js';

// A legacy nodes table WITHOUT content_changed_at (pre-migration shape).
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, file_path TEXT UNIQUE NOT NULL, title TEXT, body TEXT,
    content_hash TEXT, file_mtime INTEGER, indexed_at INTEGER, created_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1
  );`);
  return db;
}

describe('upgradeForContentChangedAt', () => {
  it('adds the column and backfills it from file_mtime', () => {
    const db = legacyDb();
    db.prepare('INSERT INTO nodes (id, file_path, file_mtime, indexed_at) VALUES (?,?,?,?)')
      .run('n1', 'N.md', 1000, 1000);
    upgradeForContentChangedAt(db);
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('content_changed_at');
    const row = db.prepare('SELECT content_changed_at FROM nodes WHERE id = ?').get('n1') as { content_changed_at: number };
    expect(row.content_changed_at).toBe(1000);
  });

  it('is idempotent (safe to run twice)', () => {
    const db = legacyDb();
    upgradeForContentChangedAt(db);
    expect(() => upgradeForContentChangedAt(db)).not.toThrow();
  });
});
