# Contributing to Vault Engine

Vault Engine is a personal, alpha-stage system. It has
real users and production operations and a terminal installer, but it does not yet promise
stable APIs or portable deployment defaults. Keep changes focused and ask before widening
their scope.

## Set up a fresh clone

Use the Node.js version pinned in [`.nvmrc`](.nvmrc) (currently Node 24). From the
repository root:

```bash
npm install
npm run build
npm test
```

The first build is required before the first test run because Engine's MCP-App UI resolves
generated declarations from shared workspace packages. Later focused test runs can use the
owning workspace directly.

## Understand the repository

Start with the root [README](README.md) and [documentation index](docs/README.md). Before
changing files, read the root [AGENTS.md](AGENTS.md) and the nearest package-level
`AGENTS.md` when one exists. Those files are the authoritative concise working rules for
people and coding agents.

The root `CLAUDE.md` is a Claude Code compatibility entry point. A package may also carry
maintainers' working notes in its own `CLAUDE.md`; where one exists, read the relevant
sections when the package `AGENTS.md` directs you there. They are not replacements for
`AGENTS.md`.

The package graph is intentional. Deployable clients communicate with Engine over MCP,
shared libraries remain host-agnostic, Contract/Pricing/Settings Registry remain leaves,
and no production package imports Bench. Run `npm run lint:deps` to check those boundaries.

## Develop and validate

Match the owning package's existing TypeScript, ESM, naming, and test conventions. Add
regression coverage for behavior changes and run the smallest relevant test first.

For a focused package change, run the applicable scripts that workspace defines (not every
workspace exposes all three):

```bash
npm run typecheck --if-present -w <workspace>
npm test --if-present -w <workspace>
npm run build --if-present -w <workspace>
```

For cross-package, shared-contract, dependency, or release-facing changes, finish with:

```bash
npm run build
npm test
```

The Obsidian plugin is intentionally outside the root build order; build it explicitly
when plugin code changes:

```bash
npm run build -w vault-obsidian
```

## Protect data and operations

Never commit secrets, `.env` files, vault content, SQLite databases, generated `dist/`
output, service credentials, or model-provider keys. Preserve safe paths, dry runs, undo,
migrations, rollback behavior, response envelopes, and user data.

Some runbooks and scripts describe the repository owner's deployment and contain personal
hostnames or absolute paths. They are operational records, not generic setup instructions.
Repository work does not authorize model spending, external writes, migrations, service
restarts, or deployment.

## Reviews and integration

Use concise conventional-style commit subjects when practical. Pull-request descriptions
should state the behavioral change, validation commands, and any schema, database,
filesystem-write, model, or MCP-contract impact. Include screenshots for visible client
changes.

Keep implementation, commit, push, pull request, merge, and deployment as separate approval
steps when working with an agent or on behalf of the repository owner.
