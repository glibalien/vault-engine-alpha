import { curatorEnvPath, engineEnvPath, installerEnvPath, replaceFile, SEED_ONLY_COMMENT, sha256 } from './configure.js';
import { EngineAuthError, engineClient, type EngineCall } from './engine-client.js';
import { parseEnvFile, renderEnvFile } from './env-file.js';
import type { Host } from './host.js';
import type { Prompter } from './prompter.js';
import { Secret } from './secret.js';
import { envDialect, plannedManager } from './service-manager.js';
import { ServiceError, type ServiceBackend } from './services.js';
import { saveState, type InstallState } from './state.js';
import { count } from './text.js';
import { CURATOR_TOKEN, INSTALLER_TOKEN, mintEngineToken } from './tokens.js';
import { ENGINE_UNIT } from './units.js';

/** Variables Engine reads only on its first start; it warns about them on every later one. */
const SEED_ONLY = ['VAULT_EXCLUDE_DIRS', 'EXTRACTION_ENABLED'];

export interface EngineStageDeps {
  host: Host;
  prompter: Prompter;
  backend: ServiceBackend;
  now: () => Date;
  /** Test seam; production connects over MCP. */
  connect?: (url: string, token: Secret) => EngineCall;
  readyTimeoutMs?: number;
  pollMs?: number;
}

interface VaultStats {
  node_count: number;
  schema_count: number;
  search_index?: { status?: string; pending?: number };
}

/**
 * Stage 8. Start Engine with the configured environment, wait until it answers, and only
 * then mint tokens: the installer's own (one day) and, when Curator is installed,
 * Curator's, which goes into curator.env. Seed-only variables leave engine.env once
 * Engine has seeded its settings. Each step checks what is already done, so a rerun
 * repeats nothing.
 */
export async function runEngineStage(deps: EngineStageDeps, state: InstallState, path: string): Promise<void> {
  const { host, prompter, backend } = deps;
  if (state.stages.engine?.completed_at) return;
  const plan = state.plan;
  const vault = plan.vault;
  if (!vault) throw new ServiceError('the saved plan has no vault');
  const dataDir = plan.data_dir;
  const port = plan.services.engine_port;
  state.stages.engine ??= { started_at: deps.now().toISOString(), completed_at: null };
  await saveState(path, state);

  await backend.start(ENGINE_UNIT);
  await waitUntilAnswering(deps, port, { ...ENGINE_SERVICE, notes: plannedNotes(plan) });

  const call = await connectAsInstaller(deps, plan);

  if (plan.curator) {
    const curatorEnv = curatorEnvPath(dataDir);
    const text = await host.readText(curatorEnv);
    if (text === null) throw new ServiceError(`${curatorEnv} is missing; it was written when the install was configured.`);
    if (!parseEnvFile(text).has('ENGINE_TOKEN')) {
      const token = await mintToken(host, plan, CURATOR_TOKEN);
      const dialect = envDialect(plannedManager(plan.services));
      const updated = `${text.replace(/\n*$/, '\n')}${renderEnvFile([], [{ name: 'ENGINE_TOKEN', value: token }], dialect)}`;
      recordFile(state, curatorEnv, await replaceFile(curatorEnv, updated));
      await saveState(path, state);
    }
  }
  await dropSeedOnlyVariables(deps, state, path);

  const stats = await call<VaultStats>('vault-stats');
  prompter.note([
    `Answering at http://localhost:${port}/mcp`,
    `Indexed ${count(stats.node_count, 'note')}; ${count(stats.schema_count, 'type')} so far.`,
    'Search embeddings are built in the background.',
  ].join('\n'), 'Engine');
  state.stages.engine = { ...state.stages.engine, completed_at: deps.now().toISOString() };
  await saveState(path, state);
}

/** The service a wait is for: Engine by default. */
export interface AnsweringService {
  unit: string;
  name: string;
  /** What it does before it answers. */
  first: string;
  /** Notes it indexes before it answers, for an expected time. */
  notes?: number;
}
const ENGINE_SERVICE: AnsweringService = { unit: ENGINE_UNIT, name: 'Engine', first: 'it indexes the vault first' };

/** Polls between reads of the service's log for progress: about 5 seconds. */
const LOG_EVERY_POLLS = 5;
/** Polls between progress lines in a headless run: about 30 seconds, so logs stay short. */
const HEADLESS_EVERY_POLLS = 30;
/** Log lines read for progress; enough that a burst of other lines does not hide it. */
const PROGRESS_LOG_LINES = 200;

/**
 * Wait until a service answers on `port`, stopping with its log if it stops or crashes.
 * Meanwhile it shows the time waited and what the service's log says it is doing, such
 * as how many notes Engine has indexed.
 */
export async function waitUntilAnswering(
  deps: Pick<EngineStageDeps, 'host' | 'prompter' | 'backend' | 'readyTimeoutMs' | 'pollMs'>,
  port: number,
  service: AnsweringService = ENGINE_SERVICE,
): Promise<void> {
  const { host, prompter, backend } = deps;
  const { unit, name } = service;
  const timeoutMs = deps.readyTimeoutMs ?? 15 * 60_000;
  const startedWaiting = Date.now();
  const deadline = startedWaiting + timeoutMs;
  const baseline = (await backend.health(unit)).restarts;
  // Only this run's log: an earlier run's progress would be stale.
  const since = await backend.startedAt(unit) ?? new Date(startedWaiting);
  const expected = service.notes === undefined ? '' : ` (${expectedIndexTime(service.notes)})`;
  const spinner = prompter.spinner(`Waiting for ${name} to answer; ${service.first}${expected}…`);
  let progress: StartupProgress | null = null;
  for (let poll = 0; ; poll++) {
    if (await host.httpStatus(`http://127.0.0.1:${port}/mcp`, {}, 2000) === 200) {
      spinner.stop(`${name} is answering.`);
      return;
    }
    const health = await backend.health(unit);
    if (health.stopped || health.restarts > baseline) {
      spinner.stop(`${name} stopped.`);
      const logs = await backend.recentLogs(unit);
      throw new ServiceError([
        `${name} stopped while starting: ${health.detail}.`,
        logs ? `Its last log lines:\n${logs}` : `Read its log with: ${backend.logCommand(unit)}`,
        'Fix the cause and run the install again.',
      ].join('\n'));
    }
    if (Date.now() >= deadline) {
      spinner.stop('Still waiting.');
      throw new ServiceError(`${name} has not answered after ${Math.round(timeoutMs / 60_000)} minutes. Follow ${backend.logCommand(unit)}, and run the install again once it answers.`);
    }
    if (poll % LOG_EVERY_POLLS === 0) {
      progress = startupProgress(await backend.recentLogs(unit, { since, lines: PROGRESS_LOG_LINES })) ?? progress;
    }
    if (prompter.interactive || (poll > 0 && poll % HEADLESS_EVERY_POLLS === 0)) {
      spinner.message?.(waitingMessage(service, progress, Date.now() - startedWaiting));
    }
    await new Promise(resolve => setTimeout(resolve, deps.pollMs ?? 1000));
  }
}

/** What a starting Engine is doing, from its log; `notes` once it has logged a count. */
export type StartupProgress =
  | { phase: 'indexing'; notes?: { done: number; total: number } }
  | { phase: 'finishing' };

/**
 * What Engine's latest startup line says it is doing: indexing, with how many notes so
 * far once it logs a count, or the rest of its startup after indexing. Null when no line
 * says.
 */
export function startupProgress(log: string): StartupProgress | null {
  for (const line of log.split('\n').map(text => text.trim()).reverse()) {
    const counted = /^Indexing: (\d+) of (\d+) notes$/.exec(line);
    if (counted) return { phase: 'indexing', notes: { done: Number(counted[1]), total: Number(counted[2]) } };
    if (line.startsWith('Indexing vault at ')) return { phase: 'indexing' };
    if (line.startsWith('Indexing complete in ')) return { phase: 'finishing' };
  }
  return null;
}

/**
 * The line shown while waiting: what the service is doing and for how long, with an
 * expected time from the plan's note count until Engine logs a count of its own.
 */
export function waitingMessage(service: AnsweringService, progress: StartupProgress | null, elapsedMs: number): string {
  const elapsed = formatElapsed(elapsedMs);
  if (progress?.phase === 'finishing') return `${service.name} has indexed the notes and is finishing its startup (${elapsed})`;
  if (progress?.notes) return `${service.name} is indexing notes: ${progress.notes.done} of ${progress.notes.total} (${elapsed})`;
  const doing = progress ? `${service.name} is indexing notes` : `Waiting for ${service.name} to answer; ${service.first}`;
  const expected = service.notes === undefined ? '' : `; ${expectedIndexTime(service.notes)}`;
  return `${doing} (${elapsed}${expected})`;
}

/**
 * Notes per second Engine gets through on its first start before it answers, for an
 * expected time. Since #464 the index takes time in proportion to the note count: a
 * desktop indexed 20,495 generated notes in 36 seconds, and with the steps after it
 * (link backfill, link repair) was ready in about 58, some 350 notes a second. This
 * rounds that down; a slower machine takes longer.
 */
const NOTES_PER_SECOND = 300;

/** `expect up to about 2 minutes for 20000 notes`, from the plan's note count. */
export function expectedIndexTime(notes: number): string {
  const minutes = Math.max(1, Math.ceil(notes / NOTES_PER_SECOND / 60));
  return `expect up to about ${minutes === 1 ? 'a minute' : `${minutes} minutes`} for ${count(notes, 'note')}`;
}

/** `45s`, `2m 05s`. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** The Markdown files in scope that Vault Analyzer counted for the plan. */
function plannedNotes(plan: InstallState['plan']): number | undefined {
  const notes = plan.vault?.inventory?.['markdown_files'];
  return typeof notes === 'number' ? notes : undefined;
}

/**
 * Engine MCP calls with the installer's token: the saved one while Engine accepts it,
 * otherwise a new one (it lasts a day, and a resumed install may come later).
 */
export async function connectAsInstaller(
  deps: Pick<EngineStageDeps, 'host' | 'connect'>,
  plan: InstallState['plan'],
): Promise<EngineCall> {
  const connect = deps.connect ?? engineClient;
  // Engine listens on IPv4 loopback only, and `localhost` can resolve to ::1 first.
  const url = `http://127.0.0.1:${plan.services.engine_port}/mcp`;
  const token = await installerToken(deps.host, plan.data_dir, url, connect, spec => mintToken(deps.host, plan, spec));
  return connect(url, token);
}

function mintToken(host: Host, plan: InstallState['plan'], token: { name: string; ttlDays: number }): Promise<Secret> {
  if (!plan.vault) throw new ServiceError('the saved plan has no vault');
  return mintEngineToken({
    host,
    nodePath: plan.services.node_path,
    repoRoot: plan.repo_root,
    vaultPath: plan.vault.path,
    dbPath: plan.review.engine_database ?? '',
    token,
  });
}

/** The saved installer token while Engine accepts it; otherwise a new one, saved 0600. */
async function installerToken(
  host: Host,
  dataDir: string,
  url: string,
  connect: (url: string, token: Secret) => EngineCall,
  mint: (token: { name: string; ttlDays: number }) => Promise<Secret>,
): Promise<Secret> {
  const path = installerEnvPath(dataDir);
  const text = await host.readText(path);
  const saved = text === null ? undefined : parseEnvFile(text).get('ENGINE_TOKEN');
  if (saved) {
    const token = new Secret(saved);
    try {
      await connect(url, token)('vault-stats');
      return token;
    } catch (error) {
      if (!(error instanceof EngineAuthError)) throw error;
    }
  }
  const token = await mint(INSTALLER_TOKEN);
  await replaceFile(path, renderEnvFile([
    `The installer's Engine token, valid for ${INSTALLER_TOKEN.ttlDays} day; it is removed when the install finishes.`,
  ], [{ name: 'ENGINE_TOKEN', value: token }]));
  return token;
}

/**
 * Remove seed-only variables from engine.env once Engine has seeded its settings, so it
 * stops warning about them. A file edited since the installer wrote it is left alone.
 */
async function dropSeedOnlyVariables(deps: EngineStageDeps, state: InstallState, path: string): Promise<void> {
  const engineEnv = engineEnvPath(state.plan.data_dir);
  const text = await deps.host.readText(engineEnv);
  if (text === null) throw new ServiceError(`${engineEnv} is missing; it was written when the install was configured.`);
  const present = SEED_ONLY.filter(name => parseEnvFile(text).has(name));
  if (present.length === 0) return;
  if (sha256(text) !== state.stages.configure?.files[engineEnv]) {
    const one = present.length === 1;
    deps.prompter.warn(`${engineEnv} changed since the installer wrote it, so ${present.join(', ')} ${one ? 'stays' : 'stay'}. Engine ignores ${one ? 'it' : 'them'} after its first start.`);
    return;
  }
  const kept = text.split('\n')
    .filter(line => line !== `# ${SEED_ONLY_COMMENT}` && !present.some(name => line.startsWith(`${name}=`)));
  recordFile(state, engineEnv, await replaceFile(engineEnv, kept.join('\n')));
  await saveState(path, state);
}

/** Keep configure's record current, so later drift checks compare against this content. */
function recordFile(state: InstallState, file: string, hash: string): void {
  if (state.stages.configure) state.stages.configure.files[file] = hash;
}
