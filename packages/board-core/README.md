# @vault/board-core

`@vault/board-core` is the host-agnostic board client and board-state library. It
defines persisted board shapes, wraps Engine's board MCP tools, and provides pure card
operations shared by board-capable surfaces.

The package does not render a board or decide how a host navigates. The Obsidian plugin
currently supplies those concerns.

## Responsibilities

- Typed board, card, summary, save-input, and document-scope contracts.
- A transport-injected `BoardClient` over Engine's board tools.
- Pure add, remove, reorder, and resize operations with stable card ordering.
- Table and kanban starter presets.
- Selection of the most recently updated board linked to an active document.
- `orderBoards`: the stable oldest-first order for a note's boards.

A board holds several views (cards). The Obsidian plugin shows the selected board's views as
tabs, in card order.

It depends on the MCP SDK for `CallToolResult` and on
[`@vault/viz-ui`](../viz-ui/README.md) for visualization/card spec types. It never
imports Engine, Curator, Obsidian, or `@vault/contract`.

## Usage

Hosts inject a generic MCP call function:

```ts
import {
  KANBAN_PRESET,
  addCard,
  makeBoardClient,
  type CallFn,
} from '@vault/board-core';

declare const call: CallFn;

const boards = makeBoardClient(call);
const cards = addCard([], KANBAN_PRESET, () => crypto.randomUUID());
const { id } = await boards.save({
  name: 'Project board',
  cards,
});

await boards.linkToDoc(id, 'engine-node-id');
```

The client exposes:

```ts
interface BoardClient {
  list(): Promise<BoardSummary[]>;
  get(id: string): Promise<Board | null>;
  save(input: SaveBoardInput): Promise<{ id: string }>;
  remove(id: string): Promise<boolean>;
  linkToDoc(boardId: string, docNodeId: string): Promise<boolean>;
  unlinkFromDoc(boardId: string, docNodeId: string): Promise<boolean>;
  listForDoc(docNodeId: string): Promise<BoardSummary[]>;
}
```

`BoardCard.spec` is `unknown` at rest because Engine stores cards opaquely. Hosts
should parse it through `parseBoardCardSpec()` from `@vault/viz-ui` before rendering.

## Pure card operations

| Export | Behavior |
| --- | --- |
| `addCard(cards, spec, makeId)` | Appends a card without mutating the input array |
| `removeCard(cards, cardId)` | Removes a card and compacts every `layout.order` |
| `reorderCard(cards, cardId, toIndex)` | Moves a card to a clamped zero-based index and renumbers order |
| `resizeCard(cards, cardId, size)` | Updates optional width/height without changing other layout data |
| `TABLE_PRESET` | Recent-nodes table seed |
| `KANBAN_PRESET` | Task board grouped by status, with the vault map at its defaults |
| `kanbanPreset(vocabulary)` | The task board for a vault's own task kind and status field; `null` when it has none |
| `pickFollowBoard(summaries)` | Returns the most recently updated linked board ID or `null` |

The exported `DocScope` interface is the host seam for resolving and subscribing to
the active document. Host-specific Obsidian behavior stays outside this package.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Persisted board contracts, `CallFn`, and `DocScope` |
| `src/board-client.ts` | MCP envelope parsing and `BoardClient` implementation |
| `src/board-cards.ts` | Pure card operations and starter presets |
| `src/follow.ts` | Active-document follow selection |
| `test/` | Client, operation, preset, and follow coverage |

## Development

```bash
npm run typecheck -w @vault/board-core
npm run build -w @vault/board-core
npm test -w @vault/board-core
```

Changes to persisted card or board shapes must be tested against Engine's board store,
`@vault/viz-ui`, and the Obsidian board surface.

## License

MIT
