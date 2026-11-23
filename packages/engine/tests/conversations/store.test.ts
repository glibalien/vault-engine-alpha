import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  upgradeConversationsStore, upgradeConversationLinks, listConversations, getConversation,
  saveConversation, archiveConversation, unarchiveConversation, setClientState, deleteConversation,
  linkConversationToDoc, unlinkConversationFromDoc, listConversationsForDoc, listDocsForConversation,
} from '../../src/conversations/store.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  upgradeConversationsStore(db);
  upgradeConversationLinks(db);
  return db;
}
const NOW = '2026-06-22T00:00:00.000Z';
const LATER = '2026-06-22T01:00:00.000Z';
const msg = (role: string, text: string) => ({ id: `${role}-${text}`, role, parts: [{ type: 'text', text }] });

describe('conversation store', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('save creates, get returns metadata + ordered messages + empty linked_docs', () => {
    saveConversation(db, { id: 'c1', title: 'Hi', messages: [msg('user', 'a'), msg('assistant', 'b')] }, NOW);
    const got = getConversation(db, 'c1');
    expect(got?.conversation.title).toBe('Hi');
    expect(got?.messages.map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant']);
    expect(got?.linked_docs).toEqual([]);
    expect(got?.conversation.revision).toBe(1);
  });

  it('advances a monotonic authority revision for conversation and link mutations only', () => {
    saveConversation(db, { id: 'c1', title: 'Hi', messages: [] }, NOW);
    expect(getConversation(db, 'c1')?.conversation.revision).toBe(1);

    saveConversation(db, { id: 'c1', messages: [msg('user', 'changed')] }, LATER);
    expect(getConversation(db, 'c1')?.conversation.revision).toBe(2);

    linkConversationToDoc(db, 'c1', 'node-1', Date.parse(LATER));
    expect(getConversation(db, 'c1')?.conversation.revision).toBe(3);
    linkConversationToDoc(db, 'c1', 'node-1', Date.parse(LATER));
    expect(getConversation(db, 'c1')?.conversation.revision).toBe(3);

    unlinkConversationFromDoc(db, 'c1', 'node-1', Date.parse(LATER));
    expect(getConversation(db, 'c1')?.conversation.revision).toBe(4);
    unlinkConversationFromDoc(db, 'c1', 'node-1', Date.parse(LATER));
    expect(getConversation(db, 'c1')?.conversation.revision).toBe(4);
  });

  it('omitting created_at/updated_at stamps now (unchanged default behavior)', () => {
    saveConversation(db, { id: 'c1', title: 'Hi', messages: [] }, NOW);
    const got = getConversation(db, 'c1')!.conversation;
    expect(got.created_at).toBe(NOW);
    expect(got.updated_at).toBe(NOW);
  });

  it('provided created_at/updated_at are stored on a fresh save (migration timestamp preservation)', () => {
    const ORIG_CREATED = '2025-01-01T00:00:00.000Z';
    const ORIG_UPDATED = '2025-03-15T12:30:00.000Z';
    saveConversation(db, { id: 'm1', title: 'Migrated', messages: [msg('user', 'a')], created_at: ORIG_CREATED, updated_at: ORIG_UPDATED }, NOW);
    const got = getConversation(db, 'm1')!.conversation;
    expect(got.created_at).toBe(ORIG_CREATED);
    expect(got.updated_at).toBe(ORIG_UPDATED);
  });

  it('updated_at override applies on the existing-row UPDATE path; created_at unchanged', () => {
    const ORIG_CREATED = '2025-01-01T00:00:00.000Z';
    saveConversation(db, { id: 'm2', title: 'M', messages: [], created_at: ORIG_CREATED, updated_at: '2025-02-02T00:00:00.000Z' }, NOW);
    saveConversation(db, { id: 'm2', messages: [msg('user', 'a')], updated_at: '2025-04-04T00:00:00.000Z' }, LATER);
    const got = getConversation(db, 'm2')!.conversation;
    expect(got.created_at).toBe(ORIG_CREATED); // created_at never moves on update
    expect(got.updated_at).toBe('2025-04-04T00:00:00.000Z');
    // omitting updated_at on a later save falls back to `now`
    saveConversation(db, { id: 'm2', messages: [] }, LATER);
    expect(getConversation(db, 'm2')!.conversation.updated_at).toBe(LATER);
  });

  it('save replaces messages (no append)', () => {
    saveConversation(db, { id: 'c1', title: 'Hi', messages: [msg('user', 'a')] }, NOW);
    saveConversation(db, { id: 'c1', messages: [msg('user', 'a'), msg('assistant', 'b')] }, LATER);
    expect(getConversation(db, 'c1')?.messages).toHaveLength(2);
    expect(getConversation(db, 'c1')?.conversation.title).toBe('Hi'); // title kept when omitted
  });

  it('list orders by updated_at desc and hides archived unless asked', () => {
    saveConversation(db, { id: 'old', title: 'old', messages: [] }, NOW);
    saveConversation(db, { id: 'new', title: 'new', messages: [] }, LATER);
    expect(listConversations(db).map((c) => c.id)).toEqual(['new', 'old']);
    archiveConversation(db, 'old', LATER);
    expect(listConversations(db).map((c) => c.id)).toEqual(['new']);
    expect(listConversations(db, true).map((c) => c.id).sort()).toEqual(['new', 'old']);
  });

  it('projects sorted linked docs only when requested', () => {
    saveConversation(db, { id: 'c1', title: 'Chat', messages: [] }, NOW);
    linkConversationToDoc(db, 'c1', 'node-z', Date.parse(NOW));
    linkConversationToDoc(db, 'c1', 'node-a', Date.parse(LATER));

    expect(listConversations(db)[0]).not.toHaveProperty('linked_docs');
    expect(listConversations(db)[0]).not.toHaveProperty('revision');
    expect(listConversations(db, false, true)[0]?.linked_docs).toEqual(['node-a', 'node-z']);
    expect(listConversations(db, false, true)[0]?.revision).toBe(3);
  });

  it('delete cascades messages and conversation_links', () => {
    saveConversation(db, { id: 'c1', title: '1', messages: [msg('user', 'a')] }, NOW);
    linkConversationToDoc(db, 'c1', 'node-1', Date.parse(NOW));
    expect(deleteConversation(db, 'c1')).toBe(true);
    expect(getConversation(db, 'c1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM conversation_links').get()).toEqual({ n: 0 });
  });

  it('upgradeConversationLinks is idempotent', () => {
    expect(() => upgradeConversationLinks(db)).not.toThrow();
  });

  it('omitting messages preserves stored messages and updates title (metadata-only save)', () => {
    saveConversation(db, { id: 'c1', messages: [msg('user', 'a'), msg('assistant', 'b')] }, NOW);
    saveConversation(db, { id: 'c1', title: 'Identifying Project Alpha Task' }, LATER);
    const got = getConversation(db, 'c1')!;
    expect(got.conversation.title).toBe('Identifying Project Alpha Task');
    expect(got.conversation.updated_at).toBe(LATER);
    expect(got.messages).toHaveLength(2); // untouched
  });

  it('metadata-only save on a missing id creates an empty placeholder row (upsert parity)', () => {
    saveConversation(db, { id: 'fresh', title: 'T' }, NOW);
    const got = getConversation(db, 'fresh')!;
    expect(got.conversation.title).toBe('T');
    expect(got.messages).toEqual([]);
  });
});

describe('conversation↔doc associations (pure M:N, node-id keyed)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    saveConversation(db, { id: 'c1', title: '1', messages: [] }, NOW);
    saveConversation(db, { id: 'c2', title: '2', messages: [] }, LATER);
  });

  it('link is idempotent and getConversation reflects linked_docs', () => {
    expect(linkConversationToDoc(db, 'c1', 'node-1', Date.parse(NOW))).toEqual({ linked: true });
    expect(linkConversationToDoc(db, 'c1', 'node-1', Date.parse(LATER))).toEqual({ linked: false }); // re-link → no-op
    expect(getConversation(db, 'c1')?.linked_docs).toEqual(['node-1']);
    expect(listDocsForConversation(db, 'c1')).toEqual(['node-1']);
  });

  it('unlink reports found/not-found', () => {
    linkConversationToDoc(db, 'c1', 'node-1', Date.parse(NOW));
    expect(unlinkConversationFromDoc(db, 'c1', 'node-1', Date.parse(LATER))).toEqual({ unlinked: true });
    expect(unlinkConversationFromDoc(db, 'c1', 'node-1', Date.parse(LATER))).toEqual({ unlinked: false });
    expect(getConversation(db, 'c1')?.linked_docs).toEqual([]);
  });

  it.each([
    ['link', (database: Database.Database) => linkConversationToDoc(database, 'c1', 'node-1', Date.parse(LATER)), false],
    ['unlink', (database: Database.Database) => unlinkConversationFromDoc(database, 'c1', 'node-1', Date.parse(LATER)), true],
  ] as const)('%s rolls its association change back when the timestamp/revision update fails', (_label, mutate, seedLink) => {
    if (seedLink) linkConversationToDoc(db, 'c1', 'node-1', Date.parse(NOW));
    db.exec(`
      CREATE TRIGGER fail_conversation_authority_update
      BEFORE UPDATE ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'forced conversation update failure');
      END
    `);

    expect(() => mutate(db)).toThrow('forced conversation update failure');
    expect(listDocsForConversation(db, 'c1')).toEqual(seedLink ? ['node-1'] : []);
  });

  it('no archive-prior: two conversations coexist on one doc; list = most-recent first', () => {
    linkConversationToDoc(db, 'c1', 'doc', Date.parse(NOW));
    linkConversationToDoc(db, 'c2', 'doc', Date.parse(LATER));
    // c2 was saved at LATER, so it is most-recently-updated.
    expect(listConversationsForDoc(db, 'doc').map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(getConversation(db, 'c1')?.conversation.archived).toBe(0); // prior NOT archived (D3)
  });

  it('listConversationsForDoc hides archived unless asked', () => {
    linkConversationToDoc(db, 'c1', 'doc', Date.parse(NOW));
    linkConversationToDoc(db, 'c2', 'doc', Date.parse(LATER));
    archiveConversation(db, 'c2', LATER);
    expect(listConversationsForDoc(db, 'doc').map((c) => c.id)).toEqual(['c1']);
    expect(listConversationsForDoc(db, 'doc', true).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('M:N — one conversation to two docs, one doc to two conversations', () => {
    linkConversationToDoc(db, 'c1', 'doc-1', Date.parse(NOW));
    linkConversationToDoc(db, 'c1', 'doc-2', Date.parse(NOW)); // one conversation → two docs
    linkConversationToDoc(db, 'c2', 'doc-1', Date.parse(LATER)); // one doc → two conversations
    expect(getConversation(db, 'c1')?.linked_docs.sort()).toEqual(['doc-1', 'doc-2']);
    expect(listConversationsForDoc(db, 'doc-1').map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });
});

describe('client_state + unarchive', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('client_state round-trips and is preserved across a message-only save', () => {
    saveConversation(db, { id: 'c1', title: 'T', messages: [msg('user', 'a')], client_state: { doc: false, board: true, nodes: ['n1'] } }, NOW);
    expect(getConversation(db, 'c1')!.client_state).toEqual({ doc: false, board: true, nodes: ['n1'] });
    // save again WITHOUT client_state → column untouched (preserve-on-omit)
    saveConversation(db, { id: 'c1', messages: [msg('user', 'a'), msg('assistant', 'b')] }, LATER);
    expect(getConversation(db, 'c1')!.client_state).toEqual({ doc: false, board: true, nodes: ['n1'] });
    expect(getConversation(db, 'c1')!.messages).toHaveLength(2);
  });

  it('getConversation returns null client_state when unset', () => {
    saveConversation(db, { id: 'c2', title: 'T', messages: [] }, NOW);
    expect(getConversation(db, 'c2')!.client_state).toBeNull();
  });

  it('setClientState replaces the whole blob on an existing row (returns existed=true)', () => {
    saveConversation(db, { id: 'c2', title: 'T', messages: [] }, NOW);
    expect(getConversation(db, 'c2')!.client_state).toBeNull();
    expect(setClientState(db, 'c2', { doc: true, board: false, nodes: [] }, NOW)).toBe(true);
    expect(getConversation(db, 'c2')!.client_state).toEqual({ doc: true, board: false, nodes: [] });
  });

  it('setClientState upserts a missing conversation carrying the state (returns existed=false)', () => {
    // Pre-first-message window: a host (web) toggles a context chip before any message has
    // created the row. The upsert must create it so the state persists (survives reload) and
    // the first turn reads it instead of the default.
    expect(getConversation(db, 'missing')).toBeNull();
    expect(setClientState(db, 'missing', { doc: false, board: true, nodes: ['n1'] }, NOW)).toBe(false);
    const created = getConversation(db, 'missing');
    expect(created).not.toBeNull();
    expect(created!.client_state).toEqual({ doc: false, board: true, nodes: ['n1'] });
    expect(created!.messages).toEqual([]);
    // Created rows are active (visible in the default list).
    expect(listConversations(db).map((c) => c.id)).toContain('missing');
  });

  it('setClientState does NOT bump updated_at (context edits must not reorder the list)', () => {
    saveConversation(db, { id: 'c2', title: 'T', messages: [] }, NOW);
    setClientState(db, 'c2', { doc: false }, LATER);
    expect(getConversation(db, 'c2')!.conversation.updated_at).toBe(NOW);
  });

  it('unarchive flips archived back to 0; missing id → false', () => {
    saveConversation(db, { id: 'c3', title: 'T', messages: [] }, NOW);
    archiveConversation(db, 'c3', NOW);
    expect(listConversations(db)).toHaveLength(0); // hidden
    expect(unarchiveConversation(db, 'c3', LATER)).toBe(true);
    expect(listConversations(db).map((c) => c.id)).toContain('c3');
    expect(unarchiveConversation(db, 'missing', LATER)).toBe(false);
  });
});
