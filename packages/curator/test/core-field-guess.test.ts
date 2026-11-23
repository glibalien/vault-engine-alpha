import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { randomUUIDMock } = vi.hoisted(() => ({ randomUUIDMock: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  randomUUID: randomUUIDMock,
}));

import Database from 'better-sqlite3';
import type { Config } from '../src/config.js';
import { CAPTURE_COVERAGE_SYSTEM_PROMPT } from '../src/conversation-capture-prompts.js';
import { curateOne, runSweep, triggerCuration, type CoreDeps } from '../src/core.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Engine } from '../src/engine.js';
import {
  FIELD_GUESS_ERROR_MAX_CHARS,
  type FieldGuessFieldCandidate,
  type FieldGuessNodeCandidate,
  type FieldGuessSweepResult,
} from '../src/field-guess/types.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { createDispatchingLlmClient } from '../src/llm/index.js';
import type { LlmClient } from '../src/llm/types.js';
import { providerForModel } from '../src/llm/provider-for-model.js';
import { CurationQueue } from '../src/queue.js';
import type { CurateResult, EngineNode, ProjectRef } from '../src/types.js';
import { runMemorySweep } from '../src/memory-sweep.js';
import { UsageReporter } from '../src/usage-reporter.js';
import { enrolProjects } from './project-wiki-fixtures.js';

const { curateProjectMock } = vi.hoisted(() => ({
  curateProjectMock: vi.fn(async (
    _engine: unknown,
    _llm: unknown,
    _config: unknown,
    project: ProjectRef,
    dryRun: boolean,
  ): Promise<CurateResult> => ({ project: project.title, outcome: 'written', dryRun })),
}));

vi.mock('../src/curate.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  curateProject: curateProjectMock,
}));
vi.mock('../src/memory-sweep.js', () => ({ runMemorySweep: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/conversation-sweep.js', () => ({ runConversationSweep: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/org-sweep.js', () => ({ runOrgSweep: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/reconcile.js', () => ({ runReconcile: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/memory-note-refresh.js', () => ({
  runMemoryNoteRefresh: vi.fn(async () => ({
    ran: false,
    file_written: false,
    live_count: 0,
    historical_count: 0,
    total: 0,
    issues_rendered: 0,
    error: null,
  })),
}));

const MODEL = 'accounts/fireworks/models/gpt-oss-120b';
const PROJECT: ProjectRef = {
  id: 'project-1',
  title: 'Newly Active',
  file_path: 'Projects/Newly Active.md',
  status: 'active',
};

const BASE_CONFIG = {
  engineUrl: 'http://localhost:9999',
  engineToken: 'test-token',
  experiment: null,
  variant: null,
  llmKeys: { keys: { anthropic: 'home-key', fireworks: 'fireworks-key' }, baseURLs: {} },
  model: 'claude-sonnet-4-6',
  fieldGuessModel: MODEL,
  fieldGuessModelError: null,
  fieldGuessCap: 25,
  fieldGuessMaxTokens: 2000,
  modelProviders: { 'claude-sonnet-4-6': 'anthropic', [MODEL]: 'fireworks' },
  reasoningEffort: undefined,
  projectHomeProvenanceEnabled: false,
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
  wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
  wikiPlanningReasoningBudget: 0, wikiPageReasoningBudget: 0, wikiHomeReasoningBudget: 0,
  homeMaxTokens: 8192,
  activeStatuses: ['active'],
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
  reconcileEnabled: false,
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
  journalEnabled: false,
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

const STATUS_FIELD: FieldGuessFieldCandidate = {
  field: 'status',
  description: 'Current project status',
  field_type: 'enum',
  list_item_type: null,
  required: true,
  enum_values: ['active', 'backlog'],
  reference_target: null,
  claiming_types: ['Project'],
  eligibility: 'absent',
  definition_hash: 'definition-status-v1',
};

const CANDIDATE: FieldGuessNodeCandidate = {
  node_id: PROJECT.id!,
  title: PROJECT.title,
  file_path: PROJECT.file_path,
  types: ['Project'],
  version: 3,
  content_hash: 'content-hash-1',
  file_mtime: 100,
  fields: [STATUS_FIELD],
};

const FULL_NODE: EngineNode = {
  id: CANDIDATE.node_id,
  title: CANDIDATE.title,
  file_path: CANDIDATE.file_path,
  types: CANDIDATE.types,
  version: CANDIDATE.version,
  fields: {},
  relationships: { outgoing: {}, incoming: {} },
  body: 'This project is being actively implemented.',
  metadata: { content_hash: CANDIDATE.content_hash, file_mtime: CANDIDATE.file_mtime },
};

const databases: Database.Database[] = [];

type HarnessOptions = {
  config?: Partial<Config>;
  db?: false;
  initiallyActive?: boolean;
  candidateMode?: 'empty' | 'pending' | 'failure';
  llm?: LlmClient;
  queue?: CurationQueue;
  order?: string[];
  usage?: CoreDeps['usage'];
  recorder?: CoreDeps['recorder'];
};

function harness(options: HarnessOptions = {}) {
  const order = options.order ?? [];
  let active = options.initiallyActive ?? false;
  const database = options.db === false ? undefined : new Database(':memory:');
  if (database !== undefined) {
    runMigrations(database); enrolProjects(database, 'Newly Active');
    databases.push(database);
  }
  const engine = {
    listFieldGuessCandidates: vi.fn(async () => {
      order.push('field-guess-candidates');
      if (options.candidateMode === 'failure') throw new Error('candidate phase failed');
      if (options.candidateMode === 'pending') {
        return {
          page: { candidates: [], next_cursor: null },
          warnings: [{ code: 'FIELD_PRESENCE_BACKFILL_PENDING', message: 'backfill pending', severity: 'warning' }],
        };
      }
      return {
        page: { candidates: options.candidateMode === 'empty' ? [] : [CANDIDATE], next_cursor: null },
        warnings: [],
      };
    }),
    getNode: vi.fn(async () => FULL_NODE),
    findNodesByExactTitle: vi.fn(async () => []),
    updateNodeFieldsCas: vi.fn(async ({ setFields }: { setFields: Record<string, unknown> }) => {
      order.push('field-guess-commit');
      if (setFields['status'] === 'active') active = true;
      return { updated: true };
    }),
    listActiveProjects: vi.fn(async () => {
      order.push('active-projects');
      return active ? [PROJECT] : [];
    }),
    projectEvidence: vi.fn(async () => ({ existing_wiki: { home_id: null, subpages: [] } })),
    updateNodeFields: vi.fn(async () => undefined),
  };
  const llm = options.llm ?? {
    structuredCall: vi.fn(async () => ({
      output: {
        decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'Implementation is underway.' }],
      },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    })),
  };
  const queue = options.queue ?? new CurationQueue();
  const enqueue = vi.spyOn(queue, 'enqueue');
  const deps: CoreDeps = {
    engine: engine as unknown as Engine,
    llm,
    config: { ...BASE_CONFIG, ...options.config },
    queue,
    ...(database === undefined ? {} : { db: database }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
  };
  return { deps, engine, llm, queue, enqueue, database, order };
}

beforeEach(() => {
  vi.clearAllMocks();
  let uuidCounter = 0;
  randomUUIDMock.mockImplementation(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`);
  curateProjectMock.mockImplementation(async (
    _engine: unknown,
    _llm: unknown,
    _config: unknown,
    project: ProjectRef,
    dryRun: boolean,
  ): Promise<CurateResult> => ({ project: project.title, outcome: 'written', dryRun }));
});

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  vi.restoreAllMocks();
});

describe('runSweep field-guess integration', () => {
  it('contains field-phase runRef entropy failure before phase admission and continues later phases', async () => {
    const entropyMessage = `entropy unavailable: ${'x'.repeat(FIELD_GUESS_ERROR_MAX_CHARS * 2)}`;
    const h = harness({ initiallyActive: true });
    randomUUIDMock.mockImplementationOnce(() => { throw new Error(entropyMessage); });
    h.deps.recorder = new ActionRecorder(h.database!);
    const callback = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: callback,
    });

    expect(results).toEqual([expect.objectContaining({ project: PROJECT.title, outcome: 'written' })]);
    expect(h.enqueue.mock.calls.filter(call => call[0] === 'field-guess-sweep')).toEqual([]);
    expect(h.engine.listFieldGuessCandidates).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
    expect(curateProjectMock).toHaveBeenCalledTimes(1);
    expect(runMemorySweep).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[curator] field guess sweep failed before a phase result was available',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain('entropy unavailable');
    const summaries = h.database!.prepare(`
      SELECT run_ref, trigger, function, kind, detail
      FROM journal_events WHERE function = 'field-guess-sweep' AND kind = 'summary'
    `).all() as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      run_ref: null,
      trigger: 'scheduled',
      function: 'field-guess-sweep',
      kind: 'summary',
    });
    expect(JSON.parse(String(summaries[0]?.detail))).toEqual({
      line: 'field guessing: failed before phase admission, 1 error',
      stats: {
        ran: false,
        skipReason: 'phase_initialization_failed',
        scannedNodes: 0,
        modelCalls: 0,
        fieldsSet: 0,
        abstentions: 0,
        ledgerSkips: 0,
        missingHashSkips: 0,
        staleNodes: 0,
        deferredNodes: 0,
        providerErrors: 0,
        referenceErrors: 0,
        mutationErrors: 0,
        errors: 1,
      },
    });
    expect(String(summaries[0]?.detail)).not.toContain('entropy unavailable');
  });

  it('records a pre-admission summary without clearing an unrelated recorder context', async () => {
    const h = harness();
    randomUUIDMock.mockImplementationOnce(() => { throw new Error('SECRET entropy failure'); });
    const recorder = new ActionRecorder(h.database!);
    h.deps.recorder = recorder;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const heldCuration = (async () => {
      recorder.setContext({ runRef: 'held-org-run', trigger: 'on-demand', fn: 'org-sweep' });
      entered();
      await releasePromise;
      recorder.record({ action: 'typed', detail: 'held context action' });
    })();
    await enteredPromise;
    h.engine.listActiveProjects.mockImplementationOnce(async () => {
      release();
      await heldCuration;
      return [];
    });

    await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
    });

    const rows = h.database!.prepare(`
      SELECT kind, function, run_ref, trigger FROM journal_events ORDER BY id
    `).all();
    expect(rows).toEqual([
      { kind: 'summary', function: 'field-guess-sweep', run_ref: null, trigger: 'scheduled' },
      { kind: 'action', function: 'org-sweep', run_ref: 'held-org-run', trigger: 'on-demand' },
    ]);
    expect(JSON.stringify({ rows, warnings: warning.mock.calls })).not.toContain('SECRET');
  });

  it('guesses active status before discovery and curates the project in the same production queue sweep', async () => {
    const order: string[] = [];
    const usageContexts: unknown[] = [];
    const usage = new UsageReporter({ recordUsage: async () => {} }, { provider: 'fireworks', experiment: null, variant: null });
    const setContext = usage.setContext.bind(usage);
    vi.spyOn(usage, 'setContext').mockImplementation(context => { usageContexts.push(context); setContext(context); });
    const h = harness({
      order,
      usage,
    });
    h.deps.recorder = new ActionRecorder(h.database!);
    let fieldGuess: FieldGuessSweepResult | undefined;
    curateProjectMock.mockImplementationOnce(async (
      _engine: unknown,
      _llm: unknown,
      _config: unknown,
      project: ProjectRef,
      dryRun: boolean,
    ): Promise<CurateResult> => {
      order.push('curate-project');
      return { project: project.title, outcome: 'written', dryRun };
    });

    const results = await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: (result) => {
        order.push('field-guess-result');
        fieldGuess = result;
      },
    });

    expect(order.slice(0, 5)).toEqual([
      'field-guess-candidates',
      'field-guess-commit',
      'field-guess-result',
      'active-projects',
      'curate-project',
    ]);
    expect(results).toEqual([expect.objectContaining({ project: PROJECT.title, outcome: 'written' })]);
    expect(fieldGuess).toMatchObject({ ran: true, modelCalls: 1, fieldsSet: 1, errors: 0 });
    expect(h.enqueue.mock.calls.map(call => call[0]).slice(0, 2)).toEqual(['field-guess-sweep', PROJECT.title]);
    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(1);
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith(expect.objectContaining({
      setFields: { status: 'active' },
      expectedVersion: 3,
      expectedContentHash: 'content-hash-1',
      dryRun: false,
    }));
    expect(h.llm.structuredCall).toHaveBeenCalledWith(expect.objectContaining({
      model: MODEL,
      maxTokens: 2000,
    }));
    const attempt = h.database!.prepare('SELECT run_ref, outcome FROM field_guess_attempts').get() as {
      run_ref: string;
      outcome: string;
    };
    expect(attempt.outcome).toBe('set');
    expect(usageContexts[0]).toEqual({ project: 'field-guess-sweep', runRef: attempt.run_ref, purpose: 'field-guess' });
    expect(usageContexts[1]).toBeNull();
    expect(h.database!.prepare(`
      SELECT run_ref, trigger, function FROM journal_events WHERE function = 'field-guess-sweep'
    `).get()).toEqual({ run_ref: attempt.run_ref, trigger: 'scheduled', function: 'field-guess-sweep' });
    const summaries = h.database!.prepare(`
      SELECT run_ref, trigger, function, kind, detail
      FROM journal_events WHERE function = 'field-guess-sweep' AND kind = 'summary'
    `).all() as Array<{ run_ref: string; trigger: string; function: string; kind: string; detail: string }>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      run_ref: attempt.run_ref, trigger: 'scheduled', function: 'field-guess-sweep', kind: 'summary',
    });
    expect(JSON.parse(summaries[0]!.detail)).toMatchObject({
      stats: { ran: true, fieldsSet: 1, providerErrors: 0, referenceErrors: 0, mutationErrors: 0, errors: 0 },
    });
  });

  it.each([
    ['scheduled', async (deps: CoreDeps) => runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' })],
    ['CLI preview', async (deps: CoreDeps) => runSweep(deps, { dryRun: true, preview: true, force: false, trigger: 'cli' })],
    ['on-demand/manual', async (deps: CoreDeps) => triggerCuration(
      deps,
      { project: null, dryRun: false, force: false },
      'on-demand',
    )],
  ])('invokes field guessing exactly once for a %s full sweep', async (_label, invoke) => {
    const h = harness({ config: { fieldGuessCap: 0 }, db: false });

    await invoke(h.deps);

    expect(h.enqueue.mock.calls.filter(call => call[0] === 'field-guess-sweep')).toHaveLength(1);
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cap zero', { config: { fieldGuessCap: 0 }, db: false }, { ran: false, skipReason: 'disabled', errors: 0 }],
    ['unresolved model', { config: { fieldGuessModel: null, fieldGuessModelError: 'dangling model' } }, { ran: false, skipReason: 'model_unresolved', errors: 0 }],
    ['unavailable DB', { db: false }, { ran: false, skipReason: 'database_unavailable', errors: 0 }],
    ['pending presence backfill', { candidateMode: 'pending' }, { ran: false, skipReason: 'presence_backfill_pending', errors: 0 }],
    ['candidate phase failure', { candidateMode: 'failure' }, { ran: true, skipReason: null, errors: 1 }],
  ] satisfies Array<[string, HarnessOptions, Partial<FieldGuessSweepResult>]>)('continues discovery and later phases after %s', async (
    _label,
    options,
    expectedResult,
  ) => {
    const h = harness(options);
    let fieldGuess: FieldGuessSweepResult | undefined;

    await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: (result) => { fieldGuess = result; },
    });

    expect(fieldGuess).toMatchObject(expectedResult);
    expect(h.enqueue.mock.calls.filter(call => call[0] === 'field-guess-sweep')).toHaveLength(1);
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
    expect(runMemorySweep).toHaveBeenCalledTimes(1);
  });

  it('treats a missing Fireworks key as the paid provider failure and still discovers projects', async () => {
    const llm = createDispatchingLlmClient({ keys: { anthropic: 'home-key-is-present' }, baseURLs: {} }, providerForModel(BASE_CONFIG.modelProviders));
    const h = harness({ llm });
    let fieldGuess: FieldGuessSweepResult | undefined;

    await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: (result) => { fieldGuess = result; },
    });

    expect(fieldGuess).toMatchObject({ ran: true, modelCalls: 1, fieldsSet: 0, errors: 1 });
    expect(fieldGuess?.warnings).toContain('field guess provider call failed');
    expect(fieldGuess?.warnings.join('\n')).not.toContain('anthropic API key');
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
  });

  it('continues after the field-guess queue boundary rejects', async () => {
    const productionQueue = new CurationQueue();
    const enqueue = vi.fn(<T>(label: string, work: () => Promise<T>): Promise<T> => {
      if (label === 'field-guess-sweep') return Promise.reject(new Error('queue unavailable'));
      return productionQueue.enqueue(label, work);
    });
    const h = harness({
      queue: { enqueue } as unknown as CurationQueue,
      db: false,
      initiallyActive: true,
    });

    const results = await runSweep(h.deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(results).toEqual([expect.objectContaining({ project: PROJECT.title })]);
    expect(enqueue.mock.calls.filter(call => call[0] === 'field-guess-sweep')).toHaveLength(1);
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
  });

  it('contains an onFieldGuessResult observer failure and continues discovery', async () => {
    const h = harness({ config: { fieldGuessCap: 0 }, db: false });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: () => { throw new Error('SECRET observer exploded'); },
    });

    expect(results).toEqual([]);
    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('[curator] field guess result callback failed');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('SECRET');
  });

  it('awaits and contains an asynchronous field-guess result observer failure', async () => {
    const h = harness({ config: { fieldGuessCap: 0 }, db: false });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runSweep(h.deps, {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: async () => { throw new Error('SECRET async observer exploded'); },
    });

    expect(h.engine.listActiveProjects).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('[curator] field guess result callback failed');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('SECRET');
  });
});

describe('targeted curation exclusion', () => {
  it.each([
    ['curateOne', async (deps: CoreDeps) => curateOne(
      deps,
      PROJECT.title,
      { dryRun: false, force: false, trigger: 'on-demand' },
    )],
    ['targeted triggerCuration', async (deps: CoreDeps) => triggerCuration(
      deps,
      { project: PROJECT.title, dryRun: false, force: false },
      'on-demand',
    )],
  ])('never invokes field guessing from %s', async (_label, invoke) => {
    const h = harness({ config: { fieldGuessCap: 0 }, db: false, initiallyActive: true });

    await invoke(h.deps);

    expect(h.enqueue.mock.calls.filter(call => call[0] === 'field-guess-sweep')).toEqual([]);
    expect(h.engine.listFieldGuessCandidates).not.toHaveBeenCalled();
  });
});
