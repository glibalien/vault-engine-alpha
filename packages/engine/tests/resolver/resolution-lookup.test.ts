import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { ResolutionLookup, resolveTarget } from '../../src/resolver/resolve.js';

let db: Database.Database;

const TARGETS = [
  'Notes/Alice Smith.md', 'Alice Smith', 'alice smith', 'ALICE SMITH.md', 'Alice Smith.md',
  'Notes/Alice Smith', 'cafe\u0301', 'Caf\u00e9', 'Caf\u00e9 Notes', 'Meeting', 'meeting', 'Shared', 'Legacy Name',
  'Topic', 'topic', 'Nonexistent Note', '', '.md',
  // A path written without `.md` (#592), and one that names no note.
  'Archive/Old/Meeting', 'Notes/Meeting', 'Nowhere/Meeting', 'Notes/caf\u00e9',
];

function expectSameAsResolveTarget(lookup: ResolutionLookup): void {
  for (const target of TARGETS) {
    expect({ target, got: lookup.resolve(target) }).toEqual({ target, got: resolveTarget(db, target) });
  }
}

beforeEach(() => {
  db = createTestDb();
  const insert = db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
  insert.run('n1', 'Notes/Alice Smith.md', 'Alice Smith');
  insert.run('n2', 'Notes/caf\u00e9.md', 'Caf\u00e9 Notes');
  insert.run('n3', 'Archive/Old/Meeting.md', 'Meeting');
  insert.run('n4', 'Notes/Meeting.md', 'Meeting');
  // Same-length paths: resolveTarget's table scan returns the lower rowid first.
  insert.run('n5', 'Beta/Shared.md', 'Shared');
  insert.run('n6', 'Acme/Shared.md', 'Shared');
  // A drifted title (tier 2) that its filename does not reproduce.
  insert.run('n7', 'Notes/Renamed File.md', 'Legacy Name');
  insert.run('n8', 'Inbox/TOPIC.md', 'TOPIC');
});

describe('ResolutionLookup', () => {
  it('answers every tier as resolveTarget does', () => {
    expectSameAsResolveTarget(new ResolutionLookup(db));
    expect(new ResolutionLookup(db).resolve('Shared')).toEqual({ id: 'n5', title: 'Shared' });
  });
});
