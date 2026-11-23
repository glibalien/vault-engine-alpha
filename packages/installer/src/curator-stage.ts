import { join } from 'node:path';
import { curatorClient, EngineToolError, type EngineCall } from './engine-client.js';
import { waitUntilAnswering, type EngineStageDeps } from './engine-stage.js';
import type { Host } from './host.js';
import type { Prompter } from './prompter.js';
import { dollars } from './review.js';
import type { Secret } from './secret.js';
import { ServiceError, type ServiceBackend } from './services.js';
import { saveState, type InstallState } from './state.js';
import { INSTALLER_CURATOR_TOKEN, mintCuratorToken } from './tokens.js';
import { CURATOR_UNIT } from './units.js';

export interface CuratorStageDeps extends Pick<EngineStageDeps, 'readyTimeoutMs' | 'pollMs'> {
  host: Host;
  prompter: Prompter;
  backend: ServiceBackend;
  now: () => Date;
  /** Test seam; production connects over MCP. */
  connectCurator?: (url: string, token: Secret) => EngineCall;
}

/** The parts of `curator-status` the installer checks. */
export interface CuratorStatus {
  daily_budget: { cap_usd: number | null };
  server: { next_sweep_at: string | null; wiki_reconciliation_mode: string };
}

/**
 * Stage 11. Start Curator with every approved setting already in Engine, then confirm it
 * reaches Engine and reads them. `curator-cost-report` asks Engine for Curator's usage
 * with Curator's own token, so it fails when Curator cannot reach Engine; `curator-status`
 * shows the settings, which Curator would otherwise fall back to defaults for. The
 * read-only token used for both lasts a day and is never saved.
 */
export async function runCuratorStage(deps: CuratorStageDeps, state: InstallState, path: string): Promise<void> {
  if (state.stages.curator?.completed_at) return;
  const { prompter } = deps;
  const plan = state.plan;
  const curator = plan.curator;
  const started = deps.now().toISOString();
  if (!curator) {
    state.stages.curator = { started_at: started, completed_at: started };
    await saveState(path, state);
    return;
  }
  state.stages.curator ??= { started_at: started, completed_at: null };
  await saveState(path, state);

  const port = plan.services.curator_port;
  await deps.backend.start(CURATOR_UNIT);
  await waitUntilAnswering(deps, port, { unit: CURATOR_UNIT, name: 'Curator', first: 'it connects to Engine first' });

  const status = await readCuratorStatus(deps, plan);

  const capCents = status.daily_budget.cap_usd === null ? null : Math.round(status.daily_budget.cap_usd * 100);
  const mismatched = [
    ...(status.server.wiki_reconciliation_mode !== curator.wiki_mode
      ? [`wiki mode ${status.server.wiki_reconciliation_mode} (planned ${curator.wiki_mode})`]
      : []),
    ...(capCents !== curator.daily_budget_cents
      ? [`daily cap ${capCents === null ? 'none' : dollars(capCents)} (planned ${curator.daily_budget_cents === null ? 'none' : dollars(curator.daily_budget_cents)})`]
      : []),
  ];
  if (mismatched.length > 0) {
    throw new ServiceError([
      `Curator reaches Engine but does not read the approved settings: ${mismatched.join('; ')}.`,
      `Check Curator's settings with Engine's get-settings and its log (${deps.backend.logCommand(CURATOR_UNIT)}), then run the install again.`,
    ].join('\n'));
  }

  prompter.note([
    `Answering at http://localhost:${port}/mcp`,
    `Daily cap: ${capCents === null ? 'none' : dollars(capCents)}; wiki mode: ${status.server.wiki_reconciliation_mode}.`,
    `Next sweep: ${status.server.next_sweep_at ?? 'not scheduled'}. It keeps the wikis you create current; there are none yet.`,
  ].join('\n'), 'Curator');
  state.stages.curator = { ...state.stages.curator, completed_at: deps.now().toISOString() };
  await saveState(path, state);
}

/**
 * `curator-status`, once `curator-cost-report` shows that Curator reaches Engine (it asks
 * Engine with Curator's own token). The read-only token is minted for this and never saved.
 */
export async function readCuratorStatus(
  deps: Pick<CuratorStageDeps, 'host' | 'connectCurator'>,
  plan: InstallState['plan'],
): Promise<CuratorStatus> {
  const { host } = deps;
  const token = await mintCuratorToken({
    host,
    nodePath: plan.services.node_path,
    repoRoot: plan.repo_root,
    dbPath: join(plan.data_dir, 'curator.db'),
    token: INSTALLER_CURATOR_TOKEN,
  });
  const connect = deps.connectCurator ?? curatorClient;
  const curatorCall = connect(`http://127.0.0.1:${plan.services.curator_port}/mcp`, token);
  try {
    await curatorCall('curator-cost-report');
  } catch (error) {
    if (!(error instanceof EngineToolError)) throw error;
    throw new ServiceError([
      `Curator is running but cannot reach Engine (${error.message}).`,
      `Check ENGINE_URL and ENGINE_TOKEN in ${join(plan.data_dir, 'curator.env')} and Curator's log, then run the install again.`,
    ].join('\n'));
  }
  return curatorCall<CuratorStatus>('curator-status');
}
