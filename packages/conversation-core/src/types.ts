import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ConversationMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

/** List-row alias (engine list-conversations returns ConversationMeta rows). */
export type ConversationSummary = ConversationMeta;

export interface ConversationWithMessages {
  conversation: ConversationMeta;
  messages: unknown[];
  linked_docs: string[];
  /** Opaque host UI state (web: {doc,board,nodes}); engine never parses it. */
  client_state: unknown;
}

export interface SaveConversationInput {
  id: string;
  title?: string;
  messages?: unknown[];
  /** When provided, replaces the opaque client_state; when omitted, the engine preserves it. */
  client_state?: unknown;
  /** Optional ISO-timestamp overrides (one-time chat.db migration preserving original timestamps); when omitted the engine stamps now. */
  created_at?: string;
  updated_at?: string;
}

/** Tool-name-agnostic call core. Same structural shape as @vault/board-core's CallFn. */
export type CallFn = (toolCall: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<CallToolResult>;
