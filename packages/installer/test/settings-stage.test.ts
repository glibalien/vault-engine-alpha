import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/env-file.js';
import type { Prompter } from '../src/prompter.js';
import { createScriptedPrompter } from '../src/prompter.js';
import { ServicePausedError, type ServiceBackend } from '../src/services.js';
import { extractionPreview, runSettingsStage, SettingsError } from '../src/settings-stage.js';
import { loadState, saveState, type InstallState } from '../src/state.js';
import { fakeEngineTools, makeTree, realFilesystemHost, removeTrees, replayPrompter } from './helpers.js';

afterEach(removeTrees);

const SETTINGS = [
  { setting: 'curator.dailyBudgetCents', value: 100 },
  { setting: 'wiki.projectType', value: 'project' },
  { setting: 'engine.memoryConsolidationModel', value: '[[GLM 5.2]]' },
  { setting: 'curator.wikiPageModel', value: null, inherits: true as const },
  { setting: 'engine.extractionEnabled', value: true, when: 'only if you approve attachment extraction' },
];

async function setup(input: {
  /** Engine's keys; by default the Gemini key, with extraction seeded off. */
  keys?: string[];
  seeded?: boolean;
  vision?: 'gemini' | 'claude' | 'model' | 'off';
  approved?: boolean | null;
  models?: Array<{ title: string; provider: string; model: string; add_to_catalog: boolean }>;
  /** The model title assigned to Engine's image vision. */
  visionModel?: string;
  files?: Record<string, number>;
  settings?: InstallState['plan']['review']['settings'];
  structure?: unknown;
} = {}) {
  const dataDir = await makeTree({});
  await mkdir(join(dataDir, 'installer'), { recursive: true });
  const engineEnv = join(dataDir, 'engine.env');
  const keys = input.keys ?? ['GEMINI_API_KEY'];
  await writeFile(engineEnv, ['VAULT_PATH=/notes', ...keys.map(name => `${name}=${name.toLowerCase()}`), ''].join('\n'), { mode: 0o600 });
  const state = {
    format: 'vault-installer-state',
    version: 1,
    approved_at: '2026-10-26T12:00:00.000Z',
    plan: {
      format: 'vault-installer-plan',
      version: 1,
      data_dir: dataDir,
      repo_root: '/repo',
      services: { user: 'tester', node_path: '/opt/node', engine_port: 3334, curator_port: 3335 },
      vault: {
        path: '/notes',
        settings_dir: 'Settings',
        exclusions: [],
        analyzer_exclusions: [],
        inventory: { total_files: 0, markdown_files: 0, non_markdown_by_extension: input.files ?? {}, excluded_entries: { directories: 0, symlinks: 0 } },
      },
      structure: input.structure ?? null,
      models: {
        preset: 'balanced',
        vision_provider: input.vision ?? 'gemini',
        roles: [{ setting: 'engine.visionModel', model: input.visionModel ?? 'Minimax M3' }],
        models: (input.models ?? []).map(model => ({ ...model, input: 0.3, output: 1.2 })),
      },
      curator: null,
      extraction_approved: input.approved ?? null,
      backup: { mode: 'skip', files: 0, bytes: 0 },
      review: {
        engine_database: '/notes/.vault-engine/vault.db',
        engine_models_dir: null,
        env_keys: { engine_first_boot: keys, engine_after_extraction_off: [], curator: [] },
        extraction_seeded_off: input.seeded ?? true,
        settings: input.settings ?? SETTINGS,
      },
    },
    stages: { configure: { completed_at: '2026-10-26T12:00:00.000Z', files: { [engineEnv]: 'old' } } },
  } as unknown as InstallState;
  const path = join(dataDir, 'installer', 'state.json');
  await saveState(path, state);
  return { state, path, engineEnv };
}

function deps(engine: ReturnType<typeof fakeEngineTools>, prompter: Prompter = createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, () => {})) {
  const restarts: string[] = [];
  const backend: ServiceBackend = {
    start: async () => {},
    restart: async unit => { restarts.push(unit); },
    startedAt: async () => restarts.length > 0 ? new Date('2100-01-01T00:00:00Z') : new Date(0),
    health: async () => ({ stopped: false, restarts: 0, detail: 'running' }),
    recentLogs: async () => '',
    logCommand: unit => `journalctl -u ${unit}`,
  };
  const host = realFilesystemHost({ httpStatus: async () => 200 });
  return { deps: { host, prompter, backend, engine: async () => engine.call, now: () => new Date('2026-10-26T13:00:00Z'), pollMs: 1 }, restarts };
}

const updates = (engine: ReturnType<typeof fakeEngineTools>) => engine.calls
  .filter(call => call.tool === 'update-settings')
  .map(call => [call.args.domain, call.args.patch]);

describe('runSettingsStage', () => {
  it('adds the models Engine lacks, then applies each domain\'s settings in one call', async () => {
    const { state, path } = await setup({
      vision: 'off',
      seeded: false,
      models: [
        { title: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', add_to_catalog: true },
        { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', add_to_catalog: false },
      ],
    });
    const engine = fakeEngineTools();

    await runSettingsStage(deps(engine).deps, state, path);

    expect(engine.catalog).toEqual([{ title: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', enabled: true }]);
    // The model note exists before a setting refers to it; the conditional setting waits.
    expect(engine.calls.map(call => call.tool)).toEqual(['get-settings', 'add-model', 'update-settings', 'update-settings', 'update-settings']);
    expect(updates(engine)).toEqual([
      ['engine', { memoryConsolidationModel: '[[GLM 5.2]]' }],
      ['wiki', { projectType: 'project' }],
      ['curator', { dailyBudgetCents: 100, wikiPageModel: null }],
    ]);
    expect((await loadState(path))?.stages.settings).toEqual({
      started_at: '2026-10-26T13:00:00.000Z',
      completed_at: '2026-10-26T13:00:00.000Z',
      extraction: 'not_needed',
      engine_restarted: false,
    });
  });

  it('applies the vault map in one call before the wiki and curator domains, a none as null', async () => {
    const { state, path } = await setup({
      vision: 'off',
      seeded: false,
      settings: [
        { setting: 'curator.dailyBudgetCents', value: 100 },
        { setting: 'vault.projectType', value: 'initiative' },
        { setting: 'vault.taskType', value: null },
        { setting: 'vault.taskActiveStatuses', value: [] },
      ],
    });
    const engine = fakeEngineTools();

    await runSettingsStage(deps(engine).deps, state, path);

    expect(updates(engine)).toEqual([
      ['vault', { projectType: 'initiative', taskType: null, taskActiveStatuses: [] }],
      ['curator', { dailyBudgetCents: 100 }],
    ]);
  });

  it('finishes a plan saved by the previous installer version, through the old names Engine still takes', async () => {
    // What the previous version saved: wiki and curator names for the map, a starter note
    // type with a project field, and the project statuses in the structure summary.
    const { path } = await setup({
      vision: 'off',
      seeded: false,
      structure: {
        source: 'field',
        analyzer_spec: { type_field: 'type', folder_rules: [], type_renames: {}, exclude: ['Settings'] },
        source_fingerprint: 'f'.repeat(64),
        types: [
          { name: 'project', from: 'vault', role: 'project', notes: 1, default_directory: 'Projects', fields: ['status'] },
          { name: 'note', from: 'starter', role: 'note', notes: 0, default_directory: null, fields: ['project'] },
        ],
        fields_from_vault: ['status'],
        starter_fields: [{ name: 'project', field_type: 'list', list_item_type: 'reference', reference_target: 'project' }],
        roles: { project: 'project', task: null, meeting: null, person: null, company: null },
        active_statuses: ['open'],
        status_groups: { done: ['done'], blocked: [], backlog: [], ignored: [] },
        unmanaged_fields: [],
        remove_type_field: false,
        warnings: [],
      },
      settings: [
        { setting: 'wiki.projectType', value: 'project' },
        { setting: 'wiki.statusOpen', value: ['open'] },
        { setting: 'wiki.statusDone', value: ['done'] },
        { setting: 'curator.dailyBudgetCents', value: 100 },
        { setting: 'curator.activeStatuses', value: ['open'] },
      ],
    });
    const engine = fakeEngineTools();
    const saved = await loadState(path);

    await runSettingsStage(deps(engine).deps, saved as InstallState, path);

    // The approved plan is applied as it was approved; Engine maps the old names to the vault keys.
    expect(saved?.plan.structure?.types.map(type => type.name)).toEqual(['project', 'note']);
    expect(updates(engine)).toEqual([
      ['wiki', { projectType: 'project', statusOpen: ['open'], statusDone: ['done'] }],
      ['curator', { dailyBudgetCents: 100, activeStatuses: ['open'] }],
    ]);
    expect((await loadState(path))?.stages.settings?.completed_at).toBe('2026-10-26T13:00:00.000Z');
  });

  it('keeps a planned model already in the catalog, and stops on one under another title', async () => {
    const model = { title: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', add_to_catalog: true };
    const same = await setup({ vision: 'off', seeded: false, models: [model] });
    const engine = fakeEngineTools();
    engine.catalog.push({ title: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', enabled: true });
    await runSettingsStage(deps(engine).deps, same.state, same.path);
    expect(engine.calls.map(call => call.tool)).not.toContain('add-model');

    const other = await setup({ vision: 'off', seeded: false, models: [model] });
    const renamed = fakeEngineTools();
    renamed.catalog.push({ title: 'GLM', provider: 'openrouter', model: 'z-ai/glm-5.2', enabled: true });
    await expect(runSettingsStage(deps(renamed).deps, other.state, other.path))
      .rejects.toThrow('Engine\'s model catalog already has z-ai/glm-5.2 as "GLM", but the plan uses "GLM 5.2".');
  });

  it('stops when Engine rejects a setting, after applying the rest', async () => {
    const { state, path } = await setup({ vision: 'off', seeded: false });
    const engine = fakeEngineTools();
    engine.rejectSettings.add('wiki.projectType');

    await expect(runSettingsStage(deps(engine).deps, state, path)).rejects.toThrow(SettingsError);
    await expect(runSettingsStage(deps(engine).deps, state, path)).rejects.toThrow('Engine did not take wiki.projectType (rejected). The others were applied.');
    expect(engine.settings.get('curator')).toEqual({ dailyBudgetCents: 100, wikiPageModel: null });
    expect(state.stages.settings?.completed_at).toBeNull();
  });

  it('stops when a setting takes another effective value, as a null that resets to a default', async () => {
    const { state, path } = await setup({ vision: 'off', seeded: false });
    const engine = fakeEngineTools();
    const call = engine.call;
    engine.call = async (tool, args, options) => {
      const result = await call(tool, args, options) as { effective?: Record<string, unknown> };
      if (tool === 'update-settings' && args?.domain === 'curator') result.effective = { ...result.effective, wikiPageModel: '[[Kimi K2.6]]' };
      return result as never;
    };

    await expect(runSettingsStage(deps(engine).deps, state, path))
      .rejects.toThrow('Engine did not take curator.wikiPageModel (it is "[[Kimi K2.6]]", not null).');
  });
});

describe('attachment extraction consent', () => {
  it('turns extraction on and restarts Engine once when the plan approves it', async () => {
    const { state, path, engineEnv } = await setup({ keys: ['GEMINI_API_KEY', 'DEEPGRAM_API_KEY'], approved: true });
    const before = await readFile(engineEnv, 'utf8');
    const engine = fakeEngineTools();
    const { deps: settingsDeps, restarts } = deps(engine);

    await runSettingsStage(settingsDeps, state, path);

    expect(engine.settings.get('engine')).toMatchObject({ extractionEnabled: true });
    expect(restarts).toEqual(['vault-engine.service']);
    // Engine had its keys from the first start; only the setting changes.
    expect(await readFile(engineEnv, 'utf8')).toBe(before);
    const saved = await loadState(path);
    expect(saved?.stages.settings).toMatchObject({ extraction: 'approved', engine_restarted: true });
  });

  it('leaves extraction off and the keys in engine.env when the plan declines', async () => {
    const { state, path, engineEnv } = await setup({ approved: false });
    const engine = fakeEngineTools();
    const { deps: settingsDeps, restarts } = deps(engine);

    await runSettingsStage(settingsDeps, state, path);

    expect(parseEnvFile(await readFile(engineEnv, 'utf8')).get('GEMINI_API_KEY')).toBe('gemini_api_key');
    expect(engine.settings.get('engine')?.extractionEnabled).toBeUndefined();
    expect(restarts).toEqual([]);
    expect(state.stages.settings?.extraction).toBe('declined');
  });

  it('asks interactively when the plan left it open, and keeps it off on a headless resume', async () => {
    const asked = await setup();
    const yes = fakeEngineTools();
    await runSettingsStage(deps(yes, replayPrompter({}, [true]).prompter).deps, asked.state, asked.path);
    expect(asked.state.stages.settings?.extraction).toBe('approved');

    const headless = await setup();
    const no = fakeEngineTools();
    await runSettingsStage(deps(no).deps, headless.state, headless.path);
    expect(headless.state.stages.settings?.extraction).toBe('declined');
  });

  it('counts a restart the user ran by hand, once Engine runs a newer process', async () => {
    const { state, path } = await setup({ approved: true });
    const engine = fakeEngineTools();
    const { deps: settingsDeps } = deps(engine);
    // With --no-sudo and no terminal, the restart is printed and the install pauses.
    settingsDeps.backend.restart = async () => { throw new ServicePausedError('Run the commands above, then run the install again.'); };

    await expect(runSettingsStage(settingsDeps, state, path)).rejects.toThrow(ServicePausedError);
    expect(state.stages.settings).toMatchObject({ extraction: 'approved', engine_restarted: false, restart_requested_at: expect.any(String) });

    // The user restarted Engine; the rerun sees its newer process and does not ask again.
    settingsDeps.backend.startedAt = async () => new Date('2100-01-01T00:00:00Z');
    await runSettingsStage(settingsDeps, state, path);
    expect(state.stages.settings).toMatchObject({ engine_restarted: true });
  });

  it('expects the extractor Engine registers for the chosen catalog model\'s provider', async () => {
    const claude = { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', add_to_catalog: false };
    const anthropic = await setup({ vision: 'model', keys: ['ANTHROPIC_API_KEY'], approved: true, models: [claude], visionModel: 'Claude Sonnet 4.6' });
    const engine = fakeEngineTools();
    engine.extractors.active = engine.extractors.active.filter(entry => entry.id !== 'openai-compat-vision-image');

    await runSettingsStage(deps(engine).deps, anthropic.state, anthropic.path);
    expect(anthropic.state.stages.settings?.engine_restarted).toBe(true);

    const luna = { title: 'GPT-6 Luna', provider: 'openai', model: 'gpt-6-luna', add_to_catalog: true };
    const openai = await setup({ vision: 'model', keys: ['OPENAI_API_KEY'], approved: true, models: [luna], visionModel: 'GPT-6 Luna' });
    const withoutCompat = fakeEngineTools();
    withoutCompat.extractors.active = withoutCompat.extractors.active.filter(entry => entry.id !== 'openai-compat-vision-image');
    await expect(runSettingsStage(deps(withoutCompat).deps, openai.state, openai.path)).rejects.toThrow('does not read images with model');
  });

  it('stops when the restarted Engine still has extraction off', async () => {
    const { state, path } = await setup({ approved: true });
    const engine = fakeEngineTools();
    engine.extractors.disabled.push({ id: 'gemini-vision-image' });

    await expect(runSettingsStage(deps(engine).deps, state, path)).rejects.toThrow('Engine restarted but still has extraction off.');
    expect(state.stages.settings?.engine_restarted).toBe(false);
  });

  it('stops when the restarted Engine lacks one of its keys', async () => {
    const { state, path } = await setup({ approved: true });
    const engine = fakeEngineTools();
    engine.extractors.active = engine.extractors.active.filter(entry => entry.id !== 'gemini-vision-image');
    engine.extractors.unavailable.push({ id: 'gemini-vision-image', missingKey: 'GEMINI_API_KEY' });

    await expect(runSettingsStage(deps(engine).deps, state, path)).rejects.toThrow('Engine restarted but does not have GEMINI_API_KEY.');
    expect(state.stages.settings?.engine_restarted).toBe(false);
  });

  it('restarts Engine on a rerun that stopped after turning extraction on', async () => {
    const { state, path } = await setup({ approved: true });
    state.stages.settings = { started_at: '2026-10-26T12:30:00.000Z', completed_at: null, extraction: 'approved', engine_restarted: false };
    const engine = fakeEngineTools();
    const { deps: settingsDeps, restarts } = deps(engine);

    await runSettingsStage(settingsDeps, state, path);

    expect(restarts).toEqual(['vault-engine.service']);
    expect(engine.settings.get('engine')).toMatchObject({ extractionEnabled: true });
  });
});

describe('extractionPreview', () => {
  it('counts files by kind for the chosen provider, with a rough cost', async () => {
    const { state } = await setup({
      keys: ['GEMINI_API_KEY', 'DEEPGRAM_API_KEY'],
      files: { '.PNG': 100, '.jpg': 900, '.gif': 5, '.pdf': 7, '.mp3': 2, '.docx': 3 },
    });

    expect(extractionPreview(state.plan).slice(1)).toEqual([
      // gif is not a Gemini image type; 1,000 images at 300–2,000 input and 200–1,000 output tokens.
      'Images: 1000 files, read by Gemini, about $0.59–$3.10 in all.',
      'PDFs: 7 files. Text PDFs are read free; only scanned pages go to Gemini, at about its image rate per page.',
      'Audio: 2 files, transcribed by Deepgram, about $0.01–$0.26 for 1–30 minutes each.',
      'Counts are every such file in the vault; Engine reads only those embedded in a note, once each.',
    ]);
  });

  it('names Gemini for scanned PDFs under a catalog vision model, or says they are not read', async () => {
    const minimax = { title: 'Minimax M3', provider: 'fireworks', model: 'accounts/fireworks/models/minimax-m3', add_to_catalog: true };
    const withGemini = await setup({ vision: 'model', keys: ['GEMINI_API_KEY'], files: { '.png': 10, '.pdf': 2 }, models: [minimax] });
    const without = await setup({ vision: 'model', keys: [], files: { '.png': 10, '.pdf': 2 } });

    expect(extractionPreview(withGemini.state.plan)[1]).toBe('Images: 10 files, read by your vision model, about $0.00–$0.02 in all.');
    expect(extractionPreview(withGemini.state.plan)[2]).toContain('only scanned pages go to Gemini');
    expect(extractionPreview(without.state.plan)[2]).toBe('PDFs: 2 files. Text PDFs are read free; scanned PDFs are not read, because that needs a Gemini key.');
  });

  it('sends scanned PDFs to an OpenAI or Anthropic vision model and counts only the image types it takes', async () => {
    const luna = { title: 'GPT-6 Luna', provider: 'openai', model: 'gpt-6-luna', add_to_catalog: true };
    const plan = (await setup({ vision: 'model', keys: [], files: { '.png': 10, '.tiff': 4, '.pdf': 2 }, models: [luna], visionModel: 'GPT-6 Luna' })).state.plan;

    expect(extractionPreview(plan)[1]).toMatch(/^Images: 10 files, read by your vision model/);
    expect(extractionPreview(plan)[2]).toBe('PDFs: 2 files. Text PDFs are read free; only scanned pages go to your vision model, at about its image rate per page.');
  });
});
