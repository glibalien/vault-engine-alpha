import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

describe('resolved-target startup backfill', () => {
  it('populates resolved_target_id on pre-existing NULL rows', () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('A', 'Foo.md', 'Foo', '', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src', 'Source.md', 'Source', '', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('src', 'Foo', 'wiki-link');

    const stats = backfillResolvedTargets(db);
    expect(stats.updated).toBe(1);

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('src') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).toBe('A');
  });

  it('runs on every startup (no version gate) and is cheap when nothing is pending', () => {
    // The backfill is no longer one-shot: every startup re-runs it after
    // fullIndex so files created while the engine was down still resolve
    // inbound pending edges (2026-06-12 triage, Cause C).
    const stats = backfillResolvedTargets(db);
    expect(stats).toEqual({ scanned: 0, uniqueTargets: 0, updated: 0 });
  });
});
