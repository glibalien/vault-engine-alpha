import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import type { Prompter } from './prompter.js';
import { shellCommand } from './text.js';
import { UNIT_DIR } from './units.js';

export class ServiceError extends Error {
  override readonly name = 'ServiceError';
}

/** The user has root commands to run before the install can go on (`--no-sudo`). */
export class ServicePausedError extends Error {
  override readonly name = 'ServicePausedError';
}

export interface ServiceHealth {
  /** The service is not running and will not start again by itself. */
  stopped: boolean;
  /** Automatic restarts so far; a rise while waiting means it crashed. */
  restarts: number;
  detail: string;
}

/** How the installer runs a service; systemd in production, child processes in tests. */
export interface ServiceBackend {
  /** Install the staged unit if needed and make sure the service is running. */
  start(unit: string): Promise<void>;
  restart(unit: string): Promise<void>;
  health(unit: string): Promise<ServiceHealth>;
  /** When the running service started, or null when it is not running. */
  startedAt(unit: string): Promise<Date | null>;
  /**
   * The service's most recent log lines (30 unless `lines` says), for a failure message or
   * startup progress; with `since`, only lines logged from then on.
   */
  recentLogs(unit: string, options?: { since?: Date; lines?: number }): Promise<string>;
  /** How the user reads the service's log. */
  logCommand(unit: string): string;
}

/**
 * Runs the services as systemd system units. Each root command is shown before it runs
 * through sudo; with `sudo: false` they are printed for the user to run. A unit that is
 * already installed, enabled, and running with the staged content is left alone, so a
 * rerun asks for no password.
 */
export function createSystemdBackend(input: {
  host: Host;
  prompter: Prompter;
  stagingDir: string;
  sudo: boolean;
}): ServiceBackend {
  const { host, prompter } = input;
  const runAsRoot = (commands: string[][], purpose: string) => runRootCommands({ ...input, command: 'install' }, commands, purpose);

  async function systemctl(args: string[]): Promise<string> {
    return (await host.run('systemctl', args)).stdout.trim();
  }

  return {
    async start(unit) {
      const staged = join(input.stagingDir, unit);
      const target = join(UNIT_DIR, unit);
      const content = await host.readText(staged);
      if (content === null) throw new ServiceError(`${staged} is missing; it is written when the install is configured.`);
      const installed = await host.readText(target);
      if (installed !== null && installed !== content) {
        prompter.warn(`${target} differs from the unit the installer staged at ${staged}.`);
        const replace = prompter.interactive
          && await prompter.confirm({ message: `Replace ${target} with the staged unit?`, initialValue: false });
        if (!replace) throw new ServiceError(`${target} was changed after the installer wrote it. Restore it from ${staged}, or move it away, and run the install again.`);
      }
      const commands: string[][] = [];
      if (installed !== content) {
        commands.push(['install', '-m', '0644', staged, target], ['systemctl', 'daemon-reload']);
      }
      const enabled = await systemctl(['is-enabled', unit]) === 'enabled';
      const active = await systemctl(['is-active', unit]) === 'active';
      if (!active) {
        commands.push(['systemctl', 'enable', '--now', unit]);
      } else {
        // `enable --now` does not restart a running service, so a replaced unit needs both.
        if (!enabled) commands.push(['systemctl', 'enable', unit]);
        if (installed !== content) commands.push(['systemctl', 'restart', unit]);
      }
      await runAsRoot(commands, `install and start ${unit}`);
    },
    async restart(unit) {
      await runAsRoot([['systemctl', 'restart', unit]], `restart ${unit}`);
    },
    async health(unit) {
      const output = await systemctl(['show', unit, '--property=ActiveState', '--property=SubState', '--property=NRestarts']);
      const values = Object.fromEntries(output.split('\n').map(line => line.split('=', 2) as [string, string]));
      const restarts = Number(values['NRestarts'] ?? 0) || 0;
      const state = `${values['ActiveState'] ?? 'unknown'} (${values['SubState'] ?? 'unknown'})`;
      return {
        stopped: values['ActiveState'] === 'failed' || values['ActiveState'] === 'inactive',
        restarts,
        detail: restarts > 0 ? `${state}, restarted ${restarts} time${restarts === 1 ? '' : 's'}` : state,
      };
    },
    async startedAt(unit) {
      const value = (await systemctl(['show', unit, '--property=ActiveEnterTimestamp', '--timestamp=unix'])).split('=', 2)[1] ?? '';
      const seconds = /^@(\d+)$/.exec(value)?.[1];
      return seconds === undefined ? null : new Date(Number(seconds) * 1000);
    },
    async recentLogs(unit, options = {}) {
      const since = options.since ? ['--since', `@${Math.floor(options.since.getTime() / 1000)}`] : [];
      const result = await host.run('journalctl', ['--unit', unit, ...since, '--lines', String(options.lines ?? 30), '--no-pager', '--output', 'cat']);
      return result.code === 0 ? result.stdout.trim() : '';
    },
    logCommand: unit => `sudo journalctl --unit ${unit} --lines 100`,
  };
}

/**
 * Run root commands through sudo, showing each before it runs. With `sudo: false` they are
 * printed for the user to run: an interactive run goes on once the user says they ran them,
 * a headless one stops so `vault-installer <command>` can be run again afterwards.
 */
export async function runRootCommands(
  input: { host: Host; prompter: Prompter; sudo: boolean; command: 'install' | 'uninstall'; dataDir?: string },
  commands: string[][],
  purpose: string,
): Promise<void> {
  const { host, prompter } = input;
  if (commands.length === 0) return;
  const shown = commands.map(command => shellCommand(['sudo', ...command]));
  const again = input.command === 'install' ? 'the install again' : `\`${installerCommand(host, input.command, input.dataDir)}\` again`;
  if (!input.sudo) {
    prompter.note(shown.join('\n'), `Run these as root to ${purpose}`);
    if (!prompter.interactive || !await prompter.confirm({ message: 'Have you run them?', initialValue: true })) {
      // The install names the command that continues it (install.ts); uninstall's is named here.
      throw new ServicePausedError(input.command === 'install'
        ? `Run the commands above to ${purpose}.`
        : `Run the commands above to ${purpose}, then run ${again}.`);
    }
    return;
  }
  for (const [index, command] of commands.entries()) {
    prompter.info(`Running: ${shown[index]}`);
    // Without a terminal, sudo must not wait for a password nobody can type.
    const code = await host.runAttached('sudo', prompter.interactive ? command : ['-n', ...command]);
    if (code !== 0) {
      throw new ServiceError(code === null
        ? `sudo could not be started. Run ${again} with --no-sudo to run the root commands yourself.`
        : `${shown[index]} failed (exit ${code}). Run ${again} with --no-sudo to run the root commands yourself.`);
    }
  }
}

/** Root commands that stop and disable installed units, remove their files, and reload systemd. */
export function unitRemovalCommands(units: readonly string[]): string[][] {
  if (units.length === 0) return [];
  return [
    ['systemctl', 'disable', '--now', ...units],
    ['rm', ...units.map(unit => join(UNIT_DIR, unit))],
    ['systemctl', 'daemon-reload'],
  ];
}

/**
 * Runs each service as a child of the installer, for tests and headless validation; it is
 * never offered for production. The children stop when `stopAll` is called.
 */
export function createProcessBackend(input: {
  command: (unit: string) => { executable: string; args: string[]; cwd: string };
  env: (unit: string) => Promise<Record<string, string>>;
}): ServiceBackend & { stopAll(): Promise<void> } {
  const children = new Map<string, { child: ChildProcess; log: string[]; startedAt: Date }>();

  async function start(unit: string): Promise<void> {
    const running = children.get(unit);
    if (running && running.child.exitCode === null && running.child.signalCode === null) return;
    const { executable, args, cwd } = input.command(unit);
    const child = spawn(executable, args, { cwd, env: await input.env(unit), stdio: ['ignore', 'pipe', 'pipe'] });
    const log: string[] = [];
    const collect = (chunk: Buffer) => {
      log.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      log.splice(0, Math.max(0, log.length - 200));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    children.set(unit, { child, log, startedAt: new Date() });
  }

  async function stop(unit: string): Promise<void> {
    const running = children.get(unit);
    if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
    const exited = new Promise(resolve => running.child.once('exit', resolve));
    running.child.kill('SIGTERM');
    const timer = setTimeout(() => running.child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  }

  return {
    start,
    async restart(unit) {
      await stop(unit);
      await start(unit);
    },
    async health(unit) {
      const running = children.get(unit);
      if (!running) return { stopped: true, restarts: 0, detail: 'not started' };
      const { exitCode, signalCode } = running.child;
      return exitCode === null && signalCode === null
        ? { stopped: false, restarts: 0, detail: 'running' }
        : { stopped: true, restarts: 0, detail: `exited (${signalCode ?? `code ${exitCode}`})` };
    },
    async startedAt(unit) {
      const running = children.get(unit);
      return running && running.child.exitCode === null && running.child.signalCode === null ? running.startedAt : null;
    },
    // Each start collects a new log, so it holds only lines since the child started.
    async recentLogs(unit, options = {}) {
      return (children.get(unit)?.log ?? []).slice(-(options.lines ?? 30)).join('\n');
    },
    logCommand: unit => `the ${unit} child process's output`,
    async stopAll() {
      await Promise.all([...children.keys()].map(stop));
    },
  };
}
