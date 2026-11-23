import { readFile, readdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnalyzerRunner } from '../src/analyzer.js';
import { AnswersError, type Answers } from '../src/answers.js';
import type { Host } from '../src/host.js';
import { createScriptedPrompter } from '../src/prompter.js';
import { detectSyncService, findObsidianVaults, MESSY_SAMPLE, parseRelativeDirectory, runVaultStage } from '../src/vault.js';
import { fakeHost, fm, makeTree, realFilesystemHost, removeTrees, replayPrompter, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

async function plan(vault: Answers['vault'], hostOverrides = {}, dataDir = '/srv/tester/vault-suite-data', repoRoot = REPO_ROOT) {
  const lines: string[] = [];
  const result = await runVaultStage({
    host: realFilesystemHost(hostOverrides),
    prompter: createScriptedPrompter({ version: 1, vault }, line => lines.push(line)),
    analyzer: createAnalyzerRunner(SOURCE_ANALYZER),
    cwd: '/',
    dataDir,
    repoRoot,
  });
  return { result, lines };
}

describe('runVaultStage', () => {
  it('inventories the folder and leaves template folders out by default', async () => {
    const root = await makeTree({
      'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
      'Meetings/2026/Kickoff.md': fm({ type: 'meeting' }),
      'Templates/Project.md': fm({ type: '"{{type}}"' }),
      'Loose.md': '# Loose\n',
      '.obsidian/app.json': '{}',
    });

    const { result } = await plan({ path: root });

    expect(result.exclusions).toEqual(['Templates']);
    expect(result.settingsDir).toBe('Settings');
    expect(result.analyzerExclusions).toEqual(['Settings', 'Templates']);
    expect(result.obsidian).toBe(true);
    expect(result.managedByEngine).toBe(false);
    expect(result.discovery.inventory.markdown_files).toBe(3);
    expect(result.discovery.source.exclusions).toEqual(['Templates']);
    expect(result.discovery.candidates[0]).toMatchObject({ key: 'type', documents_with_key: 2 });
    expect(result.warnings).toEqual([]);
  });

  it('uses the exclusions from the answers file instead of the default', async () => {
    const root = await makeTree({
      'Notes/A.md': '# A\n',
      'Templates/T.md': '# T\n',
      'Archive/Old/B.md': '# B\n',
    });

    const { result } = await plan({ path: root, exclude: ['Archive/Old/'] });

    expect(result.exclusions).toEqual(['Archive/Old']);
    expect(result.discovery.inventory.markdown_files).toBe(2);
  });

  it('asks for another settings folder when Settings/ already exists', async () => {
    const root = await makeTree({ 'Settings/Mine.md': '# Mine\n', 'Note.md': '# Note\n' });

    const defaulted = await plan({ path: root });
    const chosen = await plan({ path: root, settings_dir: 'Engine' });

    expect(defaulted.result.settingsDir).toBe('Vault Settings');
    expect(defaulted.lines.some(line => line.includes('already has a Settings/ folder'))).toBe(true);
    expect(chosen.result.settingsDir).toBe('Engine');
    expect(chosen.result.analyzerExclusions).toEqual(['Engine']);
  });

  it('refuses a settings folder that already exists', async () => {
    const root = await makeTree({ 'Settings/Mine.md': '# Mine\n', 'Notes/A.md': '# A\n' });

    await expect(plan({ path: root, settings_dir: 'Notes' }))
      .rejects.toThrow(/vault\.settings_dir: Notes\/ already exists/);
  });

  it('refuses a settings folder inside an excluded folder', async () => {
    const root = await makeTree({ 'Settings/Mine.md': '# Mine\n', 'Templates/T.md': '# T\n', 'Note.md': '# Note\n' });

    await expect(plan({ path: root, exclude: ['Templates'], settings_dir: 'Templates/Engine' }))
      .rejects.toThrow(/vault\.settings_dir: Templates\/Engine\/ is inside Templates\/, which you left out/);
  });

  it('chooses another settings folder when Settings/ itself is left out', async () => {
    const root = await makeTree({ 'Settings/Mine.md': '# Mine\n', 'Note.md': '# Note\n' });

    const { result, lines } = await plan({ path: root, exclude: ['Settings'] });

    expect(result.exclusions).toEqual(['Settings']);
    expect(result.settingsDir).toBe('Vault Settings');
    expect(lines.some(line => line.includes('Settings/ is inside Settings/, which you left out'))).toBe(true);
  });

  it('offers other wiki and topic folders when the vault already has Wikis/ and Topics/', async () => {
    const root = await makeTree({ 'Wikis/Mine.md': '# Mine\n', 'Topics/Mine.md': '# Mine\n', 'Note.md': '# Note\n' });

    const defaulted = await plan({ path: root });
    const shared = await plan({ path: root, wiki_dir: 'Wikis', topic_dir: 'Topics' });
    const plain = await plan({ path: await makeTree({ 'Note.md': '# Note\n' }) });

    expect([defaulted.result.wikiDir, defaulted.result.topicDir]).toEqual(['Vault Wikis', 'Vault Topics']);
    expect(defaulted.lines.some(line => line.includes('already has a Wikis/ folder'))).toBe(true);
    expect(defaulted.lines.some(line => line.includes('already has a Topics/ folder'))).toBe(true);
    // Answering the existing name shares the folder.
    expect([shared.result.wikiDir, shared.result.topicDir]).toEqual(['Wikis', 'Topics']);
    expect([plain.result.wikiDir, plain.result.topicDir]).toEqual(['Wikis', 'Topics']);
    expect(plain.lines.some(line => line.includes('Wikis/'))).toBe(false);
  });

  it('refuses a wiki or topic folder that is left out, exists, or overlaps another service folder', async () => {
    const root = await makeTree({ 'Wikis/Mine.md': '# Mine\n', 'Topics/Mine.md': '# Mine\n', 'Notes/A.md': '# A\n', 'Templates/T.md': '# T\n' });

    await expect(plan({ path: root, wiki_dir: 'Notes' }))
      .rejects.toThrow(/vault\.wiki_dir: Notes\/ already exists/);
    await expect(plan({ path: root, exclude: ['Templates'], wiki_dir: 'Templates/Wikis' }))
      .rejects.toThrow(/vault\.wiki_dir: Templates\/Wikis\/ is inside Templates\/, which you left out; Engine would not see the wiki pages there/);
    await expect(plan({ path: root, wiki_dir: 'Settings/Wikis' }))
      .rejects.toThrow(/vault\.wiki_dir: Settings\/Wikis\/ overlaps Engine's settings folder, Settings\//);
    await expect(plan({ path: root, wiki_dir: 'Shared', topic_dir: 'Shared/Topics' }))
      .rejects.toThrow(/vault\.topic_dir: Shared\/Topics\/ overlaps the wiki folder, Shared\//);
  });

  it('offers every folder with its usual name instead of imposing it', async () => {
    const root = await makeTree({ 'Note.md': '# Note\n' });
    const asked: string[] = [];
    const prompter = createScriptedPrompter({ version: 1, vault: { path: root } }, () => {});
    const text = prompter.text.bind(prompter);
    prompter.text = async question => {
      asked.push(`${question.id}=${question.defaultValue ?? ''}`);
      return text(question);
    };
    await runVaultStage({ host: realFilesystemHost(), prompter, analyzer: createAnalyzerRunner(SOURCE_ANALYZER), cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });
    // No folder of those names exists, so the answers are taken as given.
    const chosen = await plan({ path: root, settings_dir: 'Admin/Settings', wiki_dir: 'Pages', topic_dir: 'Pages/Topics' })
      .catch(error => error as Error);
    const separate = await plan({ path: root, settings_dir: 'Admin/Settings', wiki_dir: 'Pages', topic_dir: 'Subjects' });

    expect(asked).toEqual(['vault.path=', 'vault.settings_dir=Settings', 'vault.wiki_dir=Wikis', 'vault.topic_dir=Topics']);
    expect(chosen).toBeInstanceOf(AnswersError);
    expect([separate.result.settingsDir, separate.result.wikiDir, separate.result.topicDir]).toEqual(['Admin/Settings', 'Pages', 'Subjects']);
    expect(separate.result.analyzerExclusions).toEqual(['Admin/Settings']);
  });

  it('asks for another topic folder when the wiki folder took its default name', async () => {
    const root = await makeTree({ 'Wikis/Mine.md': '# Mine\n', 'Note.md': '# Note\n' });

    const { result, lines } = await plan({ path: root, wiki_dir: 'Topics' });

    expect([result.wikiDir, result.topicDir]).toEqual(['Topics', 'Vault Topics']);
    expect(lines.some(line => line.includes('Topics/ overlaps the wiki folder, Topics/, so Vault Curator needs another folder'))).toBe(true);
  });

  it('detects sync clients through a symlinked vault path', async () => {
    const parent = await makeTree({ 'Dropbox/Vault/Note.md': '# Note\n' });
    await symlink(join(parent, 'Dropbox', 'Vault'), join(parent, 'Notes'));

    const { result } = await plan({ path: join(parent, 'Notes') });

    expect(result.syncService).toBe('Dropbox');
    expect(result.path).toBe(await realpath(join(parent, 'Dropbox', 'Vault')));
  });

  it('warns about an existing Engine database, sync clients, and low disk', async () => {
    const parent = await makeTree({ 'Dropbox/Vault/Note.md': '# Note\n', 'Dropbox/Vault/.vault-engine/': '', 'Dropbox/Vault/Wikis/': '' });
    const root = join(parent, 'Dropbox', 'Vault');

    const { result } = await plan({ path: root }, { freeDiskBytes: async () => 1024 ** 3 });

    expect(result.managedByEngine).toBe(true);
    expect(result.syncService).toBe('Dropbox');
    expect(result.warnings).toEqual([
      expect.stringContaining('already has a .vault-engine/ directory'),
      expect.stringContaining('synced by Dropbox'),
      expect.stringContaining('Only 1.0 GB is free'),
    ]);
    // Engine's stored settings name its folders there, so none is asked.
    expect(result.wikiDir).toBe('Wikis');
  });

  it.each([
    ['a missing folder', (root: string) => join(root, 'missing'), /does not exist/],
    ['a file', (root: string) => join(root, 'Note.md'), /is not a folder/],
  ])('rejects %s as the vault path in a headless run', async (_label, pathFor, message) => {
    const root = await makeTree({ 'Note.md': '# Note\n' });

    const run = plan({ path: pathFor(root) });

    await expect(run).rejects.toThrow(AnswersError);
    await expect(run).rejects.toThrow(message);
    // A headless run never creates the folder.
    expect(await realFilesystemHost().pathExists(join(root, 'missing'))).toBe(false);
  });

  it('plans an empty folder with no type fields or folders to offer', async () => {
    const root = await makeTree({});

    const { result } = await plan({ path: root });

    expect(result.path).toBe(await realpath(root));
    expect(result.discovery.inventory.markdown_files).toBe(0);
    expect(result.discovery.folders).toEqual([]);
    expect(result.discovery.candidates).toEqual([]);
    expect(result.exclusions).toEqual([]);
  });

  it('plans a folder whose notes are all left out, still counting its attachments', async () => {
    const root = await makeTree({ 'Templates/T.md': '# T\n', 'Archive/A.md': '# A\n', 'Scans/receipt.pdf': 'x' });

    const { result } = await plan({ path: root, exclude: ['Templates', 'Archive'] });

    expect(result.exclusions).toEqual(['Archive', 'Templates']);
    expect(result.discovery.inventory).toMatchObject({ markdown_files: 0, non_markdown_by_extension: { '.pdf': 1 } });
    expect(result.discovery.source.exclusions).toEqual(['Archive', 'Templates']);
  });

  it('does not offer Obsidian vaults in a headless run', async () => {
    const listed = await makeTree({ 'A.md': '# A\n' });
    const named = await makeTree({ 'B.md': '# B\n' });
    const home = await obsidianHome({ [listed]: 1 });

    // Asked as a choice, the answers file's folder would not be one of the options.
    const { result } = await plan({ path: named }, { homeDir: home });

    expect(result.path).toBe(await realpath(named));
  });

  it('rejects a vault that contains the data directory or sits inside it', async () => {
    const root = await makeTree({ 'Notes/Note.md': '# Note\n' });
    await symlink(root, join(root, 'Notes', 'alias'));

    await expect(plan({ path: root }, {}, join(root, 'Notes', 'alias', 'data'))).rejects.toThrow(/vault\.path: The data directory .* is inside this folder/);
    await expect(plan({ path: join(root, 'Notes') }, {}, root)).rejects.toThrow(/vault\.path: This folder is inside the data directory/);
    await expect(plan({ path: join(root, 'Notes') }, {}, join(root, 'Notes-data'))).resolves.toBeDefined();
  });

  it('rejects the code checkout, a folder inside it, and a folder holding it as the vault', async () => {
    const root = await makeTree({ 'Notes/Note.md': '# Note\n', 'code/docs/Guide.md': '# Guide\n' });
    const checkout = join(root, 'code');

    await expect(plan({ path: checkout }, {}, undefined, checkout)).rejects.toThrow(/vault\.path: This folder is the Vault Engine code checkout/);
    await expect(plan({ path: join(checkout, 'docs') }, {}, undefined, checkout)).rejects.toThrow(/vault\.path: This folder is inside the Vault Engine code checkout/);
    await expect(plan({ path: root }, {}, undefined, checkout)).rejects.toThrow(/vault\.path: The Vault Engine code checkout .* is inside this folder/);
    await expect(plan({ path: join(root, 'Notes') }, {}, undefined, checkout)).resolves.toBeDefined();
  });

  it('rejects an exclusion that is not a folder path inside the vault', async () => {
    const root = await makeTree({ 'Note.md': '# Note\n' });

    await expect(plan({ path: root, exclude: ['../elsewhere'] })).rejects.toThrow(/vault\.exclude/);
  });

  it('expands ~ in the vault path', async () => {
    const home = await makeTree({ 'Notes/Note.md': '# Note\n' });

    const { result } = await plan({ path: '~/Notes' }, { homeDir: home });

    expect(result.discovery.inventory.markdown_files).toBe(1);
    expect(result.path.endsWith('/Notes')).toBe(true);
  });
});

/** The vault stage run interactively, recording each select question's options. */
async function interactively(
  script: Parameters<typeof replayPrompter>[0],
  confirms: boolean[] = [],
  hostOverrides: Partial<Host> = {},
  dataDir = '/srv/tester/vault-suite-data',
  { cwd = '/', repoRoot = REPO_ROOT }: { cwd?: string; repoRoot?: string } = {},
) {
  const replay = replayPrompter(script, confirms);
  const selects: Array<{ id: string; options: string[]; initialValue: string }> = [];
  const select = replay.prompter.select.bind(replay.prompter);
  replay.prompter.select = async question => {
    selects.push({ id: question.id, options: question.options.map(option => option.label), initialValue: question.initialValue });
    return select(question);
  };
  /** Each folder question's starting text. */
  const starts: Array<string | undefined> = [];
  const text = replay.prompter.text.bind(replay.prompter);
  replay.prompter.text = async question => {
    if (question.folder) starts.push(question.initialInput);
    return text(question);
  };
  const result = await runVaultStage({
    host: realFilesystemHost(hostOverrides),
    prompter: replay.prompter,
    analyzer: createAnalyzerRunner(SOURCE_ANALYZER),
    cwd,
    dataDir,
    repoRoot,
  });
  return { result, selects, starts, ...replay };
}

/** A home folder whose native Obsidian install lists `vaults` (path → last opened). */
async function obsidianHome(vaults: Record<string, number>): Promise<string> {
  const config = { vaults: Object.fromEntries(Object.entries(vaults).map(([path, ts], index) => [`id${index}`, { path, ts }])) };
  return makeTree({ '.config/obsidian/obsidian.json': JSON.stringify(config) });
}

describe('runVaultStage interactively', () => {
  it('offers the Obsidian vaults on this computer, most recently opened first', async () => {
    const older = await makeTree({ 'Old.md': '# Old\n' });
    const newer = await makeTree({ 'New.md': '# New\n' });
    const home = await obsidianHome({ [older]: 100, [newer]: 200 });

    const { result, selects, asked } = await interactively({ 'vault.path': [older] }, [], { homeDir: home });

    expect(selects[0]).toEqual({ id: 'vault.path', options: [newer, older, 'Somewhere else'], initialValue: newer });
    expect(result.path).toBe(await realpath(older));
    expect(asked.filter(id => id === 'vault.path')).toHaveLength(1);
  });

  it('asks for a folder when the user picks somewhere else', async () => {
    const vault = await makeTree({ 'A.md': '# A\n' });
    const other = await makeTree({ 'B.md': '# B\n' });
    const home = await obsidianHome({ [vault]: 1 });

    const { result, asked } = await interactively({ 'vault.path': ['somewhere-else', other] }, [], { homeDir: home });

    expect(result.path).toBe(await realpath(other));
    expect(asked.filter(id => id === 'vault.path')).toHaveLength(2);
  });

  it('asks for a folder without a choice when Obsidian lists no vaults', async () => {
    const vault = await makeTree({ 'A.md': '# A\n' });

    const { result, selects } = await interactively({ 'vault.path': [vault] });

    expect(selects.filter(select => select.id === 'vault.path')).toEqual([]);
    expect(result.path).toBe(await realpath(vault));
  });

  it('starts the folder question from the folder the installer was run from', async () => {
    const vault = await makeTree({ 'A.md': '# A\n' });

    const { starts } = await interactively({ 'vault.path': [vault] }, [], {}, undefined, { cwd: vault });

    expect(starts).toEqual([vault]);
  });

  it('starts the folder question empty when run from the code checkout, and asks again if the checkout is chosen', async () => {
    const root = await makeTree({ 'Notes/A.md': '# A\n', 'code/docs/Guide.md': '# Guide\n' });
    const checkout = join(root, 'code');

    const { result, starts, rejections } = await interactively(
      { 'vault.path': [checkout, join(root, 'Notes')] },
      [],
      {},
      undefined,
      { cwd: join(checkout, 'docs'), repoRoot: checkout },
    );

    expect(starts).toEqual([undefined, undefined]);
    expect(rejections).toEqual([expect.stringContaining('is the Vault Engine code checkout')]);
    expect(result.path).toBe(join(await realpath(root), 'Notes'));
  });

  it('creates a missing folder when the user agrees, and plans it as an empty vault', async () => {
    const parent = await makeTree({});
    const target = join(parent, 'Notes');

    const { result, rejections } = await interactively({ 'vault.path': [target] }, [true]);

    expect(rejections).toEqual([]);
    expect(await realFilesystemHost().inspectDirectory(target)).toEqual({ exists: true, directory: true, readable: true, writable: true });
    expect(result.path).toBe(join(await realpath(parent), 'Notes'));
    expect(result.discovery.inventory.markdown_files).toBe(0);
  });

  it('asks again, creating nothing, when the user declines to create a missing folder', async () => {
    const parent = await makeTree({ 'Vault/A.md': '# A\n' });

    const { result, asked } = await interactively({ 'vault.path': [join(parent, 'Missing'), join(parent, 'Vault')] }, [false]);

    expect(await realFilesystemHost().pathExists(join(parent, 'Missing'))).toBe(false);
    expect(asked.filter(id => id === 'vault.path')).toHaveLength(2);
    expect(result.path).toBe(join(await realpath(parent), 'Vault'));
  });

  it('refuses to create a missing folder that would hold the data directory, without asking', async () => {
    const parent = await makeTree({ 'Vault/A.md': '# A\n' });
    const confirms = [true];

    const { result, rejections } = await interactively(
      { 'vault.path': [join(parent, 'Missing'), join(parent, 'Vault')] },
      confirms,
      {},
      join(parent, 'Missing', 'data'),
    );

    expect(rejections).toEqual([expect.stringContaining('is inside this folder')]);
    expect(confirms).toEqual([true]);
    expect(await realFilesystemHost().pathExists(join(parent, 'Missing'))).toBe(false);
    expect(result.path).toBe(join(await realpath(parent), 'Vault'));
  });

  it('refuses to create a missing folder inside the code checkout, without asking', async () => {
    const root = await makeTree({ 'Vault/A.md': '# A\n', 'code/package.json': '{}' });
    const checkout = join(root, 'code');
    const confirms = [true];

    const { result, rejections } = await interactively(
      { 'vault.path': [join(checkout, 'Notes'), join(root, 'Vault')] },
      confirms,
      {},
      undefined,
      { repoRoot: checkout },
    );

    expect(rejections).toEqual([expect.stringContaining('inside the Vault Engine code checkout')]);
    expect(confirms).toEqual([true]);
    expect(await realFilesystemHost().pathExists(join(checkout, 'Notes'))).toBe(false);
    expect(result.path).toBe(join(await realpath(root), 'Vault'));
  });

  it('starts a new folder with the messy sample when asked (#650)', async () => {
    const parent = await makeTree({ 'Keep.md': '# Keep\n' });
    const target = join(parent, 'Try');

    const { result, asked } = await interactively({ 'vault.path': [target], 'vault.sample': ['messy'] }, [true]);

    expect(asked).toContain('vault.sample');
    expect(result.path).toBe(join(await realpath(parent), 'Try'));
    const sample = join(REPO_ROOT, ...MESSY_SAMPLE);
    expect(result.discovery.inventory.markdown_files).toBe(await countMarkdown(sample));
    expect(result.discovery.inventory.markdown_files).toBeGreaterThan(100);
    expect(await readFile(join(target, 'Bear Notes', (await readdir(join(sample, 'Bear Notes')))[0]!), 'utf8'))
      .toBe(await readFile(join(sample, 'Bear Notes', (await readdir(join(sample, 'Bear Notes')))[0]!), 'utf8'));
  });

  it('starts a new folder empty by default', async () => {
    const parent = await makeTree({ 'Keep.md': '# Keep\n' });
    const { result } = await interactively({ 'vault.path': [join(parent, 'Fresh')] }, [true]);
    expect(result.discovery.inventory.markdown_files).toBe(0);
  });

  it('asks again when the folder cannot be created', async () => {
    const parent = await makeTree({ 'Vault/A.md': '# A\n' });

    const { result, rejections } = await interactively(
      { 'vault.path': [join(parent, 'Missing'), join(parent, 'Vault')] },
      [true],
      { makeDirectory: async () => { throw new Error('EACCES: permission denied'); } },
    );

    expect(rejections).toEqual([`Could not create ${join(parent, 'Missing')}: EACCES: permission denied`]);
    expect(result.path).toBe(join(await realpath(parent), 'Vault'));
  });
});

describe('findObsidianVaults', () => {
  const folders = new Set(['/srv/tester/Notes', '/srv/tester/Work', '/srv/tester/Flat', '/srv/tester/Snapped', '/data/Shared']);
  const host = (files: Record<string, string>, env: Record<string, string> = {}) => fakeHost({
    env: name => env[name],
    readText: async path => {
      if (path === '/srv/tester/.config/obsidian/obsidian.json' && files.unreadable) throw new Error('EACCES');
      return files[path] ?? null;
    },
    inspectDirectory: async path => folders.has(path)
      ? { exists: true, directory: true, readable: true, writable: true }
      : { exists: false, directory: false, readable: false, writable: false },
  });
  const config = (vaults: Array<{ path?: unknown; ts?: unknown }>) => JSON.stringify({ vaults: Object.fromEntries(vaults.map((vault, index) => [`v${index}`, vault])) });

  it('reads native, Flatpak, and Snap installs, keeping folders that still exist', async () => {
    const vaults = await findObsidianVaults(host({
      '/srv/tester/.config/obsidian/obsidian.json': config([{ path: '/srv/tester/Notes', ts: 30 }, { path: '/srv/tester/Gone', ts: 99 }]),
      '/srv/tester/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json': config([{ path: '/srv/tester/Flat', ts: 20 }, { path: '/srv/tester/Notes/', ts: 10 }]),
      '/srv/tester/snap/obsidian/current/.config/obsidian/obsidian.json': config([{ path: '/srv/tester/Snapped' }]),
    }));

    expect(vaults).toEqual(['/srv/tester/Notes', '/srv/tester/Flat', '/srv/tester/Snapped']);
  });

  it('reads the config folder named by XDG_CONFIG_HOME', async () => {
    const vaults = await findObsidianVaults(host(
      { '/data/config/obsidian/obsidian.json': config([{ path: '/data/Shared', ts: 1 }]) },
      { XDG_CONFIG_HOME: '/data/config' },
    ));

    expect(vaults).toEqual(['/data/Shared']);
  });

  it.each([
    ['no config file', {}],
    ['an unreadable file', { unreadable: 'yes' }],
    ['a file that is not JSON', { '/srv/tester/.config/obsidian/obsidian.json': '{"vaults": ' }],
    ['a file of another shape', { '/srv/tester/.config/obsidian/obsidian.json': '{"vaults": ["/srv/tester/Notes"]}' }],
    ['vaults with no usable path', { '/srv/tester/.config/obsidian/obsidian.json': config([{ path: 'Notes' }, { path: 42 }, {}]) }],
  ])('suggests nothing for %s', async (_label, files) => {
    expect(await findObsidianVaults(host(files))).toEqual([]);
  });

});

describe('parseRelativeDirectory', () => {
  it.each([
    ['Templates', 'Templates'],
    ['Archive/Old/', 'Archive/Old'],
    [' Templates', null],
    ['/abs', null],
    ['a//b', null],
    ['../x', null],
    ['./x', null],
    ['', null],
  ])('parses %j as %j', (input, expected) => {
    expect(parseRelativeDirectory(input)).toBe(expected);
  });
});

describe('detectSyncService', () => {
  it('recognizes sync folder names and marker files', async () => {
    const none = async () => false;
    expect(await detectSyncService('/srv/u/Google Drive/Vault', none)).toBe('Google Drive');
    expect(await detectSyncService('/srv/u/OneDrive - Acme/Notes', none)).toBe('OneDrive');
    expect(await detectSyncService('/srv/u/Notes', none)).toBeNull();
    expect(await detectSyncService('/srv/u/Sync/Notes', async path => path === '/srv/u/Sync/.stfolder'))
      .toBe('Syncthing');
  });
});

describe('vault.sample in an answers file (#650)', () => {
  async function headlessVault(vault: Record<string, unknown>) {
    const prompter = createScriptedPrompter({ version: 1, vault } as never, () => {});
    return runVaultStage({
      host: realFilesystemHost(), prompter, analyzer: createAnalyzerRunner(SOURCE_ANALYZER), cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT,
    });
  }

  it('creates the folder with the messy sample, or empty', async () => {
    const parent = await makeTree({ 'Keep.md': '# Keep\n' });
    const messy = await headlessVault({ path: join(parent, 'Messy'), sample: 'messy' });
    expect(messy.discovery.inventory.markdown_files).toBe(await countMarkdown(join(REPO_ROOT, ...MESSY_SAMPLE)));
    const empty = await headlessVault({ path: join(parent, 'Empty'), sample: 'empty' });
    expect(empty.discovery.inventory.markdown_files).toBe(0);
  });

  it('refuses a folder that already exists, leaving it as it is', async () => {
    const parent = await makeTree({ 'Notes/A.md': '# A\n' });
    await expect(headlessVault({ path: join(parent, 'Notes'), sample: 'messy' })).rejects.toThrow(/vault\.sample.*already exists/);
    expect(await readdir(join(parent, 'Notes'))).toEqual(['A.md']);
  });

  it('refuses a new folder inside the code checkout', async () => {
    await expect(headlessVault({ path: join(REPO_ROOT, 'packages', 'sample-try'), sample: 'messy' })).rejects.toThrow(/vault\.sample/);
    expect(await realFilesystemHost().pathExists(join(REPO_ROOT, 'packages', 'sample-try'))).toBe(false);
  });
});

/** Markdown files under a folder, at any depth. */
async function countMarkdown(folder: string): Promise<number> {
  const entries = await readdir(folder, { recursive: true });
  return entries.filter(entry => String(entry).endsWith('.md')).length;
}

