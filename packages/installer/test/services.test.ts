import { describe, expect, it } from 'vitest';
import type { Host } from '../src/host.js';
import { createScriptedPrompter } from '../src/prompter.js';
import { createSystemdBackend, ServiceError, ServicePausedError } from '../src/services.js';
import { shellCommand } from '../src/text.js';
import { fakeHost, replayPrompter } from './helpers.js';

const STAGED = '/data/installer/units/vault-engine.service';
const TARGET = '/etc/systemd/system/vault-engine.service';
const UNIT = '[Unit]\nDescription=Vault Engine\n';

/** A machine where `files` exist and systemctl reports `states`; records sudo commands. */
function machine(files: Record<string, string>, states: { enabled?: string; active?: string; show?: string } = {}) {
  const sudo: string[][] = [];
  const host: Host = fakeHost({
    readText: async path => files[path] ?? null,
    run: async (command, args) => {
      if (command !== 'systemctl') return { code: 0, stdout: '', stderr: '' };
      const output = args[0] === 'is-enabled' ? states.enabled ?? 'not-found'
        : args[0] === 'is-active' ? states.active ?? 'inactive'
          : states.show ?? '';
      return { code: 0, stdout: `${output}\n`, stderr: '' };
    },
    runAttached: async (_command, args) => { sudo.push(args); return 0; },
  });
  return { host, sudo };
}

function headless() {
  const lines: string[] = [];
  return { prompter: createScriptedPrompter({ version: 1, vault: { path: '/v' } }, line => lines.push(line)), lines };
}

describe('systemd backend', () => {
  it('installs, reloads, and enables a new unit, showing each command', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT });
    const { prompter } = replayPrompter({});
    const shown: string[] = [];
    prompter.info = message => { shown.push(message); };

    await createSystemdBackend({ host, prompter, stagingDir: '/data/installer/units', sudo: true }).start('vault-engine.service');

    expect(sudo).toEqual([
      ['install', '-m', '0644', STAGED, TARGET],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'vault-engine.service'],
    ]);
    expect(shown).toEqual([
      `Running: sudo install -m 0644 ${STAGED} ${TARGET}`,
      'Running: sudo systemctl daemon-reload',
      'Running: sudo systemctl enable --now vault-engine.service',
    ]);
  });

  it('runs nothing when the unit is installed, enabled, and running', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT, [TARGET]: UNIT }, { enabled: 'enabled', active: 'active' });

    await createSystemdBackend({ host, prompter: headless().prompter, stagingDir: '/data/installer/units', sudo: true }).start('vault-engine.service');

    expect(sudo).toEqual([]);
  });

  it('never waits for a password without a terminal', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT, [TARGET]: UNIT }, { enabled: 'enabled', active: 'inactive' });

    await createSystemdBackend({ host, prompter: headless().prompter, stagingDir: '/data/installer/units', sudo: true }).start('vault-engine.service');

    expect(sudo).toEqual([['-n', 'systemctl', 'enable', '--now', 'vault-engine.service']]);
  });

  it('refuses to replace an edited unit headlessly, and asks first interactively', async () => {
    const files = { [STAGED]: UNIT, [TARGET]: `${UNIT}# edited\n` };
    const refused = machine(files, { enabled: 'enabled', active: 'active' });
    const headlessBackend = createSystemdBackend({ ...refused, prompter: headless().prompter, stagingDir: '/data/installer/units', sudo: true });
    await expect(headlessBackend.start('vault-engine.service')).rejects.toThrow(/was changed after the installer wrote it/);
    expect(refused.sudo).toEqual([]);

    const replaced = machine(files, { enabled: 'enabled', active: 'active' });
    const { prompter } = replayPrompter({}, [true]);
    await createSystemdBackend({ ...replaced, prompter, stagingDir: '/data/installer/units', sudo: true }).start('vault-engine.service');
    expect(replaced.sudo).toEqual([
      ['install', '-m', '0644', STAGED, TARGET],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'restart', 'vault-engine.service'],
    ]);
  });

  it('restarts a replaced unit that is running but disabled', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT, [TARGET]: `${UNIT}# edited\n` }, { enabled: 'disabled', active: 'active' });
    const { prompter } = replayPrompter({}, [true]);

    await createSystemdBackend({ host, prompter, stagingDir: '/data/installer/units', sudo: true }).start('vault-engine.service');

    expect(sudo).toEqual([
      ['install', '-m', '0644', STAGED, TARGET],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', 'vault-engine.service'],
      ['systemctl', 'restart', 'vault-engine.service'],
    ]);
  });

  it('enables a running, unchanged unit without restarting it', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT, [TARGET]: UNIT }, { enabled: 'disabled', active: 'active' });

    await createSystemdBackend({ host, prompter: headless().prompter, stagingDir: '/data/installer/units', sudo: true }).start('vault-engine.service');

    expect(sudo).toEqual([['-n', 'systemctl', 'enable', 'vault-engine.service']]);
  });

  it('prints the commands with --no-sudo and pauses headlessly', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT });
    const { prompter, lines } = headless();

    const start = createSystemdBackend({ host, prompter, stagingDir: '/data/installer/units', sudo: false }).start('vault-engine.service');

    await expect(start).rejects.toThrow(ServicePausedError);
    expect(sudo).toEqual([]);
    expect(lines.join('\n')).toContain(`Run these as root to install and start vault-engine.service\nsudo install -m 0644 ${STAGED} ${TARGET}\nsudo systemctl daemon-reload\nsudo systemctl enable --now vault-engine.service`);
  });

  it('goes on with --no-sudo once an interactive user has run the commands', async () => {
    const { host, sudo } = machine({ [STAGED]: UNIT });
    const { prompter } = replayPrompter({}, [true]);

    await createSystemdBackend({ host, prompter, stagingDir: '/data/installer/units', sudo: false }).start('vault-engine.service');

    expect(sudo).toEqual([]);
  });

  it('stops when sudo fails', async () => {
    const { host } = machine({ [STAGED]: UNIT });
    host.runAttached = async () => 1;

    await expect(createSystemdBackend({ host, prompter: headless().prompter, stagingDir: '/data/installer/units', sudo: true })
      .start('vault-engine.service')).rejects.toThrow(new ServiceError(`sudo install -m 0644 ${STAGED} ${TARGET} failed (exit 1). Run the install again with --no-sudo to run the root commands yourself.`));
  });

  it('reads the unit\'s state and restart count', async () => {
    const { host } = machine({}, { show: 'ActiveState=activating\nSubState=auto-restart\nNRestarts=2' });

    expect(await createSystemdBackend({ host, prompter: headless().prompter, stagingDir: '/s', sudo: true }).health('vault-engine.service'))
      .toEqual({ stopped: false, restarts: 2, detail: 'activating (auto-restart), restarted 2 times' });
  });

  it('reads the unit\'s log, from a given time when asked', async () => {
    const runs: string[][] = [];
    const host = fakeHost({ run: async (command, args) => { runs.push([command, ...args]); return { code: 0, stdout: 'Indexing vault at /v...\n', stderr: '' }; } });
    const backend = createSystemdBackend({ host, prompter: headless().prompter, stagingDir: '/s', sudo: true });

    expect(await backend.recentLogs('vault-engine.service')).toBe('Indexing vault at /v...');
    await backend.recentLogs('vault-engine.service', { since: new Date('2026-11-10T12:00:00.900Z'), lines: 200 });

    expect(runs).toEqual([
      ['journalctl', '--unit', 'vault-engine.service', '--lines', '30', '--no-pager', '--output', 'cat'],
      ['journalctl', '--unit', 'vault-engine.service', '--since', '@1794312000', '--lines', '200', '--no-pager', '--output', 'cat'],
    ]);
  });
});

describe('shellCommand', () => {
  it('quotes only the arguments a shell would split or expand', () => {
    expect(shellCommand(['sudo', 'install', '-m', '0644', "/srv/sam/my data/it's", '/etc/systemd/system/x.service']))
      .toBe(`sudo install -m 0644 '/srv/sam/my data/it'\\''s' /etc/systemd/system/x.service`);
  });
});
