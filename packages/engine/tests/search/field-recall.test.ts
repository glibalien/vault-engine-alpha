import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { hybridSearch } from '../../src/search/search.js';
import { buildFtsRow } from '../../src/search/fts-row.js';

/** Insert a node + fields + links, then populate all six nodes_fts columns via buildFtsRow. */
function insertRich(
  db: Database.Database,
  id: string,
  title: string,
  body: string,
  opts: { filePath?: string; fields?: [string, string][]; jsonFields?: [string, string[]][]; links?: [string, string | null][] } = {},
): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, opts.filePath ?? `/${id}.md`, title, body);
  for (const [name, text] of opts.fields ?? [])
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)').run(id, name, text, 'frontmatter');
  for (const [name, arr] of opts.jsonFields ?? [])
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(arr), 'frontmatter');
  for (const [target, resolvedId] of opts.links ?? [])
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)').run(id, target, 'related', resolvedId);
  const row = buildFtsRow(db, id);
  db.prepare(
    `INSERT INTO nodes_fts (rowid, title, aliases, path, fields, links, body)
     VALUES ((SELECT rowid FROM nodes WHERE id = ?), @title, @aliases, @path, @fields, @links, @body)`
  ).run(id, row);
}

describe('field-recall (richer FTS surface)', () => {
  it('finds a node matched ONLY via a frontmatter field value', async () => {
    const db = createTestDb();
    insertRich(db, 'n1', 'Weekly Sync', 'generic meeting notes', { jsonFields: [['people involved', ['Rowan Vale']]] });
    insertRich(db, 'n2', 'Unrelated', 'nothing here');
    const hits = await hybridSearch(db, null, 'Rowan Vale', { mode: 'fts', limit: 10 });
    expect(hits.map((h) => h.node_id)).toContain('n1');
  });

  it('finds a node matched ONLY via an alias', async () => {
    const db = createTestDb();
    insertRich(db, 'n1', 'Northstar Coast Trip', 'body', { jsonFields: [['aliases', ['Coast Vacation']]] });
    const hits = await hybridSearch(db, null, 'Coast Vacation', { mode: 'fts', limit: 10 });
    expect(hits.map((h) => h.node_id)).toContain('n1');
  });
});
