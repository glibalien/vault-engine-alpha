# Vault Bench Package Guidance

## Scope and role

This file extends the root `AGENTS.md` for `packages/bench/**`. `@vault/bench` is a
standalone comparative model-orchestration benchmark, not a production dependency.

Read `README.md` before changing corpus selection, replay semantics, sandbox lifecycle,
tool classification, scoring, or reports. The README documents the CLI and full safety
model; this file keeps the non-negotiable boundaries in context.

## Isolation and dependency boundaries

- No production package imports Bench, and Bench never imports Engine, Curator, or the
  Obsidian plugin. It communicates with a disposable Engine subprocess only over MCP.
- Reuse shared production behavior through the allowed `@vault/*` libraries rather than
  copying the chat loop, response envelope, settings, or pricing logic.
- Treat benchmark compatibility as external-client compatibility. Engine tool changes
  must update the explicit read/write classification and fail-closed coverage.

## Sandbox and source-data safety

- Open the source Engine database read-only. Snapshot live SQLite with `VACUUM INTO`; do
  not raw-copy a database that may have WAL state.
- Run replays only in an OS-temporary disposable vault and database. Pin every Engine
  subprocess path to the sandbox and blank paid-provider keys in the child environment.
- Preserve copy exclusions for `.vault-engine`, `Attachments`, and `.obsidian`; attachments
  and embedding weights may be linked only through the established read-only seams.
- Enforce containment before execution and again before cleanup. Kill the Engine child
  before deleting its sandbox on normal exit and `SIGINT`/`SIGTERM`/`SIGHUP`.
- Reads may execute in the sandbox. Force the first dry-runnable write to `dry_run: true`,
  refuse writes without a preview path, and suppress later calls after the first write.
  Unknown tools fail closed rather than being guessed read-only.
- Preserve sequential candidate/turn execution so model spend, subprocess state, and
  scoring remain attributable.

## Paid and external operations

`corpus` inspection is read-only and makes no model calls. A benchmark `run` spends money
and may perform external reads when an external-search key is present. Do not launch a
live run unless the user explicitly authorizes the source database/vault, candidate
models, classes or sample size, and expected external access. Always pass explicit
`--vault` and `--db` paths for reviewable runs rather than relying on developer-local
defaults.

Never print provider keys, source-vault content, full message bodies, or tool payloads in
reports or logs unless an established redacted field explicitly owns that output.

## Reports and repository state

- Per-run `.bench/runs/<tag>/` artifacts are large, reproducible, and ignored by Git.
- `.bench/history.jsonl` is the intentionally tracked append-only trend ledger. Do not
  rewrite prior entries or mix an unrelated live result into a code-only change.
- `--keep-sandbox` deliberately preserves temporary data. Surface its exact path and do
  not clean it up implicitly after the user chose to retain it.

## Commands and validation

Run from the repository root.

- `npm run typecheck -w @vault/bench` — typecheck the package.
- `npm test -w @vault/bench` — run the unit suite.
- `npm run test:e2e -w @vault/bench` — run disposable Engine/MCP integration coverage;
  this requires a built Engine.
- `npm run bench -w @vault/bench -- corpus --db <absolute-path>` — inspect replayability
  without model calls.

Run focused tests first, then typecheck and the full unit suite. Run E2E tests for sandbox,
Engine-client, tool-classification, execution, or lifecycle changes after building Engine.
Reviews must call out source-data access, containment/cleanup, paid calls, external reads,
tool-classification changes, report-schema effects, and tracked history changes.
