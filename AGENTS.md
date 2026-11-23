# Vault Engine Monorepo Guidance

## Scope and instruction hierarchy

This file governs the whole monorepo. Package-level `AGENTS.md` files add more specific
rules for their subtrees:

- `packages/engine/AGENTS.md` — the database-authoritative MCP engine.
- `packages/curator/AGENTS.md` — the autonomous AI curator and its MCP server.
- `packages/obsidian-plugin/AGENTS.md` — the Obsidian desktop client.
- `packages/bench/AGENTS.md` — the standalone model-orchestration benchmark.

Before changing a package, read its local `AGENTS.md` when one exists. Otherwise read the
package README sections covering responsibilities, boundaries, and development; packages
without a local guide inherit this file unchanged. Keep nested guides limited to durable,
package-specific rules rather than repeating repository guidance.

`AGENTS.md` files are the authoritative source for concise cross-agent working rules. The
root `CLAUDE.md` is a compatibility entry point that sends Claude Code to those rules.
A package `CLAUDE.md`, where the checkout has one, holds the maintainers' working notes:
detailed context, dated decisions and measurements. Read it where the nearest package
`AGENTS.md` points to it. Do not remove one during routine cleanup; retire one only through
a deliberate migration of every still-current invariant and reference.

## Scope discipline

Do only the task explicitly requested. Do not broaden scope, strengthen requirements,
refactor adjacent systems, or implement unrelated reviewer suggestions without obtaining
explicit approval first.

## Repository map

Vault Engine is one product with three deployable surfaces and shared libraries:

- `packages/engine` (`vault-engine`) — governed knowledge-graph engine and MCP server.
- `packages/curator` (`vault-curator`) — autonomous wiki/memory/organization service;
  an MCP client of the Engine and an MCP server for external callers.
- `packages/obsidian-plugin` (`vault-obsidian`) — thin Obsidian client over HTTP.
- `packages/contract` (`@vault/contract`) — shared MCP response-envelope wire types;
  it has zero runtime dependencies.
- `packages/query-core`, `packages/viz-ui`, `packages/board-core`,
  `packages/conversation-core`, `packages/chat-core`, `packages/chat-ui`,
  `packages/settings-registry`, and `packages/pricing` — internal `@vault/*` libraries
  composed by the surfaces.
- `packages/llm` (`@vault/llm`) — the shared model-provider clients for Engine and
  Curator: one lazily built SDK client per catalog provider, token-usage normalization,
  and a provider-neutral single-turn `complete()` call. The provider table it reads
  (`PROVIDERS`: wire API, base URL, key variable) lives in `@vault/settings-registry` so
  chat, the plugin and the installer can read it too.
- `packages/bench` (`@vault/bench`) — standalone, sandboxed model-orchestration benchmark.
  No production package imports it, and it communicates with Engine only over MCP.
- `packages/installer` (`vault-installer`) — terminal installer for Engine and Curator. It
  imports only the shared contract packages and reaches Engine and Curator through their
  CLIs, MCP, env files, and service units. No package imports it.

Keep deployable-surface policy in its owning package and reusable behavior in an existing
shared library when it is genuinely shared. Do not introduce a new package for one caller.

## Hard architecture boundaries

- Deployable clients communicate with Engine over MCP and may import only their allowed
  shared libraries. `packages/engine` must never import from `packages/curator`; shared
  libraries remain host-agnostic according to `.dependency-cruiser.cjs`;
  `packages/contract` depends on no workspace package; and no package imports Bench.
  `npm run lint:deps` enforces the repository graph.
- The Engine is the deterministic system of record. Open-ended narrative/wiki synthesis
  belongs in Curator. The Engine may perform bounded structured classification or
  extraction where its package guidance explicitly permits it.
- Curator and other clients mutate vault state only through Engine MCP tools, never by
  editing vault Markdown or the Engine SQLite database directly.
- Preserve public MCP contracts across Engine, Contract, Curator, Obsidian, and shared UI.
  When changing a wire type or tool envelope, trace and test every consumer.
- Do not use the deprecated standalone `<owner-home>/projects/vault-curator` or
  `<owner-home>/projects/vault-engine-old` checkouts for writes. They are read-only historical
  references only where package guidance explicitly allows reading them.

## Common commands

Run commands from the repository root unless package guidance says otherwise.

- `npm install` — install all workspaces using the single root lockfile.
- `npm run build` — ordered build of shared libraries, Engine, Curator, and the installer.
  It does not build the Obsidian plugin.
- `npm run typecheck` — run every workspace typecheck script that exists.
- `npm test` — build the Engine MCP-App UI, validate the lockfile and dependency graph,
  then run all workspace tests. It does not replace `npm run build` as the TypeScript emit
  gate.
- `npm run lint:deps` — validate package dependency direction.
- `npm run build -w vault-obsidian` — build the Obsidian plugin explicitly.
- `npm test -w <workspace>` / `npm run build -w <workspace>` — targeted validation.

For a focused change, run the smallest relevant test first, then the owning package's
build/typecheck and tests. Run root `npm test` and `npm run build` for cross-package,
dependency, shared-contract, or release-facing changes.

## Development conventions

- The Node.js version pinned in `.nvmrc` (currently Node 24) and TypeScript ESM are the
  baseline. Match each package's existing import, filename, formatting, and export
  conventions.
- Add regression coverage for behavior changes. Do not treat Vitest transpilation as a
  substitute for TypeScript validation.
- Preserve user data and reversibility. Never bypass safe-path, mutation, dry-run, undo,
  migration, or response-envelope seams to make a change easier.
- Never commit secrets, vault contents, local SQLite databases, `.env` files, generated
  `dist/` output, or service credentials. Document new environment variables in the
  relevant README and `.env.example`.
- Keep generated workspace lock data consistent. Add dependencies through npm from the
  repository root; do not hand-edit `package-lock.json`.
- Ask before expanding a task into an unrelated package or subsystem. If a necessary
  contract change widens scope, explain the affected consumers first.

## Real vault content stays out of the repository and GitHub

Nothing from a real vault goes into a tracked file or onto GitHub: company, client and
deal names, people's names, real note, project and wiki titles, and quoted notes, memories
or tasks.

- The rule covers tests, fixtures, eval cases, code comments and docs, and equally issue
  text, PR descriptions, review comments and commit messages. A squash merge copies the PR
  description into the commit on `main`.
- A test or write-up built from a real incident uses fictional names of the same shape
  (Acme, Northwind, Project Alpha, "a colleague"). Describe what happened and give counts;
  leave out who and which account.
- Facts about a real vault go in the package `CLAUDE.md` working notes or a dated record
  under `docs/superpowers/`: how much it holds, how fast it grows, what its notes and
  memories are about, and who is in them. READMEs, `AGENTS.md` files, code comments and
  tests describe what the product does. A timing, a failure count or what a model did may
  be given there, without those facts.
- `npm run lint:repo-safety` checks tracked files for real names only where private terms
  are set up (`docs/repository-safety.md`). It then reports a real note title, a trimmed
  copy of one, or a real surname or company name as `private-term`, with the words that
  matched. Change those words; only the repository owner edits the list of allowed matches.
  It knows nothing of a name that is in no note title, and it never reads GitHub text, so
  still read what you are about to commit or post.
- GitHub keeps edit history, so a later edit does not remove a name. If one has gone out,
  tell the repository owner; do not quietly edit it.

`docs/repository-safety.md` holds the full policy.

## Shared model and structured-output rules

On the Fireworks path, `generateObject` JSON schemas are prompt-advisory rather than
decode-time enforcement. Keep schemas compact and discriminators obvious, validate and
normalize in each configuration's `sanitize`, and live-test material schema changes against
the real model before release. `packages/chat-core/src/board-plan-interpret.ts` is the
reference pattern.

## Commits and reviews

Use concise conventional-style subjects when practical (`type(scope): summary`). A review
or PR description should state the behavioral change, validation commands run, and any
schema, database, filesystem-write, model, or MCP-contract impact. Include screenshots for
user-visible client changes.

## Change finalization and deployment

Treat every implementation request as authorization to make and validate a local change
only. This includes requests that use terms such as "ship", "release", or "live",
or that express urgency. Such wording never authorizes a commit, push, PR, merge, external
write, service restart, migration, or deployment.

- Work in an isolated branch or worktree by default, unless the user explicitly selects a
  different local working context.
- After implementation and standard review/validation, stop and present the completed work,
  relevant diff, and validation results along with the usual explicit next-step options (for
  example: leave local, commit, push a branch, open a PR, merge to `main`, or deploy to a
  named environment).
- Each option is a separate user approval. Wait for a fresh, explicit user choice before
  carrying it out; do not infer authorization from any earlier request or from the apparent
  desirability of the outcome.
- Production deployment requires an explicit post-review instruction identifying the exact
  change and production target. Never deploy, restart a production service, or otherwise
  activate a production change automatically.
