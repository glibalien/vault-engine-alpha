import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_ONLY_COMMENT } from '../src/configure.js';
import { EngineAuthError } from '../src/engine-client.js';
import { expectedIndexTime, runEngineStage, startupProgress, waitingMessage, type EngineStageDeps } from '../src/engine-stage.js';
import { parseEnvFile } from '../src/env-file.js';
import type { Host } from '../src/host.js';
import { createScriptedPrompter } from '../src/prompter.js';
import type { Secret } from '../src/secret.js';
import { ServiceError, type ServiceBackend, type ServiceHealth } from '../src/services.js';
import type { InstallState } from '../src/state.js';
import { TokenError, mintEngineToken } from '../src/tokens.js';
import { makeTree, realFilesystemHost, removeTrees, replayPrompter } from './helpers.js';

afterEach(removeTrees);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);

const ENGINE_ENV = [
  '# Vault Engine, written by vault-installer.',
  `# ${SEED_ONLY_COMMENT}`,
  '',
  'VAULT_PATH=/notes',
  'VAULT_EXCLUDE_DIRS=Templates',
  'EXTRACTION_ENABLED=false',
  'OAUTH_OWNER_PASSWORD=pw',
  '',
].join('\n');
const CURATOR_ENV = '# Vault Curator\n\nENGINE_URL=http://localhost:3334\n';

async function setup(options: { curator?: boolean } = {}) {
  const dataDir = await makeTree({});
  await mkdir(join(dataDir, 'installer'), { recursive: true });
  await writeFile(join(dataDir, 'engine.env'), ENGINE_ENV);
  await writeFile(join(dataDir, 'curator.env'), CURATOR_ENV);
  const state = {
    format: 'vault-installer-state',
    version: 1,
    approved_at: '2026-10-26T12:00:00.000Z',
    plan: {
      data_dir: dataDir,
      repo_root: '/repo',
      services: { user: 'tester', node_path: '/opt/node', engine_port: 3334, curator_port: 3335 },
      vault: { path: '/notes', settings_dir: 'Settings', exclusions: ['Templates'] },
      curator: options.curator === false ? null : { daily_budget_cents: 100 },
      review: { engine_database: '/notes/.vault-engine/vault.db' },
    },
    stages: {
      configure: {
        completed_at: '2026-10-26T12:00:00.000Z',
        files: { [join(dataDir, 'engine.env')]: sha256(ENGINE_ENV), [join(dataDir, 'curator.env')]: sha256(CURATOR_ENV) },
      },
      backup: { started_at: '', directory: null, completed_at: '2026-10-26T12:00:00.000Z', files: 0, bytes: 0 },
    },
  } as unknown as InstallState;
  return { dataDir, state, statePath: join(dataDir, 'installer', 'state.json') };
}

function backend(healths: ServiceHealth[] = [], logs = ''): ServiceBackend & { starts: string[] } {
  const starts: string[] = [];
  return {
    starts,
    start: async unit => { starts.push(unit); },
    restart: async () => {},
    health: async () => healths.length > 1 ? healths.shift()! : healths[0] ?? { stopped: false, restarts: 0, detail: 'running' },
    startedAt: async () => new Date(0),
    recentLogs: async () => logs,
    logCommand: unit => `journalctl -u ${unit}`,
  };
}

/** Hands out tokens in order to the token script and accepts only `valid` ones over MCP. */
function engineDeps(overrides: Partial<EngineStageDeps> & { tokens?: string[]; valid?: string[]; statuses?: Array<number | null> } = {}) {
  const tokens = [...(overrides.tokens ?? [TOKEN_A, TOKEN_B, TOKEN_C])];
  const valid = overrides.valid;
  const statuses = [...(overrides.statuses ?? [200])];
  const scripts: string[][] = [];
  const lines: string[] = [];
  const host: Host = realFilesystemHost({
    run: async (_command, args) => {
      scripts.push(args);
      return { code: 0, stdout: `Authorization: Bearer ${tokens.shift()}\n`, stderr: '' };
    },
    httpStatus: async () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!),
  });
  const used: string[] = [];
  const deps: EngineStageDeps = {
    host,
    prompter: createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, line => lines.push(line)),
    backend: backend(),
    now: () => new Date('2026-10-26T13:00:00Z'),
    connect: (_url: string, token: Secret) => async <T>(tool: string) => {
      used.push(`${tool}:${token.reveal().slice(0, 1)}`);
      if (valid && !valid.includes(token.reveal())) throw new EngineAuthError('refused');
      return { node_count: 3, schema_count: 1 } as T;
    },
    pollMs: 1,
    ...overrides,
  };
  return { deps, scripts, lines, used };
}

describe('runEngineStage', () => {
  it('starts Engine, waits for it, mints both tokens, and drops the seed-only variables', async () => {
    const { dataDir, state, statePath } = await setup();
    const { deps, scripts, lines } = engineDeps({ statuses: [null, 503, 200] });

    await runEngineStage(deps, state, statePath);

    expect((deps.backend as ReturnType<typeof backend>).starts).toEqual(['vault-engine.service']);
    expect(scripts.map(args => args.slice(-4))).toEqual([
      ['--name', 'installer', '--ttl-days', '1'],
      ['--name', 'vault-curator', '--ttl-days', '36500'],
    ]);
    expect(parseEnvFile(await readFile(join(dataDir, 'installer', 'installer.env'), 'utf8')).get('ENGINE_TOKEN')).toBe(TOKEN_A);
    const curator = await readFile(join(dataDir, 'curator.env'), 'utf8');
    expect(curator).toBe(`${CURATOR_ENV}ENGINE_TOKEN=${TOKEN_B}\n`);
    const engine = await readFile(join(dataDir, 'engine.env'), 'utf8');
    expect(engine).not.toContain('VAULT_EXCLUDE_DIRS');
    expect(engine).not.toContain('EXTRACTION_ENABLED');
    expect(engine).not.toContain(SEED_ONLY_COMMENT);
    expect(parseEnvFile(engine).get('VAULT_PATH')).toBe('/notes');
    expect(state.stages.configure?.files).toEqual({ [join(dataDir, 'engine.env')]: sha256(engine), [join(dataDir, 'curator.env')]: sha256(curator) });
    expect(state.stages.engine).toEqual({ started_at: '2026-10-26T13:00:00.000Z', completed_at: '2026-10-26T13:00:00.000Z' });
    expect(lines).toContainEqual(expect.stringContaining('Indexed 3 notes; 1 type so far.'));
    expect(lines.join('\n')).not.toContain(TOKEN_A);
  });

  it('runs the token script with only the variables it needs', async () => {
    const { state, statePath } = await setup({ curator: false });
    const env: Array<Record<string, string> | undefined> = [];
    const { deps } = engineDeps();
    deps.host = { ...deps.host, run: async (_command, _args, options) => {
      env.push(options?.env);
      return { code: 0, stdout: `Authorization: Bearer ${TOKEN_A}\n`, stderr: '' };
    } };

    await runEngineStage(deps, state, statePath);

    expect(env).toEqual([{ PATH: expect.any(String), HOME: '/srv/tester', VAULT_PATH: '/notes', DB_PATH: '/notes/.vault-engine/vault.db' }]);
  });

  it('keeps a saved installer token Engine accepts and replaces one it refuses', async () => {
    const first = await setup({ curator: false });
    await writeFile(join(first.dataDir, 'installer', 'installer.env'), `ENGINE_TOKEN=${TOKEN_C}\n`);
    const accepted = engineDeps();
    await runEngineStage(accepted.deps, first.state, first.statePath);
    expect(accepted.scripts).toEqual([]);

    const second = await setup({ curator: false });
    await writeFile(join(second.dataDir, 'installer', 'installer.env'), `ENGINE_TOKEN=${TOKEN_C}\n`);
    const refused = engineDeps({ valid: [TOKEN_A] });
    await runEngineStage(refused.deps, second.state, second.statePath);
    expect(refused.scripts).toHaveLength(1);
    expect(parseEnvFile(await readFile(join(second.dataDir, 'installer', 'installer.env'), 'utf8')).get('ENGINE_TOKEN')).toBe(TOKEN_A);
  });

  it('does not mint a second Curator token on a rerun', async () => {
    const { dataDir, state, statePath } = await setup();
    await writeFile(join(dataDir, 'curator.env'), `${CURATOR_ENV}ENGINE_TOKEN=${TOKEN_C}\n`);
    const { deps, scripts } = engineDeps();

    await runEngineStage(deps, state, statePath);

    expect(scripts.map(args => args.at(-3))).toEqual(['installer']);
  });

  it('leaves an edited engine.env alone, with a warning', async () => {
    const { dataDir, state, statePath } = await setup({ curator: false });
    const edited = `${ENGINE_ENV}EXTRA=1\n`;
    await writeFile(join(dataDir, 'engine.env'), edited);
    const { deps, lines } = engineDeps();

    await runEngineStage(deps, state, statePath);

    expect(await readFile(join(dataDir, 'engine.env'), 'utf8')).toBe(edited);
    expect(lines).toContainEqual(expect.stringContaining('changed since the installer wrote it, so VAULT_EXCLUDE_DIRS, EXTRACTION_ENABLED stay'));
  });

  it('stops with the log tail when Engine crashes while starting', async () => {
    const { state, statePath } = await setup();
    const { deps, scripts } = engineDeps({
      statuses: [null],
      backend: backend([
        { stopped: false, restarts: 2, detail: 'activating' },
        { stopped: false, restarts: 3, detail: 'activating (auto-restart), restarted 3 times' },
      ], 'Error: VAULT_PATH environment variable is required'),
    });

    const run = runEngineStage(deps, state, statePath);

    await expect(run).rejects.toThrow(ServiceError);
    await expect(run).rejects.toThrow(/restarted 3 times[\s\S]*VAULT_PATH environment variable is required/);
    expect(scripts).toEqual([]);
    expect(state.stages.engine?.completed_at).toBeNull();
  });

  it('gives up after the timeout and explains how to follow the log', async () => {
    const { state, statePath } = await setup();
    const { deps } = engineDeps({ statuses: [null], readyTimeoutMs: 20 });

    await expect(runEngineStage(deps, state, statePath)).rejects.toThrow(/has not answered after 0 minutes[\s\S]*journalctl -u vault-engine.service/);
  });

  it('shows how far Engine has indexed, from its log since it started', async () => {
    const { state, statePath } = await setup({ curator: false });
    Object.assign(state.plan.vault!, { inventory: { markdown_files: 5000, non_markdown_by_extension: {} } });
    const started = new Date('2026-11-10T12:00:00Z');
    const logs = [
      '[settings] seeded engine domain from env (1 keys)',
      'Indexing vault at /notes...',
      'Indexing vault at /notes...\nIndexing: 1200 of 5000 notes',
      'Indexing: 4800 of 5000 notes\nIndexing complete in 31000ms\nInitializing embedder subprocess...',
    ];
    const reads: unknown[] = [];
    const service = { ...backend(), startedAt: async () => started };
    service.recentLogs = async (_unit, options) => {
      reads.push(options);
      return logs.length > 1 ? logs.shift()! : logs[0]!;
    };
    const { prompter } = replayPrompter({});
    const shown: string[] = [];
    prompter.spinner = message => {
      shown.push(message);
      return { stop: done => { shown.push(done); }, message: text => { shown.push(text); } };
    };
    const { deps } = engineDeps({ statuses: [...Array(16).fill(null), 200], prompter, backend: service });

    await runEngineStage(deps, state, statePath);

    expect([...new Set(shown.map(line => line.replace(/\(\d+s/, '(Ns')))]).toEqual([
      'Waiting for Engine to answer; it indexes the vault first (expect up to about a minute for 5000 notes)…',
      'Waiting for Engine to answer; it indexes the vault first (Ns; expect up to about a minute for 5000 notes)',
      'Engine is indexing notes (Ns; expect up to about a minute for 5000 notes)',
      'Engine is indexing notes: 1200 of 5000 (Ns)',
      'Engine has indexed the notes and is finishing its startup (Ns)',
      'Engine is answering.',
    ]);
    expect(reads).toEqual(Array(4).fill({ since: started, lines: 200 }));
  });

  it('prints progress headlessly only every 30 polls', async () => {
    const { state, statePath } = await setup({ curator: false });
    const service = { ...backend(), recentLogs: async () => 'Indexing: 1200 of 5000 notes' };
    const { deps, lines } = engineDeps({ statuses: [...Array(61).fill(null), 200], backend: service });

    await runEngineStage(deps, state, statePath);

    expect(lines.slice(0, 4).map(line => line.replace(/\(\d+s\)/, '(Ns)'))).toEqual([
      'Waiting for Engine to answer; it indexes the vault first…',
      'Engine is indexing notes: 1200 of 5000 (Ns)',
      'Engine is indexing notes: 1200 of 5000 (Ns)',
      'Engine is answering.',
    ]);
  });
});

describe('startupProgress', () => {
  it('reads what Engine is doing from its latest startup line', () => {
    expect(startupProgress('')).toBeNull();
    expect(startupProgress('[settings] seeded engine domain from env (1 keys)')).toBeNull();
    expect(startupProgress('Indexing vault at /notes...\nExcluding directories: Templates')).toEqual({ phase: 'indexing' });
    expect(startupProgress('Indexing vault at /notes...\nIndexing: 300 of 900 notes')).toEqual({ phase: 'indexing', notes: { done: 300, total: 900 } });
    expect(startupProgress('Indexing: 800 of 900 notes\nIndexing complete in 9000ms\nLink repair: 2 notes rewritten')).toEqual({ phase: 'finishing' });
    // A second pass after the settings reconcile indexes again.
    expect(startupProgress('Indexing complete in 9000ms\nStartup exclusions changed\nIndexing: 100 of 950 notes')).toEqual({ phase: 'indexing', notes: { done: 100, total: 950 } });
  });
});

describe('waitingMessage', () => {
  const engine = { unit: 'vault-engine.service', name: 'Engine', first: 'it indexes the vault first' };

  it('says what the service is doing and for how long', () => {
    expect(waitingMessage(engine, { phase: 'indexing', notes: { done: 1200, total: 5000 } }, 125_400)).toBe('Engine is indexing notes: 1200 of 5000 (2m 05s)');
    expect(waitingMessage(engine, { phase: 'finishing' }, 61_000)).toBe('Engine has indexed the notes and is finishing its startup (1m 01s)');
    expect(waitingMessage(engine, null, 3_000)).toBe('Waiting for Engine to answer; it indexes the vault first (3s)');
    expect(waitingMessage({ ...engine, notes: 20_000 }, { phase: 'indexing' }, 3_000)).toBe('Engine is indexing notes (3s; expect up to about 2 minutes for 20000 notes)');
  });

  it('expects at least a minute', () => {
    expect(expectedIndexTime(1)).toBe('expect up to about a minute for 1 note');
    expect(expectedIndexTime(18000)).toBe('expect up to about a minute for 18000 notes');
    expect(expectedIndexTime(18001)).toBe('expect up to about 2 minutes for 18001 notes');
  });
});

describe('mintEngineToken', () => {
  const input = { nodePath: '/opt/node', repoRoot: '/repo', vaultPath: '/notes', dbPath: '/notes/db', token: { name: 'installer', ttlDays: 1 }, retryDelayMs: 1 };

  it('retries while the database is busy', async () => {
    let attempts = 0;
    const host = realFilesystemHost({
      run: async () => (++attempts < 3
        ? { code: 1, stdout: '', stderr: 'SqliteError: database is locked' }
        : { code: 0, stdout: `Authorization: Bearer ${TOKEN_A}\n`, stderr: '' }),
    });

    const token = await mintEngineToken({ ...input, host });

    expect(token.reveal()).toBe(TOKEN_A);
    expect(attempts).toBe(3);
  });

  it('reports the script error without its output', async () => {
    const host = realFilesystemHost({ run: async () => ({ code: 0, stdout: `half a token ${TOKEN_A.slice(0, 10)}`, stderr: '' }) });

    const failure = mintEngineToken({ ...input, host });

    await expect(failure).rejects.toThrow(TokenError);
    await expect(failure).rejects.toThrow('could not mint the installer token: no token in its output');
  });
});
