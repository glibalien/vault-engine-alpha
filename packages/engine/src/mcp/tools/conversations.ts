import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  listConversations, getConversation, saveConversation, archiveConversation, unarchiveConversation,
  setClientState, deleteConversation,
  linkConversationToDoc, unlinkConversationFromDoc, listConversationsForDoc, listDocsForConversation,
} from '../../conversations/store.js';
import { ok, fail } from './errors.js';

const oops = (err: unknown) => fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
// The tools that can create a conversation refuse a blank id: no reader can address such a row.
const blankId = (id: string) => id.trim() === '' ? fail('INVALID_PARAMS', 'id must be a non-empty string') : null;

export function registerConversationTools(server: McpServer, db: Database.Database): void {
  server.tool('list-conversations', 'List saved chat conversations (newest first); optionally include archived rows and linked node ids. Pass doc_node_id to list only conversations associated with that document.',
    { include_archived: z.boolean().optional(), include_linked_docs: z.boolean().optional(), doc_node_id: z.string().optional() },
    async ({ include_archived, include_linked_docs, doc_node_id }) => {
      try {
        if (doc_node_id === undefined) return ok({ conversations: listConversations(db, include_archived ?? false, include_linked_docs ?? false) });
        const rows = listConversationsForDoc(db, doc_node_id, include_archived ?? false);
        return ok({ conversations: include_linked_docs ? rows.map(row => ({ ...row, linked_docs: listDocsForConversation(db, row.id).sort() })) : rows });
      } catch (e) { return oops(e); }
    });

  server.tool('get-conversation', 'Get a conversation by id, with its ordered messages and linked_docs (node ids).',
    { id: z.string() },
    async ({ id }) => { try { const c = getConversation(db, id); return c ? ok(c) : fail('NOT_FOUND', `no conversation ${id}`); } catch (e) { return oops(e); } });

  server.tool('save-conversation', 'Upsert a conversation (id + optional title) and replace its messages. Omit messages to update metadata only (e.g. an async title save) while preserving stored messages. Messages + client_state stored opaquely; omit client_state to preserve the existing blob. created_at/updated_at are optional ISO-timestamp overrides; omit them to stamp now.',
    { id: z.string(), title: z.string().optional(), messages: z.array(z.unknown()).optional(), client_state: z.unknown().optional(), created_at: z.string().optional(), updated_at: z.string().optional() },
    async ({ id, title, messages, client_state, created_at, updated_at }) => { const blank = blankId(id); if (blank) return blank; try { saveConversation(db, { id, title, messages, client_state, created_at, updated_at }, new Date().toISOString()); return ok({ id }); } catch (e) { return oops(e); } });

  server.tool('link-conversation', 'Associate a conversation with a document (by node id), or pass linked:false to remove the association. Idempotent. Returns {linked} or {unlinked}.',
    { conversation_id: z.string(), doc_node_id: z.string(), linked: z.boolean().default(true) },
    async ({ conversation_id, doc_node_id, linked }) => {
      try {
        const now = Date.now();
        if (linked === false) return ok(unlinkConversationFromDoc(db, conversation_id, doc_node_id, now));
        if (!getConversation(db, conversation_id)) return fail('NOT_FOUND', `no conversation ${conversation_id}`);
        return ok(linkConversationToDoc(db, conversation_id, doc_node_id, now));
      } catch (e) { return oops(e); }
    });

  server.tool('archive-conversation', 'Soft-archive a conversation (hidden from the default list), or pass archived:false to restore it. Returns {archived} or {unarchived}: whether the row existed.',
    { id: z.string(), archived: z.boolean().default(true) },
    async ({ id, archived }) => {
      try {
        const now = new Date().toISOString();
        return ok(archived === false ? { unarchived: unarchiveConversation(db, id, now) } : { archived: archiveConversation(db, id, now) });
      } catch (e) { return oops(e); }
    });

  server.tool('delete-conversation', 'Permanently delete a conversation, its messages, and its doc links.',
    { id: z.string() },
    async ({ id }) => { try { return ok({ deleted: deleteConversation(db, id) }); } catch (e) { return oops(e); } });

  server.tool('set-conversation-state', "Replace a conversation's opaque client_state blob, upserting the conversation if it doesn't exist yet (host UI state; engine never parses it).",
    { id: z.string(), client_state: z.unknown() },
    async ({ id, client_state }) => { const blank = blankId(id); if (blank) return blank; try { setClientState(db, id, client_state, new Date().toISOString()); return ok({ ok: true }); } catch (e) { return oops(e); } });
}
