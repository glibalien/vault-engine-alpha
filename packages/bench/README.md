# @vault/bench

`@vault/bench` is the standalone model-orchestration benchmark for Vault Engine chat.
It extracts recorded assistant turns from the Engine conversation store, samples them
by interaction shape, and replays the same histories against candidate catalog models
using the production [`@vault/chat-core`](../chat-core/README.md) loop.

Bench is measurement tooling, not a production dependency. No package may import it,
and it communicates with a disposable Engine subprocess only over MCP.

## What it measures

Each recorded assistant turn is classified by its observed tool pattern:

| Class | Recorded shape |
| --- | --- |
| `trivial` | No tool calls |
| `single-read` | One read tool |
| `multi-read` | Two to four read tools |
| `single-write` | One write tool |
| `complex` | At least five calls or a multi-call turn containing a write |

The runner replays the preceding conversation history, model choice, context-chip
state, current-date context, discovered Engine tools, and chat settings. Tool outcomes
are scored with the shared `@vault/contract` verdicts, including weak empty-result
signals and dry-run validity.

This is a comparative regression harness. It does not claim that replayed generations
are bit-for-bit deterministic or that one aggregate score replaces qualitative review.

## Before you run it

You need:

- The Node.js version pinned in the monorepo's `.nvmrc` (currently Node 24) and installed
  monorepo dependencies.
- A built Engine (`packages/engine/dist/index.js`).
- A source vault and Engine SQLite database containing persisted conversations.
- Model entries in that database's `Settings/Models/` catalog.
- The provider key for every candidate model.
- Enough temporary disk for a Markdown copy and SQLite `VACUUM INTO` snapshot.

Build Engine first:

```bash
npm install
npm run build
```

The CLI has no default source: `--vault` and `--db` are required, must be absolute,
and are validated before any database, sandbox, model, or provider-key work begins.

## Inspect a corpus

Corpus inspection is read-only and makes no model calls:

```bash
npm run bench -w @vault/bench -- corpus \
  --db /absolute/path/to/vault/.vault-engine/vault.db
```

It reports total and replayable assistant turns, per-class counts, partial turns, and
turns excluded because they used unknown tools. A turn is replayable only when every
recorded tool part is terminal and every tool is classified by the harness.

## Run a comparison

Pass comma-separated model catalog references. Set the matching provider keys in the
process environment:

```bash
ANTHROPIC_API_KEY=<key> \
OPENAI_COMPAT_API_KEY=<key> \
npm run bench -w @vault/bench -- run \
  --vault /absolute/path/to/vault \
  --db /absolute/path/to/vault/.vault-engine/vault.db \
  --models "[[Claude Sonnet 4.6]],[[Qwen 3.7 Plus]]" \
  --per-class 20 \
  --seed 1 \
  --tag baseline-2026-08-26
```

Provider environment variables are:

| Provider | Variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| Fireworks | `OPENAI_COMPAT_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

The runner resolves every model and checks every required key before the first paid
turn. Candidate models and turns execute strictly sequentially to avoid sandbox
contention and cross-attribution.

### Run options

| Flag | Default | Purpose |
| --- | --- | --- |
| `--models <refs>` | Required | Comma-separated catalog note references or titles |
| `--vault <path>` | Required (absolute) | Source Markdown vault |
| `--db <path>` | Required (absolute) | Source Engine conversation/database snapshot |
| `--per-class <n>` | `40` | Maximum deterministic sample per turn class |
| `--classes <list>` | All classes | Restrict execution while preserving the same seeded sample draw |
| `--seed <number>` | `1` | Deterministic stratified-sampling seed |
| `--tag <name>` | Current timestamp | Output directory and run identity |
| `--keep-sandbox` | Off | Preserve the temporary sandbox for investigation |

Valid `--classes` values are `trivial`, `single-write`, `single-read`, `complex`, and
`multi-read`.

## Safety model

Bench is designed to make replay safe against a real-vault snapshot:

1. The source database is opened read-only.
2. A disposable directory is created under the OS temporary directory.
3. Markdown is copied with timestamps preserved; `.vault-engine`, `Attachments`, and
   `.obsidian` are excluded from the copy.
4. SQLite is copied with `VACUUM INTO`, not a raw file copy of a live WAL database.
5. Attachments and local embedding weights are symlinked for read access.
6. The Engine subprocess receives sandbox-pinned paths and blank paid-provider keys.
7. Reads execute against the sandbox. The first dry-runnable write in a turn is forced
   to `dry_run: true`; a write without a preview path is refused. Calls after that
   first write are suppressed.
8. Containment is checked before execution and again before recursive cleanup.
9. Normal completion and `SIGINT`/`SIGTERM`/`SIGHUP` kill the child before deleting the
   sandbox.

This protects the real vault from mutation, but a benchmark is not side-effect-free:

- Candidate model calls spend money.
- `web-search` and `fetch-url` may perform external reads when `EXA_API_KEY` is set.
- The sandboxed Engine can populate its own extraction cache, normalize its copied
  Markdown, run maintenance, and write temporary backups inside the sandbox.
- `--keep-sandbox` deliberately leaves that temporary data on disk and prints its path.

Review the selected sample size and model list before starting a large run.

## Reports

Each run writes:

```text
packages/bench/.bench/runs/<tag>/report.json
packages/bench/.bench/runs/<tag>/report.md
packages/bench/.bench/history.jsonl
```

Per-run directories are ignored by Git because they are large and reproducible.
`history.jsonl` is intentionally tracked as the small append-only trend ledger tying a
Git SHA, seed, model set, corpus coverage, and aggregate results together.

Reports include run provenance, corpus exclusions, sample shortfalls, per-model and
per-class outcomes, token use, locally estimated cost, latency, and external-tool
coverage. Benchmark spend is calculated locally through
[`@vault/pricing`](../pricing/README.md); it is not recorded in the disposable Engine
ledger.

## Boundaries

- Bench may depend on shared `@vault/*` libraries, but no production package may import
  Bench.
- Engine and Curator remain external services from Bench's perspective; replay talks to a
  disposable Engine only over MCP.
- The source database stays read-only. All executable reads and guarded write previews run
  against the sandbox snapshot.
- Tool classification is explicit and fail-closed. An unknown tool makes a recorded turn
  unreplayable until the harness classifies and tests it.
- Reports contain bounded metadata and aggregates, not provider keys, complete source-vault
  content, or raw conversation/tool payloads.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | `corpus` and `run` commands, validation, lifecycle, and report writes |
| `src/corpus.ts` | Read-only conversation extraction and replayability checks |
| `src/classify.ts` | Turn-class cascade |
| `src/sample.ts` | Deterministic stratified sampling |
| `src/model-refs.ts` | Catalog reference resolution |
| `src/sandbox.ts` | Snapshot creation, environment pinning, containment, and cleanup |
| `src/engine-client.ts` | Sandboxed Engine subprocess and MCP client |
| `src/execute.ts` | Read execution, write interception, dry-run enforcement, and verdict capture |
| `src/runner.ts` | Production-loop replay for one turn/model pair |
| `src/report.ts` | JSON/Markdown reports and history entries |
| `test-e2e/` | Disposable mini-vault pipeline coverage |

## Development

The package has no production build script; it runs from TypeScript through `tsx`.

```bash
npm run typecheck -w @vault/bench
npm test -w @vault/bench
npm run test:e2e -w @vault/bench
```

The end-to-end suite requires a built Engine. When Engine adds or removes MCP tools,
update the read/write classification sets and run the sandbox wiring tests so unknown
tools fail closed rather than silently changing benchmark behavior.

## License

MIT
