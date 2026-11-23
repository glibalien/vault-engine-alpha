# @vault/chat-ui

`@vault/chat-ui` is the shared React presentation library for Vault Engine chat
surfaces. It renders message threads, Markdown, wikilinks, Engine tool traces, the
composer, model selection, context controls, and conversation navigation.

The package is intentionally transport- and model-agnostic. It does not import
`@vault/chat-core`, `@vault/query-core`, `@vault/viz-ui`, Engine, Curator, or Obsidian.
Hosts supply data and callbacks.

## Use it in a host

Import the stylesheet once, then compose the pieces the host needs:

```tsx
import {
  Composer,
  Thread,
  ToolTrace,
  type ChatUIPart,
} from '@vault/chat-ui';
import '@vault/chat-ui/styles.css';

export function ChatSurface() {
  return (
    <>
      <Thread
        messages={messages}
        renderPart={(part: ChatUIPart) =>
          part.type === 'dynamic-tool'
            ? <ToolTrace part={part as never} />
            : null
        }
        onOpenPreview={openPreview}
      />
      <Composer
        disabled={false}
        streaming={streaming}
        capped={capped}
        searchNodes={searchNodes}
        onSend={send}
        onStop={stop}
        onAddNodeChip={addContextNode}
        onOpenPreview={openPreview}
      />
    </>
  );
}
```

This is presentation wiring, not a complete chat implementation. The host owns message
state, transport, streaming, persistence, model resolution, tool execution, node
search, preview routing, and context persistence.

## Components

| Component | Responsibility |
| --- | --- |
| `Thread` | Ordered message list with automatic scroll-to-end |
| `Message` | User/assistant layout, GFM Markdown, safe links, and host-rendered non-text parts |
| `ToolTrace` | Running/success/failure state, arguments, warnings, duration, and expandable tool details |
| `Reasoning` | A model's reasoning part, muted: open while the host marks it live (with a working indicator while the part streams), then one line the reader can expand; nothing for an empty part |
| `Composer` | Send/stop controls, multiline input, `@` node autocomplete, context-chip callback, and optional model picker |
| `ModelPicker` | Model choices with provider groups, key availability, and unpriced-state metadata supplied by the host |
| `ContextChipsBar` | Active-note, board, pinned-node, add-context, and optional follow controls |
| `AddContextPicker` | Search-and-pick UI for pinned nodes |
| `ConversationSwitcher` | Conversation selection, follow mode, archive/unarchive, attach, and delete actions |
| `ComposerAutocomplete` | Keyboard-navigable suggestion list |
| `Icon` | Small package-local icon set |

## Message and link behavior

`ChatUIMessage` is deliberately structural: an AI SDK `UIMessage` with `id`, `role`,
and `parts` satisfies it without this package depending on the SDK.

Text parts render through `react-markdown` with GFM. Obsidian-style `[[wikilinks]]`
are converted to an internal `vault://` form and become preview buttons when the host
supplies `onOpenPreview`. All other URLs pass through `react-markdown`'s safe default
URL transform; external links open in a new tab with `noreferrer`.

Non-text parts are not guessed at. `Thread`/`Message` call the host's `renderPart`
callback so the surface can render visualization cards or other application-specific
parts without coupling chat-ui to those packages.

## Tool envelopes

`ToolTrace` recognizes Engine-style tool output using helpers backed by
[`@vault/contract`](../contract/README.md):

- `envelopeOk()`
- `envelopeWarnings()`
- `envelopeMs()`

It treats an AI SDK output error or an `ok: false` Engine envelope as failed, and
surfaces warning codes without converting them into failures.

## Composer behavior

- Enter sends; Shift+Enter inserts a newline.
- `@` opens debounced node search with stale-result protection.
- Arrow keys navigate suggestions; Enter or Tab selects; Escape closes.
- Selecting a node inserts its title and can add a context chip through the host.
- When a response stops at the host's step cap, the optional continue action sends
  `Continue.`.
- A supplied model picker is mutually exclusive with the autocomplete popover.

## Boundaries

- React and presentation state only; no Engine/Curator connections.
- No AI SDK dependency and no model execution.
- No board or visualization rendering; hosts provide `renderPart`.
- No conversation persistence; the switcher emits callbacks.
- CSS class names in `styles.css` are part of host integration and should change with
  corresponding consumer checks.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/Message.tsx`, `Thread.tsx`, `ToolTrace.tsx` | Message and tool-call rendering |
| `src/composer/` | Composer, autocomplete, insertion logic, trigger parsing, and model picker |
| `src/context/` | Context chips and add-context picker |
| `src/conversation/` | Conversation switcher |
| `src/chat-wikilinks.ts` | Wikilink conversion and internal-link parsing |
| `src/envelope.ts` | Tool-envelope presentation helpers |
| `styles.css` | Host-imported chat stylesheet |
| `test/` | Component and pure-helper coverage |

## Development

```bash
npm run typecheck -w @vault/chat-ui
npm run build -w @vault/chat-ui
npm test -w @vault/chat-ui
```

Run Obsidian tests after component contracts or CSS behavior change.

## License

MIT
