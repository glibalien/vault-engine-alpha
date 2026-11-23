import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from '../src/cli.js';
import { checklistLine } from '../src/install.js';
import { INSTALL_STEPS } from '../src/tui.js';
import { parseEnvFile } from '../src/env-file.js';
import type { EngineCall } from '../src/engine-client.js';
import type { Host } from '../src/host.js';
import type { Prompter } from '../src/prompter.js';
import { ADJUST_QUESTION, CHOOSE_EVERYTHING_HINT, SETUP_MODE_QUESTION } from '../src/quick.js';
import type { Secret } from '../src/secret.js';
import { ServicePausedError, type ServiceBackend } from '../src/services.js';
import { MAP_QUESTION } from '../src/structure.js';
import type { InstallState } from '../src/state.js';
import { fakeEngineTools, fm, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

const KEYS = {
  TEST_ANTHROPIC: 'sk-ant-test-0123456789',
  TEST_GEMINI: 'gemini-test-0123456789',
  TEST_DEEPGRAM: 'deepgram-test-0123456789',
};
/** The installer runs as install.sh starts it, with the script's path in its environment. */
const INSTALL_SCRIPT = '/opt/vault/install.sh';

function capture(isInteractive = false) {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    io: {
      stdout: (text: string) => { output.stdout += text; },
      stderr: (text: string) => { output.stderr += text; },
      isInteractive,
    },
  };
}

/**
 * Stand-ins for what the Engine stage reaches outside the data directory: the service
 * manager, Engine's token script, and Engine's tools. A real Engine runs in engine.test.ts.
 */
function fakeEngine() {
  const minted: string[] = [];
  const starts: string[] = [];
  const restarts: string[] = [];
  const backend: ServiceBackend = {
    start: async unit => { starts.push(unit); },
    restart: async unit => { restarts.push(unit); },
    // Started long ago until restarted, then after any time the installer records.
    startedAt: async () => restarts.length > 0 ? new Date('2100-01-01T00:00:00Z') : new Date(0),
    health: async () => ({ stopped: false, restarts: 0, detail: 'running' }),
    recentLogs: async () => '',
    logCommand: unit => `journalctl -u ${unit}`,
  };
  const scripts: string[] = [];
  const revoked: string[] = [];
  const run: Host['run'] = async (_command, args) => {
    const script = args.find(arg => arg.endsWith('issue-service-token.ts'));
    if (!script) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('--revoke')) {
      revoked.push(args.slice(args.indexOf(script)).join(' '));
      return { code: 0, stdout: 'Revoked 1 token for client_id=service-installer\n', stderr: '' };
    }
    scripts.push(args.slice(args.indexOf(script)).join(' '));
    const token = randomBytes(32).toString('hex');
    minted.push(token);
    return { code: 0, stdout: `Issued service token\n  Authorization: Bearer ${token}\n`, stderr: '' };
  };
  // The fixture vault as Engine indexes it: Alpha is typed by `type`, which Engine does not read.
  const tools = fakeEngineTools([{ file_path: 'Inbox.md' }, { file_path: 'Projects/Alpha.md' }]);
  const connect = (_url: string, _token: Secret) => tools.call;
  // Curator as it answers curator-status once it reads the approved settings from Engine.
  const curatorStatus = { daily_budget: { cap_usd: 1 }, server: { next_sweep_at: '2026-10-27T05:00:00.000Z', wiki_reconciliation_mode: 'live' } };
  const connectCurator = (_url: string, _token: Secret) => (async () => curatorStatus) as unknown as EngineCall;
  return { minted, scripts, revoked, starts, restarts, tools, backend, run, connect, connectCurator, curatorStatus };
}

function deps(now = '2026-10-26T12:00:00Z', prompter?: Prompter, present: string[] = [], engine = fakeEngine()): CliDeps {
  const base = realFilesystemHost();
  return {
    // The real machine may have Vault services installed; tests describe a clean one.
    host: realFilesystemHost({
      env: name => (name === 'VAULT_INSTALLER_COMMAND' ? INSTALL_SCRIPT : (KEYS as Record<string, string>)[name]),
      pathExists: async path => present.includes(path) || (!path.startsWith('/etc/systemd/') && base.pathExists(path)),
      run: engine.run,
    }),
    cwd: '/',
    repoRoot: REPO_ROOT,
    analyzerCommand: SOURCE_ANALYZER,
    createInteractivePrompter: () => {
      if (!prompter) throw new Error('this test never prompts interactively');
      return prompter;
    },
    now: () => new Date(now),
    serviceBackend: () => engine.backend,
    connectEngine: engine.connect,
    connectCurator: engine.connectCurator,
  };
}

async function fixture(extra: Record<string, unknown> = {}) {
  const vault = await makeTree({
    'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
    'Inbox.md': '# Inbox\n',
    'Attachments/scan.png': 'png',
  });
  const dataDir = join(await makeTree({}), 'vault-suite-data');
  const answers = join(await makeTree({}), 'answers.json');
  await writeFile(answers, JSON.stringify({
    version: 1,
    vault: { path: vault },
    providers: { anthropic: 'env:TEST_ANTHROPIC', gemini: 'env:TEST_GEMINI', deepgram: 'env:TEST_DEEPGRAM' },
    models: { vision_provider: 'gemini' },
    curator: { install: true },
    ...extra,
  }));
  const engine = fakeEngine();
  const install = (yes = true, now?: string, withAnswers = true) => {
    const run = capture();
    const argv = [
      'install', ...(withAnswers ? ['--answers', answers] : []), '--data-dir', dataDir, '--skip-network-check', ...(yes ? ['--yes'] : []),
    ];
    return runCli(argv, run.io, deps(now, undefined, [], engine)).then(code => ({ code, ...run.output }));
  };
  return { vault, dataDir, answers, install, engine };
}

/** Answers every question with its default, takes the notes step's map, and declines the review. */
function interactive(vault: string) {
  const asked: string[] = [];
  const outro: string[] = [];
  const prompter: Prompter = {
    interactive: true,
    intro() {},
    welcome() {},
    step() {},
    success() {},
    outro: message => { outro.push(message); },
    note() {},
    info() {},
    warn() {},
    text: async question => { asked.push(question.id); return question.id === 'vault.path' ? vault : question.defaultValue ?? ''; },
    select: async question => { asked.push(question.id); return question.initialValue; },
    confirm: async question => question.message === MAP_QUESTION.message,
    multiselect: async question => { asked.push(question.id); return question.initialValues; },
    secret: async question => { asked.push(question.id); return null; },
    decide: async question => { asked.push(question.id); return question.defaultValue(); },
    rejectAnswer(_id, reason) { throw new Error(reason); },
    spinner: () => ({ stop() {} }),
  };
  return { prompter, asked, outro };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function readState(dataDir: string): Promise<InstallState> {
  return JSON.parse(await readFile(join(dataDir, 'installer', 'state.json'), 'utf8')) as InstallState;
}

describe('vault-installer install on macOS', () => {
  it('stages launchd agents, writes env files Node reads back as written, and starts both services', async () => {
    const { dataDir, answers, engine } = await fixture();
    const run = capture();
    const base = deps(undefined, undefined, [], engine);
    const code = await runCli(
      ['install', '--answers', answers, '--data-dir', dataDir, '--skip-network-check', '--yes'],
      run.io,
      { ...base, host: { ...base.host, platform: 'darwin', arch: 'arm64' } },
    );

    expect({ code, stderr: run.output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(await readdir(join(dataDir, 'installer', 'units'))).toEqual(['vault-curator.plist', 'vault-engine.plist']);
    expect(await readFile(join(dataDir, 'installer', 'units', 'vault-engine.plist'), 'utf8'))
      .toContain(`<string>--env-file=${join(dataDir, 'engine.env')}</string>`);
    // launchd reads no env file: Node does, so each must read the same through Node's parser,
    // including curator.env's ENGINE_TOKEN, added after Engine started.
    for (const file of ['engine.env', 'curator.env']) {
      const written = Object.fromEntries(parseEnvFile(await readFile(join(dataDir, file), 'utf8')));
      const { stdout } = await promisify(execFile)(process.execPath, [
        `--env-file=${join(dataDir, file)}`,
        '-e',
        `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(written))}.map(name => [name, process.env[name]]))))`,
      ], { env: {} });
      expect(JSON.parse(stdout)).toEqual(written);
    }
    expect(Object.keys(Object.fromEntries(parseEnvFile(await readFile(join(dataDir, 'curator.env'), 'utf8'))))).toContain('ENGINE_TOKEN');
    expect(engine.starts).toEqual(['vault-engine.service', 'vault-curator.service']);
    const guide = await readFile(join(dataDir, 'PUBLIC-ACCESS.md'), 'utf8');
    expect(guide).toContain('Restart: `launchctl kickstart -k gui/$(id -u)/vault-engine && launchctl kickstart -k gui/$(id -u)/vault-curator`.');
    expect(guide).not.toContain('sudo');
  });
});

describe('vault-installer install', () => {
  it('writes the configuration, seeds extraction off, backs up the vault, and starts Engine', async () => {
    const { vault, dataDir, install, engine: services } = await fixture();

    const result = await install();

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('✓ Vault Engine is running    http://localhost:3334/mcp');
    expect(result.stdout).toContain('Backup of your notes: ');
    const engine = parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8'));
    const curator = parseEnvFile(await readFile(join(dataDir, 'curator.env'), 'utf8'));
    expect(Object.fromEntries(engine)).toEqual({
      VAULT_PATH: vault,
      DB_PATH: join(vault, '.vault-engine', 'vault.db'),
      VAULT_SETTINGS_DIR: 'Settings',
      // The notes' own type field holds their types (#445).
      VAULT_TYPE_KEY: 'type',
      OAUTH_OWNER_PASSWORD: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      OAUTH_ISSUER_URL: 'http://localhost:3334',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: KEYS.TEST_ANTHROPIC,
      GEMINI_API_KEY: KEYS.TEST_GEMINI,
      DEEPGRAM_API_KEY: KEYS.TEST_DEEPGRAM,
    });
    // Engine had the extraction keys from its first start, which EXTRACTION_ENABLED=false
    // seeded with extraction off; that line is gone once Engine started. With no approval in
    // the answers file, extraction stays off and the keys stay.
    expect(result.stdout).toContain('Attachment extraction stays off; Engine keeps its keys for its other features. To turn it on later, set Engine\'s extractionEnabled to true');
    expect(services.restarts).toEqual([]);
    expect(Object.fromEntries(curator)).toEqual({
      ENGINE_URL: 'http://127.0.0.1:3334',
      CURATOR_PORT: '3335',
      CURATOR_DB_PATH: join(dataDir, 'curator.db'),
      OAUTH_OWNER_PASSWORD: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      OAUTH_ISSUER_URL: 'http://localhost:3335',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: KEYS.TEST_ANTHROPIC,
      ENGINE_TOKEN: services.minted[1],
    });
    expect(curator.get('OAUTH_OWNER_PASSWORD')).not.toBe(engine.get('OAUTH_OWNER_PASSWORD'));
    // Engine started first, then Curator once the settings were applied. The installer's
    // Engine token was minted first, then Curator's, then read-only ones on Curator for its
    // stage and for verification.
    expect(services.starts).toEqual(['vault-engine.service', 'vault-curator.service']);
    expect(services.minted).toHaveLength(4);
    expect(services.scripts[2]).toMatch(/packages\/curator\/scripts\/issue-service-token\.ts --name installer --ttl-days 1 --scope curate:read$/);
    expect(result.stdout).toContain('✓ Vault Curator is running   http://localhost:3335/mcp');
    expect(result.stdout).toContain('✓ Models: 6 model settings resolve to enabled, priced models with keys; off: engine.visionModel');
    expect(result.stdout).not.toMatch(/^✗ /m);
    // The handoff revoked the installer's tokens on both services and removed the saved one.
    expect(services.revoked.map(command => command.split(' ')[0]?.split('/packages/')[1])).toEqual([
      'engine/scripts/issue-service-token.ts',
      'curator/scripts/issue-service-token.ts',
    ]);
    expect(services.revoked.every(command => command.endsWith('--name installer --revoke'))).toBe(true);
    await expect(readFile(join(dataDir, 'installer', 'installer.env'), 'utf8')).rejects.toThrow(/ENOENT/);
    const guide = await readFile(join(dataDir, 'PUBLIC-ACCESS.md'), 'utf8');
    expect(guide).toContain('service: http://127.0.0.1:3334');
    expect(guide).toContain('service: http://127.0.0.1:3335');
    expect(result.stdout).toContain(`follow ${join(dataDir, 'PUBLIC-ACCESS.md')}. Nothing was exposed.`);
    // The command to run later is install.sh's, with this install's data directory.
    expect(result.stdout).toContain(`\`${INSTALL_SCRIPT} status --data-dir ${dataDir}\` checks the installation at any time.`);
    expect(result.stdout).toContain(`Run \`${INSTALL_SCRIPT} status --data-dir ${dataDir}\` any time to check on it.`);

    expect(await mode(dataDir)).toBe(0o700);
    expect(await mode(join(dataDir, 'installer'))).toBe(0o700);
    for (const file of ['engine.env', 'curator.env', 'installer/state.json']) {
      expect(await mode(join(dataDir, file))).toBe(0o600);
    }
    expect(await readdir(join(dataDir, 'installer', 'units'))).toEqual(['vault-curator.service', 'vault-engine.service']);
    expect(await readFile(join(dataDir, 'installer', 'units', 'vault-engine.service'), 'utf8'))
      .toContain(`EnvironmentFile=${join(dataDir, 'engine.env')}\n`);

    // Adoption created the vault's type (and no note type), typed Alpha over MCP, and kept
    // every undo operation: one field, one type, and one batch of notes.
    expect([...services.tools.schemas.keys()]).toEqual(['project']);
    expect(services.tools.notes.map(note => [note.file_path, note.types])).toEqual([['Inbox.md', []], ['Projects/Alpha.md', ['project']]]);
    const state = await readState(dataDir);
    expect(state.stages.adopt).toEqual({
      started_at: '2026-10-26T12:00:00.000Z',
      completed_at: '2026-10-26T12:00:00.000Z',
      operations: ['op1', 'op2', 'op3'],
      targets: { fields: [{ name: 'status', field_type: 'string' }], types: { 'Inbox.md': [], 'Projects/Alpha.md': ['project'] } },
    });
    expect(Object.keys(state.stages.configure?.files ?? {}).sort()).toEqual([
      join(dataDir, 'curator.env'),
      join(dataDir, 'engine.env'),
      join(dataDir, 'installer', 'units', 'vault-curator.service'),
      join(dataDir, 'installer', 'units', 'vault-engine.service'),
    ]);
    expect(state.stages.backup).toMatchObject({
      directory: join(dataDir, 'installer', 'backups', '20261026T120000Z'),
      completed_at: '2026-10-26T12:00:00.000Z',
      files: 2,
    });
    const manifest = JSON.parse(await readFile(join(dataDir, 'installer', 'backups', '20261026T120000Z', 'manifest.json'), 'utf8'));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(['Inbox.md', 'Projects/Alpha.md']);

    // Settings went through Engine, the curator domain too, before Curator's first start.
    // The vocabulary map went through the vault domain's own keys, a none as null.
    expect(services.tools.settings.get('vault')).toMatchObject({
      projectType: 'project', taskType: null, journalType: 'note', projectStatusField: 'status', projectActiveStatuses: ['open'],
      taskStatusField: null, taskActiveStatuses: [], wikiDir: 'Wikis', topicDir: 'Topics',
    });
    expect(services.tools.settings.has('wiki')).toBe(false);
    expect(services.tools.settings.get('curator')).toMatchObject({ dailyBudgetCents: 100, wikiReconciliationMode: 'live', memorySweepEnabled: false });
    // The planned vision provider is set while extraction is off, so turning it on later
    // needs only extractionEnabled. Memory consolidation runs on the Anthropic key.
    expect(services.tools.settings.get('engine')).toEqual({ visionProvider: 'gemini', memoryConsolidationModel: '[[Claude Sonnet 4.6]]' });
    expect(state.stages.settings).toEqual({
      started_at: '2026-10-26T12:00:00.000Z',
      completed_at: '2026-10-26T12:00:00.000Z',
      extraction: 'declined',
      engine_restarted: false,
    });

    // Nothing in the vault changed, and no secret was printed or saved outside the env files.
    expect(await readdir(vault, { recursive: true })).not.toContain('.vault-engine');
    const secrets = [...Object.values(KEYS), engine.get('OAUTH_OWNER_PASSWORD'), curator.get('OAUTH_OWNER_PASSWORD'), ...services.minted] as string[];
    const stateText = await readFile(join(dataDir, 'installer', 'state.json'), 'utf8');
    for (const secret of secrets) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(stateText).not.toContain(secret);
    }
  });

  it('starts Engine with its keys and extraction seeded off, and keeps a synced vault\'s database and models out of the sync', async () => {
    const synced = join(await makeTree({ 'Dropbox/Vault/Inbox.md': '# Inbox\n' }), 'Dropbox', 'Vault');
    const { dataDir, install, engine: services } = await fixture({ vault: { path: synced }, curator: { install: false } });
    let firstStart: Map<string, string> | null = null;
    services.backend.start = async unit => {
      services.starts.push(unit);
      firstStart ??= parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8'));
    };

    const result = await install();

    expect(result.code).toBe(EXIT_OK);
    expect(Object.fromEntries(firstStart ?? [])).toMatchObject({
      DB_PATH: join(dataDir, 'vault.db'),
      EMBEDDER_MODELS_DIR: join(dataDir, 'models'),
      EXTRACTION_ENABLED: 'false',
      GEMINI_API_KEY: KEYS.TEST_GEMINI,
      DEEPGRAM_API_KEY: KEYS.TEST_DEEPGRAM,
    });
    // Engine read the seed on its first start; later starts would only warn about it.
    const engine = parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8'));
    expect(engine.has('EXTRACTION_ENABLED')).toBe(false);
    expect(engine.get('EMBEDDER_MODELS_DIR')).toBe(join(dataDir, 'models'));
  });

  it('names the command that continues the install when root commands are left to the user', async () => {
    const { dataDir, install, engine: services } = await fixture();
    services.backend.start = async unit => { throw new ServicePausedError(`Run the commands above to install and start ${unit}.`); };

    const result = await install();

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stdout).toContain(`Run the commands above to install and start vault-engine.service. Then run \`${INSTALL_SCRIPT} install --data-dir ${dataDir}\` again.`);
  });

  it('changes nothing headlessly without --yes', async () => {
    const { dataDir, install } = await fixture();

    const result = await install(false);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Nothing was changed. Run again with --yes');
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('turns attachment extraction on after adoption when the answers file approves it', async () => {
    const { dataDir, install, engine: services } = await fixture({ extraction: { approve: true } });

    const result = await install();

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Attachment extraction turns on after adoption, as the answers file approves');
    expect(result.stdout).toContain('Images: 1 file, read by Gemini');
    const engine = parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8'));
    expect(engine.get('GEMINI_API_KEY')).toBe(KEYS.TEST_GEMINI);
    expect(engine.get('DEEPGRAM_API_KEY')).toBe(KEYS.TEST_DEEPGRAM);
    await expect(readFile(join(dataDir, 'installer', 'pending-keys.env'), 'utf8')).rejects.toThrow(/ENOENT/);
    expect(services.tools.settings.get('engine')).toMatchObject({ visionProvider: 'gemini', extractionEnabled: true });
    expect(services.restarts).toEqual(['vault-engine.service']);
    const state = await readState(dataDir);
    expect(state.stages.settings).toMatchObject({ extraction: 'approved', engine_restarted: true });
    // configure's record follows engine.env, so a later drift check compares its current content.
    expect(state.stages.configure?.files[join(dataDir, 'engine.env')]).toBe(createHash('sha256').update(await readFile(join(dataDir, 'engine.env'))).digest('hex'));
  });

  it('reports the installation\'s health with status, and says when there is none', async () => {
    const { dataDir, install, engine: services } = await fixture();
    await install();
    const run = capture();
    const missing = capture();

    const revokedByInstall = services.revoked.length;
    const meetings = { 'Attendees': 1, 'Date': 1 };
    services.tools.survey.result = {
      scope: { notes: 24, surveyed: 24, not_indexed: 0, truncated: false },
      groups: [
        { group: 1, notes: 14, samples: [{ title: 'Northwind sync' }], shared: { folders: [], title_patterns: [], headings: [], fields: [], label_lines: Object.entries(meetings).map(([name, share]) => ({ name, share })) } },
        { group: 2, notes: 10, samples: [{ title: 'Loose thought' }], shared: { folders: [], title_patterns: [], headings: [], fields: [], label_lines: [] } },
      ],
      ungrouped: { notes: 0 },
    };
    const code = await runCli(['status', '--data-dir', dataDir], run.io, deps('2026-10-27T08:00:00Z', undefined, [], services));
    const none = await runCli(['status', '--data-dir', join(dataDir, 'elsewhere')], missing.io, deps());

    expect(code).toBe(EXIT_OK);
    // status minted its own tokens, then revoked them, as the finished install did.
    expect(services.revoked.length).toBe(revokedByInstall + 2);
    await expect(readFile(join(dataDir, 'installer', 'installer.env'), 'utf8')).rejects.toThrow(/ENOENT/);
    expect(run.output.stdout).toContain('✓ Engine: answers authenticated calls at http://localhost:3334/mcp');
    expect(run.output.stdout).toContain('✓ Curator: next sweep');
    // After the checks, what the notes with no kind have in common (#650), from Engine's survey.
    expect(run.output.stdout).toContain([
      '',
      '24 notes have no kind. Grouped by how alike they are (no AI model), they share:',
      '  14 notes: "Attendees:" and "Date:" lines, e.g. "Northwind sync"',
      '  10 notes with nothing that sets them apart',
      'To sort them, ask Claude Code: "What is still unorganized in my vault?"',
    ].join('\n'));
    expect(none).toBe(EXIT_BLOCKED);
    expect(missing.output.stderr).toContain(`no installation in ${join(dataDir, 'elsewhere')}`);
  });

  it('continues from the saved state without planning again', async () => {
    const { dataDir, install } = await fixture();
    await install();
    const engineEnv = await readFile(join(dataDir, 'engine.env'), 'utf8');

    const again = await install(true, '2026-10-27T08:00:00Z');

    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).toContain('picking up where you left off');
    expect(again.stdout).toContain('Progress: ████████████████████████ 8/8');
    expect(again.stdout).not.toContain('This computer');
    expect(await readFile(join(dataDir, 'engine.env'), 'utf8')).toBe(engineEnv);
    expect(await readdir(join(dataDir, 'installer', 'backups'))).toEqual(['20261026T120000Z']);
  });

  it('continues headlessly without the answers file it was planned with', async () => {
    const { dataDir, answers, install } = await fixture();
    await install();
    const state = await readState(dataDir);
    delete state.stages.backup;
    delete state.stages.engine;
    delete state.stages.adopt;
    delete state.stages.settings;
    delete state.stages.curator;
    delete state.stages.verify;
    delete state.stages.handoff;
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));
    await rm(answers);

    const withoutFlag = await install(true, '2026-10-27T08:00:00Z', false);
    const freshDataDir = join(await makeTree({}), 'data');
    const nothingToContinue = capture();
    const usage = await runCli(['install', '--data-dir', freshDataDir, '--yes'], nothingToContinue.io, deps());

    expect(withoutFlag.code).toBe(EXIT_OK);
    expect(withoutFlag.stdout).toContain('✓ Vault Engine is running    http://localhost:3334/mcp');
    expect((await readState(dataDir)).stages.backup?.completed_at).toBe('2026-10-27T08:00:00.000Z');
    // The removed answers file is not needed either.
    expect((await install(true, '2026-10-28T08:00:00Z')).code).toBe(EXIT_OK);
    expect(usage).toBe(EXIT_USAGE);
    expect(nothingToContinue.output.stderr).toContain('pass --answers');
  });

  it('completes a configuration that was fully written before the run stopped', async () => {
    const { dataDir, install } = await fixture();
    await install();
    const engineEnv = await readFile(join(dataDir, 'engine.env'), 'utf8');
    const state = await readState(dataDir);
    state.stages.configure = { ...state.stages.configure!, completed_at: null };
    delete state.stages.backup;
    delete state.stages.engine;
    delete state.stages.adopt;
    delete state.stages.settings;
    delete state.stages.curator;
    delete state.stages.verify;
    delete state.stages.handoff;
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));

    const again = await install(true, '2026-10-27T08:00:00Z', false);

    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).toContain('✓ Save the configuration\n- Back up your notes');
    expect((await readState(dataDir)).stages.configure?.completed_at).toBe('2026-10-27T08:00:00.000Z');
    expect(await readFile(join(dataDir, 'engine.env'), 'utf8')).toBe(engineEnv);
  });

  it('removes a configuration that stopped partway and plans again', async () => {
    const { dataDir, install } = await fixture();
    await install();
    const oldPassword = parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8')).get('OAUTH_OWNER_PASSWORD');
    const state = await readState(dataDir);
    state.stages.configure = { ...state.stages.configure!, completed_at: null };
    delete state.stages.backup;
    delete state.stages.engine;
    delete state.stages.adopt;
    delete state.stages.settings;
    delete state.stages.curator;
    delete state.stages.verify;
    delete state.stages.handoff;
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));
    await rm(join(dataDir, 'curator.env'));
    await rm(join(dataDir, 'installer', 'backups'), { recursive: true });

    const again = await install(true, '2026-10-27T08:00:00Z');

    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).toContain('The last run stopped while writing the configuration. What it wrote was removed; planning again.');
    expect(again.stdout).toContain('This computer');
    const engine = parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8'));
    expect(engine.get('OAUTH_OWNER_PASSWORD')).not.toBe(oldPassword);
    expect((await readState(dataDir)).stages.configure?.completed_at).toBe('2026-10-27T08:00:00.000Z');
  });

  it('refuses to continue when a file it was writing has changed', async () => {
    const { dataDir, install } = await fixture();
    await install();
    const state = await readState(dataDir);
    state.stages.configure = { ...state.stages.configure!, completed_at: null };
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));
    await writeFile(join(dataDir, 'engine.env'), 'EDITED=1\n');

    const again = await install(true, '2026-10-27T08:00:00Z');

    expect(again.code).toBe(EXIT_BLOCKED);
    expect(again.stderr).toContain(`${join(dataDir, 'engine.env')} changed after the installer began writing it`);
    expect(await readFile(join(dataDir, 'engine.env'), 'utf8')).toBe('EDITED=1\n');
  });

  it('replaces a backup that stopped partway', async () => {
    const { dataDir, install } = await fixture();
    await install();
    const state = await readState(dataDir);
    const partial = join(dataDir, 'installer', 'backups', '20261026T120000Z');
    state.stages.backup = { ...state.stages.backup!, completed_at: null };
    delete state.stages.engine;
    delete state.stages.adopt;
    delete state.stages.settings;
    delete state.stages.curator;
    delete state.stages.verify;
    delete state.stages.handoff;
    await writeFile(join(dataDir, 'installer', 'state.json'), JSON.stringify(state));
    await writeFile(join(partial, 'manifest.json'), 'partial');

    const declined = await install(false, '2026-10-27T08:00:00Z');
    const again = await install(true, '2026-10-27T08:00:00Z');

    expect(declined.stdout).toContain('✓ Save the configuration\n- Back up your notes');
    expect(declined.stdout).toContain('Nothing was changed. Run again with --yes to continue.');
    expect(again.code).toBe(EXIT_OK);
    expect(await readdir(join(dataDir, 'installer', 'backups'))).toEqual(['20261027T080000Z']);
    expect((await readState(dataDir)).stages.backup?.completed_at).toBe('2026-10-27T08:00:00.000Z');
  });

  it('records a skipped backup without copying anything', async () => {
    const { dataDir, install } = await fixture({ backup: { mode: 'skip' } });

    const result = await install();

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('No backup was taken, as you chose.');
    expect((await readState(dataDir)).stages.backup).toMatchObject({ directory: null, files: 0 });
    await expect(stat(join(dataDir, 'installer', 'backups'))).rejects.toThrow();
  });

  it('never overwrites an existing env file, and removes what it wrote before stopping', async () => {
    const { dataDir, install } = await fixture();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'curator.env'), 'ENGINE_TOKEN=keep-me\n');

    const result = await install();

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stderr).toContain(`${join(dataDir, 'curator.env')} already exists`);
    expect(await readFile(join(dataDir, 'curator.env'), 'utf8')).toBe('ENGINE_TOKEN=keep-me\n');
    expect((await readdir(dataDir, { recursive: true })).sort()).toEqual(['curator.env', 'installer', 'installer/units']);
  });

  it('refuses a folder Vault Engine already manages', async () => {
    const { vault, dataDir, install } = await fixture();
    await mkdir(join(vault, '.vault-engine'));

    const result = await install();

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.stdout).toContain('Vault Engine has used this folder before.');
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('changes nothing when the review is declined interactively', async () => {
    const { vault, dataDir } = await fixture();
    const { prompter } = interactive(vault);
    const run = capture(true);

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check'], run.io, deps(undefined, prompter));

    expect(code).toBe(EXIT_OK);
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('asks for the details, then for approval, both defaulting to no', async () => {
    const { vault, dataDir } = await fixture();
    const { prompter } = interactive(vault);
    const confirms: Array<{ message: string; initialValue: boolean }> = [];
    const titles: Array<string | undefined> = [];
    let summary = '';
    prompter.confirm = async question => {
      confirms.push({ message: question.message, initialValue: question.initialValue });
      // Choose everything (#434), take the notes step's map as found (#435), and show the details.
      return question.message === 'Show every file and command?' || question.message === MAP_QUESTION.message;
    };
    prompter.note = (message, title) => {
      titles.push(title);
      if (title === 'The plan in short') summary = message;
    };

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check', '--no-sudo'], capture(true).io, deps(undefined, prompter));

    expect(code).toBe(EXIT_OK);
    expect(confirms.map(question => question.message)).toEqual([
      SETUP_MODE_QUESTION.message, MAP_QUESTION.message,
      // No key is ticked, so the key tick-list (#436) offers to go back.
      'Go back to the list and tick one?',
      'Show every file and command?', 'Ready? Install Vault with this plan?',
    ]);
    expect(confirms.slice(-2)).toEqual([
      { message: 'Show every file and command?', initialValue: false },
      { message: 'Ready? Install Vault with this plan?', initialValue: false },
    ]);
    // The summary first, then today's detail boxes, then the approval question.
    expect(titles.slice(titles.indexOf('The plan in short'))).toEqual([
      'The plan in short',
      '1 · Your notes folder',
      '2 · Kinds of notes',
      '3 · AI services',
      '4 · Curator',
      '5 · AI models',
      '6 · The details: every file, service, and command',
    ]);
    // --no-sudo reaches the summary: the root commands are the user's to run.
    expect(summary).toContain('you run 3 root commands yourself (--no-sudo)');
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('stops at a failed check before asking anything', async () => {
    const { vault, dataDir } = await fixture();
    const { prompter, asked, outro } = interactive(vault);

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check'], capture(true).io,
      deps(undefined, prompter, [join(REPO_ROOT, 'packages', 'engine', '.env')]));

    expect(code).toBe(EXIT_BLOCKED);
    expect(asked).toEqual([]);
    expect(outro).toEqual(['Some checks failed; fix them and run the installer again. Nothing was changed.']);
    await expect(stat(dataDir)).rejects.toThrow();
  });
});

/**
 * Quick setup, interactively: the folder, Anthropic's key from `TEST_ANTHROPIC`, and each
 * confirmation's answers by message, in order (any other confirmation says no). Records
 * what was asked, every confirmation, and the review's notes.
 */
function quickInteractive(vault: string, confirms: Record<string, boolean[]>, selects: Partial<Record<string, string[]>> = {}) {
  const asked: string[] = [];
  const confirmed: string[] = [];
  const notes: Array<{ title?: string; message: string }> = [];
  const outro: string[] = [];
  const infos: string[] = [];
  const prompter: Prompter = {
    interactive: true,
    intro() {},
    welcome() {},
    step() {},
    success() {},
    outro: message => { outro.push(message); },
    note: (message, title) => { notes.push({ message, ...(title !== undefined ? { title } : {}) }); },
    info: message => { infos.push(message.replace(/\n/g, ' ')); },
    warn() {},
    text: async question => { asked.push(question.id); return question.id === 'vault.path' ? vault : question.defaultValue ?? ''; },
    select: async question => {
      asked.push(question.id);
      return (selects[question.id]?.shift() ?? question.initialValue) as typeof question.initialValue;
    },
    confirm: async question => { confirmed.push(question.message); return confirms[question.message]?.shift() ?? false; },
    multiselect: async question => { asked.push(question.id); return question.initialValues; },
    secret: async question => { asked.push(question.id); return question.id === 'providers.anthropic' ? { source: 'env', name: 'TEST_ANTHROPIC' } : null; },
    decide: question => question.ask(),
    rejectAnswer(_id, reason) { throw new Error(reason); },
    spinner: () => ({ stop() {} }),
  };
  return { prompter, asked, confirmed, notes, outro, infos };
}

const APPROVE = 'Ready? Install Vault with this plan?';
const EXTRACT = 'Start reading your attachments now? This uses paid AI calls.';
/** The short review's question (#437), asked before each approval. */
const DETAILS = 'Show every file and command?';

describe('vault-installer install, quick setup', () => {
  it('installs after asking for the folder, one key, and approval', async () => {
    const { vault, dataDir } = await fixture();
    const quick = quickInteractive(vault, { [SETUP_MODE_QUESTION.message]: [true], [APPROVE]: [true] });

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check'], capture(true).io, deps(undefined, quick.prompter));

    expect(code).toBe(EXIT_OK);
    // Six answers: the setup choice, the folder, the service, its key, the short review's
    // details question (#437), and the approval. Attachment extraction is asked after
    // adoption, as in the full flow.
    expect(quick.asked).toEqual(['vault.path', 'providers', 'providers.anthropic']);
    expect(quick.confirmed).toEqual([SETUP_MODE_QUESTION.message, DETAILS, APPROVE, EXTRACT]);
    const state = await readState(dataDir);
    expect(state.stages.handoff?.completed_at).toBeTruthy();
    expect(state.plan.structure?.roles).toEqual({ project: 'project', task: null, meeting: null, person: null, company: null });
    expect(state.plan.curator).toMatchObject({ daily_budget_cents: 100, sweep_at: '05:00', wiki_mode: 'live' });
    expect(state.plan.models.preset).toBe('balanced');
    expect(state.plan.backup?.mode).toBe('markdown');
    expect(quick.infos[0]).toBe('To change how your notes are sorted, answer No when asked to install; you can then adjust it.');
  });

  it('adjusts the kinds of notes from the review, then installs the adjusted plan', async () => {
    const { vault, dataDir } = await fixture();
    const quick = quickInteractive(vault, {
      [SETUP_MODE_QUESTION.message]: [true],
      [APPROVE]: [false, true],
      [ADJUST_QUESTION.message]: [true],
      'Keep these?': [false, true], // the kinds: Change; the other lines: Keep
      [MAP_QUESTION.message]: [true],
      // Every file and command, so both reviews show their "Kinds of notes" box (#437).
      [DETAILS]: [true, true],
    }, { 'structure.roles': ['\u0000none', '\u0000none', '\u0000none', '\u0000none', '\u0000none'] });

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check'], capture(true).io, deps(undefined, quick.prompter));

    expect(code).toBe(EXIT_OK);
    expect(quick.confirmed).toEqual([
      SETUP_MODE_QUESTION.message, DETAILS, APPROVE, ADJUST_QUESTION.message,
      // The notes step's questions under Adjust (no question about the old type field: it is
      // the type key, #445).
      'Keep these?', 'Keep these?', MAP_QUESTION.message,
      DETAILS, APPROVE, EXTRACT,
    ]);
    // The review was shown again, with projects now none, and that plan was installed.
    const reviews = quick.notes.filter(note => note.title === '2 · Kinds of notes').map(note => note.message);
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).not.toEqual(reviews[0]);
    const state = await readState(dataDir);
    expect(state.plan.structure?.roles.project).toBeNull();
    expect(state.plan.vault_map?.kinds.project).toEqual({ type: null, from: null });
  });

  it('stops without changing anything when the user neither installs nor adjusts, saying how to choose everything', async () => {
    const { vault, dataDir } = await fixture();
    const quick = quickInteractive(vault, { [SETUP_MODE_QUESTION.message]: [true] });

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check'], capture(true).io, deps(undefined, quick.prompter));

    expect(code).toBe(EXIT_OK);
    expect(quick.confirmed).toEqual([SETUP_MODE_QUESTION.message, DETAILS, APPROVE, ADJUST_QUESTION.message]);
    expect(quick.infos.at(-1)).toBe(CHOOSE_EVERYTHING_HINT.replace(/\n/g, ' '));
    expect(quick.outro).toEqual(['Nothing was changed.']);
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('stops at a failed check before asking for the folder', async () => {
    const { vault, dataDir } = await fixture();
    const quick = quickInteractive(vault, { [SETUP_MODE_QUESTION.message]: [true] });

    const code = await runCli(['install', '--data-dir', dataDir, '--skip-network-check'], capture(true).io,
      deps(undefined, quick.prompter, [join(REPO_ROOT, 'packages', 'engine', '.env')]));

    expect(code).toBe(EXIT_BLOCKED);
    expect(quick.asked).toEqual([]);
    expect(quick.outro).toEqual(['Some checks failed; fix them and run the installer again. Nothing was changed.']);
  });
});

describe('resume checklist', () => {
  const curatorStep = INSTALL_STEPS.find(step => step.id === 'curator')!;
  const stages = { settings: { completed_at: '2026-10-26T12:00:00Z' } } as unknown as InstallState['stages'];

  it('shows Curator as skipped, not done, when the plan leaves it out', () => {
    const state = { plan: { curator: null } as unknown as InstallState['plan'], stages };
    expect(checklistLine(state, curatorStep)).toBe('- Start Curator (skipped: not installed, as you chose)');
  });

  it('marks a planned Curator done only once its stage completes', () => {
    const plan = { curator: {} } as unknown as InstallState['plan'];
    expect(checklistLine({ plan, stages }, curatorStep)).toBe('- Start Curator');
    const done = { ...stages, curator: { completed_at: '2026-10-26T12:00:00Z' } } as unknown as InstallState['stages'];
    expect(checklistLine({ plan, stages: done }, curatorStep)).toBe('✓ Start Curator');
  });
});
