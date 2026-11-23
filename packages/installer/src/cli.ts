#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AnalyzerError, analyzerCommandForRepo, createAnalyzerRunner, type AnalyzerCommand } from './analyzer.js';
import { AnswersError, loadAnswers } from './answers.js';
import { parseArgs, USAGE, UsageError, type InstallArgs, type PlanArgs, type UndoArgs, type UninstallArgs } from './args.js';
import { EXIT_BLOCKED, EXIT_CANCELLED, EXIT_OK, EXIT_USAGE } from './exit.js';
import { createSystemHost, type Host } from './host.js';
import { isInstallError, runInstall } from './install.js';
import { CURATOR_PORT, defaultDataDir, ENGINE_PORT, INSTALLER_COMMAND_VAR, INSTALLER_CWD_VAR, installerCommand, repoRootFromModule, resolveUserPath } from './layout.js';
import { planInstall, showPlan, type PlanContext } from './plan.js';
import { hasFailures } from './preflight.js';
import { CancelledError, createClackPrompter, createProgressPrompter, createScriptedPrompter, type Prompter } from './prompter.js';
import type { EngineCall } from './engine-client.js';
import type { Secret } from './secret.js';
import { createLaunchdBackend } from './launchd.js';
import { serviceManagerFor } from './service-manager.js';
import { createSystemdBackend, type ServiceBackend } from './services.js';
import { connectAsInstaller } from './engine-stage.js';
import { revokeInstallerTokens } from './handoff.js';
import { renderChecks } from './report.js';
import { loadState, statePath } from './state.js';
import { untypedSummary } from './survey-summary.js';
import { shellCommand } from './text.js';
import { runUndo } from './undo.js';
import { runUninstall } from './uninstall.js';
import { verifyInstall } from './verify.js';

export { EXIT_BLOCKED, EXIT_CANCELLED, EXIT_OK, EXIT_USAGE };

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  isInteractive: boolean;
}

/** Test seams; production uses the real machine and the checkout this module lives in. */
export interface CliDeps {
  host: Host;
  cwd: string;
  repoRoot: string;
  analyzerCommand?: AnalyzerCommand;
  /** `resumeCommand` continues an approved install; the prompter names it on Ctrl+C. */
  createInteractivePrompter: (resumeCommand: string) => Prompter;
  now: () => Date;
  /** How `install` runs the services; systemd on Linux and launchd on macOS by default. */
  serviceBackend?: (input: { host: Host; prompter: Prompter; stagingDir: string; dataDir: string; sudo: boolean }) => ServiceBackend;
  /** How `install` calls Engine's tools; MCP over HTTP by default. */
  connectEngine?: (url: string, token: Secret) => EngineCall;
  /** Test seam for Curator's MCP endpoint. */
  connectCurator?: (url: string, token: Secret) => EngineCall;
}

export async function runCli(argv: string[], io: CliIo, deps: CliDeps): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`vault-installer: ${error.message}\n\n${usage(deps.host)}\n`);
    return EXIT_USAGE;
  }
  if (args.command === 'help') {
    io.stdout(`${usage(deps.host)}\n`);
    return EXIT_OK;
  }
  if (args.command === 'version') {
    io.stdout(`${await installerVersion()}\n`);
    return EXIT_OK;
  }

  try {
    if (args.command === 'status') return await runStatus(args.dataDir, io, deps);
    if (args.command === 'undo' || args.command === 'uninstall') return await runRemoval(args, io, deps);
    const context = await planContext(args, io, deps);
    if (context === null) return EXIT_USAGE;
    if (args.command === 'plan') return await runPlan(args, io, context);
    const { host, prompter, dataDir } = context;
    const createBackend = deps.serviceBackend
      ?? (serviceManagerFor(host.platform) === 'launchd' ? createLaunchdBackend : createSystemdBackend);
    const backend = createBackend({
      host,
      prompter,
      stagingDir: join(dataDir, 'installer', 'units'),
      dataDir,
      sudo: args.sudo,
    });
    return await runInstall({
      ...context,
      yes: args.yes,
      sudo: args.sudo,
      backend,
      ...(deps.connectEngine ? { connect: deps.connectEngine } : {}),
      ...(deps.connectCurator ? { connectCurator: deps.connectCurator } : {}),
    });
  } catch (error) {
    if (error instanceof CancelledError) return EXIT_CANCELLED;
    if (error instanceof AnswersError) {
      io.stderr(`vault-installer: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof AnalyzerError || isInstallError(error)) {
      io.stderr(`vault-installer: ${error.message}\n`);
      return EXIT_BLOCKED;
    }
    throw error;
  }
}

/**
 * `vault-installer status`: the verification checks against a saved install, without
 * changing it. Exit 0 when nothing failed.
 */
async function runStatus(dataDirArg: string | undefined, io: CliIo, deps: CliDeps): Promise<number> {
  const { host } = deps;
  const dataDir = dataDirArg ? resolveUserPath(dataDirArg, host.homeDir, deps.cwd) : defaultDataDir(host.homeDir);
  const state = await loadState(statePath(dataDir));
  if (state === null) {
    io.stderr(`vault-installer: no installation in ${dataDir} (no installer/state.json). Pass --data-dir if it is elsewhere.\n`);
    return EXIT_BLOCKED;
  }
  let engine: Promise<EngineCall> | undefined;
  const engineCall = () => (engine ??= connectAsInstaller({ host, ...(deps.connectEngine ? { connect: deps.connectEngine } : {}) }, state.plan));
  const checks = await verifyInstall({
    host,
    analyzer: createAnalyzerRunner(deps.analyzerCommand ?? analyzerCommandForRepo(state.plan.repo_root)),
    engine: engineCall,
    ...(deps.connectCurator ? { connectCurator: deps.connectCurator } : {}),
  }, state.plan);
  io.stdout(`${renderChecks(checks)}\n`);
  // What the notes with no kind have in common (#650), when Engine answered the checks.
  if (checks.find(entry => entry.id === 'engine')?.status === 'pass') {
    const summary = await untypedSummary(await engineCall());
    if (summary.length > 0) io.stdout(`\n${summary.join('\n')}\n`);
  }
  // A finished install keeps no installer token. Before Engine's first start the token
  // scripts would create its database, so an unfinished install keeps its own.
  if (state.stages.handoff?.completed_at) await revokeInstallerTokens(host, state.plan);
  return checks.some(entry => entry.status === 'fail') ? EXIT_BLOCKED : EXIT_OK;
}

/**
 * `vault-installer undo` and `uninstall`, against the installation recorded in the data
 * directory. Without a terminal they need --yes to change anything.
 */
async function runRemoval(args: UndoArgs | UninstallArgs, io: CliIo, deps: CliDeps): Promise<number> {
  const { host } = deps;
  const dataDir = args.dataDir ? resolveUserPath(args.dataDir, host.homeDir, deps.cwd) : defaultDataDir(host.homeDir);
  const path = statePath(dataDir);
  const state = await loadState(path);
  if (state === null) {
    io.stderr(`vault-installer: no installation in ${dataDir} (no installer/state.json). Pass --data-dir if it is elsewhere.\n`);
    return EXIT_BLOCKED;
  }
  const prompter = io.isInteractive ? deps.createInteractivePrompter(installerCommand(host, 'install', dataDir)) : createProgressPrompter(line => io.stdout(`${line}\n`));
  const now = deps.now();
  if (args.command === 'undo') {
    return runUndo({ host, prompter, yes: args.yes, now, ...(deps.connectEngine ? { connect: deps.connectEngine } : {}) }, state, path);
  }
  return runUninstall({ host, prompter, yes: args.yes, sudo: args.sudo, now }, state, dataDir);
}

/** Where to work and how to ask; null (after a message) when there is no way to ask. */
async function planContext(args: PlanArgs | InstallArgs, io: CliIo, deps: CliDeps): Promise<PlanContext | null> {
  const { host } = deps;
  const repoRoot = args.repo ? resolveUserPath(args.repo, host.homeDir, deps.cwd) : deps.repoRoot;
  const dataDir = args.dataDir ? resolveUserPath(args.dataDir, host.homeDir, deps.cwd) : defaultDataDir(host.homeDir);

  // With --json, stdout carries only the plan; progress goes to stderr.
  const json = args.command === 'plan' && args.json;
  const write = json ? (line: string) => io.stderr(`${line}\n`) : (line: string) => io.stdout(`${line}\n`);
  const answersPath = args.answers !== undefined ? resolveUserPath(args.answers, host.homeDir, deps.cwd) : undefined;
  // A saved install continues from its approved plan without planning questions, so it
  // needs neither a terminal nor the answers file it was planned with.
  const resuming = args.command === 'install' && await host.pathExists(statePath(dataDir));

  let prompter: Prompter;
  if (answersPath !== undefined && (!resuming || await host.pathExists(answersPath))) {
    prompter = createScriptedPrompter(await loadAnswers(answersPath), write);
  } else if (answersPath === undefined && io.isInteractive) {
    prompter = deps.createInteractivePrompter(installerCommand(host, 'install', dataDir));
  } else if (resuming) {
    prompter = createProgressPrompter(write);
  } else {
    io.stderr('vault-installer: no terminal to ask questions in; pass --answers <file>.\n');
    return null;
  }
  return {
    host,
    prompter,
    repoRoot,
    dataDir,
    cwd: deps.cwd,
    checkNetwork: args.checkNetwork,
    enginePort: args.enginePort ?? ENGINE_PORT,
    curatorPort: args.curatorPort ?? CURATOR_PORT,
    ...(deps.analyzerCommand ? { analyzerCommand: deps.analyzerCommand } : {}),
    now: deps.now(),
  };
}

async function runPlan(args: PlanArgs, io: CliIo, context: PlanContext): Promise<number> {
  const { host, prompter } = context;
  prompter.intro('Vault Installer · practice run');
  if (prompter.interactive) prompter.welcome('plan');
  const { preflight, report } = await planInstall(context);
  await showPlan(prompter, report);
  if (args.out !== undefined) {
    const outPath = resolveUserPath(args.out, host.homeDir, context.cwd);
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    prompter.info(`Plan written to ${outPath}`);
  }
  if (args.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);

  const blocked = hasFailures(preflight);
  prompter.outro(blocked
    ? 'Some checks did not pass (marked ✗ above), so installing here would not work yet. Fix them and run this again.'
    : `All done. Nothing on this computer was changed. When you are ready, run \`${installerCommand(host, 'install', context.dataDir)}\`.`);
  return blocked ? EXIT_BLOCKED : EXIT_OK;
}

/** The usage text, naming install.sh when it started the installer: `vault-installer` is not on PATH. */
function usage(host: Pick<Host, 'env'>): string {
  const script = host.env(INSTALLER_COMMAND_VAR);
  return script ? USAGE.replace(/^Usage: vault-installer /, `Usage: ${shellCommand([script])} `) : USAGE;
}

async function installerVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function isEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(
    process.argv.slice(2),
    {
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
      isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    },
    {
      host: createSystemHost(),
      // install.sh runs this from the checkout and names the folder the user ran it from.
      cwd: process.env[INSTALLER_CWD_VAR] || process.cwd(),
      repoRoot: repoRootFromModule(import.meta.url),
      createInteractivePrompter: createClackPrompter,
      now: () => new Date(),
    },
  );
}
