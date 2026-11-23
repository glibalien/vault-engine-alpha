import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  childArgs, costByProvider, DEFAULT_HISTORY, historyEntry, parseArgs, parseResultLine, renderReport, runAll, summarize,
  type EvalResult, type Row, type RunChild,
} from './eval-models.js';
import { resultLine as curatorResultLine } from '../packages/curator/src/eval/result.js';
import { resultLine as engineResultLine } from '../packages/engine/src/memories/consolidation-eval-run.js';

// #570: the eval:models runner, with the child processes faked. No model is called.

const calls = (over: Partial<EvalResult['job']> = {}): EvalResult['job'] => ({
  model: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus', provider: 'openrouter', calls: 8, failures: 0,
  usage: { input: 8000, output: 2000, cacheRead: 0, cacheWrite: 0 }, latencyMs: 16000, costUsd: 0.01, ...over,
});
type ExactResult = EvalResult & { score: { kind: 'exact'; correct: number; total: number } };
const exact = (correct: number, over: Partial<ExactResult> = {}): ExactResult =>
  ({ version: 1, eval: 'consolidation', score: { kind: 'exact', correct, total: 8 }, failures: 0, job: calls(), ...over });

test('reads the result lines both emitters print', () => {
  const fromCurator = curatorResultLine({
    version: 1, eval: 'extraction', score: { kind: 'judged', coverage: 1, precision: 0.9, total: 6 }, failures: 1,
    job: calls(), judge: calls({ model: 'judge', label: 'Judge', costUsd: null }),
  });
  const fromEngine = engineResultLine(exact(7));
  assert.equal(parseResultLine(`noise\n${fromCurator}\n`).eval, 'extraction');
  assert.deepEqual(parseResultLine(`## case\n  got add\n${fromEngine}`).score, { kind: 'exact', correct: 7, total: 8 });
});

test('refuses output with no result line, another version or a broken shape', () => {
  assert.throws(() => parseResultLine('== consolidation eval: 7/8'), /no result line/);
  assert.throws(() => parseResultLine(`EVAL_RESULT ${JSON.stringify({ ...exact(7), version: 2 })}`), /version 2/);
  assert.throws(() => parseResultLine(`EVAL_RESULT ${JSON.stringify({ ...exact(7), job: { model: 'x' } })}`), /malformed/);
});

test('parses options, with every eval and the configured models by default', () => {
  assert.deepEqual(parseArgs([]), {
    evals: ['consolidation', 'reconcile', 'typing', 'extraction', 'conversation'], models: [null], runs: 1, history: DEFAULT_HISTORY,
  });
  assert.equal(parseArgs(['--engine-db', 'data/vault.db']).engineDb, join(process.cwd(), 'data/vault.db'));
  const opts = parseArgs(['--models', 'Qwen 3.7 Plus, DeepSeek V4 Pro', '--evals', 'reconcile,extraction', '--runs', '3',
    '--judge-model', 'Judge', '--engine-db', '/x/vault.db', '--tag', 'try', '--no-history']);
  assert.deepEqual(opts.models, ['Qwen 3.7 Plus', 'DeepSeek V4 Pro']);
  assert.deepEqual(opts.evals, ['reconcile', 'extraction']);
  assert.equal(opts.runs, 3);
  assert.equal(opts.history, null);
  assert.throws(() => parseArgs(['--evals', 'wiki']), /unknown eval wiki/);
  assert.throws(() => parseArgs(['--runs', '0']), /at least 1/);
  assert.throws(() => parseArgs(['--models']), /needs a value/);
  assert.throws(() => parseArgs(['--model', 'x']), /unknown option --model/);
});

test('builds each eval\'s npm call, passing the judge and database only where they apply', () => {
  const opts = { judgeModel: 'Judge', engineDb: '/x/vault.db' };
  assert.deepEqual(childArgs('consolidation', 'Qwen 3.7 Plus', opts),
    ['run', '-s', 'eval:consolidation', '-w', 'vault-engine', '--', '--json', '--model', 'Qwen 3.7 Plus', '--db', '/x/vault.db']);
  assert.deepEqual(childArgs('extraction', null, opts),
    ['run', '-s', 'eval:extraction', '-w', 'vault-curator', '--', '--json', '--judge-model', 'Judge']);
  assert.deepEqual(childArgs('reconcile', 'M', opts), ['run', '-s', 'eval:reconcile', '-w', 'vault-curator', '--', '--json', '--model', 'M']);
});

test('summarizes runs: mean score with its range, failures, tokens, latency and cost', () => {
  const row: Row = { eval: 'consolidation', ref: 'Qwen 3.7 Plus', errors: [], results: [
    exact(7), exact(8), exact(6, { failures: 1, job: calls({ costUsd: 0.02, calls: 8, latencyMs: 8000 }) }),
  ] };
  const s = summarize(row);
  assert.equal(s.score, '7/8 (6–8)');
  assert.equal(s.failures, '1 of 24');
  assert.equal(s.tokensPerRun, '8.0k / 2.0k');
  assert.equal(s.latencyPerCall, '1.7s');
  assert.equal(s.costPerRun, `$${((0.01 + 0.01 + 0.02) / 3).toFixed(4)}`);
  assert.equal(s.judgeCostPerRun, null);

  const unpriced = summarize({ ...row, results: [exact(7), exact(7, { job: calls({ costUsd: null }) })] });
  assert.equal(unpriced.score, '7/8');
  assert.equal(unpriced.costPerRun, 'unpriced');

  const judged = summarize({ eval: 'extraction', ref: null, errors: [], results: [
    { version: 1, eval: 'extraction', score: { kind: 'judged', coverage: 1, precision: 0.8, total: 6 }, failures: 0, job: calls(), judge: calls({ costUsd: 0.004 }) },
    { version: 1, eval: 'extraction', score: { kind: 'judged', coverage: 0.9, precision: 1, total: 6 }, failures: 0, job: calls(), judge: calls({ costUsd: 0.006 }) },
  ] });
  assert.equal(judged.score, 'cov 95% · prec 90% (80%–100%)');
  assert.equal(judged.judgeCostPerRun, '$0.0050');

  // A judge call that failed leaves its fixture unscored: say so (Codex on #618).
  const partly = summarize({ eval: 'extraction', ref: null, errors: [], results: [
    { version: 1, eval: 'extraction', score: { kind: 'judged', coverage: 1, precision: 1, total: 4 }, failures: 0, job: calls(), judge: calls({ failures: 2 }) },
  ] });
  assert.equal(partly.failures, '0; 2 unjudged');

  // A run whose judge calls all failed is left out of the means (Codex on #618).
  const judgedRun = (precision: number, total: number, judgeFailures = 0): EvalResult =>
    ({ version: 1, eval: 'extraction', score: { kind: 'judged', coverage: 1, precision, total }, failures: 0, job: calls(), judge: calls({ failures: judgeFailures }) });
  const oneBlank = summarize({ eval: 'extraction', ref: null, errors: [], results: [judgedRun(0.5, 4), judgedRun(0, 0, 4)] });
  assert.equal(oneBlank.score, 'cov 100% · prec 50%');
  assert.equal(oneBlank.failures, '0; 4 unjudged');
  assert.equal(summarize({ eval: 'extraction', ref: null, errors: [], results: [judgedRun(0, 0, 4)] }).score, 'unjudged');
  assert.match(renderReport([{ eval: 'extraction', ref: null, errors: [], results: [
    { version: 1, eval: 'extraction', score: { kind: 'judged', coverage: 1, precision: 1, total: 4 }, failures: 0, job: calls(), judge: calls({ failures: 2 }) },
  ] }], { runs: 1 }), /"unjudged": fixtures whose judge call failed/);

  const failed = summarize({ eval: 'typing', ref: 'X', errors: ['no key'], results: [] });
  assert.equal(failed.score, 'error');
  assert.equal(failed.stats, null);
});

test('renders one table, the cost by provider and the errors', () => {
  const rows: Row[] = [
    { eval: 'consolidation', ref: 'Qwen 3.7 Plus', errors: [], results: [exact(7)] },
    { eval: 'consolidation', ref: 'Kimi', errors: [], results: [exact(8, { job: calls({ label: 'Kimi | K2', provider: 'fireworks', costUsd: null }) })] },
    { eval: 'typing', ref: 'Broken', errors: ['the eval printed no result line (exit 1): no key'], results: [] },
  ];
  const report = renderReport(rows, { runs: 1 });
  assert.match(report, /^\| Eval \| Model \| Provider \| Score \|/);
  assert.match(report, /\| consolidation \| Qwen 3\.7 Plus \| openrouter \| 7\/8 \| 0 \|/);
  assert.match(report, /Kimi \\\| K2/);
  assert.match(report, /- fireworks: \$0\.0000 \(\+ 1 unpriced run\)/);
  assert.match(report, /- openrouter: \$0\.0100/);
  assert.match(report, /typing × Broken: the eval printed no result line/);
  assert.deepEqual(costByProvider(rows).map((p) => p.provider), ['fireworks', 'openrouter']);
});

test('runs every eval × model × run through the child runner and keeps going after a failure', async () => {
  const seen: Array<{ args: string[]; key: string | undefined }> = [];
  const runChild: RunChild = async (args, env) => {
    seen.push({ args, key: env.TEST_PROVIDER_KEY });
    if (args.includes('eval:typing')) return { code: 1, stdout: '', stderr: 'no provider key for openrouter' };
    return { code: 0, stdout: `## case\n${engineResultLine(exact(7))}\n`, stderr: '' };
  };
  const dir = mkdtempSync(join(tmpdir(), 'eval-models-'));
  try {
    const envFile = join(dir, 'engine.env');
    writeFileSync(envFile, 'TEST_PROVIDER_KEY=from-engine-env\n');
    const opts = parseArgs(['--evals', 'consolidation,typing', '--models', 'A,B', '--runs', '2', '--engine-env', envFile, '--no-history']);
    const rows = await runAll(opts, runChild, () => {});
    assert.equal(seen.length, 8);
    assert.equal(seen[0]!.key, 'from-engine-env');
    assert.equal(seen.find((s) => s.args.includes('eval:typing'))!.key, process.env.TEST_PROVIDER_KEY);
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.results.length, 2);
    assert.match(rows[2]!.errors[0]!, /no result line \(exit 1\): no provider key/);

    const entry = historyEntry(rows, { ...opts, tag: 'try' }, new Date('2026-11-16T12:00:00Z'), { sha: 'abc', dirty: false });
    assert.equal(entry.at, '2026-11-16T12:00:00.000Z');
    assert.equal(entry.tag, 'try');
    assert.equal((entry.results as unknown[]).length, 4);
    assert.ok(!JSON.stringify(entry).includes('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
