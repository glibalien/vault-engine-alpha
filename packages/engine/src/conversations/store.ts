import type Database from 'better-sqlite3';

export interface ConversationMeta {
  id: string; title: string; created_at: string; updated_at: string; archived: number;
}
export interface ConversationAuthorityMeta extends ConversationMeta { revision: number }
export type ConversationListMeta = ConversationMeta & { revision?: number; linked_docs?: string[] };
export interface ConversationWithMessages {
  conversation: ConversationAuthorityMeta; messages: unknown[]; linked_docs: string[];
  /** Opaque host UI state (web: {doc,board,nodes}); parsed from JSON, null when unset. Engine never interprets it. */
  client_state: unknown;
}

export { upgradeConversationsStore, upgradeConversationLinks } from '../db/migrate.js';

const META_COLS = 'id, title, created_at, updated_at, archived';
const AUTHORITY_META_COLS = `${META_COLS}, revision`;

export function listConversations(
  db: Database.Database,
  includeArchived = false,
  includeLinkedDocs = false,
): ConversationListMeta[] {
  if (!includeLinkedDocs) {
    const where = includeArchived ? '' : 'WHERE archived = 0';
    return db.prepare(`SELECT ${META_COLS} FROM conversations ${where} ORDER BY updated_at DESC, id`).all() as ConversationMeta[];
  }

  const where = includeArchived ? '' : 'WHERE c.archived = 0';
  const rows = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at, c.archived, c.revision,
           COALESCE(json_group_array(l.doc_node_id) FILTER (WHERE l.doc_node_id IS NOT NULL), '[]') AS linked_docs_json
      FROM conversations c LEFT JOIN conversation_links l ON l.conversation_id = c.id
      ${where}
     GROUP BY c.id ORDER BY c.updated_at DESC, c.id
  `).all() as Array<ConversationMeta & { linked_docs_json: string }>;
  return rows.map(({ linked_docs_json, ...row }) => ({
    ...row,
    linked_docs: (JSON.parse(linked_docs_json) as string[]).sort(),
  }));
}

export function getConversation(db: Database.Database, id: string): ConversationWithMessages | null {
  const conversation = db.prepare(`SELECT ${AUTHORITY_META_COLS} FROM conversations WHERE id = ?`).get(id) as ConversationAuthorityMeta | undefined;
  if (!conversation) return null;
  const stateRow = db.prepare('SELECT client_state FROM conversations WHERE id = ?').get(id) as { client_state: string | null } | undefined;
  const client_state = stateRow?.client_state != null ? (JSON.parse(stateRow.client_state) as unknown) : null;
  const rows = db.prepare('SELECT message_json FROM messages WHERE conversation_id = ? ORDER BY seq').all(id) as Array<{ message_json: string }>;
  return { conversation, messages: rows.map((r) => JSON.parse(r.message_json) as unknown), linked_docs: listDocsForConversation(db, id), client_state };
}

/**
 * Upsert metadata + REPLACE all message rows. Reads only message.role + serializes (opaque).
 * client_state is written ONLY when provided (preserve-on-omit) so per-turn message saves that
 * don't carry it leave the stored context untouched.
 *
 * messages is preserve-on-omit (like client_state): omitting it updates metadata (title/timestamps)
 * only — the async title-only save both chat surfaces perform after the first exchange.
 *
 * created_at/updated_at are OPTIONAL timestamp overrides — when omitted the row is stamped with
 * `now` exactly as before (default behavior unchanged). They exist so the one-time chat.db
 * migration can preserve each conversation's original timestamps; without them every migrated
 * conversation would collapse to the migration instant and dominate the updated_at-DESC list.
 */
export function saveConversation(db: Database.Database, input: { id: string; title?: string; messages?: unknown[]; client_state?: unknown; created_at?: string; updated_at?: string }, now: string): void {
  db.transaction(() => {
    const updatedAt = input.updated_at ?? now;
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(input.id) as { id: string } | undefined;
    if (existing) {
      if (input.title !== undefined) db.prepare('UPDATE conversations SET title = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(input.title, updatedAt, input.id);
      else db.prepare('UPDATE conversations SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(updatedAt, input.id);
    } else {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)`)
        .run(input.id, input.title ?? 'New chat', input.created_at ?? now, updatedAt);
    }
    if (input.client_state !== undefined) {
      db.prepare('UPDATE conversations SET client_state = ? WHERE id = ?').run(JSON.stringify(input.client_state), input.id);
    }
    if (input.messages !== undefined) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(input.id);
      const ins = db.prepare('INSERT INTO messages (conversation_id, seq, role, message_json) VALUES (?, ?, ?, ?)');
      input.messages.forEach((m, i) => {
        const role = typeof (m as { role?: unknown })?.role === 'string' ? (m as { role: string }).role : 'unknown';
        ins.run(input.id, i, role, JSON.stringify(m));
      });
    }
  })();
}

export function archiveConversation(db: Database.Database, id: string, now: string): boolean {
  return db.prepare('UPDATE conversations SET archived = 1, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now, id).changes > 0;
}

/** Restore an archived conversation (archived = 0). Returns whether the row existed. */
export function unarchiveConversation(db: Database.Database, id: string, now: string): boolean {
  return db.prepare('UPDATE conversations SET archived = 0, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now, id).changes > 0;
}

/**
 * Replace the opaque client_state blob (JSON-serialized). UPSERTS: if the conversation row
 * doesn't exist yet, it is created carrying the state (default title, no messages). Hosts
 * (web) persist per-conversation UI state — e.g. context-chip toggles — that can be edited
 * BEFORE the first message has created the row; without the upsert those edits would be
 * silently dropped. The upsert touches only client_state on an existing row (never updated_at
 * or messages), so it can't reorder the list or clobber a concurrent message save.
 * Returns whether the row pre-existed (false ⇒ it was just created).
 */
export function setClientState(db: Database.Database, id: string, clientState: unknown, now: string): boolean {
  const existed = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id) !== undefined;
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, archived, client_state)
    VALUES (?, 'New chat', ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET client_state = excluded.client_state
  `).run(id, now, now, JSON.stringify(clientState));
  return existed;
}

export function deleteConversation(db: Database.Database, id: string): boolean {
  // Explicit cascade alongside the FK ON DELETE CASCADE (belt-and-braces).
  db.prepare('DELETE FROM conversation_links WHERE conversation_id = ?').run(id);
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
}

// --- conversation↔doc associations (node-id keyed, pure M:N; mirrors board_links) ---

/** Associate a conversation with a doc (by node id). Idempotent: re-link → linked:false. */
export function linkConversationToDoc(db: Database.Database, conversation_id: string, doc_node_id: string, now: number): { linked: boolean } {
  return db.transaction(() => {
    const res = db.prepare('INSERT OR IGNORE INTO conversation_links (conversation_id, doc_node_id, created_at) VALUES (?, ?, ?)').run(conversation_id, doc_node_id, now);
    if (res.changes > 0) {
      db.prepare('UPDATE conversations SET updated_at = ?, revision = revision + 1 WHERE id = ?')
        .run(new Date(now).toISOString(), conversation_id);
    }
    return { linked: res.changes > 0 };
  })();
}

export function unlinkConversationFromDoc(db: Database.Database, conversation_id: string, doc_node_id: string, now: number): { unlinked: boolean } {
  return db.transaction(() => {
    const res = db.prepare('DELETE FROM conversation_links WHERE conversation_id = ? AND doc_node_id = ?').run(conversation_id, doc_node_id);
    if (res.changes > 0) {
      db.prepare('UPDATE conversations SET updated_at = ?, revision = revision + 1 WHERE id = ?')
        .run(new Date(now).toISOString(), conversation_id);
    }
    return { unlinked: res.changes > 0 };
  })();
}

/** Conversations linked to a doc, most-recently-updated first; hides archived unless asked. */
export function listConversationsForDoc(db: Database.Database, doc_node_id: string, includeArchived = false): ConversationMeta[] {
  const archivedClause = includeArchived ? '' : 'AND c.archived = 0';
  return db.prepare(
    `SELECT ${META_COLS.split(', ').map((c) => `c.${c}`).join(', ')}
       FROM conversations c JOIN conversation_links l ON l.conversation_id = c.id
      WHERE l.doc_node_id = ? ${archivedClause}
      ORDER BY c.updated_at DESC, c.id`,
  ).all(doc_node_id) as ConversationMeta[];
}

/** Doc node ids a conversation is linked to (oldest link first). */
export function listDocsForConversation(db: Database.Database, id: string): string[] {
  return (db.prepare('SELECT doc_node_id FROM conversation_links WHERE conversation_id = ? ORDER BY created_at').all(id) as Array<{ doc_node_id: string }>)
    .map((r) => r.doc_node_id);
}
