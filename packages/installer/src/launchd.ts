import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Host } from './host.js';
import type { Prompter } from './prompter.js';
import { launchdLabel, serviceDirFor, serviceFileName } from './service-manager.js';
import { ServiceError, type ServiceBackend } from './services.js';
import { shellCommand } from './text.js';
import { curatorCommand, engineCommand, UnitError, type ServiceSpec } from './units.js';

/** Where a launchd agent writes its output; launchd has no journal. */
export function serviceLogPath(dataDir: string, unit: string): string {
  return join(dataDir, 'logs', `${launchdLabel(unit)}.log`);
}

/**
 * Engine as a launchd agent in `~/Library/LaunchAgents`: it starts when the user logs in
 * and runs as them, so nothing needs root. launchd reads no env file, so Node loads
 * engine.env itself (`--env-file`). Both services start in the data directory, as their
 * systemd units do, and run on the Node binary the checkout was built with.
 */
export function renderEnginePlist(spec: ServiceSpec): string {
  const [node, ...args] = engineCommand(spec);
  return renderPlist({
    spec,
    args: [node as string, `--env-file=${join(spec.dataDir, 'engine.env')}`, ...args],
    // As systemd's RestartSec=10; its default stop timeout is 90 seconds.
    throttleSeconds: 10,
    exitTimeoutSeconds: 90,
  });
}

export function renderCuratorPlist(spec: ServiceSpec): string {
  const [node, ...args] = curatorCommand(spec);
  return renderPlist({
    spec,
    args: [node as string, `--env-file=${join(spec.dataDir, 'curator.env')}`, ...args],
    throttleSeconds: 5,
    exitTimeoutSeconds: 15,
  });
}

/**
 * KeepAlive restarts a service that exits with an error, as systemd's Restart=on-failure
 * does; one that exits cleanly (it was told to stop) stays stopped. Umask 0077 (63) keeps
 * what the services write private, as the units' UMask=0077 does. The units' other
 * hardening (NoNewPrivileges, PrivateTmp, ProtectSystem) has no launchd equivalent.
 */
function renderPlist(input: { spec: ServiceSpec; args: string[]; throttleSeconds: number; exitTimeoutSeconds: number }): string {
  const { spec } = input;
  const log = serviceLogPath(spec.dataDir, spec.unit);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by vault-installer. -->',
    '<plist version="1.0">',
    '<dict>',
    ...entry('Label', string(launchdLabel(spec.unit))),
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...input.args.map(argument => `\t\t${string(argument)}`),
    '\t</array>',
    ...entry('WorkingDirectory', string(spec.dataDir)),
    ...entry('RunAtLoad', '<true/>'),
    '\t<key>KeepAlive</key>',
    '\t<dict>',
    '\t\t<key>SuccessfulExit</key>',
    '\t\t<false/>',
    '\t</dict>',
    ...entry('ThrottleInterval', `<integer>${input.throttleSeconds}</integer>`),
    ...entry('ExitTimeOut', `<integer>${input.exitTimeoutSeconds}</integer>`),
    ...entry('Umask', '<integer>63</integer>'),
    ...entry('StandardOutPath', string(log)),
    ...entry('StandardErrorPath', string(log)),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function entry(key: string, value: string): string[] {
  return [`\t<key>${key}</key>`, `\t${value}`];
}

function string(value: string): string {
  // XML 1.0 cannot hold most control characters, even escaped.
  if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new UnitError(`a launchd agent cannot hold ${JSON.stringify(value)}`);
  return `<string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`;
}

/** What `launchctl print` says of a loaded service. */
export interface LaunchdJob {
  state: string;
  pid: number | null;
  /** How many times launchd has started it since it was loaded. */
  runs: number;
  /** The last exit code, or null when it has not exited (or was ended by a signal). */
  lastExitCode: number | null;
}

/** Read the service's top-level `key = value` lines from `launchctl print`. */
export function parseLaunchctlPrint(output: string): LaunchdJob {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (match) values.set(match[1] as string, (match[2] as string).trim());
  }
  const number = (key: string) => {
    const parsed = /^-?\d+/.exec(values.get(key) ?? '');
    return parsed ? Number(parsed[0]) : null;
  };
  return {
    state: values.get('state') ?? 'unknown',
    pid: number('pid'),
    runs: number('runs') ?? 0,
    lastExitCode: number('last exit code'),
  };
}

/**
 * Runs the services as launchd agents for the logged-in user (`gui/<uid>`). Nothing needs
 * root, so each launchctl command runs as the user and is shown as it runs. A service that
 * is already loaded and running from the staged definition is left alone. The installer
 * moves a service's log aside each time it starts or restarts it, so the log holds only
 * the running process's output.
 */
export function createLaunchdBackend(input: {
  host: Host;
  prompter: Prompter;
  stagingDir: string;
  dataDir: string;
  /** Test seam for the pause between attempts to load a service. */
  wait?: (ms: number) => Promise<void>;
}): ServiceBackend {
  const { host, prompter, dataDir } = input;
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (host.uid === null) throw new ServiceError('launchd needs the user id of the logged-in user, and none was found.');
  const domain = `gui/${host.uid}`;
  const service = (unit: string) => `${domain}/${launchdLabel(unit)}`;
  const installedPath = (unit: string) => join(serviceDirFor('launchd', host.homeDir), serviceFileName('launchd', unit));

  async function job(unit: string): Promise<LaunchdJob | null> {
    const result = await host.run('launchctl', ['print', service(unit)]);
    return result.code === 0 ? parseLaunchctlPrint(result.stdout) : null;
  }

  async function launchctl(args: string[]): Promise<{ code: number | null; stderr: string }> {
    prompter.info(`Running: ${shellCommand(['launchctl', ...args])}`);
    return host.run('launchctl', args);
  }

  async function mustRun(args: string[]): Promise<void> {
    const result = await launchctl(args);
    if (result.code !== 0) throw launchctlFailed(args, result);
  }

  /**
   * Load the agent. Right after `bootout`, launchd can still be removing the old one and
   * refuse (error 5, input/output error), so a refusal is tried again for a few seconds.
   */
  async function bootstrap(unit: string): Promise<void> {
    const args = ['bootstrap', domain, installedPath(unit)];
    for (let attempt = 1; ; attempt++) {
      const result = await launchctl(args);
      if (result.code === 0) return;
      if (attempt === 5) throw launchctlFailed(args, result);
      await wait(1000);
    }
  }

  async function moveLogAside(unit: string): Promise<void> {
    const log = serviceLogPath(dataDir, unit);
    await mkdir(dirname(log), { recursive: true, mode: 0o700 });
    try {
      await stat(log);
    } catch {
      return;
    }
    await rename(log, `${log}.1`);
  }

  return {
    async start(unit) {
      const staged = join(input.stagingDir, serviceFileName('launchd', unit));
      const target = installedPath(unit);
      const content = await host.readText(staged);
      if (content === null) throw new ServiceError(`${staged} is missing; it is written when the install is configured.`);
      const installed = await host.readText(target);
      if (installed !== null && installed !== content) {
        prompter.warn(`${target} differs from the agent the installer staged at ${staged}.`);
        const replace = prompter.interactive
          && await prompter.confirm({ message: `Replace ${target} with the staged agent?`, initialValue: false });
        if (!replace) throw new ServiceError(`${target} was changed after the installer wrote it. Restore it from ${staged}, or move it away, and run the install again.`);
      }
      let loaded = await job(unit);
      if (installed !== content) {
        // launchd reads the definition when it loads it, so a loaded one is unloaded first.
        if (loaded) {
          await mustRun(['bootout', service(unit)]);
          loaded = null;
        }
        prompter.info(`Running: ${shellCommand(['cp', staged, target])}`);
        await writeAgent(target, content);
      }
      if (!loaded) {
        await moveLogAside(unit);
        // A service disabled earlier (`launchctl disable`) cannot be loaded until enabled.
        await mustRun(['enable', service(unit)]);
        await bootstrap(unit);
      } else if (loaded.state !== 'running') {
        await moveLogAside(unit);
        await mustRun(['kickstart', service(unit)]);
      }
    },
    async restart(unit) {
      await moveLogAside(unit);
      await mustRun(['kickstart', '-k', service(unit)]);
    },
    async health(unit) {
      const loaded = await job(unit);
      if (!loaded) return { stopped: true, restarts: 0, detail: 'not loaded in launchd' };
      const restarts = Math.max(0, loaded.runs - 1);
      const running = loaded.state === 'running';
      const exit = loaded.lastExitCode === null ? '' : `, last exit code ${loaded.lastExitCode}`;
      const state = `${loaded.state}${running ? '' : exit}`;
      return {
        // launchd starts it again after an exit with an error, but not after a clean one.
        stopped: !running && loaded.lastExitCode === 0,
        restarts,
        detail: restarts > 0 ? `${state}, restarted ${restarts} time${restarts === 1 ? '' : 's'}` : state,
      };
    },
    async startedAt(unit) {
      const loaded = await job(unit);
      if (loaded?.pid == null || loaded.state !== 'running') return null;
      const result = await host.run('ps', ['-o', 'lstart=', '-p', String(loaded.pid)], {
        env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: host.timeZone },
      });
      const started = result.code === 0 ? new Date(result.stdout.trim()) : null;
      return started && !Number.isNaN(started.getTime()) ? started : null;
    },
    // The log is moved aside whenever the installer starts the service, so `since` is met.
    async recentLogs(unit, options = {}) {
      const text = await host.readText(serviceLogPath(dataDir, unit));
      if (text === null) return '';
      return text.split('\n').filter(Boolean).slice(-(options.lines ?? 30)).join('\n');
    },
    logCommand: unit => shellCommand(['tail', '-n', '100', serviceLogPath(dataDir, unit)]),
  };
}

function launchctlFailed(args: readonly string[], result: { code: number | null; stderr: string }): ServiceError {
  const why = result.stderr.trim();
  return new ServiceError(`${shellCommand(['launchctl', ...args])} failed (${result.code === null ? 'could not run' : `exit ${result.code}`})${why ? `: ${why}` : ''}.`);
}

/** Write an agent definition in one step, readable by launchd (0644). */
async function writeAgent(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Stop and remove installed agents, as the user, showing each step. An agent that is not
 * loaded is only removed.
 */
export async function removeLaunchAgents(
  host: Host,
  prompter: Prompter,
  agents: ReadonlyArray<{ unit: string; path: string }>,
): Promise<void> {
  if (agents.length === 0) return;
  if (host.uid === null) throw new ServiceError('launchd needs the user id of the logged-in user, and none was found.');
  for (const { unit } of agents) {
    const target = `gui/${host.uid}/${launchdLabel(unit)}`;
    if ((await host.run('launchctl', ['print', target])).code !== 0) continue;
    const args = ['bootout', target];
    prompter.info(`Running: ${shellCommand(['launchctl', ...args])}`);
    const result = await host.run('launchctl', args);
    if (result.code !== 0 && (await host.run('launchctl', ['print', target])).code === 0) {
      throw launchctlFailed(args, result);
    }
  }
  prompter.info(`Running: ${shellCommand(['rm', ...agents.map(({ path }) => path)])}`);
  await Promise.all(agents.map(({ path }) => rm(path, { force: true })));
}
