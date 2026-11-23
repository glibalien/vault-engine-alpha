import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { loadRuntimeConfig } from './settings.js';
import { CurationQueue } from './queue.js';
import { runSweep, curateOne, createProjectWiki } from './core.js';
import { addUsage, formatUsage, ZERO_USAGE } from './pricing.js';
import { openRouterKeyRef, UsageReporter } from './usage-reporter.js';
import { budgetGate, createRunBudget, DailyBudget, dailyBudgetPolicy, ledgerSpend, withDailyBudget, type RunBudgetFactory } from './budget.js';
import { checkFieldFillArgs, fieldFillCli, type FieldFillCliArgs } from './field-fill/cli.js';
import { flagList, flagValue } from './on-demand/cli.js';
import { OnDemandError } from './on-demand/run.js';
import { checkTypeNotesArgs, typeNotesCli, type TypeNotesCliArgs } from './type-notes/cli.js';
import { budgetChargeStore } from './db/budget-charges.js';
import { ProviderLimits, providerKeyReaders } from './provider-limits.js';
import type { CurateResult, TokenUsage } from './types.js';
import { openCuratorDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { ActionRecorder } from './journal/recorder.js';
import { formatConversationCaptureCliOutput } from './capture-cli-output.js';
import { formatFieldGuessReport, formatTopicRefreshResult } from './report.js';

interface Args extends FieldFillCliArgs {
  project: string | null;
  createWiki: string | null;
  limit: number | null;
  force: boolean;
  experiment: string | null;
  variant: string | null;
  /** `--type-notes`: type the untyped notes in scope (#644). */
  typeNotes: boolean;
  undoTypes: string | null;
}

/** The typing command's flags. `--types` and `--path` are shared with `--fill-fields`, and mean its scope there. */
function typeNotesArgs(args: Args): TypeNotesCliArgs {
  return { dryRun: args.dryRun, preview: args.preview, typeNotes: args.typeNotes, offer: args.fillTypes, path: args.fillPath,
    limitUsd: args.limitUsd, sample: args.sample, undoTypes: args.undoTypes };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, preview: false, project: null, createWiki: null, limit: null, force: false, experiment: null, variant: null,
    fillFields: null, fillTypes: null, fillPath: null, limitUsd: null, sample: null, undoFill: null, replaceInvalid: false,
    typeNotes: false, undoTypes: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--preview') { args.dryRun = true; args.preview = true; }
    else if (a === '--force') args.force = true;
    // A flag with no value is refused, never read as absent: --project with nothing after it
    // would otherwise curate every project, and --path with nothing would fill every folder.
    else if (a === '--project') args.project = flagValue(a, argv[++i]);
    else if (a === '--create-wiki') args.createWiki = flagValue(a, argv[++i]);
    else if (a === '--limit') args.limit = Number(flagValue(a, argv[++i]));
    else if (a === '--experiment') args.experiment = flagValue(a, argv[++i]);
    else if (a === '--variant') args.variant = flagValue(a, argv[++i]);
    else if (a === '--fill-fields') args.fillFields = flagList(a, argv[++i]);
    else if (a === '--types') args.fillTypes = flagList(a, argv[++i]);
    else if (a === '--path') args.fillPath = flagValue(a, argv[++i]);
    else if (a === '--limit-usd') args.limitUsd = Number(flagValue(a, argv[++i]));
    else if (a === '--sample') args.sample = Number(flagValue(a, argv[++i]));
    else if (a === '--undo-fill') args.undoFill = flagValue(a, argv[++i]);
    else if (a === '--replace-invalid') args.replaceInvalid = true;
    else if (a === '--type-notes') args.typeNotes = true;
    else if (a === '--undo-types') args.undoTypes = flagValue(a, argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number');
  }
  if (args.typeNotes || args.undoTypes !== null) {
    if (args.fillFields !== null || args.undoFill !== null || args.replaceInvalid) {
      throw new Error('--type-notes and --undo-types are one command, --fill-fields and --undo-fill another: give one at a time');
    }
    checkTypeNotesArgs(typeNotesArgs(args));
  } else {
    checkFieldFillArgs(args);
  }
  return args;
}

function printHelp(): void {
  console.log(`vault-curator — maintain project wikis via vault-engine

Usage: vault-curator [options]

  --dry-run            Report which wikis would be curated and why; no model calls, no writes
  --preview            Like --dry-run, but run the paid model calls and show the result
  --force              Re-curate even when the evidence fingerprint is unchanged
  --project "<title>"  Curate exactly one project wiki by title
  --create-wiki "<title>"  Start keeping a wiki for a project (empty home, then first curation)
  --limit <n>          Cap the number of active projects curated this run
  --fill-fields <a,b>  Fill these fields on a chosen set of notes from each note's text. Alone, or
                       with --dry-run, it counts the notes in scope and calls no model
    --types <a,b>      ...on notes that have all of these types
    --path <prefix>    ...on notes under this folder
    --preview          ...and try the model on a sample (paid, from the daily cap), with an estimate
    --sample <n>       ...of this many notes (default 5)
    --limit-usd <n>    ...or run it, spending at most this many dollars, apart from the daily cap
    --replace-invalid  ...also replacing values that fail their field's type (left alone otherwise)
  --undo-fill <run>    Put back what a field-filling run wrote (with --dry-run, say what it would)
  --type-notes         Give untyped notes a type each, chosen by a model from the note's text. Alone,
                       or with --dry-run, it counts the notes in scope and calls no model
    --path <prefix>    ...the untyped notes under this folder (all of them otherwise)
    --types <a,b>      ...choosing among these types only (every type otherwise)
    --preview          ...and try the model on a sample (paid, from the daily cap), with an estimate
    --sample <n>       ...of this many notes (default 5)
    --limit-usd <n>    ...or run it, spending at most this many dollars, apart from the daily cap
  --undo-types <run>   Take back the types a typing run gave (with --dry-run, say what it would)
  --experiment "<id>"  Stamp usage events with a benchmark experiment label
  --variant "<id>"     Stamp usage events with a benchmark arm label
  -h, --help           Show this help

Env (see .env.example): ENGINE_URL, ENGINE_TOKEN, ANTHROPIC_API_KEY / OPENAI_COMPAT_API_KEY`);
}

function log(line: string): void {
  console.log(`[curator ${new Date().toISOString()}] ${line}`);
}

function printSectionsPreview(sections: { now: string; focus: string; open_threads: string; log_entry: string }): void {
  const blocks: Array<[string, string]> = [
    ['Now', sections.now], ['Focus', sections.focus],
    ['Open threads', sections.open_threads], ['Log (append)', sections.log_entry],
  ];
  console.log('\n  ┌─ would write ─────────────────────────────');
  for (const [name, content] of blocks) {
    console.log(`\n  ## ${name}\n`);
    console.log(content.split('\n').map(l => `  ${l}`).join('\n'));
  }
  console.log('\n  └───────────────────────────────────────────\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (args.experiment) env.CURATOR_EXPERIMENT = args.experiment;
  if (args.variant) env.CURATOR_VARIANT = args.variant;
  const { bootstrap, config, engine } = await loadRuntimeConfig(env, (m) => log(m));
  const reporter = new UsageReporter(engine, {
    provider: providerForModel(config.modelProviders),
    experiment: bootstrap.experiment,
    variant: bootstrap.variant,
    openRouterKeyRef: openRouterKeyRef(bootstrap.llmKeys),
  });
  const db = openCuratorDb(bootstrap.curatorDbPath);
  runMigrations(db);
  const dailyBudget = new DailyBudget(ledgerSpend(engine), undefined, budgetChargeStore(db),
    new ProviderLimits(providerKeyReaders(bootstrap.llmKeys)));
  engine.setSpendObserver(usd => dailyBudget.charge(usd));
  const policy = dailyBudgetPolicy(config);
  const reported = reporter.wrap(createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders),
    { reasoningEffort: config.reasoningEffort }));
  const llm = withDailyBudget(reported, dailyBudget, policy);
  const queue = new CurationQueue();
  const recorder = new ActionRecorder(db);
  engine.setRecorder(recorder);
  // An on-demand run (field filling, typing) states its own limit, apart from the daily cap (#644).
  const runBudget: RunBudgetFactory = run => createRunBudget({
    llm: reported, policy, engine, limitUsd: run.limitUsd, runRef: run.runRef,
    ...(dailyBudget.limits ? { limits: dailyBudget.limits } : {}),
  });
  const deps = { engine, llm, config, queue, db, usage: reporter, recorder, budget: budgetGate(dailyBudget, policy), runBudget };

  await engine.connect();
  log(`connected to engine at ${config.engineUrl} (model ${config.model})${args.dryRun ? ' [DRY RUN]' : ''}`);

  const logResult = (result: CurateResult): void => {
    const tag = result.outcome === 'error' ? 'ERROR' : result.outcome.toUpperCase();
    log(`${tag}  ${result.project} — ${result.detail ?? ''}`);
    const refresh = formatTopicRefreshResult(result);
    if (refresh !== null) log(`  refresh: ${refresh}`);
    if (result.usage) log(`  tokens: ${formatUsage(result.usage, result.costUsd ?? null)}`);
    if (args.dryRun && result.sections) printSectionsPreview(result.sections);
  };

  try {
    const typing = args.typeNotes || args.undoTypes !== null;
    if (typing || args.fillFields !== null || args.undoFill !== null) {
      try {
        const done = typing ? await typeNotesCli(deps, typeNotesArgs(args), log) : await fieldFillCli(deps, args, log);
        if (done.failed) process.exitCode = 1;
      } catch (error) {
        if (!(error instanceof OnDemandError)) throw error;
        log(`ERROR  ${error.code}: ${error.message}`);
        process.exitCode = 1;
      }
      return;
    }
    if (args.createWiki) {
      const created = await createProjectWiki(deps, { project: args.createWiki, dryRun: args.dryRun, by: 'cli' });
      if (!created.ok) {
        log(`ERROR  ${args.createWiki} — ${created.error.code}: ${created.error.message}`);
        process.exitCode = 1;
      } else {
        log(`${created.created ? 'CREATED' : 'EXISTS'}  ${created.project} — ${created.detail}`);
        if (created.first_build !== null && typeof created.first_build === 'object') logResult(created.first_build);
      }
      return;
    }
    let results: CurateResult[];
    if (args.project) {
      log(`curating "${args.project}"`);
      const result = await curateOne(deps, args.project, { dryRun: args.dryRun, preview: args.preview, force: args.force, trigger: 'cli' });
      logResult(result);
      results = [result];
    } else {
      if (args.dryRun && !args.preview) log('dry run: capture, field-guess, memory, organization and reconciliation sweeps skipped; --preview runs them');
      results = await runSweep(deps, {
        dryRun: args.dryRun,
        preview: args.preview,
        force: args.force,
        trigger: 'cli',
        limit: args.limit,
        onFieldGuessResult: (result) => {
          for (const line of formatFieldGuessReport(result)) log(line);
        },
        onStart: (n) => log(`${n} project(s) to curate`),
        onResult: logResult,
        onConversationCaptureResult: (result) => {
          for (const line of formatConversationCaptureCliOutput(result, result.dryRun)) log(line);
        },
      });
    }

    const written = results.filter((r) => r.outcome === 'written').length;
    const skipped = results.filter((r) => r.outcome === 'skipped').length;
    const wouldCurate = results.filter((r) => r.outcome === 'would_curate').length;
    const refreshedLive = results.filter((r) => r.outcome === 'refreshed_live').length;
    const errors = results.filter((r) => r.outcome === 'error').length;
    const totalUsage = results.reduce<TokenUsage>((acc, r) => (r.usage ? addUsage(acc, r.usage) : acc), ZERO_USAGE);
    const totalCost = results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    log(`done: ${written} written, ${skipped} skipped (unchanged), ${wouldCurate} would curate, ${refreshedLive} live-only, ${errors} error(s), ${results.length} total`);
    log(`total tokens: ${formatUsage(totalUsage, totalCost)} (home ${config.model})`);
    if (errors > 0) process.exitCode = 1;
  } finally {
    // Usage rows are written in the background; closing first would drop the last call's (#386).
    await reporter.flush();
    await engine.close();
    db.close();
  }
}

main().catch(err => {
  console.error(`[curator] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
