import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { textHashOf, textHashes } from '../../src/notes/text-hash.js';

describe('note text hash (#332)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'N1.md', 'N1', 'Met Dana Whitfield at Acme.', 'h1')").run();
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('n1', 'meeting')").run();
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('n1', 'status', 'open')").run();
  });
  afterEach(() => db.close());

  /** A write as the pipeline makes it: the change, a new content hash and the next version. */
  const write = (sql: string) => {
    db.prepare(sql).run();
    db.prepare("UPDATE nodes SET version = version + 1, content_hash = content_hash || '+' WHERE id = 'n1'").run();
  };

  it('stays when links are added around words already in the note', () => {
    const before = textHashOf(db, 'n1');
    write("UPDATE nodes SET body = 'Met [[Dana Whitfield]] at [[Acme Inc|Acme]].' WHERE id = 'n1'");
    expect(textHashOf(db, 'n1')).toBe(before);
  });

  it('changes with the words, the kinds and the fields', () => {
    const before = textHashOf(db, 'n1');
    write("UPDATE nodes SET body = 'Met Dana Whitfield at Acme. Moved to Friday.' WHERE id = 'n1'");
    const edited = textHashOf(db, 'n1');
    expect(edited).not.toBe(before);
    write("INSERT INTO node_types (node_id, schema_type) VALUES ('n1', 'note')");
    const typed = textHashOf(db, 'n1');
    expect(typed).not.toBe(edited);
    write("UPDATE node_fields SET value_text = 'done' WHERE node_id = 'n1' AND field_name = 'status'");
    expect(textHashOf(db, 'n1')).not.toBe(typed);
  });

  it('changes when a field is written as an explicit null, or stops being one (Codex, #696)', () => {
    const before = textHashOf(db, 'n1');
    write("INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES ('n1', 'context')");
    const declared = textHashOf(db, 'n1');
    expect(declared).not.toBe(before);
    // A null marker wins over a value row, as get-node reads it.
    write("INSERT INTO node_explicit_null_fields (node_id, field_name) VALUES ('n1', 'status')");
    const nulled = textHashOf(db, 'n1');
    expect(nulled).not.toBe(declared);
    write("DELETE FROM node_explicit_null_fields WHERE node_id = 'n1'");
    expect(textHashOf(db, 'n1')).toBe(before);
  });

  it('leaves out the wiki build fingerprints, which the file never holds', () => {
    const before = textHashOf(db, 'n1');
    write("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('n1', 'wiki_evidence_hash', 'abc')");
    expect(textHashOf(db, 'n1')).toBe(before);
  });

  it('is computed again after a write, and left out for an id that is no node', () => {
    const before = textHashOf(db, 'n1');
    write("UPDATE nodes SET body = 'Something else' WHERE id = 'n1'");
    expect(textHashOf(db, 'n1')).not.toBe(before);
    expect(textHashes(db, ['n1', 'missing']).has('missing')).toBe(false);
    expect(textHashOf(db, 'missing')).toBeNull();
  });
});
