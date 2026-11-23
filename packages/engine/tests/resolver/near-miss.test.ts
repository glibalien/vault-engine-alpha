// Near-miss detection for unresolved references (2026-06-12 triage).
// A "near miss" is an unresolved edge whose target normalizes — via the same
// transforms Obsidian/users apply when sanitizing titles into filenames —
// to an existing note. Three real classes: filename-illegal characters
// ("A / B" vs "A - B.md"), unicode whitespace (U+202F), and exact-match
// stragglers awaiting the startup backfill.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { normalizeRefKey, findNearMissTargets } from '../../src/resolver/near-miss.js';

describe('normalizeRefKey', () => {
  it('maps filename-illegal characters to dashes with collapsed spacing', () => {
    expect(normalizeRefKey('Lantern Inspections / Checklists'))
      .toBe(normalizeRefKey('Lantern Inspections - Checklists'));
    expect(normalizeRefKey('QA 1:1s')).toBe(normalizeRefKey('QA 1-1s'));
    expect(normalizeRefKey('w/ Tomas')).toBe(normalizeRefKey('w- Tomas'));
  });

  it('maps the -> arrow to a dash', () => {
    expect(normalizeRefKey('Juniper -> Cloud Photos'))
      .toBe(normalizeRefKey('Juniper - Cloud Photos'));
  });

  it('canonicalizes unicode whitespace (U+202F narrow no-break space)', () => {
    expect(normalizeRefKey('Avery\u202FQuinn')).toBe(normalizeRefKey('Avery Quinn'));
  });

  it('is case-insensitive and NFC-normalized', () => {
    expect(normalizeRefKey('CAFÉ')).toBe(normalizeRefKey('café'));
  });

  it('does not conflate genuinely different names', () => {
    expect(normalizeRefKey('Clay Role')).not.toBe(normalizeRefKey('Clay Roles'));
  });
});

describe('findNearMissTargets', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  function insertNode(id: string, file_path: string, title: string | null) {
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run(id, file_path, title);
  }
  function insertRel(source_id: string, target: string, rel_type = 'wiki-link') {
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run(source_id, target, rel_type);
  }

  it('reports unresolved targets that normalize to an existing note', () => {
    insertNode('proj', 'Projects/Lantern Inspections - Checklists.md', 'Lantern Inspections - Checklists');
    insertNode('src1', 'a.md', 'A');
    insertNode('src2', 'b.md', 'B');
    insertRel('src1', 'Lantern Inspections / Checklists', 'project');
    insertRel('src2', 'Lantern Inspections / Checklists', 'project');

    const groups = findNearMissTargets(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].target).toBe('Lantern Inspections / Checklists');
    expect(groups[0].edge_count).toBe(2);
    expect(groups[0].matches).toEqual([
      { id: 'proj', file_path: 'Projects/Lantern Inspections - Checklists.md' },
    ]);
  });

  it('ignores unresolved targets with no normalized match (genuine pending references)', () => {
    insertNode('src1', 'a.md', 'A');
    insertRel('src1', 'Some Note That Never Existed');
    expect(findNearMissTargets(db)).toHaveLength(0);
  });

  it('ignores already-resolved edges', () => {
    insertNode('t', 'Thing.md', 'Thing');
    insertNode('src1', 'a.md', 'A');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Thing', 'wiki-link', 't');
    expect(findNearMissTargets(db)).toHaveLength(0);
  });

  it('matches by title as well as basename', () => {
    insertNode('t', 'dir/some-slug.md', 'Juniper - Cloud Photos');
    insertNode('src1', 'a.md', 'A');
    insertRel('src1', 'Juniper -> Cloud Photos', 'project');
    const groups = findNearMissTargets(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].matches[0].id).toBe('t');
  });

  it('matches a bare alias to the note declaring it', () => {
    insertNode('t', 'Persons/Ada Lovelace.md', 'Ada Lovelace');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES ('t', 'aliases', ?, 'frontmatter')")
      .run(JSON.stringify(['Ada L.']));
    insertNode('src1', 'a.md', 'A');
    insertRel('src1', 'ada l.');
    expect(findNearMissTargets(db)).toEqual([
      { target: 'ada l.', edge_count: 1, matches: [{ id: 't', file_path: 'Persons/Ada Lovelace.md' }] },
    ]);
  });

  it('matches no attachment reference by alias, and keeps a .md alias clash ambiguous', () => {
    const alias = (id: string, value: string) => db.prepare(
      "INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES (?, 'aliases', ?, 'frontmatter')"
    ).run(id, JSON.stringify([value]));
    insertNode('summary', 'Notes/Summary.md', 'Summary');
    alias('summary', 'report.pdf');
    insertNode('alice', 'Notes/Alice.md', 'Alice');
    alias('alice', 'Legacy.md');
    insertNode('bob', 'Notes/Bob.md', 'Bob');
    alias('bob', 'Legacy');
    insertNode('src1', 'a.md', 'A');
    insertRel('src1', 'report.pdf');
    insertRel('src1', 'Legacy.md');
    expect(findNearMissTargets(db)).toEqual([{
      target: 'Legacy.md', edge_count: 1,
      matches: [{ id: 'alice', file_path: 'Notes/Alice.md' }, { id: 'bob', file_path: 'Notes/Bob.md' }],
    }]);
  });

  it('takes no alias from an empty aliases item, which YAML reads as null', () => {
    insertNode('t', 'Places/Lisbon.md', 'Lisbon');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES ('t', 'aliases', '[null]', 'frontmatter')").run();
    insertNode('src1', 'a.md', 'A');
    insertRel('src1', 'null', 'people involved');
    expect(findNearMissTargets(db)).toEqual([]);
  });

  it('orders groups by edge_count descending', () => {
    insertNode('p1', 'P - One.md', 'P - One');
    insertNode('p2', 'P - Two.md', 'P - Two');
    insertNode('src1', 'a.md', 'A');
    insertNode('src2', 'b.md', 'B');
    insertRel('src1', 'P / One', 'project');
    insertRel('src1', 'P / Two', 'project');
    insertRel('src2', 'P / Two', 'project');
    const groups = findNearMissTargets(db);
    expect(groups.map(g => g.target)).toEqual(['P / Two', 'P / One']);
  });
});
