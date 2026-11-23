import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { CurateResult, ProjectRef } from '../src/types.js';
import type { RequestedPageOutcome } from '../src/curate.js';
import { isStale } from '../src/staleness.js'; // ensure the module resolves alongside core
import { EngineError } from '../src/engine.js';

vi.mock('../src/topic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/topic.js')>();
  return {
    ...actual,
    curateTopic: vi.fn(async (
      _e: unknown,
      _l: unknown,
      _c: unknown,
      root: { title: string },
      _spec: unknown,
      opts: { dryRun: boolean },
    ) => ({ project: root.title, outcome: 'written', dryRun: opts.dryRun })),
    topicRefreshCommitMaterial: vi.fn((result: { __refreshCommitMaterial?: unknown }) => (
      result.__refreshCommitMaterial
    )),
  };
});

vi.mock('../src/memory-sweep.js', () => ({ runMemorySweep: vi.fn(async () => undefined) }));
vi.mock('../src/conversation-sweep.js', () => ({ runConversationSweep: vi.fn(async () => undefined) }));
vi.mock('../src/org-sweep.js', () => ({ runOrgSweep: vi.fn(async () => undefined) }));
vi.mock('../src/reconcile.js', () => ({ runReconcile: vi.fn(async () => undefined) }));
vi.mock('../src/memory-note-refresh.js', () => ({
  runMemoryNoteRefresh: vi.fn(async () => ({ ran: false, file_written: false, live_count: 0, historical_count: 0, total: 0, issues_rendered: 0, error: null })),
}));

vi.mock('../src/curate.js', () => ({
  curateProject: vi.fn(
    async (_e, _a, _c, project: ProjectRef, dryRun: boolean): Promise<CurateResult> => ({
      project: project.title,
      outcome: 'written',
      dryRun,
    }),
  ),
  curateRequestedPage: vi.fn(
    async (_e, _a, _c, project: ProjectRef, req: { title: string }): Promise<RequestedPageOutcome> => ({
      project: project.title,
      requestedTitle: req.title,
      qualifiedTitle: `${project.title} — ${req.title}`,
      outcome: 'written',
      nodeId: 'pg1',
      resolvedTo: { nodeId: 'pg1', title: `${project.title} — ${req.title}`, action: 'created' },
      dryRun: false,
      usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 },
      costUsd: 0.001,
    }),
  ),
}));

import { curateProject, curateRequestedPage } from '../src/curate.js';
import { curateTopic } from '../src/topic.js';
import { runMemorySweep } from '../src/memory-sweep.js';
import { runConversationSweep } from '../src/conversation-sweep.js';
import { runOrgSweep } from '../src/org-sweep.js';
import { runReconcile } from '../src/reconcile.js';
import { runSweep, curateOne, curateTopicTimed, requestWikiPage, triggerCuration, createProjectWiki, createOrUpdateWiki, removeWiki, startOnDemandCuration } from '../src/core.js';
import { BackgroundBuilds } from '../src/background-builds.js';
import { resolveWikiOutputPolicy, wikiOutputPolicyHash } from '../src/wiki-output-policy.js';
import type { LlmClient } from '../src/llm/types.js';
import { CurationQueue } from '../src/queue.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { curateResultToRunRow, lastSweepAt, recentRuns, recordRun } from '../src/db/runs.js';
import { readEvidenceManifest, writeEvidenceManifest } from '../src/db/evidence-manifests.js';
import { readDeferredCreates, recordDeferredCreates } from '../src/db/deferred-creates.js';
import { insertPageRequest, pendingRequests, pinnedPageTitles, markRequestFulfilled } from '../src/db/requests.js';
import { setPaused, addCorrection, isPaused, activeCorrections } from '../src/db/control.js';
import { makeSetWikiPausedHandler } from '../src/tools/wiki-control.js';
import { writeStagePlanning } from '../src/db/stage-checkpoints.js';
import type { PlanningResult } from '../src/reconciliation-planning.js';
import { deleteWikiRoot, getWikiRoot, projectWikiRoots, registerWikiRoot } from '../src/db/wiki-roots.js';
import {
  commitTopicRefreshBaseline,
  observedTopicRefreshSources,
  replaceExplicitTopicRefreshSources,
  storeTopicProbeCache,
  topicRefreshState,
  type TopicCommittedSourceProjection,
} from '../src/db/topic-refresh.js';
import {
  buildCanonicalWebProbe,
  topicVaultSourceFingerprint,
  type CanonicalWebProbe,
} from '../src/topic-refresh-evidence.js';
import type { Config } from '../src/config.js';
import { CAPTURE_COVERAGE_SYSTEM_PROMPT } from '../src/conversation-capture-prompts.js';
import type { CoreDeps } from '../src/core.js';
import { UsageReporter } from '../src/usage-reporter.js';
import { enrolProjects } from './project-wiki-fixtures.js';

const BASE_CONFIG = {
  engineUrl: 'http://localhost:9999',
  engineToken: 'test-token',
  experiment: null,
  variant: null,
  llmKeys: { keys: { anthropic: 'test-key', fireworks: 'test-fireworks-key' }, baseURLs: {} },
  model: 'claude-sonnet-4-6',
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null,
  fieldGuessCap: 25,
  fieldGuessMaxTokens: 2000,
  modelProviders: {
    'claude-sonnet-4-6': 'anthropic',
    'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
  },
  reasoningEffort: undefined,
  projectHomeProvenanceEnabled: false,
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
  wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
  wikiPlanningReasoningBudget: 0, wikiPageReasoningBudget: 0, wikiHomeReasoningBudget: 0,
  homeMaxTokens: 8192,
  activeStatuses: ['open', 'in-progress'],
  meetingReads: 10,
  noteReads: 6,
    topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576,
  bodyCharCap: 4000,
  webSearchResults: 5,
  webFetchTop: 3,
  webFetchCharCap: 4000,
  topicWebCadenceMs: 7 * 24 * 60 * 60 * 1000,
  topicEarlyRefreshEnabled: false,
  topicEarlyRefreshAssessmentModel: null,
  topicEarlyRefreshAssessmentMaxTokens: 2000,
  topicEarlyRefreshAssessmentCap: 5,
  semanticGapFill: false,
  semanticGapFillLimit: 15,
  semanticGapFillBodyReads: 0,
  staleProjectDays: 14,
  staleProjectStatus: 'backlog',
  staleSkipStatuses: ['backlog', 'done', 'dropped'],
  projectStatusField: 'status',
  oauthOwnerPassword: undefined,
  oauthIssuerUrl: undefined,
  curatorPort: 3335,
  curatorDbPath: ':memory:',
  curatorTz: 'UTC',
  curatorSweepAt: '05:00',
  wikiReconciliationMode: 'live',
  memoryWriteEnabled: true,
  memoryWriteCap: 3,
  memorySweepEnabled: false,
  memorySweepTypes: [],
  memorySweepPaths: [],
  memorySweepCap: 10,
  memorySweepNoteCap: 3,
  memorySweepMaxTokens: 4000,
  memorySweepModel: null,
  memorySweepSince: null,
  conversationSweepEnabled: false,
  conversationSweepSettleHours: 6,
  conversationSweepMinUserChars: 300,
  conversationSweepCap: 5,
  conversationSweepPerConversationCap: 2,
  conversationSweepMaxTokens: 4000,
  conversationSweepModel: null,
  conversationSweepSince: null,
  conversationCaptureMode: 'off',
  conversationCaptureSettleHours: 6,
  conversationCaptureInitialLookbackDays: 7,
  conversationCaptureMinAssistantChars: 500,
  conversationCaptureEvaluationCap: 10,
  conversationCaptureArtifactCap: 3,
  conversationCaptureWriteCap: 5,
  conversationCaptureModel: null,
  conversationCapturePlannerMaxTokens: 4000,
  conversationCaptureCoverageModel: null,
  conversationCaptureCoverageMaxTokens: 2000,
  conversationCaptureComposerMaxTokens: 6000,
  reverifyEnabled: true,
  reconcileEnabled: true,
  reconcilePairCap: 10,
  reconcileModel: null,
  orgSweepEnabled: false,
  orgTypePaths: [],
  orgTypeExcludePaths: ['Settings'],
  orgMovePaths: ['/'],
  orgMovePin: ['CLAUDE.md'],
  orgTypeExclude: [],
  orgTypeCap: 25,
  orgMoveCap: 25,
  orgSweepMaxTokens: 4000,
  orgSweepModel: null,
  linkSweepEnabled: false,
  linkSweepMode: 'report',
  linkSweepBacklog: 'fewest-links',
  linkSweepSchedule: 'daily',
  linkSweepQuietMinutes: 30,
  linkSweepTargetTypes: [],
  linkSweepNoteCap: 50,
  journalEnabled: true,
  journalModel: null,
  curatorProjectHomePrompt: '',
  curatorTopicPrompt: '',
  curatorTopicWebPrompt: '',
  curatorRequestedPagePrompt: '',
  curatorRequestedPageWebPrompt: '',
  curatorMemorySweepPrompt: '',
  curatorConversationSweepPrompt: '',
  curatorConversationCapturePlannerPrompt: '',
  curatorConversationCaptureCoveragePrompt: CAPTURE_COVERAGE_SYSTEM_PROMPT,
  curatorConversationCaptureComposerPrompt: '',
  curatorTopologyPrompt: '',
  curatorCreateAdjudicationPrompt: '',
  curatorPagePrompt: '',
} satisfies Config;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...BASE_CONFIG, ...overrides };
}

const REFRESH_TS = '2026-08-29T12:00:00.000Z';

function canonicalProbe(url: string, snippet = url): CanonicalWebProbe {
  const built = buildCanonicalWebProbe([{
    url, title: `Result ${url}`, snippet, published: null,
  }]);
  if (!built.ok) throw new Error('test probe unexpectedly overflowed');
  return built.probe;
}

function committedProjection(
  nodeId: string,
  title = 'Committed source',
  renderedBody = 'committed body',
): TopicCommittedSourceProjection {
  const fingerprint = topicVaultSourceFingerprint({
    nodeId, title, types: ['note'], bodyIncluded: true, renderedBody,
  });
  return {
    nodeId,
    titleAtCommit: title,
    evidenceState: 'present',
    bodyIncluded: 1,
    fingerprintVersion: fingerprint.version,
    evidenceHash: fingerprint.hash,
    capturedAt: REFRESH_TS,
  };
}

function registerWebTopic(db: Database.Database, title: string, cadence = '7d'): void {
  registerWikiRoot(db, {
    root_title: title,
    root_node_id: `root-${title}`,
    kind: 'topic',
    source: 'vault+web',
    cadence,
    brief: `Brief ${title}`,
    created_at: REFRESH_TS,
    created_by: 'tester',
  });
}

function freshWikiEvidence(title: string, curatedAt = new Date().toISOString()) {
  return {
    project: { id: `root-${title}`, title, file_path: '', status: null },
    existing_wiki: {
      home_id: `home-${title}`,
      home: { id: `home-${title}`, version: 1, wiki_curated_at: curatedAt },
      topology_hash: `topology-${title}`,
      catalog_valid: true,
      subpages: [],
    },
  };
}

function deps(active: ProjectRef[]): CoreDeps {
  const engine = { listActiveProjects: vi.fn(async () => active) };
  return {
    engine: engine as never,
    llm: {} as never,
    config: makeConfig({ activeStatuses: ['open'] }),
    queue: new CurationQueue(),
  };
}

beforeEach(() => {
  (curateProject as Mock).mockClear();
  (curateRequestedPage as Mock).mockClear();
  (curateTopic as Mock).mockClear();
  (runMemorySweep as Mock).mockClear();
  (runConversationSweep as Mock).mockClear();
  (runOrgSweep as Mock).mockClear();
  (runReconcile as Mock).mockClear();
});

describe('runSweep', () => {
  it('curates every active project and returns one result each', async () => {
    const active: ProjectRef[] = [
      { id: '1', title: 'A', file_path: '', status: 'open' },
      { id: '2', title: 'B', file_path: '', status: 'open' },
    ];
    const d = deps(active);
    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(curateProject).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.project)).toEqual(['A', 'B']);
  });

  it('honors limit', async () => {
    const active: ProjectRef[] = [
      { id: '1', title: 'A', file_path: '', status: 'open' },
      { id: '2', title: 'B', file_path: '', status: 'open' },
    ];
    const results = await runSweep(deps(active), { dryRun: false, force: false, trigger: 'scheduled', limit: 1 });
    expect(results).toHaveLength(1);
    expect(curateProject).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled wiki reconciliation mode', () => {
  function modeDeps(mode: 'off' | 'dry-run' | 'live') {
    const db = new Database(':memory:');
    runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 'topic-1', kind: 'topic', source: 'vault', cadence: null, brief: 'b', created_at: new Date().toISOString(), created_by: 'tester' });
    const engine = {
      listActiveProjects: vi.fn(async () => [{ id: 'project-1', title: 'Project', file_path: '', status: 'open' }]),
      updateNodeFields: vi.fn(async () => undefined),
      projectEvidence: vi.fn(async () => ({ existing_wiki: { home_id: null, subpages: [] } })),
    };
    const coreDeps: CoreDeps = {
      engine: engine as never,
      llm: {} as never,
      config: makeConfig({
        activeStatuses: ['open'], wikiReconciliationMode: mode,
        staleProjectDays: 14, staleProjectStatus: 'backlog', staleSkipStatuses: [], projectStatusField: 'status',
      }),
      queue: new CurationQueue(),
      db,
    };
    return {
      db,
      engine,
      deps: coreDeps,
    };
  }

  it('off records one visible mode-disabled outcome while non-wiki phases continue', async () => {
    const d = modeDeps('off');
    const onStart = vi.fn();
    const onResult = vi.fn();

    const results = await runSweep(d.deps, { dryRun: false, force: false, trigger: 'scheduled', onStart, onResult });

    expect(results).toEqual([expect.objectContaining({
      project: 'Scheduled wiki reconciliation', outcome: 'skipped_mode_disabled',
      detail: 'mode disabled (off)', dryRun: false,
    })]);
    expect(onStart).toHaveBeenCalledWith(0);
    expect(onResult).toHaveBeenCalledWith(results[0]);
    expect(recentRuns(d.db, 10)).toEqual([expect.objectContaining({
      project: 'Scheduled wiki reconciliation', trigger: 'scheduled', outcome: 'skipped_mode_disabled',
    })]);
    expect(lastSweepAt(d.db)).not.toBeNull();
    expect(d.engine.listActiveProjects).not.toHaveBeenCalled();
    expect(d.engine.updateNodeFields).not.toHaveBeenCalled();
    expect(curateProject).not.toHaveBeenCalled();
    expect(curateTopic).not.toHaveBeenCalled();
    expect(runMemorySweep).toHaveBeenCalledWith(d.deps, { dryRun: false, trigger: 'scheduled' });
    expect(runConversationSweep).toHaveBeenCalledWith(d.deps, { dryRun: false, trigger: 'scheduled' });
    expect(runOrgSweep).toHaveBeenCalledWith(d.deps, { dryRun: false, trigger: 'scheduled' });
    expect(runReconcile).toHaveBeenCalledWith(d.deps, { dryRun: false, trigger: 'scheduled' });
    d.db.close();
  });

  it('dry-run forces scheduled project and topic wiki work to dry-run', async () => {
    const d = modeDeps('dry-run');

    const results = await runSweep(d.deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect((curateProject as Mock).mock.calls[0]![4]).toBe(true);
    expect((curateTopic as Mock).mock.calls[0]![5]).toMatchObject({ dryRun: true, scheduled: true });
    expect(results.every(result => result.dryRun)).toBe(true);
    expect(d.engine.updateNodeFields).not.toHaveBeenCalled();
    expect(runMemorySweep).toHaveBeenCalledWith(d.deps, { dryRun: false, trigger: 'scheduled' });
    d.db.close();
  });

  it('live preserves scheduled live wiki behavior', async () => {
    const d = modeDeps('live');

    await runSweep(d.deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect((curateProject as Mock).mock.calls[0]![4]).toBe(false);
    expect((curateTopic as Mock).mock.calls[0]![5]).toMatchObject({ dryRun: false, scheduled: true });
    d.db.close();
  });
});

describe('wiki status around a project build (#547)', () => {
  function statusDeps(stored = 'behind') {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'Atlas');
    const home = { status: stored };
    const engine = {
      listActiveProjects: vi.fn(async () => [{ id: 'p-1', title: 'Atlas', file_path: '', status: 'open' }]),
      getNode: vi.fn(async (id: string) => ({ id, title: 'Atlas', types: ['project'], fields: {}, body: '' })),
      findNodesByExactTitle: vi.fn(async () => [] as Array<{ id: string; types: string[] }>),
      wikiStatus: vi.fn(async (root: string, status?: string) => {
        const previous = home.status;
        if (status !== undefined) home.status = status;
        return { root_id: root, home_node_id: 'home-1', previous_status: previous, status: home.status, version: 5, written: status !== undefined };
      }),
    };
    const d: CoreDeps = { engine: engine as never, llm: {} as never, queue: new CurationQueue(), db,
      config: makeConfig({ activeStatuses: ['open'] }) };
    return { db, engine, d, home };
  }
  const buildOptions = () => (curateProject as Mock).mock.calls[0]![10] as { buildStatus: { onBuildStart(id: string): Promise<void>; homeStatus: string } };

  it('marks a started build that did not write failed', async () => {
    const { db, engine, d, home } = statusDeps();
    (curateProject as Mock).mockImplementationOnce(async (_e, _a, _c, project: ProjectRef, _dry, _force, _p, _c2, _r, _t, options) => {
      await options.buildStatus.onBuildStart('home-1');
      return { project: project.title, outcome: 'error', detail: 'home synthesis: timeout', dryRun: false };
    });

    await curateOne(d, 'Atlas', { dryRun: false, force: false, trigger: 'on-demand' });

    expect(engine.wikiStatus.mock.calls.map(call => call[1])).toEqual(['building', undefined, 'failed']);
    expect(home.status).toBe('failed');
    db.close();
  });

  it('writes no status for a build that never started', async () => {
    const { db, engine, d } = statusDeps();
    (curateProject as Mock).mockResolvedValueOnce({ project: 'Atlas', outcome: 'skipped_unchanged', dryRun: false });

    await curateOne(d, 'Atlas', { dryRun: false, force: false, trigger: 'on-demand' });

    expect(engine.wikiStatus).not.toHaveBeenCalled();
    db.close();
  });

  it('tells the build\'s home write whether the wiki is paused when it writes', async () => {
    const { db, d } = statusDeps('paused');
    await curateOne(d, 'Atlas', { dryRun: false, force: true, trigger: 'on-demand' });
    const hooks = buildOptions().buildStatus;
    expect(hooks.homeStatus).toBe('current');
    setPaused(db, 'Atlas', true, null, '2026-11-15T00:00:00Z');
    expect(hooks.homeStatus).toBe('paused');
    db.close();
  });
});

describe('project wiki enrollment', () => {
  const projectEvidence = (home: Record<string, unknown> | null) => ({
    project: { id: 'p-1', title: 'Atlas', file_path: 'Projects/Atlas.md', status: 'open' },
    existing_wiki: { home_id: home ? 'home-1' : null, home, subpages: [], topology_hash: 't', catalog_valid: true },
  });
  function enrollmentDeps(home: Record<string, unknown> | null = null, types = ['project']) {
    const db = new Database(':memory:'); runMigrations(db);
    const engine = {
      listActiveProjects: vi.fn(async () => [{ id: 'p-1', title: 'Atlas', file_path: '', status: 'open' }]),
      projectEvidence: vi.fn(async () => projectEvidence(home)),
      getNode: vi.fn(async (id: string) => ({ id, title: 'Atlas', types, fields: {}, body: '' })),
      wikiCreateHome: vi.fn(async () => ({ node_id: 'home-1', created: true })),
      findNodesByExactTitle: vi.fn(async (_title: string, _limit: number) => [] as Array<{ id: string; types: string[] }>),
    };
    const d: CoreDeps = { engine: engine as never, llm: {} as never, queue: new CurationQueue(), db,
      config: makeConfig({ activeStatuses: ['open'] }) };
    return { db, engine, d };
  }

  it('registers the project, writes an empty home and runs the first curation', async () => {
    const { db, engine, d } = enrollmentDeps();
    const res = await createProjectWiki(d, { project: 'Atlas', dryRun: false, by: 'client-1' });
    expect(res).toMatchObject({ ok: true, project: 'Atlas', project_id: 'p-1', created: true, home_created: true,
      first_build: { outcome: 'written' }, detail: 'wiki created and built' });
    expect(engine.wikiCreateHome).toHaveBeenCalledWith('p-1', false);
    expect(curateProject).toHaveBeenCalledTimes(1);
    expect(getWikiRoot(db, 'Atlas')).toMatchObject({ kind: 'project', root_node_id: 'p-1', created_by: 'client-1' });
    db.close();
  });

  it('keeps the empty home and registration when the first build is refused, to build later on request', async () => {
    const { db, d } = enrollmentDeps();
    (curateProject as Mock).mockResolvedValueOnce({ project: 'Atlas', outcome: 'skipped_budget', detail: 'daily budget spent', dryRun: false });
    const res = await createProjectWiki(d, { project: 'Atlas', dryRun: false });
    expect(res).toMatchObject({ ok: true, created: true, home_created: true, first_build: { outcome: 'skipped_budget' } });
    expect(res.ok && res.detail).toMatch(/registered with an empty home; first build skipped_budget .*; build it later with curate-project-wiki and force: true$/);
    // Scheduled sweeps build it only while wikiReconciliationMode is live, so none is promised (#544).
    expect(res.ok && res.detail).not.toMatch(/sweep/);
    expect(getWikiRoot(db, 'Atlas')?.kind).toBe('project');
    db.close();
  });

  it('reports an empty-home write failure without losing the registration', async () => {
    const { db, engine, d } = enrollmentDeps();
    engine.wikiCreateHome.mockRejectedValueOnce(new Error('engine busy'));
    expect(await createProjectWiki(d, { project: 'Atlas', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'HOME_CREATE_FAILED',
        message: expect.stringMatching(/could not be written \(calling create-project-wiki again writes it\): engine busy$/) } });
    expect(getWikiRoot(db, 'Atlas')?.kind).toBe('project');
    expect(curateProject).not.toHaveBeenCalled();
    db.close();
  });

  it('reports a dry run without registering, writing or curating', async () => {
    const { db, engine, d } = enrollmentDeps();
    const res = await createProjectWiki(d, { project: 'Atlas', dryRun: true });
    expect(res).toMatchObject({ ok: true, dry_run: true, created: true, home_created: true, first_build: null });
    expect(res.ok && res.detail).toBe('dry run: would register the wiki, create its home and run its first curation; no writes or model calls');
    expect(getWikiRoot(db, 'Atlas')).toBeUndefined();
    expect(engine.wikiCreateHome).not.toHaveBeenCalled();
    expect(curateProject).not.toHaveBeenCalled();
    db.close();
  });

  it('only confirms a wiki that is already registered and built', async () => {
    const { db, engine, d } = enrollmentDeps({ id: 'home-1', version: 4, wiki_evidence_hash: 'h' });
    enrolProjects(db, 'Atlas');
    const res = await createProjectWiki(d, { project: 'Atlas', dryRun: false });
    expect(res).toMatchObject({ ok: true, created: false, home_created: false, first_build: null, detail: 'already maintained; nothing to build' });
    expect(engine.wikiCreateHome).not.toHaveBeenCalled();
    expect(curateProject).not.toHaveBeenCalled();
    db.close();
  });

  it('refuses notes that are not projects, unknown titles and topic wiki titles', async () => {
    const notProject = enrollmentDeps(null, ['note']);
    expect(await createProjectWiki(notProject.d, { project: 'Atlas', dryRun: false })).toMatchObject({ ok: false, error: { code: 'NOT_A_PROJECT' } });
    const unknown = enrollmentDeps();
    unknown.engine.projectEvidence.mockRejectedValueOnce(new Error('Project not found'));
    expect(await createProjectWiki(unknown.d, { project: 'Ghost', dryRun: false })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PROJECT' } });
    const topic = enrollmentDeps();
    registerWikiRoot(topic.db, { root_title: 'Atlas', root_node_id: 'topic-1', kind: 'topic', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    expect(await createProjectWiki(topic.d, { project: 'Atlas', dryRun: false })).toMatchObject({ ok: false, error: { code: 'TITLE_IN_USE' } });
    for (const f of [notProject, unknown, topic]) expect(getWikiRoot(f.db, 'Atlas')?.kind ?? null).not.toBe('project');
    expect(curateProject).not.toHaveBeenCalled();
  });

  it('sweeps only registered active projects and refuses unregistered ones elsewhere', async () => {
    const { db, d } = enrollmentDeps();
    d.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live' });
    expect(await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' })).toEqual([]);
    expect(await curateOne(d, 'Atlas', { dryRun: false, force: false, trigger: 'on-demand' }))
      .toMatchObject({ outcome: 'error', detail: expect.stringMatching(/^NO_WIKI: "Atlas" has no project wiki/) });
    expect(await requestWikiPage(d, { project: 'Atlas', title: 'Risks', mode: 'immediate' }))
      .toMatchObject({ ok: false, error: { code: 'NO_WIKI' } });
    expect(db.prepare('SELECT COUNT(*) AS c FROM page_requests').get()).toEqual({ c: 0 });
    expect(curateProject).not.toHaveBeenCalled();
    enrolProjects(db, 'Atlas');
    expect((await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' })).map(r => r.project)).toEqual(['Atlas']);
    db.close();
  });

  it('admits a registered project by node identity, so a rename keeps the wiki and a new holder of the old title does not get it', async () => {
    const { db, engine, d } = enrollmentDeps();
    d.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live' });
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    engine.listActiveProjects.mockResolvedValue([{ id: 'p-1', title: 'Atlas', file_path: '', status: 'open' },
      { id: 'p-2', title: 'Old Atlas', file_path: '', status: 'open' }]);
    expect((await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' })).map(r => r.project)).toEqual(['Atlas']);
    expect(await curateOne(d, 'Old Atlas', { dryRun: false, force: false, trigger: 'on-demand' }))
      .toMatchObject({ outcome: 'error', detail: expect.stringMatching(/^NO_WIKI/) });
    db.close();
  });

  it('moves a renamed project\'s registration to its current title instead of adding a second one', async () => {
    const { db, d } = enrollmentDeps({ id: 'home-1', version: 4, wiki_evidence_hash: 'h' });
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: 'client-0' });
    expect(await createProjectWiki(d, { project: 'Atlas', dryRun: false, by: 'client-1' }))
      .toMatchObject({ ok: true, created: false, first_build: null });
    expect(projectWikiRoots(db)).toEqual([expect.objectContaining({ root_title: 'Atlas', root_node_id: 'p-1',
      created_at: '2026-10-01T00:00:00Z', created_by: 'client-0' })]);

    registerWikiRoot(db, { root_title: 'Atlas', root_node_id: 'p-9', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    expect(await createProjectWiki(d, { project: 'Atlas', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'TITLE_IN_USE', message: expect.stringContaining('renamed') } });
    expect(getWikiRoot(db, 'Atlas')?.root_node_id).toBe('p-9');
    db.close();
  });

  it('enrolls notes of the configured project type', async () => {
    const custom = enrollmentDeps(null, ['initiative']);
    custom.d.config = { ...custom.d.config, projectType: 'initiative' };
    expect(await createProjectWiki(custom.d, { project: 'Atlas', dryRun: false })).toMatchObject({ ok: true, created: true });
    await curateOne(custom.d, 'Atlas', { dryRun: true, force: false, trigger: 'on-demand' });
    expect(custom.engine.listActiveProjects).toHaveBeenCalledWith(['open'], 'initiative', 'status');
    const plain = enrollmentDeps(null, ['project']);
    plain.d.config = { ...plain.d.config, projectType: 'initiative' };
    expect(await createProjectWiki(plain.d, { project: 'Atlas', dryRun: false })).toMatchObject({ ok: false, error: { code: 'NOT_A_PROJECT' } });
    custom.db.close(); plain.db.close();
  });

  it('builds the resolved project first, not an active namesake', async () => {
    const { db, engine, d } = enrollmentDeps();
    engine.listActiveProjects.mockResolvedValue([{ id: 'p-9', title: 'Atlas', file_path: '', status: 'open' }]);
    const res = await createProjectWiki(d, { project: 'p-1', dryRun: false });
    expect(res).toMatchObject({ ok: true, project_id: 'p-1', first_build: { outcome: 'written' } });
    expect((curateProject as Mock).mock.calls[0]![3]).toMatchObject({ id: 'p-1', title: 'Atlas' });
    db.close();
  });

  it('finds a renamed project outside the active list by node identity', async () => {
    const { db, engine, d } = enrollmentDeps();
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    engine.listActiveProjects.mockResolvedValue([]);
    engine.findNodesByExactTitle.mockResolvedValue([{ id: 'note-1', types: ['note'] }, { id: 'p-1', types: ['project'] }]);
    expect((await curateOne(d, 'Atlas', { dryRun: false, force: false, trigger: 'on-demand' })).outcome).toBe('written');
    expect((curateProject as Mock).mock.calls[0]![3]).toMatchObject({ id: 'p-1', title: 'Atlas' });
    expect(await requestWikiPage(d, { project: 'Atlas', title: 'Risks', mode: 'next-run' })).toMatchObject({ ok: true, status: 'pending' });
    engine.findNodesByExactTitle.mockResolvedValue([{ id: 'p-2', types: ['project'] }]);
    expect(await curateOne(d, 'Atlas', { dryRun: false, force: false, trigger: 'on-demand' }))
      .toMatchObject({ outcome: 'error', detail: expect.stringMatching(/^NO_WIKI/) });
    db.close();
  });

  it('follows a rename with the wiki\'s pause flag and corrections, so a paused wiki stays paused', async () => {
    const { db, engine, d } = enrollmentDeps();
    d.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live' });
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    setPaused(db, 'Old Atlas', true, 'tester', '2026-10-02T00:00:00Z');
    addCorrection(db, { project_title: 'Old Atlas', note: 'Stop surfacing X.', created_by: 'tester', created_at: '2026-10-02T00:00:00Z' });
    recordDeferredCreates(db, 'Old Atlas', { evidenceHash: 'h', count: 2 });
    engine.listActiveProjects.mockResolvedValue([{ id: 'p-1', title: 'Atlas', file_path: '', status: 'open' }]);

    expect(await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' })).toEqual([]);
    expect(curateProject).not.toHaveBeenCalled();
    expect(getWikiRoot(db, 'Old Atlas')).toBeUndefined();
    expect(getWikiRoot(db, 'Atlas')).toMatchObject({ root_node_id: 'p-1', created_at: '2026-10-01T00:00:00Z' });
    expect(isPaused(db, 'Atlas')).toBe(true);
    expect(activeCorrections(db, 'Atlas').map(c => c.note)).toEqual(['Stop surfacing X.']);
    expect(readDeferredCreates(db, 'Atlas')).toEqual({ evidenceHash: 'h', count: 2 });
    db.close();
  });

  it('moves nothing on dry runs, reading a renamed wiki\'s state under its registered title', async () => {
    const { db, engine, d } = enrollmentDeps();
    d.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live' });
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    writeStagePlanning(db, 'Old Atlas', 'fp', {} as PlanningResult);
    setPaused(db, 'Old Atlas', true, 'tester', '2026-10-02T00:00:00Z');
    engine.listActiveProjects.mockResolvedValue([{ id: 'p-1', title: 'Atlas', file_path: '', status: 'open' }]);

    expect(await runSweep(d, { dryRun: true, force: false, trigger: 'scheduled' })).toEqual([]);
    expect(await curateOne(d, 'Atlas', { dryRun: true, force: false, trigger: 'on-demand' }))
      .toMatchObject({ project: 'Atlas', outcome: 'skipped', detail: 'paused' });
    setPaused(db, 'Old Atlas', false, 'tester', '2026-10-03T00:00:00Z');
    await curateOne(d, 'Atlas', { dryRun: true, force: false, trigger: 'on-demand' });
    expect((curateProject as Mock).mock.calls[0]![3]).toMatchObject({ id: 'p-1', title: 'Old Atlas' });

    expect(getWikiRoot(db, 'Old Atlas')?.root_node_id).toBe('p-1');
    expect(getWikiRoot(db, 'Atlas')).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS c FROM wiki_stage_checkpoints WHERE root_title = 'Old Atlas'").get()).toEqual({ c: 1 });
    db.close();
  });

  it('moves a renamed wiki only after an in-flight curation of it finishes', async () => {
    const { db, engine, d } = enrollmentDeps();
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    engine.listActiveProjects.mockResolvedValue([{ id: 'p-1', title: 'Old Atlas', file_path: '', status: 'open' }]);
    let release: (() => void) | undefined;
    (curateProject as Mock).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { project: 'Old Atlas', outcome: 'written', dryRun: false, evidenceHash: 'h1', deferredCreates: 2 };
    });
    const running = curateOne(d, 'Old Atlas', { dryRun: false, force: false, trigger: 'on-demand' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    // The project is renamed and paused by its new title while that run is still writing.
    engine.findNodesByExactTitle.mockResolvedValue([{ id: 'p-1', types: ['project'] }]);
    const pause = makeSetWikiPausedHandler(d)({ project: 'Atlas', paused: true },
      { authInfo: { scopes: ['curate:trigger'], clientId: 'client-1' } } as never);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getWikiRoot(db, 'Old Atlas')).toBeDefined();
    release!();
    await running;
    await pause;

    expect(getWikiRoot(db, 'Old Atlas')).toBeUndefined();
    expect(readDeferredCreates(db, 'Atlas')).toEqual({ evidenceHash: 'h1', count: 2 });
    expect(readDeferredCreates(db, 'Old Atlas')).toBeNull();
    expect(isPaused(db, 'Atlas')).toBe(true);
    db.close();
  });

  it('lets title-based tools name a renamed project by its current title', async () => {
    const { db, engine, d } = enrollmentDeps();
    const register = () => registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault',
      cadence: null, brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    engine.findNodesByExactTitle.mockResolvedValue([{ id: 'p-1', types: ['project'] }]);

    register();
    const pause = makeSetWikiPausedHandler(d);
    await pause({ project: 'Atlas', paused: true }, { authInfo: { scopes: ['curate:trigger'], clientId: 'client-1' } } as never);
    expect(getWikiRoot(db, 'Atlas')?.root_node_id).toBe('p-1');
    expect(isPaused(db, 'Atlas')).toBe(true);
    expect(isPaused(db, 'Old Atlas')).toBe(false);

    deleteWikiRoot(db, 'Atlas');
    register();
    const removed = await removeWiki(d, { topic: 'Atlas' });
    expect(removed).toMatchObject({ ok: true, topic: 'Atlas', removed: true, cleared: { paused: 1 } });
    expect(projectWikiRoots(db)).toEqual([]);
    db.close();
  });

  it('carries title-keyed state along when create-project-wiki follows a rename', async () => {
    const { db, d } = enrollmentDeps({ id: 'home-1', version: 4, wiki_evidence_hash: 'h' });
    registerWikiRoot(db, { root_title: 'Old Atlas', root_node_id: 'p-1', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-01T00:00:00Z', created_by: null });
    addCorrection(db, { project_title: 'Old Atlas', note: 'Keep it short.', created_by: 'tester', created_at: '2026-10-02T00:00:00Z' });
    expect(await createProjectWiki(d, { project: 'Atlas', dryRun: false })).toMatchObject({ ok: true, created: false });
    expect(activeCorrections(db, 'Atlas').map(c => c.note)).toEqual(['Keep it short.']);
    expect(activeCorrections(db, 'Old Atlas')).toEqual([]);
    db.close();
  });

  it('does not fulfill an immediate page request whose wiki was removed while it waited in the queue', async () => {
    const { db, d } = enrollmentDeps();
    enrolProjects(db, 'Atlas');
    let release: (() => void) | undefined;
    const blocker = d.queue.enqueue('blocker', () => new Promise<void>(resolve => { release = resolve; }));
    const removal = removeWiki(d, { topic: 'Atlas' });
    const request = requestWikiPage(d, { project: 'Atlas', title: 'Risks', mode: 'immediate' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise(resolve => setTimeout(resolve, 0));
    release!();
    await blocker;
    expect(await removal).toMatchObject({ ok: true });
    expect(await request).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^NO_WIKI/) } });
    expect(curateRequestedPage).not.toHaveBeenCalled();
    expect(curateProject).not.toHaveBeenCalled();
    db.close();
  });

  it('does not curate a project whose wiki was removed while its run waited in the queue', async () => {
    const { db, d } = enrollmentDeps();
    enrolProjects(db, 'Atlas');
    let release: (() => void) | undefined;
    const blocker = d.queue.enqueue('blocker', () => new Promise<void>(resolve => { release = resolve; }));
    const removal = removeWiki(d, { topic: 'Atlas' });
    // Still registered when checked, so the curation queues behind the removal.
    const run = curateOne(d, 'Atlas', { dryRun: false, force: false, trigger: 'on-demand' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise(resolve => setTimeout(resolve, 0));
    release!();
    await blocker;
    expect(await run).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/^NO_WIKI/) });
    expect(await removal).toMatchObject({ ok: true });
    expect(curateProject).not.toHaveBeenCalled();
    db.close();
  });

  it('removing a project wiki clears its evidence manifest; the topic tool refuses project titles', async () => {
    const { db, d } = enrollmentDeps();
    enrolProjects(db, 'Atlas');
    writeEvidenceManifest(db, 'Atlas', { evidenceHash: 'h', components: { status: 's', tasks: 't', notes: 'n', meetings: 'm', contacts: 'c' },
      curatedAt: '2026-10-25T05:00:00.000Z' });
    recordDeferredCreates(db, 'Atlas', { evidenceHash: 'h', count: 2 });
    expect(await createOrUpdateWiki(d, { topic: 'Atlas' })).toMatchObject({ ok: false, error: { code: 'WIKI_IS_A_PROJECT' } });
    expect(await removeWiki(d, { topic: 'Atlas' })).toMatchObject({ ok: true });
    expect(readEvidenceManifest(db, 'Atlas')).toBeNull();
    expect(readDeferredCreates(db, 'Atlas')).toBeNull();
    expect(getWikiRoot(db, 'Atlas')).toBeUndefined();
    db.close();
  });

  describe('builds that run after the reply (#284)', () => {
    /** A curateProject that stays running until released. */
    function holdCuration() {
      let release!: () => void;
      const done = new Promise<void>((r) => { release = r; });
      (curateProject as Mock).mockImplementationOnce(async (_e, _l, _c, project: ProjectRef, dryRun: boolean) => {
        await done;
        return { project: project.title, outcome: 'written', dryRun };
      });
      return release;
    }
    function withBuilds(d: CoreDeps) {
      const kept: Promise<unknown>[] = [];
      const builds = new BackgroundBuilds((work) => { kept.push(work); });
      return { builds, kept, d: { ...d, builds } };
    }

    it('create-project-wiki registers the wiki and replies "queued" before the first build finishes', async () => {
      const base = enrollmentDeps();
      const { d, kept } = withBuilds(base.d);
      const release = holdCuration();
      const res = await createProjectWiki(d, { project: 'Atlas', dryRun: false });
      expect(res).toMatchObject({ ok: true, project_id: 'p-1', created: true, home_created: true, first_build: 'queued',
        detail: expect.stringMatching(/^wiki registered with an empty home; its first build is queued\. .*curator-status shows the outcome/) });
      expect(res.ok && res.detail).not.toMatch(/sweep/); // none builds it while wikiReconciliationMode is off (#544)
      expect(getWikiRoot(base.db, 'Atlas')?.kind).toBe('project');
      expect(base.engine.wikiCreateHome).toHaveBeenCalledWith('p-1', false);
      expect(kept).toHaveLength(1); // handed to the server lifecycle, so shutdown waits for it
      release();
      await kept[0];
      expect(curateProject).toHaveBeenCalledTimes(1);
      base.db.close();
    });

    it('a repeat create-project-wiki call while the build runs replies "in_progress" without waiting for the queue', async () => {
      const base = enrollmentDeps();
      const { d, kept } = withBuilds(base.d);
      const release = holdCuration();
      await createProjectWiki(d, { project: 'Atlas', dryRun: false });
      await new Promise((r) => setTimeout(r, 0)); // the build now holds the queue
      const evidenceReads = base.engine.projectEvidence.mock.calls.length;
      for (const dryRun of [false, true]) {
        expect(await createProjectWiki(d, { project: 'Atlas', dryRun })).toMatchObject({ ok: true, project_id: 'p-1', dry_run: dryRun,
          first_build: 'in_progress', detail: expect.stringContaining('A build for "Atlas" is already queued or running') });
      }
      expect(base.engine.projectEvidence).toHaveBeenCalledTimes(evidenceReads); // neither call reached the queued step
      release();
      await kept[0];
      expect(curateProject).toHaveBeenCalledTimes(1);
      base.db.close();
    });

    it('curate-project-wiki queues a live project run and reports a second call as in progress', async () => {
      const base = enrollmentDeps();
      enrolProjects(base.db, 'Atlas');
      const { builds, d, kept } = withBuilds(base.d);
      const release = holdCuration();
      const args = { project: 'Atlas', force: false, dryRun: false };
      expect(await startOnDemandCuration(d, builds, args, 'on-demand')).toMatchObject({ status: 'queued', project: 'Atlas',
        queued_at: expect.any(String), detail: expect.stringMatching(/^Queued a curation of "Atlas"\. /) });
      for (const dryRun of [false, true]) {
        expect(await startOnDemandCuration(d, builds, { ...args, dryRun }, 'on-demand'))
          .toMatchObject({ status: 'in_progress', project: 'Atlas' });
      }
      release();
      await kept[0];
      expect(curateProject).toHaveBeenCalledTimes(1);
      // Settled: a dry run is the caller's to run synchronously again.
      expect(await startOnDemandCuration(d, builds, { ...args, dryRun: true }, 'on-demand')).toBeNull();
      base.db.close();
    });

    it('finds a build in flight whether the call names the project by node id or by title', async () => {
      const base = enrollmentDeps();
      const { builds, d, kept } = withBuilds(base.d);
      const release = holdCuration();
      expect(await createProjectWiki(d, { project: 'p-1', dryRun: false })).toMatchObject({ project: 'Atlas', first_build: 'queued' });
      await new Promise((r) => setTimeout(r, 0));
      const evidenceReads = base.engine.projectEvidence.mock.calls.length;
      for (const project of ['p-1', 'Atlas']) {
        expect(await createProjectWiki(d, { project, dryRun: false })).toMatchObject({ first_build: 'in_progress', project_id: 'p-1' });
        expect(await startOnDemandCuration(d, builds, { project, force: false, dryRun: false }, 'on-demand'))
          .toMatchObject({ status: 'in_progress' });
      }
      expect(base.engine.projectEvidence).toHaveBeenCalledTimes(evidenceReads);
      release();
      await kept[0];
      expect(curateProject).toHaveBeenCalledTimes(1);
      base.db.close();
    });

    it('create-project-wiki answers a paused, unbuilt wiki at once instead of queueing a build that would be skipped', async () => {
      const base = enrollmentDeps();
      setPaused(base.db, 'Atlas', true, 'tester', '2026-10-31T00:00:00Z');
      const { d, kept } = withBuilds(base.d);
      const res = await createProjectWiki(d, { project: 'Atlas', dryRun: false });
      expect(res).toMatchObject({ ok: true, first_build: { outcome: 'skipped', detail: 'paused' },
        detail: 'wiki registered with an empty home; it was already paused, so its first build did not run. '
          + 'curate-project-wiki with force: true builds it on request and leaves it paused' });
      expect(kept).toHaveLength(0);
      expect(curateProject).not.toHaveBeenCalled();
      base.db.close();
    });

    it('curate-project-wiki answers an unregistered project at once instead of queueing it', async () => {
      const base = enrollmentDeps();
      const { builds, d, kept } = withBuilds(base.d);
      const res = await startOnDemandCuration(d, builds, { project: 'Atlas', force: false, dryRun: false }, 'on-demand');
      expect(res).toEqual([expect.objectContaining({ project: 'Atlas', outcome: 'error', detail: expect.stringMatching(/^NO_WIKI/) })]);
      expect(kept).toHaveLength(0);
      base.db.close();
    });

    it('a build shutdown gives up on gets an "interrupted" error run row for curator-status (#405)', async () => {
      const base = enrollmentDeps();
      enrolProjects(base.db, 'Atlas');
      const { builds, d } = withBuilds(base.d);
      holdCuration(); // never released: the build is still running when shutdown gives up
      expect(await startOnDemandCuration(d, builds, { project: 'Atlas', force: false, dryRun: false }, 'on-demand'))
        .toMatchObject({ status: 'queued' });
      expect(builds.interruptAll('interrupted: the Curator shut down before this build finished')).toEqual(['curation of Atlas']);
      expect(recentRuns(base.db, 5)).toEqual([expect.objectContaining({ project: 'Atlas', trigger: 'on-demand', outcome: 'error',
        error: 'interrupted: the Curator shut down before this build finished', input_tokens: 0, output_tokens: 0 })]);
      base.db.close();
    });

    it('a queued build that fails before recording a run gets an error run row for curator-status', async () => {
      const base = enrollmentDeps();
      enrolProjects(base.db, 'Atlas');
      const { builds, d, kept } = withBuilds(base.d);
      // The sweep's first Engine read fails, before any per-project run is recorded.
      base.engine.listActiveProjects.mockRejectedValueOnce(new Error('engine unreachable'));
      expect(await startOnDemandCuration(d, builds, { force: false, dryRun: false }, 'on-demand')).toMatchObject({ status: 'queued' });
      await kept[0];
      expect(recentRuns(base.db, 5)).toEqual([expect.objectContaining({ project: 'On-demand sweep', trigger: 'on-demand',
        outcome: 'error', error: expect.stringContaining('engine unreachable') })]);
      expect(builds.get('sweep')).toBeUndefined();
      base.db.close();
    });

    it('curate-project-wiki queues a live sweep once', async () => {
      const base = enrollmentDeps();
      enrolProjects(base.db, 'Atlas');
      const { builds, d, kept } = withBuilds(base.d);
      const release = holdCuration();
      const queued = await startOnDemandCuration(d, builds, { force: false, dryRun: false, limit: 3 }, 'on-demand');
      expect(queued).toMatchObject({ status: 'queued', project: null, detail: expect.stringContaining('(at most 3)') });
      // A scheduled sweep retries budget refusals only while wiki reconciliation is live (#544).
      expect(queued).toMatchObject({ detail: expect.stringMatching(
        /retried by the next scheduled sweep only while curator-status shows wiki_reconciliation_mode "live"; otherwise call this again once there is budget\.$/) });
      expect(await startOnDemandCuration(d, builds, { force: false, dryRun: false }, 'on-demand'))
        .toMatchObject({ status: 'in_progress', project: null });
      release();
      await kept[0];
      expect(curateProject).toHaveBeenCalledTimes(1);
      base.db.close();
    });
  });
});

describe('evidence manifests in curation', () => {
  const components = { status: 's', tasks: 't', notes: 'n', meetings: 'm', contacts: 'c' };
  it('passes the stored manifest in and records it after real written runs only', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    writeEvidenceManifest(db, 'A', { evidenceHash: 'h0', components, curatedAt: '2026-10-20T05:00:00.000Z' });
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    const d = { ...deps(active), db };
    const written = (dryRun: boolean): CurateResult => ({ project: 'A', outcome: 'written', dryRun, evidenceHash: 'h1',
      wikiCuratedAt: '2026-10-25T05:00:00.000Z', evidenceComponents: { ...components, notes: 'n1' } });

    (curateProject as Mock).mockResolvedValueOnce(written(true));
    await curateOne(d, 'A', { dryRun: true, force: false, trigger: 'on-demand' });
    expect((curateProject as Mock).mock.calls[0]![10]).toMatchObject({ priorManifest: { evidenceHash: 'h0' } });
    expect(readEvidenceManifest(db, 'A')?.evidenceHash).toBe('h0');

    (curateProject as Mock).mockResolvedValueOnce({ ...written(false), outcome: 'refreshed_live' });
    await curateOne(d, 'A', { dryRun: false, force: false, trigger: 'on-demand' });
    expect(readEvidenceManifest(db, 'A')?.evidenceHash).toBe('h0');

    (curateProject as Mock).mockResolvedValueOnce(written(false));
    await curateOne(d, 'A', { dryRun: false, force: false, trigger: 'on-demand' });
    expect(readEvidenceManifest(db, 'A')).toEqual({ evidenceHash: 'h1', components: { ...components, notes: 'n1' },
      curatedAt: '2026-10-25T05:00:00.000Z' });
    db.close();
  });
});

describe('deferred page creates', () => {
  it('records a written project run\'s deferred creates, passes them to the next run and clears them', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A');
    const d = { ...deps([{ id: '1', title: 'A', file_path: '', status: 'open' }]), db };
    const written = (over: Partial<CurateResult> = {}): CurateResult =>
      ({ project: 'A', outcome: 'written', dryRun: false, evidenceHash: 'h1', ...over });
    const run = (dryRun = false) => curateOne(d, 'A', { dryRun, force: false, trigger: 'on-demand' });

    (curateProject as Mock).mockResolvedValueOnce(written({ deferredCreates: 2 }));
    await run();
    expect(readDeferredCreates(db, 'A')).toEqual({ evidenceHash: 'h1', count: 2 });
    (curateProject as Mock).mockResolvedValueOnce(written({ dryRun: true }));
    await run(true);
    expect((curateProject as Mock).mock.lastCall![10]).toMatchObject({ deferred: { evidenceHash: 'h1', count: 2 } });
    expect(readDeferredCreates(db, 'A')).toEqual({ evidenceHash: 'h1', count: 2 });
    (curateProject as Mock).mockResolvedValueOnce(written({ evidenceHash: 'h2' }));
    await run();
    expect(readDeferredCreates(db, 'A')).toBeNull();
    db.close();
  });

  it('does the same for topic wikis', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 'topic-1', kind: 'topic', source: 'vault', cadence: null, brief: 'b',
      created_at: new Date().toISOString(), created_by: 'tester' });
    const d = { ...deps([]), db };
    const run = () => curateTopicTimed(d, { id: 'topic-1', title: 'Topic', file_path: '', status: null },
      { source: 'vault', cadence: null }, { dryRun: false, force: false, trigger: 'scheduled' });
    (curateTopic as Mock).mockResolvedValueOnce({ project: 'Topic', outcome: 'written', dryRun: false, evidenceHash: 't1', deferredCreates: 1 });
    await run();
    expect(readDeferredCreates(db, 'Topic')).toEqual({ evidenceHash: 't1', count: 1 });
    await run();
    expect((curateTopic as Mock).mock.lastCall![5]).toMatchObject({ deferred: { evidenceHash: 't1', count: 1 } });
    db.close();
  });
});

describe('daily budget gate', () => {
  function budgetDeps(remainingUsd: number | null) {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 'topic-1', kind: 'topic', source: 'vault', cadence: null, brief: 'b', created_at: new Date().toISOString(), created_by: 'tester' });
    const engine = {
      listActiveProjects: vi.fn(async () => [{ id: 'project-1', title: 'Project', file_path: '', status: 'open' }]),
      updateNodeFields: vi.fn(async () => undefined),
    };
    const remaining = vi.fn(async () => remainingUsd);
    const d: CoreDeps = { engine: engine as never, llm: {} as never, queue: new CurationQueue(), db, budget: { remainingUsd: remaining },
      config: makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live', staleProjectDays: 0, staleProjectStatus: 'backlog',
        staleSkipStatuses: [], projectStatusField: 'status' }) };
    return { db, engine, d, remaining };
  }

  it('stops starting paid wiki work once the budget is spent and records why', async () => {
    const { db, engine, d } = budgetDeps(0);
    (curateProject as Mock).mockImplementationOnce(async (_e, _l, _c, project: ProjectRef, dryRun: boolean, ...rest: unknown[]) =>
      ({ project: project.title, outcome: 'skipped_budget', detail: (rest.at(-1) as { budgetSpent: string }).budgetSpent, dryRun }));
    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results.map(r => [r.project, r.outcome])).toEqual([['Project', 'skipped_budget'], ['Topic', 'skipped_budget']]);
    // Projects still reach the no-model skip and live-refresh paths; the pipeline refuses paid stages.
    expect((curateProject as Mock).mock.calls[0]![10]).toMatchObject({ budgetSpent: 'daily budget spent; the next sweep retries' });
    expect(curateTopic).not.toHaveBeenCalled();
    expect(engine.updateNodeFields).not.toHaveBeenCalled();
    expect(recentRuns(db, 10).map(r => r.outcome)).toEqual(['skipped_budget', 'skipped_budget']);
    db.close();
  });

  it('stops starting paid wiki work when a wiki provider\'s key limit is spent (#342)', async () => {
    const { db, d } = budgetDeps(5);
    const spent = 'OpenRouter key limit spent; resets 2026-11-05T00:00:00.000Z';
    d.budget = { remainingUsd: async () => 5, providerSpent: async () => spent };
    (curateProject as Mock).mockImplementationOnce(async (_e, _l, _c, project: ProjectRef, dryRun: boolean, ...rest: unknown[]) =>
      ({ project: project.title, outcome: 'skipped_budget', detail: (rest.at(-1) as { budgetSpent: string }).budgetSpent, dryRun }));
    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results.map(r => [r.project, r.outcome])).toEqual([['Project', 'skipped_budget'], ['Topic', 'skipped_budget']]);
    expect((curateProject as Mock).mock.calls[0]![10]).toMatchObject({ budgetSpent: `${spent}; the next sweep retries` });
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('curates while budget remains, without a cap, and never gates plain dry runs', async () => {
    for (const remaining of [0.5, null]) {
      const { db, d } = budgetDeps(remaining);
      await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
      db.close();
    }
    expect(curateProject).toHaveBeenCalledTimes(2);
    const spent = budgetDeps(0);
    await runSweep(spent.d, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(curateProject).toHaveBeenCalledTimes(3);
    expect(spent.remaining).not.toHaveBeenCalled();
    spent.db.close();
  });
});

describe('failure hold', () => {
  const failedPaidRun = (db: Database.Database) => recordRun(db, curateResultToRunRow({ project: 'Project', outcome: 'error',
    dryRun: false, evidenceHash: 'h1', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } as CurateResult,
  { trigger: 'scheduled', durationMs: 1, ts: new Date().toISOString() }));

  it('passes a recent paid failure to scheduled curation only', async () => {
    const live = (() => { const d = new Database(':memory:'); runMigrations(d); enrolProjects(d, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done'); return d; })();
    failedPaidRun(live);
    const active: ProjectRef[] = [{ id: 'project-1', title: 'Project', file_path: '', status: 'open' }];
    const scheduled = { ...deps(active), db: live };
    scheduled.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live' });
    await runSweep(scheduled, { dryRun: false, force: false, trigger: 'scheduled' });
    expect((curateProject as Mock).mock.calls[0]![10]).toMatchObject({ failureHoldHash: 'h1' });

    await curateOne(scheduled, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    expect((curateProject as Mock).mock.calls[1]![10]).toMatchObject({ failureHoldHash: null });

    scheduled.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live', wikiFailureHoldDays: 0 });
    await runSweep(scheduled, { dryRun: false, force: false, trigger: 'scheduled' });
    expect((curateProject as Mock).mock.calls[2]![10]).toMatchObject({ failureHoldHash: null });
    live.close();
  });

  it('lifts the hold when the wiki output policy changed since the failure (#358)', async () => {
    const live = new Database(':memory:'); runMigrations(live); enrolProjects(live, 'Project');
    const llm = {
      configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }),
      withConfiguration() { return this; },
      structuredCall: vi.fn(),
    } as unknown as LlmClient;
    const active: ProjectRef[] = [{ id: 'project-1', title: 'Project', file_path: '', status: 'open' }];
    const at = (wikiHomeMaxTokens: number) => makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'live',
      model: 'm', wikiHomeMaxTokens, wikiPlanningMaxTokens: 100, wikiPageMaxTokens: 100, homeMaxTokens: 100,
      wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit' });
    recordRun(live, curateResultToRunRow({ project: 'Project', outcome: 'error', dryRun: false, evidenceHash: 'h1',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      outputPolicyHash: wikiOutputPolicyHash(resolveWikiOutputPolicy(at(100), llm)) } as CurateResult,
    { trigger: 'scheduled', durationMs: 1, ts: new Date().toISOString() }));
    const sweep = async (wikiHomeMaxTokens: number) => {
      (curateProject as Mock).mockClear();
      await runSweep({ ...deps(active), db: live, llm, config: at(wikiHomeMaxTokens) }, { dryRun: false, force: false, trigger: 'scheduled' });
      return (curateProject as Mock).mock.calls[0]![10];
    };

    expect(await sweep(100)).toMatchObject({ failureHoldHash: 'h1' });
    expect(await sweep(200)).toMatchObject({ failureHoldHash: null });
    live.close();
  });
});

describe('curateOne', () => {
  it('resolves a known project from the active set', async () => {
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '/A.md', status: 'open' }];
    const r = await curateOne(deps(active), 'A', { dryRun: false, force: false, trigger: 'on-demand' });
    expect(r.project).toBe('A');
    const call = (curateProject as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![3]).toMatchObject({ id: '1', title: 'A' });
  });

  it('falls back to an honestly title-only ref when the title is not active', async () => {
    const r = await curateOne(deps([]), 'Ghost', { dryRun: true, force: false, trigger: 'on-demand' });
    expect(r.project).toBe('Ghost');
    const call = (curateProject as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![3]).toEqual({ id: null, title: 'Ghost', file_path: '', status: null });
    expect(call![4]).toBe(true); // dryRun threaded through
  });

  it('honors an on-demand dryRun argument regardless of scheduled wiki mode', async () => {
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    const d = deps(active);
    d.config = makeConfig({ activeStatuses: ['open'], wikiReconciliationMode: 'off' });

    await curateOne(d, 'A', { dryRun: true, force: false, trigger: 'on-demand' });

    expect((curateProject as Mock).mock.calls[0]![4]).toBe(true);
  });
});

describe('pause gate', () => {
  it('curateOne returns skipped/paused unless force overrides', async () => {
    const d = new Database(':memory:'); runMigrations(d); enrolProjects(d, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    setPaused(d, 'A', true, null, '2026-06-26T00:00:00Z');
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    const skipped = await curateOne({ ...deps(active), db: d }, 'A', { dryRun: false, force: false, trigger: 'on-demand' });
    expect(skipped.outcome).toBe('skipped');
    expect(skipped.detail).toBe('paused');
    expect(curateProject).not.toHaveBeenCalled();

    const forced = await curateOne({ ...deps(active), db: d }, 'A', { dryRun: false, force: true, trigger: 'on-demand' });
    expect(forced.outcome).toBe('written');
    expect(curateProject).toHaveBeenCalledTimes(1);
    d.close();
  });

  it('runSweep excludes a paused project from curation and the backlog nudge', async () => {
    const d = new Database(':memory:'); runMigrations(d); enrolProjects(d, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    setPaused(d, 'B', true, 'tester', '2026-06-26T00:00:00Z');
    const active: ProjectRef[] = [
      { id: 'a', title: 'A', file_path: '', status: 'open' },
      { id: 'b', title: 'B', file_path: '', status: 'open' },
    ];
    const updates: Array<{ id: string }> = [];
    const engine = {
      listActiveProjects: vi.fn(async () => active),
      updateNodeFields: vi.fn(async (id: string) => { updates.push({ id }); }),
    };
    const config = makeConfig({
      activeStatuses: ['open'], staleProjectDays: 14, staleProjectStatus: 'backlog',
      staleSkipStatuses: ['backlog', 'done', 'dropped'], projectStatusField: 'status',
    });
    const d2: CoreDeps = { engine: engine as never, llm: {} as never, config, queue: new CurationQueue(), db: d };
    const results = await runSweep(d2, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results.map(r => r.project)).toEqual(['A']);
    expect(updates.find(u => u.id === 'b')).toBeUndefined();
    d.close();
  });
});

describe('correction threading', () => {
  it('curateOne passes active corrections to curateProject (8th arg)', async () => {
    const d = new Database(':memory:'); runMigrations(d); enrolProjects(d, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    addCorrection(d, { project_title: 'A', note: 'stop tracking X', created_by: null, created_at: '2026-06-26T00:00:00Z' });
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    await curateOne({ ...deps(active), db: d }, 'A', { dryRun: false, force: false, trigger: 'on-demand' });
    const call = (curateProject as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![7]).toEqual(['stop tracking X']); // corrections = 8th positional arg
    d.close();
  });
});

describe('triggerCuration', () => {
  it('curates a single named project (length-1 result, sweep not run)', async () => {
    const active: ProjectRef[] = [
      { id: '1', title: 'A', file_path: '', status: 'open' },
      { id: '2', title: 'B', file_path: '', status: 'open' },
    ];
    const results = await triggerCuration(deps(active), { project: 'A', force: false, dryRun: false }, 'on-demand');
    expect(results).toHaveLength(1);
    expect(results[0]!.project).toBe('A');
    expect(curateProject).toHaveBeenCalledTimes(1);
  });

  it('sweeps all active projects when no project is given', async () => {
    const active: ProjectRef[] = [
      { id: '1', title: 'A', file_path: '', status: 'open' },
      { id: '2', title: 'B', file_path: '', status: 'open' },
    ];
    const results = await triggerCuration(deps(active), { project: null, force: false, dryRun: false }, 'on-demand');
    expect(results.map((r) => r.project)).toEqual(['A', 'B']);
    expect(curateProject).toHaveBeenCalledTimes(2);
  });

  it('threads limit through to the sweep', async () => {
    const active: ProjectRef[] = [
      { id: '1', title: 'A', file_path: '', status: 'open' },
      { id: '2', title: 'B', file_path: '', status: 'open' },
    ];
    const results = await triggerCuration(deps(active), { force: false, dryRun: false, limit: 1 }, 'on-demand');
    expect(results).toHaveLength(1);
    expect(curateProject).toHaveBeenCalledTimes(1);
  });
});

describe('runSweep backlog staleness', () => {
  function stalenessDeps(active: ProjectRef[], curatedAtByProject: Record<string, string | null>) {
    const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
    const engine = {
      listActiveProjects: vi.fn(async () => active),
      updateNodeFields: vi.fn(async (id: string, fields: Record<string, unknown>) => { updates.push({ id, fields }); }),
    };
    (curateProject as Mock).mockImplementation(async (_e, _a, _c, project: ProjectRef): Promise<CurateResult> => ({
      project: project.title, outcome: 'skipped', dryRun: false,
      wikiCuratedAt: project.id === null ? null : (curatedAtByProject[project.id] ?? null),
    }));
    const config = makeConfig({
      activeStatuses: ['open'],
      wikiReconciliationMode: 'live',
      staleProjectDays: 14, staleProjectStatus: 'backlog',
      staleSkipStatuses: ['backlog', 'done', 'dropped'], projectStatusField: 'status',
    });
    const coreDeps: CoreDeps = {
      engine: engine as never, llm: {} as never, config, queue: new CurationQueue(),
    };
    return { deps: coreDeps, updates, engine };
  }

  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();

  it('backlogs a stale active project and leaves a fresh one alone', async () => {
    const active: ProjectRef[] = [
      { id: 'p1', title: 'Stale', file_path: '', status: 'open' },
      { id: 'p2', title: 'Fresh', file_path: '', status: 'open' },
    ];
    const { deps, updates } = stalenessDeps(active, { p1: old, p2: fresh });
    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(updates).toEqual([{ id: 'p1', fields: { status: 'backlog' } }]);
  });

  it('does not backlog under dry-run', async () => {
    const active: ProjectRef[] = [{ id: 'p1', title: 'Stale', file_path: '', status: 'open' }];
    const { deps, updates } = stalenessDeps(active, { p1: old });
    await runSweep(deps, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(updates).toEqual([]);
  });

  it('does not backlog a project already in a skip status', async () => {
    const active: ProjectRef[] = [{ id: 'p1', title: 'Done', file_path: '', status: 'done' }];
    const { deps, updates } = stalenessDeps(active, { p1: old });
    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(updates).toEqual([]);
  });

  it('lists and backlogs projects through the configured status field', async () => {
    const active: ProjectRef[] = [{ id: 'p1', title: 'Stale', file_path: '', status: 'open' }];
    const { deps, updates, engine } = stalenessDeps(active, { p1: old });
    deps.config = { ...deps.config, projectStatusField: 'state' };
    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(engine.listActiveProjects).toHaveBeenCalledWith(['open'], deps.config.projectType, 'state');
    expect(updates).toEqual([{ id: 'p1', fields: { state: 'backlog' } }]);
  });

  it('changes no status when no status is designated for the nudge (#447)', async () => {
    const active: ProjectRef[] = [{ id: 'p1', title: 'Stale', file_path: '', status: 'open' }];
    for (const staleProjectStatus of ['', '  ']) {
      const { deps, updates } = stalenessDeps(active, { p1: old });
      deps.config = { ...deps.config, staleProjectStatus };
      await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
      expect(updates).toEqual([]);
    }
  });

  it('writes no status when the vault map sets the project status field to none', async () => {
    const active: ProjectRef[] = [{ id: 'p1', title: 'Stale', file_path: '', status: null }];
    const { deps, updates, engine } = stalenessDeps(active, { p1: old });
    deps.config = { ...deps.config, projectStatusField: null };
    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(engine.listActiveProjects).toHaveBeenCalledWith(['open'], deps.config.projectType, null);
    expect(updates).toEqual([]);
  });
});

describe('run recording', () => {
  beforeEach(() => {
    // Reset to the original written-outcome implementation (staleness tests override it).
    (curateProject as Mock).mockImplementation(
      async (_e: unknown, _a: unknown, _c: unknown, project: ProjectRef): Promise<CurateResult> => ({
        project: project.title,
        outcome: 'written',
        dryRun: false,
      }),
    );
  });

  it('records one row per result with the supplied trigger when a db is present', async () => {
    const db = new Database(':memory:');
    runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const active: ProjectRef[] = [
      { id: '1', title: 'A', file_path: '', status: 'open' },
      { id: '2', title: 'B', file_path: '', status: 'open' },
    ];
    await runSweep({ ...deps(active), db }, { dryRun: false, force: false, trigger: 'scheduled' });
    const rows = recentRuns(db, 10);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.trigger === 'scheduled')).toBe(true);
    expect(rows.every((r) => r.duration_ms >= 0)).toBe(true);
    db.close();
  });

  it('records an on-demand run via curateOne', async () => {
    const db = new Database(':memory:');
    runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '/A.md', status: 'open' }];
    await curateOne({ ...deps(active), db }, 'A', { dryRun: false, force: false, trigger: 'on-demand' });
    const rows = recentRuns(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe('on-demand');
    db.close();
  });

  it('does not record and still curates when no db is present', async () => {
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    const results = await runSweep(deps(active), { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('written');
  });

  it('a failing recordRun does not fail curation', async () => {
    const badDb = new Database(':memory:'); runMigrations(badDb); enrolProjects(badDb, 'A');
    badDb.exec('DROP TABLE runs');
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    const results = await runSweep({ ...deps(active), db: badDb }, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results[0]!.outcome).toBe('written');
    badDb.close();
  });

  it('curates nothing when the project wiki registry cannot be read', async () => {
    const badDb = { prepare: () => { throw new Error('boom'); } } as never;
    const active: ProjectRef[] = [{ id: '1', title: 'A', file_path: '', status: 'open' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await runSweep({ ...deps(active), db: badDb }, { dryRun: false, force: false, trigger: 'scheduled' });
    warn.mockRestore();
    expect(results).toEqual([]);
    expect(curateProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helpers for requestWikiPage / pending fulfillment tests
// ---------------------------------------------------------------------------

const ACTIVE_PROJECT: ProjectRef = { id: 'p1', title: 'Demo', file_path: 'Projects/Demo.md', status: 'open' };

function makeDeps(opts: { projectEvidenceFails?: boolean } = {}): { deps: CoreDeps; } {
  const db = new Database(':memory:');
  runMigrations(db); enrolProjects(db, ACTIVE_PROJECT.title);

  const engine = {
    listActiveProjects: vi.fn(async () => [ACTIVE_PROJECT]),
    projectEvidence: vi.fn(async (title: string) => ({
      existing_wiki: {
        home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'topology', catalog_valid: true,
        subpages: [{
          id: 'pg1', title: `${title} — ${title === 'Owls' ? 'Updates' : 'ID Check Pilot'}`,
          file_path: 'Wikis/Page.md', version: 1, content_hash: 'body', wiki_state: 'active',
          wiki_origin: 'requested', wiki_pinned: true,
        }],
      },
    })),
  } as never;

  // Reset curateProject to return 'written' (the staleness tests override it).
  (curateProject as Mock).mockImplementation(
    async (_e: unknown, _a: unknown, _c: unknown, project: ProjectRef): Promise<CurateResult> => ({
      project: project.title,
      outcome: 'written',
      dryRun: false,
    }),
  );

  // curateRequestedPage: if projectEvidenceFails → unknown-project, else written.
  (curateRequestedPage as Mock).mockImplementation(
    async (_e: unknown, _a: unknown, _c: unknown, project: ProjectRef, req: { title: string }): Promise<RequestedPageOutcome> => {
      if (opts.projectEvidenceFails) {
        return {
          project: project.title,
          requestedTitle: req.title,
          qualifiedTitle: `${project.title} — ${req.title}`,
          outcome: 'unknown-project',
          detail: 'no such project',
          dryRun: false,
        };
      }
      return {
        project: project.title,
        requestedTitle: req.title,
        qualifiedTitle: `${project.title} — ${req.title}`,
        outcome: 'written',
        nodeId: 'pg1',
        resolvedTo: { nodeId: 'pg1', title: `${project.title} — ${req.title}`, action: 'created' },
        dryRun: false,
        usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 },
        costUsd: 0.001,
      };
    },
  );

  const coreDeps: CoreDeps = {
    engine,
    llm: {} as never,
    config: makeConfig(),
    queue: new CurationQueue(),
    db,
  };

  return { deps: coreDeps };
}

describe('requestWikiPage', () => {
  it('next-run mode inserts a pending row and returns a receipt without curating', async () => {
    const { deps } = makeDeps();
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', brief: 'b', mode: 'next-run' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pending');
    expect(pendingRequests(deps.db!, 'Demo')).toHaveLength(1);
    expect((curateRequestedPage as Mock).mock.calls).toHaveLength(0);
  });

  it('rejects a title that matches both an active project and a registered topic', async () => {
    const { deps } = makeDeps();
    deleteWikiRoot(deps.db!, 'Demo');
    registerWikiRoot(deps.db!, {
      root_title: 'Demo', root_node_id: 'topic-demo', kind: 'topic', source: 'vault',
      cadence: null, brief: 'topic duplicate', created_at: '2026-08-18T00:00:00Z', created_by: null,
    });

    const res = await requestWikiPage(deps, { project: 'Demo', title: 'Updates', mode: 'immediate' });

    expect(res).toMatchObject({
      ok: false,
      error: { code: 'AMBIGUOUS_WIKI' },
    });
    expect(deps.db!.prepare(`SELECT COUNT(*) AS c FROM page_requests`).get()).toEqual({ c: 0 });
    expect(curateRequestedPage).not.toHaveBeenCalled();
    expect(curateProject).not.toHaveBeenCalled();
    expect(curateTopic).not.toHaveBeenCalled();
  });

  it('leaves a request pending when the daily budget refuses it before dispatch', async () => {
    const { deps } = makeDeps();
    (curateRequestedPage as Mock).mockImplementationOnce(async (_e, _l, _c, project: ProjectRef, spec: { title: string }) => ({
      project: project.title, requestedTitle: spec.title, qualifiedTitle: `${project.title} — ${spec.title}`,
      outcome: 'error', detail: 'daily budget: $1.0000 spent of $1.00', budgetRefused: true, dryRun: false }));
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'Risks', mode: 'immediate' });
    expect(res).toMatchObject({ ok: false, status: 'pending', error: { code: 'BUDGET_REFUSED' } });
    expect(pendingRequests(deps.db!, 'Demo')).toHaveLength(1);
  });

  it('immediate mode fulfills, marks the row, pins the title, and records a run', async () => {
    const { deps } = makeDeps();
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('fulfilled');
    expect(res.page?.title).toBe('Demo — ID Check Pilot');
    expect(res.resolvedTo).toEqual({ nodeId: 'pg1', title: 'Demo — ID Check Pilot', action: 'created' });
    expect(pinnedPageTitles(deps.db!, 'Demo')).toEqual(new Set(['Demo — ID Check Pilot']));
    const runs = deps.db!.prepare(`SELECT outcome FROM runs`).all() as Array<{ outcome: string }>;
    expect(runs.map(r => r.outcome)).toContain('requested_page');
  });

  it('merge fulfillment retargets older fulfilled source rows to the canonical target', async () => {
    // Given
    const { deps } = makeDeps();
    const older = insertPageRequest(deps.db!, {
      project_node_id: 'p1', project_title: 'Demo', title: 'Legacy', page_title: 'Demo — Legacy',
      brief: null, requested_by: null, created_at: '2026-06-10T00:00:00Z',
    });
    markRequestFulfilled(deps.db!, older, 'Demo — Legacy', 'source', 't');
    vi.mocked(curateRequestedPage).mockResolvedValueOnce({
      project: 'Demo', requestedTitle: 'Architecture', qualifiedTitle: 'Demo — Canonical',
      outcome: 'written', nodeId: 'target',
      resolvedTo: { nodeId: 'target', title: 'Demo — Canonical', action: 'merged' },
      mergedSourceNodeIds: ['source'], dryRun: false,
    });

    // When
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'Architecture', mode: 'immediate' });

    // Then
    expect(res.resolvedTo?.action).toBe('merged');
    expect(pinnedPageTitles(deps.db!, 'Demo')).toEqual(new Set(['Demo — Canonical']));
    const nodeIds = deps.db!.prepare(`SELECT DISTINCT page_node_id FROM page_requests WHERE status = 'fulfilled'`).all();
    expect(nodeIds).toEqual([{ page_node_id: 'target' }]);
  });

  it('surfaces a retarget DB warning and repairs the stale fulfilled source on the next catalog load', async () => {
    // Given
    const { deps } = makeDeps();
    const older = insertPageRequest(deps.db!, {
      project_node_id: 'p1', project_title: 'Demo', title: 'Legacy', page_title: 'Demo — Legacy',
      brief: null, requested_by: null, created_at: '2026-06-10T00:00:00Z',
    });
    markRequestFulfilled(deps.db!, older, 'Demo — Legacy', 'source', 't');
    deps.db!.exec(`CREATE TRIGGER fail_source_retarget BEFORE UPDATE ON page_requests
      WHEN OLD.page_node_id = 'source' BEGIN SELECT RAISE(ABORT, 'retarget unavailable'); END`);
    vi.mocked(curateRequestedPage).mockResolvedValueOnce({
      project: 'Demo', requestedTitle: 'Architecture', qualifiedTitle: 'Demo — Canonical',
      outcome: 'written', nodeId: 'target',
      resolvedTo: { nodeId: 'target', title: 'Demo — Canonical', action: 'merged' },
      mergedSourceNodeIds: ['source'], dryRun: false,
    });
    const projectEvidence = vi.mocked(deps.engine.projectEvidence);
    projectEvidence.mockResolvedValue({
      existing_wiki: {
        home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'topology', catalog_valid: true,
        subpages: [
          { id: 'source', title: 'Demo — Legacy', file_path: 'Wikis/Legacy.md', version: 1, content_hash: 's', wiki_state: 'retired', wiki_origin: 'requested', wiki_pinned: false, wiki_replaced_by: { id: 'target', title: 'Demo — Canonical' } },
          { id: 'target', title: 'Demo — Canonical', file_path: 'Wikis/Canonical.md', version: 1, content_hash: 't', wiki_state: 'active', wiki_origin: 'requested', wiki_pinned: true },
        ],
      },
    } as never);

    // When
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'Architecture', mode: 'immediate' });
    deps.db!.exec('DROP TRIGGER fail_source_retarget');
    await curateOne(deps, 'Demo', { dryRun: false, force: true, trigger: 'cli' });

    // Then
    expect(res.detail).toMatch(/WARN: curator request DB update failed/);
    const repaired = deps.db!.prepare(`SELECT page_node_id, page_title FROM page_requests WHERE id = ?`).get(older);
    expect(repaired).toEqual({ page_node_id: 'target', page_title: 'Demo — Canonical' });
  });

  it('unknown project → structured error and a failed row', async () => {
    const { deps } = makeDeps({ projectEvidenceFails: true });
    enrolProjects(deps.db!, 'Nope');
    const res = await requestWikiPage(deps, { project: 'Nope', title: 'X', mode: 'immediate' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('UNKNOWN_PROJECT');
    // The DB row must be failed.
    const row = deps.db!.prepare(`SELECT status, error FROM page_requests WHERE id = ?`).get(res.request_id) as { status: string; error: string | null };
    expect(row.status).toBe('failed');
    // A requested_page_error run row must exist.
    const runs = deps.db!.prepare(`SELECT outcome FROM runs`).all() as Array<{ outcome: string }>;
    expect(runs.some(r => r.outcome === 'requested_page_error')).toBe(true);
  });

  it('no-wiki fallback, success leg — curateProject runs then second fulfillOne succeeds', async () => {
    const { deps } = makeDeps();

    // First call: no-wiki; second call: written.
    (curateRequestedPage as Mock)
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'no-wiki',
        dryRun: false,
      })
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'written',
        nodeId: 'pg2', dryRun: false,
        usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.001,
      });

    // curateProject returns written (wiki now exists).
    (curateProject as Mock).mockResolvedValueOnce({
      project: 'Demo', outcome: 'written', dryRun: false,
    });

    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });

    expect(curateProject).toHaveBeenCalledTimes(1);
    expect(curateRequestedPage).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('fulfilled');

    const row = deps.db!.prepare(`SELECT status FROM page_requests WHERE id = ?`).get(res.request_id) as { status: string };
    expect(row.status).toBe('fulfilled');
  });

  it('no-wiki fallback — stand-up curateProject receives active corrections as 8th arg', async () => {
    const { deps } = makeDeps();

    // Plant a correction in the DB.
    addCorrection(deps.db!, { project_title: 'Demo', note: 'stop tracking X', created_by: null, created_at: '2026-06-26T00:00:00Z' });

    // First call: no-wiki; second call: written.
    (curateRequestedPage as Mock)
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'no-wiki',
        dryRun: false,
      })
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'written',
        nodeId: 'pg2', dryRun: false,
        usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.001,
      });

    (curateProject as Mock).mockResolvedValueOnce({
      project: 'Demo', outcome: 'written', dryRun: false,
    });

    await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });

    // The stand-up curateProject call must have received corrections as its 8th positional arg.
    const call = (curateProject as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![7]).toEqual(['stop tracking X']);
  });

  it('no-wiki fallback, failure leg — curateProject error → FIRST_CURATION_FAILED response and failed row', async () => {
    const { deps } = makeDeps();

    // First call: no-wiki; curateProject will fail so no second call is made.
    (curateRequestedPage as Mock)
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'no-wiki',
        dryRun: false,
      });

    (curateProject as Mock).mockResolvedValueOnce({
      project: 'Demo', outcome: 'error', detail: 'engine down', dryRun: false,
    });

    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('FIRST_CURATION_FAILED');

    const row = deps.db!.prepare(`SELECT status, error FROM page_requests WHERE id = ?`).get(res.request_id) as { status: string; error: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/first curation failed/i);
  });

  it('no-wiki fallback on a registered topic stands the wiki up via curateTopic, not curateProject', async () => {
    const { deps } = makeDeps();
    registerWikiRoot(deps.db!, {
      root_title: 'Owls', root_node_id: 'n1', kind: 'topic', source: 'vault+web',
      cadence: '14d', brief: 'the topic', created_at: '2026-06-26T00:00:00Z', created_by: null,
    });
    (curateRequestedPage as Mock)
      .mockResolvedValueOnce({
        project: 'Owls', requestedTitle: 'Updates', qualifiedTitle: 'Owls — Updates',
        outcome: 'no-wiki', dryRun: false,
      })
      .mockResolvedValueOnce({
        project: 'Owls', requestedTitle: 'Updates', qualifiedTitle: 'Owls — Updates',
        outcome: 'written', nodeId: 'pg3', dryRun: false,
        usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.001,
      });

    const res = await requestWikiPage(deps, { project: 'Owls', title: 'Updates', mode: 'immediate' });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('fulfilled');
    expect(curateProject).not.toHaveBeenCalled();
    expect(curateTopic).toHaveBeenCalledTimes(1);
    const call = (curateTopic as Mock).mock.calls[0];
    expect(call).toBeDefined();
    // Root carries the registered node id; spec comes straight from the row.
    expect(call![3]).toMatchObject({ id: 'n1', title: 'Owls' });
    expect(call![4]).toEqual({ brief: 'the topic', source: 'vault+web', cadence: '14d' });
  });

  it('keeps a registered topic root ID through immediate insertion, stand-up, and retry when its title is ambiguous', async () => {
    const { deps } = makeDeps();
    const topicTitle = 'Owls';
    const rootNodeId = 'topic-root-exact';
    registerWikiRoot(deps.db!, {
      root_title: topicTitle, root_node_id: rootNodeId, kind: 'topic', source: 'vault',
      cadence: null, brief: 'the topic', created_at: '2026-06-26T00:00:00Z', created_by: null,
    });

    let wikiReady = false;
    const projectEvidence = vi.mocked(deps.engine.projectEvidence);
    projectEvidence.mockImplementation(async (selector: string) => {
      if (selector !== rootNodeId) throw new Error(`ambiguous title lookup: ${selector}`);
      return {
        project: { id: rootNodeId, title: topicTitle, file_path: '', status: null },
        existing_wiki: { home_id: wikiReady ? 'topic-home' : null, subpages: [] },
      } as never;
    });
    (curateRequestedPage as Mock).mockImplementation(async (
      engine: CoreDeps['engine'], _llm: unknown, _config: unknown, root: ProjectRef, request: { title: string },
    ): Promise<RequestedPageOutcome> => {
      try {
        const evidence = await engine.projectEvidence(root.id ?? root.title);
        if (!evidence.existing_wiki.home_id) {
          return {
            project: root.title, requestedTitle: request.title, qualifiedTitle: `${root.title} — ${request.title}`,
            outcome: 'no-wiki', dryRun: false,
          };
        }
        return {
          project: root.title, requestedTitle: request.title, qualifiedTitle: `${root.title} — ${request.title}`,
          outcome: 'written', nodeId: 'topic-page', dryRun: false,
        };
      } catch (error) {
        return {
          project: root.title, requestedTitle: request.title, qualifiedTitle: `${root.title} — ${request.title}`,
          outcome: 'error', detail: error instanceof Error ? error.message : String(error), dryRun: false,
        };
      }
    });
    (curateTopic as Mock).mockImplementationOnce(async (
      engine: CoreDeps['engine'], _llm: unknown, _config: unknown, root: ProjectRef,
    ): Promise<CurateResult> => {
      await engine.projectEvidence(root.id ?? root.title);
      wikiReady = true;
      return { project: root.title, outcome: 'written', dryRun: false };
    });

    const res = await requestWikiPage(deps, { project: topicTitle, title: 'Updates', mode: 'immediate' });

    const inserted = deps.db!.prepare(`SELECT project_node_id FROM page_requests WHERE id = ?`)
      .get(res.request_id) as { project_node_id: string | null };
    expect(inserted.project_node_id).toBe(rootNodeId);
    expect(res).toMatchObject({ ok: true, status: 'fulfilled' });
    expect(vi.mocked(curateRequestedPage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(curateRequestedPage).mock.calls.every(call => call[3]?.id === rootNodeId)).toBe(true);
    expect(vi.mocked(curateTopic)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(curateTopic).mock.calls[0]?.[3]).toMatchObject({ id: rootNodeId, title: topicTitle });
    expect(projectEvidence).toHaveBeenCalledWith(rootNodeId);
    expect(projectEvidence.mock.calls.every(call => call[0] === rootNodeId)).toBe(true);
  });

  it('rejects a request named after a retired spine label (bare form)', async () => {
    const { deps } = makeDeps();
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'Task Board', mode: 'immediate' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('RESERVED_TITLE');
    // Nothing inserted, nothing curated.
    expect(deps.db!.prepare(`SELECT COUNT(*) AS c FROM page_requests`).get()).toEqual({ c: 0 });
    expect(vi.mocked(curateRequestedPage)).not.toHaveBeenCalled();
  });

  it('rejects a request named after a retired spine label (qualified form)', async () => {
    const { deps } = makeDeps();
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'Demo — Meetings', mode: 'next-run' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('RESERVED_TITLE');
    expect(deps.db!.prepare(`SELECT COUNT(*) AS c FROM page_requests`).get()).toEqual({ c: 0 });
  });

  it('threads the wiki root source (vault+web) into curateRequestedPage', async () => {
    const { deps } = makeDeps();
    registerWikiRoot(deps.db!, { root_title: 'The 2026 Metro Owls', root_node_id: 'n1', kind: 'topic', source: 'vault+web', cadence: null, brief: 'b', created_at: '2026-06-26T00:00:00Z', created_by: null });
    const res = await requestWikiPage(deps, { project: 'The 2026 Metro Owls', title: 'Updates', mode: 'immediate' });
    expect(res.ok).toBe(true);
    const call = (curateRequestedPage as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![6]).toBe('vault+web');
  });

  it('passes source vault for a project with no wiki-root registration', async () => {
    const { deps } = makeDeps();
    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });
    expect(res.ok).toBe(true);
    const call = (curateRequestedPage as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![6]).toBe('vault');
  });

  it('does not re-fulfill a row a concurrent sweep already drained (no double synthesis)', async () => {
    const { deps } = makeDeps();
    // Block the queue so requestWikiPage's thunk queues behind us.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blocker = deps.queue.enqueue('blocker', async () => { await gate; });

    const pending = requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });
    // Give requestWikiPage time to insert its row and enqueue behind the blocker.
    // Poll instead of vi.waitFor in case the vitest version doesn't support it.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (pendingRequests(deps.db!, 'Demo').length >= 1) { resolve(); return; }
        setTimeout(check, 5);
      };
      check();
    });
    const rowId = pendingRequests(deps.db!, 'Demo')[0]!.id;
    // Simulate the sweep ahead of us fulfilling the row.
    markRequestFulfilled(deps.db!, rowId, 'Demo — ID Check Pilot', 'n_sweep', '2026-06-11T00:00:00Z');
    release();
    await blocker;

    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.status).toBe('fulfilled');
    expect(res.page?.node_id).toBe('n_sweep');
    // The short-circuit must not have run synthesis or recorded a run row.
    expect(vi.mocked(curateRequestedPage)).not.toHaveBeenCalled();
    const runs = deps.db!.prepare(`SELECT outcome FROM runs WHERE outcome LIKE 'requested_page%'`).all();
    expect(runs).toHaveLength(0);
  });

  it('immediate mode sets run attribution context around the fulfillment and clears it after', async () => {
    const { deps } = makeDeps();
    const setContext = vi.fn();
    deps.usage = { setContext } as unknown as CoreDeps['usage'];

    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });

    expect(res.ok).toBe(true);
    expect(setContext).toHaveBeenCalledTimes(2);
    expect(setContext.mock.calls[0]![0]).toMatchObject({ project: 'Demo' });
    expect(typeof setContext.mock.calls[0]![0].runRef).toBe('string');
    expect(setContext.mock.calls[1]![0]).toBeNull();
  });

  it('immediate mode keeps run attribution set through the no-wiki stand-up fallback', async () => {
    const { deps } = makeDeps();
    const setContext = vi.fn();
    deps.usage = { setContext } as unknown as CoreDeps['usage'];

    (curateRequestedPage as Mock)
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'no-wiki',
        dryRun: false,
      })
      .mockResolvedValueOnce({
        project: 'Demo', requestedTitle: 'ID Check Pilot',
        qualifiedTitle: 'Demo — ID Check Pilot', outcome: 'written',
        nodeId: 'pg2', dryRun: false,
        usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.001,
      });
    (curateProject as Mock).mockResolvedValueOnce({
      project: 'Demo', outcome: 'written', dryRun: false,
    });

    const res = await requestWikiPage(deps, { project: 'Demo', title: 'ID Check Pilot', mode: 'immediate' });

    expect(res.ok).toBe(true);
    // Set once at the start of the thunk (covers both fulfillOne calls and the
    // stand-up curation), cleared once at the end — never reset mid-thunk.
    expect(setContext).toHaveBeenCalledTimes(2);
    expect(setContext.mock.calls[0]![0]).toMatchObject({ project: 'Demo' });
    expect(setContext.mock.calls[1]![0]).toBeNull();
  });
});

describe('runSweep — topic wikis', () => {
  it('the wiki-mode off gate prevents all topic refresh source, web, and assessment work', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWebTopic(db, 'Off Topic');
    const engine = {
      listActiveProjects: vi.fn(async () => []),
      projectEvidence: vi.fn(async () => freshWikiEvidence('Off Topic')),
      getNode: vi.fn(async () => { throw new Error('must not read'); }),
      webSearch: vi.fn(async () => { throw new Error('must not search'); }),
    };
    const llm = { structuredCall: vi.fn(async () => { throw new Error('must not assess'); }) };
    const d: CoreDeps = {
      engine: engine as never,
      llm,
      config: makeConfig({ wikiReconciliationMode: 'off', topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
    };

    await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(engine.projectEvidence).not.toHaveBeenCalled();
    expect(engine.getNode).not.toHaveBeenCalled();
    expect(engine.webSearch).not.toHaveBeenCalled();
    expect(llm.structuredCall).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ['manual force', { force: true, trigger: 'on-demand' as const }, new Date().toISOString()],
    ['scheduled force', { force: true, trigger: 'scheduled' as const }, new Date().toISOString()],
    ['cadence due', { force: false, trigger: 'scheduled' as const }, '2026-01-01T00:00:00.000Z'],
  ])('%s bypasses source, web, and assessment effects', async (_label, request, curatedAt) => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWebTopic(db, 'Bypass Topic');
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence('Bypass Topic', curatedAt)),
      getNode: vi.fn(async () => { throw new Error('must not read'); }),
      webSearch: vi.fn(async () => { throw new Error('must not search'); }),
    };
    const llm = { structuredCall: vi.fn(async () => { throw new Error('must not assess'); }) };
    const d: CoreDeps = {
      engine: engine as never,
      llm,
      config: makeConfig({ topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
    };

    await curateTopicTimed(
      d,
      { id: 'root-Bypass Topic', title: 'Bypass Topic', file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, ...request },
    );

    expect(engine.getNode).not.toHaveBeenCalled();
    expect(engine.webSearch).not.toHaveBeenCalled();
    expect(llm.structuredCall).not.toHaveBeenCalled();
    db.close();
  });

  it.each([false, true])('ignores persisted observed journals without changing the baseline (dryRun=%s)', async dryRun => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Journal Feedback';
    registerWebTopic(db, title);
    const journal = committedProjection('journal', 'Curator Journal — 2026-09');
    commitTopicRefreshBaseline(db, {
      rootTitle: title, sourceProjections: [journal], observedSourceNodeIds: ['journal'],
      sourceCommittedAt: REFRESH_TS,
    });
    const before = observedTopicRefreshSources(db, title);
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence(title)),
      getNode: vi.fn(async () => ({
        id: 'journal', title: journal.titleAtCommit, types: ['note'], fields: {}, body: 'new journal entry',
      })),
      webSearch: vi.fn(async () => []),
    };
    const llm = { structuredCall: vi.fn() };
    const d: CoreDeps = {
      engine: engine as never, llm: llm as never,
      config: makeConfig({ topicEarlyRefreshEnabled: true }), queue: new CurationQueue(), db,
    };
    try {
      const result = await curateTopicTimed(d,
        { id: `root-${title}`, title, file_path: '', status: null },
        { source: 'vault+web', cadence: '7d' },
        { dryRun, force: false, trigger: 'scheduled' });
      expect(result).toMatchObject({ outcome: 'skipped_cadence_not_due', refreshTrigger: 'not_due' });
      expect(engine.getNode).not.toHaveBeenCalled();
      expect(llm.structuredCall).not.toHaveBeenCalled();
      expect(curateTopic).not.toHaveBeenCalled();
      expect(observedTopicRefreshSources(db, title)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('passes changed observed IDs as priority evidence on vault-source admission', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWebTopic(db, 'Vault Change');
    const prior = committedProjection('observed-1');
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Vault Change', sourceProjections: [prior], observedSourceNodeIds: ['observed-1'],
      sourceCommittedAt: REFRESH_TS,
    });
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence('Vault Change')),
      getNode: vi.fn(async () => ({
        id: 'observed-1', title: 'Changed source', types: ['note'], fields: {}, body: 'changed body',
      })),
      webSearch: vi.fn(async () => []),
    };
    const d: CoreDeps = {
      engine: engine as never,
      llm: {} as never,
      config: makeConfig({ topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
    };

    await curateTopicTimed(
      d,
      { id: 'root-Vault Change', title: 'Vault Change', file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: false, trigger: 'scheduled' },
    );

    const opts = (curateTopic as Mock).mock.calls[0]?.[5];
    expect(opts).toMatchObject({
      prioritySourceNodeIds: ['observed-1'],
      admission: { trigger: 'vault_source_changed', changedSourceNodeIds: ['observed-1'] },
    });
    expect(engine.webSearch).not.toHaveBeenCalled();
    db.close();
  });

  it('passes the admitted canonical probe into a web-material topic run', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWebTopic(db, 'Web Change');
    const committed = canonicalProbe('https://example.com/old');
    const current = canonicalProbe('https://example.com/new');
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Web Change', sourceProjections: [], observedSourceNodeIds: [],
      sourceCommittedAt: REFRESH_TS, webProbe: committed, webCommittedAt: REFRESH_TS,
    });
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence('Web Change')),
      webSearch: vi.fn(async () => current.results),
    };
    const llm = { structuredCall: vi.fn(async () => ({
      output: { verdict: 'material', reasonCode: 'new_development', changedUrls: [current.results[0]!.url] },
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
    })) };
    const d: CoreDeps = {
      engine: engine as never,
      llm,
      config: makeConfig({ topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
    };

    await curateTopicTimed(
      d,
      { id: 'root-Web Change', title: 'Web Change', file_path: '', status: null },
      { source: 'vault+web', cadence: '7d', brief: 'Brief Web Change' },
      { dryRun: false, force: false, trigger: 'scheduled' },
    );

    expect((curateTopic as Mock).mock.calls[0]?.[5]).toMatchObject({
      admission: { trigger: 'web_material_change', webProbe: current },
    });
    db.close();
  });

  it('records committed and current web hashes privately for scheduled topic orchestration', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Run Hash Evidence';
    registerWebTopic(db, title);
    const committed = canonicalProbe('https://example.com/committed-old');
    const current = canonicalProbe('https://example.com/current-new');
    commitTopicRefreshBaseline(db, {
      rootTitle: title,
      sourceProjections: [],
      observedSourceNodeIds: [],
      sourceCommittedAt: REFRESH_TS,
      webProbe: committed,
      webCommittedAt: REFRESH_TS,
    });
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence(title)),
      webSearch: vi.fn(async () => current.results),
    };
    const llm = { structuredCall: vi.fn(async () => ({
      output: {
        verdict: 'material',
        reasonCode: 'new_development',
        changedUrls: [current.results[0]!.url],
      },
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
    })) };
    const d: CoreDeps = {
      engine: engine as never,
      llm,
      config: makeConfig({ topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d', brief: `Brief ${title}` },
      { dryRun: false, force: false, trigger: 'scheduled' },
    );
    const run = recentRuns(db, 1)[0]!;
    const refreshEvidence = JSON.parse(run.refresh_evidence_json ?? '{}');

    expect(refreshEvidence).toMatchObject({
      committed_web_hash: committed.hash,
      current_web_hash: current.hash,
    });
    expect(result).not.toHaveProperty('committedWebHash');
    expect(result).not.toHaveProperty('currentWebHash');
    db.close();
  });

  it('returns bounded source/web warnings, leaves pending requests queued, and restores recorder context', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWebTopic(db, 'Unavailable Topic');
    const committed = canonicalProbe('https://example.com/old');
    const projection = committedProjection('source-1');
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Unavailable Topic', sourceProjections: [projection], observedSourceNodeIds: ['source-1'],
      sourceCommittedAt: REFRESH_TS, webProbe: committed, webCommittedAt: REFRESH_TS,
    });
    insertPageRequest(db, {
      project_node_id: 'root-Unavailable Topic', project_title: 'Unavailable Topic', title: 'Pending',
      page_title: 'Unavailable Topic — Pending', brief: null, requested_by: null, created_at: REFRESH_TS,
    });
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence('Unavailable Topic')),
      getNode: vi.fn(async () => { throw new EngineError('INTERNAL_ERROR', 'offline'); }),
      webSearch: vi.fn(async () => { throw new Error('offline'); }),
    };
    const setContext = vi.fn();
    const d: CoreDeps = {
      engine: engine as never,
      llm: {} as never,
      config: makeConfig({ topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
      recorder: { setContext, summary: vi.fn(), record: vi.fn() } as never,
    };

    const result = await curateTopicTimed(
      d,
      { id: 'root-Unavailable Topic', title: 'Unavailable Topic', file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: false, trigger: 'scheduled' },
    ) as CurateResult & { refreshWarnings?: string[] };

    expect(result).toMatchObject({ outcome: 'skipped_cadence_not_due' });
    expect(result.refreshWarnings).toEqual(['source_read_unavailable', 'web_probe_unavailable']);
    expect(curateRequestedPage).not.toHaveBeenCalled();
    expect(pendingRequests(db, 'Unavailable Topic')).toHaveLength(1);
    expect(setContext.mock.calls.at(-1)?.[0]).toBeNull();
    db.close();
  });

  it('dry-run makes no assessment call or commit, while live assessment is sanitized, cached, and attributed', async () => {
    const makeAdmissionDeps = (dryRun: boolean) => {
      const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
      registerWebTopic(db, dryRun ? 'Dry Assessment' : 'Live Assessment');
      const title = dryRun ? 'Dry Assessment' : 'Live Assessment';
      const committed = canonicalProbe('https://example.com/old');
      const current = canonicalProbe('https://example.com/new');
      commitTopicRefreshBaseline(db, {
        rootTitle: title, sourceProjections: [], observedSourceNodeIds: [], sourceCommittedAt: REFRESH_TS,
        webProbe: committed, webCommittedAt: REFRESH_TS,
      });
      const recordUsage = vi.fn(async () => undefined);
      const engine = {
        projectEvidence: vi.fn(async () => freshWikiEvidence(title)),
        webSearch: vi.fn(async () => current.results),
        recordUsage,
      };
      const rawLlm = { structuredCall: vi.fn(async () => ({
        output: { verdict: 'material', reasonCode: 'new_development', changedUrls: ['https://outside.example/'] },
        usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
      })) };
      const usage = new UsageReporter(engine as never, { provider: 'anthropic', experiment: null, variant: null });
      const d: CoreDeps = {
        engine: engine as never,
        llm: usage.wrap(rawLlm),
        usage,
        config: makeConfig({ topicEarlyRefreshEnabled: true }),
        queue: new CurationQueue(),
        db,
      };
      return { db, title, current, d, recordUsage, rawLlm };
    };

    const dry = makeAdmissionDeps(true);
    await curateTopicTimed(
      dry.d,
      { id: `root-${dry.title}`, title: dry.title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: true, force: false, trigger: 'scheduled' },
    );
    expect(topicRefreshState(dry.db, dry.title)).toMatchObject({ last_probe_hash: null, source_committed_at: REFRESH_TS });
    expect(dry.rawLlm.structuredCall).not.toHaveBeenCalled();
    dry.db.close();

    const live = makeAdmissionDeps(false);
    const liveResult = await curateTopicTimed(
      live.d,
      { id: `root-${live.title}`, title: live.title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: false, trigger: 'scheduled' },
    );
    expect(topicRefreshState(live.db, live.title)).toMatchObject({
      last_probe_hash: live.current.hash,
      last_probe_verdict: 'uncertain',
      last_probe_reason_code: 'insufficient_evidence',
      last_probe_changed_urls_json: '[]',
    });
    expect(live.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'topic-refresh-assessment',
      source_ref: live.title,
      run_ref: liveResult.runRef,
    }));
    live.db.close();
  });

  it('fails an assessment closed with a bounded warning and restores usage and recorder contexts', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Assessment Failure';
    registerWebTopic(db, title);
    const committed = canonicalProbe('https://example.com/old');
    const current = canonicalProbe('https://example.com/new');
    commitTopicRefreshBaseline(db, {
      rootTitle: title, sourceProjections: [], observedSourceNodeIds: [], sourceCommittedAt: REFRESH_TS,
      webProbe: committed, webCommittedAt: REFRESH_TS,
    });
    const engine = {
      projectEvidence: vi.fn(async () => freshWikiEvidence(title)),
      webSearch: vi.fn(async () => current.results),
    };
    const usageContext = vi.fn();
    const recorderContext = vi.fn();
    const d: CoreDeps = {
      engine: engine as never,
      llm: { structuredCall: vi.fn(async () => { throw new Error('provider unavailable'); }) },
      usage: { setContext: usageContext } as never,
      recorder: { setContext: recorderContext, summary: vi.fn(), record: vi.fn() } as never,
      config: makeConfig({ topicEarlyRefreshEnabled: true }),
      queue: new CurationQueue(),
      db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: false, trigger: 'scheduled' },
    ) as CurateResult & { refreshWarnings?: string[] };

    expect(result).toMatchObject({
      outcome: 'skipped_cadence_not_due',
      refreshWarnings: ['assessment_failed'],
    });
    expect(usageContext.mock.calls.some(call => call[0]?.purpose === 'topic-refresh-assessment')).toBe(true);
    expect(usageContext.mock.calls.at(-1)?.[0]).toBeNull();
    expect(recorderContext.mock.calls.at(-1)?.[0]).toBeNull();
    db.close();
  });

  it('shares one novel-assessment cap across a sweep and retries capped topics next sweep', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const topics = ['Cached', 'Unchanged', 'Cadence', 'Novel A', 'Novel B'];
    for (const title of topics) registerWebTopic(db, title);
    const currentByTitle = new Map<string, CanonicalWebProbe>();
    for (const title of topics) {
      const committed = canonicalProbe(`https://example.com/${title}/old`);
      const current = title === 'Unchanged' ? committed : canonicalProbe(`https://example.com/${title}/new`);
      currentByTitle.set(title, current);
      commitTopicRefreshBaseline(db, {
        rootTitle: title, sourceProjections: [], observedSourceNodeIds: [], sourceCommittedAt: REFRESH_TS,
        webProbe: committed, webCommittedAt: REFRESH_TS,
      });
    }
    storeTopicProbeCache(db, {
      rootTitle: 'Cached', probe: currentByTitle.get('Cached')!,
      assessment: { verdict: 'immaterial', reasonCode: 'restatement', changedUrls: [] },
      assessedAt: REFRESH_TS,
    });
    const engine = {
      listActiveProjects: vi.fn(async () => []),
      projectEvidence: vi.fn(async (selector: string) => {
        const title = selector.replace(/^root-/, '');
        return freshWikiEvidence(title, title === 'Cadence' ? '2026-01-01T00:00:00.000Z' : new Date().toISOString());
      }),
      webSearch: vi.fn(async (query: string) => {
        const title = topics.find(candidate => query.startsWith(candidate));
        return title === undefined ? [] : currentByTitle.get(title)!.results;
      }),
    };
    const llm = { structuredCall: vi.fn(async () => ({
      output: { verdict: 'immaterial', reasonCode: 'restatement', changedUrls: [] },
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
    })) };
    const d: CoreDeps = {
      engine: engine as never,
      llm,
      config: makeConfig({ topicEarlyRefreshEnabled: true, topicEarlyRefreshAssessmentCap: 1 }),
      queue: new CurationQueue(),
      db,
    };

    const first = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(first.find(result => result.project === 'Novel B')).toMatchObject({
      outcome: 'skipped_cadence_not_due',
      refreshWarnings: ['assessment_cap_exhausted'],
    });

    await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(llm.structuredCall).toHaveBeenCalledTimes(2);
    expect((curateTopic as Mock).mock.calls.filter(call => call[3]?.title === 'Cadence')).toHaveLength(2);
    db.close();
  });

  it('commits written live baselines before deferred memory persistence and preserves web on unavailable refresh', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWebTopic(db, 'Commit Topic');
    const oldWeb = canonicalProbe('https://example.com/old');
    commitTopicRefreshBaseline(db, {
      rootTitle: 'Commit Topic', sourceProjections: [], observedSourceNodeIds: [], sourceCommittedAt: REFRESH_TS,
      webProbe: oldWeb, webCommittedAt: REFRESH_TS,
    });
    const projection = committedProjection('new-source', 'New source', 'new body');
    const persistMemories = vi.fn(async () => {
      expect(observedTopicRefreshSources(db, 'Commit Topic').map(row => row.node_id)).toEqual(['new-source']);
      return [{ content: 'remembered', action: 'created' as const }];
    });
    (curateTopic as Mock).mockResolvedValueOnce({
      project: 'Commit Topic', outcome: 'written', dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [projection], observedSourceNodeIds: ['new-source'], persistMemories,
      },
    });
    const engine = { projectEvidence: vi.fn(async () => freshWikiEvidence('Commit Topic')) };
    const d: CoreDeps = {
      engine: engine as never, llm: {} as never, config: makeConfig(), queue: new CurationQueue(), db,
    };

    const result = await curateTopicTimed(
      d,
      { id: 'root-Commit Topic', title: 'Commit Topic', file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: true, trigger: 'scheduled' },
    );

    expect(result).toMatchObject({ outcome: 'written', memories: [{ action: 'created' }] });
    expect(persistMemories).toHaveBeenCalledOnce();
    expect(topicRefreshState(db, 'Commit Topic')).toMatchObject({ committed_web_hash: oldWeb.hash });
    db.close();
  });

  it.each([
    ['skipped', false],
    ['error', false],
    ['written', true],
  ] as const)('does not commit a %s result when dryRun=%s', async (outcome, dryRun) => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = `${outcome}-${dryRun}`;
    const projection = committedProjection('source');
    (curateTopic as Mock).mockResolvedValueOnce({
      project: title, outcome, dryRun,
      __refreshCommitMaterial: { sourceProjections: [projection], observedSourceNodeIds: ['source'] },
    });
    const d: CoreDeps = {
      engine: {} as never, llm: {} as never, config: makeConfig(), queue: new CurationQueue(), db,
    };

    await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault', cadence: null },
      { dryRun, force: true, trigger: 'on-demand' },
    );

    expect(topicRefreshState(db, title)).toBeUndefined();
    db.close();
  });

  it('preserves a stable-source warning and pending baseline when topic curation errors', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Stable Source Retry';
    const old = committedProjection('old-source');
    commitTopicRefreshBaseline(db, {
      rootTitle: title,
      sourceProjections: [old],
      observedSourceNodeIds: ['old-source'],
      sourceCommittedAt: REFRESH_TS,
    });
    replaceExplicitTopicRefreshSources(db, title, ['explicit-source']);
    (curateTopic as Mock).mockResolvedValueOnce({
      project: title,
      outcome: 'error',
      detail: 'stable topic source unavailable; refresh state unchanged for retry',
      dryRun: false,
      refreshWarnings: ['source_read_unavailable'],
      __refreshCommitMaterial: {
        sourceProjections: [committedProjection('new-source')],
        observedSourceNodeIds: ['new-source'],
      },
    });
    const d: CoreDeps = {
      engine: { projectEvidence: vi.fn(async () => freshWikiEvidence(title)) } as never,
      llm: {} as never,
      config: makeConfig(),
      queue: new CurationQueue(),
      db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault', cadence: null },
      { dryRun: false, force: true, trigger: 'on-demand' },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      refreshWarnings: ['source_read_unavailable'],
    });
    expect(topicRefreshState(db, title)).toMatchObject({
      pending_source_change: 1,
      source_committed_at: REFRESH_TS,
    });
    expect(observedTopicRefreshSources(db, title).map(row => row.node_id)).toEqual(['old-source']);
    db.close();
  });

  it('retries the next scheduled sweep after a live baseline commit fails behind a fresh Engine cadence stamp', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Partial State';
    const old = committedProjection('old-source');
    commitTopicRefreshBaseline(db, {
      rootTitle: title, sourceProjections: [old], observedSourceNodeIds: ['old-source'], sourceCommittedAt: REFRESH_TS,
    });
    db.exec(`CREATE TRIGGER fail_refresh_state BEFORE UPDATE OF source_committed_at ON topic_refresh_state
      BEGIN SELECT RAISE(ABORT, 'refresh state unavailable'); END`);
    const persistMemories = vi.fn(async () => []);
    const written = {
      project: title, outcome: 'written', dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [committedProjection('new-source')],
        observedSourceNodeIds: ['new-source'],
        persistMemories,
      },
    };
    (curateTopic as Mock)
      .mockResolvedValueOnce(written)
      .mockResolvedValueOnce(written);
    const d: CoreDeps = {
      engine: { projectEvidence: vi.fn(async () => freshWikiEvidence(title)) } as never,
      llm: {} as never,
      config: makeConfig(),
      queue: new CurationQueue(),
      db,
    };

    const failed = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: true, trigger: 'on-demand' },
    ) as CurateResult & { refreshWarnings?: string[] };

    expect(failed).toMatchObject({
      outcome: 'error',
      detail: 'wiki content committed but refresh state did not; scheduled retry remains pending',
      refreshWarnings: ['refresh_state_persist_failed'],
    });
    expect(observedTopicRefreshSources(db, title).map(row => row.node_id)).toEqual(['old-source']);
    expect(topicRefreshState(db, title)).toMatchObject({
      pending_baseline_retry: 1,
      source_committed_at: REFRESH_TS,
    });
    expect(persistMemories).not.toHaveBeenCalled();

    db.exec('DROP TRIGGER fail_refresh_state');
    const retried = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: false, trigger: 'scheduled' },
    );

    expect(retried).toMatchObject({ outcome: 'written', refreshTrigger: 'baseline_retry' });
    expect((curateTopic as Mock).mock.calls.at(-1)?.[5]).toMatchObject({
      admission: { trigger: 'baseline_retry' },
    });
    expect(observedTopicRefreshSources(db, title).map(row => row.node_id)).toEqual(['new-source']);
    expect(topicRefreshState(db, title)?.pending_baseline_retry).toBe(0);
    expect(recentRuns(db, 1)[0]?.refresh_trigger).toBe('baseline_retry');
    db.close();
  });

  it('reports manual recovery without attempting baseline commit when durable retry arming fails', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Retry State Unavailable';
    const old = committedProjection('old-source');
    commitTopicRefreshBaseline(db, {
      rootTitle: title,
      sourceProjections: [old],
      observedSourceNodeIds: ['old-source'],
      sourceCommittedAt: REFRESH_TS,
    });
    db.exec(`CREATE TRIGGER fail_retry_arm BEFORE UPDATE OF pending_baseline_retry ON topic_refresh_state
      WHEN NEW.pending_baseline_retry = 1
      BEGIN SELECT RAISE(ABORT, 'retry state unavailable'); END`);
    const persistMemories = vi.fn(async () => []);
    (curateTopic as Mock).mockResolvedValueOnce({
      project: title,
      outcome: 'written',
      dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [committedProjection('new-source')],
        observedSourceNodeIds: ['new-source'],
        persistMemories,
      },
    });
    const d: CoreDeps = {
      engine: {} as never,
      llm: {} as never,
      config: makeConfig(),
      queue: new CurationQueue(),
      db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: true, trigger: 'on-demand' },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      detail: 'wiki content committed but refresh retry state did not; manual recovery required',
      refreshWarnings: ['refresh_state_persist_failed'],
    });
    expect(observedTopicRefreshSources(db, title).map(row => row.node_id)).toEqual(['old-source']);
    expect(topicRefreshState(db, title)?.pending_baseline_retry).toBe(0);
    expect(persistMemories).not.toHaveBeenCalled();
    db.close();
  });

  it('does not rewrite an already-armed baseline retry before committing its successful retry', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Already Armed Retry';
    commitTopicRefreshBaseline(db, {
      rootTitle: title,
      sourceProjections: [],
      observedSourceNodeIds: [],
      sourceCommittedAt: REFRESH_TS,
    });
    db.prepare(`
      UPDATE topic_refresh_state SET pending_baseline_retry = 1 WHERE root_title = ?
    `).run(title);
    db.exec(`CREATE TRIGGER reject_redundant_retry_arm
      BEFORE UPDATE OF pending_baseline_retry ON topic_refresh_state
      WHEN NEW.pending_baseline_retry = 1
      BEGIN SELECT RAISE(ABORT, 'retry is already armed'); END`);
    (curateTopic as Mock).mockResolvedValueOnce({
      project: title,
      outcome: 'written',
      dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [committedProjection('source')],
        observedSourceNodeIds: ['source'],
      },
    });
    const d: CoreDeps = {
      engine: {} as never,
      llm: {} as never,
      config: makeConfig(),
      queue: new CurationQueue(),
      db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault+web', cadence: '7d' },
      { dryRun: false, force: true, trigger: 'on-demand' },
    );

    expect(result.outcome).toBe('written');
    expect(topicRefreshState(db, title)?.pending_baseline_retry).toBe(0);
    db.close();
  });

  it('does not add scheduled retry-state writes to vault-only topic reconciliation', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Vault Only';
    commitTopicRefreshBaseline(db, {
      rootTitle: title,
      sourceProjections: [],
      observedSourceNodeIds: [],
      sourceCommittedAt: REFRESH_TS,
    });
    db.exec(`CREATE TRIGGER reject_retry_arm BEFORE UPDATE OF pending_baseline_retry ON topic_refresh_state
      WHEN NEW.pending_baseline_retry = 1
      BEGIN SELECT RAISE(ABORT, 'retry state must remain untouched'); END`);
    (curateTopic as Mock).mockResolvedValueOnce({
      project: title,
      outcome: 'written',
      dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [committedProjection('source')],
        observedSourceNodeIds: ['source'],
      },
    });
    const d: CoreDeps = {
      engine: {} as never,
      llm: {} as never,
      config: makeConfig(),
      queue: new CurationQueue(),
      db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault', cadence: null },
      { dryRun: false, force: true, trigger: 'on-demand' },
    );

    expect(result.outcome).toBe('written');
    db.close();
  });

  it('does not let a deferred memory failure redefine successful baseline persistence', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    const title = 'Memory Failure';
    const projection = committedProjection('source');
    (curateTopic as Mock).mockResolvedValueOnce({
      project: title, outcome: 'written', dryRun: false,
      __refreshCommitMaterial: {
        sourceProjections: [projection], observedSourceNodeIds: ['source'],
        persistMemories: vi.fn(async () => { throw new Error('memory unavailable'); }),
      },
    });
    const d: CoreDeps = {
      engine: {} as never, llm: {} as never, config: makeConfig(), queue: new CurationQueue(), db,
    };

    const result = await curateTopicTimed(
      d,
      { id: `root-${title}`, title, file_path: '', status: null },
      { source: 'vault', cadence: null },
      { dryRun: false, force: true, trigger: 'on-demand' },
    );

    expect(result.outcome).toBe('written');
    expect(observedTopicRefreshSources(db, title).map(row => row.node_id)).toEqual(['source']);
    db.close();
  });

  it('curates registered topic wikis via curateTopic after the project loop', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWikiRoot(db, { root_title: 'The 2026 Metro Owls', root_node_id: 'n1', kind: 'topic', source: 'vault', cadence: null, brief: 'b', created_at: '2026-06-26T00:00:00Z', created_by: null });
    const active: ProjectRef[] = [{ id: 'p', title: 'A', file_path: '', status: 'open' }];
    const d = { ...deps(active), db };
    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    // 1 project (curateProject mock) + 1 topic (curateTopic mock) — both curated.
    expect(results.map(r => r.project)).toEqual(['A', 'The 2026 Metro Owls']);
    expect(curateTopic).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('skips a paused topic wiki', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWikiRoot(db, { root_title: 'Paused Topic', root_node_id: 'n2', kind: 'topic', source: 'vault', cadence: null, brief: null, created_at: '2026-06-26T00:00:00Z', created_by: null });
    setPaused(db, 'Paused Topic', true, null, '2026-06-26T00:00:00Z');
    const d = { ...deps([]), db };
    const results = await runSweep(d, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(results).toEqual([]);
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('skips a topic wiki created paused while the sweep was curating projects (#387)', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    (curateProject as Mock).mockImplementationOnce(async () => {
      // As create-or-update-wiki with paused:true does: registered and paused in one transaction.
      db.transaction(() => {
        registerWikiRoot(db, { root_title: 'New Topic', root_node_id: 'n3', kind: 'topic', source: 'vault+web', cadence: null, brief: null,
          created_at: '2026-11-09T00:00:00Z', created_by: null });
        setPaused(db, 'New Topic', true, null, '2026-11-09T00:00:00Z');
      })();
      return { project: 'A', outcome: 'written', dryRun: false };
    });
    const d = { ...deps([{ id: 'p', title: 'A', file_path: '', status: 'open' }]), db };
    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results.map(r => r.project)).toEqual(['A']);
    expect(curateTopic).not.toHaveBeenCalled();
    db.close();
  });

  it('defers pending page requests for a fresh scheduled web topic until its cadence is due', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWikiRoot(db, { root_title: 'Weekly Topic', root_node_id: 'topic-1', kind: 'topic', source: 'vault+web', cadence: '7d', brief: null, created_at: '2026-06-26T00:00:00Z', created_by: null });
    insertPageRequest(db, {
      project_node_id: 'topic-1', project_title: 'Weekly Topic', title: 'Update', page_title: 'Weekly Topic — Update',
      brief: null, requested_by: null, created_at: '2026-08-27T00:00:00Z',
    });
    const engine = {
      listActiveProjects: vi.fn(async () => []),
      projectEvidence: vi.fn(async () => ({
        existing_wiki: {
          home_id: 'home', home: { id: 'home', version: 1, wiki_curated_at: new Date().toISOString() },
          topology_hash: 'topology', catalog_valid: true, subpages: [],
        },
      })),
    };
    const d: CoreDeps = { engine: engine as never, llm: {} as never, config: makeConfig(), queue: new CurationQueue(), db };

    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(results).toMatchObject([{ project: 'Weekly Topic', outcome: 'skipped_cadence_not_due' }]);
    expect(curateRequestedPage).not.toHaveBeenCalled();
    expect(curateTopic).not.toHaveBeenCalled();
    expect(pendingRequests(db, 'Weekly Topic')).toHaveLength(1);
    db.close();
  });

  it('defers pending page requests when scheduled web-topic cadence admission fails', async () => {
    const db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'A', 'B', 'Project', 'Stale', 'Fresh', 'Done');
    registerWikiRoot(db, { root_title: 'Weekly Topic', root_node_id: 'topic-1', kind: 'topic', source: 'vault+web', cadence: '7d', brief: null, created_at: '2026-06-26T00:00:00Z', created_by: null });
    insertPageRequest(db, {
      project_node_id: 'topic-1', project_title: 'Weekly Topic', title: 'Update', page_title: 'Weekly Topic — Update',
      brief: null, requested_by: null, created_at: '2026-08-27T00:00:00Z',
    });
    const engine = {
      listActiveProjects: vi.fn(async () => []),
      projectEvidence: vi.fn(async () => { throw new Error('Engine unavailable'); }),
    };
    const d: CoreDeps = { engine: engine as never, llm: {} as never, config: makeConfig(), queue: new CurationQueue(), db };

    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(results).toMatchObject([{ project: 'Weekly Topic', outcome: 'error', detail: 'cadence admission: Engine unavailable' }]);
    expect(curateRequestedPage).not.toHaveBeenCalled();
    expect(curateTopic).not.toHaveBeenCalled();
    expect(pendingRequests(db, 'Weekly Topic')).toHaveLength(1);
    db.close();
  });
});

describe('pending fulfillment for topic wikis', () => {
  const registerOwls = (deps: CoreDeps) => registerWikiRoot(deps.db!, {
    root_title: 'Owls', root_node_id: 'n1', kind: 'topic', source: 'vault',
    cadence: null, brief: 'b', created_at: '2026-06-26T00:00:00Z', created_by: null,
  });
  const queueOwlsRequest = (deps: CoreDeps) => insertPageRequest(deps.db!, {
    project_node_id: 'n1', project_title: 'Owls', title: 'Updates',
    page_title: 'Owls — Updates', brief: null, requested_by: null,
    created_at: '2026-07-04T00:00:00Z',
  });

  it('the sweep drains a pending topic request before curateTopic and pins it', async () => {
    const { deps } = makeDeps();
    registerOwls(deps);
    queueOwlsRequest(deps);
    const projectEvidence = vi.mocked(deps.engine.projectEvidence);
    projectEvidence.mockImplementation(async selector => {
      if (selector !== 'n1') throw new Error(`ambiguous title lookup: ${selector}`);
      return {
        existing_wiki: {
          home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'topology', catalog_valid: true,
          subpages: [{
            id: 'pg1', title: 'Owls — Updates', file_path: 'Wikis/Owls — Updates.md', version: 1,
            content_hash: 'body', wiki_state: 'active', wiki_origin: 'requested', wiki_pinned: true,
          }],
        },
      } as never;
    });
    await runSweep(deps, { dryRun: false, force: true, trigger: 'scheduled' });
    expect(pendingRequests(deps.db!, 'Owls')).toEqual([]);
    const reqCall = (curateRequestedPage as Mock).mock.invocationCallOrder[0];
    const topicCall = (curateTopic as Mock).mock.invocationCallOrder[0];
    expect(reqCall).toBeDefined();
    expect(topicCall).toBeDefined();
    expect(reqCall!).toBeLessThan(topicCall!);
    // Pin handoff remains explicit inside curateTopic's options object.
    const call = (curateTopic as Mock).mock.calls[0];
    expect(call).toBeDefined();
    const pinned = (call![5] as { pinnedNodeIds: Set<string> }).pinnedNodeIds;
    expect(pinned).toBeInstanceOf(Set);
    expect(pinned.has('pg1')).toBe(true);
    expect(projectEvidence).toHaveBeenCalledWith('n1');
  });

  it('a sweep-drained request on a vault+web topic threads the web source into curateRequestedPage', async () => {
    const { deps } = makeDeps();
    registerWikiRoot(deps.db!, {
      root_title: 'Owls', root_node_id: 'n1', kind: 'topic', source: 'vault+web',
      cadence: null, brief: 'b', created_at: '2026-06-26T00:00:00Z', created_by: null,
    });
    queueOwlsRequest(deps);
    await runSweep(deps, { dryRun: false, force: true, trigger: 'scheduled' });
    expect(pendingRequests(deps.db!, 'Owls')).toEqual([]);
    const call = (curateRequestedPage as Mock).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![6]).toBe('vault+web');
  });

  it('dry-run suppression — a pending topic request stays pending', async () => {
    const { deps } = makeDeps();
    registerOwls(deps);
    queueOwlsRequest(deps);
    await runSweep(deps, { dryRun: true, force: true, trigger: 'scheduled' });
    expect(curateRequestedPage).not.toHaveBeenCalled();
    expect(pendingRequests(deps.db!, 'Owls')).toHaveLength(1);
  });

  it('no-wiki retry — a request skipped before the first topic build fulfills after it', async () => {
    const { deps } = makeDeps();
    registerOwls(deps);
    queueOwlsRequest(deps);
    (curateRequestedPage as Mock)
      .mockResolvedValueOnce({
        project: 'Owls', requestedTitle: 'Updates', qualifiedTitle: 'Owls — Updates',
        outcome: 'no-wiki', dryRun: false,
      })
      .mockResolvedValueOnce({
        project: 'Owls', requestedTitle: 'Updates', qualifiedTitle: 'Owls — Updates',
        outcome: 'written', nodeId: 'pg9', dryRun: false,
        usage: { input: 5, output: 3, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.001,
      });
    await runSweep(deps, { dryRun: false, force: true, trigger: 'scheduled' });
    expect(curateRequestedPage).toHaveBeenCalledTimes(2);
    expect(pendingRequests(deps.db!, 'Owls')).toEqual([]);
  });
});

describe('pending fulfillment in curateTimed', () => {
  it('curateOne fulfills pending requests before the full curation and pins them', async () => {
    const { deps } = makeDeps();
    insertPageRequest(deps.db!, {
      project_node_id: 'p1', project_title: 'Demo', title: 'ID Check Pilot',
      page_title: 'Demo — ID Check Pilot', brief: null, requested_by: null,
      created_at: '2026-06-11T00:00:00Z',
    });
    await curateOne(deps, 'Demo', { dryRun: false, force: true, trigger: 'cli' });
    expect(pendingRequests(deps.db!, 'Demo')).toEqual([]);
    // The mock for curateRequestedPage was called before curateProject.
    const reqCall = (curateRequestedPage as Mock).mock.invocationCallOrder[0];
    const homeCall = (curateProject as Mock).mock.invocationCallOrder[0];
    expect(reqCall).toBeDefined();
    expect(homeCall).toBeDefined();
    expect(reqCall!).toBeLessThan(homeCall!);
  });

  it('pin set handoff — stable node IDs are passed to curateProject', async () => {
    const { deps } = makeDeps();
    const projectEvidence = vi.mocked(deps.engine.projectEvidence);
    projectEvidence.mockImplementation(async selector => {
      if (selector !== 'p1') throw new Error(`ambiguous title lookup: ${selector}`);
      return {
        existing_wiki: {
          home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'topology', catalog_valid: true,
          subpages: [{
            id: 'pg1', title: 'Demo — ID Check Pilot', file_path: 'Wikis/Demo — ID Check Pilot.md', version: 1,
            content_hash: 'body', wiki_state: 'active', wiki_origin: 'requested', wiki_pinned: true,
          }],
        },
      } as never;
    });
    insertPageRequest(deps.db!, {
      project_node_id: 'p1', project_title: 'Demo', title: 'ID Check Pilot',
      page_title: 'Demo — ID Check Pilot', brief: null, requested_by: null,
      created_at: '2026-06-11T00:00:00Z',
    });
    await curateOne(deps, 'Demo', { dryRun: false, force: true, trigger: 'cli' });
    // 7th argument (index 6) of curateProject is pinned node IDs.
    const call = (curateProject as Mock).mock.calls[0];
    expect(call).toBeDefined();
    const pinnedNodeIds = call![6] as Set<string>;
    expect(pinnedNodeIds).toBeInstanceOf(Set);
    expect(pinnedNodeIds.has('pg1')).toBe(true);
    expect(projectEvidence).toHaveBeenCalledWith('p1');
  });

  it('dry-run suppression — pending requests are not fulfilled when dryRun is true', async () => {
    const { deps } = makeDeps();
    insertPageRequest(deps.db!, {
      project_node_id: 'p1', project_title: 'Demo', title: 'ID Check Pilot',
      page_title: 'Demo — ID Check Pilot', brief: null, requested_by: null,
      created_at: '2026-06-11T00:00:00Z',
    });
    await curateOne(deps, 'Demo', { dryRun: true, force: true, trigger: 'cli' });
    // curateRequestedPage must never be called under dry-run.
    expect(curateRequestedPage).not.toHaveBeenCalled();
    // The row must still be pending.
    expect(pendingRequests(deps.db!, 'Demo')).toHaveLength(1);
  });
});

describe('topic wikis on request (#425)', () => {
  const TOPIC = 'Tidal Power';
  function topicDeps(paused = true) {
    const db = new Database(':memory:'); runMigrations(db);
    registerWikiRoot(db, { root_title: TOPIC, root_node_id: 't-1', kind: 'topic', source: 'vault+web', cadence: '7d',
      brief: 'Tidal energy.', created_at: REFRESH_TS, created_by: 'test' });
    if (paused) setPaused(db, TOPIC, true, 'test', REFRESH_TS);
    const engine = {
      listActiveProjects: vi.fn(async () => [] as ProjectRef[]),
      findNodesByExactTitle: vi.fn(async () => [] as Array<{ id: string; types: string[] }>),
      projectEvidence: vi.fn(async () => freshWikiEvidence(TOPIC)),
      ensureTopicSchema: vi.fn(async () => undefined),
    };
    const kept: Promise<unknown>[] = [];
    const builds = new BackgroundBuilds((work) => { kept.push(work); });
    const d: CoreDeps = { engine: engine as never, llm: {} as never, queue: new CurationQueue(), db, builds,
      config: makeConfig({ activeStatuses: ['open'] }) };
    return { db, engine, d, builds, kept };
  }
  /** A curateTopic that stays running until released. */
  function holdTopic() {
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    (curateTopic as Mock).mockImplementationOnce(async (_e, _l, _c, root: { title: string }, _s, opts: { dryRun: boolean }) => {
      await done;
      return { project: root.title, outcome: 'written', dryRun: opts.dryRun };
    });
    return release;
  }
  const topicCall = (n = 0) => (curateTopic as Mock).mock.calls[n] as [unknown, unknown, unknown, ProjectRef, { brief?: string; source: string }, { dryRun: boolean; force: boolean; scheduled: boolean }];

  it('queues a forced rebuild of a paused topic wiki, which stays paused, and reports a repeat as in progress', async () => {
    const { db, d, builds, kept } = topicDeps();
    const release = holdTopic();
    expect(await startOnDemandCuration(d, builds, { project: TOPIC, force: true, dryRun: false }, 'on-demand'))
      .toMatchObject({ status: 'queued', project: TOPIC, detail: expect.stringMatching(/^Queued a rebuild of the topic wiki "Tidal Power"\. A paused wiki stays paused\. /) });
    for (const [project, dryRun] of [[TOPIC, false], ['t-1', false], [TOPIC, true]] as const) {
      expect(await startOnDemandCuration(d, builds, { project, force: true, dryRun }, 'on-demand')).toMatchObject({ status: 'in_progress' });
    }
    release();
    await kept[0];
    expect(curateTopic).toHaveBeenCalledTimes(1);
    const [, , , root, spec, opts] = topicCall();
    expect(root).toMatchObject({ id: 't-1', title: TOPIC });
    expect(spec).toMatchObject({ brief: 'Tidal energy.', source: 'vault+web', cadence: '7d' });
    expect(opts).toMatchObject({ dryRun: false, force: true, scheduled: false });
    expect(recentRuns(db, 5)).toEqual([expect.objectContaining({ project: TOPIC, trigger: 'on-demand', outcome: 'written', dry_run: 0 })]);
    expect(isPaused(db, TOPIC)).toBe(true);
    expect(builds.get(`project:${TOPIC}`)).toBeUndefined();
    db.close();
  });

  it('answers a paused topic wiki at once without force, and a dry run with force checks it without paying', async () => {
    const { db, d, builds, kept } = topicDeps();
    expect(await startOnDemandCuration(d, builds, { project: TOPIC, force: false, dryRun: false }, 'on-demand'))
      .toEqual([expect.objectContaining({ project: TOPIC, outcome: 'skipped', detail: 'paused' })]);
    expect(await triggerCuration(d, { project: TOPIC, force: false, dryRun: true }, 'on-demand'))
      .toEqual([expect.objectContaining({ outcome: 'skipped', detail: 'paused', dryRun: true })]);
    expect(kept).toHaveLength(0);
    expect(curateTopic).not.toHaveBeenCalled();

    expect(await startOnDemandCuration(d, builds, { project: TOPIC, force: true, dryRun: true }, 'on-demand')).toBeNull();
    await triggerCuration(d, { project: TOPIC, force: true, dryRun: true }, 'on-demand');
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(topicCall()[5]).toMatchObject({ dryRun: true, force: true });
    expect(recentRuns(db, 5).every((run) => run.dry_run === 1)).toBe(true);
    db.close();
  });

  it('runs an unpaused topic wiki on request without force, through the same path', async () => {
    const { db, d, builds, kept } = topicDeps(false);
    expect(await startOnDemandCuration(d, builds, { project: TOPIC, force: false, dryRun: false }, 'on-demand'))
      .toMatchObject({ status: 'queued' });
    await kept[0];
    expect(topicCall()[5]).toMatchObject({ dryRun: false, force: false });
    db.close();
  });

  it('reads the registration again when the build starts: new settings are used, and a removed wiki is not built', async () => {
    const { db, d, builds, kept } = topicDeps();
    let releaseLane!: () => void;
    const lane = d.queue.enqueue('other work', () => new Promise<void>((r) => { releaseLane = r; }));
    await startOnDemandCuration(d, builds, { project: TOPIC, force: true, dryRun: false }, 'on-demand');
    registerWikiRoot(db, { root_title: TOPIC, root_node_id: 't-1', kind: 'topic', source: 'vault', cadence: null,
      brief: 'Tidal and wave energy.', created_at: REFRESH_TS, created_by: 'test' });
    releaseLane(); await lane; await kept[0];
    expect(topicCall()[4]).toMatchObject({ brief: 'Tidal and wave energy.', source: 'vault' });

    const second = d.queue.enqueue('other work', () => new Promise<void>((r) => { releaseLane = r; }));
    await startOnDemandCuration(d, builds, { project: TOPIC, force: true, dryRun: false }, 'on-demand');
    deleteWikiRoot(db, TOPIC);
    releaseLane(); await second; await kept[1];
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(recentRuns(db, 1)).toEqual([expect.objectContaining({ project: TOPIC, outcome: 'error',
      error: '"Tidal Power" was removed before its build started' })]);
    db.close();
  });

  it('refuses a name that reaches both a topic wiki and a renamed project\'s wiki', async () => {
    const { db, d, builds, engine, kept } = topicDeps(false);
    registerWikiRoot(db, { root_title: 'Old Name', root_node_id: 'p-9', kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: REFRESH_TS, created_by: 'test' });
    engine.listActiveProjects.mockResolvedValue([{ id: 'p-9', title: TOPIC, file_path: '', status: 'open' }]);
    for (const dryRun of [false, true]) {
      const res = dryRun ? await triggerCuration(d, { project: TOPIC, force: true, dryRun }, 'on-demand')
        : await startOnDemandCuration(d, builds, { project: TOPIC, force: true, dryRun }, 'on-demand');
      expect(res).toEqual([expect.objectContaining({ outcome: 'error', detail: expect.stringMatching(/^AMBIGUOUS_WIKI/) })]);
    }
    expect(kept).toHaveLength(0);
    expect(curateTopic).not.toHaveBeenCalled();
    expect(curateProject).not.toHaveBeenCalled();
    db.close();
  });

  it('shares create-or-update-wiki\'s queued build: a rebuild asked for while it waits starts nothing', async () => {
    const { db, d, builds, kept } = topicDeps();
    const release = holdTopic();
    expect(await createOrUpdateWiki(d, { topic: TOPIC, brief: 'Tidal and wave energy.', by: null })).toMatchObject({ outcome: 'queued' });
    for (const project of [TOPIC, 't-1']) {
      expect(await startOnDemandCuration(d, builds, { project, force: true, dryRun: false }, 'on-demand')).toMatchObject({ status: 'in_progress' });
    }
    release(); await Promise.all(kept);
    expect(kept).toHaveLength(1);
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(topicCall()[4]).toMatchObject({ brief: 'Tidal and wave energy.' });
    expect(isPaused(db, TOPIC)).toBe(true);
    db.close();
  });

  it('a scheduled sweep still skips the paused topic wiki after a rebuild', async () => {
    const { db, d, builds, kept } = topicDeps();
    await startOnDemandCuration(d, builds, { project: TOPIC, force: true, dryRun: false }, 'on-demand');
    await kept[0];
    expect(curateTopic).toHaveBeenCalledTimes(1);
    const results = await runSweep(d, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results.map((r) => r.project)).not.toContain(TOPIC);
    expect(curateTopic).toHaveBeenCalledTimes(1);
    db.close();
  });
});
