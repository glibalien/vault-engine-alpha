// Thin re-export of the shared @vault/conversation-core package so the plugin and
// vault-chat web drive the engine conversation store through one implementation.
// Existing imports of this module (chat-view.ts, ChatPane.tsx, ConversationSwitcher.tsx,
// the client test) keep working unchanged; the package's ConversationClient.get now
// returns ConversationWithMessages (a superset of the old local return type).
export { makeConversationClient } from '@vault/conversation-core';
export type {
  ConversationClient,
  ConversationMeta,
  ConversationSummary,
  ConversationWithMessages,
  SaveConversationInput,
  CallFn,
} from '@vault/conversation-core';
