import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { dropRetiredNodeFacts } from '../../src/db/migrate.js';

const RETIRED = ['node_fact_subjects', 'node_facts', 'node_fact_extractions', 'node_item_subjects', 'node_items', 'node_item_extractions'];

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name);
}

describe('dropRetiredNodeFacts (#352)', () => {
  it('drops the node facts tables, under either name, and is a no-op once they are gone', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    // The shape production had before node facts were retired, with a row in each table.
    db.exec(`
      INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES ('n1', 'a.md', 'a', '', 'h', 0, 0);
      CREATE TABLE node_fact_extractions (node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, content_hash TEXT NOT NULL, extractor TEXT NOT NULL, extracted_at TEXT NOT NULL, fact_count INTEGER NOT NULL);
      CREATE TABLE node_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, as_of TEXT, created_at TEXT NOT NULL);
      CREATE TABLE node_fact_subjects (fact_id INTEGER NOT NULL REFERENCES node_facts(id) ON DELETE CASCADE, label TEXT NOT NULL, subject_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, PRIMARY KEY (fact_id, label));
      CREATE TABLE node_items (id INTEGER PRIMARY KEY);
      INSERT INTO node_fact_extractions VALUES ('n1', 'h', 'node-facts-v2/m', 't', 1);
      INSERT INTO node_facts (node_id, ordinal, kind, content, created_at) VALUES ('n1', 0, 'stable', 'x', 't');
      INSERT INTO node_fact_subjects VALUES (1, 'a', 'n1');
    `);
    dropRetiredNodeFacts(db);
    expect(tables(db).filter(name => RETIRED.includes(name))).toEqual([]);
    expect(db.prepare('SELECT id FROM nodes').all()).toEqual([{ id: 'n1' }]);
    dropRetiredNodeFacts(db);
    db.close();
  });
});
