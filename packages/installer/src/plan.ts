import { createAnalyzerRunner, analyzerCommandForRepo, type AnalyzerCommand } from './analyzer.js';
import { runBackupChoice, type BackupPlan } from './backup.js';
import { askInstallCurator, chooseJournalType, runCuratorScheduleStage, type CuratorPlan } from './curator-plan.js';
import type { Host } from './host.js';
import { installerCommand, requiredNodeMajor } from './layout.js';
import { runModelsStage, type ModelsPlan } from './models.js';
import { hasFailures, runPreflight, type CheckResult } from './preflight.js';
import { showStep, type Prompter } from './prompter.js';
import {
  describeQuickBackup,
  describeQuickCurator,
  describeQuickModels,
  quickDefaults,
  runQuickKeys,
  runQuickNotes,
  SETUP_MODE_QUESTION,
} from './quick.js';
import { checkTally, SETUP_STEPS } from './tui.js';
import { hasKey, MODEL_PROVIDERS, runProvidersStage, type ProviderKey } from './providers.js';
import {
  buildPlanReport,
  renderChecks,
  renderCurator,
  renderModels,
  renderNotInThisVersion,
  renderProviders,
  renderStructure,
  renderSummary,
  renderVault,
  type PlanReport,
  type SummaryOptions,
} from './report.js';
import { buildReview, needsExtractionConsent, renderReview, type ServicePlan } from './review.js';
import { plannedManager, serviceDirFor, serviceManagerFor } from './service-manager.js';
import { plannedTypeNames, runStructureStage, type StructurePlan } from './structure.js';
import { renderVaultMap } from './vault-map.js';
import { runVaultStage, type VaultPlan } from './vault.js';

export interface PlanContext {
  /** `install` stops at the first reason it cannot go on, before asking more questions. */
  installing?: boolean;
  host: Host;
  prompter: Prompter;
  repoRoot: string;
  dataDir: string;
  cwd: string;
  checkNetwork: boolean;
  enginePort: number;
  curatorPort: number;
  analyzerCommand?: AnalyzerCommand;
  now: Date;
}

/** Everything stages 1–5 decided; the keys are the only part that holds secrets. */
export interface PlannedInstall {
  preflight: CheckResult[];
  vault: VaultPlan | null;
  structure: StructurePlan | null;
  keys: ProviderKey[];
  models: ModelsPlan;
  curator: CuratorPlan | null;
  backup: BackupPlan | null;
  report: PlanReport;
  /** Quick setup: an interactive run that asked only for the folder, one key, and approval. */
  quick?: boolean;
}

/** What `finishPlan` turns into the review and the plan report. */
export type PlanParts = Omit<PlannedInstall, 'report' | 'quick'>;

/** Why `install` cannot go on; nothing has changed when it is thrown. */
export class InstallRefusedError extends Error {
  override readonly name = 'InstallRefusedError';
}

/**
 * Stages 1–5. Read-only, apart from a new vault folder the user agrees to create: both
 * `plan` and `install` ask exactly these questions.
 */
export async function planInstall(context: PlanContext): Promise<PlannedInstall> {
  const { host, prompter, repoRoot, dataDir } = context;
  const step = (id: string) => showStep(prompter, 'Setup', SETUP_STEPS, id);
  // Quick setup (interactive only) asks for the folder, one key, and approval; the rest
  // takes its defaults, each shown before the review.
  const quick = prompter.interactive && await prompter.confirm(SETUP_MODE_QUESTION);
  const defaults = quick ? quickDefaults(prompter) : prompter;
  step('computer');
  const checking = prompter.spinner('Checking this computer…');
  const preflight = await runPreflight(host, {
    repoRoot,
    dataDir,
    requiredNodeMajor: await requiredNodeMajor(repoRoot),
    enginePort: context.enginePort,
    curatorPort: context.curatorPort,
    checkNetwork: context.checkNetwork,
  });
  checking.stop(`Computer checked: ${checkTally(preflight.map(check => check.status))}.`);
  prompter.note(renderChecks(preflight), 'This computer');
  if (context.installing) {
    if (hasFailures(preflight)) throw new InstallRefusedError('Some checks failed; fix them and run the installer again.');
    if (preflight.some(check => check.id === 'existing' && check.status !== 'pass')) {
      throw new InstallRefusedError(`An existing installation was found (see Preflight). This installer version installs fresh only; \`${installerCommand(host, 'uninstall', dataDir)}\` removes one it installed.`);
    }
  }

  let vault: VaultPlan | null = null;
  let structure: StructurePlan | null = null;
  if (preflight.some(check => check.id === 'build' && check.status === 'fail')) {
    prompter.warn('Your notes cannot be read until Vault is built. Run `npm ci && npm run build` in the Vault folder, then start again.');
  } else {
    const analyzer = createAnalyzerRunner(context.analyzerCommand ?? analyzerCommandForRepo(repoRoot));
    step('folder');
    vault = await runVaultStage({ host, prompter: defaults, analyzer, cwd: context.cwd, dataDir, repoRoot });
    if (vault.managedByEngine && context.installing) {
      throw new InstallRefusedError('Vault Engine has used this folder before. This installer version installs into new folders only.');
    }
    if (vault.managedByEngine) {
      prompter.warn('Vault has already been used on this folder, so its notes are left as they are.');
    } else {
      step('notes');
      structure = quick
        ? await runQuickNotes({ prompter, analyzer, vault }, context.installing === true)
        : await runStructureStage({ prompter, analyzer, vault });
    }
  }

  step('keys');
  const keys = quick
    ? await runQuickKeys({ host, prompter, checkKeys: context.checkNetwork })
    : await runProvidersStage({ host, prompter, checkKeys: context.checkNetwork });
  step('curator');
  const installCurator = await askInstallCurator(defaults, MODEL_PROVIDERS.some(provider => hasKey(keys, provider)));
  const curator = installCurator ? await runCuratorScheduleStage({ host, prompter: defaults }) : null;
  if (quick) prompter.info(describeQuickCurator(curator));
  // The journal kind is part of the map only when Curator, which writes the journal, is
  // installed. An interactive run settled it on the notes step's map; a headless run asks here.
  if (curator && structure && !structure.journalSettled) {
    structure = { ...structure, journalType: await chooseJournalType(prompter, plannedTypeNames(structure), structure.journalType) };
  }
  step('models');
  const models = await runModelsStage({ prompter: defaults, keys, curatorInstalled: installCurator });
  if (quick) prompter.info(describeQuickModels(models));
  if (vault) step('backup');
  const backup = vault ? await runBackupChoice({ host, prompter: defaults, vaultPath: vault.path, dataDir }) : null;
  if (quick && backup) prompter.info(describeQuickBackup(backup));
  return { ...await finishPlan(context, { preflight, vault, structure, keys, models, curator, backup }), quick };
}

/**
 * The review and the plan report from the stages' choices. Quick setup calls it again
 * after the kinds of notes are adjusted from its review.
 */
export async function finishPlan(context: PlanContext, parts: PlanParts): Promise<PlannedInstall> {
  const { host, prompter, repoRoot, dataDir } = context;
  const { preflight, vault, structure, keys, models, curator, backup } = parts;
  const manager = serviceManagerFor(host.platform);
  const services: ServicePlan = {
    repoRoot,
    user: host.username,
    nodePath: host.execPath,
    enginePort: context.enginePort,
    curatorPort: context.curatorPort,
    manager,
    serviceDir: serviceDirFor(manager, host.homeDir),
  };
  // Asked after adoption, when the attachments can be shown; a headless run decides now
  // (no unless the answers file approves), so a resumed run needs no answers.
  const extractionApproved = needsExtractionConsent(keys, models)
    ? await prompter.decide<boolean | null>({ id: 'extraction.approve', ask: async () => null, defaultValue: () => false })
    : null;
  // Offered at the end, once everything works; a headless run decides now (no unless the
  // answers file asks), so a resumed run needs no answers.
  const obsidianPlugin = vault?.obsidian && !vault.managedByEngine
    ? await prompter.decide<boolean | null>({ id: 'obsidian.install_plugin', ask: async () => null, defaultValue: () => false })
    : null;
  const review = buildReview({ dataDir, services, vault, structure, keys, models, curator, backup, extractionApproved, obsidianPlugin });
  const report = buildPlanReport({
    repoRoot, dataDir, services, preflight, vault, structure, keys, models, curator, backup, review, extractionApproved, obsidianPlugin,
    now: context.now,
  });
  return { preflight, vault, structure, keys, models, curator, backup, report };
}

/**
 * The review step. Interactively it leads with the plan in short and shows every file and
 * command only on request; a headless run prints every detail, so its log is complete.
 */
export async function showPlan(prompter: Prompter, report: PlanReport, options: SummaryOptions = { sudo: true }): Promise<void> {
  showStep(prompter, 'Setup', SETUP_STEPS, 'review');
  if (prompter.interactive) {
    prompter.note(renderSummary(report, options), 'The plan in short');
    if (!await prompter.confirm({ message: 'Show every file and command?', initialValue: false })) return;
  }
  showDetails(prompter, report);
}

function showDetails(prompter: Prompter, report: PlanReport): void {
  if (report.vault) prompter.note(renderVault(report.vault), '1 · Your notes folder');
  if (report.structure) {
    prompter.note([
      renderStructure(report.structure),
      ...(report.vault_map ? [renderVaultMap(report.vault_map)] : []),
    ].join('\n'), '2 · Kinds of notes');
  }
  prompter.note(renderProviders(report.providers), '3 · AI services');
  prompter.note(renderCurator(report.curator, report.vault?.settings_dir ?? null), '4 · Curator');
  prompter.note(renderModels(report.models), '5 · AI models');
  prompter.note(renderReview(report.review, plannedManager(report.services)), '6 · The details: every file, service, and command');
  if (report.not_in_this_version.length > 0) prompter.note(renderNotInThisVersion(report), 'Not available yet');
}
