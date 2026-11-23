# Vault Obsidian Package Guidance

## Scope and role

This file extends the root `AGENTS.md` for `packages/obsidian-plugin/**`. Vault Obsidian
is the desktop-only Obsidian client for Engine-backed queries, chat, boards,
conversations, search, and model management.

Read `README.md` before changing transport, persistence orchestration, shared UI
composition, or build/install behavior. The README owns user-facing setup and the current
package map; this file keeps the critical client boundaries in context.

## Thin-client boundaries

- Engine remains authoritative for vault nodes, settings, models, conversations, boards,
  usage, and every governed mutation. Never write vault Markdown or Engine SQLite
  directly from the plugin.
- Communicate with Engine and Curator only through their public HTTP/MCP surfaces. Never
  import source from either deployable package.
- Keep host-agnostic behavior in the existing shared packages. The plugin owns Obsidian
  lifecycle, commands, leaves/views, connection setup, host persistence orchestration,
  preview/navigation behavior, and the streaming-relay adapter.
- Preserve preview-first mutation behavior and Engine version/validation gates. Do not
  turn the plugin into a competing state store or validation authority.
- Engine tools win when Engine and Curator discovery returns the same tool name. Curator
  tools are available only when a Curator endpoint and scoped token are configured.

## Transport, models, and credentials

- MCP uses Obsidian's CORS-free buffered `requestUrl` with the existing Streamable HTTP
  session handling. Provider response bytes stream through Engine's allowlisted
  `/llm/stream` relay because `requestUrl` does not expose a renderer stream.
- Preserve the relay's HTTPS and host-allowlist protections. Do not add a renderer-side
  direct-fetch path that bypasses Engine transport controls.
- Provider keys and service tokens are local Obsidian connection data. Never log them,
  place them in messages or tool arguments, or persist them outside the established
  `data.json` settings path.
- Model and behavioral chat settings come from Engine's settings/model catalog. Keep
  connection details, local key availability, and the documented search preference in
  plugin settings; do not duplicate catalog policy in `data.json`.

## Package ownership

- `src/main.ts` owns plugin lifecycle and top-level registration.
- `src/engine/` owns MCP transport, typed clients, settings/catalog access, and active-doc
  scope.
- `src/chat/`, `src/boards/`, `src/search/`, and `src/models/` own their Obsidian host
  integrations; reusable logic belongs in the corresponding `@vault/*` package.
- `src/llm/` maps catalog models to the Engine streaming relay. It must not become a second
  model catalog or usage ledger.
- Tests live in `test/` and should mirror the affected source domain.

## Commands and validation

Run from the repository root.

- `npm run dev -w vault-obsidian` — start the esbuild watcher.
- `npm run build -w vault-obsidian` — build shared dependencies, typecheck the plugin, and
  emit the production bundle.
- `npm test -w vault-obsidian` — run the Vitest and React Testing Library suite.

Run focused tests first, then the package build and full package tests. Changes to MCP
envelopes, messages, generated parts, persisted board/conversation shapes, query
mutations, or shared CSS require the affected shared-package and Engine consumer tests
plus `npm run lint:deps`. Exercise lifecycle, command registration, navigation, and
renderer/CSS changes in Obsidian when unit coverage cannot prove the host integration.

## Generated files and review

Generated `main.js` is ignored and must not be committed. Never commit Obsidian
`data.json`, provider keys, service tokens, vault content, or installed-plugin copies.

Reviews must call out Engine/Curator contract effects, local credential handling,
persisted client-state changes, shared-package impact, and manual Obsidian verification.
Include screenshots for user-visible changes.
