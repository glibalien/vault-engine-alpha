import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_OK, runCli, type CliDeps } from '../src/cli.js';
import { curatorClient, EngineAuthError, engineClient, type EngineCall } from '../src/engine-client.js';
import { parseEnvFile } from '../src/env-file.js';
import { createSystemHost } from '../src/host.js';
import type { Prompter } from '../src/prompter.js';
import { SETUP_MODE_QUESTION } from '../src/quick.js';
import { Secret } from '../src/secret.js';
import { createProcessBackend } from '../src/services.js';
import { loadState } from '../src/state.js';
import { CURATOR_UNIT } from '../src/units.js';
import { fm, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

const stops: Array<() => Promise<void>> = [];
// Stopping Engine can take a while on a busy machine.
afterEach(async () => {
  await Promise.all(stops.splice(0).map(stop => stop()));
  await removeTrees();
}, 60_000);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/**
 * The whole install through adoption against a real Engine, run from source as a child
 * process: its first start, Engine's token script, and MCP over HTTP. The search model is
 * never downloaded. With `interactive`, the run asks that prompter instead of reading the
 * answers file.
 */
async function installWithEngine(files: Record<string, string>, answers: Record<string, unknown>, interactive?: (vault: string) => Prompter) {
  const vault = await makeTree(files);
  const dataDir = join(await makeTree({}), 'data');
  const home = await makeTree({});
  const answersPath = join(await makeTree({}), 'answers.json');
  const [enginePort, curatorPort] = [await freePort(), await freePort()];
  await writeFile(answersPath, JSON.stringify({ version: 1, ...answers, vault: { path: vault, ...(answers.vault as object) } }));
  const system = createSystemHost();
  const backend = createProcessBackend({
    command: unit => unit === CURATOR_UNIT
      ? { executable: process.execPath, args: ['--import', 'tsx', join(REPO_ROOT, 'packages', 'curator', 'src', 'server.ts')], cwd: REPO_ROOT }
      : {
          executable: process.execPath,
          args: ['--import', 'tsx', join(REPO_ROOT, 'packages', 'engine', 'src', 'index.ts'), '--transport', 'http', '--port', String(enginePort)],
          cwd: REPO_ROOT,
        },
    env: async unit => ({
      ...Object.fromEntries(parseEnvFile(await readFile(join(dataDir, unit === CURATOR_UNIT ? 'curator.env' : 'engine.env'), 'utf8'))),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      VAULT_ENGINE_MODELS_OFFLINE: '1',
    }),
  });
  stops.push(() => backend.stopAll());
  const output = { stdout: '', stderr: '' };

  const deps: CliDeps = {
    host: realFilesystemHost({
      execPath: process.execPath,
      env: name => ({ TEST_ANTHROPIC: 'sk-ant-e2e-placeholder', TEST_GEMINI: 'gemini-e2e-placeholder', PATH: process.env.PATH } as Record<string, string | undefined>)[name],
      // The services run as child processes; preflight sees a Linux host with systemd and
      // sudo on any machine, and everything else is real.
      run: async (command, args, options) => (command === 'systemctl' || command === 'sudo'
        ? { code: 0, stdout: '', stderr: '' }
        : system.run(command, args, options)),
      httpStatus: system.httpStatus,
      pathExists: async path => path === '/run/systemd/system' || (!path.startsWith('/etc/systemd/') && system.pathExists(path)),
    }),
    cwd: '/',
    repoRoot: REPO_ROOT,
    analyzerCommand: SOURCE_ANALYZER,
    createInteractivePrompter: () => {
      if (!interactive) throw new Error('headless');
      return interactive(vault);
    },
    now: () => new Date(),
    serviceBackend: () => backend,
  };
  const code = await runCli(
    ['install', ...(interactive ? [] : ['--answers', answersPath]), '--data-dir', dataDir, '--engine-port', String(enginePort),
      '--curator-port', String(curatorPort), '--skip-network-check', ...(interactive ? [] : ['--yes'])],
    { stdout: text => { output.stdout += text; }, stderr: text => { output.stderr += text; }, isInteractive: interactive !== undefined },
    deps,
  );
  /** Runs another installer command, headless, against the same machine and services. */
  const cli = async (argv: string[]) => {
    const result = { stdout: '', stderr: '' };
    const exit = await runCli(argv, { stdout: text => { result.stdout += text; }, stderr: text => { result.stderr += text; }, isInteractive: false }, deps);
    return { code: exit, ...result };
  };

  const url = `http://localhost:${enginePort}/mcp`;
  // The handoff revoked the installer's own token, so tests mint one with Engine's script.
  const engineScript = async (args: string[]) => {
    const env = parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8'));
    return system.run(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'packages', 'engine', 'scripts', 'issue-service-token.ts'), ...args], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', VAULT_PATH: env.get('VAULT_PATH') as string, DB_PATH: env.get('DB_PATH') as string },
      timeoutMs: 60_000,
    });
  };
  const installerToken = async () => /Bearer ([0-9a-f]{64})/.exec((await engineScript(['--name', 'e2e', '--ttl-days', '1'])).stdout)?.[1] as string;
  return { code, output, vault, dataDir, url, enginePort, installerToken, engineScript, cli };
}

/**
 * What Claude Code does after `claude mcp login`: register itself, open the service's
 * sign-in page, send the owner password as that page's form does, and trade the code for
 * a token, here with the MCP SDK's own OAuth client. Returns how many tools it then sees.
 */
async function signInWithOAuth(url: string, password: string): Promise<number> {
  const redirect = 'http://localhost:1/callback';
  let information: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = '';
  let code: string | null = null;
  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    clientMetadata: { client_name: 'e2e', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    clientInformation: () => information,
    saveClientInformation: value => { information = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    async redirectToAuthorization(authorization) {
      const form = new URLSearchParams(Object.fromEntries(authorization.searchParams));
      form.set('password', password);
      const response = await fetch(new URL('/authorize', authorization), { method: 'POST', body: form, redirect: 'manual' });
      code = new URL(response.headers.get('location') ?? '', authorization).searchParams.get('code');
    },
  };
  expect(await auth(provider, { serverUrl: url })).toBe('REDIRECT');
  expect(await auth(provider, { serverUrl: url, authorizationCode: code ?? '' })).toBe('AUTHORIZED');
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

/** How many tools a service-token client sees: every tool, the suite's own plumbing too. */
async function bearerToolCount(url: string, token: string): Promise<number> {
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

/** Every note's types, by path, as Engine reports them. */
async function typesByPath(call: EngineCall): Promise<Record<string, string[]>> {
  const { nodes } = await call<{ nodes: Array<{ file_path: string; types: string[] }> }>('query-nodes', { select: ['file_path', 'types'], limit: 200 });
  return Object.fromEntries(nodes.map(node => [node.file_path, node.types]).sort());
}

describe('install with a running Engine', () => {
  it('starts Engine, mints working tokens, applies the first-start exclusions, and adopts the notes', async () => {
    const { code, output, vault, dataDir, url, enginePort, installerToken, engineScript } = await installWithEngine({
      'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
      'Inbox.md': '# Inbox\n',
      'Templates/Project.md': fm({ type: 'project' }),
      '.obsidian/app.json': '{}\n',
    }, {
      vault: { exclude: ['Templates'] },
      providers: { anthropic: 'env:TEST_ANTHROPIC', gemini: 'env:TEST_GEMINI' },
      curator: { install: true },
      obsidian: { install_plugin: true },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(output.stdout).toContain(`✓ Vault Engine is running    http://localhost:${enginePort}/mcp`);
    expect(output.stdout).toContain('✓ Your notes are organized and your settings are saved');
    expect(output.stdout).toContain('The installation is complete and verified.');
    expect(output.stdout).toMatch(/Indexed \d+ notes/);

    // The handoff wrote the guide and left no installer token: none is saved, and every
    // one Engine issued to the installer is already revoked.
    await expect(readFile(join(dataDir, 'installer', 'installer.env'), 'utf8')).rejects.toThrow(/ENOENT/);
    expect((await engineScript(['--name', 'installer', '--revoke'])).stdout).toContain('Revoked 0 tokens for client_id=service-installer');
    expect(await readFile(join(dataDir, 'PUBLIC-ACCESS.md'), 'utf8')).toContain(`service: http://127.0.0.1:${enginePort}`);

    const installer = await installerToken();
    const curator = parseEnvFile(await readFile(join(dataDir, 'curator.env'), 'utf8')).get('ENGINE_TOKEN') as string;
    expect(installer).toMatch(/^[0-9a-f]{64}$/);
    expect(curator).toMatch(/^[0-9a-f]{64}$/);
    const call = engineClient(url, new Secret(installer));
    const stats = await engineClient(url, new Secret(curator))<{
      node_count: number;
      extractors: { disabled: Array<{ id: string }> };
    }>('vault-stats');
    const { domains } = await call<{
      domains: { engine: { effective: { excludeDirs: string[]; visionProvider: string; extractionEnabled: boolean } } };
    }>('get-settings', { domain: 'engine' });
    const settings = domains.engine;
    await expect(engineClient(url, new Secret('0'.repeat(64)))('vault-stats')).rejects.toThrow(EngineAuthError);

    // Engine seeded its exclusions and extraction off on the first start, so the template
    // stays out and its Gemini key reads nothing, and the seed-only variables have left
    // engine.env.
    expect(settings.effective.excludeDirs).toEqual(['Templates']);
    expect(settings.effective.visionProvider).toBe('gemini');
    expect(settings.effective.extractionEnabled).toBe(false);
    expect(stats.extractors.disabled.map(entry => entry.id)).toContain('gemini-vision-image');
    const engineEnv = await readFile(join(dataDir, 'engine.env'), 'utf8');
    expect(engineEnv).not.toContain('VAULT_EXCLUDE_DIRS');
    expect(engineEnv).not.toContain('EXTRACTION_ENABLED');
    expect(engineEnv).toContain('GEMINI_API_KEY=');
    expect(stats.node_count).toBeGreaterThanOrEqual(2);

    // Adoption: the vault's project type exists, Alpha has its type in Engine and in its
    // file, under its own key, which is Engine's type key (#445), and Inbox stays untyped.
    // The installer planned no note type: Curator creates its journal kind when it first writes.
    const schemas = (await call<Array<{ name: string; default_directory: string | null; has_schema: boolean }>>('list-schemas'))
      .filter(schema => schema.has_schema);
    expect(schemas.map(schema => [schema.name, schema.default_directory])).toContainEqual(['project', 'Projects']);
    const types = await typesByPath(call);
    expect(types['Projects/Alpha.md']).toEqual(['project']);
    expect(types['Inbox.md']).toEqual([]);
    expect(types).not.toHaveProperty('Templates/Project.md');
    const alpha = await readFile(join(vault, 'Projects', 'Alpha.md'), 'utf8');
    expect(alpha).toMatch(/^type:( project|\n {2}- project)$/m);
    expect(alpha).not.toMatch(/^types:/m);
    expect(parseEnvFile(engineEnv).get('VAULT_TYPE_KEY')).toBe('type');
    const { typeKey } = await call<{ typeKey: string }>('get-settings', { domain: 'vault' });
    expect(typeKey).toBe('type');
    // Engine's own notes carry the same key.
    const settingsDir = parseEnvFile(engineEnv).get('VAULT_SETTINGS_DIR') as string;
    const engineNote = await readFile(join(vault, settingsDir, 'Engine', 'General.md'), 'utf8');
    expect(engineNote.startsWith('---\ntype:\n')).toBe(true);
    expect(engineNote).not.toMatch(/^types:/m);
    const state = await loadState(join(dataDir, 'installer', 'state.json'));
    expect(state?.plan.structure?.types.map(type => type.name)).toEqual(['project']);
    expect(state?.plan.structure?.starter_fields).toEqual([]);
    expect(state?.stages.adopt?.completed_at).not.toBeNull();
    expect(state?.stages.adopt?.operations.length).toBeGreaterThan(0);

    // Settings, the curator domain included, were applied through Engine and validated by
    // it (model references resolve to seeded catalog notes). Extraction was not approved,
    // so it stays off.
    const { domains: applied } = await call<{
      domains: Record<string, { effective: Record<string, unknown> }>;
    }>('get-settings');
    // The vocabulary map went through the vault keys: a kind the notes lack is none, not
    // Engine's default name, and the journal kind is designated because Curator is installed.
    expect(applied.vault?.effective).toMatchObject({
      projectType: 'project', taskType: null, meetingType: null, personType: null, companyType: null, journalType: 'note',
      projectStatusField: 'status', projectActiveStatuses: ['open'], projectDoneStatuses: [],
      taskStatusField: null, taskActiveStatuses: [], wikiDir: 'Wikis', topicDir: 'Topics',
    });
    expect(await readFile(join(vault, 'Settings', 'Vault.md'), 'utf8')).toMatch(/^taskType:[ \t]*$/m);
    expect(applied.curator?.effective).toMatchObject({ dailyBudgetCents: 100, wikiReconciliationMode: 'live', model: '[[Claude Sonnet 4.6]]' });
    expect(state?.stages.settings).toMatchObject({ extraction: 'declined', engine_restarted: false });

    // Curator started last and, through curator-status, read the approved settings from Engine.
    expect(output.stdout).toContain('Daily cap: $1.00; wiki mode: live.');
    expect(output.stdout).toMatch(/Next sweep: \d{4}-\d{2}-\d{2}T/);
    expect(output.stdout).toContain('✓ Vault Curator is running   http://localhost:');
    expect(state?.stages.curator?.completed_at).not.toBeNull();

    // Verification against the real services: every check passes, except that search may
    // still be embedding in the background.
    expect(output.stdout).toContain('The installation is complete and verified.');
    expect(state?.stages.verify?.checks.filter(entry => entry.status === 'fail')).toEqual([]);
    expect(state?.stages.verify?.checks.find(entry => entry.id === 'notes')?.status).toBe('pass');
    expect(state?.stages.verify?.checks.find(entry => entry.id === 'models')?.status).toBe('pass');
    await expect(readFile(join(dataDir, 'installer', 'pending-keys.env'), 'utf8')).rejects.toThrow(/ENOENT/);

    // The handoff added the Obsidian plugin, connected: its own tokens from each service's
    // script work against the running services, the Curator one with the scope its wiki
    // commands need. Only data.json (0600) holds them; Obsidian's own settings are untouched.
    const pluginDir = join(vault, '.obsidian', 'plugins', 'vault-engine');
    expect((await readdir(pluginDir)).sort()).toEqual(['data.json', 'main.js', 'manifest.json', 'styles.css']);
    expect((await readdir(join(vault, '.obsidian'))).sort()).toEqual(['app.json', 'plugins']);
    expect((await stat(join(pluginDir, 'data.json'))).mode & 0o777).toBe(0o600);
    const plugin = JSON.parse(await readFile(join(pluginDir, 'data.json'), 'utf8')) as Record<string, string>;
    expect(plugin).toEqual({
      engineUrl: `http://localhost:${enginePort}/mcp`,
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
      curatorUrl: expect.stringMatching(/^http:\/\/localhost:\d+\/mcp$/),
      curatorToken: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const pluginEngine = engineClient(plugin.engineUrl as string, new Secret(plugin.token as string));
    expect((await pluginEngine<{ node_count: number }>('vault-stats')).node_count).toBeGreaterThanOrEqual(2);
    const pluginCurator = curatorClient(plugin.curatorUrl as string, new Secret(plugin.curatorToken as string));
    await expect(pluginCurator('curator-status')).resolves.toBeDefined();
    await expect(pluginCurator('create-project-wiki', { project: 'Alpha', dry_run: true })).resolves.toBeDefined();
    for (const secret of [plugin.token, plugin.curatorToken] as string[]) {
      expect(output.stdout).not.toContain(secret);
      expect(await readFile(join(dataDir, 'installer', 'state.json'), 'utf8')).not.toContain(secret);
    }
    expect(state?.stages.handoff?.obsidian_plugin).toBe('installed');
    expect(output.stdout).toContain(`Obsidian: the Vault Engine plugin is in ${pluginDir}, connected to Engine and Curator.`);
    expect(output.stdout).toContain(`claude mcp add --transport http --scope user vault-engine http://localhost:${enginePort}/mcp`);
    // One loose note is too few to lead with sorting: the project wiki comes first, then one line.
    expect(output.stdout).toContain('\nStart a wiki for one of your projects.');
    expect(output.stdout).toContain('1 of your 2 notes has no kind. To sort it, ask Claude Code: "What is still unorganized in my vault?"');

    // A local AI client signs in to each service at its localhost address with the owner
    // password the printed command shows, as Claude Code does after `claude mcp login`.
    // It sees Engine's external tool surface. At 127.0.0.1 the sign-in is refused, since
    // the address must match the issuer.
    const shown = async (service: string) => {
      const command = new RegExp(`^ {2}(sed -n .*)    # ${service}$`, 'm').exec(output.stdout)?.[1] as string;
      return (await createSystemHost().run('sh', ['-c', command])).stdout.trim();
    };
    const enginePassword = await shown('Engine');
    expect(enginePassword).toBe(parseEnvFile(engineEnv).get('OAUTH_OWNER_PASSWORD'));
    const engineTools = await signInWithOAuth(`http://localhost:${enginePort}/mcp`, enginePassword);
    expect(engineTools).toBeGreaterThan(0);
    expect(engineTools).toBeLessThan(await bearerToolCount(url, installer));
    await expect(signInWithOAuth(`http://127.0.0.1:${enginePort}/mcp`, enginePassword)).rejects.toThrow(/does not match/);
    const curatorPassword = await shown('Curator');
    expect(curatorPassword).toBe(parseEnvFile(await readFile(join(dataDir, 'curator.env'), 'utf8')).get('OAUTH_OWNER_PASSWORD'));
    expect(await signInWithOAuth(plugin.curatorUrl as string, curatorPassword)).toBeGreaterThan(0);
  }, 180_000);

  it('installs into an empty folder with every kind none', async () => {
    const { code, output, url, installerToken } = await installWithEngine({}, {
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: false },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(output.stdout).toContain('The installation is complete and verified.');
    expect(output.stdout).toContain('Notes indexed');
    const call = engineClient(url, new Secret(await installerToken()));
    // No starter kind is created unless asked for (#451).
    const schemas = (await call<Array<{ name: string; has_schema: boolean }>>('list-schemas')).filter(schema => schema.has_schema);
    expect(schemas).toEqual([]);
  }, 180_000);

  it('installs with every kind none: nothing is created for them, and none stays none', async () => {
    const { code, output, vault, dataDir, url, installerToken } = await installWithEngine({
      'Clips/Article.md': fm({ type: 'clipping', status: 'read' }),
      'Inbox.md': '# Inbox\n',
    }, {
      structure: { source: 'field', type_field: 'type' },
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: false },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(output.stdout).toContain('The installation is complete and verified.');
    // No Curator, so the first thing to try is a search; the one note with no kind gets a line.
    expect(output.stdout).toContain('Search your notes.');
    expect(output.stdout).toContain('1 of your 2 notes has no kind. To sort it, ask Claude Code: "What is still unorganized in my vault?"');
    const call = engineClient(url, new Secret(await installerToken()));
    const schemas = (await call<Array<{ name: string; has_schema: boolean }>>('list-schemas')).filter(schema => schema.has_schema);
    // Only the notes' own type: no starter project, no note type, and no status field claimed for a kind.
    expect(schemas.map(schema => schema.name)).toEqual(['clipping']);
    const { domains } = await call<{ domains: { vault: { effective: Record<string, unknown> } } }>('get-settings', { domain: 'vault' });
    expect(domains.vault.effective).toMatchObject({
      projectType: null, taskType: null, meetingType: null, personType: null, companyType: null, journalType: null,
      projectStatusField: null, taskStatusField: null,
      projectActiveStatuses: [], projectDoneStatuses: [], taskActiveStatuses: [], taskDoneStatuses: [],
      // The notes have none of the other fields, so each is none rather than Engine's default name.
      dueField: null, dateField: null, peopleField: null, companyField: null, priorityField: null, scheduledField: null,
      wikiDir: 'Wikis', topicDir: null,
    });
    const note = await readFile(join(vault, 'Settings', 'Vault.md'), 'utf8');
    for (const key of ['projectType', 'taskType', 'meetingType', 'personType', 'companyType', 'journalType', 'projectStatusField', 'taskStatusField']) {
      expect(note, key).toMatch(new RegExp(`^${key}:[ \\t]*$`, 'm'));
    }
    const state = await loadState(join(dataDir, 'installer', 'state.json'));
    expect(state?.stages.verify?.checks.filter(entry => entry.status === 'fail')).toEqual([]);
    // So Engine reports no designated name missing from the vault: no Settings warning.
    expect(state?.stages.verify?.checks.find(entry => entry.id === 'settings')).toMatchObject({ status: 'pass' });
    expect(state?.plan.review.settings.filter(setting => setting.setting.startsWith('wiki.'))).toEqual([]);
  }, 180_000);

  it('installs renamed kinds, new types under chosen names, and their own status fields', async () => {
    const { code, output, url, installerToken } = await installWithEngine({
      'Initiatives/Alpha.md': fm({ type: 'initiative', stage: 'live' }),
      'Initiatives/Beta.md': fm({ type: 'initiative', stage: 'shelved' }),
      'Log/Entry.md': fm({ type: 'log' }),
    }, {
      structure: {
        source: 'field',
        type_field: 'type',
        roles: { project: 'initiative', task: { starter: 'action item' } },
        status_fields: { project: 'stage', task: { starter: 'state' } },
        active_statuses: ['live'],
        status_groups: { ignored: ['shelved'] },
      },
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: true, journal_type: 'log' },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(output.stdout).toContain('The installation is complete and verified.');
    const call = engineClient(url, new Secret(await installerToken()));
    const action = await call<{ fields: Array<{ name: string }> }>('describe-schema', { name: 'action item' });
    expect(action.fields.map(field => field.name).sort()).toEqual(['due', 'project', 'state']);
    expect(await call('describe-global-field', { name: 'state' })).toMatchObject({ field_type: 'enum' });
    expect(await call('describe-global-field', { name: 'project' })).toMatchObject({ reference_target: 'initiative' });
    const initiative = await call<{ fields: Array<{ name: string }> }>('describe-schema', { name: 'initiative' });
    expect(initiative.fields.map(field => field.name)).toEqual(['stage']);
    await expect(call('describe-global-field', { name: 'status' })).rejects.toThrow();
    const { domains } = await call<{ domains: { vault: { effective: Record<string, unknown> } } }>('get-settings', { domain: 'vault' });
    expect(domains.vault.effective).toMatchObject({
      projectType: 'initiative', taskType: 'action item', meetingType: null, journalType: 'log',
      projectStatusField: 'stage', projectActiveStatuses: ['live'], projectIgnoredStatuses: ['shelved'], projectDoneStatuses: [],
      taskStatusField: 'state', taskActiveStatuses: ['open', 'in-progress'], taskDoneStatuses: ['done'],
      taskTickStatus: 'done', taskUntickStatus: 'open',
      // The new task type's due field counts as present; the notes have no people field.
      dueField: 'due', peopleField: null, dateField: null,
    });
  }, 180_000);

  it('merges and drops type values Engine already indexed from types', async () => {
    const { code, output, vault, url, installerToken } = await installWithEngine({
      'Meetings/Sync.md': '---\ntypes:\n  - meeting\n---\n',
      'Meetings/Review.md': '---\ntypes:\n  - Meeting\n---\n',
      // Engine keeps the spaces; the Analyzer reads the value trimmed.
      'Meetings/Padded.md': "---\ntypes:\n  - ' Meeting '\n---\n",
      // Engine strips the brackets but keeps the alias; the Analyzer reads the target.
      'Meetings/Linked.md': "---\ntypes:\n  - '[[Meeting|Meetings]]'\n---\n",
      'Scratch.md': '---\ntypes:\n  - misc\n---\n',
    }, {
      structure: { source: 'field', type_field: 'types', type_renames: { Meeting: 'meeting', misc: null } },
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: false },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const types = await typesByPath(engineClient(url, new Secret(await installerToken())));
    expect(types['Meetings/Sync.md']).toEqual(['meeting']);
    expect(types['Meetings/Review.md']).toEqual(['meeting']);
    expect(types['Meetings/Padded.md']).toEqual(['meeting']);
    expect(types['Meetings/Linked.md']).toEqual(['meeting']);
    expect(types['Scratch.md']).toEqual([]);
    expect(await readFile(join(vault, 'Meetings', 'Review.md'), 'utf8')).toMatch(/^types:\n {2}- meeting$/m);
    expect(await readFile(join(vault, 'Scratch.md'), 'utf8')).toMatch(/^types:$/m);
  }, 180_000);

  it('stores a review field as chosen and keeps the type field as Engine\'s type key', async () => {
    const { code, output, vault, url, installerToken } = await installWithEngine({
      'Projects/Alpha.md': fm({ kind: 'project', owners: '"[[Avery]]"' }),
      'Projects/Beta.md': fm({ kind: 'project', owners: '["[[Avery]]", "[[Blake]]"]' }),
      'People/Avery.md': fm({ kind: 'person' }),
      'People/Blake.md': fm({ kind: 'person' }),
      'Loose.md': fm({ kind: 'misc' }),
    }, {
      structure: { source: 'field', type_field: 'kind', type_renames: { misc: null }, review_fields: { owners: 'dominant' }, remove_type_field: true },
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: false },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const call = engineClient(url, new Secret(await installerToken()));
    // Adoption's reanalysis read the choice back from the saved plan.
    expect(await call('describe-global-field', { name: 'owners' }))
      .toMatchObject({ field_type: 'list', list_item_type: 'reference', reference_target: 'person' });
    const project = await call<{ fields: Array<{ name: string }> }>('describe-schema', { name: 'project' });
    expect(project.fields.map(field => field.name)).toContain('owners');
    const types = await typesByPath(call);
    expect(types['Projects/Alpha.md']).toEqual(['project']);
    // kind holds the types (#445): Engine rewrote Alpha (its owners became a list) with
    // kind first, and added no types key. The remove_type_field answer had nothing to remove.
    const alpha = await readFile(join(vault, 'Projects', 'Alpha.md'), 'utf8');
    expect(alpha).toMatch(/^---\nkind:\n {2}- project\n/);
    expect(alpha).not.toMatch(/^types:/m);
    expect(alpha).toMatch(/^owners:\n {2}- "\[\[Avery\]\]"$/m);
    // The dropped value goes from the note, as it would from types.
    expect(types['Loose.md']).toEqual([]);
    expect(await readFile(join(vault, 'Loose.md'), 'utf8')).toMatch(/^kind:$/m);
  }, 180_000);

  it('converts a chosen field on notes whose types already match', async () => {
    const { code, output, vault, url, installerToken } = await installWithEngine({
      'Projects/Alpha.md': '---\ntypes:\n  - project\nowners: "[[Avery]]"\n---\n',
      'Projects/Beta.md': '---\ntypes:\n  - project\nowners:\n  - "[[Avery]]"\n  - "[[Blake]]"\n---\n',
      'People/Avery.md': '---\ntypes:\n  - person\n---\n',
      'People/Blake.md': '---\ntypes:\n  - person\n---\n',
    }, {
      structure: { source: 'field', type_field: 'types', review_fields: { owners: 'dominant' } },
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: false },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const call = engineClient(url, new Secret(await installerToken()));
    expect(await call('describe-global-field', { name: 'owners' })).toMatchObject({ field_type: 'list', list_item_type: 'reference' });
    // Alpha needed no type change; claiming owners converted its single link to a list.
    expect(await readFile(join(vault, 'Projects', 'Alpha.md'), 'utf8')).toMatch(/^owners:\n {2}- "\[\[Avery\]\]"$/m);
  }, 180_000);

  it('undoes adoption, field definitions included, and the notes keep their values (#468)', async () => {
    const { code, output, vault, dataDir, url, installerToken, cli } = await installWithEngine({
      'Projects/Alpha.md': '---\ntypes:\n  - project\nowners: "[[Avery]]"\n---\n',
      'Projects/Beta.md': '---\ntypes:\n  - project\nowners:\n  - "[[Avery]]"\n  - "[[Blake]]"\n---\n',
      'People/Avery.md': '---\ntypes:\n  - person\n---\n',
      'People/Blake.md': '---\ntypes:\n  - person\n---\n',
    }, {
      structure: { source: 'field', type_field: 'types', review_fields: { owners: 'dominant' } },
      providers: { anthropic: 'env:TEST_ANTHROPIC' },
      curator: { install: false },
    });
    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const undone = await cli(['undo', '--data-dir', dataDir, '--yes']);

    expect({ code: undone.code, stderr: undone.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(undone.stdout).toMatch(/- Fields: the \d+ fields? organizing defined (are|is) removed; notes keep their values for them, unmanaged again\./);
    expect(undone.stdout).toContain('The changes organizing your notes made are undone.');
    const call = engineClient(url, new Secret(await installerToken()));
    const fields = (await call<Array<{ name: string }>>('list-global-fields')).map(field => field.name);
    expect(fields).not.toContain('owners');
    // The claim's conversion is reverted and both notes keep their links, in Engine and in the files.
    const alpha = await readFile(join(vault, 'Projects', 'Alpha.md'), 'utf8');
    const beta = await readFile(join(vault, 'Projects', 'Beta.md'), 'utf8');
    expect(alpha).toMatch(/^owners: "\[\[Avery\]\]"$/m);
    expect(beta).toMatch(/^owners:\n {2}- "\[\[Avery\]\]"\n {2}- "\[\[Blake\]\]"$/m);
    const owners = async (file_path: string) => (await call<{ fields: Record<string, { value: unknown }> }>('get-node', { file_path, include_embeds: false })).fields.owners?.value;
    expect(await owners('Projects/Alpha.md')).toBe('Avery');
    expect(await owners('Projects/Beta.md')).toEqual(['Avery', 'Blake']);
  }, 240_000);

  it('drops the values the plan drops when it drops every type, and turns on approved extraction', async () => {
    const { code, output, dataDir, url, installerToken } = await installWithEngine({
      'Clip.md': '---\ntypes:\n  - clipping\n---\n',
      'Scratch.md': '---\ntypes:\n  - misc\n---\n',
    }, {
      structure: { source: 'field', type_field: 'types', type_renames: { clipping: null, misc: null } },
      providers: { anthropic: 'env:TEST_ANTHROPIC', gemini: 'env:TEST_GEMINI' },
      models: { vision_provider: 'gemini' },
      curator: { install: false },
      extraction: { approve: true },
    });

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    // Engine was restarted with the held key and answers again.
    const call = engineClient(url, new Secret(await installerToken()));
    const types = await typesByPath(call);
    expect(types['Clip.md']).toEqual([]);
    expect(types['Scratch.md']).toEqual([]);
    expect(parseEnvFile(await readFile(join(dataDir, 'engine.env'), 'utf8')).get('GEMINI_API_KEY')).toBe('gemini-e2e-placeholder');
    const { domains } = await call<{ domains: { engine: { effective: { visionProvider: string } } } }>('get-settings', { domain: 'engine' });
    expect(domains.engine.effective.visionProvider).toBe('gemini');
    expect((await loadState(join(dataDir, 'installer', 'state.json')))?.stages.settings)
      .toMatchObject({ extraction: 'approved', engine_restarted: true });
  }, 180_000);

  it('installs through quick setup, writing no kind into notes that do not state one', async () => {
    const soup = '# Soup\n\nA note in a folder, with no line saying its kind.\n';
    const asked: string[] = [];
    const confirmed: string[] = [];
    const outros: string[] = [];
    const quick = (vault: string): Prompter => ({
      interactive: true,
      intro() {},
      welcome() {},
      step() {},
      success() {},
      outro: message => { outros.push(message); },
      note() {},
      info() {},
      warn() {},
      text: async question => { asked.push(question.id); return question.id === 'vault.path' ? vault : question.defaultValue ?? ''; },
      select: async question => { asked.push(question.id); return question.initialValue; },
      // Quick setup, then install; attachment extraction stays off.
      confirm: async question => {
        confirmed.push(question.message);
        return question.message === SETUP_MODE_QUESTION.message || question.message === 'Ready? Install Vault with this plan?';
      },
      multiselect: async question => { asked.push(question.id); return question.initialValues; },
      secret: async question => { asked.push(question.id); return question.id === 'providers.anthropic' ? { source: 'env', name: 'TEST_ANTHROPIC' } : null; },
      decide: question => question.ask(),
      rejectAnswer(_id, reason) { throw new Error(reason); },
      spinner: () => ({ stop() {} }),
    });
    const { code, output, vault, dataDir, url, installerToken } = await installWithEngine({
      'Projects/Alpha.md': fm({ type: 'project', status: 'active' }),
      'Meetings/Kickoff.md': fm({ type: 'meeting', date: '2026-11-01' }),
      'Recipes/Soup.md': soup,
      'Templates/Project.md': fm({ type: 'project' }),
    }, {}, quick);

    expect({ code, stderr: output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(outros.at(-1)).toContain('The installation is complete and verified.');
    expect(asked).toEqual(['vault.path', 'providers', 'providers.anthropic']);
    // The short review's details question (#437) comes before the approval.
    expect(confirmed.slice(0, 3)).toEqual([SETUP_MODE_QUESTION.message, 'Show every file and command?', 'Ready? Install Vault with this plan?']);
    const call = engineClient(url, new Secret(await installerToken()));
    const schemas = (await call<Array<{ name: string; has_schema: boolean }>>('list-schemas')).filter(schema => schema.has_schema);
    // The plan created only the kinds the notes state (Curator adds its journal kind itself
    // when it first writes); the folder of notes without one got no kind.
    expect(schemas.map(schema => schema.name)).toEqual(expect.arrayContaining(['meeting', 'project']));
    expect(schemas.map(schema => schema.name)).not.toContain('recipe');
    expect((await typesByPath(call))['Recipes/Soup.md']).toEqual([]);
    expect(await readFile(join(vault, 'Recipes', 'Soup.md'), 'utf8')).toBe(soup);
    const { domains } = await call<{ domains: Record<string, { effective: Record<string, unknown> }> }>('get-settings');
    expect(domains.vault?.effective).toMatchObject({
      projectType: 'project', meetingType: 'meeting', taskType: null, personType: null, companyType: null, journalType: 'note',
      projectStatusField: 'status', projectActiveStatuses: ['active'], dateField: 'date', dueField: null, wikiDir: 'Wikis', topicDir: 'Topics',
    });
    expect(domains.curator?.effective).toMatchObject({ dailyBudgetCents: 100, sweepAt: '05:00', wikiReconciliationMode: 'live' });
    const state = await loadState(join(dataDir, 'installer', 'state.json'));
    expect(state?.plan.structure?.types.map(type => type.name).sort()).toEqual(['meeting', 'project']);
    expect(state?.plan.vault?.exclusions).toEqual(['Templates']);
    expect(state?.plan.models.preset).toBe('balanced');
    expect(state?.stages.verify?.checks.filter(entry => entry.status === 'fail')).toEqual([]);
  }, 180_000);
});
