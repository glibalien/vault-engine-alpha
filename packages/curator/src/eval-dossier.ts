import { randomUUID } from 'node:crypto';
import { DailyBudget, dailyBudgetPolicy, ledgerSpend, withDailyBudget } from './budget.js';
import { DOSSIER_GOLDEN_CASES, type DossierGoldenCase } from './eval/dossier-golden-cases.js';
import { runDossierCase, type DossierGoldenResult } from './eval/dossier-golden.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { addUsage, catalogPricing, formatUsage, ZERO_USAGE } from './pricing.js';
import { loadRuntimeConfig } from './settings.js';
import { openRouterKeyRef, UsageReporter } from './usage-reporter.js';
import { resolveConfiguredWikiStage } from './wiki-output-policy.js';

/**
 * `npm run eval:dossier` — run the golden dossier cases (#721) against the configured wiki home
 * model: one page call per case, plus the rule check when the case's subject has rules, under the
 * daily budget and recorded as `eval-wiki`. Informational: failures are reported, not enforced.
 * `--dry-run` lists the cases without model calls.
 */

function log(line: string): void {
  console.log(`[eval:dossier] ${line}`);
}

interface Args { dryRun: boolean; cases: string[]; showOutput: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, cases: [], showOutput: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--case') args.cases.push(argv[++i] ?? '');
    else if (a === '--show-output') args.showOutput = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run eval:dossier -- [--dry-run] [--case <id>]... [--show-output]\n\n'
        + '--show-output prints the page code wrote for each case after its verdict.\n\nCases:\n'
        + DOSSIER_GOLDEN_CASES.map(c => `  ${c.id.padEnd(28)} ${c.failure}`).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

export function selectDossierCases(ids: readonly string[]): DossierGoldenCase[] {
  if (ids.length === 0) return [...DOSSIER_GOLDEN_CASES];
  const unknown = ids.filter(id => !DOSSIER_GOLDEN_CASES.some(c => c.id === id));
  if (unknown.length > 0) throw new Error(`unknown case(s): ${unknown.join(', ')}`);
  return DOSSIER_GOLDEN_CASES.filter(c => ids.includes(c.id));
}

function report(result: DossierGoldenResult): void {
  log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${result.kept} lines, ${result.undated} undated`
    + `${result.ruleDropped > 0 ? `, ${result.ruleDropped} left out by the rule check` : ''}; ${result.calls} call(s)`
    + `${result.costUsd === null ? '' : `  $${result.costUsd.toFixed(4)}`}`);
  if (result.error) log(`  error: ${result.error}`);
  for (const check of result.checks) if (!check.passed) log(`  failed: ${check.why}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = selectDossierCases(args.cases);
  if (args.dryRun) {
    for (const c of cases) log(`${c.id} (${c.kind}): ${c.checks.map(check => check.why).join('; ')}`);
    log(`${cases.length} case(s); dry run, no model calls`);
    return;
  }
  const { bootstrap, config, engine } = await loadRuntimeConfig(process.env, line => log(line));
  const reporter = new UsageReporter(engine, { provider: providerForModel(config.modelProviders), experiment: 'eval-dossier', variant: null,
    openRouterKeyRef: openRouterKeyRef(bootstrap.llmKeys) });
  try {
    const llm = withDailyBudget(reporter.wrap(createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders),
      { reasoningEffort: config.reasoningEffort })), new DailyBudget(ledgerSpend(engine)), dailyBudgetPolicy(config));
    const policy = resolveConfiguredWikiStage(config, llm, 'home');
    log(`home model ${policy.model}; ${cases.length} case(s)`);
    const results: DossierGoldenResult[] = [];
    for (const c of cases) {
      reporter.setContext({ project: `eval:dossier:${c.id}`, runRef: randomUUID(), purpose: 'eval-wiki' });
      const result = await runDossierCase(llm, policy, c, catalogPricing(config));
      reporter.setContext(null);
      report(result);
      if (args.showOutput) {
        const mark = `----- ${result.id} page`;
        console.log(`${mark} -----\n${result.output === '' ? '(no output)' : result.output.trimEnd()}\n${mark} ends -----`);
      }
      results.push(result);
    }
    const passed = results.filter(result => result.passed).length;
    const total = results.reduce((sum, result) => addUsage(sum, result.usage), ZERO_USAGE);
    const known = results.map(result => result.costUsd).filter((cost): cost is number => cost !== null);
    log(`${passed}/${results.length} passed; ${formatUsage(total, known.reduce((sum, cost) => sum + cost, 0))}`);
  } finally {
    // Usage rows are written in the background; closing first would drop the last call's (#386).
    await reporter.flush();
    await engine.close();
  }
}

if (process.argv[1]?.endsWith('eval-dossier.ts') || process.argv[1]?.endsWith('eval-dossier.js')) {
  main().catch(err => {
    console.error(`[eval:dossier] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
