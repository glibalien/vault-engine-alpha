import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToMemories, upgradeToMemoriesV2, upgradeToMemoriesV3 } from '../../src/db/migrate.js';

function createMemoriesV1TestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  return db;
}

describe('upgradeToMemories', () => {
  it('creates the memories table with the expected columns (v3 shape)', () => {
    const db = createMemoriesV1TestDb();
    upgradeToMemories(db);

    const cols = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual([
      'id', 'source', 'scope', 'node_id', 'content', 'category',
      'metadata_json', 'vec_id', 'created_at', 'updated_at',
      'expired_at', 'valid_at', 'invalid_at', 'superseded_by',
      'evidence_kind', 'evidence_node_id', 'evidence_hash', 'evidence_ref', 'expire_reason',
    ]);
    db.close();
  });

  it('creates the memories indexes (v3 shape) after the full migration chain', () => {
    const db = createMemoriesV1TestDb();
    upgradeToMemories(db);
    // idx_memories_live and idx_memories_evidence_node are owned by the V2/V3
    // migrations, not createSchema/upgradeToMemories (migration-ordering rule:
    // createSchema must never index columns an older-shape table lacks).
    upgradeToMemoriesV2(db);
    upgradeToMemoriesV3(db);

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memories'",
    ).all() as Array<{ name: string }>).map((i) => i.name).sort();
    expect(indexes).toEqual([
      'idx_memories_category', 'idx_memories_evidence_node', 'idx_memories_live',
      'idx_memories_node_id', 'idx_memories_source',
    ]);
    db.close();
  });

  it('creates the memory_embedding_vec vec0 table (cosine, 256-dim)', () => {
    const db = createMemoriesV1TestDb();
    upgradeToMemories(db);

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_embedding_vec'",
    ).all() as Array<{ name: string }>);
    expect(tables).toHaveLength(1);

    // Exercise it: insert + KNN query must not throw, proving vec0 + cosine metric loaded correctly.
    // vec0 primary keys must be bound as BigInt (matches src/search/indexer.ts's
    // stmtInsertVec, typed [bigint, Uint8Array] for the shared embedding_vec table) —
    // a plain JS number throws "Only integers are allows for primary key values".
    const vector = new Float32Array(256).fill(0.1);
    db.prepare('INSERT INTO memory_embedding_vec (id, vector) VALUES (?, ?)').run(1n, Buffer.from(vector.buffer));
    const rows = db.prepare(
      'SELECT id, distance FROM memory_embedding_vec WHERE vector MATCH ? AND k = 1',
    ).all(Buffer.from(vector.buffer)) as Array<{ id: number; distance: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    db.close();
  });

  it('creates the memories_fts contentless table and keeps it in sync via triggers', () => {
    const db = createMemoriesV1TestDb();
    upgradeToMemories(db);

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, source, scope, content, category, created_at, updated_at) VALUES (1, 'test', 'vault', 'hello world', 'note', ?, ?)",
    ).run(now, now);

    let hits = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'hello'").all() as Array<{ rowid: number }>;
    expect(hits.map((h) => h.rowid)).toEqual([1]);

    db.prepare("UPDATE memories SET content = 'goodbye world', updated_at = ? WHERE id = 1").run(now);
    hits = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'hello'").all() as Array<{ rowid: number }>;
    expect(hits).toHaveLength(0);
    hits = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'goodbye'").all() as Array<{ rowid: number }>;
    expect(hits.map((h) => h.rowid)).toEqual([1]);

    db.prepare('DELETE FROM memories WHERE id = 1').run();
    hits = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'goodbye'").all() as Array<{ rowid: number }>;
    expect(hits).toHaveLength(0);
    db.close();
  });

  it('v3: NULLs node_id on node delete (SET NULL, not CASCADE)', () => {
    const db = createMemoriesV1TestDb();
    upgradeToMemories(db);

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body) VALUES ('n1', 'n1.md', 'N1', 'body')",
    ).run();
    const memId = db.prepare(
      "INSERT INTO memories (source, scope, node_id, content, created_at, updated_at) VALUES ('test', 'vault', 'n1', 'about n1', ?, ?)",
    ).run(now, now).lastInsertRowid as number;

    db.prepare("DELETE FROM nodes WHERE id = 'n1'").run();
    // v3: memory row survives, but node_id is NULLed
    const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(memId) as { node_id: string | null } | undefined;
    expect(mem).toBeTruthy();
    expect(mem!.node_id).toBeNull();
    db.close();
  });

  it('is idempotent — safe to run twice', () => {
    const db = createMemoriesV1TestDb();
    upgradeToMemories(db);
    expect(() => upgradeToMemories(db)).not.toThrow();
    db.close();
  });
});
