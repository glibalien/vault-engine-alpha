/**
 * #445: Engine starts only with the type key its database was built with. An existing
 * database with no recorded key was built with `types`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { getMeta, setMeta } from '../../src/db/meta.js';
import { builtTypeKey, checkTypeKey, TYPE_KEY_META } from '../../src/db/type-key.js';
import { TypeKeyError } from '../../src/parser/type-key.js';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

function addNote(): void {
  db.prepare(`INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
    VALUES ('n1', 'Note.md', 'Note', '', 'h', 0, 0)`).run();
}

describe('checkTypeKey', () => {
  it('records the configured key on a database with no notes yet', () => {
    expect(builtTypeKey(db)).toBeNull();
    checkTypeKey(db, 'kind');
    expect(getMeta(db, TYPE_KEY_META)).toBe('kind');
    expect(builtTypeKey(db)).toBe('kind');
  });

  it('starts an existing database with no recorded key on types, and records it', () => {
    addNote();
    expect(builtTypeKey(db)).toBe('types');
    checkTypeKey(db, 'types');
    expect(getMeta(db, TYPE_KEY_META)).toBe('types');
  });

  it('refuses another key on an existing database with no recorded key', () => {
    addNote();
    expect(() => checkTypeKey(db, 'kind')).toThrow(TypeKeyError);
    expect(() => checkTypeKey(db, 'kind')).toThrow('VAULT_TYPE_KEY is "kind", but this database\'s notes were indexed with "types"');
    expect(getMeta(db, TYPE_KEY_META)).toBeNull();
  });

  it('refuses a key other than the recorded one, notes or not', () => {
    setMeta(db, TYPE_KEY_META, 'kind');
    expect(() => checkTypeKey(db, 'types')).toThrow('Set VAULT_TYPE_KEY=kind');
    addNote();
    expect(() => checkTypeKey(db, 'category')).toThrow(TypeKeyError);
    checkTypeKey(db, 'kind');
    expect(getMeta(db, TYPE_KEY_META)).toBe('kind');
  });
});
