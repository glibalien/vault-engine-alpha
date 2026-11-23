import { rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { AdoptError, runAdoptStage } from './adopt.js';
import { analyzerCommandForRepo, createAnalyzerRunner } from './analyzer.js';
import { BackupError, backupStamp, formatBytes, removeIncompleteBackup, writeBackup } from './backup.js';
import {
  ConfigureError,
  inspectConfiguration,
  prepareConfiguration,
  prepareDataDir,
  removeConfiguration,
  writeConfiguration,
} from './configure.js';
import { EngineAuthError, EngineToolError } from './engine-client.js';
import { runCuratorStage, type CuratorStageDeps } from './curator-stage.js';
import { connectAsInstaller, runEngineStage, type EngineStageDeps } from './engine-stage.js';
import { EnvFileError } from './env-file.js';
import { EXIT_BLOCKED, EXIT_OK } from './exit.js';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import { finishPlan, InstallRefusedError, planInstall, showPlan, type PlanContext, type PlannedInstall } from './plan.js';
import { showStep, type Prompter } from './prompter.js';
import { ADJUST_QUESTION, CHOOSE_EVERYTHING_HINT } from './quick.js';
import type { PlanReport } from './report.js';
import { adjustStructure } from './structure.js';
import { INSTALL_STEPS, progressBar, SETUP_STEPS, terminalStyle, type Step } from './tui.js';
import { ServiceError, ServicePausedError, type ServiceBackend } from './services.js';
import { runSettingsStage, SettingsError } from './settings-stage.js';
import { runHandoffStage } from './handoff.js';
import { runVerifyStage } from './verify.js';
import { loadState, saveState, StateError, statePath, type InstallState } from './state.js';
import { count } from './text.js';
import { TokenError } from './tokens.js';
import { UnitError } from './units.js';

/** Errors that stop an install with a message instead of a stack trace. */
export function isInstallError(error: unknown): error is Error {
  return [
    ConfigureError, BackupError, StateError, EnvFileError, UnitError, ServiceError, TokenError, EngineToolError, EngineAuthError,
    AdoptError, SettingsError,
  ].some(type => error instanceof type);
}

export interface InstallContext extends PlanContext {
  yes: boolean;
  /** Root commands run through sudo (the default); false with `--no-sudo`, which prints them. */
  sudo?: boolean;
  /** Runs the services; systemd unless a test supplies another. */
  backend: ServiceBackend;
  connect?: EngineStageDeps['connect'];
  connectCurator?: CuratorStageDeps['connectCurator'];
}

/**
 * `vault-installer install`: plan, get one approval, then apply the stages this version
 * has (configure, backup, Engine, and adoption). A rerun reads `installer/state.json` and continues
 * from the first unfinished stage without asking the planning questions again.
 */
export async function runInstall(context: InstallContext): Promise<number> {
  const { prompter } = context;
  const path = statePath(context.dataDir);
  const saved = await loadState(path);
  if (saved && await configurationWritten(context, saved, path)) return continueInstall(context, saved, path);

  prompter.intro('Vault Installer');
  if (prompter.interactive) prompter.welcome('install');
  let planned;
  try {
    planned = await planInstall({ ...context, installing: true });
  } catch (error) {
    if (!(error instanceof InstallRefusedError)) throw error;
    prompter.outro(`${error.message} Nothing was changed.`);
    return EXIT_BLOCKED;
  }
  // The plan in short, every file and command on request, then the approval.
  await showPlan(prompter, planned.report, { sudo: context.sudo ?? true });
  if (planned.vault === null) {
    prompter.outro('The vault could not be inspected. Nothing was changed.');
    return EXIT_BLOCKED;
  }

  let approved = prompter.interactive ? await prompter.confirm(APPROVAL_QUESTION) : context.yes;
  // Quick setup can go back to the kinds of notes from here.
  if (!approved && planned.quick) ({ approved, planned } = await reconsiderQuickPlan(context, planned));
  if (!approved) {
    prompter.outro(prompter.interactive
      ? 'Nothing was changed.'
      : 'Nothing was changed. Run again with --yes to install with this plan.');
    return EXIT_OK;
  }

  // Rendering first means a value no env file or unit can hold stops before any write.
  const files = prepareConfiguration({ plan: planned.report, keys: planned.keys });
  await prepareDataDir(context.dataDir, files);
  // Record every file before writing the first, so a rerun after an interruption can
  // recognize them; configure is complete only once all are written.
  const state: InstallState = {
    format: 'vault-installer-state',
    version: 1,
    approved_at: context.now.toISOString(),
    plan: planned.report,
    stages: { configure: { completed_at: null, files: Object.fromEntries(files.map(file => [file.path, file.sha256])) } },
  };
  await saveState(path, state);
  installStep(prompter, state, 'configure');
  const configuring = prompter.spinner('Writing the configuration…');
  try {
    await writeConfiguration(context.dataDir, files);
  } catch (error) {
    configuring.stop('Stopped.');
    // writeConfiguration removed what it wrote; with the record gone too, a rerun starts over.
    await rm(path, { force: true });
    throw error;
  }
  configuring.stop(`Wrote ${count(files.length, 'file')} to ${context.dataDir}.`);
  state.stages.configure = { ...state.stages.configure!, completed_at: context.now.toISOString() };
  await saveState(path, state);
  return runRemainingStages(context, state, path);
}

/**
 * Whether the saved install's configuration was fully written. A run that stopped while
 * writing it left a record of every file: when all are in place, configure is complete;
 * otherwise the files it wrote are removed with the record, and the install starts over
 * (the keys for the missing files were never saved).
 */
async function configurationWritten(context: PlanContext, state: InstallState, path: string): Promise<boolean> {
  const configure = state.stages.configure;
  if (!configure || configure.completed_at !== null) return true;
  const { matching, missing, changed } = await inspectConfiguration(configure.files);
  if (changed.length > 0) {
    throw new ConfigureError(`${changed.join(', ')} changed after the installer began writing it. Move ${changed.length === 1 ? 'it' : 'them'} away and run the installer again.`);
  }
  if (missing.length === 0) {
    state.stages.configure = { ...configure, completed_at: context.now.toISOString() };
    await saveState(path, state);
    return true;
  }
  await removeConfiguration(context.dataDir, matching);
  await rm(path, { force: true });
  context.prompter.warn('The last run stopped while writing the configuration. What it wrote was removed; planning again.');
  return false;
}

async function continueInstall(context: InstallContext, state: InstallState, path: string): Promise<number> {
  const { prompter } = context;
  prompter.intro('Vault Installer · picking up where you left off');
  const done = INSTALL_STEPS.filter(step => stageDone(state, step.id));
  prompter.note([
    `Notes folder: ${state.plan.vault?.path}`,
    `Plan approved: ${state.approved_at}`,
    `Progress: ${progressBar(done.length, INSTALL_STEPS.length, terminalStyle())}`,
    ...INSTALL_STEPS.map(step => checklistLine(state, step)),
    '',
    `Saved progress: ${path}`,
  ].join('\n'), 'An install is already under way');
  if (state.stages.handoff?.completed_at) return finish(context, state);
  const resume = prompter.interactive
    ? await prompter.confirm({ message: 'Continue from where it stopped?', initialValue: true })
    : context.yes;
  if (!resume) {
    prompter.outro(prompter.interactive ? 'Nothing was changed.' : 'Nothing was changed. Run again with --yes to continue.');
    return EXIT_OK;
  }
  return runRemainingStages(context, state, path);
}

async function runRemainingStages(context: InstallContext, state: InstallState, path: string): Promise<number> {
  const step = (id: string) => installStep(context.prompter, state, id);
  step('backup');
  await runBackupStage(context, state, path);
  const engine = () => connectAsInstaller(context, state.plan);
  const analyzer = createAnalyzerRunner(context.analyzerCommand ?? analyzerCommandForRepo(state.plan.repo_root));
  try {
    step('engine');
    await runEngineStage({ ...context, now: () => context.now }, state, path);
    step('adopt');
    await runAdoptStage({ ...context, analyzer, engine, now: () => context.now }, state, path);
    step('settings');
    await runSettingsStage({ ...context, engine, now: () => context.now }, state, path);
    if (state.plan.curator) step('curator');
    await runCuratorStage({ ...context, now: () => context.now }, state, path);
  } catch (error) {
    // Restarting Engine for extraction may also need root commands run by hand.
    if (!(error instanceof ServicePausedError)) throw error;
    context.prompter.outro(`${error.message} Then run \`${installerCommand(context.host, 'install', state.plan.data_dir)}\` again.`);
    return EXIT_BLOCKED;
  }
  step('verify');
  if (!await runVerifyStage({ ...context, analyzer, engine, now: () => context.now }, state, path)) {
    context.prompter.outro(`Some checks found problems (marked ✗ above). Fix them and run \`${installerCommand(context.host, 'install', state.plan.data_dir)}\` again: it picks up where it stopped and checks again.`);
    return EXIT_BLOCKED;
  }
  step('handoff');
  await runHandoffStage({ ...context, now: () => context.now }, state, path);
  return finish(context, state);
}

/** Show install step `id` unless a previous run already finished it. */
function installStep(prompter: Prompter, state: InstallState, id: string): void {
  if (!stageDone(state, id)) showStep(prompter, 'Install', INSTALL_STEPS, id);
}

/** One line of the resume checklist; Curator left out of the plan is shown as skipped, not done. */
export function checklistLine(state: Pick<InstallState, 'plan' | 'stages'>, step: Step): string {
  if (step.id === 'curator' && !state.plan.curator) return `- ${step.title} (skipped: not installed, as you chose)`;
  return `${stageDone(state, step.id) ? '✓' : '-'} ${step.title}`;
}

function stageDone(state: Pick<InstallState, 'plan' | 'stages'>, id: string): boolean {
  if (id === 'curator' && !state.plan.curator) return Boolean(state.stages.settings?.completed_at);
  const stage = (state.stages as Record<string, { completed_at?: string | null } | undefined>)[id];
  return Boolean(stage?.completed_at);
}

/** Every stage this version has is done. */
function finish({ host, prompter }: { host: Host; prompter: Prompter }, state: InstallState): number {
  const backup = state.stages.backup?.directory ? `Backup of your notes: ${state.stages.backup.directory}` : 'Backup: skipped, as you chose.';
  prompter.success([
    `✓ Vault Engine is running    http://localhost:${state.plan.services.engine_port}/mcp`,
    ...(state.plan.curator ? [`✓ Vault Curator is running   http://localhost:${state.plan.services.curator_port}/mcp`] : []),
    '✓ Your notes are organized and your settings are saved',
    '✓ Everything was checked and works',
    '',
    backup,
  ].join('\n'), 'Vault is ready');
  prompter.outro(`The installation is complete and verified. Run \`${installerCommand(host, 'status', state.plan.data_dir)}\` any time to check on it.`);
  return EXIT_OK;
}

/** Stage 7. Copies the vault before anything in it changes; a rerun replaces an unfinished copy. */
async function runBackupStage(context: { host: Host; prompter: Prompter; now: Date }, state: InstallState, path: string): Promise<void> {
  const { host, prompter, now } = context;
  const recorded = state.stages.backup;
  if (recorded?.completed_at) return;
  const plan = state.plan;
  const vault = plan.vault;
  const backup = plan.backup;
  if (!vault || !backup) throw new StateError('the saved plan has no vault to back up');

  if (backup.mode === 'skip') {
    state.stages.backup = { started_at: now.toISOString(), directory: null, completed_at: now.toISOString(), files: 0, bytes: 0 };
    await saveState(path, state);
    prompter.warn('No backup was taken, as you chose.');
    return;
  }

  const backups = join(plan.data_dir, 'installer', 'backups');
  if (recorded?.directory) {
    // Only ever a folder this installer created under its own backups folder.
    const inside = relative(backups, recorded.directory);
    if (inside === '' || inside.startsWith('..') || inside.includes(sep)) {
      throw new StateError(`the saved state names an unexpected backup folder: ${recorded.directory}`);
    }
    await removeIncompleteBackup(recorded.directory);
  }
  const directory = join(backups, backupStamp(now));
  state.stages.backup = { started_at: now.toISOString(), directory, completed_at: null, files: 0, bytes: 0 };
  await saveState(path, state);

  const spinner = prompter.spinner(`Backing up ${vault.path}…`);
  let result;
  try {
    result = await writeBackup({
      vaultPath: vault.path,
      dataDir: plan.data_dir,
      directory,
      mode: backup.mode,
      now,
      freeBytes: target => host.freeDiskBytes(target),
    });
  } catch (error) {
    spinner.stop('Stopped.');
    throw error;
  }
  spinner.stop(`Backed up ${count(result.files, 'file')} (${formatBytes(result.bytes)}) to ${directory}.`);
  state.stages.backup = { ...state.stages.backup, completed_at: now.toISOString(), files: result.files, bytes: result.bytes };
  await saveState(path, state);
}

const APPROVAL_QUESTION = { message: 'Ready? Install Vault with this plan?', initialValue: false } as const;

/**
 * Quick setup's review, after the user declines to install: offer to adjust the kinds of
 * notes (the notes step's questions, then its map), then show the plan again and ask
 * again. Choosing every other answer means running the installer again: the keys are
 * never saved, so nothing would carry over.
 */
async function reconsiderQuickPlan(context: InstallContext, planned: PlannedInstall): Promise<{ approved: boolean; planned: PlannedInstall }> {
  const { prompter } = context;
  // Awaited through an async wrapper, so the review may ask questions of its own.
  const show = async (report: PlanReport) => showPlan(prompter, report, { sudo: context.sudo ?? true });
  let current = planned;
  while (current.vault && current.structure && await prompter.confirm(ADJUST_QUESTION)) {
    showStep(prompter, 'Setup', SETUP_STEPS, 'notes');
    const analyzer = createAnalyzerRunner(context.analyzerCommand ?? analyzerCommandForRepo(context.repoRoot));
    const structure = await adjustStructure({ prompter, analyzer, vault: current.vault });
    current = { ...await finishPlan(context, { ...current, structure }), quick: true };
    await show(current.report);
    if (await prompter.confirm(APPROVAL_QUESTION)) return { approved: true, planned: current };
  }
  prompter.info(CHOOSE_EVERYTHING_HINT);
  return { approved: false, planned: current };
}
