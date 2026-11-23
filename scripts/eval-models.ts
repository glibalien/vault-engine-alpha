/**
 * Compare models per job in one table (#570). Runs the chosen evals once per model (and per
 * repeat), reads each eval's `--json` result line, prints job × model → score, failures, tokens,
 * latency and estimated cost, with the cost per provider below, and appends one line to the
 * history file. Every eval run makes paid model calls.
 *
 *   npm run eval:models -- --models "Qwen 3.7 Plus,DeepSeek V4 Pro" --runs 3
 *       [--evals consolidation,reconcile,typing,extraction,conversation] [--judge-model "<ref>"]
 *       [--engine-env <file>] [--curator-env <file>] [--engine-db <path>]
 *       [--tag <name>] [--history <file> | --no-history]
 *
 * Models are Settings/Models titles. Without --models each eval runs its configured model. The
 * Curator evals reach the Engine and read provider keys as `npm run eval:<name> -w vault-curator`
 * does (their env file, or --curator-env); the Engine eval reads its keys and database from
 * --engine-env (or the environment) and --engine-db. --judge-model fixes the judge of the judged
 * evals (extraction, conversation) so models are compared under one judge; without it each model
 * judges itself.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const EVAL_RESULT_PREFIX = 'EVAL_RESULT ';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_HISTORY = join(REPO_ROOT, 'evals', 'history.jsonl');

interface EvalDef { workspace: string; script: string; env: 'engine' | 'curator'; judged: boolean }
export const EVALS: Record<string, EvalDef> = {
  consolidation: { workspace: 'vault-engine', script: 'eval:consolidation', env: 'engine', judged: false },
  reconcile: { workspace: 'vault-curator', script: 'eval:reconcile', env: 'curator', judged: false },
  typing: { workspace: 'vault-curator', script: 'eval:typing', env: 'curator', judged: false },
  extraction: { workspace: 'vault-curator', script: 'eval:extraction', env: 'curator', judged: true },
  conversation: { workspace: 'vault-curator', script: 'eval:conversation', env: 'curator', judged: true },
};

// ---------------------------------------------------------------------------------------------
// The result line the evals print (packages/curator/src/eval/result.ts,
// packages/engine/src/memories/consolidation-eval-run.ts).

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface EvalCalls {
  model: string; label: string; provider: string | null;
  calls: number; failures: number; usage: TokenUsage; latencyMs: number; costUsd: number | null;
}
export type EvalScore =
  | { kind: 'exact'; correct: number; total: number }
  | { kind: 'judged'; coverage: number; precision: number; total: number };
export interface EvalResult { version: 1; eval: string; score: EvalScore; failures: number; job: EvalCalls; judge?: EvalCalls }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function isCalls(v: unknown): v is EvalCalls {
  const c = v as EvalCalls | null;
  return !!c && typeof c === 'object' && typeof c.model === 'string' && typeof c.label === 'string'
    && (c.provider === null || typeof c.provider === 'string') && isNum(c.calls) && isNum(c.failures)
    && !!c.usage && isNum(c.usage.input) && isNum(c.usage.output) && isNum(c.usage.cacheRead) && isNum(c.usage.cacheWrite)
    && isNum(c.latencyMs) && (c.costUsd === null || isNum(c.costUsd));
}
function isScore(v: unknown): v is EvalScore {
  const s = v as EvalScore | null;
  if (!s || typeof s !== 'object') return false;
  if (s.kind === 'exact') return isNum(s.correct) && isNum(s.total);
  return s.kind === 'judged' && isNum(s.coverage) && isNum(s.precision) && isNum(s.total);
}

/** The last result line in an eval's output, checked; throws when there is none or it is malformed. */
export function parseResultLine(stdout: string): EvalResult {
  const line = stdout.split('\n').reverse().find((l) => l.startsWith(EVAL_RESULT_PREFIX));
  if (line === undefined) throw new Error('the eval printed no result line');
  const raw = JSON.parse(line.slice(EVAL_RESULT_PREFIX.length)) as Record<string, unknown>;
  if (raw.version !== 1) throw new Error(`unsupported result line version ${String(raw.version)}`);
  if (typeof raw.eval !== 'string' || !isScore(raw.score) || !isNum(raw.failures) || !isCalls(raw.job)
    || (raw.judge !== undefined && !isCalls(raw.judge))) {
    throw new Error('malformed result line');
  }
  return raw as unknown as EvalResult;
}

// ---------------------------------------------------------------------------------------------
// Arguments.

export interface Options {
  evals: string[];
  /** Model refs; null runs each eval's configured model. */
  models: Array<string | null>;
  runs: number;
  judgeModel?: string;
  engineEnv?: string;
  curatorEnv?: string;
  engineDb?: string;
  tag?: string;
  /** null: write no history line. */
  history: string | null;
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter((s) => s !== '');

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { evals: Object.keys(EVALS), models: [null], runs: 1, history: DEFAULT_HISTORY };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--evals': {
        const evals = list(value());
        const unknown = evals.filter((e) => !(e in EVALS));
        if (unknown.length > 0) throw new Error(`unknown eval ${unknown.join(', ')}; known: ${Object.keys(EVALS).join(', ')}`);
        opts.evals = evals;
        break;
      }
      case '--models': opts.models = list(value()); break;
      case '--runs': {
        const runs = Number(value());
        if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs takes a whole number of at least 1');
        opts.runs = runs;
        break;
      }
      case '--judge-model': opts.judgeModel = value(); break;
      case '--engine-env': opts.engineEnv = value(); break;
      case '--curator-env': opts.curatorEnv = value(); break;
      // Resolved here: the Engine eval runs from packages/engine, where a relative path would point elsewhere.
      case '--engine-db': opts.engineDb = resolve(value()); break;
      case '--tag': opts.tag = value(); break;
      case '--history': opts.history = resolve(value()); break;
      case '--no-history': opts.history = null; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (opts.models.length === 0) throw new Error('--models names no model');
  return opts;
}

/** The npm arguments that run one eval on one model, from the repository root. */
export function childArgs(name: string, model: string | null, opts: Pick<Options, 'judgeModel' | 'engineDb'>): string[] {
  const def = EVALS[name]!;
  const args = ['run', '-s', def.script, '-w', def.workspace, '--', '--json'];
  if (model !== null) args.push('--model', model);
  if (def.judged && opts.judgeModel !== undefined) args.push('--judge-model', opts.judgeModel);
  if (def.env === 'engine' && opts.engineDb !== undefined) args.push('--db', opts.engineDb);
  return args;
}

// ---------------------------------------------------------------------------------------------
// Aggregation and output.

export interface Row {
  eval: string;
  ref: string | null;
  results: EvalResult[];
  errors: string[];
}

export interface RowSummary {
  eval: string;
  ref: string | null;
  label: string;
  provider: string | null;
  runs: number;
  errors: string[];
  score: string;
  failures: string;
  tokensPerRun: string;
  latencyPerCall: string;
  costPerRun: string;
  judgeCostPerRun: string | null;
  /** Numbers behind the strings, for the history line. */
  stats: {
    exact?: { meanCorrect: number; min: number; max: number; total: number };
    judged?: { coverage: number; precision: number; minPrecision: number; maxPrecision: number; total: number };
    failures: number; fixtures: number;
    /** Fixtures a judged eval left unscored because the judge's call failed. */
    unjudged: number;
    inputPerRun: number; outputPerRun: number;
    latencyPerCallMs: number | null; costPerRunUsd: number | null; judgeCostPerRunUsd: number | null;
  } | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
const dollars = (n: number | null) => (n === null ? 'unpriced' : `$${n.toFixed(4)}`);
const trimNum = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

/** Null when any run has no cost. */
function meanCost(costs: Array<number | null>): number | null {
  return costs.some((c) => c === null) ? null : mean(costs as number[]);
}

export function summarize(row: Row): RowSummary {
  const first = row.results[0];
  const base = {
    eval: row.eval, ref: row.ref, label: first?.job.label ?? row.ref ?? 'configured', provider: first?.job.provider ?? null,
    runs: row.results.length, errors: row.errors,
  };
  if (first === undefined) {
    return { ...base, score: 'error', failures: '—', tokensPerRun: '—', latencyPerCall: '—', costPerRun: '—', judgeCostPerRun: null, stats: null };
  }
  const rs = row.results;
  let score: string;
  const stats: NonNullable<RowSummary['stats']> = {
    failures: rs.reduce((a, r) => a + r.failures, 0),
    fixtures: rs.reduce((a, r) => a + r.score.total, 0),
    unjudged: rs.reduce((a, r) => a + (r.judge?.failures ?? 0), 0),
    inputPerRun: mean(rs.map((r) => r.job.usage.input)),
    outputPerRun: mean(rs.map((r) => r.job.usage.output)),
    latencyPerCallMs: null,
    costPerRunUsd: meanCost(rs.map((r) => r.job.costUsd)),
    judgeCostPerRunUsd: rs.every((r) => r.judge !== undefined) ? meanCost(rs.map((r) => r.judge!.costUsd)) : null,
  };
  const calls = rs.reduce((a, r) => a + r.job.calls, 0);
  if (calls > 0) stats.latencyPerCallMs = rs.reduce((a, r) => a + r.job.latencyMs, 0) / calls;
  const exact = rs.map((r) => r.score).filter((s): s is Extract<EvalScore, { kind: 'exact' }> => s.kind === 'exact');
  const judged = rs.map((r) => r.score).filter((s): s is Extract<EvalScore, { kind: 'judged' }> => s.kind === 'judged');
  if (exact.length === rs.length) {
    const correct = exact.map((s) => s.correct);
    const total = exact[0]!.total;
    stats.exact = { meanCorrect: mean(correct), min: Math.min(...correct), max: Math.max(...correct), total };
    score = `${trimNum(mean(correct))}/${total}${rs.length > 1 && stats.exact.min !== stats.exact.max ? ` (${stats.exact.min}–${stats.exact.max})` : ''}`;
  } else {
    // A run whose judge calls all failed scored nothing: it counts as unjudged, not as 0%.
    const scored = judged.filter((s) => s.total > 0);
    if (scored.length === 0) {
      score = 'unjudged';
    } else {
      const precision = scored.map((s) => s.precision);
      stats.judged = {
        coverage: mean(scored.map((s) => s.coverage)), precision: mean(precision),
        minPrecision: Math.min(...precision), maxPrecision: Math.max(...precision), total: scored[0]!.total,
      };
      const spread = scored.length > 1 && stats.judged.minPrecision !== stats.judged.maxPrecision
        ? ` (${pct(stats.judged.minPrecision)}–${pct(stats.judged.maxPrecision)})` : '';
      score = `cov ${pct(stats.judged.coverage)} · prec ${pct(stats.judged.precision)}${spread}`;
    }
  }
  return {
    ...base,
    score,
    failures: `${stats.failures === 0 ? '0' : `${stats.failures} of ${stats.fixtures}`}${stats.unjudged > 0 ? `; ${stats.unjudged} unjudged` : ''}`,
    tokensPerRun: `${kTokens(stats.inputPerRun)} / ${kTokens(stats.outputPerRun)}`,
    latencyPerCall: stats.latencyPerCallMs === null ? '—' : `${(stats.latencyPerCallMs / 1000).toFixed(1)}s`,
    costPerRun: dollars(stats.costPerRunUsd),
    judgeCostPerRun: rs.every((r) => r.judge !== undefined) ? dollars(stats.judgeCostPerRunUsd) : null,
    stats,
  };
}

/** Total estimated cost per provider, judges included, and how many runs had no price. */
export function costByProvider(rows: readonly Row[]): Array<{ provider: string; costUsd: number; unpricedRuns: number }> {
  const by = new Map<string, { costUsd: number; unpricedRuns: number }>();
  for (const row of rows) {
    for (const r of row.results) {
      for (const calls of [r.job, ...(r.judge ? [r.judge] : [])]) {
        const key = calls.provider ?? 'unknown';
        const entry = by.get(key) ?? { costUsd: 0, unpricedRuns: 0 };
        if (calls.costUsd === null) entry.unpricedRuns += 1;
        else entry.costUsd += calls.costUsd;
        by.set(key, entry);
      }
    }
  }
  return [...by.entries()].map(([provider, v]) => ({ provider, ...v })).sort((a, b) => a.provider.localeCompare(b.provider));
}

export function renderReport(rows: readonly Row[], opts: Pick<Options, 'runs' | 'judgeModel'>): string {
  const summaries = rows.map(summarize);
  const judged = summaries.some((s) => s.judgeCostPerRun !== null);
  const head = ['Eval', 'Model', 'Provider', 'Score', 'Failures', 'Tokens in / out per run', 'Latency per call', 'Cost per run', ...(judged ? ['Judge cost per run'] : [])];
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...summaries.map((s) => `| ${[
      s.eval, s.label, s.provider ?? '?', s.score, s.failures, s.tokensPerRun, s.latencyPerCall, s.costPerRun,
      ...(judged ? [s.judgeCostPerRun ?? '—'] : []),
    ].map(cell).join(' | ')} |`),
  ];
  const notes = [
    `${opts.runs} run${opts.runs === 1 ? '' : 's'} per eval and model; scores are means, with the range when runs differ. Costs are estimates from catalog or table rates, or the provider's reported charge where the Engine got one.`,
  ];
  if (judged) notes.push(opts.judgeModel !== undefined ? `Judged evals used ${opts.judgeModel} as judge.` : 'Judged evals were judged by the model under test (pass --judge-model to fix one judge).');
  if (summaries.some((s) => (s.stats?.unjudged ?? 0) > 0)) {
    notes.push('"unjudged": fixtures whose judge call failed; they are left out of that row\'s coverage and precision.');
  }
  const providers = costByProvider(rows);
  const byProvider = providers.length === 0 ? [] : [
    '',
    'Estimated cost by provider:',
    ...providers.map((p) => `- ${p.provider}: $${p.costUsd.toFixed(4)}${p.unpricedRuns > 0 ? ` (+ ${p.unpricedRuns} unpriced run${p.unpricedRuns === 1 ? '' : 's'})` : ''}`),
  ];
  const errors = summaries.flatMap((s) => s.errors.map((e) => `- ${s.eval} × ${s.label}: ${e}`));
  return [...lines, '', ...notes, ...byProvider, ...(errors.length > 0 ? ['', 'Errors:', ...errors] : [])].join('\n');
}

export function historyEntry(rows: readonly Row[], opts: Options, at: Date, git: { sha: string | null; dirty: boolean }): Record<string, unknown> {
  return {
    version: 1,
    at: at.toISOString(),
    gitSha: git.sha,
    dirty: git.dirty,
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
    runs: opts.runs,
    ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
    rows: rows.map((row) => {
      const s = summarize(row);
      return { eval: s.eval, ref: s.ref, label: s.label, provider: s.provider, runs: s.runs, errors: s.errors, stats: s.stats };
    }),
    results: rows.flatMap((row) => row.results),
  };
}

// ---------------------------------------------------------------------------------------------
// Running.

export interface ChildRun { code: number | null; stdout: string; stderr: string }
export type RunChild = (args: string[], env: NodeJS.ProcessEnv) => Promise<ChildRun>;

function spawnNpm(args: string[], env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function loadEnvFile(path: string | undefined): Record<string, string> {
  return path === undefined ? {} : parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

/** The last lines of a failed child's output, for the report. */
function failureText(run: ChildRun, err: unknown): string {
  const tail = `${run.stderr}\n${run.stdout}`.trim().split('\n').filter((l) => l.trim() !== '').slice(-3).join(' / ');
  return `${err instanceof Error ? err.message : String(err)}${run.code !== 0 ? ` (exit ${run.code})` : ''}${tail ? `: ${tail}` : ''}`.slice(0, 400);
}

export async function runAll(
  opts: Options,
  runChild: RunChild = spawnNpm,
  log: (line: string) => void = (l) => console.error(l),
): Promise<Row[]> {
  const envs = {
    engine: { ...process.env, ...loadEnvFile(opts.engineEnv) },
    curator: { ...process.env, ...loadEnvFile(opts.curatorEnv) },
  };
  const rows: Row[] = [];
  for (const name of opts.evals) {
    for (const model of opts.models) {
      const row: Row = { eval: name, ref: model, results: [], errors: [] };
      rows.push(row);
      for (let run = 1; run <= opts.runs; run++) {
        const label = `${name} × ${model ?? 'configured'}${opts.runs > 1 ? ` (run ${run}/${opts.runs})` : ''}`;
        const started = Date.now();
        let child: ChildRun = { code: null, stdout: '', stderr: '' };
        try {
          child = await runChild(childArgs(name, model, opts), envs[EVALS[name]!.env]);
          const result = parseResultLine(child.stdout);
          row.results.push(result);
          const s = result.score;
          const unjudged = result.judge?.failures ?? 0;
          log(`[eval-models] ${label}: ${s.kind === 'exact' ? `${s.correct}/${s.total}` : `cov ${pct(s.coverage)} prec ${pct(s.precision)} over ${s.total}${unjudged > 0 ? `, ${unjudged} unjudged` : ''}`} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
        } catch (err) {
          const text = failureText(child, err);
          row.errors.push(text);
          log(`[eval-models] ${label}: failed — ${text}`);
        }
      }
    }
  }
  return rows;
}

function gitState(): { sha: string | null; dirty: boolean } {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  // Tracked changes only: an untracked log or the history file itself can't change a result.
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { sha: sha.status === 0 ? sha.stdout.trim() : null, dirty: status.status === 0 && status.stdout.trim() !== '' };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await runAll(opts);
  console.log(renderReport(rows, opts));
  if (opts.history !== null) {
    mkdirSync(dirname(opts.history), { recursive: true });
    appendFileSync(opts.history, `${JSON.stringify(historyEntry(rows, opts, new Date(), gitState()))}\n`);
    console.error(`[eval-models] history line appended to ${opts.history}`);
  }
  if (rows.some((r) => r.errors.length > 0)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[eval-models] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
