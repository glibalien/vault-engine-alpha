import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { firstThingToTry, ownerPasswordCommand, runHandoffStage } from '../src/handoff.js';
import type { Host } from '../src/host.js';
import { OBSIDIAN_PLUGIN_ID, PLUGIN_BUNDLE } from '../src/obsidian.js';
import { createProgressPrompter, createScriptedPrompter, type Prompter } from '../src/prompter.js';
import { publicAccessGuide } from '../src/public-access.js';
import { SORTING_COMMAND } from '../src/sorting.js';
import { loadState, saveState, type InstallState } from '../src/state.js';
import type { KindSource, MapKind, VaultMapSummary } from '../src/vault-map.js';
import { makeTree, realFilesystemHost, removeTrees, REPO_ROOT, replayPrompter } from './helpers.js';

afterEach(removeTrees);

function plan(dataDir: string, curator: boolean): InstallState['plan'] {
  return {
    data_dir: dataDir,
    repo_root: '/srv/vault-suite',
    services: { user: 'tester', node_path: '/opt/node/bin/node', engine_port: 4334, curator_port: 4335 },
    vault: { path: '/notes' },
    curator: curator ? { daily_budget_cents: 100, sweep_at: '05:00', tz: 'UTC', wiki_mode: 'live' } : null,
    review: { engine_database: '/notes/.vault-engine/vault.db' },
  } as unknown as InstallState['plan'];
}

const NONE = { type: null, from: null };

function vaultMap(kinds: Partial<Record<MapKind, { type: string | null; from: KindSource | null }>> = {}): VaultMapSummary {
  const status = { field: null, from: null, active: [], done: [], blocked: [], backlog: [], ignored: [] };
  return {
    kinds: { project: NONE, task: NONE, meeting: NONE, person: NONE, company: NONE, journal: NONE, dailyNote: NONE, ...kinds },
    status: { project: status, task: status },
    // The map's other field names (#476), all none here.
    fields: { due: null, date: null, people: null, company: null, priority: null, scheduled: null },
    folders: { wiki_dir: 'Wikis', topic_dir: null },
    off: [],
  };
}

const ENGINE_TOKEN = '1'.repeat(64);
const CURATOR_TOKEN = '2'.repeat(64);

/**
 * A saved install at its last stage, in the shape `loadState` reads back: a vault (an
 * Obsidian vault unless `obsidian` is false), a checkout whose plugin is built unless
 * `bundle` is false, and Engine's and Curator's token scripts answered in memory.
 */
async function setup(input: {
  obsidian?: boolean;
  curator?: boolean;
  /** The answers file's `obsidian.install_plugin`; null when asked at the end. */
  answer?: boolean | null;
  bundle?: boolean;
  build?: 'ok' | 'fail';
  vaultFiles?: Record<string, string>;
  map?: VaultMapSummary | null;
} = {}) {
  const dataDir = await makeTree({ 'installer/installer.env': 'ENGINE_TOKEN=abc\n' });
  const repoRoot = await makeTree(input.bundle === false
    ? { 'packages/obsidian-plugin/': '' }
    : Object.fromEntries(PLUGIN_BUNDLE.map(file => [`packages/obsidian-plugin/${file}`, `checkout ${file}`])));
  const vault = await makeTree({
    'Inbox.md': '# Inbox\n',
    ...(input.obsidian === false ? {} : { '.obsidian/app.json': '{}\n' }),
    ...input.vaultFiles,
  });
  const curator = input.curator ?? true;
  const state = {
    format: 'vault-installer-state',
    version: 1,
    approved_at: '2026-10-26T12:00:00.000Z',
    plan: {
      format: 'vault-installer-plan',
      version: 1,
      data_dir: dataDir,
      repo_root: repoRoot,
      services: { user: 'tester', node_path: '/opt/node/bin/node', engine_port: 4334, curator_port: 4335 },
      vault: {
        path: vault,
        settings_dir: 'Settings',
        exclusions: [],
        analyzer_exclusions: [],
        obsidian: input.obsidian ?? true,
        inventory: { total_files: 1, markdown_files: 1, non_markdown_by_extension: {}, excluded_entries: { directories: 0, symlinks: 0 } },
      },
      structure: null,
      vault_map: input.map === undefined ? vaultMap({ project: { type: 'project', from: 'vault' } }) : input.map,
      models: { preset: 'balanced', vision_provider: 'off', roles: [], models: [] },
      curator: curator ? { daily_budget_cents: 100, sweep_at: '05:00', tz: 'UTC', wiki_mode: 'live' } : null,
      extraction_approved: null,
      obsidian_plugin: input.answer ?? null,
      backup: { mode: 'skip', files: 0, bytes: 0 },
      review: {
        engine_database: join(vault, '.vault-engine', 'vault.db'),
        engine_models_dir: null,
        env_keys: { engine_first_boot: [], engine_after_extraction_off: [], curator: [] },
        extraction_seeded_off: false,
        settings: [],
      },
    },
    stages: {},
  } as unknown as InstallState;
  const path = join(dataDir, 'installer', 'state.json');
  await saveState(path, state);

  const runs: Array<{ command: string; args: string[]; cwd?: string; env?: Record<string, string> }> = [];
  let minted = 0;
  const run: Host['run'] = async (command, args, options) => {
    runs.push({ command, args, cwd: options?.cwd, env: options?.env });
    if (command === 'npm') {
      if (input.build === 'fail') return { code: 1, stdout: '', stderr: 'src/main.ts: error TS2307\nnpm error code 1' };
      for (const file of PLUGIN_BUNDLE) await writeFile(join(repoRoot, 'packages', 'obsidian-plugin', file), `built ${file}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('--revoke')) return { code: 0, stdout: 'Revoked 1 token', stderr: '' };
    minted++;
    return { code: 0, stdout: `Issued service token\n  Authorization: Bearer ${String(minted).repeat(64)}\n`, stderr: '' };
  };
  const pluginDir = join(vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID);
  const host = realFilesystemHost({ run });
  return { state, path, dataDir, repoRoot, vault, pluginDir, runs, host, deps: (prompter: Prompter) => ({ host, prompter, now: NOW }) };
}

/** Every note and line a prompter shows, in order, and each confirmation it was asked. */
function watch(prompter: Prompter) {
  const shown: string[] = [];
  const asked: string[] = [];
  const confirm = prompter.confirm.bind(prompter);
  prompter.note = (message, title) => { shown.push(title ? `${title}\n${message}` : message); };
  prompter.warn = message => { shown.push(`Warning: ${message}`); };
  prompter.confirm = async question => { asked.push(question.message); return confirm(question); };
  return { prompter, shown, asked, text: () => shown.join('\n') };
}

const NOW = () => new Date('2026-10-26T13:00:00Z');
const scriptArgs = (runs: Array<{ command: string; args: string[] }>) => runs
  .filter(run => run.command !== 'npm')
  .map(run => [run.args[2]?.replace(/^.*\/packages\//, ''), ...run.args.slice(3)]);

describe('publicAccessGuide', () => {
  it('fills in this installation and leaves Curator out when it is not installed', () => {
    const guide = publicAccessGuide(plan('/data', false), new Date('2026-10-26T12:00:00Z'));

    expect(guide).toContain('Written by vault-installer on 2026-10-26');
    expect(guide).toContain('service: http://127.0.0.1:4334');
    expect(guide).toContain('sudo systemctl restart vault-engine.service`');
    expect(guide).toContain('in `/data/engine.env` to\n   https://engine.example.com.');
    expect(guide).toContain("cd /srv/vault-suite && VAULT_PATH=/notes DB_PATH=/notes/.vault-engine/vault.db /opt/node/bin/node --import tsx packages/engine/scripts/issue-service-token.ts --name obsidian --revoke");
    expect(guide).not.toMatch(/curator/i);
  });
});

describe('runHandoffStage', () => {
  it('writes the guide, revokes the installer tokens once, removes the saved one, and says how to connect', async () => {
    const { state, path, dataDir, host, runs } = await setup({ obsidian: false });
    const lines: string[] = [];
    const deps = { host, prompter: createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, line => lines.push(line)), now: NOW };

    await runHandoffStage(deps, state, path);
    await runHandoffStage(deps, state, path);

    expect(scriptArgs(runs)).toEqual([
      ['engine/scripts/issue-service-token.ts', '--name', 'installer', '--revoke'],
      ['curator/scripts/issue-service-token.ts', '--name', 'installer', '--revoke'],
    ]);
    await expect(readFile(join(dataDir, 'installer', 'installer.env'), 'utf8')).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(dataDir, 'PUBLIC-ACCESS.md'), 'utf8')).toContain('service: http://127.0.0.1:4335');
    const text = lines.join('\n');
    // A local AI client signs in with OAuth at the localhost issuer; the passwords are shown
    // by a command, never printed by the installer.
    expect(text).toContain('claude mcp add --transport http --scope user vault-engine http://localhost:4334/mcp\n  claude mcp login vault-engine');
    expect(text).toContain('claude mcp add --transport http --scope user vault-curator http://localhost:4335/mcp\n  claude mcp login vault-curator');
    expect(text).toContain(`  sed -n 's/^OAUTH_OWNER_PASSWORD=//p' ${join(dataDir, 'engine.env')}    # Engine`);
    expect(text).toContain(`  sed -n 's/^OAUTH_OWNER_PASSWORD=//p' ${join(dataDir, 'curator.env')}    # Curator`);
    expect(text).not.toContain('Obsidian:');
    expect(text).not.toContain('task views');
    expect(state.stages.handoff).toEqual({ started_at: '2026-10-26T13:00:00.000Z', completed_at: '2026-10-26T13:00:00.000Z' });
  });

  it('leads with sorting, and reads whether search was ready from the verification it saved (#650)', async () => {
    async function finish(search: 'pass' | 'warn' | null): Promise<string> {
      const { state, path, host } = await setup({ obsidian: false, curator: false });
      state.plan.structure = { typed_notes: 10, untyped_notes: 30 } as never;
      if (search) {
        state.stages.verify = { checked_at: '2026-10-26T12:59:00.000Z', completed_at: '2026-10-26T12:59:00.000Z', checks: [{ id: 'search', status: search, title: 'Search', detail: '' }] };
      }
      const lines: string[] = [];
      await runHandoffStage({ host, prompter: createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, line => lines.push(line)), now: NOW }, state, path);
      return lines.join('\n');
    }
    const ready = await finish('pass');
    expect(ready).toContain('30 of your 40 notes have no kind yet, so start by sorting them. Ask Claude Code: "What is still unorganized in my vault?"');
    expect(ready).not.toContain('search index');
    // Still embedding, or never checked: the index is not known to be ready.
    for (const text of [await finish('warn'), await finish(null)]) {
      expect(text).toMatch(/Grouping similar notes needs the search index, which was not ready when this install was checked: `.* status .*` shows when it is, and then what the notes with no kind have in common\./);
    }
  });

  it('adds the plugin to an Obsidian vault, connected with its own tokens, when an interactive user agrees', async () => {
    const { state, path, host, runs, pluginDir, vault, dataDir } = await setup();
    const { prompter, asked, text } = watch(replayPrompter({}).prompter);

    await runHandoffStage({ host, prompter, now: NOW }, state, path);

    expect(asked).toEqual(['Add the Vault Engine plugin to this Obsidian vault, already connected to Engine?']);
    expect((await readdir(pluginDir)).sort()).toEqual(['data.json', 'main.js', 'manifest.json', 'styles.css']);
    expect(await readFile(join(pluginDir, 'main.js'), 'utf8')).toBe('built main.js');
    expect(JSON.parse(await readFile(join(pluginDir, 'data.json'), 'utf8'))).toEqual({
      engineUrl: 'http://localhost:4334/mcp',
      token: ENGINE_TOKEN,
      curatorUrl: 'http://localhost:4335/mcp',
      curatorToken: CURATOR_TOKEN,
    });
    expect((await stat(join(pluginDir, 'data.json'))).mode & 0o777).toBe(0o600);
    // Its tokens come from each service's own script, under the name the guide revokes.
    expect(scriptArgs(runs)).toEqual([
      ['engine/scripts/issue-service-token.ts', '--name', 'obsidian', '--ttl-days', '36500'],
      ['curator/scripts/issue-service-token.ts', '--name', 'obsidian', '--ttl-days', '36500', '--scope', 'curate:read,curate:trigger'],
      ['engine/scripts/issue-service-token.ts', '--name', 'installer', '--revoke'],
      ['curator/scripts/issue-service-token.ts', '--name', 'installer', '--revoke'],
    ]);
    // The plugin's build runs first; the token scripts follow it.
    expect(runs[0]).toMatchObject({ command: 'npm', args: ['run', 'build', '-w', 'vault-obsidian'] });
    const tokenRuns = runs.filter(run => run.command !== 'npm');
    expect(tokenRuns[0]?.env).toMatchObject({ VAULT_PATH: vault, DB_PATH: join(vault, '.vault-engine', 'vault.db') });
    expect(tokenRuns[1]?.env).toMatchObject({ CURATOR_DB_PATH: join(dataDir, 'curator.db') });
    // No token is in the saved state, and Obsidian's own settings are untouched.
    const saved = await readFile(path, 'utf8');
    expect(saved).not.toContain(ENGINE_TOKEN);
    expect(saved).not.toContain(CURATOR_TOKEN);
    expect(state.stages.handoff?.obsidian_plugin).toBe('installed');
    expect((await readdir(join(vault, '.obsidian'))).sort()).toEqual(['app.json', 'plugins']);

    expect(text()).toContain(`Obsidian: the Vault Engine plugin is in ${pluginDir}, connected to Engine and Curator.`);
    expect(text()).toContain('Turn on community plugins if it asks, then turn on Vault Engine.');
    expect(text()).toContain('Or, in Obsidian, open one of your project notes and run "Vault Engine: Create project wiki".');
  });

  it('leaves the plugin out when the interactive user says no', async () => {
    const { state, path, host, runs, pluginDir, repoRoot } = await setup();
    const { prompter, text } = watch(replayPrompter({}, [false]).prompter);

    await runHandoffStage({ host, prompter, now: NOW }, state, path);

    await expect(stat(pluginDir)).rejects.toThrow(/ENOENT/);
    expect(runs.filter(run => !run.args.includes('--revoke'))).toEqual([]);
    expect(state.stages.handoff?.obsidian_plugin).toBe('declined');
    expect(text()).toContain(`Obsidian: the Vault Engine plugin was not added. ${join(repoRoot, 'packages', 'obsidian-plugin', 'README.md')} says how to add it.`);
    expect(text()).not.toContain('"Vault Engine: Create project wiki"');
  });

  it('headless, adds the plugin only when the answers file asks, and never on a resume nobody can answer', async () => {
    for (const [answer, outcome] of [[false, 'declined'], [true, 'installed']] as const) {
      const { state, path, host, pluginDir } = await setup({ answer });
      const { prompter, asked } = watch(createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, () => {}));
      await runHandoffStage({ host, prompter, now: NOW }, state, path);
      expect(asked).toEqual([]);
      expect(state.stages.handoff?.obsidian_plugin).toBe(outcome);
      expect(await stat(pluginDir).then(() => true, () => false)).toBe(outcome === 'installed');
    }

    // An interactive plan continued headless: the question has no answer, so no plugin.
    const { state, path, host, pluginDir } = await setup({ answer: null });
    const { prompter, asked } = watch(createProgressPrompter(() => {}));
    await runHandoffStage({ host, prompter, now: NOW }, state, path);
    expect(asked).toEqual([]);
    expect(state.stages.handoff?.obsidian_plugin).toBe('declined');
    await expect(stat(pluginDir)).rejects.toThrow(/ENOENT/);
  });

  it('never replaces a plugin folder already in the vault without asking', async () => {
    const existing = {
      [`.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`]: 'their main.js',
      [`.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/data.json`]: '{"token":"theirs","fireworksApiKey":"fw-key","curatorUrl":"http://other-host:3335/mcp","curatorToken":"their-curator"}',
    };

    // Headless, even when the answers file asks for the plugin.
    const headless = await setup({ answer: true, vaultFiles: existing });
    const quiet = watch(createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, () => {}));
    await runHandoffStage(headless.deps(quiet.prompter), headless.state, headless.path);
    expect(headless.state.stages.handoff?.obsidian_plugin).toBe('kept');
    expect(await readFile(join(headless.pluginDir, 'data.json'), 'utf8')).toBe(existing[`.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/data.json`]);
    expect(await readFile(join(headless.pluginDir, 'main.js'), 'utf8')).toBe('their main.js');
    expect(quiet.text()).toContain(`Obsidian: a Vault Engine plugin was already in ${headless.pluginDir}, so it was left as it is.`);
    expect(quiet.text()).toContain('set its Engine URL to http://localhost:4334/mcp and its Bearer token to the token this prints once:');
    expect(quiet.text()).toContain('packages/engine/scripts/issue-service-token.ts --name obsidian\n');

    // Interactively the default is to keep it.
    const kept = await setup({ vaultFiles: existing });
    const keeping = watch(replayPrompter({}).prompter);
    await runHandoffStage(kept.deps(keeping.prompter), kept.state, kept.path);
    expect(keeping.asked).toEqual([expect.stringMatching(/^A Vault Engine plugin is already in .*\. Replace it with this version and connect it to this Engine\?/)]);
    expect(kept.state.stages.handoff?.obsidian_plugin).toBe('kept');
    expect(await readFile(join(kept.pluginDir, 'main.js'), 'utf8')).toBe('their main.js');

    // Replaced only when the user says so, keeping its other settings; with no Curator in
    // this install, the old Curator connection is cleared rather than kept.
    const replaced = await setup({ vaultFiles: existing, curator: false });
    const replacing = watch(replayPrompter({}, [true]).prompter);
    await runHandoffStage(replaced.deps(replacing.prompter), replaced.state, replaced.path);
    expect(replaced.state.stages.handoff?.obsidian_plugin).toBe('installed');
    expect(await readFile(join(replaced.pluginDir, 'main.js'), 'utf8')).toBe('built main.js');
    expect(JSON.parse(await readFile(join(replaced.pluginDir, 'data.json'), 'utf8'))).toEqual({
      token: ENGINE_TOKEN,
      fireworksApiKey: 'fw-key',
      engineUrl: 'http://localhost:4334/mcp',
    });
  });

  it.each([
    ['missing', false],
    ['left by an earlier build', true],
  ])('builds the plugin before adding it when its bundle is %s', async (_label, bundle) => {
    const { state, path, host, runs, repoRoot, pluginDir } = await setup({ bundle, answer: true });
    await runHandoffStage({ host, prompter: createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, () => {}), now: NOW }, state, path);

    expect(runs[0]).toMatchObject({ command: 'npm', args: ['run', 'build', '-w', 'vault-obsidian'], cwd: repoRoot });
    expect(await readFile(join(pluginDir, 'main.js'), 'utf8')).toBe('built main.js');
    expect(state.stages.handoff?.obsidian_plugin).toBe('installed');
  });

  it.each([
    ['missing', false],
    ['left by an earlier build', true],
  ])('adds nothing to the vault and mints no token when the build fails, with its bundle %s', async (_label, bundle) => {
    const { state, path, host, runs, vault } = await setup({ bundle, answer: true, build: 'fail' });
    const { prompter, text } = watch(createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, () => {}));

    await runHandoffStage({ host, prompter, now: NOW }, state, path);

    expect(state.stages.handoff).toMatchObject({ obsidian_plugin: 'not_built', completed_at: '2026-10-26T13:00:00.000Z' });
    expect(await readdir(join(vault, '.obsidian'))).toEqual(['app.json']);
    expect(runs.filter(run => run.command !== 'npm' && !run.args.includes('--revoke'))).toEqual([]);
    expect(text()).toContain('Warning: The Obsidian plugin was not added: its build failed (src/main.ts: error TS2307 npm error code 1).');
    expect(text()).toContain('Obsidian: the plugin could not be built, so it was not added.');
  });

  it('finishes a plugin install an interrupted run started, without asking again', async () => {
    const { state, path, host, pluginDir } = await setup({ vaultFiles: { [`.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`]: 'half' } });
    state.stages.handoff = { started_at: '2026-10-26T12:30:00.000Z', completed_at: null, obsidian_plugin: 'installing' };
    await saveState(path, state);
    const reloaded = await loadState(path) as InstallState;
    const { prompter, asked } = watch(replayPrompter({}).prompter);

    await runHandoffStage({ host, prompter, now: NOW }, reloaded, path);
    await runHandoffStage({ host, prompter, now: NOW }, reloaded, path);

    expect(asked).toEqual([]);
    expect(await readFile(join(pluginDir, 'main.js'), 'utf8')).toBe('built main.js');
    expect(JSON.parse(await readFile(join(pluginDir, 'data.json'), 'utf8'))).toMatchObject({ token: ENGINE_TOKEN });
    expect(reloaded.stages.handoff).toEqual({
      started_at: '2026-10-26T12:30:00.000Z',
      completed_at: '2026-10-26T13:00:00.000Z',
      obsidian_plugin: 'installed',
    });
  });

  it('finishes a state saved by the previous installer version', async () => {
    const { state, path, host } = await setup();
    // That version's plan had no plugin answer and no vault map.
    const old = state.plan as unknown as Record<string, unknown>;
    delete old['obsidian_plugin'];
    delete old['vault_map'];
    state.stages.handoff = { started_at: '2026-10-26T12:30:00.000Z', completed_at: null };
    await saveState(path, state);
    const reloaded = await loadState(path) as InstallState;
    expect(reloaded.plan.obsidian_plugin).toBeNull();
    const { prompter, text } = watch(createProgressPrompter(() => {}));

    await runHandoffStage({ host, prompter, now: NOW }, reloaded, path);

    expect(reloaded.stages.handoff?.obsidian_plugin).toBe('declined');
    expect(text()).toContain('Start a wiki about a topic.');
  });
});

describe('firstThingToTry', () => {
  async function suggestion(input: { curator: boolean; map: VaultMapSummary | null; obsidian?: boolean }, plugin = false) {
    const { state } = await setup({ curator: input.curator, map: input.map, obsidian: input.obsidian ?? true });
    return firstThingToTry(state.plan, plugin).join('\n');
  }

  it('suggests a project wiki only when a project kind holds notes, and Curator is installed', async () => {
    const initiative = vaultMap({ project: { type: 'initiative', from: 'vault' }, task: { type: 'task', from: 'vault' } });
    const text = await suggestion({ curator: true, map: initiative }, true);
    expect(text).toContain('Start a wiki for one of your projects. Ask Claude Code: "Create a project wiki for <one of your initiative notes>."');
    expect(text).toContain('Or, in Obsidian, open one of your initiative notes and run "Vault Engine: Create project wiki".');
    expect(text).toContain('Its first build is a paid call that counts against Curator\'s daily cap ($1.00).');
    expect(text).toContain('is set in Settings/Vault.md in your notes folder. Change it there, or ask an assistant connected to Engine to change it.');
    expect(text).not.toContain('task views');
  });

  it('suggests a topic wiki when no project kind holds notes', async () => {
    for (const project of [NONE, { type: 'project', from: 'starter' as const }]) {
      const text = await suggestion({ curator: true, map: vaultMap({ project }) }, true);
      expect(text).toContain('Start a wiki about a topic. Ask Claude Code: "Make a topic wiki about <a subject your notes cover>."');
      expect(text).toContain('Or, in Obsidian, open a note and run "Vault Engine: Create topic wiki from this note".');
      expect(text).not.toContain('project wiki');
    }
  });

  it('suggests a search without Curator, whatever the map says', async () => {
    const text = await suggestion({ curator: false, map: vaultMap({ project: { type: 'project', from: 'vault' } }) });
    expect(text).toContain('Search your notes. Ask Claude Code: "Search my notes for <something you wrote about>."');
    expect(text).not.toContain('wiki');
    expect(text).not.toContain('Obsidian, run');
    expect(await suggestion({ curator: false, map: vaultMap() }, true)).toContain('Or, in Obsidian, run "Vault Engine: Search vault" from the command palette.');
  });

  describe('with notes that got no kind (#650)', () => {
    const SEARCH = { status: 'vault-installer status', searchReady: true };
    async function sorted(counts: { typed: number; untyped: number }, options: { curator?: boolean; searchReady?: boolean } = {}) {
      const { state } = await setup({ curator: options.curator ?? false, map: vaultMap() });
      state.plan.structure = { typed_notes: counts.typed, untyped_notes: counts.untyped } as never;
      return firstThingToTry(state.plan, false, { ...SEARCH, searchReady: options.searchReady ?? true });
    }

    it('leads with sorting when a quarter of the notes or more have no kind', async () => {
      const lines = await sorted({ typed: 460, untyped: 1840 });
      expect(lines.slice(0, 4)).toEqual([
        '1840 of your 2300 notes have no kind yet, so start by sorting them. Ask Claude Code: "What is still unorganized in my vault?"',
        'Or type /mcp__vault-engine__organize-vault there, which starts the same session.',
        'It lists what is left to sort, largest first, and works through it with you: it groups similar notes, proposes a kind for each group, and changes nothing until you agree.',
        'Vault makes no paid calls for this, and each change can be undone for a day.',
      ]);
      // The suggestion that led before comes second.
      expect(lines.slice(4, 6)).toEqual(['', 'Then search your notes. Ask Claude Code: "Search my notes for <something you wrote about>."']);
      expect((await sorted({ typed: 75, untyped: 25 }))[0]).toContain('25 of your 100 notes have no kind yet');
      expect((await sorted({ typed: 0, untyped: 40 }))[0]).toContain('None of your 40 notes has a kind yet, so start by sorting them.');
      expect((await sorted({ typed: 0, untyped: 1840 }, { curator: true })).join('\n'))
        .toContain('\n\nThen start a wiki about a topic. Ask Claude Code: "Make a topic wiki about <a subject your notes cover>."\nIts first build is a paid call');
    });

    it('does not lead with fewer than ten notes to sort, whatever their share', async () => {
      for (const counts of [{ typed: 1, untyped: 1 }, { typed: 0, untyped: 9 }]) {
        const lines = await sorted(counts);
        expect(lines[0]).toBe('Search your notes. Ask Claude Code: "Search my notes for <something you wrote about>."');
        expect(lines.join('\n')).not.toContain('start by sorting');
      }
      expect((await sorted({ typed: 1, untyped: 1 })).join('\n')).toContain('1 of your 2 notes has no kind. To sort it, ask Claude Code: "What is still unorganized in my vault?"');
      expect((await sorted({ typed: 0, untyped: 9 })).join('\n')).toContain('None of your 9 notes has a kind. To sort them, ask Claude Code:');
      expect((await sorted({ typed: 0, untyped: 10 }))[0]).toContain('None of your 10 notes has a kind yet, so start by sorting them.');
    });

    it('names the Engine\'s own prompt, under the server name the connect step registers', async () => {
      const prompts = await readFile(join(REPO_ROOT, 'packages', 'engine', 'src', 'mcp', 'prompts.ts'), 'utf8');
      const name = /ORGANIZE_PROMPT_NAME = '([^']+)'/.exec(prompts)?.[1];
      // `vault-engine` is the name in the `claude mcp add` line the connect step prints (pinned above).
      expect(name).toBeTruthy();
      expect(SORTING_COMMAND).toBe(`/mcp__vault-engine__${name}`);
    });

    it('keeps the wiki or search suggestion first below a quarter, and adds one line on sorting', async () => {
      const lines = await sorted({ typed: 76, untyped: 24 });
      expect(lines[0]).toBe('Search your notes. Ask Claude Code: "Search my notes for <something you wrote about>."');
      expect(lines.slice(1, 3)).toEqual(['', '24 of your 100 notes have no kind. To sort them, ask Claude Code: "What is still unorganized in my vault?"']);
      expect((await sorted({ typed: 99, untyped: 1 })).join('\n')).toContain('1 of your 100 notes has no kind. To sort it, ask Claude Code:');
    });

    it('says nothing about sorting when every note has a kind, or the plan did not read the notes', async () => {
      expect((await sorted({ typed: 100, untyped: 0 })).join('\n')).not.toContain('no kind');
      const { state } = await setup({ curator: false, map: vaultMap() });
      expect(state.plan.structure).toBeNull();
      expect(firstThingToTry(state.plan, false, SEARCH).join('\n')).not.toContain('unorganized');
    });

    it('says the search index is needed for grouping only while it is not ready', async () => {
      const waiting = (await sorted({ typed: 0, untyped: 40 }, { searchReady: false })).join('\n');
      expect(waiting).toContain('Grouping similar notes needs the search index, which was not ready when this install was checked: `vault-installer status` shows when it is, and then what the notes with no kind have in common.');
      expect((await sorted({ typed: 0, untyped: 40 })).join('\n')).not.toContain('search index');
      // Below a quarter the one line asks for the list, which needs no index.
      expect((await sorted({ typed: 99, untyped: 1 }, { searchReady: false })).join('\n')).not.toContain('search index');
    });
  });

  it('says the plugin hides its task views when no task kind is set', async () => {
    expect(await suggestion({ curator: true, map: vaultMap() })).toContain(
      'No task kind is set, so the Vault Engine plugin hides its task views (the Kanban and List presets in Boards). To set one later, give taskType (and taskStatusField) a value in Settings/Vault.md.',
    );
    expect(await suggestion({ curator: true, map: vaultMap(), obsidian: false })).not.toContain('task views');
  });
});

describe('ownerPasswordCommand', () => {
  it('prints only the password, from a quoted path', () => {
    expect(ownerPasswordCommand('/srv/vault data/engine.env')).toBe("sed -n 's/^OAUTH_OWNER_PASSWORD=//p' '/srv/vault data/engine.env'");
  });
});

describe('OBSIDIAN_PLUGIN_ID', () => {
  it('is the plugin manifest\'s id', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'packages', 'obsidian-plugin', 'manifest.json'), 'utf8')) as { id: string };
    expect(manifest.id).toBe(OBSIDIAN_PLUGIN_ID);
  });
});
