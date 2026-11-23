// Per-model x per-class report aggregation + rendering, plus the append-only
// history ledger entry shape. Pure data in, data/markdown out — no fs, no
// engine, no network. That split is deliberate (ambiguity ruling #1 in the
// task brief): report.ts is unit-testable against hand-built TurnResult[]
// fixtures alone, while packages/bench/src/cli.ts owns every I/O concern
// (git SHA, engine dist mtime, corpus DB reads, writing the files below).

import { ALL_TURN_CLASSES } from './sample.js';
import type { TurnClass } from './classify.js';
import type { TurnResult } from './runner.js';

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * Aggregate over one (model, class) bucket of TurnResult. Field set and
 * order are verbatim from the task brief's "report.json cells" line.
 */
export interface ReportCell {
  pass: number;
  weak: number;
  fail: number;
  error: number;
  /** Count of turns whose first write truncated the rest of the turn — a
   *  coverage signal, not a score input (Task 8's own framing). */
  truncatedAtWrite: number;
  /** Sum, across this cell's turns, of write calls that had no dry-run path
   *  (TurnResult.unvalidatable is itself a per-turn count). */
  unvalidatable: number;
  /** Sum, across this cell's turns, of calls suppressed after the
   *  truncation latch (CallOutcome.kind === 'suppressed'). */
  suppressed: number;
  /** Count of turns whose usage was null — "not measured", never folded
   *  into totalCostUsd as a hidden zero (ambiguity ruling #3). */
  usageUnreported: number;
  meanLatencyMs: number;
  /** Sum of non-null costUsd across the cell. null when EVERY turn in the
   *  cell had a null cost (unpriced model or unmeasured usage) — never a
   *  fabricated $0.00 (ambiguity ruling #3 / real-data note re: 3 of 9
   *  catalog models having no pricing entry). */
  totalCostUsd: number | null;
  turns: number;
}

function emptyCell(): ReportCell {
  return {
    pass: 0,
    weak: 0,
    fail: 0,
    error: 0,
    truncatedAtWrite: 0,
    unvalidatable: 0,
    suppressed: 0,
    usageUnreported: 0,
    meanLatencyMs: 0,
    totalCostUsd: null,
    turns: 0,
  };
}

/**
 * Aggregate one (model, class) bucket's turns into a ReportCell. Every rule
 * quantifies over the whole array — never `results[0]`, per carried-forward
 * requirement #2 (Task 7/8's outcomes() ordering caveat applies transitively:
 * a TurnResult's own `calls` must never be read positionally either, and the
 * `suppressed` sum below reads it only as a predicate/count).
 */
export function aggregateCell(results: readonly TurnResult[]): ReportCell {
  const cell = emptyCell();
  let latencySum = 0;
  let costSum = 0;
  let costCount = 0;

  for (const r of results) {
    cell.turns += 1;
    if (r.outcome === 'PASS') cell.pass += 1;
    else if (r.outcome === 'WEAK') cell.weak += 1;
    else if (r.outcome === 'FAIL') cell.fail += 1;
    else cell.error += 1;

    if (r.truncatedAtWrite) cell.truncatedAtWrite += 1;
    cell.unvalidatable += r.unvalidatable;
    cell.suppressed += r.calls.filter((c) => c.kind === 'suppressed').length;
    if (r.usage === null) cell.usageUnreported += 1;

    latencySum += r.latencyMs;
    if (r.costUsd !== null) {
      costSum += r.costUsd;
      costCount += 1;
    }
  }

  cell.meanLatencyMs = cell.turns > 0 ? latencySum / cell.turns : 0;
  cell.totalCostUsd = costCount > 0 ? costSum : null;
  return cell;
}

/** One ReportCell per TurnClass, keyed off ALL_TURN_CLASSES (sample.js) so a
 *  future 6th class can't silently vanish from a report — carried-forward
 *  requirement #1. */
export function aggregateByClass(results: readonly TurnResult[]): Record<TurnClass, ReportCell> {
  const cells = {} as Record<TurnClass, ReportCell>;
  for (const turnClass of ALL_TURN_CLASSES) {
    cells[turnClass] = aggregateCell(results.filter((r) => r.turnClass === turnClass));
  }
  return cells;
}

/**
 * PASS rate for one cell, excluding ERROR turns from the denominator
 * (ambiguity ruling #4 — an ERROR is a harness failure, not a model-quality
 * signal). null when there is nothing to rate (every turn in the cell
 * errored, or the cell is empty) — never a fabricated 0/0 = 0%.
 */
export function passRate(cell: ReportCell): number | null {
  const denominator = cell.turns - cell.error;
  if (denominator <= 0) return null;
  return cell.pass / denominator;
}

// ---------------------------------------------------------------------------
// Manifest / coverage / models
// ---------------------------------------------------------------------------

export interface ReportManifest {
  tag: string;
  gitSha: string;
  seed: number;
  perClass: number;
  /** Resolved provider model ids (not the operator-typed refs). */
  models: string[];
  tz: string;
  dbPath: string;
  /** Total turns extractTurns() found in the corpus DB (replayable + excluded). */
  corpusTurnCount: number;
  /** mtime of packages/engine/dist/index.js, ISO — which engine build produced this run. */
  engineDistMtime: string;
  startedAt: string;
  endedAt: string;
}

/** Standing caveats every report must carry, regardless of run shape — see
 *  the task brief's Design section (single-run deltas, phase-1 usage_events
 *  scope). Fixed here, not passed by the caller, so they can't drift or be
 *  forgotten by a future call site. */
const MANIFEST_NOTES: readonly string[] = [
  'Single-run per-class deltas under ~5 points are not meaningful — sample sizes this small have wide variance; look for trends across multiple history.jsonl entries, not one run.',
  'Phase 1 does not record usage_events for bench spend: the sandbox DB (and its ledger) is disposable and bench never writes to the live engine, so this cost is invisible to usage-report. Cost figures below are computed locally from @vault/pricing only.',
  // Fidelity limit (task brief carry-forward #4): the corpus DB never
  // persisted which note/doc was open when a turn was recorded (docPath),
  // so runner.ts's docRefProvider has nothing to fire on and is silent for
  // EVERY model during replay — a turn that said "this note"/"this doc" is
  // equally unanswerable no matter which model is being scored, so it does
  // not bias the comparison, but it does mean those turns' scores can't
  // speak to doc-context quality at all. The count is corpus-specific
  // (phrased so it stays true as a snapshot, not a live-recomputed claim):
  // in the 2026-08-01 corpus this was roughly 13 of 722 user turns (~2%).
  'Fidelity limit: the open-note identity (docPath) was never persisted anywhere in the corpus DB, so the doc-context provider is silent for every model during replay — a turn that referenced "this note"/"this doc" is equally unanswerable regardless of which model is being scored. In the 2026-08-01 corpus this affected roughly 13 of 722 user turns (~2%).',
];

export interface CoverageInput {
  totalTurns: number;
  replayableTurns: number;
  /** Turns excluded because they contained a non-terminal tool part. */
  partialExcluded: number;
  /** Turns excluded because they named a tool this bench can't classify (e.g. a curator-only tool). */
  unknownToolExcluded: number;
  /** Classes actually executed this session (a `--classes` filter narrows this; sampling itself always covers all classes so the seed stays comparable across runs with different filters). */
  requestedClasses: TurnClass[];
  /** Counts from the full stratified sample, ALL classes — independent of `requestedClasses`. */
  sampledPerClass: Record<TurnClass, number>;
  shortfalls: { turnClass: TurnClass; requested: number; available: number }[];
  /** Among executed turns: how many recorded a web-search or fetch-url call. */
  externalToolTurns: number;
}

export interface ModelResultsInput {
  /** The ref as typed on the CLI (report readability: what the operator asked for). */
  ref: string;
  /** Resolved provider model id. */
  model: string;
  /** Catalog title (or the pass-through label for an unresolved ref). */
  label: string;
  results: TurnResult[];
}

export interface ReportModelEntry {
  ref: string;
  model: string;
  label: string;
  cells: Record<TurnClass, ReportCell>;
}

export interface ReportJson {
  manifest: ReportManifest & { notes: readonly string[] };
  coverage: CoverageInput;
  models: ReportModelEntry[];
}

export interface ReportInput {
  models: ModelResultsInput[];
  manifest: ReportManifest;
  coverage: CoverageInput;
}

export interface BuiltReport {
  json: ReportJson;
  markdown: string;
}

// ---------------------------------------------------------------------------
// History ledger
// ---------------------------------------------------------------------------

/** One append-only packages/bench/.bench/history.jsonl line. Field set is
 *  verbatim from the task brief. `mode` exists so a future full-sweep runner
 *  (out of scope here) can share the ledger without ever being averaged
 *  against sampled runs — this CLI only ever produces sampled runs, so
 *  `mode` defaults to 'sampled' and nothing in this phase sets 'full'. */
export interface HistoryEntry {
  tag: string;
  at: string;
  gitSha: string;
  seed: number;
  perClass: number;
  mode: 'sampled' | 'full';
  models: { ref: string; model: string; cells: Record<TurnClass, ReportCell> }[];
  coverage: CoverageInput;
}

export function buildHistoryEntry(report: ReportJson, opts: { mode?: 'sampled' | 'full' } = {}): HistoryEntry {
  return {
    tag: report.manifest.tag,
    at: report.manifest.endedAt,
    gitSha: report.manifest.gitSha,
    seed: report.manifest.seed,
    perClass: report.manifest.perClass,
    mode: opts.mode ?? 'sampled',
    models: report.models.map((m) => ({ ref: m.ref, model: m.model, cells: m.cells })),
    coverage: report.coverage,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function fmtCost(v: number | null): string {
  return v === null ? 'n/a' : `$${v.toFixed(4)}`;
}

function fmtRate(cell: ReportCell): string {
  const rate = passRate(cell);
  const denominator = cell.turns - cell.error;
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}% (${cell.pass}/${denominator})`;
}

function renderManifest(manifest: ReportManifest & { notes: readonly string[] }): string {
  const lines = [
    '## Manifest',
    '',
    `- Tag: \`${manifest.tag}\``,
    `- Git SHA: \`${manifest.gitSha}\``,
    `- Seed: \`${manifest.seed}\``,
    `- Per-class sample size: \`${manifest.perClass}\``,
    `- Models: ${manifest.models.map((m) => `\`${m}\``).join(', ')}`,
    `- Timezone: \`${manifest.tz}\``,
    `- Corpus DB: \`${manifest.dbPath}\` (${manifest.corpusTurnCount} turns extracted)`,
    `- Engine dist mtime: \`${manifest.engineDistMtime}\``,
    `- Run window: \`${manifest.startedAt}\` → \`${manifest.endedAt}\``,
    '',
    ...manifest.notes.map((n) => `> ${n}`),
  ];
  return lines.join('\n');
}

function renderCoverage(coverage: CoverageInput): string {
  const excluded = coverage.totalTurns - coverage.replayableTurns;
  const rows = ALL_TURN_CLASSES.map((c) => {
    const shortfall = coverage.shortfalls.find((s) => s.turnClass === c);
    const shortfallText = shortfall ? `${shortfall.available}/${shortfall.requested}` : '—';
    const ran = coverage.requestedClasses.includes(c) ? 'yes' : 'skipped';
    return `| ${c} | ${coverage.sampledPerClass[c]} | ${shortfallText} | ${ran} |`;
  });

  return [
    '## Coverage',
    '',
    `- Corpus: ${coverage.totalTurns} turns extracted, ${coverage.replayableTurns} replayable ` +
      `(${excluded} excluded: ${coverage.partialExcluded} partial-turn, ${coverage.unknownToolExcluded} ` +
      `unknown-tool — a turn may hit both, so these need not sum to ${excluded}).`,
    `- Classes run this session: ${coverage.requestedClasses.length > 0 ? coverage.requestedClasses.join(', ') : '(none)'}`,
    '',
    '| Class | Sampled | Shortfall (available/requested) | Run this session |',
    '|---|---|---|---|',
    ...rows,
    '',
    `- External-tool-dependent turns this session: ${coverage.externalToolTurns} (web-search / fetch-url — ` +
      'requires EXA_API_KEY on the sandboxed engine; results depend on live external state and are not ' +
      'guaranteed reproducible run-to-run).',
  ].join('\n');
}

function renderModelTable(entry: ReportModelEntry): string {
  const rows = ALL_TURN_CLASSES.map((c) => {
    const cell = entry.cells[c];
    return (
      `| ${c} | ${cell.turns} | ${cell.pass} | ${cell.weak} | ${cell.fail} | ${cell.error} | ${fmtRate(cell)} | ` +
      `${cell.truncatedAtWrite} | ${cell.unvalidatable} | ${cell.suppressed} | ${cell.usageUnreported} | ` +
      `${Math.round(cell.meanLatencyMs)} | ${fmtCost(cell.totalCostUsd)} |`
    );
  });

  return [
    `### ${entry.label} (\`${entry.model}\`, ref \`${entry.ref}\`)`,
    '',
    '| Class | Turns | Pass | Weak | Fail | Error | Pass rate | Truncated@Write | Unvalidatable | Suppressed | Usage n/a | Mean latency (ms) | Total cost |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function renderResults(models: ReportModelEntry[]): string {
  // Joined with '\n\n' (not folded into the outer '\n'-joined array like
  // every other section) so consecutive model tables get a blank line
  // between them — multi-model is the common case for this tool, and
  // without this model N's last table row abuts model N+1's '### ' heading
  // directly.
  const tables = models.map(renderModelTable).join('\n\n');

  return [
    '## Results',
    '',
    '> Usage/cost figures cover the FINAL attempt only (ambiguity ruling #3). A turn that errored after ' +
      'burning retries reports `usage: null` / cost `n/a` despite having spent tokens on earlier attempts; ' +
      'a turn that succeeded on retry reports only the successful attempt\'s spend. Treat `Total cost` as a ' +
      'floor, not a complete accounting. "n/a" cost never means $0 — it means unknown pricing or unmeasured usage.',
    '',
    tables,
  ].join('\n');
}

export function buildReport(input: ReportInput): BuiltReport {
  const manifest = { ...input.manifest, notes: MANIFEST_NOTES };
  const models: ReportModelEntry[] = input.models.map((m) => ({
    ref: m.ref,
    model: m.model,
    label: m.label,
    cells: aggregateByClass(m.results),
  }));

  const json: ReportJson = { manifest, coverage: input.coverage, models };

  const markdown = [
    `# Vault Bench Report — ${manifest.tag}`,
    '',
    renderManifest(manifest),
    '',
    renderCoverage(input.coverage),
    '',
    renderResults(models),
    '',
  ].join('\n');

  return { json, markdown };
}
