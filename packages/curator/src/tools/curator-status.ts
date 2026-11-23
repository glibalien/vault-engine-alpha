import { readEvidenceDiagnostics } from '../topic-evidence-diagnostics.js';
import { z } from 'zod';
import { withScope, type ToolHandler } from '../auth/with-scope.js';
import type { CoreDeps } from '../core.js';
import { recentRuns, perProjectLatest, aggregateUsage, lastSweepAt, latestProjectRuns, runTopology } from '../db/runs.js';
import { projectBuildKey } from '../background-builds.js';
import { resolveWikiModel } from '../wiki-output-policy.js';
import { requestCounts } from '../db/requests.js';
import { isPaused, pausedWikis, allActiveCorrections } from '../db/control.js';
import { getWikiRoot, projectWikiRoots, topicWikiRoots } from '../db/wiki-roots.js';
import { computeNextRun } from '../scheduler.js';
import { activeOnDemandRun, listOnDemandRuns } from '../db/on-demand-runs.js';
import { releaseAbandonedRuns } from '../on-demand/run.js';
import { viewOnDemandRun } from '../on-demand/views.js';
import { isStale } from '../staleness.js';
import {
  explicitTopicRefreshSources,
  observedTopicRefreshSources,
  topicRefreshState,
  type TopicRefreshSourceRow,
} from '../db/topic-refresh.js';
import type { TopicWebMaterialityAssessment } from '../topic-refresh-assessment.js';

/** Raw zod shape for registerTool. */
export const curatorStatusInput = {
  limit: z.number().int().positive().max(200).default(20).describe('How many recent runs to return'),
  window_hours: z.number().int().positive().max(8760).default(168).describe('Aggregate tokens/cost over the last N hours'),
  topology_run_id: z.number().int().positive().optional()
    .describe('Also return this run\'s topology as run_topology. recent_runs leaves topology out because it is large; has_topology says which runs have one.'),
  project: z.string().min(1).optional()
    .describe('Return only this wiki\'s status: whether it is registered as a project or topic wiki (kind, root_node_id, and a topic\'s source), whether a build is queued or running, its latest run, its last written build, its models, whether it is paused, and today\'s budget. Use this to follow a rebuild.'),
};

type Args = { limit: number; window_hours: number; topology_run_id?: number | undefined; project?: string | undefined };

/**
 * Build the curate:read-guarded status handler. Reads run history + live queue
 * state from the shared deps. `stale` is an age-only signal (status passed null,
 * so the backlog skip-list isn't applied here — the sweep still owns the actual
 * auto-backlog decision). A present `db` implies migrations have been applied —
 * server boot runs `runMigrations` before building deps — so `requestCounts` and
 * `recentRuns` may query their tables without a prior existence check.
 */
/** Today's cap, spend and remaining allowance in USD; spend is unknown when no cap is set. */
async function dailyBudgetStatus(deps: CoreDeps): Promise<Record<string, number | boolean | null>> {
  const cents = deps.config.dailyBudgetCents ?? null;
  const capUsd = cents === null ? null : cents / 100;
  if (capUsd === null || !deps.budget) return { cap_usd: capUsd, spent_usd: null, remaining_usd: null };
  try {
    const remaining = await deps.budget.remainingUsd();
    if (remaining === null) return { cap_usd: capUsd, spent_usd: null, remaining_usd: null };
    const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
    return { cap_usd: capUsd, spent_usd: round(capUsd - remaining), remaining_usd: round(Math.max(remaining, 0)) };
  } catch {
    return { cap_usd: capUsd, spent_usd: null, remaining_usd: null, unavailable: true };
  }
}

/** The wiki-stage providers' own key limits (#342): limit, what remains, reset, any stop. Best-effort. */
async function providerLimitsStatus(deps: CoreDeps): Promise<Array<Record<string, string | number | null>>> {
  try {
    return await deps.budget?.providerLimits?.() ?? [];
  } catch {
    return [];
  }
}

/** One wiki's status, small enough to poll while a rebuild runs. `kind` is how the wiki is registered under
 *  this title: a topic wiki (with its `source`) or a project wiki, or null when no wiki is registered under it. */
async function wikiStatus(deps: CoreDeps, db: import('better-sqlite3').Database, project: string) {
  const { latest, written } = latestProjectRuns(db, project);
  const build = deps.builds?.get(projectBuildKey(project));
  const root = getWikiRoot(db, project);
  const kind = root?.kind === 'topic' || root?.kind === 'project' ? root.kind : null;
  return {
    project,
    kind,
    root_node_id: kind === null ? null : root?.root_node_id ?? null,
    source: kind === 'topic' ? (root?.source === 'vault+web' ? 'vault+web' : 'vault') : null,
    in_progress: build ? { since: build.since } : null,
    queue: deps.queue.state,
    paused: isPaused(db, project),
    models: {
      planning: resolveWikiModel(deps.config, 'planning'),
      page: resolveWikiModel(deps.config, 'page'),
      home: resolveWikiModel(deps.config, 'home'),
    },
    latest_run: latest,
    last_written: written,
    daily_budget: await dailyBudgetStatus(deps),
  };
}

export function makeCuratorStatusHandler(deps: CoreDeps, startedAt: Date): ToolHandler<Args> {
  return withScope<Args>('curate:read', async (args) => {
    const { db, config, queue } = deps;
    if (!db) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NO_DB', message: 'run history not available' } }) }],
      };
    }
    if (args.project !== undefined) {
      return { content: [{ type: 'text', text: JSON.stringify(await wikiStatus(deps, db, args.project)) }] };
    }
    const now = new Date();
    const sinceTs = new Date(now.getTime() - args.window_hours * 3_600_000).toISOString();
    const projects = perProjectLatest(db).map((r) => ({
      project: r.project,
      last_run_at: r.ts,
      last_outcome: r.outcome,
      wiki_curated_at: r.wiki_curated_at,
      stale: isStale(r.wiki_curated_at, null, config, now),
    }));
    let nextSweepAt: string | null = null;
    try {
      nextSweepAt = computeNextRun(now, config.curatorSweepAt, config.curatorTz).toISOString();
    } catch {
      nextSweepAt = null;
    }
    const last = lastSweepAt(db);
    const payload = {
      daily_budget: await dailyBudgetStatus(deps),
      provider_key_limits: await providerLimitsStatus(deps),
      recent_runs: recentRuns(db, args.limit).map(row => ({
        ...row,
        has_topology: row.topology_json !== null,
        evidence_selection: readEvidenceDiagnostics(row.refresh_evidence_json),
        topology_json: undefined,
        refresh_evidence_json: undefined,
        output_policy_hash: undefined,
      })),
      ...(args.topology_run_id === undefined ? {} : { run_topology: runTopologyView(db, args.topology_run_id) }),
      queue: queue.state,
      projects,
      aggregate: { window_hours: args.window_hours, ...aggregateUsage(db, sinceTs) },
      requests: requestCounts(db),
      control: {
        paused: pausedWikis(db).map(r => ({ project: r.project_title, paused_at: r.paused_at, paused_by: r.paused_by })),
        corrections: allActiveCorrections(db).map(c => ({ project: c.project_title, id: c.id, note: c.note, created_at: c.created_at })),
      },
      project_wikis: (() => {
        const lastCuratedByTitle = new Map(projects.map(p => [p.project, p.wiki_curated_at]));
        return projectWikiRoots(db).map(r => ({
          project: r.root_title, root_node_id: r.root_node_id, created_at: r.created_at, created_by: r.created_by,
          last_curated_at: lastCuratedByTitle.get(r.root_title) ?? null,
        }));
      })(),
      topics: (() => {
        const lastCuratedByTitle = new Map(projects.map(p => [p.project, p.wiki_curated_at]));
        return topicWikiRoots(db).map(r => ({
          topic: r.root_title,
          root_node_id: r.root_node_id,
          source: r.source,
          cadence: r.cadence,
          brief: r.brief,
          last_curated_at: lastCuratedByTitle.get(r.root_title) ?? null,
          early_refresh: topicEarlyRefreshStatus(db, r.root_title, config.topicEarlyRefreshEnabled === true),
        }));
      })(),
      // The on-demand run in progress (field filling or typing), else the latest one (#644).
      on_demand_run: latestOnDemandRun(db),
      server: {
        started_at: startedAt.toISOString(),
        uptime_seconds: Math.floor((now.getTime() - startedAt.getTime()) / 1000),
        next_sweep_at: nextSweepAt,
        last_sweep_at: last ? last.toISOString() : null,
        wiki_reconciliation_mode: config.wikiReconciliationMode,
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  });
}

/** The run in progress, else the most recent; null when there has been none. Never fails status. */
function latestOnDemandRun(db: import('better-sqlite3').Database | undefined) {
  if (!db) return null;
  try {
    releaseAbandonedRuns(db);
    const run = activeOnDemandRun(db) ?? listOnDemandRuns(db, 1)[0];
    return run === undefined ? null : viewOnDemandRun(db, run);
  } catch {
    return null;
  }
}

function topicEarlyRefreshStatus(db: import('better-sqlite3').Database, rootTitle: string, enabled: boolean) {
  const state = topicRefreshState(db, rootTitle);
  const vaultBaselineReady = state?.source_committed_at !== null && state?.source_committed_at !== undefined;
  const explicitSources = explicitTopicRefreshSources(db, rootTitle).slice(0, 20).map(row => ({
    node_id: row.node_id,
    title_at_commit: explicitTitle(row, vaultBaselineReady),
    state: explicitState(row, vaultBaselineReady),
  }));
  const webBaselineReady = state !== undefined
    && state.committed_web_hash !== null
    && state.committed_web_snapshot_json !== null
    && state.web_committed_at !== null;
  return {
    enabled,
    vault_baseline_ready: vaultBaselineReady,
    web_baseline_ready: webBaselineReady,
    pending_source_change: state?.pending_source_change === 1,
    explicit_sources: explicitSources,
    observed_source_count: observedTopicRefreshSources(db, rootTitle).length,
    source_committed_at: state?.source_committed_at ?? null,
    web_committed_at: state?.web_committed_at ?? null,
    last_probe_at: state?.last_probe_assessed_at ?? null,
    last_probe_verdict: closedProbeVerdict(state?.last_probe_verdict),
  };
}

function explicitState(
  row: TopicRefreshSourceRow,
  baselineReady: boolean,
): 'present' | 'missing' | 'unavailable' {
  if (!baselineReady) return 'unavailable';
  switch (row.evidence_state) {
    case 'present': return 'present';
    case 'missing': return 'missing';
    case null: return 'unavailable';
    default: {
      const exhaustive: never = row.evidence_state;
      return exhaustive;
    }
  }
}

function explicitTitle(row: TopicRefreshSourceRow, baselineReady: boolean): string | null {
  return baselineReady && row.evidence_state === 'present' ? row.title_at_commit : null;
}

function closedProbeVerdict(value: unknown): TopicWebMaterialityAssessment['verdict'] | null {
  switch (value) {
    case 'material': case 'immaterial': case 'uncertain': return value;
    default: return null;
  }
}

/** The run's topology, or null when there is no such run. */
function runTopologyView(db: import('better-sqlite3').Database, id: number) {
  const row = runTopology(db, id);
  return row === undefined ? null
    : { run_id: row.id, project: row.project, ts: row.ts, topology: parseTopology(row.topology_json) };
}

function parseTopology(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
