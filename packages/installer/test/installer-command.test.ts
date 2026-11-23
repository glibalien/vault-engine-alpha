import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_OK, runCli, type CliDeps } from '../src/cli.js';
import type { Host } from '../src/host.js';
import { installerCommand, INSTALLER_COMMAND_VAR } from '../src/layout.js';
import type { Prompter } from '../src/prompter.js';
import { fakeHost, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

const SCRIPT = '/opt/vault suite/install.sh';
const startedByScript = (name: string) => (name === INSTALLER_COMMAND_VAR ? SCRIPT : undefined);

describe('installerCommand', () => {
  it('names install.sh when it started the installer, quoted for the shell', () => {
    expect(installerCommand(fakeHost({ env: startedByScript }), 'status')).toBe(`'${SCRIPT}' status`);
  });

  it('names the built CLI through node otherwise, also when run from source', () => {
    expect(installerCommand(fakeHost(), 'install')).toBe(`node ${join(REPO_ROOT, 'packages', 'installer', 'dist', 'cli.js')} install`);
  });

  it('passes a data directory along only when it is not the default', () => {
    const host = fakeHost({ env: startedByScript, homeDir: '/srv/tester' });

    expect(installerCommand(host, 'status', '/srv/tester/vault-suite-data')).toBe(`'${SCRIPT}' status`);
    expect(installerCommand(host, 'status', '/srv/tester/vault-suite-data/')).toBe(`'${SCRIPT}' status`);
    expect(installerCommand(host, 'install', '/data/vault')).toBe(`'${SCRIPT}' install --data-dir /data/vault`);
  });
});

describe('runCli names the command that started it', () => {
  function capture(isInteractive = false) {
    const output = { stdout: '', stderr: '' };
    const io = {
      stdout: (text: string) => { output.stdout += text; },
      stderr: (text: string) => { output.stderr += text; },
      isInteractive,
    };
    return { output, io };
  }

  function deps(overrides: Partial<Host> = {}): CliDeps {
    return {
      host: realFilesystemHost({ env: startedByScript, ...overrides }),
      cwd: '/',
      repoRoot: REPO_ROOT,
      analyzerCommand: SOURCE_ANALYZER,
      createInteractivePrompter: () => { throw new Error('this test never prompts interactively'); },
      now: () => new Date('2026-10-26T12:00:00Z'),
    };
  }

  it('in the usage text', async () => {
    const help = capture();
    const bad = capture();

    await runCli(['--help'], help.io, deps());
    await runCli(['frobnicate'], bad.io, deps());

    expect(help.output.stdout).toContain(`Usage: '${SCRIPT}' <plan|install|status|undo|uninstall> [options]`);
    expect(bad.output.stderr).toContain(`Usage: '${SCRIPT}' <plan|install|status|undo|uninstall> [options]`);
  });

  it('when a practice run ends, with its data directory', async () => {
    const vault = await makeTree({ 'Note.md': '# Note\n' });
    const answers = join(await makeTree({}), 'answers.json');
    await writeFile(answers, JSON.stringify({ version: 1, vault: { path: vault } }));
    const run = capture();

    const code = await runCli(['plan', '--answers', answers, '--data-dir', '/data/vault', '--skip-network-check'], run.io, deps());

    expect(code).toBe(EXIT_OK);
    expect(run.output.stdout).toContain(`When you are ready, run \`'${SCRIPT}' install --data-dir /data/vault\`.`);
  });

  it('to the interactive prompter, for the message shown on Ctrl+C', async () => {
    const run = capture(true);
    let resume: string | undefined;

    await runCli(['plan'], run.io, {
      ...deps(),
      createInteractivePrompter: command => {
        resume = command;
        // Stops the run at its first question; this test only needs the command.
        return { interactive: true, intro() { throw new Error('stop'); } } as unknown as Prompter;
      },
    }).catch(() => undefined);

    expect(resume).toBe(`'${SCRIPT}' install`);
  });
});
