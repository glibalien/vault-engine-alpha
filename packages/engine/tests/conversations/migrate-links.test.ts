import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { upgradeConversationLinks } from '../../src/conversations/store.js';
import type Database from 'better-sqlite3';

/** Recreate the PRE-migration conversations schema (with owner_doc + the unique index). */
function oldConversationsSchema(db: Database.Database): void {
  db.prepare(`CREATE TABLE conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, owner_doc TEXT, archived INTEGER NOT NULL DEFAULT 0
  )`).run();
  db.prepare(`CREATE UNIQUE INDEX idx_conversations_owner
    ON conversations(owner_doc) WHERE owner_doc IS NOT NULL AND archived = 0`).run();
}
const node = (db: Database.Database, id: string, file_path: string) =>
  db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run(id, file_path);
const conv = (db: Database.Database, id: string, owner_doc: string | null, archived = 0) =>
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, owner_doc, archived) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'T', '2026-01-01', '2026-01-01', owner_doc, archived);

const hasOwnerDoc = (db: Database.Database) =>
  (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).some((c) => c.name === 'owner_doc');
const hasOwnerIndex = (db: Database.Database) =>
  (db.prepare('PRAGMA index_list(conversations)').all() as Array<{ name: string }>).some((i) => i.name === 'idx_conversations_owner');
const links = (db: Database.Database) =>
  db.prepare('SELECT conversation_id, doc_node_id FROM conversation_links ORDER BY conversation_id').all();

describe('upgradeConversationLinks migration (owner_doc backfill + drop)', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); oldConversationsSchema(db); });

  it('backfills links from owner_doc via nodes.file_path, then drops the column + unique index', () => {
    node(db, 'n1', 'Notes/a.md');
    conv(db, 'c1', 'Notes/a.md');
    upgradeConversationLinks(db);
    expect(links(db)).toEqual([{ conversation_id: 'c1', doc_node_id: 'n1' }]);
    expect(hasOwnerDoc(db)).toBe(false);
    expect(hasOwnerIndex(db)).toBe(false);
  });

  it('skips an unresolvable owner_doc (no matching node) — conversation retained, no link', () => {
    conv(db, 'c2', 'Notes/missing.md');
    upgradeConversationLinks(db);
    expect(links(db)).toEqual([]);
    expect(db.prepare('SELECT id FROM conversations WHERE id = ?').get('c2')).toEqual({ id: 'c2' });
  });

  it('links archived conversations too (the listing filters, not the link)', () => {
    node(db, 'n1', 'Notes/a.md');
    conv(db, 'c1', 'Notes/a.md', 0);
    conv(db, 'c3', 'Notes/a.md', 1); // archived shares the doc (allowed by the partial unique index)
    upgradeConversationLinks(db);
    expect(links(db)).toEqual([
      { conversation_id: 'c1', doc_node_id: 'n1' },
      { conversation_id: 'c3', doc_node_id: 'n1' },
    ]);
  });

  it('is idempotent on re-run (and a no-op once owner_doc is gone)', () => {
    node(db, 'n1', 'Notes/a.md');
    conv(db, 'c1', 'Notes/a.md');
    upgradeConversationLinks(db);
    expect(() => upgradeConversationLinks(db)).not.toThrow();
    expect(links(db)).toEqual([{ conversation_id: 'c1', doc_node_id: 'n1' }]);
  });

  it('a doc renamed AFTER migration keeps its link (node-id stability — the headline win)', () => {
    node(db, 'n1', 'Notes/a.md');
    conv(db, 'c1', 'Notes/a.md');
    upgradeConversationLinks(db);
    db.prepare('UPDATE nodes SET file_path = ? WHERE id = ?').run('Notes/renamed.md', 'n1');
    expect(links(db)).toEqual([{ conversation_id: 'c1', doc_node_id: 'n1' }]); // unaffected by the path change
  });
});
