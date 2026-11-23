import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { upgradeToMemories, upgradeToMemoriesV2 } from '../../src/db/migrate.js';

function v1Db(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY);');
  upgradeToMemories(db);
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe('upgradeToMemoriesV2', () => {
  it('adds the four bi-temporal columns and the partial live index', () => {
    const db = v1Db();
    upgradeToMemoriesV2(db);
    const cols = columns(db, 'memories');
    expect(cols).toEqual(expect.arrayContaining(['expired_at', 'valid_at', 'invalid_at', 'superseded_by']));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_live'").get();
    expect(idx).toBeTruthy();
  });

  it('backfills valid_at = created_at for existing rows', () => {
    const db = v1Db();
    db.prepare(
      "INSERT INTO memories (source, scope, content, created_at, updated_at) VALUES ('chat','vault','hi','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    ).run();
    upgradeToMemoriesV2(db);
    const row = db.prepare("SELECT valid_at, created_at FROM memories WHERE content='hi'").get() as {
      valid_at: string;
      created_at: string;
    };
    expect(row.valid_at).toBe(row.created_at);
  });

  it('is idempotent (safe to run twice)', () => {
    const db = v1Db();
    upgradeToMemoriesV2(db);
    expect(() => upgradeToMemoriesV2(db)).not.toThrow();
    expect(columns(db, 'memories').filter((c) => c === 'valid_at')).toHaveLength(1);
  });
});
