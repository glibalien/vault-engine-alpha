# Vault Engine Package Guidance

## Scope and authoritative context

This file extends the root `AGENTS.md` for `packages/engine/**`. Vault Engine is the
database-authoritative knowledge-graph engine and primary MCP tool surface.

Before implementation work, read the relevant sections of `CLAUDE.md` in this directory
where the checkout has it. That file holds the maintainers' working notes (detailed, evolving
invariants and design history); this file holds the critical rules that must always be in
context. For changes to architecture or the mutation
model, also consult the Vault note `<vault-root>/Notes/Vault Engine - Charter.md`
when it is available. The charter wins over lower-level design notes.

## Architecture invariants

- SQLite is the source of truth. Markdown files are a rendered projection of database
  state, not a competing authority.
- Every write flows through the single parse -> validate -> coerce -> reconcile -> apply ->
  render mutation pipeline. Do not create parallel MCP, watcher, maintenance, or filesystem
  write paths.
- The watcher updates database state only and never writes files. Preserve its debounce,
  retry, exclusion, and concurrent-edit protections.
- Data is never silently deleted. Preserve orphan fields and removed-type data unless an
  explicit, confirmed, reversible operation owns the deletion.
- Route every vault filesystem entry point through the existing safe-path utilities. Never
  accept unresolved paths, filenames, or references as direct filesystem targets.
- The Engine must never import from Curator. Open-ended narrative/wiki synthesis belongs in
  Curator; bounded structured classification and extraction are allowed only through the
  existing Engine seams. Do not add a new open-ended text-generation path.
- Use the `yaml` package directly; never add `gray-matter`. Do not copy from or modify
  `<owner-home>/projects/vault-engine-old` except for reading the already-designated auth/transport
  history when explicitly relevant.
- Ask before widening work into a module or package outside the requested feature.

## Tool, schema, and storage safety

- MCP tools return the shared envelope `{ ok: true, data, warnings }` or
  `{ ok: false, error, warnings }` through the helpers in `src/mcp/tools/errors.ts`.
  Warnings remain warnings; do not turn soft signals into transport errors.
- Preserve dry-run and undo behavior for mutations. Multi-step filesystem operations must
  register rollback callbacks and avoid clobbering concurrent edits.
- Schema changes use the existing schema/pipeline operations. Database changes use ordered,
  idempotent migrations; never rely on ad hoc create-if-missing DDL for an evolution.
- Settings behavior belongs in `@vault/settings-registry` descriptors and the settings
  service. Environment variables are bootstrap/seeding/secrets only where documented.
- Paid or model-backed work must use the existing provider seams and usage recorder.
  Observability is best-effort and must not make the primary operation fail.
- A tool that only the suite's own services call from code belongs in
  `SERVICE_ONLY_TOOL_NAMES` (`src/mcp/tool-surface.ts`), which hides it from OAuth-flow
  clients. Keep advertised input schemas compact: factor repeated subschemas with
  `reused: 'ref'` rather than inlining them.
- `wiki-write` owns content inside `<!-- ve:live:* -->` regions. Human content belongs
  outside those markers or in explicitly supplied managed sections.

## Project structure

Production code lives in `src/`, grouped by domain: `mcp/`, `pipeline/`, `db/`, `parser/`,
`renderer/`, `sync/`, `search/`, `extraction/`, `settings/`, `usage/`, and `undo/`. Tests live
under `tests/` in matching domain folders; fixtures are in `tests/fixtures/`. Current design
specs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

Keep MCP tool handlers in `src/mcp/tools/`. Prefer extending an existing domain seam over
adding orchestration to `src/index.ts`.

## Commands and validation

Run from `packages/engine` or use the equivalent `-w vault-engine` command at the root.

- `npm run dev` — run `src/index.ts` with `tsx watch`.
- `npm run build` — compile production TypeScript, verify embedder provenance, typecheck
  tests, and build the MCP-App UI.
- `npm run typecheck` — typecheck the test project.
- `npm run build:ui` — typecheck and build the query-nodes MCP-App bundle.
- `npm test` — run Vitest, excluding performance and model suites.
- `npm run test:model` — run live/model-specific tests; use only when the change requires
  configured external models.
- `npm run test:perf` — run performance tests when search/indexing behavior is relevant.
- `npm run eval:consolidation [-- --model "<Settings/Models title>"]` — live memory-merge eval; run
  on the production model after changing the consolidation prompt. Needs the provider's key and,
  for `--model` and the configured model, the Engine database (`--db`, `DB_PATH` or `VAULT_PATH`,
  opened read-only). `--provider <p> --model <id>` runs a raw id without it. The root
  `npm run eval:models` compares models across this and the Curator's evals.
- `npm run start:http` — run the built HTTP transport.

Add regression tests for pipeline, schema, MCP response, sync, search storage, settings,
filesystem, and undo changes because these paths share stateful behavior. Run a focused test
first, then `npm run build` and `npm test`. For cross-package changes, also run the root
validation required by the root `AGENTS.md`.

## TypeScript and naming

Use strict TypeScript ESM. Source filenames are lowercase and hyphenated. Prefer named
exports, two-space indentation, semicolons, single-quoted strings/imports, and explicit
`.js` extensions for relative imports where the surrounding NodeNext code uses them. Match
nearby code rather than applying repository-wide formatting.

Name tests `*.test.ts` and place them in the matching domain. Use helpers from
`tests/helpers/` and fixtures from `tests/fixtures/`.

## Commits and review

Use a concise conventional-style subject when practical. Reviews must call out schema,
database, filesystem-write, MCP-contract, model-provider, and migration impacts. Include
screenshots for user-visible HTTP/MCP-App changes.
