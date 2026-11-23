import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, removeTrees, REPO_ROOT } from './helpers.js';

afterEach(removeTrees);

/** The real tools install.sh uses; everything else on its PATH is a fake (`uname` says Linux). */
const TOOLS = ['bash', 'dirname', 'tr', 'cut', 'mktemp', 'env', 'tail', 'sed', 'rm'];

interface Machine {
  /** The Node.js major version on PATH, or null for none. */
  nodeMajor?: number | null;
  /** Dependencies installed after the lockfile last changed. */
  withModules?: boolean;
  /** Whether better-sqlite3 loads, as built for this Node.js ABI or another. */
  nativeLoads?: boolean;
  /** What `systemctl is-system-running` prints, or null for no systemctl. */
  systemd?: string | null;
  uid?: number;
  busyPorts?: number[];
  /** Free space for the checkout, in GB as the probe prints it. */
  freeGb?: string;
  failBuild?: boolean;
  managers?: Array<'mise' | 'nvm' | 'fnm'>;
  /** An install saved in the default data directory. */
  savedInstall?: boolean;
  /** The folder install.sh is run from. */
  from?: string;
  /** What `uname -s` prints. */
  os?: 'Linux' | 'Darwin';
  /** Node.js's `process.arch`. */
  nodeArch?: string;
  /** Whether launchctl is on PATH (macOS). */
  launchctl?: boolean;
}

/**
 * install.sh from a copy of the checkout's root files, on a PATH of the few real tools it
 * needs and fakes for the rest: `node` and `npm` log how they were called, and the machine
 * probes answer as `machine` describes.
 */
async function bootstrap(args: string[], machine: Machine = {}) {
  const {
    nodeMajor = 24, withModules = false, nativeLoads = true, systemd = 'running', uid = 1000,
    busyPorts = [], freeGb = '120.5', failBuild = false, managers = [], savedInstall = false, from,
    os = 'Linux', nodeArch = os === 'Darwin' ? 'arm64' : 'x64', launchctl = os === 'Darwin',
  } = machine;
  const root = await makeTree({ ...(withModules ? { 'node_modules/.package-lock.json': '{}' } : {}) });
  for (const file of ['install.sh', '.nvmrc', 'package-lock.json']) await copyFile(join(REPO_ROOT, file), join(root, file));
  if (withModules) await utimes(join(root, 'package-lock.json'), new Date('2026-01-01'), new Date('2026-01-01'));
  const home = await makeTree(savedInstall ? { 'vault-suite-data/installer/state.json': '{}' } : {});
  const tmp = await makeTree({});
  const bin = await makeTree({});
  for (const tool of TOOLS) {
    const real = ['/usr/bin', '/bin'].map(directory => join(directory, tool)).find(path => existsSync(path));
    if (!real) throw new Error(`${tool} not found`);
    await symlink(real, join(bin, tool));
  }
  const log = join(bin, 'calls.log');
  const fake = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  if (nodeMajor !== null) {
    await fake('node', [
      'case "$1:$2" in',
      `  -p:*statfs*) echo "check disk" >> ${log}; echo ${freeGb}; exit 0 ;;`,
      `  -p:process.arch) echo ${nodeArch}; exit 0 ;;`,
      `  -p:*) echo ${nodeMajor}; exit 0 ;;`,
      `  -e:*listen*) echo "check port $3" >> ${log}; case " ${busyPorts.join(' ')} " in *" $3 "*) exit 1 ;; esac; exit 0 ;;`,
      `  -e:*) exit ${nativeLoads ? 0 : 1} ;;`,
      `  --version:*) echo v${nodeMajor}.1.0; exit 0 ;;`,
      'esac',
      `echo "node $*" >> ${log}`,
      `printf %s "$VAULT_INSTALLER_COMMAND" > ${join(bin, 'command')}`,
      `printf '%s\\n%s' "$VAULT_INSTALLER_CWD" "$PWD" > ${join(bin, 'cwd')}`,
      // The installer's own output, which stays on stdout.
      `echo '{"plan":true}'`,
    ].join('\n'));
    await fake('npm', [
      `echo "npm $* SHARP=$SHARP_IGNORE_GLOBAL_LIBVIPS" >> ${log}`,
      'echo "npm output"',
      ...(failBuild ? ['if [ "$1" = run ]; then echo "error TS2304: Cannot find name"; exit 2; fi'] : []),
    ].join('\n'));
  }
  await fake('uname', `case "$1" in -m) echo ${os === 'Darwin' ? 'arm64' : 'x86_64'} ;; *) echo ${os} ;; esac`);
  if (launchctl) await fake('launchctl', 'exit 0');
  if (systemd !== null) await fake('systemctl', `[ "$1" = is-system-running ] && echo ${systemd}; [ ${systemd} = running ]`);
  await fake('id', `echo ${uid}`);
  for (const manager of managers) {
    if (manager === 'nvm') await mkdir(join(home, '.nvm')).then(() => writeFile(join(home, '.nvm', 'nvm.sh'), '# nvm\n'));
    else await fake(manager, 'exit 0');
  }
  const result = spawnSync(join(bin, 'bash'), [join(root, 'install.sh'), ...args], {
    env: { PATH: bin, HOME: home, TMPDIR: tmp },
    encoding: 'utf8',
    ...(from !== undefined ? { cwd: from } : {}),
  });
  const calls = await readFile(log, 'utf8').then(text => text.trim().split('\n'), () => []);
  const command = await readFile(join(bin, 'command'), 'utf8').catch(() => null);
  const [callerDir, installerDir] = await readFile(join(bin, 'cwd'), 'utf8').then(text => text.split('\n'), () => [null, null]);
  return { ...result, calls, root, home, command, callerDir, installerDir, logs: await readdir(tmp), tmp };
}

const CHECKS = ['check port 3334', 'check port 3335', 'check disk'];

describe('install.sh', () => {
  it('checks the machine, installs dependencies with sharp\'s prebuilt binary, builds, and runs install with the options', async () => {
    const { status, stderr, calls, logs } = await bootstrap(['--answers', 'a.json', '--yes']);

    expect(status).toBe(0);
    expect(calls).toEqual([
      ...CHECKS,
      'npm ci SHARP=1',
      'npm run build SHARP=',
      'node packages/installer/dist/cli.js install --answers a.json --yes',
    ]);
    // One line instead of the build's output, which went to a log removed once it passed.
    expect(stderr).toContain('▶ Preparing: installing dependencies and building, about 3 minutes');
    expect(stderr).not.toContain('npm output');
    expect(stderr).not.toContain('warning');
    expect(logs).toEqual([]);
  });

  it('runs the installer in the checkout and tells it the folder install.sh was run from', async () => {
    const from = await makeTree({});

    const { status, root, callerDir, installerDir } = await bootstrap(['--answers', 'a.json'], { from });

    expect(status).toBe(0);
    expect(installerDir).toBe(root);
    // Relative options and the notes folder it first suggests mean this folder.
    expect(callerDir).toBe(from);
  });

  it('keeps its own and npm\'s output off stdout, so plan --json prints only the JSON', async () => {
    const { status, stdout, stderr, calls } = await bootstrap(['plan', '--answers', 'a.json', '--json']);

    expect(status).toBe(0);
    expect(stdout).toBe('{"plan":true}\n');
    expect(stderr).toContain('▶ Preparing: installing dependencies and building');
    // plan is a practice run: the installer reports the machine itself.
    expect(calls).not.toContain('check disk');
  });

  it('tells the installer its own path, so messages name it instead of vault-installer', async () => {
    const { status, root, command } = await bootstrap(['status'], { withModules: true });

    expect(status).toBe(0);
    expect(command).toBe(join(root, 'install.sh'));
  });

  it('reinstalls current-looking dependencies built for another Node.js', async () => {
    const { calls } = await bootstrap([], { withModules: true, nativeLoads: false });

    expect(calls).toContain('npm ci SHARP=1');
  });

  it('passes the installer\'s other commands through, and skips dependencies that are current', async () => {
    const { status, stderr, calls } = await bootstrap(['status', '--data-dir', '/srv/data'], { withModules: true });

    expect(status).toBe(0);
    expect(stderr).toContain('▶ Preparing: building, about a minute');
    expect(calls).toEqual(['npm run build SHARP=', 'node packages/installer/dist/cli.js status --data-dir /srv/data']);
  });

  it.each([['undo'], ['uninstall']])('passes %s through', async command => {
    const { status, calls } = await bootstrap([command, '--yes'], { withModules: true });

    expect(status).toBe(0);
    expect(calls).toEqual(['npm run build SHARP=', `node packages/installer/dist/cli.js ${command} --yes`]);
  });

  it('shows the end of the build output and keeps the log when a step fails', async () => {
    const { status, stderr, calls, logs, tmp } = await bootstrap([], { failBuild: true });

    expect(status).toBe(1);
    expect(stderr).toContain('install.sh: \'npm run build\' failed. The end of its output:');
    expect(stderr).toContain('  error TS2304: Cannot find name');
    expect(logs).toHaveLength(1);
    expect(stderr).toContain(`The full output is in ${join(tmp, logs[0] as string)}.`);
    expect(await readFile(join(tmp, logs[0] as string), 'utf8')).toContain('$ env SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci\nnpm output\n');
    expect(calls.at(-1)).toBe('npm run build SHARP=');
  });

  it('stops without systemd before anything else', async () => {
    const { status, stderr, calls } = await bootstrap([], { systemd: 'offline' });
    const missing = await bootstrap([], { systemd: null });

    expect(status).toBe(1);
    expect(stderr).toContain('install.sh: Vault Suite runs Engine and Curator as systemd services, and this system is not running systemd.');
    expect(calls).toEqual([]);
    expect(missing.status).toBe(1);
  });

  describe('on macOS', () => {
    it('installs on an Apple Silicon Mac with launchctl and no systemd', async () => {
      const { status, stderr, calls } = await bootstrap(['--answers', 'a.json', '--yes'], { os: 'Darwin', systemd: null });

      expect(status).toBe(0);
      expect(stderr).not.toContain('systemd');
      expect(calls.at(-1)).toBe('node packages/installer/dist/cli.js install --answers a.json --yes');
    });

    it('stops on an Intel Mac, or Node.js under Rosetta, before building', async () => {
      const { status, stderr, calls } = await bootstrap([], { os: 'Darwin', systemd: null, nodeArch: 'x64' });

      expect(status).toBe(1);
      expect(stderr).toContain('install.sh: Node.js here runs as x64. Engine\'s local search model has no build for Intel Macs, so Vault Suite needs an Apple Silicon Mac and the arm64 Node.js 24.');
      expect(calls.filter(call => call.startsWith('npm'))).toEqual([]);
    });

    it('stops without launchctl, and warns as root with the Mac\'s wording', async () => {
      const missing = await bootstrap([], { os: 'Darwin', systemd: null, launchctl: false });
      const root = await bootstrap([], { os: 'Darwin', systemd: null, uid: 0 });

      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('install.sh: Vault Suite runs Engine and Curator as launchd agents, and launchctl was not found.');
      expect(root.status).toBe(0);
      expect(root.stderr).toContain('the services run as that user while they are logged in.');
    });
  });

  it('stops on another operating system', async () => {
    const { status, stderr } = await bootstrap([], { os: 'FreeBSD' as 'Linux' });

    expect(status).toBe(1);
    expect(stderr).toContain('install.sh: Vault Suite installs on Linux with systemd, and on macOS on Apple Silicon.');
  });

  it('shows the help or the version of install without the install checks', async () => {
    for (const args of [['install', '--help'], ['--answers', 'a.json', '-h'], ['install', '--version']]) {
      const { status, stderr, calls } = await bootstrap(args, { systemd: null, busyPorts: [3334], uid: 0 });

      expect(status).toBe(0);
      expect(stderr).not.toContain('systemd services');
      expect(stderr).not.toContain('running as root');
      expect(calls.filter(call => call.startsWith('check'))).toEqual([]);
      expect(calls.at(-1)).toBe(`node packages/installer/dist/cli.js ${args[0] === 'install' ? '' : 'install '}${args.join(' ')}`);
    }
  });

  it('goes on with a degraded systemd, and only warns as root', async () => {
    const { status, stderr } = await bootstrap([], { systemd: 'degraded', uid: 0 });

    expect(status).toBe(0);
    expect(stderr).toContain('install.sh: warning: running as root.');
  });

  it('stops on a default port in use before installing anything', async () => {
    const { status, stderr, calls } = await bootstrap([], { busyPorts: [3335] });

    expect(status).toBe(1);
    expect(stderr).toContain('install.sh: port 3335 is in use.');
    expect(calls).toEqual(['check port 3334', 'check port 3335']);
  });

  it('leaves ports to the installer for other ports, another data directory, or a saved install', async () => {
    for (const run of [
      await bootstrap(['--engine-port', '4334'], { busyPorts: [3334] }),
      await bootstrap(['install', '--data-dir', '/srv/data'], { busyPorts: [3334] }),
      await bootstrap([], { busyPorts: [3334], savedInstall: true }),
    ]) {
      expect(run.status).toBe(0);
      expect(run.calls[0]).toBe('check disk');
    }
  });

  it('warns about low disk space and goes on', async () => {
    const { status, stderr, root } = await bootstrap([], { freeGb: '1.4' });

    expect(status).toBe(0);
    expect(stderr).toContain(`install.sh: warning: only 1.4 GB is free for ${root}.`);
  });

  it('stops on another Node.js version with the command for the version manager it finds, repeating this run', async () => {
    const { status, stderr, calls, root } = await bootstrap(['plan', '--answers', 'my answers.json', '--json'], { nodeMajor: 22, managers: ['mise'] });

    expect(status).toBe(1);
    expect(stderr).toContain('install.sh: Node.js 24 is required, but node is v22.1.0;');
    expect(stderr).toContain(`  with mise:  mise install node@24 && PATH="$(mise where node@24)/bin:$PATH" ${join(root, 'install.sh')} plan --answers my\\ answers.json --json\n`);
    expect(stderr).not.toContain('with nvm');
    expect(calls).toEqual([]);
  });

  it('names nvm and fnm when they are installed, and nodejs.org when nothing is', async () => {
    const managed = await bootstrap([], { nodeMajor: null, managers: ['nvm', 'fnm'] });
    const bare = await bootstrap([], { nodeMajor: null });

    expect(managed.status).toBe(1);
    expect(managed.stderr).toContain('install.sh: Node.js 24 is required, and node was not found.');
    // nvm is a shell function, so the command loads nvm.sh first.
    expect(managed.stderr).toContain(`  with nvm:   . ${join(managed.home, '.nvm', 'nvm.sh')} && nvm install 24 && nvm use 24 && ${join(managed.root, 'install.sh')} install\n`);
    expect(managed.stderr).toContain(`  with fnm:   fnm install 24 && fnm use 24 && ${join(managed.root, 'install.sh')} install\n`);
    expect(managed.stderr).not.toContain('with mise');
    expect(bare.stderr).toContain('Install Node.js 24 from https://nodejs.org');
  });
});
