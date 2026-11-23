import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { upgradeForExtractionCacheLastUsed } from '../../src/db/migrate.js';
import { createTestDb } from '../helpers/db.js';
import { runRetentionSweeps, PRESERVED_EDITS_LOG_EVENT_TYPES } from '../../src/db/retention.js';

// Pre-migration table shape (no last_used_at), as on the prod DB today.
function createLegacyCacheDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE extraction_cache (
      content_hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      extractor_id TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      metadata_json TEXT,
      extracted_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('upgradeForExtractionCacheLastUsed', () => {
  it('adds the column and backfills existing rows with now (full window before eviction)', () => {
    const db = createLegacyCacheDb();
    db.prepare(
      "INSERT INTO extraction_cache (content_hash, file_path, media_type, extractor_id, extracted_text, extracted_at) VALUES ('h1', 'a.pdf', 'pdf', 'unpdf', 'text', '2025-01-01T00:00:00.000Z')"
    ).run();

    upgradeForExtractionCacheLastUsed(db);

    const cols = (db.prepare('PRAGMA table_info(extraction_cache)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('last_used_at');
    const row = db.prepare("SELECT last_used_at FROM extraction_cache WHERE content_hash = 'h1'").get() as { last_used_at: string };
    expect(row.last_used_at).not.toBeNull();
    // Backfill is "now", NOT extracted_at — existing rows get a fresh window.
    expect(Date.parse(row.last_used_at)).toBeGreaterThan(Date.parse('2026-06-01'));
    db.close();
  });

  it('is idempotent', () => {
    const db = createLegacyCacheDb();
    upgradeForExtractionCacheLastUsed(db);
    expect(() => upgradeForExtractionCacheLastUsed(db)).not.toThrow();
    db.close();
  });
});

describe('runRetentionSweeps — edits_log', () => {
  const DAY = 86_400_000;

  function seedEdit(db: Database.Database, ageDays: number, eventType: string): void {
    db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)')
      .run('n1', Date.now() - ageDays * DAY, eventType, '{}');
  }

  it('deletes rows past retention but keeps fresh rows', () => {
    const db = createTestDb();
    seedEdit(db, 91, 'value-coerced');
    seedEdit(db, 1, 'value-coerced');
    const result = runRetentionSweeps(db, { editsLogRetentionDays: 90 });
    expect(result.editsLogDeleted).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM edits_log').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('NEVER deletes discard-record rows (charter carve-out), regardless of age', () => {
    const db = createTestDb();
    seedEdit(db, 5000, 'value-removed'); // ~13 years old
    runRetentionSweeps(db, { editsLogRetentionDays: 90 });
    const row = db.prepare("SELECT event_type FROM edits_log WHERE event_type = 'value-removed'").get();
    expect(row).toBeDefined();
    db.close();
  });

  it('pins the carve-out list to the event types crud.ts actually writes', () => {
    // Reminder-pin, not an enforced linkage: if crud.ts ever writes a second
    // discard-record event type, update PRESERVED_EDITS_LOG_EVENT_TYPES and
    // this list together.
    expect(PRESERVED_EDITS_LOG_EVENT_TYPES).toEqual(['value-removed']);
  });
});

describe('runRetentionSweeps — extraction_cache', () => {
  function seedCache(db: Database.Database, hash: string, lastUsedAt: string | null): void {
    db.prepare(
      'INSERT INTO extraction_cache (content_hash, file_path, media_type, extractor_id, extracted_text, extracted_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(hash, 'f.pdf', 'pdf', 'unpdf', 'text', '2026-01-01T00:00:00.000Z', lastUsedAt);
  }

  it('evicts rows unused past retention, keeps recent and NULL rows', () => {
    const db = createTestDb();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    seedCache(db, 'old', old);
    seedCache(db, 'recent', recent);
    seedCache(db, 'legacy-null', null); // defensive: NULL = treat as fresh

    const result = runRetentionSweeps(db, { extractionCacheRetentionDays: 30 });

    expect(result.extractionCacheEvicted).toBe(1);
    const hashes = (db.prepare('SELECT content_hash FROM extraction_cache ORDER BY content_hash').all() as { content_hash: string }[]).map(r => r.content_hash);
    expect(hashes).toEqual(['legacy-null', 'recent']);
    db.close();
  });
});

describe('runRetentionSweeps — embedding_vec orphan sweep', () => {
  it('deletes orphaned embedding_vec rows and preserves rows backed by embedding_meta', () => {
    const db = createTestDb();

    // Seed a node and a VALID (meta + vec) pair.
    db.prepare(
      "INSERT INTO nodes (id, file_path, title) VALUES ('n1', 'a.md', 'A')"
    ).run();
    const validMeta = db.prepare(
      "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n1', 'node', 'h1', 0, NULL, '2026-01-01')"
    ).run();
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
      .run(BigInt(validMeta.lastInsertRowid), new Uint8Array(1024));

    // Seed an ORPHAN vec row with no backing embedding_meta row.
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (999, ?)')
      .run(new Uint8Array(1024));

    // Verify setup: 2 vec rows before sweep.
    expect((db.prepare('SELECT COUNT(*) AS c FROM embedding_vec').get() as { c: number }).c).toBe(2);

    const result = runRetentionSweeps(db, {});

    // Exactly one orphan swept; the valid pair survives.
    expect(result.embeddingVecOrphansDeleted).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM embedding_vec').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM embedding_meta').get() as { c: number }).c).toBe(1);

    db.close();
  });
});

describe('runRetentionSweeps — memory_embedding_vec orphan sweep', () => {
  function seedMemoryVec(db: Database.Database, id: number): void {
    db.prepare('INSERT INTO memory_embedding_vec (id, vector) VALUES (?, ?)')
      .run(BigInt(id), new Uint8Array(1024));
  }

  it('deletes orphaned memory_embedding_vec rows and preserves rows backed by a memories.vec_id', () => {
    const db = createTestDb();

    // Seed a VALID memory row referencing a vec row.
    seedMemoryVec(db, 1);
    db.prepare(
      "INSERT INTO memories (source, scope, content, vec_id, created_at, updated_at) VALUES ('user', 'vault', 'remember this', 1, '2026-01-01', '2026-01-01')"
    ).run();

    // Seed an ORPHAN vec row with no memories row pointing at it (simulates a
    // nodes-cascade delete of the owning memory, or a crash mid-delete).
    seedMemoryVec(db, 999);

    expect((db.prepare('SELECT COUNT(*) AS c FROM memory_embedding_vec').get() as { c: number }).c).toBe(2);

    const result = runRetentionSweeps(db, {});

    expect(result.memoryEmbeddingVecOrphansDeleted).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM memory_embedding_vec').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c).toBe(1);

    db.close();
  });
});
