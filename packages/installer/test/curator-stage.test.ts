import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCuratorStage } from '../src/curator-stage.js';
import { EngineToolError, type EngineCall } from '../src/engine-client.js';
import { createScriptedPrompter } from '../src/prompter.js';
import type { Secret } from '../src/secret.js';
import { ServiceError, type ServiceBackend } from '../src/services.js';
import { loadState, saveState, type InstallState } from '../src/state.js';
import { makeTree, realFilesystemHost, removeTrees } from './helpers.js';

afterEach(removeTrees);

const CURATOR = { daily_budget_cents: 250, sweep_at: '05:00', tz: 'UTC', wiki_mode: 'live' };

async function setup(curator: typeof CURATOR | null = CURATOR) {
  const dataDir = await makeTree({});
  await mkdir(join(dataDir, 'installer'), { recursive: true });
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
      vault: { path: '/notes', settings_dir: 'Settings', exclusions: [], analyzer_exclusions: [], inventory: { non_markdown_by_extension: {} } },
      structure: null,
      models: { preset: 'balanced', vision_provider: 'off', roles: [], models: [] },
      curator,
      backup: { mode: 'skip', files: 0, bytes: 0 },
      review: {
        engine_database: '/notes/.vault-engine/vault.db',
        env_keys: { engine_first_boot: [], engine_after_extraction_off: [], curator: [] },
        extraction_seeded_off: false,
        engine_models_dir: null,
        settings: [],
      },
    },
    stages: {},
  } as unknown as InstallState;
  const path = join(dataDir, 'installer', 'state.json');
  await saveState(path, state);
  return { state, path, dataDir };
}

function deps(
  status: unknown = { daily_budget: { cap_usd: 2.5 }, server: { next_sweep_at: '2026-10-27T05:00:00.000Z', wiki_reconciliation_mode: 'live' } },
  reachesEngine = true,
) {
  const starts: string[] = [];
  const runs: string[][] = [];
  const tokens: string[] = [];
  const lines: string[] = [];
  const backend: ServiceBackend = {
    start: async unit => { starts.push(unit); },
    restart: async () => {},
    health: async () => ({ stopped: false, restarts: 0, detail: 'running' }),
    startedAt: async () => new Date(0),
    recentLogs: async () => '',
    logCommand: unit => `journalctl -u ${unit}`,
  };
  const host = realFilesystemHost({
    run: async (_command, args) => {
      runs.push(args);
      return { code: 0, stdout: `  Authorization: Bearer ${'c'.repeat(64)}\n`, stderr: '' };
    },
  });
  const tools: string[] = [];
  const connectCurator = (_url: string, token: Secret) => {
    tokens.push(token.reveal());
    return (async (tool: string) => {
      tools.push(tool);
      if (tool === 'curator-cost-report') {
        if (!reachesEngine) throw new EngineToolError('TOOL_ERROR', 'curator-cost-report failed: Engine usage reporting is unavailable');
        return { ok: true, data: { totals: {} } };
      }
      return status;
    }) as unknown as EngineCall;
  };
  return {
    deps: {
      host,
      prompter: createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, line => lines.push(line)),
      backend,
      now: () => new Date('2026-10-26T14:00:00Z'),
      connectCurator,
      pollMs: 1,
    },
    starts, runs, tokens, lines, tools,
  };
}

describe('runCuratorStage', () => {
  it('starts Curator, then confirms with a read-only token that it reads the approved settings', async () => {
    const { state, path } = await setup();
    const { deps: stageDeps, starts, runs, tokens, lines, tools } = deps();

    await runCuratorStage(stageDeps, state, path);

    expect(starts).toEqual(['vault-curator.service']);
    expect(tools).toEqual(['curator-cost-report', 'curator-status']);
    // Curator's own script, against its database, minted after Curator started.
    expect(runs).toEqual([['--import', 'tsx', '/repo/packages/curator/scripts/issue-service-token.ts', '--name', 'installer', '--ttl-days', '1', '--scope', 'curate:read']]);
    expect(tokens).toEqual(['c'.repeat(64)]);
    expect(lines.join('\n')).toContain('Daily cap: $2.50; wiki mode: live.');
    expect(lines.join('\n')).toContain('Next sweep: 2026-10-27T05:00:00.000Z.');
    const saved = await loadState(path);
    expect(saved?.stages.curator).toEqual({ started_at: '2026-10-26T14:00:00.000Z', completed_at: '2026-10-26T14:00:00.000Z' });
    // The token was used, never saved.
    expect(JSON.stringify(saved)).not.toContain('c'.repeat(64));
  });

  it('stops when Curator cannot reach Engine, even when its fallback settings match the plan', async () => {
    // The registry defaults, which Curator falls back to when it cannot read Engine's.
    const { state, path } = await setup({ ...CURATOR, daily_budget_cents: 100, wiki_mode: 'off' });
    const { deps: stageDeps } = deps({ daily_budget: { cap_usd: 1 }, server: { next_sweep_at: null, wiki_reconciliation_mode: 'off' } }, false);

    await expect(runCuratorStage(stageDeps, state, path)).rejects.toThrow(
      'Curator is running but cannot reach Engine (curator-cost-report failed: Engine usage reporting is unavailable).',
    );
    expect(state.stages.curator?.completed_at).toBeNull();
  });

  it('stops when Curator does not read the approved settings', async () => {
    const { state, path } = await setup();
    const { deps: stageDeps } = deps({ daily_budget: { cap_usd: 1 }, server: { next_sweep_at: null, wiki_reconciliation_mode: 'off' } });

    const run = runCuratorStage(stageDeps, state, path);

    await expect(run).rejects.toThrow(ServiceError);
    await expect(runCuratorStage(stageDeps, state, path)).rejects.toThrow(
      'Curator reaches Engine but does not read the approved settings: wiki mode off (planned live); daily cap $1.00 (planned $2.50).',
    );
    expect(state.stages.curator?.completed_at).toBeNull();
  });

  it('completes at once without starting anything when the plan installs no Curator', async () => {
    const { state, path } = await setup(null);
    const { deps: stageDeps, starts, runs } = deps();

    await runCuratorStage(stageDeps, state, path);
    await runCuratorStage(stageDeps, state, path);

    expect(starts).toEqual([]);
    expect(runs).toEqual([]);
    expect(state.stages.curator?.completed_at).toBe('2026-10-26T14:00:00.000Z');
  });
});
