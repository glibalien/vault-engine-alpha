import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from '../src/cli.js';
import { parseArgs, UsageError } from '../src/args.js';
import type { Host } from '../src/host.js';
import type { Prompter } from '../src/prompter.js';
import { SETUP_MODE_QUESTION } from '../src/quick.js';
import { fm, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

function capture(isInteractive = false) {
  let stdout = '';
  let stderr = '';
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
      isInteractive,
    },
  };
}

function deps(hostOverrides: Partial<Host> = {}): CliDeps {
  return {
    host: realFilesystemHost(hostOverrides),
    cwd: '/',
    repoRoot: REPO_ROOT,
    analyzerCommand: SOURCE_ANALYZER,
    createInteractivePrompter: () => { throw new Error('tests never prompt interactively'); },
    now: () => new Date('2026-10-26T12:00:00Z'),
  };
}

async function answersFile(vaultPath: string): Promise<string> {
  const directory = await makeTree({});
  const path = join(directory, 'answers.json');
  await writeFile(path, JSON.stringify({ version: 1, vault: { path: vaultPath } }));
  return path;
}

describe('runCli plan', () => {
  it('prints only the JSON plan on stdout with --json and reports progress on stderr', async () => {
    const vault = await makeTree({ 'Projects/A.md': fm({ type: 'project' }) });
    const output = capture();

    const code = await runCli(['plan', '--answers', await answersFile(vault), '--json', '--skip-network-check'], output.io, deps());

    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(output.stdout);
    expect(report).toMatchObject({
      format: 'vault-installer-plan',
      version: 1,
      generated_at: '2026-10-26T12:00:00.000Z',
      repo_root: REPO_ROOT,
      data_dir: '/srv/tester/vault-suite-data',
      vault: {
        exclusions: [],
        settings_dir: 'Settings',
        analyzer_version: '2.1.0',
        top_level_folders: [{ path: 'Projects', notes: 1 }],
        type_field_candidates: [{ key: 'type', notes: 1, samples: ['project'] }],
      },
      structure: {
        source: 'field',
        analyzer_spec: { type_field: 'type', folder_rules: [], type_renames: {}, exclude: ['Settings'] },
        typed_notes: 1,
        untyped_notes: 0,
        // No note type and no status field: only what the notes have.
        types: [
          { name: 'project', from: 'vault', role: 'project', notes: 1, default_directory: 'Projects', fields: [] },
        ],
        roles: { project: 'project', task: null, meeting: null, person: null, company: null },
      },
      vault_map: {
        kinds: { project: { type: 'project', from: 'vault' }, task: { type: null, from: null } },
        status: { project: { field: null, from: null, active: [] } },
        folders: { wiki_dir: 'Wikis', topic_dir: null },
      },
    });
    expect(report.vault_map.off).toContainEqual(expect.stringContaining('Projects have no status field'));
    expect(report.structure.source_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.preflight.map((check: { id: string }) => check.id)).toContain('ports');
    expect(output.stderr).toContain('Vault Installer · practice run');
  });

  it('plans an empty folder with every kind none', async () => {
    const vault = await makeTree({});
    const output = capture();

    const code = await runCli(['plan', '--answers', await answersFile(vault), '--json', '--skip-network-check'], output.io, deps());

    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(output.stdout);
    expect(report.vault).toMatchObject({ inventory: { markdown_files: 0 }, top_level_folders: [], type_field_candidates: [] });
    expect(report.structure).toMatchObject({ source: 'none', source_fingerprint: null, typed_notes: 0, untyped_notes: 0 });
    // No starter kind is created unless asked for (#451).
    expect(report.structure.types).toEqual([]);
  });

  it('writes the plan to --out and renders a readable summary', async () => {
    const vault = await makeTree({ 'Note.md': '# Note\n' });
    const outDirectory = await makeTree({});
    const outPath = join(outDirectory, 'plan.json');
    const output = capture();

    const code = await runCli(
      ['plan', '--answers', await answersFile(vault), '--out', outPath, '--skip-network-check'],
      output.io,
      deps(),
    );

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toMatchObject({ format: 'vault-installer-plan' });
    expect(output.stdout).toContain('1 Markdown file');
    expect(output.stdout).toContain(`Plan written to ${outPath}`);
    expect(output.stdout).toContain('All done. Nothing on this computer was changed.');
  });

  it('exits 1 when a check fails, and still inspects the vault', async () => {
    const vault = await makeTree({ 'Note.md': '# Note\n' });
    const output = capture();

    const code = await runCli(
      ['plan', '--answers', await answersFile(vault), '--json', '--skip-network-check'],
      output.io,
      deps({ platform: 'darwin' }),
    );

    expect(code).toBe(EXIT_BLOCKED);
    expect(JSON.parse(output.stdout).vault).not.toBeNull();
  });

  it('skips the vault when the repository is not built', async () => {
    const output = capture();

    const code = await runCli(
      ['plan', '--answers', await answersFile('/unused'), '--json', '--skip-network-check'],
      output.io,
      deps({ pathExists: async path => path === '/run/systemd/system' }),
    );

    expect(code).toBe(EXIT_BLOCKED);
    expect(JSON.parse(output.stdout).vault).toBeNull();
  });

  it('exits 2 for a bad answers file or no terminal without one', async () => {
    const directory = await makeTree({ 'answers.json': JSON.stringify({ version: 1, vault: { path: '/x', extra: 1 } }) });
    const badAnswers = capture();
    const noTerminal = capture(false);

    const badCode = await runCli(['plan', '--answers', join(directory, 'answers.json')], badAnswers.io, deps());
    const noTerminalCode = await runCli(['plan'], noTerminal.io, deps());

    expect(badCode).toBe(EXIT_USAGE);
    expect(badAnswers.stderr).toMatch(/invalid answers file .*vault/);
    expect(noTerminalCode).toBe(EXIT_USAGE);
    expect(noTerminal.stderr).toContain('pass --answers');
  });

  it('uses the interactive prompter when attached to a terminal', async () => {
    const vault = await makeTree({ 'Note.md': '# Note\n' });
    const { asked } = await interactivePlan(vault, null);

    expect(asked).toEqual([
      // The folders are offered with their usual names. The notes step's map is taken as
      // found ("Looks good"), so none of its questions is asked.
      'vault.path', 'vault.exclude', 'vault.settings_dir', 'vault.wiki_dir', 'vault.topic_dir',
      // Nothing is ticked, so no key is asked for.
      'providers',
      // With no model key, Curator defaults to not installed and there is no model to choose.
      'curator.install',
      'backup.mode',
    ]);
  });

  it('does not ask the journal kind again in the Curator step after the map settled it', async () => {
    const vault = await makeTree({ 'Projects/A.md': fm({ types: 'project' }) });
    const { asked, notes } = await interactivePlan(vault, 'providers.anthropic');

    expect(asked).toContain('curator.daily_budget_cents');
    expect(asked).not.toContain('curator.journal_type');
    expect(notes.join('\n')).toContain('  Curator\'s journal: note (a new kind; Curator creates it when it first writes)');
  });
});

/**
 * An interactive `plan` through "Choose everything" that takes every default, with a key
 * typed for `keyFor`; what it asked and the notes it showed.
 */
async function interactivePlan(vault: string, keyFor: string | null) {
  const asked: string[] = [];
  const notes: string[] = [];
  const prompter: Prompter = {
    interactive: true,
    intro() {},
    welcome() {},
    step() {},
    success() {},
    outro() {},
    note(message) { notes.push(message); },
    info() {},
    warn() {},
    async text(question) { asked.push(question.id); return question.id === 'vault.path' ? vault : question.defaultValue ?? ''; },
    async select(question) { asked.push(question.id); return question.initialValue; },
    async confirm(question) {
      // Choose everything (#434), and see every box of the review (#437).
      if (question.message === SETUP_MODE_QUESTION.message) return false;
      if (question.message === 'Show every file and command?') return true;
      return question.initialValue;
    },
    async multiselect(question) {
      asked.push(question.id);
      // The key tick-list (#436): tick the service whose key is typed.
      if (question.id === 'providers' && keyFor !== null) return [keyFor.replace(/^providers\./, '')];
      return question.initialValues;
    },
    async secret(question) { asked.push(question.id); return question.id === keyFor ? { source: 'entered', value: 'sk-ant-test-key' } : null; },
    async decide(question) { asked.push(question.id); return question.defaultValue(); },
    rejectAnswer(_id, reason) { throw new Error(reason); },
    spinner: () => ({ stop() {} }),
  };
  const output = capture(true);

  const code = await runCli(['plan', '--skip-network-check'], output.io, {
    ...deps(),
    createInteractivePrompter: () => prompter,
  });

  expect(code).toBe(EXIT_OK);
  return { asked, notes };
}

describe('runCli', () => {
  it('prints help and the version', async () => {
    const help = capture();
    const version = capture();

    expect(await runCli([], help.io, deps())).toBe(EXIT_OK);
    expect(await runCli(['--version'], version.io, deps())).toBe(EXIT_OK);
    expect(help.stdout).toContain('Usage: vault-installer <plan|install|status|undo|uninstall>');
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('parseArgs', () => {
  it('parses plan options', () => {
    expect(parseArgs(['plan', '--answers', 'a.json', '--json', '--out', 'p.json', '--data-dir', '~/d', '--repo', '.', '--skip-network-check']))
      .toEqual({
        command: 'plan',
        answers: 'a.json',
        json: true,
        out: 'p.json',
        dataDir: '~/d',
        repo: '.',
        checkNetwork: false,
      });
  });

  it('parses install options', () => {
    expect(parseArgs(['install', '--answers', 'a.json', '--yes', '--data-dir', '~/d']))
      .toEqual({ command: 'install', answers: 'a.json', yes: true, sudo: true, dataDir: '~/d', checkNetwork: true });
    expect(parseArgs(['install', '--no-sudo', '--engine-port', '4334', '--curator-port', '4335']))
      .toEqual({ command: 'install', yes: false, sudo: false, enginePort: 4334, curatorPort: 4335, checkNetwork: true });
  });

  it('parses status, which takes only a data directory', () => {
    expect(parseArgs(['status'])).toEqual({ command: 'status' });
    expect(parseArgs(['status', '--data-dir', '~/d'])).toEqual({ command: 'status', dataDir: '~/d' });
  });

  it('parses undo and uninstall, which take a data directory, --yes, and (uninstall) --no-sudo', () => {
    expect(parseArgs(['undo'])).toEqual({ command: 'undo', yes: false });
    expect(parseArgs(['undo', '--yes', '--data-dir', '~/d'])).toEqual({ command: 'undo', dataDir: '~/d', yes: true });
    expect(parseArgs(['uninstall'])).toEqual({ command: 'uninstall', yes: false, sudo: true });
    expect(parseArgs(['uninstall', '--data-dir', '~/d', '--no-sudo', '--yes']))
      .toEqual({ command: 'uninstall', dataDir: '~/d', yes: true, sudo: false });
  });

  it.each([
    [['upgrade']],
    [['undo', '--no-sudo']],
    [['undo', '--answers', 'a.json']],
    [['uninstall', '--data-dir']],
    [['uninstall', '--yes', '--yes']],
    [['uninstall', '--skip-network-check']],
    [['plan', '--yes']],
    [['install', '--json']],
    [['install', '--out', 'plan.json']],
    [['plan', '--no-sudo']],
    [['plan', '--engine-port', '0']],
    [['plan', '--engine-port', '3335']],
    [['install', '--curator-port', 'x']],
    [['plan', '--verbose']],
    [['plan', '--answers']],
    [['plan', '--json']],
    [['plan', '--out', 'a', '--out', 'b']],
    [['status', '--yes']],
    [['status', '--data-dir']],
    [['status', '--data-dir', '~/d', '--yes']],
  ])('rejects %j', argv => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});
