import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, Host } from '../src/host.js';
import { parseVmStat } from '../src/host.js';
import {
  createLaunchdBackend,
  parseLaunchctlPrint,
  removeLaunchAgents,
  renderCuratorPlist,
  renderEnginePlist,
  serviceLogPath,
} from '../src/launchd.js';
import { createScriptedPrompter } from '../src/prompter.js';
import { ServiceError } from '../src/services.js';
import { UnitError, type ServiceSpec } from '../src/units.js';
import { fakeHost, makeTree, removeTrees, replayPrompter } from './helpers.js';

afterEach(removeTrees);

const SPEC: ServiceSpec = {
  unit: 'vault-engine.service',
  user: 'sam',
  nodePath: '/srv/sam/.local/share/mise/installs/node/24.11.0/bin/node',
  repoRoot: '/srv/sam/vault-suite',
  dataDir: '/srv/sam/vault-suite-data',
  port: 3334,
};

describe('launchd agents', () => {
  it('runs Engine on the pinned Node binary, loading engine.env itself', () => {
    expect(renderEnginePlist(SPEC)).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<!-- Written by vault-installer. -->',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>Label</key>',
      '\t<string>vault-engine</string>',
      '\t<key>ProgramArguments</key>',
      '\t<array>',
      '\t\t<string>/srv/sam/.local/share/mise/installs/node/24.11.0/bin/node</string>',
      '\t\t<string>--env-file=/srv/sam/vault-suite-data/engine.env</string>',
      '\t\t<string>/srv/sam/vault-suite/packages/engine/dist/index.js</string>',
      '\t\t<string>--transport</string>',
      '\t\t<string>http</string>',
      '\t\t<string>--port</string>',
      '\t\t<string>3334</string>',
      '\t</array>',
      '\t<key>WorkingDirectory</key>',
      '\t<string>/srv/sam/vault-suite-data</string>',
      '\t<key>RunAtLoad</key>',
      '\t<true/>',
      '\t<key>KeepAlive</key>',
      '\t<dict>',
      '\t\t<key>SuccessfulExit</key>',
      '\t\t<false/>',
      '\t</dict>',
      '\t<key>ThrottleInterval</key>',
      '\t<integer>10</integer>',
      '\t<key>ExitTimeOut</key>',
      '\t<integer>90</integer>',
      '\t<key>Umask</key>',
      '\t<integer>63</integer>',
      '\t<key>StandardOutPath</key>',
      '\t<string>/srv/sam/vault-suite-data/logs/vault-engine.log</string>',
      '\t<key>StandardErrorPath</key>',
      '\t<string>/srv/sam/vault-suite-data/logs/vault-engine.log</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
  });

  it('runs Curator with its own env file, label, and log', () => {
    const plist = renderCuratorPlist({ ...SPEC, unit: 'vault-curator.service', port: 3335 });

    expect(plist).toContain('<string>vault-curator</string>');
    expect(plist).toContain([
      '\t\t<string>--env-file=/srv/sam/vault-suite-data/curator.env</string>',
      '\t\t<string>/srv/sam/vault-suite/packages/curator/dist/server.js</string>',
      '\t</array>',
    ].join('\n'));
    expect(plist).toContain('<string>/srv/sam/vault-suite-data/logs/vault-curator.log</string>');
    expect(plist).toContain('\t<key>ExitTimeOut</key>\n\t<integer>15</integer>');
  });

  it('escapes XML in paths and refuses characters XML cannot hold', () => {
    const plist = renderEnginePlist({ ...SPEC, dataDir: '/srv/sam/R&D <notes>' });

    expect(plist).toContain('<string>/srv/sam/R&amp;D &lt;notes&gt;</string>');
    expect(() => renderEnginePlist({ ...SPEC, dataDir: '/srv/sam/bad\u0001dir' })).toThrow(UnitError);
  });
});

describe('parseLaunchctlPrint', () => {
  it('reads the service\'s own state, ignoring nested blocks', () => {
    const output = [
      'gui/501/vault-engine = {',
      '\tactive count = 1',
      '\tpath = /srv/sam/Library/LaunchAgents/vault-engine.plist',
      '\ttype = LaunchAgent',
      '\tstate = running',
      '',
      '\tprogram = /srv/sam/node',
      '\tenvironment = {',
      '\t\tstate = not this one',
      '\t}',
      '',
      '\truns = 3',
      '\tpid = 4242',
      '\tlast exit code = 1',
      '}',
    ].join('\n');

    expect(parseLaunchctlPrint(output)).toEqual({ state: 'running', pid: 4242, runs: 3, lastExitCode: 1 });
  });

  it('reads a service that never exited as having no exit code', () => {
    expect(parseLaunchctlPrint('x = {\n\tstate = not running\n\truns = 0\n\tlast exit code = (never exited)\n}')).toEqual({
      state: 'not running', pid: null, runs: 0, lastExitCode: null,
    });
  });
});

describe('parseVmStat', () => {
  it('counts the pages a new process can have', () => {
    const output = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               10000.',
      'Pages active:                            500000.',
      'Pages inactive:                          200000.',
      'Pages speculative:                         5000.',
      'Pages throttled:                              0.',
      'Pages wired down:                        150000.',
      'Pages purgeable:                           1000.',
    ].join('\n');

    expect(parseVmStat(output)).toBe((10000 + 200000 + 5000 + 1000) * 16384);
    expect(parseVmStat('nothing here')).toBeNull();
  });
});

/**
 * A Mac whose launchctl answers from `loaded` (label → `launchctl print` output); every
 * call is recorded. Agents and logs are real files under a temporary home.
 */
async function mac(options: { loaded?: Record<string, string>; failBootstrap?: number } = {}) {
  const home = await makeTree({});
  const dataDir = join(home, 'vault-suite-data');
  const stagingDir = join(dataDir, 'installer', 'units');
  await mkdir(stagingDir, { recursive: true });
  const calls: string[][] = [];
  const loaded = { ...options.loaded };
  let bootstrapFailures = options.failBootstrap ?? 0;
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
  const host: Host = fakeHost({
    platform: 'darwin',
    arch: 'arm64',
    homeDir: home,
    uid: 501,
    readText: async path => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'ps') return ok('Wed Nov 19 23:23:29 2026\n');
      if (command !== 'launchctl') return ok();
      const label = args.at(-1)?.split('/').at(-1)?.replace(/\.plist$/, '') ?? '';
      if (args[0] === 'print') return label in loaded ? ok(loaded[label]) : { code: 113, stdout: '', stderr: 'Could not find service' };
      if (args[0] === 'bootstrap') {
        if (bootstrapFailures > 0) {
          bootstrapFailures--;
          return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
        }
        loaded[label] = '\tstate = running\n\truns = 1\n\tpid = 99\n';
      }
      if (args[0] === 'bootout') delete loaded[label];
      return ok();
    },
  });
  const agent = join(home, 'Library', 'LaunchAgents', 'vault-engine.plist');
  const staged = join(stagingDir, 'vault-engine.plist');
  const backend = (prompter = createScriptedPrompter({ version: 1, vault: { path: '/v' } }, () => {})) =>
    createLaunchdBackend({ host, prompter, stagingDir, dataDir, wait: async () => {} });
  const launchctl = () => calls.filter(call => call[0] === 'launchctl' && call[1] !== 'print').map(call => call.slice(1).join(' '));
  return { host, home, dataDir, staged, agent, backend, calls, launchctl, loaded };
}

describe('launchd backend', () => {
  it('copies the staged agent to LaunchAgents and loads it, showing each step, with no sudo', async () => {
    const m = await mac();
    await writeFile(m.staged, '<plist>engine</plist>\n');
    const { prompter } = replayPrompter({});
    const shown: string[] = [];
    prompter.info = message => { shown.push(message); };

    await m.backend(prompter).start('vault-engine.service');

    expect(await readFile(m.agent, 'utf8')).toBe('<plist>engine</plist>\n');
    expect((await stat(m.agent)).mode & 0o777).toBe(0o644);
    expect(m.launchctl()).toEqual([
      'enable gui/501/vault-engine',
      `bootstrap gui/501 ${m.agent}`,
    ]);
    expect(shown).toEqual([
      `Running: cp ${m.staged} ${m.agent}`,
      'Running: launchctl enable gui/501/vault-engine',
      `Running: launchctl bootstrap gui/501 ${m.agent}`,
    ]);
    expect(m.calls.some(call => call[0] === 'sudo')).toBe(false);
    expect((await stat(join(m.dataDir, 'logs'))).isDirectory()).toBe(true);
  });

  it('leaves a loaded, running agent with the staged content alone', async () => {
    const m = await mac({ loaded: { 'vault-engine': '\tstate = running\n\tpid = 7\n\truns = 1\n' } });
    await writeFile(m.staged, 'same\n');
    await mkdir(join(m.home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(m.agent, 'same\n');

    await m.backend().start('vault-engine.service');

    expect(m.launchctl()).toEqual([]);
  });

  it('unloads an agent the user agreed to replace before loading the new one', async () => {
    const m = await mac({ loaded: { 'vault-engine': '\tstate = running\n' } });
    await writeFile(m.staged, 'new\n');
    await mkdir(join(m.home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(m.agent, 'old\n');
    const { prompter } = replayPrompter({}, [true]);

    await m.backend(prompter).start('vault-engine.service');

    expect(await readFile(m.agent, 'utf8')).toBe('new\n');
    expect(m.launchctl()).toEqual([
      'bootout gui/501/vault-engine',
      'enable gui/501/vault-engine',
      `bootstrap gui/501 ${m.agent}`,
    ]);
  });

  it('refuses to replace an agent changed since it was written, without asking headless', async () => {
    const m = await mac();
    await writeFile(m.staged, 'new\n');
    await mkdir(join(m.home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(m.agent, 'edited by hand\n');

    await expect(m.backend().start('vault-engine.service')).rejects.toThrow(/was changed after the installer wrote it/);
    expect(await readFile(m.agent, 'utf8')).toBe('edited by hand\n');
  });

  it('tries loading again while launchd is still removing the old agent', async () => {
    const m = await mac({ failBootstrap: 2 });
    await writeFile(m.staged, 'agent\n');

    await m.backend().start('vault-engine.service');

    expect(m.launchctl().filter(call => call.startsWith('bootstrap'))).toHaveLength(3);
  });

  it('stops with launchctl\'s message when loading keeps failing', async () => {
    const m = await mac({ failBootstrap: 10 });
    await writeFile(m.staged, 'agent\n');

    await expect(m.backend().start('vault-engine.service')).rejects.toThrow(ServiceError);
    await expect(m.backend().start('vault-engine.service')).rejects.toThrow(/Input\/output error/);
  });

  it('starts a loaded agent that exited, and restarts with kickstart -k, moving the log aside each time', async () => {
    const m = await mac({ loaded: { 'vault-engine': '\tstate = not running\n\tlast exit code = 0\n' } });
    await writeFile(m.staged, 'same\n');
    await mkdir(join(m.home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(m.agent, 'same\n');
    const log = serviceLogPath(m.dataDir, 'vault-engine.service');
    await mkdir(join(m.dataDir, 'logs'), { recursive: true });
    await writeFile(log, 'the old process\n');
    const backend = m.backend();

    await backend.start('vault-engine.service');
    expect(await readFile(`${log}.1`, 'utf8')).toBe('the old process\n');
    await writeFile(log, 'line 1\nline 2\nline 3\n');
    expect(await backend.recentLogs('vault-engine.service', { lines: 2 })).toBe('line 2\nline 3');

    await backend.restart('vault-engine.service');
    expect(await readFile(`${log}.1`, 'utf8')).toBe('line 1\nline 2\nline 3\n');
    expect(await backend.recentLogs('vault-engine.service')).toBe('');
    expect(m.launchctl()).toEqual(['kickstart gui/501/vault-engine', 'kickstart -k gui/501/vault-engine']);
    expect(backend.logCommand('vault-engine.service')).toBe(`tail -n 100 ${log}`);
  });

  it('reports health and start time from launchctl and ps', async () => {
    const m = await mac({
      loaded: {
        'vault-engine': '\tstate = running\n\tpid = 4242\n\truns = 3\n\tlast exit code = 1\n',
        'vault-curator': '\tstate = not running\n\truns = 1\n\tlast exit code = 0\n',
      },
    });
    const backend = m.backend();

    expect(await backend.health('vault-engine.service')).toEqual({ stopped: false, restarts: 2, detail: 'running, restarted 2 times' });
    // launchd starts a service again after an error, not after a clean exit.
    expect(await backend.health('vault-curator.service')).toEqual({ stopped: true, restarts: 0, detail: 'not running, last exit code 0' });
    expect(await backend.health('missing.service')).toMatchObject({ stopped: true, detail: 'not loaded in launchd' });
    expect((await backend.startedAt('vault-engine.service'))?.getFullYear()).toBe(2026);
    expect(m.calls).toContainEqual(['ps', '-o', 'lstart=', '-p', '4242']);
    expect(await backend.startedAt('vault-curator.service')).toBeNull();
  });

  it('removes agents as the user: unloads a loaded one, then deletes the files', async () => {
    const m = await mac({ loaded: { 'vault-engine': '\tstate = running\n' } });
    const curatorAgent = join(m.home, 'Library', 'LaunchAgents', 'vault-curator.plist');
    await mkdir(join(m.home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(m.agent, 'engine\n');
    await writeFile(curatorAgent, 'curator\n');
    const { prompter } = replayPrompter({});
    const shown: string[] = [];
    prompter.info = message => { shown.push(message); };

    await removeLaunchAgents(m.host, prompter, [
      { unit: 'vault-curator.service', path: curatorAgent },
      { unit: 'vault-engine.service', path: m.agent },
    ]);

    expect(m.launchctl()).toEqual(['bootout gui/501/vault-engine']);
    expect(shown).toEqual(['Running: launchctl bootout gui/501/vault-engine', `Running: rm ${curatorAgent} ${m.agent}`]);
    expect(await m.host.readText(m.agent)).toBeNull();
    expect(await m.host.readText(curatorAgent)).toBeNull();
  });
});
