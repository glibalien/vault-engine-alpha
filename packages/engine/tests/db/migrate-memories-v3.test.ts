import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToMemories, upgradeToMemoriesV2, upgradeToMemoriesV3 } from '../../src/db/migrate.js';

/** A v2-shape DB with a nodes table, mirroring pre-v3 production. */
function v2Db(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY);');
  upgradeToMemories(db);
  upgradeToMemoriesV2(db);
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

const NOW = '2026-01-01T00:00:00.000Z';

function insertV2Row(db: Database.Database, content: string, metadataJson: string | null, nodeId: string | null = null): number {
  const r = db.prepare(
    `INSERT INTO memories (source, scope, node_id, content, metadata_json, created_at, updated_at, valid_at)
     VALUES ('curator', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(nodeId ? 'node' : 'vault', nodeId, content, metadataJson, NOW, NOW, NOW);
  return Number(r.lastInsertRowid);
}

describe('prod boot sequence (createSchema re-run over an existing older-shape DB)', () => {
  // Regression for the 2026-07-16 deploy crash-loop: createSchema runs BEFORE
  // the migration chain on every boot, so it must never reference columns that
  // only a later migration adds. On prod, CREATE TABLE IF NOT EXISTS no-ops
  // against the v2-shape memories table; an index on evidence_node_id inside
  // createSchema then throws "no such column" before upgradeToMemoriesV3 ever
  // runs. Indexes on new columns belong to the migration, not createSchema.
  it('boots a v2-shape DB: createSchema + full migration chain, no throw, index lands', () => {
    const db = v2Db();
    insertV2Row(db, 'pre-existing prod row', null);
    expect(() => {
      createSchema(db);
      upgradeToMemories(db);
      upgradeToMemoriesV2(db);
      upgradeToMemoriesV3(db);
    }).not.toThrow();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_evidence_node'").get();
    expect(idx).toBeTruthy();
    expect(columns(db, 'memories')).toEqual(expect.arrayContaining(['evidence_kind', 'expire_reason']));
    db.close();
  });

  it('boots a fresh DB: the evidence index still lands despite the v3 early-return', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.pragma('foreign_keys = ON');
    createSchema(db);
    upgradeToMemories(db);
    upgradeToMemoriesV2(db);
    upgradeToMemoriesV3(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_evidence_node'").get();
    expect(idx).toBeTruthy();
    db.close();
  });
});

describe('upgradeToMemoriesV3', () => {
  it('adds the five v3 columns and the evidence partial index', () => {
    const db = v2Db();
    upgradeToMemoriesV3(db);
    expect(columns(db, 'memories')).toEqual(
      expect.arrayContaining(['evidence_kind', 'evidence_node_id', 'evidence_hash', 'evidence_ref', 'expire_reason']),
    );
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_evidence_node'").get();
    expect(idx).toBeTruthy();
    db.close();
  });

  it('backfills sweep-stamped rows to evidence_kind=note and everything else to unknown', () => {
    const db = v2Db();
    const sweepId = insertV2Row(db, 'sweep fact', JSON.stringify({
      origin: 'memory-sweep', source_node_id: 'n1', source_title: 'Note One', content_hash: 'abc123',
    }));
    const chatId = insertV2Row(db, 'chat fact', null);
    upgradeToMemoriesV3(db);
    const sweep = db.prepare('SELECT * FROM memories WHERE id = ?').get(sweepId) as Record<string, unknown>;
    expect(sweep.evidence_kind).toBe('note');
    expect(sweep.evidence_node_id).toBe('n1');
    expect(sweep.evidence_hash).toBe('abc123');
    const chat = db.prepare('SELECT * FROM memories WHERE id = ?').get(chatId) as Record<string, unknown>;
    expect(chat.evidence_kind).toBe('unknown');
    expect(chat.evidence_node_id).toBeNull();
    db.close();
  });

  it('preserves row ids, FTS content, and the FTS sync triggers across the rebuild', () => {
    const db = v2Db();
    const id = insertV2Row(db, 'searchable little fact', null);
    upgradeToMemoriesV3(db);
    const hit = db.prepare(
      "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'searchable'",
    ).get() as { rowid: number };
    expect(hit.rowid).toBe(id);
    // triggers recreated: an insert after the rebuild is FTS-visible
    db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at)
       VALUES ('chat','vault','post-rebuild banana', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);
    const post = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'banana'").get();
    expect(post).toBeTruthy();
    db.close();
  });

  it('replaces the CASCADE: deleting a node NULLs node_id instead of deleting the memory', () => {
    const db = v2Db();
    db.prepare("INSERT INTO nodes (id) VALUES ('n9')").run();
    const id = insertV2Row(db, 'node-scoped fact', null, 'n9');
    upgradeToMemoriesV3(db);
    db.prepare("DELETE FROM nodes WHERE id = 'n9'").run();
    const row = db.prepare('SELECT node_id FROM memories WHERE id = ?').get(id) as { node_id: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row!.node_id).toBeNull();
    db.close();
  });

  it('preserves AUTOINCREMENT continuity (new ids continue past copied max)', () => {
    const db = v2Db();
    const maxId = insertV2Row(db, 'last v2 row', null);
    upgradeToMemoriesV3(db);
    const r = db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at)
       VALUES ('chat','vault','fresh', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(maxId);
    db.close();
  });

  it('never reuses the id of a pre-migration hard-deleted max row', () => {
    const db = v2Db();
    insertV2Row(db, 'row one', null);
    insertV2Row(db, 'row two', null);
    const maxId = insertV2Row(db, 'row three (will be hard-deleted)', null);
    db.prepare('DELETE FROM memories WHERE id = ?').run(maxId);
    upgradeToMemoriesV3(db);
    const r = db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at)
       VALUES ('chat','vault','post-migration insert', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(maxId);
    db.close();
  });

  it('is idempotent and leaves foreign_keys ON afterwards', () => {
    const db = v2Db();
    upgradeToMemoriesV3(db);
    expect(() => upgradeToMemoriesV3(db)).not.toThrow();
    expect(columns(db, 'memories').filter((c) => c === 'evidence_kind')).toHaveLength(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});
