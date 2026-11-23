import { randomUUID } from 'node:crypto';
import { DailyBudget, dailyBudgetPolicy, ledgerSpend, withDailyBudget } from './budget.js';
import { GOLDEN_CASES, type GoldenCase } from './eval/wiki-golden-cases.js';
import { flaggedExcerpt, runGoldenCase, totalUsage, type GoldenResult } from './eval/wiki-golden.js';
import { judgeRule, resolveJudgeModel, type RuleJudge } from './eval/wiki-judge.js';
import { JUDGE_CALIBRATION } from './eval/wiki-judge-calibration.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { catalogPricing, formatUsage } from './pricing.js';
import { loadRuntimeConfig } from './settings.js';
import { SPEC_A_SYSTEM_PROMPT } from './synthesize.js';
import { openRouterKeyRef, UsageReporter } from './usage-reporter.js';
import { resolveWikiOutputPolicy } from './wiki-output-policy.js';

/**
 * `npm run eval:wiki` — run the golden wiki cases against the configured page/home
 * models and prompts. One paid call per case, plus a judge call for each answer a
 * "must not say" pattern flags (#604), under the daily budget. Informational: failures
 * are reported, not enforced. `--dry-run` lists cases without model calls.
 */

function log(line: string): void {
  console.log(`[eval:wiki] ${line}`);
}

interface Args { dryRun: boolean; cases: string[]; judge: boolean; judgeModel?: string; checkJudge: boolean; showOutput: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, cases: [], judge: true, checkJudge: false, showOutput: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--case') args.cases.push(argv[++i] ?? '');
    else if (a === '--no-judge') args.judge = false;
    else if (a === '--judge-model') args.judgeModel = argv[++i] ?? '';
    else if (a === '--check-judge') args.checkJudge = true;
    else if (a === '--show-output') args.showOutput = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run eval:wiki -- [--dry-run] [--case <id>]... [--show-output] [--no-judge] [--judge-model <ref>] [--check-judge]\n\n'
        + 'A judge rules on each answer a "must not say" pattern flags (#604); it runs on the page model\n'
        + 'unless --judge-model names another. --check-judge runs the judge over its calibration answers\n'
        + 'instead of the cases. --show-output prints what the model wrote for each case after its verdict.\n\nCases:\n'
        + GOLDEN_CASES.map(c => `  ${c.id.padEnd(32)} ${c.failure}`).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function selectCases(ids: readonly string[]): GoldenCase[] {
  if (ids.length === 0) return [...GOLDEN_CASES];
  const unknown = ids.filter(id => !GOLDEN_CASES.some(c => c.id === id));
  if (unknown.length > 0) throw new Error(`unknown case(s): ${unknown.join(', ')}`);
  return GOLDEN_CASES.filter(c => ids.includes(c.id));
}

/** What the model wrote for a case, between marker lines, so a failure can be read and not only counted (#632). */
function showOutput(result: GoldenResult): void {
  const mark = `----- ${result.id} (${result.stage}) output`;
  console.log(`${mark} -----\n${result.output === '' ? '(no output)' : result.output.trimEnd()}\n${mark} ends -----`);
}

function report(result: GoldenResult): void {
  log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.id} (${result.stage})${result.costUsd === null ? '' : `  $${result.costUsd.toFixed(4)}`}`);
  if (result.error) log(`  error: ${result.error}`);
  for (const check of result.checks) {
    if (check.judge !== undefined) {
      const ruling = check.judge.ruling;
      if (ruling === null) log(`  failed: ${check.why} (judge gave no ruling${check.judge.error ? `: ${check.judge.error}` : ''})`);
      else log(`  ${ruling.breaks ? 'failed' : 'cleared by judge'}: ${check.why} — ${ruling.reason} «${ruling.quote}»`);
    } else if (!check.passed) log(`  failed: ${check.why}`);
  }
}

/** Run the judge over its calibration answers and report how often it agrees with their labels. */
async function checkJudge(judge: RuleJudge): Promise<void> {
  let agreed = 0;
  for (const answer of JUDGE_CALIBRATION) {
    const c = GOLDEN_CASES.find(golden => golden.id === answer.caseId);
    const check = c?.checks.find(candidate => candidate.judge !== undefined);
    if (c === undefined || c.stage !== 'home' || check === undefined || check.judge === undefined) {
      throw new Error(`calibration answer "${answer.label}" names no judged home case`);
    }
    const { ruling, error } = await judgeRule(judge, { rule: check.judge, mistake: c.failure, evidence: c.evidence,
      page: answer.output, flagged: flaggedExcerpt(answer.output, check) });
    const ok = ruling !== null && ruling.breaks === answer.breaks;
    if (ok) agreed += 1;
    log(`${ok ? 'AGREE   ' : 'DISAGREE'} ${answer.caseId} / ${answer.label}: expected ${answer.breaks ? 'breaks' : 'keeps'}, `
      + `judge ${ruling === null ? `no ruling${error ? ` (${error})` : ''}` : `${ruling.breaks ? 'breaks' : 'keeps'} — ${ruling.reason}`}`);
  }
  log(`judge agreed on ${agreed}/${JUDGE_CALIBRATION.length} calibration answers (model ${judge.model})`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = selectCases(args.cases);
  if (args.dryRun) {
    for (const c of cases) log(`${c.id} (${c.stage}): ${c.checks.map(check => check.why).join('; ')}`);
    log(`${cases.length} case(s); dry run, no model calls`);
    return;
  }
  const { bootstrap, config, engine, catalog } = await loadRuntimeConfig(process.env, line => log(line));
  const reporter = new UsageReporter(engine, { provider: providerForModel(config.modelProviders), experiment: 'eval-wiki', variant: null, openRouterKeyRef: openRouterKeyRef(bootstrap.llmKeys) });
  try {
    const llm = withDailyBudget(reporter.wrap(createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders),
      { reasoningEffort: config.reasoningEffort })), new DailyBudget(ledgerSpend(engine)), dailyBudgetPolicy(config));
    const policy = resolveWikiOutputPolicy(config, llm);
    const prompts = {
      ...(config.curatorPagePrompt.trim() ? { page: config.curatorPagePrompt } : {}),
      home: config.curatorProjectHomePrompt.trim() || SPEC_A_SYSTEM_PROMPT,
    };
    // The judge (#604) runs on the page model unless --judge-model names another; it should not be
    // the model that wrote the homes it rules on.
    const judgeModel = args.judgeModel === undefined ? policy.page.model
      : resolveJudgeModel(catalog, args.judgeModel, config);
    const judge: RuleJudge | undefined = args.judge || args.checkJudge ? { llm, model: judgeModel } : undefined;
    if (judge !== undefined && judge.model === policy.home.model) {
      log(`warning: the judge (${judge.model}) is also the home model; pass --judge-model to pick another`);
    }
    if (args.checkJudge) {
      reporter.setContext({ project: 'eval:judge-calibration', runRef: randomUUID(), purpose: 'eval-wiki' });
      await checkJudge(judge!);
      reporter.setContext(null);
      return;
    }
    log(`page model ${policy.page.model}; home model ${policy.home.model}; judge ${judge?.model ?? 'off'}; ${cases.length} case(s)`);
    const results: GoldenResult[] = [];
    for (const c of cases) {
      reporter.setContext({ project: `eval:${c.id}`, runRef: randomUUID(), purpose: 'eval-wiki' });
      const result = await runGoldenCase(llm, policy, prompts, c, judge, catalogPricing(config));
      reporter.setContext(null);
      report(result);
      if (args.showOutput) showOutput(result);
      results.push(result);
    }
    const passed = results.filter(result => result.passed).length;
    const knownCosts = results.map(result => result.costUsd).filter((cost): cost is number => cost !== null);
    log(`${passed}/${results.length} passed; ${formatUsage(totalUsage(results), knownCosts.reduce((sum, cost) => sum + cost, 0))}`);
  } finally {
    // Usage rows are written in the background; closing first would drop the last call's (#386).
    await reporter.flush();
    await engine.close();
  }
}

main().catch(err => {
  console.error(`[eval:wiki] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
