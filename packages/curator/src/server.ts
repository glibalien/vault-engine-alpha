import 'dotenv/config';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { loadBootstrapConfig, projectTypeOf, vaultOf, type Config } from './config.js';
import { CuratorSettingsClient, buildRuntimeConfig } from './settings.js';
import { ownerPasswordWarning, validateAuthEnv } from './auth/env.js';
import { openCuratorDb } from './db/connection.js';
import { createAuthSchema } from './auth/schema.js';
import { runMigrations } from './db/migrate.js';
import { Engine } from './engine.js';
import { CurationQueue } from './queue.js';
import { BackgroundBuilds } from './background-builds.js';
import { openRouterKeyRef, UsageReporter } from './usage-reporter.js';
import { budgetGate, createRunBudget, DailyBudget, dailyBudgetPolicy, ledgerSpend, withDailyBudget, type RunBudgetFactory } from './budget.js';
import { budgetChargeStore } from './db/budget-charges.js';
import { ProviderLimits, providerKeyReaders } from './provider-limits.js';
import { buildAuthConfig, curatorServerFactory } from './server-bootstrap.js';
import { startHomeRefreshRecovery } from './home-refresh-recovery.js';
import { startHttpTransport } from './transport/http.js';
import { startScheduler, needsCatchUp, SWEEP_INTERVAL_MS } from './scheduler.js';
import type { CoreDeps } from './core.js';
import { lastSweepAt } from './db/runs.js';
import { ActionRecorder } from './journal/recorder.js';
import { createProductionSweepRunner } from './server-sweep.js';
import { ServerLifecycle, finishWithin } from './server-lifecycle.js';
import { releaseAbandonedRuns } from './on-demand/run.js';
import { startWikiFieldTimer, WikiFieldCheck, wikiFieldCheckLog } from './wiki-field-check.js';
import { LINK_SWEEP_EVERY_MS, runLinkSweepOnTimer } from './link-sweep.js';
import { startWikiStatusSync } from './wiki-status.js';
import { checkDossiers, DOSSIER_CHECK_EVERY_MS } from './dossier/freshness.js';
import { recoverDossierBuilds } from './dossier/build.js';
import { leftDossierBuilds } from './db/dossier-builds.js';
import { processAlive } from './on-demand/run.js';
import { markJournalNotes } from './journal/writer.js';

function log(line: string): void {
  process.stderr.write(`[vault-curator ${new Date().toISOString()}] ${line}\n`);
}

/** Shutdown first lets running work finish on its own for this long, so a short build or a
 *  one-call page rebuild isn't cut off by a deploy (#405). */
const SHUTDOWN_GRACE_MS = 300_000;
/** Then it refuses new model calls and waits this much longer for a call already in flight
 *  before giving up. Grace plus limit stays under the example unit's TimeoutStopSec=600, so
 *  the exit is ours, not a SIGKILL. */
const SHUTDOWN_LIMIT_MS = 120_000;
/** How often shutdown logs what it is still waiting for. */
const SHUTDOWN_LOG_EVERY_MS = 30_000;

async function main(): Promise<void> {
  const bootstrap = loadBootstrapConfig();
  // validateAuthEnv throws a clear message if either is missing/invalid.
  const { ownerPassword, issuerUrl } = validateAuthEnv(bootstrap.oauthOwnerPassword, bootstrap.oauthIssuerUrl);
  const weakPassword = ownerPasswordWarning(ownerPassword);
  if (weakPassword) console.warn(`[vault-curator] ${weakPassword}`);

  const db = openCuratorDb(bootstrap.curatorDbPath);
  createAuthSchema(db);
  runMigrations(db);
  // An on-demand run left queued or running by a process that is gone, such as this server
  // before it restarted (#644). A run a live CLI owns is left alone.
  const abandonedRuns = releaseAbandonedRuns(db);
  if (abandonedRuns > 0) log(`marked ${abandonedRuns} on-demand run(s) as interrupted: their process is gone`);

  const engine = new Engine(bootstrap); // lazy — first call connects
  // One tally per process: every settings snapshot shares today's spend.
  const dailyBudget = new DailyBudget(ledgerSpend(engine), undefined, budgetChargeStore(db),
    new ProviderLimits(providerKeyReaders(bootstrap.llmKeys)));
  engine.setSpendObserver(usd => dailyBudget.charge(usd));
  const recorder = new ActionRecorder(db);
  engine.setRecorder(recorder);
  const settings = new CuratorSettingsClient(engine, process.env, log);
  await settings.seedIfNeeded();        // one-shot; throw-safe if the engine is still booting
  settings.warnStaleEnv();

  const queue = new CurationQueue();
  const lifecycle = new ServerLifecycle();
  // On-demand builds that run after their tool call replies; shutdown waits for them.
  const builds = new BackgroundBuilds((work, label) => lifecycle.keepAlive(work, label), log);
  const startedAt = new Date();

  const initial = await settings.effective();
  let runtime = buildRuntimeConfig(bootstrap, initial.settings, initial.catalog,
    { settingsDir: initial.settingsDir, vault: initial.vault });

  const reporter = new UsageReporter(engine, {
    provider: providerForModel(runtime.modelProviders),
    experiment: bootstrap.experiment,
    variant: bootstrap.variant,
    openRouterKeyRef: openRouterKeyRef(bootstrap.llmKeys),
  });
  // Fresh settings at every sweep start + on-demand tool run (spec "Consumers &
  // reload"). Each run gets an immutable deps snapshot; `runtime` tracks the
  // latest build so the scheduler re-arm and log lines read current values.
  const refreshRuntime = async (): Promise<Config> => {
    const { settings: s, catalog, settingsDir, vault } = await settings.effective();
    runtime = buildRuntimeConfig(bootstrap, s, catalog, { settingsDir, vault });
    return runtime;
  };
  // Budgets of on-demand runs that state their own limit (#644): closed with the daily one at
  // shutdown, so a run stops at its next call.
  const runBudgets = new Set<DailyBudget>();
  const freshDeps = async (): Promise<CoreDeps> => {
    await refreshRuntime();
    const provider = providerForModel(runtime.modelProviders);
    const llm = createDispatchingLlmClient(bootstrap.llmKeys, provider, { reasoningEffort: runtime.reasoningEffort });
    const policy = dailyBudgetPolicy(runtime);
    const reported = reporter.wrap(llm, provider);
    const runBudget: RunBudgetFactory = run => createRunBudget({
      llm: reported, policy, engine, limitUsd: run.limitUsd, runRef: run.runRef, budgets: runBudgets,
      ...(dailyBudget.limits ? { limits: dailyBudget.limits } : {}),
    });
    return { engine, llm: withDailyBudget(reported, dailyBudget, policy), budget: budgetGate(dailyBudget, policy),
      config: runtime, queue, db, usage: reporter, recorder, builds, runBudget, stopping: () => lifecycle.stopping };
  };

  const strictRefreshDeps = async (): Promise<CoreDeps> => {
    const { settings: s, catalog, settingsDir, vault } = await settings.effectiveStrict();
    const config = buildRuntimeConfig(bootstrap, s, catalog, { settingsDir, vault });
    const provider = providerForModel(config.modelProviders);
    const llm = createDispatchingLlmClient(bootstrap.llmKeys, provider, { reasoningEffort: config.reasoningEffort });
    const policy = dailyBudgetPolicy(config);
    return { engine, llm: withDailyBudget(reporter.wrap(llm, provider), dailyBudget, policy), budget: budgetGate(dailyBudget, policy),
      config, queue, db, usage: reporter, recorder, refreshDeps: strictRefreshDeps };
  };
  // Status/recovery do not need settings or provider availability.
  const refreshBase = { ...(await freshDeps()), refreshDeps: strictRefreshDeps };
  const recovery = startHomeRefreshRecovery(refreshBase);
  const { httpServer } = await startHttpTransport(
    curatorServerFactory(freshDeps, startedAt, async () => refreshBase, lifecycle, () => vaultOf(runtime).wikiFlagField),
    bootstrap.curatorPort,
    buildAuthConfig(db, ownerPassword, issuerUrl),
  );
  log(`MCP server on :${bootstrap.curatorPort}; daily sweep ${runtime.curatorSweepAt} ${runtime.curatorTz}`);
  const runProductionSweep = createProductionSweepRunner(freshDeps, log);
  const productionSweep = () => lifecycle.run(runProductionSweep, 'the daily sweep') ?? Promise.resolve();

  const scheduler = startScheduler({
    schedule: () => ({ hhmm: runtime.curatorSweepAt, tz: runtime.curatorTz }),
    sweep: productionSweep,
    onError: () => log('sweep failed'),
  });

  // A person asks for a project wiki with `wiki: true` (the vault map's wikiFlagField) on the
  // project note (#385): checked at startup and every 15 minutes, through the lifecycle so
  // shutdown waits for a check under way. Each check reads the settings first, so a renamed or
  // emptied field takes effect at the next check.
  const wikiFields = new WikiFieldCheck({ engine, db, coreDeps: freshDeps, vocabulary: async () => {
    const config = await refreshRuntime();
    return { projectType: projectTypeOf(config), wikiFlagField: vaultOf(config).wikiFlagField };
  } });
  const wikiFieldTimer = startWikiFieldTimer({
    check: stopped => lifecycle.run(async () => {
      for (const line of wikiFieldCheckLog(await wikiFields.run(stopped))) log(line);
    }, 'the wiki field check'),
    onError: err => log(`wiki field check failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  // The link sweep's timer schedule (#332): every 30 minutes, with fresh settings, so it runs
  // only while linkSweepEnabled is on and linkSweepSchedule is timer (the daily schedule runs in
  // the sweep). Through the lifecycle, so shutdown waits for a run under way.
  const linkSweepTimer = startWikiFieldTimer({
    everyMs: LINK_SWEEP_EVERY_MS,
    check: () => lifecycle.run(async () => { await runLinkSweepOnTimer(await freshDeps(), log); }, 'the link sweep'),
    onError: err => log(`link sweep failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  // Dossier freshness (#714): every 30 minutes, which dossiers are behind (a memory about the
  // subject, or a note it read, changed since its build), written to each page's status. In the
  // build lane, so it never reads a record a build is rewriting. Engine reads only, no model call.
  const dossierTimer = startWikiFieldTimer({
    everyMs: DOSSIER_CHECK_EVERY_MS,
    check: stopped => lifecycle.run(async () => {
      // Builds a gone process left (#722): outside the lane, since a restarted build is queued in it.
      // The first tick runs at startup; a tick that can't reach the Engine leaves them for the next.
      if (leftDossierBuilds(db, processAlive).length > 0) {
        const recovered = await recoverDossierBuilds(await freshDeps(), log);
        log(`dossier builds cut off by a restart: ${recovered.restarted} started again, ${recovered.reported} reported`);
      }
      const done = await queue.enqueue('dossier check', () => checkDossiers({ engine, db }, log, stopped));
      if (done.behind > 0) log(`dossier check: ${done.behind} of ${done.checked} behind`);
    }, 'the dossier check'),
    onError: err => log(`dossier check failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  // Wiki home status (#547): settle each registered wiki's status (a stale `building`, a status
  // missing or disagreeing with the pause table) in the build lane, ahead of the catch-up sweep.
  const wikiStatusSync = startWikiStatusSync({ engine, db, queue }, log, (work, label) => lifecycle.keepAlive(work, label));

  // Journal notes written before the suite marker existed get it (#600), so no evidence path reads
  // them. Best-effort; retried each minute while the Engine is unreachable, then done.
  let journalMarkTimer: NodeJS.Timeout | undefined;
  const markJournal = (attempt: number): void => {
    markJournalNotes(engine)
      .then(n => { if (n > 0) log(`marked ${n} Curator Journal note(s) as the suite's own`); })
      .catch(err => {
        if (attempt >= 30) { log(`journal marking gave up: ${err instanceof Error ? err.message : String(err)}`); return; }
        journalMarkTimer = setTimeout(() => markJournal(attempt + 1), 60_000);
        journalMarkTimer.unref();
      });
  };
  markJournal(1);

  // Startup catch-up: derive the last real curation from the runs table (step 7).
  void (async () => {
    try {
      const hint = lastSweepAt(db);
      if (needsCatchUp(hint, new Date(), SWEEP_INTERVAL_MS)) {
        log(`catch-up sweep (last curation ${hint?.toISOString() ?? 'never'})`);
        await productionSweep();
      } else {
        log(`no catch-up needed (last curation ${hint?.toISOString()})`);
      }
    } catch {
      log('catch-up check failed');
    }
  })();

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — shutting down`);
    const shutdownStarted = Date.now();
    const producersSettled = lifecycle.stop();
    scheduler.stop();
    wikiStatusSync.stop();
    if (journalMarkTimer) clearTimeout(journalMarkTimer);
    wikiFieldTimer.stop();
    linkSweepTimer.stop();
    dossierTimer.stop();
    recovery.stop();
    let httpOpen = true;
    const httpClosed = new Promise<void>((res) => httpServer.close(() => { httpOpen = false; res(); }));
    httpServer.closeIdleConnections(); // drop idle keep-alives so close() doesn't hang
    // Socket closure alone does not await disconnected tool handlers. Let every
    // accepted handler/sweep finish admitting work before the final queue barrier.
    const drained = (async () => {
      await producersSettled;
      await queue.enqueue('Wait for active curation', async () => {});
      await httpClosed;
    })();
    const holding = (): string => {
      const items = lifecycle.pending().map(p => `${p.label} (since ${p.since})`);
      const { current, depth } = queue.state;
      if (current) items.push(`queue: ${current}${depth > 1 ? ` and ${depth - 1} more` : ''}`);
      if (httpOpen) items.push('open HTTP connections');
      return items.length > 0 ? items.join('; ') : 'nothing tracked';
    };
    const waiting = () => log(`shutdown: still waiting after ${Math.round((Date.now() - shutdownStarted) / 1000)}s `
      + `on ${holding()}`);
    let finished = await finishWithin(drained, SHUTDOWN_GRACE_MS, SHUTDOWN_LOG_EVERY_MS, waiting);
    if (!finished) {
      // Still running: stop it at its next model call rather than let it spend on until systemd
      // kills it (#405). A refused wiki run records a skip, a sweep stage stops for the next run,
      // a requested page stays pending, and a page rebuild is resumed by recovery after the restart.
      log(`shutdown: refusing new model calls after ${SHUTDOWN_GRACE_MS / 1000}s; ${holding()} stops at its next call`);
      dailyBudget.closeAdmission();
      for (const budget of runBudgets) budget.closeAdmission();
      finished = await finishWithin(drained, SHUTDOWN_LIMIT_MS, SHUTDOWN_LOG_EVERY_MS, waiting);
    }
    if (!finished) {
      const waitingOn = holding();
      const gaveUpAfter = (SHUTDOWN_GRACE_MS + SHUTDOWN_LIMIT_MS) / 1000;
      const cut = builds.interruptAll(`interrupted: the Curator shut down before this build finished `
        + `(gave up after ${gaveUpAfter}s)`);
      log(`shutdown: gave up after ${gaveUpAfter}s; exiting with ${waitingOn} still running`
        + `${cut.length > 0 ? `; recorded as interrupted: ${cut.join(', ')}` : ''}`);
    }
    await engine.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`[vault-curator] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
