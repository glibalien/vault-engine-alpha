# Vault Curator Package Guidance

## Scope and role

This file extends the root `AGENTS.md` for `packages/curator/**`. Vault Curator is a major
service in the monorepo: an autonomous AI application that maintains project wikis,
memories, and organization through Vault Engine. It is both an MCP client of the Engine and
an OAuth-protected MCP server for external callers.

Read `README.md` for the product narrative and `DEPLOY.md` for production setup. Before
changing pipeline shape, the page model, reconciliation, or the spine, read the relevant
sections of `CLAUDE.md` (the maintainers' working notes, where the checkout has them) plus
the latest applicable specs/plans in this package's `docs/superpowers/` directories. The vault note "Vault Curator — Master Design" is the
cross-repository design of record when available.

The standalone `<owner-home>/projects/vault-curator` checkout is deprecated. Do not modify, import
from, deploy from, or run it; all current Curator work lives here.

## Hard architecture boundaries

- Open-ended synthesis and curator policy live in Curator, never in Engine. Engine may own
  bounded structured classification/extraction, but Curator must not push narrative or wiki
  composition into it.
- Mutate vault state only through typed Engine MCP methods in `src/engine.ts`, normally
  `wiki-write`, `update-node`, or other governed tools. Never write vault Markdown or the
  Engine SQLite database directly. Read-only evidence gathering may use explicitly designed
  read paths; writes always go through the Engine mutation pipeline.
- Provider SDK imports belong only in `src/llm/`. All synthesis uses the `LlmClient` seam;
  there is no silent provider fallback.
- Keep the pure curation result separate from orchestration and observability. Per-project
  synthesis belongs in `curate.ts`; sweep policy, scheduling, recording, and cross-project
  phases belong in `core.ts` or their dedicated modules.
- `CurationQueue` is the single serialization point. Do not introduce an execution path
  that allows overlapping curations.
- Best-effort observability may warn but must not fail curation. Business writes and state
  stamps retain their existing all-required-success semantics.

## Core flow and ownership

- `src/run.ts` — one-off/dev CLI entrypoint.
- `src/server.ts` and `src/server-bootstrap.ts` — long-lived production MCP service.
- `src/core.ts` — `curateOne`, serialized sweeps, timing, run records, and scheduled phases.
- `src/curate.ts` — project curation: gather typed evidence, gate on the Engine-owned
  `evidence_hash`, synthesize, write, and stamp only after every required write succeeds.
- `src/engine.ts` — typed Engine MCP client. It may reconnect once on transport failure but
  must not retry tool-level `{ ok: false }` results or request timeouts (the Engine may still
  finish a timed-out call, so resending it can apply a write twice).
- `src/synthesize.ts`, `src/page-synthesis.ts`, and `src/llm/` — prompt and model work.
- `src/reconciliation-*`, `src/reconcile*`, and `src/topology*` — wiki identity/topology
  planning, validation, and governed repair.
- `src/scheduler.ts` — timezone- and DST-correct scheduling; never replace wall-clock
  recomputation with `+24h` arithmetic.
- `src/db/` — Curator-owned `.state/curator.db`. Evolve non-OAuth tables only through
  versioned, transactional migrations in `src/db/migrate.ts` that advance `user_version`.
  OAuth schema remains owned by the established idempotent bootstrap seam in
  `src/auth/schema.ts`.
- `src/tools/` — OAuth-scoped MCP tools. Preserve the create/update distinction and the
  `<topic> Wiki` collision guards; a wiki page title is not a valid new topic identity.
- `src/journal/` — best-effort action/run journal. Journal writes run suspended and never
  record themselves.

Project wikis are built from note evidence. A per-note fact layer (node facts, #378) was tried and retired on 2026-11-09 (#352); don't reintroduce it without the owner. `CLAUDE.md` says why. An existing sub-page whose notes changed since its last build is rewritten from its current text plus only those notes (the bounded rewrite, `rewritePlan` in `src/page-synthesis.ts`); run the golden case `rewrite-updates-and-keeps` before changing its prompt or rules.

`curateProject` returns a `CurateResult` for every outcome rather than throwing. Preserve
the evidence-hash idempotency gate, retryability after partial writes, and accurate
`created`/updated reporting when modifying the pipeline.

## Settings and providers

- Environment variables are for bootstrap, connectivity, database paths, OAuth, and
  secrets. Behavioral settings live in the notes of `Settings/Curator/` via descriptors in
  `@vault/settings-registry`; do not add a behavioral `process.env` shortcut.
- Model settings are `model-ref` values resolved through the Engine model catalog. Provider
  selection is per model, not a process-wide Curator provider flag.
- A missing provider key must fail loudly for that call without silently switching models
  or providers. Keep API keys optional at boot because a run only needs keys for models it
  actually invokes.
- Record paid calls through the existing usage reporting seam. Usage reporting remains
  observer-only and cannot block the primary call.

## Commands and validation

Run from `packages/curator` or use the equivalent `-w vault-curator` command at the root.

- `npm run build` — compile production sources to `dist/`.
- `npm run typecheck` — typecheck source and tests without emitting.
- `npm test` — run the Vitest suite.
- `npm run curate -- --dry-run [--project "Title"]` — inspect a development curation with
  no writes.
- `npm run start:server` — run the built long-lived MCP server.
- `npm run eval`, `npm run eval:extraction`, `npm run eval:typing`, `npm run eval:conversation`,
  `npm run eval:reconcile` — targeted evaluation commands; use only when the relevant behavior
  changes. Each prompt's eval is listed in `docs/model-prompts.md`. To compare models across
  them, use the root `npm run eval:models` (`docs/model-prompts.md`).
- `npm run eval:wiki` — paid golden wiki cases (one call each, plus a judge call for each answer
  a "must not say" pattern flags); run before changing page/home prompts or wiki models.
  `--dry-run` lists cases without calls; `--check-judge` checks the judge against its labelled
  answers, and is the step to run after changing the judge, its model, or a case's rule.

Run one test with `npx vitest run test/<name>.test.ts` or a name filter with
`npx vitest run -t "substring"`. For code changes, run the focused tests, `npm run
typecheck`, `npm run build`, and `npm test`. For shared contracts or Engine interactions,
also run affected consumer tests and root dependency validation.

## TypeScript and testing conventions

- Use strict TypeScript, ESM, and NodeNext conventions. Relative source imports include
  explicit `.js` extensions even though their files are `.ts`.
- Respect `noUncheckedIndexedAccess` and `noImplicitOverride`; do not assert away missing
  values that require handling.
- Keep effects at the edges and inject seams for Engine, model, clock, queue, and storage
  behavior. Prefer deterministic unit coverage over live network tests.
- Add regressions for idempotency gates, partial failure/retry, topic identity, topology,
  scopes, migrations, scheduling/DST, queue serialization, and provider dispatch whenever
  those paths change.
- Match nearby two-space formatting and naming. Tests live in `test/` and use
  `*.test.ts`.

## Operational safety and review

Do not commit `.env`, `.state/`, OAuth tokens, provider keys, generated `dist/`, or vault
content. Update `.env.example`, README, and deployment examples when bootstrap or secret
requirements change.

Reviews must state effects on Engine tool calls, wiki identity/idempotency, scheduled versus
on-demand execution, Curator DB migrations, settings/model routing, scopes, and paid model
usage. Use concise conventional-style commit subjects when practical.
