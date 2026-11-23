import { descriptorsFor, validateValue, vaultAliasFor, type SettingsDomain } from '@vault/settings-registry';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Answers } from '../src/answers.js';
import { runCli } from '../src/cli.js';
import type { CuratorPlan } from '../src/curator-plan.js';
import { runModelsStage } from '../src/models.js';
import { createScriptedPrompter } from '../src/prompter.js';
import type { ProviderId, ProviderKey } from '../src/providers.js';
import { buildReview, renderReview } from '../src/review.js';
import { Secret } from '../src/secret.js';
import type { StructurePlan } from '../src/structure.js';
import { NO_STATUS } from '../src/vault-map.js';
import type { VaultPlan } from '../src/vault.js';
import type { BackupPlan } from '../src/backup.js';
import { fm, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER, TEST_SERVICES } from './helpers.js';

afterEach(removeTrees);

function key(provider: ProviderId): ProviderKey {
  return { provider, source: 'entered', secret: new Secret(`key-${provider}`), check: 'valid', detail: 'accepted' };
}

const CURATOR: CuratorPlan = { dailyBudgetCents: 100, sweepAt: '05:00', tz: 'UTC', wikiMode: 'live' };

function vault(syncService: string | null = null): VaultPlan {
  return {
    path: '/notes',
    settingsDir: 'Settings',
    wikiDir: 'Wikis',
    topicDir: 'Topics',
    syncService,
    discovery: { inventory: { markdown_files: 10 } },
  } as unknown as VaultPlan;
}

async function review(providers: ProviderId[], options: {
  models?: Answers['models'];
  curator?: CuratorPlan | null;
  vault?: VaultPlan | null;
  structure?: StructurePlan | null;
  backup?: BackupPlan | null;
  obsidianPlugin?: boolean | null;
} = {}) {
  const keys = providers.map(key);
  const prompter = createScriptedPrompter({ version: 1, vault: { path: '/notes' }, models: options.models ?? {} }, () => {});
  const curator = options.curator === undefined ? CURATOR : options.curator;
  const models = await runModelsStage({ prompter, keys, curatorInstalled: curator !== null });
  return buildReview({
    dataDir: '/data',
    services: TEST_SERVICES,
    vault: options.vault === undefined ? vault() : options.vault,
    structure: options.structure ?? null,
    keys,
    models,
    curator,
    backup: options.backup === undefined ? { mode: 'markdown', files: 10, bytes: 2048 } : options.backup,
    obsidianPlugin: options.obsidianPlugin ?? null,
  });
}


/** A structure plan in which every kind is none. */
const NO_KINDS = {
  spec: { type_field: null, folder_rules: [], type_renames: {}, exclude: [] },
  roles: { project: null, task: null, meeting: null, person: null, company: null },
  status: { project: NO_STATUS, task: NO_STATUS },
  fields: { due: null, date: null, people: null, company: null, priority: null, scheduled: null },
  journalType: 'note',
  analysis: null,
  starterTypes: [],
  starterFields: [],
} as unknown as StructurePlan;

/** The descriptor an installer setting writes: its domain's own, or the vault key an old name now aliases. */
function settingDescriptor(setting: string) {
  const [domain, key] = setting.split('.') as [SettingsDomain, string];
  const alias = vaultAliasFor(domain, key);
  return alias
    ? descriptorsFor('vault').find(candidate => candidate.key === alias.vaultKey)
    : descriptorsFor(domain).find(candidate => candidate.key === key);
}

describe('buildReview', () => {
  it('places each key in the right env file and seeds extraction off until consent', async () => {
    const summary = await review(['anthropic', 'fireworks', 'gemini', 'deepgram', 'exa'], { models: { vision_provider: 'gemini' } });

    // A new database seeds extractionEnabled off, so Engine has every key from its first start.
    expect(summary.env_keys).toEqual({
      engine_first_boot: ['ANTHROPIC_API_KEY', 'FIREWORKS_API_KEY', 'GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'EXA_API_KEY'],
      engine_after_extraction_off: [],
      curator: ['ANTHROPIC_API_KEY', 'OPENAI_COMPAT_API_KEY'],
    });
    expect(summary.extraction_seeded_off).toBe(true);
    expect(summary.files.map(file => file.path)).not.toContain('/data/installer/pending-keys.env');
    expect(summary.settings).toContainEqual({ setting: 'engine.visionProvider', value: 'gemini' });
    expect(summary.settings).toContainEqual({
      setting: 'engine.extractionEnabled', value: true, when: 'only if you approve attachment extraction',
    });
    // In the order they run: Curator starts only after Engine has any approved keys.
    expect(summary.sudo_commands).toEqual([
      { command: 'sudo install -m 0644 /data/installer/units/vault-engine.service /etc/systemd/system/vault-engine.service' },
      { command: 'sudo systemctl daemon-reload' },
      { command: 'sudo systemctl enable --now vault-engine.service' },
      { command: 'sudo systemctl restart vault-engine.service', when: 'only if you approve attachment extraction' },
      { command: 'sudo install -m 0644 /data/installer/units/vault-curator.service /etc/systemd/system/vault-curator.service' },
      { command: 'sudo systemctl daemon-reload' },
      { command: 'sudo systemctl enable --now vault-curator.service' },
    ]);
    expect(summary.paid_calls).toContainEqual(expect.stringContaining(
      'Attachment extraction (images and scanned PDFs via Gemini; audio via Deepgram) stays off until you approve it'));
  });

  it('holds extracting keys back from a managed vault until its extraction is off', async () => {
    // An existing database ignores the env seed and keeps its own settings, under which a
    // model key alone could start extraction.
    const managed = { ...vault(), managedByEngine: true } as VaultPlan;
    const summary = await review(['anthropic', 'fireworks', 'deepgram', 'exa'], { vault: managed, models: { vision_provider: 'off' } });

    expect(summary.env_keys).toMatchObject({
      engine_first_boot: ['EXA_API_KEY'],
      engine_after_extraction_off: ['ANTHROPIC_API_KEY', 'FIREWORKS_API_KEY', 'DEEPGRAM_API_KEY'],
    });
    expect(summary.extraction_seeded_off).toBe(false);
    expect(summary.settings[0]).toEqual({
      setting: 'engine.extractionEnabled',
      value: false,
      when: 'as soon as Engine starts, before its other keys are added',
    });
    expect(summary.sudo_commands).toContainEqual({
      command: 'sudo systemctl restart vault-engine.service',
      when: 'after extraction is turned off, to add the held keys',
    });
    expect(renderReview(summary)).toContain('engine.env once Engine\'s extraction is off: ANTHROPIC_API_KEY, FIREWORKS_API_KEY, DEEPGRAM_API_KEY');
  });

  it('never writes a Gemini key when image vision is off', async () => {
    const summary = await review(['fireworks', 'gemini'], { models: { vision_provider: 'off' } });

    // Engine reads it only for vision, and its default vision provider is Gemini.
    expect(summary.env_keys.engine_first_boot).toEqual(['FIREWORKS_API_KEY']);
    expect(summary.extraction_seeded_off).toBe(false);
    expect(summary.sudo_commands.some(command => command.command.includes('restart'))).toBe(false);
    expect(summary.paid_calls).toContain('Attachment extraction: off.');
  });

  it('leaves Curator out entirely when it is not installed', async () => {
    const summary = await review(['openrouter'], { curator: null });

    expect(summary.files.map(file => file.path)).not.toContain('/data/curator.env');
    expect(summary.sudo_commands.map(command => command.command).join('\n')).not.toContain('vault-curator');
    expect(summary.env_keys.curator).toEqual([]);
    expect(summary.settings.filter(setting => setting.setting.startsWith('curator.'))).toEqual([]);
    expect(summary.paid_calls.join('\n')).not.toContain('Curator calls models');
  });

  it('applies model settings only for roles in use, plus the Curator choices', async () => {
    const summary = await review(['anthropic'], { curator: { ...CURATOR, dailyBudgetCents: 250 } });
    const inheriting = summary.settings.filter(setting => setting.inherits);

    expect(summary.settings.filter(setting => !inheriting.includes(setting))).toEqual([
      { setting: 'engine.memoryConsolidationModel', value: '[[Claude Sonnet 4.6]]' },
      { setting: 'chat.defaultModel', value: '[[Claude Sonnet 4.6]]' },
      { setting: 'chat.titleModel', value: '[[Claude Sonnet 4.6]]' },
      { setting: 'chat.vizModel', value: '[[Claude Sonnet 4.6]]' },
      { setting: 'curator.model', value: '[[Claude Sonnet 4.6]]' },
      { setting: 'curator.fieldGuessModel', value: '[[Claude Sonnet 4.6]]' },
      { setting: 'engine.visionProvider', value: 'claude' },
      { setting: 'engine.extractionEnabled', value: true, when: 'only if you approve attachment extraction' },
      { setting: 'curator.dailyBudgetCents', value: 250 },
      { setting: 'curator.sweepAt', value: '05:00' },
      { setting: 'curator.tz', value: 'UTC' },
      { setting: 'curator.wikiReconciliationMode', value: 'live' },
      { setting: 'curator.memorySweepEnabled', value: false },
      { setting: 'curator.conversationSweepEnabled', value: false },
      { setting: 'curator.conversationCaptureMode', value: 'off' },
      { setting: 'curator.orgSweepEnabled', value: false },
    ]);
    expect(summary.paid_calls).toContain('Curator calls models from its first start, up to $2.50 a day (UTC).');
  });

  it('writes an explicit null for each role that uses Curator\'s writing model, so no older override survives', async () => {
    const summary = await review(['fireworks'], {
      models: { preset: 'custom', vision_provider: 'off', roles: { 'curator.wikiPageModel': null, 'curator.wikiHomeModel': 'GPT-OSS 120B' } },
    });
    const value = (name: string) => summary.settings.find(setting => setting.setting === name);

    expect(value('curator.wikiPageModel')).toEqual({ setting: 'curator.wikiPageModel', value: null, inherits: true });
    expect(value('curator.memorySweepModel')?.value).toBeNull();
    expect(value('curator.wikiHomeModel')?.value).toBe('[[GPT-OSS 120B]]');
    // A role that is off is left as it is.
    expect(value('engine.visionModel')).toBeUndefined();
    expect(renderReview(summary)).toMatch(/model settings = none \(they use Curator's writing model\): curator\.wikiPlanningModel, curator\.wikiPageModel/);
  });

  it('writes the map through the vault keys, a none as null, and the journal kind only with Curator', async () => {
    const structure = {
      ...NO_KINDS,
      roles: { project: 'initiative', task: 'task', meeting: null, person: 'contact', company: null },
      status: {
        project: { field: 'stage', starter: false, active: ['active'], groups: { done: ['finished'], blocked: [], backlog: [], ignored: ['dropped', 'cancelled'] } },
        task: NO_STATUS,
      },
    } as unknown as StructurePlan;
    const withCurator = await review(['anthropic'], { structure });
    const withoutCurator = await review(['anthropic'], { structure, curator: null });
    const vaultSettings = (summary: Awaited<ReturnType<typeof review>>) =>
      summary.settings.filter(setting => setting.setting.startsWith('vault.'));

    const expected = [
      { setting: 'vault.projectType', value: 'initiative' },
      { setting: 'vault.taskType', value: 'task' },
      { setting: 'vault.meetingType', value: null },
      { setting: 'vault.personType', value: 'contact' },
      { setting: 'vault.companyType', value: null },
      { setting: 'vault.journalType', value: 'note' },
      // Daily notes are written too, none when the notes have no such kind (#572).
      { setting: 'vault.dailyNoteType', value: null },
      { setting: 'vault.projectStatusField', value: 'stage' },
      { setting: 'vault.projectActiveStatuses', value: ['active'] },
      { setting: 'vault.projectDoneStatuses', value: ['finished'] },
      { setting: 'vault.projectBlockedStatuses', value: [] },
      { setting: 'vault.projectBacklogStatuses', value: [] },
      { setting: 'vault.projectIgnoredStatuses', value: ['dropped', 'cancelled'] },
      // A kind with no status field has no status values either.
      { setting: 'vault.taskStatusField', value: null },
      { setting: 'vault.taskActiveStatuses', value: [] },
      { setting: 'vault.taskDoneStatuses', value: [] },
      { setting: 'vault.taskBlockedStatuses', value: [] },
      { setting: 'vault.taskBacklogStatuses', value: [] },
      { setting: 'vault.taskIgnoredStatuses', value: [] },
      // Field names the notes lack are none too, so Engine reports none of them missing.
      { setting: 'vault.dueField', value: null },
      { setting: 'vault.dateField', value: null },
      { setting: 'vault.peopleField', value: null },
      { setting: 'vault.companyField', value: null },
      { setting: 'vault.priorityField', value: null },
      { setting: 'vault.scheduledField', value: null },
      { setting: 'vault.wikiDir', value: 'Wikis' },
      { setting: 'vault.topicDir', value: 'Topics' },
    ];
    expect(vaultSettings(withCurator)).toEqual(expected);
    // Without Curator there is no journal and no topic notes.
    expect(vaultSettings(withoutCurator)).toEqual(expected
      .filter(setting => setting.setting !== 'vault.topicDir')
      .map(setting => setting.setting === 'vault.journalType' ? { ...setting, value: null } : setting));
    // Nothing goes through the old wiki and curator names any more.
    expect(withCurator.settings.filter(setting => setting.setting.startsWith('wiki.'))).toEqual([]);
    expect(withCurator.settings.map(setting => setting.setting))
      .not.toEqual(expect.arrayContaining(['curator.activeStatuses', 'curator.topicDir', 'curator.projectStatusField']));
    for (const { setting, value } of expected) {
      const descriptor = settingDescriptor(setting);
      expect(descriptor && validateValue(descriptor, value), setting).toBeNull();
    }
    expect(renderReview(withoutCurator)).toContain('vault.meetingType = none');
    expect(renderReview(withoutCurator)).toContain('vault.taskActiveStatuses = none');
  });

  it('sets the tick values from the task statuses, so ticking a task writes one of its values', async () => {
    const structure = {
      ...NO_KINDS,
      roles: { ...NO_KINDS.roles, task: 'todo' },
      status: {
        project: NO_STATUS,
        task: { field: 'state', starter: false, active: ['next', 'open'], groups: { done: ['complete'], blocked: [], backlog: [], ignored: [] } },
      },
    } as unknown as StructurePlan;
    const summary = await review(['anthropic'], { structure });

    expect(summary.settings).toContainEqual({ setting: 'vault.taskTickStatus', value: 'complete' });
    expect(summary.settings).toContainEqual({ setting: 'vault.taskUntickStatus', value: 'open' });
    expect((await review(['anthropic'], { structure: NO_KINDS })).settings.map(setting => setting.setting))
      .not.toContain('vault.taskTickStatus');
  });

  it('turns the optional sweeps off explicitly, so a managed vault cannot keep one running', async () => {
    const summary = await review(['anthropic'], { vault: { ...vault(), managedByEngine: true } as VaultPlan });
    const sweeps = [
      { setting: 'curator.memorySweepEnabled', value: false },
      { setting: 'curator.conversationSweepEnabled', value: false },
      { setting: 'curator.conversationCaptureMode', value: 'off' },
      { setting: 'curator.orgSweepEnabled', value: false },
    ];

    expect(summary.settings).toEqual(expect.arrayContaining(sweeps));
    for (const { setting, value } of sweeps) {
      const descriptor = descriptorsFor('curator').find(candidate => `curator.${candidate.key}` === setting);
      expect(descriptor && validateValue(descriptor, value)).toBeNull();
    }
    const withoutCurator = await review(['anthropic'], { curator: null });
    expect(withoutCurator.settings.some(setting => setting.setting.includes('Sweep'))).toBe(false);
  });

  it('keeps the database and the search model cache out of a synced folder', async () => {
    const synced = await review(['anthropic'], { vault: vault('Dropbox') });
    const plain = await review(['anthropic']);

    expect(synced.engine_database).toBe('/data/vault.db');
    expect(synced.engine_models_dir).toBe('/data/models');
    expect(synced.vault_changes).toContain('Engine keeps its database (/data/vault.db) and search model cache (/data/models/) outside what Dropbox syncs.');
    expect(plain.engine_database).toBe('/notes/.vault-engine/vault.db');
    expect(plain.engine_models_dir).toBeNull();
    // An existing database stays where it is.
    const managed = await review(['anthropic'], { vault: { ...vault('Dropbox'), managedByEngine: true } as VaultPlan });
    expect(managed.engine_database).toBe('/notes/.vault-engine/vault.db');
    expect(managed.engine_models_dir).toBeNull();
    expect(managed.vault_changes).toContain('Engine keeps using its existing database, /notes/.vault-engine/vault.db.');
  });

  it('sets the wiki and topic folders the vault stage chose', async () => {
    const chosen = { ...vault(), wikiDir: 'Vault Wikis', topicDir: 'Vault Topics' } as VaultPlan;
    const withCurator = await review(['anthropic'], { vault: chosen, structure: NO_KINDS });
    const withoutCurator = await review(['anthropic'], { vault: chosen, structure: NO_KINDS, curator: null });
    const plain = await review(['anthropic'], { structure: NO_KINDS });
    const folders = (summary: Awaited<ReturnType<typeof review>>) =>
      summary.settings.filter(setting => setting.setting === 'vault.wikiDir' || setting.setting === 'vault.topicDir');

    expect(folders(withCurator)).toEqual([
      { setting: 'vault.wikiDir', value: 'Vault Wikis' },
      { setting: 'vault.topicDir', value: 'Vault Topics' },
    ]);
    // Topic notes are Curator's.
    expect(folders(withoutCurator)).toEqual([{ setting: 'vault.wikiDir', value: 'Vault Wikis' }]);
    // The usual names are written too: the map states every designation.
    expect(folders(plain)).toEqual([{ setting: 'vault.wikiDir', value: 'Wikis' }, { setting: 'vault.topicDir', value: 'Topics' }]);
    // With no structure planned (a vault Engine already manages), no map is written.
    expect((await review(['anthropic'])).settings.some(setting => setting.setting.startsWith('vault.'))).toBe(false);
    expect(withCurator.vault_changes).toContain('Wiki pages go to Vault Wikis/ instead of Wikis/.');
    expect(plain.vault_changes).toContain('Wiki pages go to Wikis/.');
    for (const { setting, value } of folders(withCurator)) {
      const descriptor = settingDescriptor(setting);
      expect(descriptor && validateValue(descriptor, value)).toBeNull();
    }
  });

  it('lists the Obsidian plugin folder when the install may add the plugin', async () => {
    const obsidian = { ...vault(), obsidian: true } as VaultPlan;
    const plugin = (summary: Awaited<ReturnType<typeof review>>) =>
      summary.files.find(file => file.path === '/notes/.obsidian/plugins/vault-engine/');

    expect(plugin(await review(['anthropic'], { vault: obsidian }))?.purpose)
      .toMatch(/^only if you agree at the end: the Vault Engine Obsidian plugin .*data\.json \(private\); a plugin already there is not replaced without asking$/);
    expect(plugin(await review(['anthropic'], { vault: obsidian, obsidianPlugin: true }))?.purpose).toMatch(/^the Vault Engine Obsidian plugin/);
    expect(plugin(await review(['anthropic'], { vault: obsidian, obsidianPlugin: false }))).toBeUndefined();
    expect(plugin(await review(['anthropic']))).toBeUndefined();
    expect(plugin(await review(['anthropic'], { vault: { ...obsidian, managedByEngine: true } as VaultPlan }))).toBeUndefined();
  });

  it('renders every section', async () => {
    const text = renderReview(await review(['anthropic', 'deepgram']));

    expect(text).toContain('/data/engine.env (private)');
    expect(text).toContain('engine.env: ANTHROPIC_API_KEY, DEEPGRAM_API_KEY');
    expect(text).toContain('engine.env also has EXTRACTION_ENABLED=false');
    expect(text).toContain('curator.env: ANTHROPIC_API_KEY');
    expect(text).toContain('sudo systemctl restart vault-engine.service  (only if you approve attachment extraction)');
    expect(text).toContain('curator.dailyBudgetCents = 100');
    expect(text).toContain('Back up 10 Markdown files');
  });
});

describe('plan output', () => {
  it('never contains a key, on any output', async () => {
    const notes = await makeTree({ 'Projects/A.md': fm({ type: 'project', status: 'open' }) });
    const directory = await makeTree({});
    const answers = join(directory, 'answers.json');
    const out = join(directory, 'plan.json');
    await writeFile(answers, JSON.stringify({
      version: 1,
      vault: { path: notes },
      providers: { anthropic: 'env:ANTHROPIC_API_KEY', fireworks: 'env:FIREWORKS_API_KEY', deepgram: 'env:DEEPGRAM_API_KEY' },
    }));
    const secrets = { ANTHROPIC_API_KEY: 'sk-ant-secret-1', FIREWORKS_API_KEY: 'fw-secret-2', DEEPGRAM_API_KEY: 'dg-secret-3' };
    let stdout = '';
    let stderr = '';

    const code = await runCli(['plan', '--answers', answers, '--json', '--out', out], {
      stdout: text => { stdout += text; },
      stderr: text => { stderr += text; },
      isInteractive: false,
    }, {
      host: realFilesystemHost({ env: name => secrets[name as keyof typeof secrets] }),
      cwd: '/',
      repoRoot: REPO_ROOT,
      analyzerCommand: SOURCE_ANALYZER,
      createInteractivePrompter: () => { throw new Error('tests never prompt interactively'); },
      now: () => new Date('2026-10-26T12:00:00Z'),
    });

    expect(code).toBe(0);
    const written = await readFile(out, 'utf8');
    for (const secret of Object.values(secrets)) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
      expect(written).not.toContain(secret);
    }
    const report = JSON.parse(stdout);
    expect(report.providers.map((provider: { source: string }) => provider.source))
      .toEqual(['env:ANTHROPIC_API_KEY', 'env:FIREWORKS_API_KEY', 'env:DEEPGRAM_API_KEY']);
    expect(report.models.roles.find((role: { setting: string }) => role.setting === 'curator.model').model).toBe('Claude Sonnet 4.6');
    expect(report.curator).toEqual({ daily_budget_cents: 100, sweep_at: '05:00', tz: 'UTC', wiki_mode: 'live' });
    expect(report.review.settings).toContainEqual({ setting: 'vault.projectActiveStatuses', value: ['open'] });
    expect(report.review.settings).toContainEqual({ setting: 'vault.taskType', value: null });
    // The plan states the map, each none, and what each none turns off.
    expect(report.vault_map.kinds).toEqual({
      project: { type: 'project', from: 'vault' },
      task: { type: null, from: null },
      meeting: { type: null, from: null },
      person: { type: null, from: null },
      company: { type: null, from: null },
      journal: { type: 'note', from: 'curator' },
      dailyNote: { type: null, from: null },
    });
    expect(report.vault_map.status.project).toMatchObject({ field: 'status', from: 'vault', active: ['open'] });
    expect(report.vault_map.off).toEqual([
      expect.stringContaining('No task kind'),
      expect.stringContaining('No meeting kind'),
      expect.stringContaining('No person kind'),
      expect.stringContaining('No company kind'),
      expect.stringContaining('No daily-note kind'),
      ...['due-date', 'date', 'people', 'company', 'priority', 'scheduled-date'].map(field => expect.stringContaining(`No ${field} field`)),
    ]);
    // A default plan creates no type the notes do not have: no note, no starter project.
    expect(report.structure.types.map((type: { name: string }) => type.name)).toEqual(['project']);
    expect(report.structure.starter_fields).toEqual([]);
    // Not an Obsidian vault: no plugin question.
    expect(report.obsidian_plugin).toBeNull();
  });

  it('records the answers file\'s choice about the Obsidian plugin in the plan', async () => {
    const notes = await makeTree({ 'Inbox.md': '# Inbox\n', '.obsidian/app.json': '{}\n' });
    const directory = await makeTree({});
    const plan = async (obsidian?: Answers['obsidian']) => {
      const answers = join(directory, 'answers.json');
      await writeFile(answers, JSON.stringify({ version: 1, vault: { path: notes }, ...(obsidian ? { obsidian } : {}) }));
      let stdout = '';
      const code = await runCli(['plan', '--answers', answers, '--json'], { stdout: text => { stdout += text; }, stderr: () => {}, isInteractive: false }, {
        host: realFilesystemHost(),
        cwd: '/',
        repoRoot: REPO_ROOT,
        analyzerCommand: SOURCE_ANALYZER,
        createInteractivePrompter: () => { throw new Error('tests never prompt interactively'); },
        now: () => new Date('2026-10-26T12:00:00Z'),
      });
      expect(code).toBe(0);
      return JSON.parse(stdout) as { obsidian_plugin: boolean | null; review: { files: Array<{ path: string }> } };
    };
    const pluginFolder = `${join(notes, '.obsidian', 'plugins', 'vault-engine')}/`;

    const asked = await plan({ install_plugin: true });
    expect(asked.obsidian_plugin).toBe(true);
    expect(asked.review.files.map(file => file.path)).toContain(pluginFolder);
    // Headless, the plugin is added only when the answers file asks.
    const omitted = await plan();
    expect(omitted.obsidian_plugin).toBe(false);
    expect(omitted.review.files.map(file => file.path)).not.toContain(pluginFolder);
  });
});
