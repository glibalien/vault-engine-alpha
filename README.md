# Vault Engine

Vault Engine is a local-first, agent-native personal knowledge system. You work
exclusively with local files (Markdown, Office docs) and embedded attachments (audio, images, PDFs); Vault Engine turns it all into a typed, structured,
searchable knowledge graph vault and exposes the same governed capabilities to MCP-capable AI models (of your choosing) and autonomous AI services.

The AI can do everything you can do, and much of what the system does is yours to change via Markdown edits, to both your own content and the system's Markdown-exposed config. Update model routing, start a project wiki, correct a memory. Or ask the AI: adjust the database schema, bulk transcribe audio and delete the recordings, curate a custom automated wiki about your partner's upcoming birthday, summarize meetings.

DIY, or ask the LLM of your choosing to do it for you.

If you use Obsidian, it comes with a fantastic multi-surface plugin. But nothing requires it: the text editor of your choosing works for your notes and settings.

> **Project status:** Vault Engine is a personal, alpha-stage system. It has a terminal
> installer for new setups but no stable compatibility guarantee yet. See
> [CONTRIBUTING.md](CONTRIBUTING.md) before making changes, the
> [documentation index](docs/README.md) for current guidance, and the
> [repository safety policy](docs/repository-safety.md) before committing anything.

## What you get

| Area | Capabilities |
| --- | --- |
| Knowledge graph | Typed notes, shared fields, per-type schema overrides, references, defaults, validation, and safe schema evolution |
| Exhaustive AI graph tools | A discoverable, tiered MCP surface for retrieval, bounded filtering and aggregation, mutation, database management, batch/bulk work, undo, and more; AI can guide you on how to configure your graph, **and** implement the changes |
| Autonomous curation | Scheduled and on-demand project and topic wikis (with several sub-page templates), automated Vault organization, intelligent entity and field guessing, self-perpetuating knowledge loops |
| Durable, changeable memory | Memories auto-extract from changing Vault content and conversations, changes in preference tracked as distinct memories, memory editable via Markdown |
| Model agnostic | Mix and match Anthropic, Fireworks, OpenRouter, and OpenAI models for chat and curation, with optional Gemini, Deepgram, Exa, and other bounded integrations where their capabilities fit |
| Markdown Settings | Configure Vault Engine and Vault Curator behavior by updating local Markdown files; keep bootstrap paths, credentials, and connection details in their documented host-specific stores |
| Search and retrieval | Hybrid lexical and semantic search across Markdown, Office files, PDFs, images, and audio transcripts |
| Structured analysis | Bounded `all`/`any` filters, related-node summaries, saved rollups, relative-date windows, percentages, and dependency traversal without turning computed results into editable fields |
| Evidence and provenance | Optional retained synthesis inputs, output receipts, impact inspection, comparison with current sources, and deliberate composite purge controls |
| Operational safety | Dry-run previews, undo snapshots, path containment, atomic renders, health diagnostics, backups, and forensic logs |
| Spend visibility | One ledger for chat, curation, extraction, transcription, and other paid API calls, with CSV exports |

### ...and for Obsidian users

**Vault Engine for Obsidian**: Search, live query cards, boards, chat, context chips, model selection, provenance inspection, and integrated model discovery and orchestration, inside a single configurable Obsidian plugin.


## How it fits together

The Engine is the deterministic center. It takes no initiative of its own: it has been built to listen to AI via MCP and to humans via Markdown, and to carry out what either one asks under the same rules.

Every non-human surface is a client
of its MCP, including Vault Curator, which is the only service that performs
open-ended narrative synthesis.

Four rules keep that architecture intact:

1. **The database owns truth.** Markdown is a human-editable projection of
   canonical SQLite state.
2. **All writes share one pipeline.** Tool calls and reconciled file edits pass
   through parse, validate, coerce, reconcile, apply, and render stages.
3. **All non-human clients use MCP (all human clients use local files).** Obsidian and Curator never import Engine internals or edit
   its database directly. Humans use their local hard drive.
4. **Intelligence stays at the edges.** Engine performs deterministic work and
   bounded extraction; Curator and chat hosts own model loops and narrative output.

## Quick start

Before you start, you need:

- Linux with systemd, or a Mac with Apple Silicon
  ([On macOS](packages/installer/README.md#on-macos); Intel Macs are not supported).
- Node.js 24, the version pinned in [`.nvmrc`](.nvmrc), with npm (on a Mac, the arm64 build).
- On Linux, sudo, to install the two services (or `--no-sudo` to run the root commands
  yourself). On a Mac the services are launchd agents for your user and need no sudo.
- An API key for at least one AI provider (Anthropic, Fireworks, OpenRouter, or OpenAI),
  for Curator and chat.
- About 10 minutes, and 2 GB of free disk.

Then, from a checkout of this repository:

```bash
./install.sh
```

It first checks what would stop an install: systemd (launchd on a Mac), the Node.js version (with the command
to switch when mise, nvm, or fnm is installed), and the ports; it warns when disk space is
low. It installs
dependencies and builds in a few minutes, keeping their output in a log that it shows only
when a step fails, and runs the terminal installer. The installer asks
about your Markdown folder, how your notes say what they are, provider keys, models, and
Curator's budget. It shows one review of everything it would do, and changes nothing
until you approve it. Then it backs up the folder, starts Engine and Curator as systemd
services (showing each `sudo` command; on a Mac, as launchd agents that start when you
log in), gives your notes their types, applies the
settings, verifies the result, and writes a guide to reaching the services from the
internet. It exposes nothing itself.

- `./install.sh plan` shows what installing would do, changing nothing in your notes or
  on the system.
- `./install.sh --answers answers.json --yes` installs headlessly.
- `./install.sh status` checks an installation later.
- `./install.sh undo` reverts what organizing changed in your notes, and
  `./install.sh uninstall` removes the services.

Every `./install.sh` command first installs dependencies when they are stale and rebuilds
this checkout. Installed services run from the checkout's build output, so after a
`git pull` even `status` puts new code where the services will load it on their next
restart.

See the [installer README](packages/installer/README.md) for every question, the answers
file, and what each stage changes.

## Manual setup

To run the pieces yourself instead, use the Node.js version pinned in
[`.nvmrc`](.nvmrc) and an existing directory to use as a Markdown vault. Run commands from
the monorepo root unless a package README says otherwise.

### 1. Install and build

```bash
npm install
npm run build
```

The root build compiles all shared libraries, Engine, Curator, and the installer. The
Obsidian plugin is intentionally built separately.

If `npm install` or `npm ci` fails while building `sharp` from source, the machine has a
system-wide libvips that sharp tries to compile against. Use sharp's prebuilt binaries
instead:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci
```

### 2. Configure Engine

Copy the example environment file and add the absolute path to your vault:

```bash
cp packages/engine/.env.example packages/engine/.env
```

```dotenv
VAULT_PATH=/absolute/path/to/your/vault
```

For local stdio use, that is the only required value. If your notes name their kind under
a frontmatter key other than `types` (`type`, `kind`, ...), also set `VAULT_TYPE_KEY`
before the first start: Engine records the key its database was built with and refuses to
start with another. HTTP deployment also needs
`OAUTH_OWNER_PASSWORD` and the public `OAUTH_ISSUER_URL`. Provider keys enable
optional extraction, transcription, web search, and other bounded integrations;
missing keys disable only the corresponding integration.

### 3. Start Engine

Start the local stdio MCP server:

```bash
node packages/engine/dist/index.js
```

An MCP host launches this command itself. On stdio, stdout carries only MCP messages and
Engine's logs go to stderr. `npm start -w vault-engine` runs the same server but puts npm's
own banner on stdout, so don't give a host that form.

Engine trusts a stdio connection fully, because it has no sign-in: the rules it applies to
a chat AI (what `fetch-url` may load, who may change which memories) cover only clients that
sign in over HTTP. Connect a chat AI over HTTP, and keep stdio for scripts and hosts you
trust; the [Engine README](packages/engine/README.md#3-start-a-transport) says more.

Or start the HTTP transport on the repository's conventional deployment port:

```bash
node packages/engine/dist/index.js --transport http --port 3334
```

See [the Engine README](packages/engine/README.md) for OAuth, service tokens,
settings notes, transports, and deployment.

### 4. Add a surface

- Build and install [Vault Engine for Obsidian](packages/obsidian-plugin/README.md)
  for the desktop UI.
- Configure [Vault Curator](packages/curator/README.md) for scheduled wiki and
  memory maintenance.
- Connect any OAuth-capable MCP client to the Engine's `/mcp` endpoint.

## Limitations

Vault Engine is designed to run on a single computer and does not currently provide any sort of syncing service. Your files can live in a folder synced by a cloud-based file syncing service (e.g. Google Drive, Dropbox, iCloud Drive) or by Obsidian Sync. The exception is Engine's own database: a sync client can corrupt a live SQLite file, so the database and the search-model cache belong outside the synced folder. The installer puts them there when it sees a synced folder; for a manual setup, set `DB_PATH` and `EMBEDDER_MODELS_DIR`.

## Packages

This is one npm-workspaces product with three deployable surfaces, ten reusable
libraries, a standalone benchmark, and a terminal installer.

### Deployable surfaces

| Package | Workspace | Responsibility |
| --- | --- | --- |
| [Engine](packages/engine/README.md) | `vault-engine` | Database-authoritative MCP server, mutation pipeline, structured reads, provenance, search, extraction, memory, settings, usage, and diagnostics |
| [Curator](packages/curator/README.md) | `vault-curator` | Autonomous LLM service for project/topic wikis, optional provenance-tracked synthesis, memory sweeps, and governed organization |
| [Obsidian plugin](packages/obsidian-plugin/README.md) | `vault-obsidian` | Desktop client for Engine-backed search, chat, boards, live cards, provenance inspection, settings, and model management |

### Shared libraries

| Package | Responsibility |
| --- | --- |
| [`@vault/contract`](packages/contract/README.md) | Zero-runtime-dependency MCP response-envelope wire types and shared outcome verdicts |
| [`@vault/settings-registry`](packages/settings-registry/README.md) | Zero-runtime-dependency setting descriptors, defaults, validation, env seeding, and model-catalog types |
| [`@vault/pricing`](packages/pricing/README.md) | Zero-runtime-dependency rate table and token/audio cost arithmetic |
| [`@vault/llm`](packages/llm/README.md) | Provider SDK clients, usage normalization, and a provider-neutral single-turn call for Engine and Curator |
| [`@vault/query-core`](packages/query-core/README.md) | Host-agnostic query client, schema mirrors, caller-filter ownership, read adapters, and safe edit/create/bulk flow logic |
| [`@vault/viz-ui`](packages/viz-ui/README.md) | React visualization cards, provenance surfaces, query hooks, editing, filtering, and live refresh |
| [`@vault/board-core`](packages/board-core/README.md) | Board MCP client, board/card types, pure card operations, presets, and follow behavior |
| [`@vault/conversation-core`](packages/conversation-core/README.md) | Conversation MCP client, persistence types, document associations, and follow behavior |
| [`@vault/chat-core`](packages/chat-core/README.md) | Host-agnostic model loop, providers, tool tiering, context assembly, visualization interpretation, titles, and usage mapping |
| [`@vault/chat-ui`](packages/chat-ui/README.md) | React chat presentation: messages, tool traces, composer, context controls, model picker, and conversation switcher |

### Tooling

| Package | Responsibility |
| --- | --- |
| [`@vault/bench`](packages/bench/README.md) | Sandboxed replay benchmark for comparing candidate chat models against recorded Obsidian turns |
| [`vault-installer`](packages/installer/README.md) | Terminal installer for Engine and Curator: `plan`, `install`, `status`, `undo`, and `uninstall` (run through `./install.sh`) |

All packages are currently workspace-private except `vault-engine`; package names
describe ownership boundaries inside this repository, not independent installation
from npm.

## Repository workflows

```bash
npm run build          # ordered shared-library, Engine, Curator, and installer builds
npm run typecheck      # every workspace typecheck script that exists
npm test               # UI build, lockfile/dependency checks, then workspace tests
npm run lint:deps      # enforce package dependency direction
npm run lint:lockfile  # verify native dependency lockfile coverage
npm run lint:repo-safety  # reject committed secrets, owner data, and forbidden files
```

The Obsidian plugin is outside the root build order:

```bash
npm run build -w vault-obsidian
npm test -w vault-obsidian
```

For focused work, run the owning package's checks first:

```bash
npm run typecheck -w @vault/query-core
npm test -w @vault/query-core
npm run build -w @vault/query-core
```

## Contributor boundaries

- Engine never imports Curator. Deployable clients communicate with Engine over MCP.
- Shared libraries remain host-agnostic according to
  [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs).
- `@vault/contract`, `@vault/pricing`, and `@vault/settings-registry` have zero
  runtime dependencies on other workspace packages.
- No production package imports `@vault/bench`; Bench talks to a disposable Engine
  subprocess over MCP.
- Public MCP envelopes and persisted board/conversation shapes are cross-package
  contracts. Trace every consumer before changing them.
- Curator and other clients mutate vault state only through Engine tools.

Read the root [AGENTS.md](AGENTS.md) and the nearest package-level guidance before
making changes.

## Deployment shape

The reference deployment runs Engine and Curator as separate systemd services behind
TLS termination, commonly through one Cloudflare Tunnel:

| Service | Conventional port | Role |
| --- | --- | --- |
| `vault-engine-new` | `3334` | OAuth-protected MCP system of record |
| `vault-curator` | `3335` | OAuth-protected curation API and daily scheduler |

The Obsidian plugin runs on the user's desktop and connects to those HTTP endpoints.
Optional provider integrations degrade independently when their keys are absent.

An installation made by `./install.sh` names Engine's unit `vault-engine` instead. To
update one with `scripts/deploy.sh`, set `ENGINE_SERVICE=vault-engine` (and
`CURATOR_SERVICE`, empty when Curator is not installed). The script also refuses to run
unless `PROD_ROOT` is the path of the checkout it runs from, and its smoke step reads the
services' env files from `~/vault-suite-data` (set `VAULT_SUITE_DATA` for another data
directory).

`scripts/deploy.sh` runs `npm ci` only when `node_modules` has no record of a completed
install of the current `package-lock.json` under the current Node ABI, so don't run
`npm ci` by hand first: that deletes the record and makes the script install again.
After the restart it waits until Engine and Curator answer on `ENGINE_PORT` and
`CURATOR_PORT` (default `3334` and `3335`, up to `HEALTH_TIMEOUT` seconds each, default
180) and prints a unit's log if one doesn't. With `PLUGIN_DIR` set, it also builds the
Obsidian plugin before the smoke and copies `main.js`, `manifest.json`, and `styles.css`
there once the services answer. If the install, build, or smoke fails after a pull, it
prints the command that puts the checkout back on the commit it started from.

See the [Engine deployment guide](packages/engine/README.md#deployment).

## License

MIT. The Geist and Geist Mono font files under `docs/images/fonts/` are licensed
separately under the SIL Open Font License 1.1; see
[`docs/images/fonts/OFL.txt`](docs/images/fonts/OFL.txt).
