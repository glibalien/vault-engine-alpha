import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_OK, runCli, type CliDeps } from '../src/cli.js';
import { EngineToolError, type EngineCall } from '../src/engine-client.js';
import type { Host } from '../src/host.js';
import { OBSIDIAN_PLUGIN_ID, PLUGIN_BUNDLE, type ObsidianPluginOutcome } from '../src/obsidian.js';
import type { Prompter } from '../src/prompter.js';
import type { ServiceBackend } from '../src/services.js';
import type { InstallState } from '../src/state.js';
import { shellCommand } from '../src/text.js';
import { UNIT_DIR } from '../src/units.js';
import { fakeEngineTools, fm, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

const KEYS = {
  TEST_ANTHROPIC: 'sk-ant-test-0123456789',
  TEST_GEMINI: 'gemini-test-0123456789',
  TEST_DEEPGRAM: 'deepgram-test-0123456789',
};
const INSTALLED_AT = '2026-10-26T12:00:00Z';
const LATER = '2026-10-26T13:00:00Z';
const ENGINE_UNIT_PATH = join(UNIT_DIR, 'vault-engine.service');
const CURATOR_UNIT_PATH = join(UNIT_DIR, 'vault-curator.service');
const OPERATIONS = ['op1', 'op2', 'op3', 'op4', 'op5'];
/** install.sh's path, as install.sh hands it to the installer (#439). */
const INSTALLER = '/opt/vault/install.sh';
/** The command line messages name for `command` against the install in `dataDir`. */
const named = (command: string, dataDir: string) => `${INSTALLER} ${command} --data-dir ${dataDir}`;

/**
 * A machine with the installer's outside world faked: systemd's unit folder (which the
 * service backend installs into and `sudo rm` removes from), every sudo command, Engine's
 * token scripts, and Engine's tools, with `undo-operations` answering as Engine does.
 */
function machine(options: { macHome?: string } = {}) {
  const units = new Map<string, string>();
  /** On a Mac: the launchd agents loaded, by label; their files are real, under `macHome`. */
  const loaded = new Set<string>();
  const agents = options.macHome ? join(options.macHome, 'Library', 'LaunchAgents') : null;
  const sudo: string[][] = [];
  const minted: string[] = [];
  const revoked: string[] = [];
  /** Each sudo command and token revoke, in order: `sudo <command>`, `revoke <service> <name>`. */
  const events: string[] = [];
  const state = { engineUp: true, sudoExit: 0 as number | null, revokeFails: [] as Array<'engine' | 'curator'> };
  const undo = {
    calls: [] as Array<Record<string, unknown>>,
    conflicts: [] as Array<{ node_id: string; file_path: string; reason: string }>,
    refuse: null as EngineToolError | null,
  };
  let dataDir = '';

  const backend: ServiceBackend = {
    start: async unit => {
      if (agents) {
        const label = unit.replace(/\.service$/, '');
        await mkdir(agents, { recursive: true });
        await writeFile(join(agents, `${label}.plist`), await readFile(join(dataDir, 'installer', 'units', `${label}.plist`), 'utf8'));
        loaded.add(label);
        return;
      }
      units.set(join(UNIT_DIR, unit), await readFile(join(dataDir, 'installer', 'units', unit), 'utf8'));
    },
    restart: async () => {},
    startedAt: async () => new Date(0),
    health: async () => ({ stopped: false, restarts: 0, detail: 'running' }),
    recentLogs: async () => '',
    logCommand: unit => `journalctl -u ${unit}`,
  };
  const tools = fakeEngineTools([{ file_path: 'Inbox.md' }, { file_path: 'Projects/Alpha.md' }]);
  const call = (async (tool: string, args: Record<string, unknown> = {}) => {
    if (tool !== 'undo-operations') return tools.call(tool, args);
    undo.calls.push(args);
    if (undo.refuse) throw undo.refuse;
    const dry = args.dry_run !== false;
    const ids = args.operation_ids as string[];
    // Adoption made two fields (op1, op2), two types (op3, op4), and one batch of notes (op5).
    return {
      dry_run: dry,
      operations: ids.map(id => ({
        operation_id: id,
        node_count: id === 'op5' ? 2 : 0,
        schema_count: id === 'op3' || id === 'op4' ? 1 : 0,
        global_field_count: id === 'op1' || id === 'op2' ? 1 : 0,
        status: dry ? 'would_undo' : 'undone',
      })),
      conflicts: undo.conflicts,
      total_undone: dry ? 0 : 2 - new Set(undo.conflicts.map(conflict => conflict.node_id)).size,
      total_conflicts: undo.conflicts.length,
      total_skipped: 0,
    };
  }) as EngineCall;

  const base = realFilesystemHost();
  const host: Host = realFilesystemHost({
    env: name => name === 'VAULT_INSTALLER_COMMAND' ? INSTALLER : (KEYS as Record<string, string>)[name],
    // Only systemd's unit folder is faked; the data directory and vault are real.
    pathExists: async path => path.startsWith(`${UNIT_DIR}/`) ? units.has(path) : base.pathExists(path),
    readText: async path => path.startsWith(`${UNIT_DIR}/`) ? units.get(path) ?? null : base.readText(path),
    httpStatus: async () => state.engineUp ? 200 : null,
    ...(options.macHome ? { platform: 'darwin' as const, arch: 'arm64', homeDir: options.macHome } : {}),
    run: async (command, args) => {
      if (command === 'launchctl') {
        events.push(`launchctl ${args.join(' ')}`);
        const label = args[1]?.split('/')[2];
        if (args[0] === 'print') return { code: label === undefined || loaded.has(label) ? 0 : 113, stdout: '', stderr: '' };
        if (args[0] === 'bootout' && label) loaded.delete(label);
        return { code: 0, stdout: '', stderr: '' };
      }
      const script = args.find(arg => arg.endsWith('issue-service-token.ts'));
      if (!script) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('--revoke')) {
        const service = script.includes(`${join('packages', 'curator')}/`) ? 'curator' : 'engine';
        events.push(`revoke ${service} ${args[args.indexOf('--name') + 1]}`);
        if (state.revokeFails.includes(service)) return { code: 1, stdout: '', stderr: 'Error: unable to open database file' };
        revoked.push(script);
        return { code: 0, stdout: 'Revoked 1 token\n', stderr: '' };
      }
      const token = randomBytes(32).toString('hex');
      minted.push(token);
      return { code: 0, stdout: `Issued service token\n  Authorization: Bearer ${token}\n`, stderr: '' };
    },
    runAttached: async (_command, args) => {
      sudo.push(args);
      const command = args[0] === '-n' ? args.slice(1) : args;
      events.push(`sudo ${command.join(' ')}`);
      if (state.sudoExit === 0 && command[0] === 'rm') for (const path of command.slice(1)) units.delete(path);
      return state.sudoExit;
    },
  });

  const deps = (now: string, prompter?: Prompter): CliDeps => ({
    host,
    cwd: '/',
    repoRoot: REPO_ROOT,
    analyzerCommand: SOURCE_ANALYZER,
    createInteractivePrompter: () => {
      if (!prompter) throw new Error('this test never prompts interactively');
      return prompter;
    },
    now: () => new Date(now),
    serviceBackend: () => backend,
    connectEngine: () => call,
    connectCurator: () => (async () => ({
      daily_budget: { cap_usd: 1 },
      server: { next_sweep_at: '2026-10-27T05:00:00.000Z', wiki_reconciliation_mode: 'live' },
    })) as unknown as EngineCall,
  });

  return { units, loaded, agents, sudo, minted, revoked, events, state, undo, deps, setDataDir: (path: string) => { dataDir = path; } };
}

/** A finished install (with Curator unless `synced`, a Curator-less install into a synced folder), on the faked machine. */
async function installed(options: { synced?: boolean; mac?: boolean } = {}) {
  const notes = {
    'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
    'Inbox.md': '# Inbox\n',
    'Attachments/scan.png': 'png',
  };
  const vault = options.synced
    ? join(await makeTree(Object.fromEntries(Object.entries(notes).map(([path, text]) => [`Dropbox/Vault/${path}`, text]))), 'Dropbox', 'Vault')
    : await makeTree(notes);
  const dataDir = join(await makeTree({}), 'vault-suite-data');
  const answers = join(await makeTree({}), 'answers.json');
  await writeFile(answers, JSON.stringify({
    version: 1,
    vault: { path: vault },
    providers: { anthropic: 'env:TEST_ANTHROPIC', gemini: 'env:TEST_GEMINI', deepgram: 'env:TEST_DEEPGRAM' },
    models: { vision_provider: 'gemini' },
    curator: { install: !options.synced },
  }));
  const world = machine(options.mac ? { macHome: await makeTree({}) } : {});
  world.setDataDir(dataDir);
  const run = async (argv: string[], now = LATER, prompter?: Prompter) => {
    const output = { stdout: '', stderr: '' };
    const code = await runCli(argv, {
      stdout: text => { output.stdout += text; },
      stderr: text => { output.stderr += text; },
      isInteractive: prompter !== undefined,
    }, world.deps(now, prompter));
    return { code, ...output };
  };
  const install = (now = INSTALLED_AT) => run(['install', '--answers', answers, '--data-dir', dataDir, '--skip-network-check', '--yes'], now);
  const first = await install();
  expect(first.code).toBe(EXIT_OK);
  // The fake Engine answers undo-operations for adoption's five operations (two field
  // definitions, two types, one batch of notes). How many adoption records depends on what
  // the plan creates (#451 creates no starter note type), so the state names those five.
  const adopted = await readState(dataDir);
  adopted.stages.adopt!.operations = [...OPERATIONS];
  await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(adopted));
  return { vault, dataDir, world, run, install };
}

async function readState(dataDir: string): Promise<InstallState> {
  return JSON.parse(await readFile(join(dataDir, 'installer', 'state.json'), 'utf8')) as InstallState;
}

/**
 * As if the install's last step had ended with the Obsidian plugin `outcome` in an Obsidian
 * vault (undefined: never asked), with a plugin folder in the vault unless `folder` is false.
 */
async function withPlugin(vault: string, dataDir: string, outcome: ObsidianPluginOutcome | undefined, folder = true): Promise<string> {
  const state = await readState(dataDir);
  state.plan.vault!.obsidian = true;
  state.stages.handoff!.obsidian_plugin = outcome;
  await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));
  const plugin = join(vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID);
  if (folder) {
    await mkdir(plugin, { recursive: true });
    for (const file of [...PLUGIN_BUNDLE, 'data.json']) await writeFile(join(plugin, file), `plugin ${file}`);
  }
  return plugin;
}

/** The plugin's token revokes since `from` events. */
const pluginRevokes = (events: readonly string[], from = 0) => events.slice(from).filter(event => event.startsWith('revoke') && event.endsWith(' obsidian'));

async function present(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** An interactive user who answers each confirmation in turn. */
function interactive(confirms: boolean[]) {
  const shown: string[] = [];
  const prompter: Prompter = {
    interactive: true,
    intro() {},
    welcome() {},
    step() {},
    success() {},
    outro: message => { shown.push(message); },
    note: message => { shown.push(message); },
    info: message => { shown.push(message); },
    warn: message => { shown.push(message); },
    text: async () => { throw new Error('no questions'); },
    select: async () => { throw new Error('no questions'); },
    confirm: async () => confirms.shift() ?? false,
    multiselect: async () => { throw new Error('no questions'); },
    secret: async () => { throw new Error('no questions'); },
    decide: async () => { throw new Error('no questions'); },
    rejectAnswer(_id, reason) { throw new Error(reason); },
    spinner: () => ({ stop() {} }),
  };
  return { prompter, shown };
}

describe('vault-installer undo', () => {
  it('previews the undo and changes nothing headlessly without --yes', async () => {
    const { dataDir, world, run } = await installed();
    const revokedBefore = world.revoked.length;

    const result = await run(['undo', '--data-dir', dataDir]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Engine would undo 5 operations from organizing your notes:');
    expect(result.stdout).toContain('- Notes: 2 note changes, so each note gets back the types and values it had.');
    expect(result.stdout).toContain('- Types: 2 changes; types organizing created are removed.');
    expect(result.stdout).toContain('- Fields: the 2 fields organizing defined are removed; notes keep their values for them, unmanaged again.');
    expect(result.stdout).toContain('Engine keeps these changes until about 2026-10-27T12:00:00.000Z.');
    expect(result.stdout).toContain('Nothing was changed. Run again with --yes to undo these changes.');
    // One dry run of every operation adoption made, field definitions included (#468).
    expect(world.undo.calls).toEqual([
      { operation_ids: OPERATIONS, dry_run: true },
    ]);
    expect((await readState(dataDir)).stages.adopt?.operations).toEqual(OPERATIONS);
    // The finished install keeps no installer token: the one minted for undo is revoked.
    expect(world.revoked.length).toBe(revokedBefore + 2);
    expect(await present(join(dataDir, 'installer', 'installer.env'))).toBe(false);
  });

  it('undoes adoption with --yes, keeps notes changed since, and records it', async () => {
    const { dataDir, world, run } = await installed();
    const changed = { node_id: 'n2', file_path: 'Projects/Alpha.md', reason: 'modified_after_operation' };
    world.undo.conflicts = [changed, { ...changed, reason: 'superseded_by_later_op' }];

    const result = await run(['undo', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('1 note changed after organizing keeps its current content: Projects/Alpha.md.');
    expect(world.undo.calls[1]).toEqual({
      operation_ids: OPERATIONS,
      dry_run: false,
      resolve_conflicts: [{ node_id: 'n2', action: 'skip' }],
    });
    expect(result.stdout).toContain('Undid 1 note change.');
    expect(result.stdout).toContain('The changes organizing your notes made are undone.\n1 note changed after organizing kept its current content: Projects/Alpha.md.');
    expect((await readState(dataDir)).stages.adopt).toMatchObject({ operations: [], undone_at: '2026-10-26T13:00:00.000Z' });

    const again = await run(['undo', '--data-dir', dataDir, '--yes']);

    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).toContain('were undone on 2026-10-26T13:00:00.000Z. Nothing was changed.');
    expect(world.undo.calls).toHaveLength(2);
  });

  it('undoes an adoption that only defined fields, since Engine keeps their values in the notes', async () => {
    const { dataDir, world, run } = await installed();
    const state = await readState(dataDir);
    state.stages.adopt!.operations = ['op1', 'op2'];
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));

    const result = await run(['undo', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Engine would undo 2 operations from organizing your notes:');
    expect(result.stdout).toContain('- Fields: the 2 fields organizing defined are removed; notes keep their values for them, unmanaged again.');
    expect(world.undo.calls).toEqual([
      { operation_ids: ['op1', 'op2'], dry_run: true },
      { operation_ids: ['op1', 'op2'], dry_run: false },
    ]);
    expect((await readState(dataDir)).stages.adopt).toMatchObject({ operations: [], undone_at: '2026-10-26T13:00:00.000Z' });
  });

  it('asks first when interactive, and undoes nothing when declined', async () => {
    const { dataDir, world, run } = await installed();
    const user = interactive([false]);

    const result = await run(['undo', '--data-dir', dataDir], LATER, user.prompter);

    expect(result.code).toBe(EXIT_OK);
    expect(user.shown).toContain('Nothing was changed.');
    expect(world.undo.calls.every(call => call.dry_run === true)).toBe(true);
  });

  it('points to the backup when Engine no longer has the changes', async () => {
    const { vault, dataDir, world, run } = await installed();
    world.undo.refuse = new EngineToolError('OPERATION_NOT_FOUND', "undo-operations failed: Operation 'op1' is not active or does not exist.");

    const result = await run(['undo', '--data-dir', dataDir, '--yes'], '2026-10-28T12:00:00Z');

    expect(result.code).toBe(EXIT_BLOCKED);
    const backup = join(dataDir, 'installer', 'backups', '20261026T120000Z');
    expect(result.stdout).toContain('Engine no longer has these changes to undo. It keeps them for 24 hours (organizing started 2026-10-26T12:00:00.000Z)');
    expect(result.stdout).toContain(`Your notes as they were before installing are in ${join(backup, 'vault')}`);
    expect(result.stdout).toContain(`cp -a ${join(backup, 'vault')}/. ${vault}/`);
    expect((await readState(dataDir)).stages.adopt?.operations).toEqual(OPERATIONS);
  });

  it('needs Engine answering, and mints no token without it', async () => {
    const { dataDir, world, run } = await installed();
    world.state.engineUp = false;
    const minted = world.minted.length;

    const result = await run(['undo', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stdout).toContain('Engine is not answering at http://127.0.0.1:3334/mcp, and undo goes through it.');
    expect(result.stdout).toContain('Your notes as they were before installing are in');
    expect(world.minted.length).toBe(minted);
    expect(world.undo.calls).toEqual([]);
  });
});

describe('vault-installer uninstall on macOS', () => {
  it('unloads and removes the launchd agents it installed as the user, with no sudo', async () => {
    const { dataDir, world, run } = await installed({ mac: true });
    const agents = world.agents as string;
    const engineAgent = join(agents, 'vault-engine.plist');
    const curatorAgent = join(agents, 'vault-curator.plist');
    expect([...world.loaded].sort()).toEqual(['vault-curator', 'vault-engine']);

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Stops and removes the services this installation set up: vault-curator.service, vault-engine.service. The commands, each shown again as it runs:');
    expect(result.stdout).toContain('  launchctl bootout gui/$(id -u)/vault-curator');
    expect(result.stdout).toContain(`  rm ${curatorAgent} ${engineAgent}`);
    expect(result.stdout).toContain('Running: launchctl bootout gui/1000/vault-engine');
    expect(world.sudo).toEqual([]);
    expect(world.loaded.size).toBe(0);
    expect(await present(engineAgent)).toBe(false);
    expect(await present(curatorAgent)).toBe(false);
    const aside = join(dataDir, 'uninstalled-20261026T130000Z');
    expect((await readdir(join(aside, 'installer', 'units'))).sort()).toEqual(['vault-curator.plist', 'vault-engine.plist']);
    expect(result.stdout).not.toContain('sudo');
  });

  it('keeps an agent changed since it was installed, and says how to remove it', async () => {
    const { dataDir, world, run } = await installed({ mac: true });
    const engineAgent = join(world.agents as string, 'vault-engine.plist');
    await writeFile(engineAgent, '<plist>edited</plist>\n');

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stdout).toContain(`${engineAgent} changed after the installer wrote it (${join(dataDir, 'installer', 'units', 'vault-engine.plist')})`);
    expect(result.stdout).toContain('  launchctl bootout gui/$(id -u)/vault-engine');
    expect(world.loaded.has('vault-engine')).toBe(true);
  });
});

describe('vault-installer uninstall', () => {
  it('shows what it would do and changes nothing headlessly without --yes', async () => {
    const { dataDir, world, run } = await installed();

    const result = await run(['uninstall', '--data-dir', dataDir]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Stops and removes the services this installation set up: vault-curator.service, vault-engine.service.');
    expect(result.stdout).toContain(`  sudo rm ${CURATOR_UNIT_PATH} ${ENGINE_UNIT_PATH}`);
    expect(result.stdout).toContain('Nothing was changed. Run again with --yes to uninstall.');
    expect(world.sudo).toEqual([]);
    expect(world.units.size).toBe(2);
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(true);
  });

  it('removes the units it installed and sets its files aside, so a new install starts fresh', async () => {
    const { vault, dataDir, world, run, install } = await installed();
    // What Engine and Curator would have made while they ran.
    await mkdir(join(vault, '.vault-engine'));
    await writeFile(join(vault, '.vault-engine', 'vault.db'), '');
    await writeFile(join(dataDir, 'curator.db'), '');
    // An override the user added with `systemctl edit`.
    world.units.set(`${ENGINE_UNIT_PATH}.d`, '');

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    // Organizing can still be undone, which needs Engine: the user is told before it stops.
    expect(result.stdout).toContain(`Until about 2026-10-27T12:00:00.000Z, \`${named('undo', dataDir)}\` can undo that, but only while Engine runs`);
    expect(world.sudo).toEqual([
      ['-n', 'systemctl', 'disable', '--now', 'vault-curator.service', 'vault-engine.service'],
      ['-n', 'rm', CURATOR_UNIT_PATH, ENGINE_UNIT_PATH],
      ['-n', 'systemctl', 'daemon-reload'],
    ]);
    expect(result.stdout).toContain(`Running: sudo rm ${CURATOR_UNIT_PATH} ${ENGINE_UNIT_PATH}`);
    const aside = join(dataDir, 'uninstalled-20261026T130000Z');
    expect((await readdir(aside, { recursive: true })).sort()).toEqual([
      'curator.env', 'engine.env', 'installer', 'installer/state.json', 'installer/units',
      'installer/units/vault-curator.service', 'installer/units/vault-engine.service',
    ]);
    expect((await readdir(dataDir)).sort()).toEqual(['PUBLIC-ACCESS.md', 'curator.db', 'installer', 'uninstalled-20261026T130000Z']);
    expect(await readdir(join(dataDir, 'installer'))).toEqual(['backups']);
    // What stays, each with how to remove it.
    expect(result.stdout).toContain(`- The backup of your notes from before installing: ${join(dataDir, 'installer', 'backups', '20261026T120000Z', 'vault')}.`);
    expect(result.stdout).toContain(`Remove them with: rm -rf ${aside}`);
    expect(result.stdout).toContain(`- Engine's folder in your notes, ${join(vault, '.vault-engine')}, with its database and search model. A new install into ${vault} refuses while it is there. Remove it with: rm -rf ${join(vault, '.vault-engine')}`);
    expect(result.stdout).toContain(`- Curator's database: ${join(dataDir, 'curator.db')}.`);
    expect(result.stdout).toContain(`- ${ENGINE_UNIT_PATH}.d, overrides made for the removed unit. Remove it with: sudo rm -r ${ENGINE_UNIT_PATH}.d`);
    expect(result.stdout).toContain('Vault is uninstalled.');

    // Once Engine's folder and the override are removed, as the run says, the same install starts fresh.
    await rm(join(vault, '.vault-engine'), { recursive: true });
    world.units.delete(`${ENGINE_UNIT_PATH}.d`);
    const again = await install('2026-10-26T14:00:00Z');

    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).not.toContain('An existing installation was found');
    expect(world.units.size).toBe(2);
  });

  it('removes only Engine\'s unit without Curator, and names a database kept outside a synced folder', async () => {
    const { dataDir, world, run } = await installed({ synced: true });
    await writeFile(join(dataDir, 'vault.db'), '');
    await mkdir(join(dataDir, 'models'));

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(world.sudo).toEqual([
      ['-n', 'systemctl', 'disable', '--now', 'vault-engine.service'],
      ['-n', 'rm', ENGINE_UNIT_PATH],
      ['-n', 'systemctl', 'daemon-reload'],
    ]);
    const database = join(dataDir, 'vault.db');
    expect(result.stdout).toContain(`- Engine's database: ${database}. A new install with this data directory would use it again. Remove it with: rm -f ${database} ${database}-wal ${database}-shm`);
    expect(result.stdout).toContain(`- Engine's search model: ${join(dataDir, 'models')}. A new install reuses it.`);
    expect((await readdir(dataDir)).sort()).toEqual(['PUBLIC-ACCESS.md', 'installer', 'models', 'uninstalled-20261026T130000Z', 'vault.db']);
  });

  it('stops when an interactive user says the --no-sudo commands ran but the units are still there', async () => {
    const { dataDir, world, run } = await installed();
    const user = interactive([true, true]);

    const result = await run(['uninstall', '--data-dir', dataDir, '--no-sudo'], LATER, user.prompter);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(user.shown).toContain(`${CURATOR_UNIT_PATH} and ${ENGINE_UNIT_PATH} are still installed, so nothing else was changed. Remove them and run \`${named('uninstall', dataDir)}\` again.`);
    expect(world.sudo).toEqual([]);
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(true);
  });

  it('runs sudo on the terminal after an interactive yes', async () => {
    const { dataDir, world, run } = await installed();
    const user = interactive([true]);

    const result = await run(['uninstall', '--data-dir', dataDir], LATER, user.prompter);

    expect(result.code).toBe(EXIT_OK);
    expect(world.sudo[0]).toEqual(['systemctl', 'disable', '--now', 'vault-curator.service', 'vault-engine.service']);
    expect(user.shown).toContain(`Vault is uninstalled. Once you have removed what you no longer need from the list above, \`${named('install', dataDir)}\` can install it again.`);
  });

  it('refuses, changing nothing, when an installed unit changed after the installer wrote it', async () => {
    const { dataDir, world, run } = await installed();
    world.units.set(ENGINE_UNIT_PATH, `${world.units.get(ENGINE_UNIT_PATH)}# edited\n`);

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stdout).toContain(`${ENGINE_UNIT_PATH} changed after the installer wrote it`);
    expect(result.stdout).toContain('  sudo systemctl disable --now vault-engine.service');
    expect(result.stdout).toContain('Nothing was changed.');
    expect(world.sudo).toEqual([]);
    expect(world.units.size).toBe(2);
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(true);
  });

  it('leaves a unit the saved progress does not say it installed', async () => {
    const { dataDir, world, run } = await installed();
    // As if the install had stopped before starting either service.
    const state = await readState(dataDir);
    delete state.stages.engine;
    delete state.stages.curator;
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(world.sudo).toEqual([]);
    expect(world.units.size).toBe(2);
    expect(result.stdout).toContain(`${ENGINE_UNIT_PATH} was not installed by this installation, so it stays.`);
    expect(result.stdout).toContain(`- ${ENGINE_UNIT_PATH}, which this installation did not install. A new install refuses while it is there.`);
  });

  it('prints the root commands with --no-sudo and finishes once they have been run', async () => {
    const { dataDir, world, run } = await installed();

    const paused = await run(['uninstall', '--data-dir', dataDir, '--yes', '--no-sudo']);

    expect(paused.code).toBe(EXIT_BLOCKED);
    expect(paused.stdout).toContain(`Run these as root to stop and remove the Vault services\nsudo systemctl disable --now vault-curator.service vault-engine.service\nsudo rm ${CURATOR_UNIT_PATH} ${ENGINE_UNIT_PATH}\nsudo systemctl daemon-reload`);
    expect(paused.stdout).toContain(`then run \`${named('uninstall', dataDir)}\` again. Nothing else was changed.`);
    expect(world.sudo).toEqual([]);
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(true);

    world.units.clear();
    const finished = await run(['uninstall', '--data-dir', dataDir, '--yes', '--no-sudo']);

    expect(finished.code).toBe(EXIT_OK);
    expect(finished.stdout).toContain('No service this installation set up is installed.');
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(false);
  });

  it('stops before moving anything when sudo fails', async () => {
    const { dataDir, world, run } = await installed();
    world.state.sudoExit = 1;

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stderr).toContain(`failed (exit 1). Run \`${named('uninstall', dataDir)}\` again with --no-sudo to run the root commands yourself.`);
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(true);
    expect(await present(join(dataDir, 'engine.env'))).toBe(true);
  });

  it('refuses saved progress that records another data directory', async () => {
    const { dataDir, world, run } = await installed();
    const moved = `${dataDir}-moved`;
    await rename(dataDir, moved);

    const result = await run(['uninstall', '--data-dir', moved, '--yes']);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stdout).toContain(`records an installation in ${dataDir}, so its files are not where it says. Nothing was changed.`);
    expect(world.sudo).toEqual([]);
  });
});

describe('vault-installer uninstall with the Obsidian plugin (#486)', () => {
  const REMOVE_UNITS = [
    'sudo systemctl disable --now vault-curator.service vault-engine.service',
    `sudo rm ${CURATOR_UNIT_PATH} ${ENGINE_UNIT_PATH}`,
    'sudo systemctl daemon-reload',
  ];

  it('revokes the plugin\'s tokens once the services are removed, and leaves its folder with how to remove it', async () => {
    const { vault, dataDir, world, run } = await installed();
    const plugin = await withPlugin(vault, dataDir, 'installed');
    const start = world.events.length;

    const preview = await run(['uninstall', '--data-dir', dataDir]);

    expect(preview.stdout).toContain(`Then revokes the tokens the installer made for the Obsidian plugin, on Engine and Curator, so the plugin no longer connects. Its folder, ${plugin}, stays.`);
    expect(preview.stdout).toContain('Nothing was changed. Run again with --yes to uninstall.');
    expect(world.events.slice(start)).toEqual([]);

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(world.events.slice(start)).toEqual([...REMOVE_UNITS, 'revoke engine obsidian', 'revoke curator obsidian']);
    expect(result.stdout).toContain('Revoked the Obsidian plugin\'s tokens.');
    expect(result.stdout).toContain(`- The Vault Engine plugin the installer added to Obsidian, in ${plugin}, with its tokens revoked. To remove it, uninstall it in Obsidian (Settings → Community plugins), or delete its folder: ${shellCommand(['rm', '-rf', plugin])}`);
    // Nothing of the plugin is removed.
    expect((await readdir(plugin)).sort()).toEqual(['data.json', 'main.js', 'manifest.json', 'styles.css']);
    expect(await readFile(join(plugin, 'data.json'), 'utf8')).toBe('plugin data.json');
  });

  it.each<[ObsidianPluginOutcome | undefined]>([['kept'], ['declined'], ['not_built'], [undefined]])(
    'never revokes for, names, or touches a plugin folder the installer did not write (%s)',
    async outcome => {
      const { vault, dataDir, world, run } = await installed();
      const plugin = await withPlugin(vault, dataDir, outcome);
      await writeFile(join(plugin, 'data.json'), '{"token":"their own"}');
      const start = world.events.length;

      const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

      expect(result.code).toBe(EXIT_OK);
      expect(world.events.slice(start)).toEqual(REMOVE_UNITS);
      expect(result.stdout).not.toContain('Obsidian');
      expect(result.stdout).not.toContain(plugin);
      expect(await readFile(join(plugin, 'data.json'), 'utf8')).toBe('{"token":"their own"}');
      expect((await readdir(plugin)).sort()).toEqual(['data.json', 'main.js', 'manifest.json', 'styles.css']);
    },
  );

  it('revokes them with the services already stopped, and names no folder the user already removed', async () => {
    const { vault, dataDir, world, run } = await installed();
    await withPlugin(vault, dataDir, 'installed', false);
    // The services were stopped and their units removed by hand: the token scripts write
    // each service's database directly, so they need neither service.
    world.units.clear();
    world.state.engineUp = false;
    const start = world.events.length;

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('No service this installation set up is installed.');
    expect(world.events.slice(start)).toEqual(['revoke engine obsidian', 'revoke curator obsidian']);
    expect(result.stdout).toContain('Revoked the Obsidian plugin\'s tokens.');
    expect(result.stdout).not.toContain('The Vault Engine plugin the installer added');
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(false);
  });

  it('prints the exact revoke commands and finishes when a revoke fails', async () => {
    const { vault, dataDir, world, run } = await installed();
    const plugin = await withPlugin(vault, dataDir, 'installed');
    const { plan } = await readState(dataDir);
    world.state.revokeFails = ['engine', 'curator'];

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(pluginRevokes(world.events)).toEqual(['revoke engine obsidian', 'revoke curator obsidian']);
    expect(result.stdout).toContain('Could not revoke the Obsidian plugin\'s token on Engine and Curator; the list below says how.');
    const node = shellCommand([plan.services.node_path]);
    expect(result.stdout).toContain([
      '- The Obsidian plugin\'s token on Engine, which could not be revoked (Engine\'s token script failed (--name obsidian --revoke): Error: unable to open database file).',
      `Revoke it with: cd ${shellCommand([REPO_ROOT])} && VAULT_PATH=${shellCommand([vault])} DB_PATH=${shellCommand([plan.review.engine_database!])} ${node} --import tsx packages/engine/scripts/issue-service-token.ts --name obsidian --revoke`,
    ].join(' '));
    expect(result.stdout).toContain([
      '- The Obsidian plugin\'s token on Curator, which could not be revoked (Curator\'s token script failed (--name obsidian --revoke): Error: unable to open database file).',
      `Revoke it with: cd ${shellCommand([REPO_ROOT])} && CURATOR_DB_PATH=${shellCommand([join(dataDir, 'curator.db')])} ${node} --import tsx packages/curator/scripts/issue-service-token.ts --name obsidian --revoke`,
    ].join(' '));
    // The folder is still listed, without claiming its tokens are revoked, and the uninstall finished.
    expect(result.stdout).toContain(`- The Vault Engine plugin the installer added to Obsidian, in ${plugin}. To remove it`);
    expect(result.stdout).toContain('Vault is uninstalled.');
    expect(await present(join(dataDir, 'installer', 'state.json'))).toBe(false);
  });

  it('is safe to rerun: a run that stops at the root commands revokes nothing, and the next one finishes', async () => {
    const { vault, dataDir, world, run } = await installed();
    const plugin = await withPlugin(vault, dataDir, 'installed');

    world.state.sudoExit = 1;
    const failed = await run(['uninstall', '--data-dir', dataDir, '--yes']);
    expect(failed.code).toBe(EXIT_BLOCKED);
    world.state.sudoExit = 0;
    const paused = await run(['uninstall', '--data-dir', dataDir, '--yes', '--no-sudo']);
    expect(paused.code).toBe(EXIT_BLOCKED);
    expect(paused.stdout).toContain('Nothing else was changed.');
    expect(pluginRevokes(world.events)).toEqual([]);

    // The user runs the printed root commands, then uninstall again.
    world.units.clear();
    const finished = await run(['uninstall', '--data-dir', dataDir, '--yes', '--no-sudo']);

    expect(finished.code).toBe(EXIT_OK);
    expect(pluginRevokes(world.events)).toEqual(['revoke engine obsidian', 'revoke curator obsidian']);
    expect(finished.stdout).toContain(`in ${plugin}, with its tokens revoked.`);

    // Once uninstalled, there is nothing left to uninstall, and nothing is revoked again.
    const again = await run(['uninstall', '--data-dir', dataDir, '--yes']);
    expect(again.code).toBe(EXIT_BLOCKED);
    expect(pluginRevokes(world.events)).toHaveLength(2);
    expect((await readdir(plugin)).sort()).toEqual(['data.json', 'main.js', 'manifest.json', 'styles.css']);
  });

  it('revokes only Engine\'s token without Curator, including for a plugin a stopped run was adding', async () => {
    const { vault, dataDir, world, run } = await installed({ synced: true });
    const plugin = await withPlugin(vault, dataDir, 'installing');

    const result = await run(['uninstall', '--data-dir', dataDir, '--yes']);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(`Then revokes the tokens the installer made for the Obsidian plugin, so the plugin no longer connects. Its folder, ${plugin}, stays.`);
    expect(pluginRevokes(world.events)).toEqual(['revoke engine obsidian']);
    expect(result.stdout).toContain(`- The Vault Engine plugin the installer added to Obsidian, in ${plugin}, with its tokens revoked.`);
  });
});

describe('undo and uninstall without an installation', () => {
  it.each([['undo'], ['uninstall']])('%s refuses', async command => {
    const empty = await makeTree({});
    const world = machine();
    const output = { stdout: '', stderr: '' };

    const code = await runCli([command, '--data-dir', empty, '--yes'], {
      stdout: text => { output.stdout += text; },
      stderr: text => { output.stderr += text; },
      isInteractive: false,
    }, world.deps(LATER));

    expect(code).toBe(EXIT_BLOCKED);
    expect(output.stderr).toContain(`no installation in ${empty}`);
    expect(world.sudo).toEqual([]);
  });
});
