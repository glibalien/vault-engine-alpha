import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { buildFtsRow } from '../../src/search/fts-row.js';

function seedNode(db: Database.Database, id: string, title: string, body: string, filePath: string): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, filePath, title, body);
}
function seedField(db: Database.Database, nodeId: string, name: string, text: string | null, json: string | null): void {
  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_json, source) VALUES (?, ?, ?, ?, ?)'
  ).run(nodeId, name, text, json, 'frontmatter');
}

describe('buildFtsRow', () => {
  it('derives all six columns from node, fields, and links', () => {
    const db = createTestDb();
    seedNode(db, 'n1', 'Northstar Coast Trip', 'body text here', '/Notes/Northstar Coast Trip.md');
    seedField(db, 'n1', 'aliases', null, JSON.stringify(['NC Trip', 'Coast Vacation']));
    seedField(db, 'n1', 'project', 'Summer 2026', null);
    seedField(db, 'n1', 'people involved', null, JSON.stringify(['Alex Quill', 'Jordan Vale']));
    // A resolved link (target n2 exists) and an unresolved link (raw target only).
    seedNode(db, 'n2', 'Packing Checklist', '', '/Notes/Packing Checklist.md');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)'
    ).run('n1', 'Packing Checklist', 'related', 'n2');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)'
    ).run('n1', 'Ferry Schedule', 'related', null);

    const row = buildFtsRow(db, 'n1');
    expect(row.title).toBe('Northstar Coast Trip');
    expect(row.body).toBe('body text here');
    // aliases: both alias strings, NOT in the generic fields blob.
    expect(row.aliases).toContain('NC Trip');
    expect(row.aliases).toContain('Coast Vacation');
    expect(row.fields).not.toContain('NC Trip');
    // fields: scalar + flattened json string leaves, values only.
    expect(row.fields).toContain('Summer 2026');
    expect(row.fields).toContain('Alex Quill');
    expect(row.fields).toContain('Jordan Vale');
    // path: folder + filename tokens, no slashes / .md.
    expect(row.path).toContain('Notes');
    expect(row.path).toContain('Northstar Coast Trip');
    expect(row.path).not.toContain('/');
    expect(row.path).not.toMatch(/\bmd\b/);
    // links: resolved target title + raw unresolved target.
    expect(row.links).toContain('Packing Checklist');
    expect(row.links).toContain('Ferry Schedule');
  });

  it('returns empty strings for absent data, never throws', () => {
    const db = createTestDb();
    seedNode(db, 'n1', 'Bare Note', '', '/Bare Note.md');
    const row = buildFtsRow(db, 'n1');
    expect(row.aliases).toBe('');
    expect(row.fields).toBe('');
    expect(row.links).toBe('');
    expect(row.body).toBe('');
  });
});
