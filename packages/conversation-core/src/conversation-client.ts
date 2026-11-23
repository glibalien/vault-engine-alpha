import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConversationMeta, ConversationSummary, ConversationWithMessages, SaveConversationInput, CallFn } from './types.js';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function parseEnvelope<T>(result: CallToolResult): Envelope<T> {
  const first = result.content?.[0] as { type: string; text?: string } | undefined;
  if (typeof first?.text !== 'string') throw new Error('conversation tool result missing text content');
  return JSON.parse(first.text) as Envelope<T>;
}

export interface ConversationClient {
  list(includeArchived?: boolean): Promise<ConversationSummary[]>;
  get(id: string): Promise<ConversationWithMessages | null>;
  save(input: SaveConversationInput): Promise<void>;
  archive(id: string): Promise<boolean>;
  unarchive(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  linkToDoc(id: string, docNodeId: string): Promise<boolean>;
  unlinkFromDoc(id: string, docNodeId: string): Promise<boolean>;
  listForDoc(docNodeId: string, includeArchived?: boolean): Promise<ConversationSummary[]>;
  setState(id: string, clientState: unknown): Promise<boolean>;
}

export function makeConversationClient(call: CallFn): ConversationClient {
  return {
    async list(includeArchived = false) {
      const env = parseEnvelope<{ conversations: ConversationMeta[] }>(await call({ name: 'list-conversations', arguments: { include_archived: includeArchived } }));
      return env.data?.conversations ?? [];
    },
    async get(id: string) {
      const env = parseEnvelope<ConversationWithMessages>(await call({ name: 'get-conversation', arguments: { id } }));
      return env.ok && env.data ? env.data : null;
    },
    async save(input: SaveConversationInput) {
      const args: Record<string, unknown> = { id: input.id };
      if (input.messages !== undefined) args.messages = input.messages;
      if (input.title !== undefined) args.title = input.title;
      if (input.client_state !== undefined) args.client_state = input.client_state;
      if (input.created_at !== undefined) args.created_at = input.created_at;
      if (input.updated_at !== undefined) args.updated_at = input.updated_at;
      const env = parseEnvelope<{ id: string }>(await call({ name: 'save-conversation', arguments: args }));
      if (!env.ok) throw new Error('save-conversation failed');
    },
    async archive(id: string) {
      const env = parseEnvelope<{ archived: boolean }>(await call({ name: 'archive-conversation', arguments: { id } }));
      return env.data?.archived ?? false;
    },
    async unarchive(id: string) {
      const env = parseEnvelope<{ unarchived: boolean }>(await call({ name: 'archive-conversation', arguments: { id, archived: false } }));
      return env.data?.unarchived ?? false;
    },
    async remove(id: string) {
      const env = parseEnvelope<{ deleted: boolean }>(await call({ name: 'delete-conversation', arguments: { id } }));
      return env.data?.deleted ?? false;
    },
    async linkToDoc(id: string, docNodeId: string) {
      const env = parseEnvelope<{ linked: boolean }>(await call({ name: 'link-conversation', arguments: { conversation_id: id, doc_node_id: docNodeId } }));
      return env.data?.linked ?? false;
    },
    async unlinkFromDoc(id: string, docNodeId: string) {
      const env = parseEnvelope<{ unlinked: boolean }>(await call({ name: 'link-conversation', arguments: { conversation_id: id, doc_node_id: docNodeId, linked: false } }));
      return env.data?.unlinked ?? false;
    },
    async listForDoc(docNodeId: string, includeArchived = false) {
      const env = parseEnvelope<{ conversations: ConversationMeta[] }>(await call({ name: 'list-conversations', arguments: { doc_node_id: docNodeId, include_archived: includeArchived } }));
      return env.data?.conversations ?? [];
    },
    async setState(id: string, clientState: unknown) {
      const env = parseEnvelope<{ ok: boolean }>(await call({ name: 'set-conversation-state', arguments: { id, client_state: clientState } }));
      return env.ok;
    },
  };
}
