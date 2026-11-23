import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { resolvesByFilename, wikilinkTo, findFilenameUnresolvableLinks, LinkCanonicalizer } from '../../src/resolver/file-link.js';

describe('resolvesByFilename', () => {
  it('resolves a link whose text equals the basename', () => {
    expect(resolvesByFilename('Alice', 'Persons/Alice.md')).toBe(true);
  });

  it('resolves case-insensitively', () => {
    expect(resolvesByFilename('marco dinapoli', 'Persons/Marco Dinapoli.md')).toBe(true);
    expect(resolvesByFilename('Marco DiNapoli', 'Persons/Marco Dinapoli.md')).toBe(true);
  });

  it('resolves a vault-relative path, with or without the .md suffix', () => {
    expect(resolvesByFilename('Persons/Alice', 'Persons/Alice.md')).toBe(true);
    expect(resolvesByFilename('Persons/Alice.md', 'Persons/Alice.md')).toBe(true);
    expect(resolvesByFilename('Alice.md', 'Persons/Alice.md')).toBe(true);
  });

  it('does NOT resolve a title that was sanitized out of the filename', () => {
    // The reported bug: `:` is filename-illegal, so the file is `... Deal- June ...`
    // while the DB title (and the emitted link) keeps the colon.
    expect(resolvesByFilename(
      'North-South Rail Link — Tunnel Funding Vote: June 2026 Deadline',
      'Wikis/North-South Rail Link — Tunnel Funding Vote- June 2026 Deadline.md',
    )).toBe(false);
    expect(resolvesByFilename(
      'Maps / Tile-Cache Layout — Design Spec',
      'Notes/Maps - Tile-Cache Layout — Design Spec.md',
    )).toBe(false);
  });

  it('does NOT resolve a title that drifted from its filename entirely', () => {
    expect(resolvesByFilename('Vault Curator Wiki', 'Wikis/Vault Curator Enhancements Wiki.md')).toBe(false);
  });

  it('normalizes unicode (NFC) before comparing', () => {
    expect(resolvesByFilename('Café'.normalize('NFD'), 'Notes/Café.md')).toBe(true);
  });
});

describe('wikilinkTo', () => {
  it('emits a plain link when the title already resolves by filename', () => {
    expect(wikilinkTo('Alice', 'Persons/Alice.md')).toBe('[[Alice]]');
  });

  it('emits a plain link when title and filename differ only by case', () => {
    // Filename matching is case-insensitive, so aliasing here would be pure churn.
    expect(wikilinkTo('Marco DiNapoli', 'Persons/Marco Dinapoli.md')).toBe('[[Marco DiNapoli]]');
  });

  it('emits [[basename|title]] when the filename was sanitized', () => {
    expect(wikilinkTo(
      'Site audit: link checker',
      'TaskNotes/Tasks/Site audit- link checker.md',
    )).toBe('[[Site audit- link checker|Site audit: link checker]]');
  });

  it('targets the basename, not the full path (full paths do not resolve engine-side)', () => {
    const out = wikilinkTo('Maps / Tile-Cache Layout — Design Spec', 'Notes/Maps - Tile-Cache Layout — Design Spec.md');
    expect(out).toBe('[[Maps - Tile-Cache Layout — Design Spec|Maps / Tile-Cache Layout — Design Spec]]');
    expect(out).not.toContain('Notes/');
  });

  it('replaces a pipe in the display half so it cannot break the alias delimiter', () => {
    expect(wikilinkTo('A | B', 'Notes/A - B.md')).toBe('[[A - B|A - B]]');
  });

  it('falls back to a plain title link when file_path is unknown', () => {
    expect(wikilinkTo('Some Title', undefined)).toBe('[[Some Title]]');
  });

  it('degrades to a plain title link when the basename itself carries a pipe', () => {
    // An un-linkable target — a pipe in the target half would be parsed as the
    // alias delimiter, so there is nothing better to emit than the raw title.
    expect(wikilinkTo('A: B', 'Notes/A| B.md')).toBe('[[A: B]]');
  });
});

// ---------------------------------------------------------------------------
// The vault-doctor blind spot: edges that RESOLVE engine-side (so near-miss
// detection never sees them) but are dead links to every reader of the files.
// ---------------------------------------------------------------------------

describe('findFilenameUnresolvableLinks', () => {
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
  function insertRel(source_id: string, target: string, resolved: string | null, rel_type = 'wiki-link') {
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run(source_id, target, rel_type, resolved);
  }

  it('reports a resolved edge whose link text cannot resolve by filename', () => {
    insertNode('sub', 'Wikis/North-South Rail Link — Tunnel Funding Vote- June 2026 Deadline.md',
      'North-South Rail Link — Tunnel Funding Vote: June 2026 Deadline');
    insertNode('home', 'Wikis/North-South Rail Link Wiki.md', 'North-South Rail Link Wiki');
    insertRel('home', 'North-South Rail Link — Tunnel Funding Vote: June 2026 Deadline', 'sub');

    const groups = findFilenameUnresolvableLinks(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].target).toBe('North-South Rail Link — Tunnel Funding Vote: June 2026 Deadline');
    expect(groups[0].edge_count).toBe(1);
    expect(groups[0].file_path).toBe('Wikis/North-South Rail Link — Tunnel Funding Vote- June 2026 Deadline.md');
    expect(groups[0].sources).toEqual(['Wikis/North-South Rail Link Wiki.md']);
  });

  it('ignores links that differ from the filename only by case', () => {
    insertNode('p', 'Persons/Marco Dinapoli.md', 'Marco DiNapoli');
    insertNode('s', 'Clippings/Film.md', 'Film');
    insertRel('s', 'Marco DiNapoli', 'p');
    expect(findFilenameUnresolvableLinks(db)).toHaveLength(0);
  });

  it('ignores links written as a vault-relative path or with a .md suffix', () => {
    insertNode('n', 'Meetings/Standup.md', 'Standup');
    insertNode('s', 'Notes/S.md', 'S');
    insertRel('s', 'Meetings/Standup', 'n');
    insertRel('s', 'Standup.md', 'n');
    expect(findFilenameUnresolvableLinks(db)).toHaveLength(0);
  });

  it('reports a link an alias spells — Obsidian resolves no bare [[alias]]', () => {
    insertNode('n', 'Persons/Ada Lovelace.md', 'Ada L.');
    insertNode('s', 'Notes/S.md', 'S');
    insertRel('s', 'Ada L.', 'n');
    db.prepare(
      "INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES (?, 'aliases', ?, 'frontmatter')"
    ).run('n', JSON.stringify(['Ada L.']));
    expect(findFilenameUnresolvableLinks(db)).toHaveLength(1);
  });

  it('ignores unresolved edges — those are near-miss territory', () => {
    insertNode('s', 'Notes/S.md', 'S');
    insertRel('s', 'Nothing At All', null);
    expect(findFilenameUnresolvableLinks(db)).toHaveLength(0);
  });

  it('groups repeated link text and orders by edge count descending', () => {
    insertNode('t1', 'TaskNotes/Tasks/Site audit- link checker.md', 'Site audit: link checker');
    insertNode('t2', 'TaskNotes/Tasks/Site audit- broken-page report.md', 'Site audit: broken-page report');
    insertNode('a', 'Wikis/A.md', 'A');
    insertNode('b', 'Wikis/B.md', 'B');
    insertRel('a', 'Site audit: link checker', 't1');
    insertRel('b', 'Site audit: link checker', 't1');
    insertRel('a', 'Site audit: broken-page report', 't2');

    const groups = findFilenameUnresolvableLinks(db);
    expect(groups.map(g => g.edge_count)).toEqual([2, 1]);
    expect(groups[0].target).toBe('Site audit: link checker');
    expect(groups[0].sources.sort()).toEqual(['Wikis/A.md', 'Wikis/B.md']);
  });
});

describe('LinkCanonicalizer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  function insertNode(id: string, file_path: string, title: string | null, type?: string) {
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run(id, file_path, title);
    if (type) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
  }
  function insertAliases(id: string, field: 'aliases' | 'alias', value: string | string[]) {
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_json, source) VALUES (?, ?, ?, ?, ?)')
      .run(id, field, typeof value === 'string' ? value : null, typeof value === 'string' ? null : JSON.stringify(value), 'frontmatter');
  }
  const match = (target: string, requiredType: string | null = null) =>
    new LinkCanonicalizer(db).match(target, requiredType)?.id ?? null;

  it('leaves text that resolves by filename alone — path, basename, case', () => {
    insertNode('n', 'Persons/Ada Lovelace.md', 'Ada Lovelace');
    for (const text of ['Ada Lovelace', 'ada lovelace', 'Persons/Ada Lovelace', 'Ada Lovelace.md']) {
      expect(match(text)).toBeNull();
    }
  });

  it('matches a bare alias, which no reader resolves', () => {
    insertNode('n', 'Persons/Ada Lovelace.md', 'Ada Lovelace');
    insertAliases('n', 'aliases', ['Ada L.', 'Countess']);
    insertNode('m', 'Persons/Grace Hopper.md', 'Grace Hopper');
    insertAliases('m', 'alias', 'Amazing Grace');
    expect(match('Ada L.')).toBe('n');
    expect(match('countess')).toBe('n');
    expect(match('Amazing Grace')).toBe('m');
    expect(new LinkCanonicalizer(db).linkTarget({ id: 'n', file_path: 'Persons/Ada Lovelace.md', title: 'Ada Lovelace' }))
      .toBe('Ada Lovelace');
  });

  it('leaves an alias that is also a filename to the file', () => {
    insertNode('n', 'Persons/Ada Lovelace.md', 'Ada Lovelace');
    insertAliases('n', 'aliases', ['Ada']);
    insertNode('a', 'Notes/Ada.md', 'Ada');
    expect(match('Ada')).toBeNull();
  });

  it('leaves an attachment reference to the attachment, even when an alias spells it', () => {
    insertNode('n', 'Notes/Summary.md', 'Summary');
    insertAliases('n', 'aliases', ['report.pdf', 'Ada L.']);
    expect(match('report.pdf')).toBeNull();
    expect(match('Ada L.')).toBe('n');
  });

  it('drops a .md suffix from an alias and a link alike', () => {
    insertNode('a', 'Notes/Alice.md', 'Alice');
    insertAliases('a', 'aliases', ['Legacy.md']);
    expect(match('Legacy')).toBe('a');
    expect(match('Legacy.md')).toBe('a');
    insertNode('b', 'Notes/Bob.md', 'Bob');
    insertAliases('b', 'aliases', ['Legacy']);
    expect(match('Legacy.md')).toBeNull();
  });

  it('leaves aliases out when asked', () => {
    insertNode('n', 'Persons/Ada Lovelace.md', 'Ada Lovelace');
    insertAliases('n', 'aliases', ['Ada L.']);
    expect(new LinkCanonicalizer(db, { aliases: false }).match('Ada L.')).toBeNull();
  });

  it('does not guess between notes sharing an alias, or an alias and another name', () => {
    insertNode('a', 'Notes/Alpha.md', 'Alpha');
    insertNode('b', 'Notes/Beta.md', 'Beta');
    insertAliases('a', 'aliases', ['Shared', 'Q4: Plan']);
    insertAliases('b', 'aliases', ['Shared']);
    insertNode('q', 'Notes/Q4- Plan.md', 'Q4- Plan');
    expect(match('Shared')).toBeNull();
    expect(match('Q4: Plan')).toBeNull();
  });

  it('matches text that misses a filename only by sanitization', () => {
    insertNode('t', 'TaskNotes/Tasks/Ping Tomas on vendor-onboarding status.md', 'Ping Tomas on vendor-onboarding status');
    expect(match('Ping Tomas on vendor/onboarding status')).toBe('t');
  });

  it('matches unicode whitespace variants', () => {
    insertNode('n', 'Notes/Q3 Plan.md', 'Q3 Plan');
    expect(match('Q3\u202FPlan')).toBe('n');
  });

  it('matches a title that drifted from its filename (resolvable only engine-side)', () => {
    insertNode('t', 'TaskNotes/Tasks/Site audit- link checker.md', 'Site audit: link checker');
    expect(match('Site audit: link checker')).toBe('t');
  });

  it('does not guess between several candidates', () => {
    insertNode('a', 'Notes/A - B.md', 'A - B');
    insertNode('b', 'Archive/A-B.md', 'A-B');
    expect(match('A: B')).toBeNull();
  });

  it('does not match text with no candidate', () => {
    insertNode('a', 'Notes/Alpha.md', 'Alpha');
    expect(match('Beta: Gamma')).toBeNull();
  });

  it('filters candidates by a required type', () => {
    insertNode('p', 'Projects/Acme- Rollout.md', 'Acme- Rollout', 'project');
    insertNode('m', 'Meetings/Acme- Rollout.md', 'Acme- Rollout', 'meeting');
    expect(match('Acme: Rollout')).toBeNull();
    expect(match('Acme: Rollout', 'project')).toBe('p');
    expect(match('Acme: Rollout', 'person')).toBeNull();
  });
});
