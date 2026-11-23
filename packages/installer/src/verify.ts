import { pricingForExact } from '@vault/pricing';
import { indexedNotes } from './adopt.js';
import type { AnalyzerRunner } from './analyzer.js';
import { curatorEnvPath } from './configure.js';
import { readCuratorStatus, type CuratorStageDeps } from './curator-stage.js';
import { parseEnvFile } from './env-file.js';
import type { EngineCall } from './engine-client.js';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import type { CheckResult, CheckStatus } from './preflight.js';
import type { Prompter } from './prompter.js';
import { renderChecks } from './report.js';
import { PROVIDERS } from './providers.js';
import { dollars } from './review.js';
import { plannedManager, serviceName } from './service-manager.js';
import { CURATOR_UNIT, ENGINE_UNIT } from './units.js';
import { saveState, type InstallState } from './state.js';
import { count } from './text.js';

export interface VerifyDeps {
  host: Host;
  analyzer: AnalyzerRunner;
  /** Engine calls with the installer token. */
  engine: () => Promise<EngineCall>;
  connectCurator?: CuratorStageDeps['connectCurator'];
}

interface VaultStats {
  node_count: number;
  search_index?: {
    status: 'ready' | 'indexing' | 'disabled';
    nodes_total: number;
    nodes_indexed: number;
    pending: number;
    terminal_failures: number;
  };
}

/** Each settings domain, and the `models` pseudo-domain with the catalog. */
interface SettingsPayload {
  domains: Record<string, {
    effective?: Record<string, unknown>;
    issues?: Array<{ key: string; code: string; message: string }>;
    catalog?: Array<{ title: string; provider: string; model: string; enabled: boolean; pricing?: unknown }>;
    /** On the models pseudo-domain: which providers' keys Engine has. */
    providers?: Record<string, boolean>;
  }>;
}

/**
 * The installation's health, as stage 12 and `vault-installer status` report it. Every
 * check is a free, read-only request. A failed check is a problem to fix; a warning,
 * such as search still embedding, does not hold the install up.
 */
export async function verifyInstall(deps: VerifyDeps, plan: InstallState['plan']): Promise<CheckResult[]> {
  const port = plan.services.engine_port;
  const answering = await deps.host.httpStatus(`http://127.0.0.1:${port}/mcp`, {}, 5000) === 200;
  if (!answering) {
    return [check('engine', 'fail', 'Engine', `does not answer at http://localhost:${port}/mcp; is ${serviceName(plannedManager(plan.services), ENGINE_UNIT)} running?`)];
  }
  const checks: CheckResult[] = [];
  let call: EngineCall;
  try {
    call = await deps.engine();
  } catch (error) {
    return [check('engine', 'fail', 'Engine', `answers, but the installer could not call it: ${message(error)}`)];
  }
  checks.push(check('engine', 'pass', 'Engine', `answers authenticated calls at http://localhost:${port}/mcp`));

  checks.push(await attempt('notes', 'Notes indexed', () => notesCheck(deps, call, plan)));
  checks.push(await attempt('types', 'Types', () => typesCheck(call, plan)));
  checks.push(await attempt('search', 'Search', () => searchCheck(call)));
  checks.push(await attempt('doctor', 'Database', () => doctorCheck(call)));
  const settings = await attempt('settings', 'Settings', async () => call<SettingsPayload>('get-settings'));
  if ('status' in settings) {
    checks.push(settings);
  } else {
    checks.push(settingsIssuesCheck(settings));
    checks.push(modelsCheck(settings, plan, await curatorKeys(deps.host, plan)));
  }
  if (plan.curator) checks.push(await attempt('curator', 'Curator', () => curatorCheck(deps, plan)));
  return checks;
}

/**
 * Stage 12. Verify and record the results; the stage completes only when nothing failed,
 * so a rerun checks again. Returns whether nothing failed.
 */
export async function runVerifyStage(
  deps: VerifyDeps & { prompter: Prompter; now: () => Date },
  state: InstallState,
  path: string,
): Promise<boolean> {
  if (state.stages.verify?.completed_at) return true;
  const spinner = deps.prompter.spinner('Verifying the installation (free, read-only checks)…');
  const checks = await verifyInstall(deps, state.plan);
  const failed = checks.filter(entry => entry.status === 'fail').length;
  spinner.stop(failed > 0 ? `${count(failed, 'check')} failed.` : 'Verified.');
  deps.prompter.note(renderChecks(checks), 'Verification');
  state.stages.verify = { checked_at: deps.now().toISOString(), completed_at: failed > 0 ? null : deps.now().toISOString(), checks };
  await saveState(path, state);
  return failed === 0;
}

/** Every Markdown file in scope is indexed. The vault may change meanwhile, so a gap warns. */
async function notesCheck(deps: VerifyDeps, call: EngineCall, plan: InstallState['plan']): Promise<CheckResult> {
  const vault = plan.vault;
  if (!vault) return check('notes', 'warn', 'Notes indexed', 'the plan has no vault');
  const [discovery, notes] = await Promise.all([
    deps.analyzer.discover(vault.path, vault.analyzer_exclusions),
    indexedNotes(call, vault.analyzer_exclusions),
  ]);
  const files = discovery.inventory.markdown_files;
  if (notes.length === files) return check('notes', 'pass', 'Notes indexed', `all ${count(files, 'Markdown file')} in scope`);
  return check('notes', 'warn', 'Notes indexed', `Engine has ${count(notes.length, 'note')} in scope; the folder has ${count(files, 'Markdown file')}. Engine may still be catching up with recent changes; check again with \`${installerCommand(deps.host, 'status', plan.data_dir)}\`.`);
}

async function typesCheck(call: EngineCall, plan: InstallState['plan']): Promise<CheckResult> {
  const planned = plan.structure?.types.map(type => type.name) ?? [];
  const existing = new Set((await call<Array<{ name: string; has_schema?: boolean }>>('list-schemas'))
    .filter(schema => schema.has_schema !== false).map(schema => schema.name));
  const missing = planned.filter(name => !existing.has(name));
  return missing.length > 0
    ? check('types', 'fail', 'Types', `Engine lacks ${missing.join(', ')}`)
    : check('types', 'pass', 'Types', `all ${count(planned.length, 'planned type')} exist`);
}

async function searchCheck(call: EngineCall): Promise<CheckResult> {
  const index = (await call<VaultStats>('vault-stats')).search_index;
  if (!index) return check('search', 'warn', 'Search', 'Engine reports no search index');
  if (index.status === 'disabled') return check('search', 'warn', 'Search', 'semantic search is off: the local search model is not loaded; text search works');
  const progress = `${index.nodes_indexed} of ${count(index.nodes_total, 'note')} embedded`;
  if (index.terminal_failures > 0) return check('search', 'warn', 'Search', `${progress}; ${count(index.terminal_failures, 'item')} could not be embedded`);
  return index.status === 'indexing'
    ? check('search', 'warn', 'Search', `still embedding: ${progress}, ${index.pending} queued. It finishes in the background.`)
    : check('search', 'pass', 'Search', progress);
}

async function doctorCheck(call: EngineCall): Promise<CheckResult> {
  const { integrity } = await call<{ integrity: { ok: boolean; messages: string[] } }>('vault-doctor');
  return integrity.ok
    ? check('doctor', 'pass', 'Database', 'the integrity check passed')
    : check('doctor', 'fail', 'Database', `the integrity check failed: ${integrity.messages.slice(0, 3).join('; ')}`);
}

function settingsIssuesCheck(settings: SettingsPayload): CheckResult {
  const issues = Object.entries(settings.domains)
    .flatMap(([domain, payload]) => (payload.issues ?? []).map(issue => `${domain}.${issue.key}: ${issue.message}`));
  return issues.length > 0
    ? check('settings', 'warn', 'Settings', issues.slice(0, 5).join('; '))
    : check('settings', 'pass', 'Settings', 'no domain reports an issue');
}

/** The key variables in curator.env, which Curator reads when it starts. */
async function curatorKeys(host: Host, plan: InstallState['plan']): Promise<Set<string>> {
  if (!plan.curator) return new Set();
  const text = await host.readText(curatorEnvPath(plan.data_dir));
  return new Set(text === null ? [] : [...parseEnvFile(text)].filter(([, value]) => value.trim() !== '').map(([name]) => name));
}

/**
 * Each model setting in use names an enabled, priced catalog model whose provider has a
 * key; a role whose feature is off is listed as off, not failed. The key is the one the
 * role's caller uses: Engine reports its own; Curator's are in curator.env; chat runs in
 * its client with the user's own key, so the plan's keys stand for it.
 */
function modelsCheck(settings: SettingsPayload, plan: InstallState['plan'], curatorEnv: ReadonlySet<string>): CheckResult {
  const catalog = settings.domains.models?.catalog ?? [];
  const engineKeys = settings.domains.models?.providers ?? {};
  const planned = new Set<string>(plan.providers.map(entry => entry.provider));
  const hasKey = (domain: string, provider: string): boolean => {
    if (domain === 'engine') return engineKeys[provider] === true;
    if (domain === 'curator') {
      const name = PROVIDERS.find(info => info.id === provider)?.curatorEnv;
      return name !== null && name !== undefined && curatorEnv.has(name);
    }
    return planned.has(provider);
  };
  const problems: string[] = [];
  const off: string[] = [];
  let inUse = 0;
  for (const role of plan.models.roles) {
    if (role.off !== null) {
      off.push(role.setting);
      continue;
    }
    if (role.model === null) continue;
    inUse++;
    const [domain, key] = role.setting.split('.') as [string, string];
    const effective = settings.domains[domain]?.effective?.[key];
    const entry = catalog.find(candidate => candidate.title === role.model);
    if (effective !== `[[${role.model}]]`) problems.push(`${role.setting} is ${JSON.stringify(effective ?? null)}, not [[${role.model}]]`);
    else if (!entry || !entry.enabled) problems.push(`${role.setting}: ${role.model} is not an enabled catalog model`);
    else if (!entry.pricing && !pricingForExact(entry.model)) problems.push(`${role.setting}: ${role.model} has no price`);
    else if (!hasKey(domain, entry.provider)) problems.push(`${role.setting}: no ${entry.provider} key${domain === 'chat' ? '' : ` for ${domain === 'engine' ? 'Engine' : 'Curator'}`}`);
  }
  if (problems.length > 0) return check('models', 'fail', 'Models', problems.join('; '));
  return check('models', 'pass', 'Models', [
    `${count(inUse, 'model setting')} ${inUse === 1 ? 'resolves' : 'resolve'} to enabled, priced models with keys`,
    ...(off.length > 0 ? [`off: ${off.join(', ')}`] : []),
  ].join('; '));
}

async function curatorCheck(deps: VerifyDeps, plan: InstallState['plan']): Promise<CheckResult> {
  const curator = plan.curator as NonNullable<InstallState['plan']['curator']>;
  const port = plan.services.curator_port;
  if (await deps.host.httpStatus(`http://127.0.0.1:${port}/mcp`, {}, 5000) !== 200) {
    return check('curator', 'fail', 'Curator', `does not answer at http://localhost:${port}/mcp; is ${serviceName(plannedManager(plan.services), CURATOR_UNIT)} running?`);
  }
  const status = await readCuratorStatus(deps, plan);
  const cap = status.daily_budget.cap_usd === null ? null : Math.round(status.daily_budget.cap_usd * 100);
  if (cap !== curator.daily_budget_cents || status.server.wiki_reconciliation_mode !== curator.wiki_mode) {
    return check('curator', 'fail', 'Curator', `does not read the approved settings (cap ${cap === null ? 'none' : dollars(cap)}, wiki mode ${status.server.wiki_reconciliation_mode}); it may not reach Engine`);
  }
  return status.server.next_sweep_at === null
    ? check('curator', 'warn', 'Curator', 'answers and reads its settings, but reports no next sweep; check sweepAt and tz in its settings')
    : check('curator', 'pass', 'Curator', `next sweep ${status.server.next_sweep_at}; daily cap ${dollars(cap as number)}; wiki mode ${status.server.wiki_reconciliation_mode}`);
}

async function attempt<T extends CheckResult | object>(id: string, title: string, run: () => Promise<T>): Promise<T | CheckResult> {
  try {
    return await run();
  } catch (error) {
    return check(id, 'fail', title, `could not be checked: ${message(error)}`);
  }
}

function check(id: string, status: CheckStatus, title: string, detail: string): CheckResult {
  return { id, status, title, detail };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
