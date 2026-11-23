import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { upgradeToRicherFts } from '../../src/db/migrate.js';

/** Build a DB, then downgrade nodes_fts to the OLD 2-column shape with one node + a frontmatter field. */
function legacyDb(): Database.Database {
  const db = createTestDb(); // creates the NEW 6-col nodes_fts + all base tables; does NOT run upgradeToRicherFts
  db.exec('DROP TABLE nodes_fts');
  db.exec("CREATE VIRTUAL TABLE nodes_fts USING fts5(title, body, content='', contentless_delete=1)");
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run('n1', '/Notes/Q3 Plan.md', 'Q3 Plan', 'roadmap');
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)').run('n1', 'project', 'Atlas', 'frontmatter');
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run('n1', 'Q3 Plan', 'roadmap');
  return db;
}

describe('upgradeToRicherFts', () => {
  it('rebuilds nodes_fts to six columns and repopulates from DB data', () => {
    const db = legacyDb();
    upgradeToRicherFts(db);

    const cols = (db.prepare("PRAGMA table_info('nodes_fts')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['title', 'aliases', 'path', 'fields', 'links', 'body']);

    // The 'project' field value 'Atlas' is now searchable (was invisible pre-migration).
    const hit = db
      .prepare("SELECT n.id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ?")
      .get('"Atlas"') as { id: string } | undefined;
    expect(hit?.id).toBe('n1');

    expect((db.prepare("SELECT value FROM meta WHERE key = 'fts_schema_version'").get() as { value: string }).value).toBe('2');
  });

  it('is idempotent: a second run is a no-op and preserves rows', () => {
    const db = legacyDb();
    upgradeToRicherFts(db);
    upgradeToRicherFts(db);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM nodes_fts').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
