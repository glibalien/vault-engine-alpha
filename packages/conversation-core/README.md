# @vault/conversation-core

`@vault/conversation-core` is the host-agnostic client for conversations persisted by
Vault Engine. It owns shared conversation metadata and save shapes, wraps the Engine
MCP tools, and defines the cross-surface rule for following a document's conversation.

Engine stores message arrays and `client_state` opaquely. This package transports
those values but does not interpret AI SDK message parts or host UI state.

## Usage

```ts
import {
  makeConversationClient,
  type CallFn,
} from '@vault/conversation-core';

declare const call: CallFn;

const conversations = makeConversationClient(call);

await conversations.save({
  id: crypto.randomUUID(),
  title: 'Release planning',
  messages: [],
  client_state: { doc: true, board: false, nodes: [] },
});
```

The client exposes:

```ts
interface ConversationClient {
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
```

Omitted `messages`, `title`, or `client_state` fields on `save()` are preserved by
Engine rather than replaced. Timestamp overrides exist for controlled migrations;
normal hosts should omit them and let Engine stamp the save.

## Follow behavior

`pickFollowConversation(summaries)` selects the most recently updated active
(non-archived) conversation linked to a document. It returns `null` when the host
should start a fresh conversation. The function does not rely on server sort order.

This rule is shared so a conversation follows the active document consistently across
hosts. The package does not subscribe to editor events or decide when follow mode is
enabled.

## Boundaries

- Depends only on the MCP SDK at runtime.
- Does not import Engine, Curator, Obsidian, or `@vault/contract`.
- Does not own message rendering, transcript flattening, model calls, or chat context.
- Does not parse `client_state`; [`@vault/chat-core`](../chat-core/README.md) owns the
  shared chat-context shape.
- Permanent deletion remains an explicit client call; archive/unarchive are separate
  operations.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Conversation metadata, summary, payload, save, and transport contracts |
| `src/conversation-client.ts` | MCP envelope parsing and client implementation |
| `src/follow.ts` | Most-recent active-conversation selection |
| `test/` | Client and follow behavior coverage |

## Development

```bash
npm run typecheck -w @vault/conversation-core
npm run build -w @vault/conversation-core
npm test -w @vault/conversation-core
```

Persisted-shape changes require coordinated Engine and Obsidian tests.

## License

MIT
