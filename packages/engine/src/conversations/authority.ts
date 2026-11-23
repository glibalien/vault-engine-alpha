import type Database from 'better-sqlite3';
import { z } from 'zod';

export const conversationAuthorityGuardSchema = z.object({
  conversation_id: z.string().min(1),
  expected_revision: z.number().int().min(1),
  expected_link_mode: z.enum(['bound', 'unbound']),
  expected_linked_docs: z.array(z.string().min(1)),
}).superRefine((guard, context) => {
  const unique = new Set(guard.expected_linked_docs);
  if (unique.size !== guard.expected_linked_docs.length) {
    context.addIssue({ code: 'custom', path: ['expected_linked_docs'], message: 'linked document ids must be unique' });
  }
  const actualMode = guard.expected_linked_docs.length > 0 ? 'bound' : 'unbound';
  if (actualMode !== guard.expected_link_mode) {
    context.addIssue({ code: 'custom', path: ['expected_link_mode'], message: 'link mode must match the expected linked document set' });
  }
});

export type ConversationAuthorityGuard = z.infer<typeof conversationAuthorityGuardSchema>;

export interface ConversationAuthorityState {
  conversation_id: string;
  current_revision: number | null;
  current_link_mode: 'bound' | 'unbound';
  current_linked_docs: string[];
}

export class ConversationAuthorityError extends Error {
  constructor(public readonly state: ConversationAuthorityState) {
    super(state.current_revision === null
      ? `Conversation ${state.conversation_id} no longer exists`
      : `Conversation ${state.conversation_id} changed after capture planning`);
    this.name = 'ConversationAuthorityError';
  }
}

/** Must be called from the same SQLite transaction as the guarded mutation. */
export function assertConversationAuthority(
  db: Database.Database,
  guard: ConversationAuthorityGuard | undefined,
): void {
  if (!guard) return;

  const row = db.prepare('SELECT revision FROM conversations WHERE id = ?')
    .get(guard.conversation_id) as { revision: number } | undefined;
  const linkedDocs = row
    ? (db.prepare('SELECT doc_node_id FROM conversation_links WHERE conversation_id = ? ORDER BY doc_node_id')
        .all(guard.conversation_id) as Array<{ doc_node_id: string }>).map(({ doc_node_id }) => doc_node_id)
    : [];
  const state: ConversationAuthorityState = {
    conversation_id: guard.conversation_id,
    current_revision: row?.revision ?? null,
    current_link_mode: linkedDocs.length > 0 ? 'bound' : 'unbound',
    current_linked_docs: linkedDocs,
  };
  const expectedDocs = [...guard.expected_linked_docs].sort();
  const sameDocs = expectedDocs.length === linkedDocs.length
    && expectedDocs.every((docId, index) => docId === linkedDocs[index]);
  if (
    row?.revision !== guard.expected_revision
    || state.current_link_mode !== guard.expected_link_mode
    || !sameDocs
  ) {
    throw new ConversationAuthorityError(state);
  }
}
