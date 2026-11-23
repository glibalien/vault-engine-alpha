import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../src/config.js';
import { CAPTURE_COVERAGE_SYSTEM_PROMPT } from '../src/conversation-capture-prompts.js';
import { runMigrations } from '../src/db/migrate.js';
import { insertFieldGuessAttempts } from '../src/db/field-guess.js';
import { EngineError, type Engine } from '../src/engine.js';
import type {
  FieldGuessFieldCandidate,
  FieldGuessNodeCandidate,
  FieldGuessSweepDeps,
  FieldGuessSweepResult,
} from '../src/field-guess/types.js';
import { runFieldGuessSweep, runFieldGuessSweepWorker } from '../src/field-guess/sweep.js';
import { fieldGuessEvidenceHash } from '../src/field-guess/prompt.js';
import { createDispatchingLlmClient } from '../src/llm/index.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest, type StructuredCallResult } from '../src/llm/types.js';
import { CurationQueue } from '../src/queue.js';
import { BudgetExhaustedError } from '../src/budget.js';
import type { EngineNode, EngineNodeSummary } from '../src/types.js';
import { UsageReporter } from '../src/usage-reporter.js';
import { ActionRecorder } from '../src/journal/recorder.js';

const MODEL = 'accounts/fireworks/models/gpt-oss-120b';

const BASE_CONFIG = {
  engineUrl: 'http://localhost:9999',
  engineToken: 'test-token',
  experiment: null,
  variant: null,
  llmKeys: { keys: { anthropic: 'test-key', fireworks: 'test-fireworks-key' }, baseURLs: {} },
  model: 'claude-sonnet-4-6',
  fieldGuessModel: MODEL,
  fieldGuessModelError: null,
  fieldGuessCap: 25,
  fieldGuessMaxTokens: 2000,
  modelProviders: {
    'claude-sonnet-4-6': 'anthropic',
    [MODEL]: 'fireworks',
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

function field(overrides: Partial<FieldGuessFieldCandidate> = {}): FieldGuessFieldCandidate {
  return {
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
    ...overrides,
  };
}

function candidate(overrides: Partial<FieldGuessNodeCandidate> = {}): FieldGuessNodeCandidate {
  return {
    node_id: 'node-1',
    title: 'Project One',
    file_path: 'Projects/Project One.md',
    types: ['Project'],
    version: 3,
    content_hash: 'hash-1',
    file_mtime: 100,
    fields: [field()],
    ...overrides,
  };
}

function node(input: FieldGuessNodeCandidate, overrides: Partial<EngineNode> = {}): EngineNode {
  return {
    id: input.node_id,
    title: input.title,
    file_path: input.file_path,
    types: input.types,
    version: input.version,
    fields: {},
    relationships: { outgoing: {}, incoming: {} },
    body: 'The project is active.',
    metadata: { content_hash: input.content_hash, file_mtime: input.file_mtime },
    ...overrides,
  };
}

function call(output: unknown = {
  decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'The project is active.' }],
}): StructuredCallResult {
  return { output, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
}

function evidenceFor(input: FieldGuessNodeCandidate): { evidence_hash: string; evidence_version: number } {
  return {
    evidence_hash: fieldGuessEvidenceHash(node(input), input.fields, {
      bodyCharCap: BASE_CONFIG.bodyCharCap, model: MODEL,
      maxTokens: BASE_CONFIG.fieldGuessMaxTokens, reasoningEffort: BASE_CONFIG.reasoningEffort,
    }),
    evidence_version: 1,
  };
}

function page(
  candidates: FieldGuessNodeCandidate[],
  nextCursor: string | null,
): Awaited<ReturnType<Engine['listFieldGuessCandidates']>> {
  return { page: { candidates, next_cursor: nextCursor }, warnings: [] };
}

type Harness = ReturnType<typeof harness>;
const databases: Database.Database[] = [];

function harness(options: {
  config?: Partial<Config>;
  db?: Database.Database | false;
  candidatePages?: Array<ReturnType<typeof page>>;
  getNode?: (nodeId: string, options: { includeEmbeds: false }) => Promise<EngineNode>;
  structuredCall?: (request: StructuredCallRequest) => Promise<StructuredCallResult>;
  usage?: FieldGuessSweepDeps['usage'];
  recorder?: FieldGuessSweepDeps['recorder'];
} = {}) {
  const database = options.db === false ? undefined : (options.db ?? new Database(':memory:'));
  if (database !== undefined) {
    if (options.db === undefined) runMigrations(database);
    databases.push(database);
  }
  const defaultCandidate = candidate();
  const pages = options.candidatePages ?? [page([defaultCandidate], null)];
  const engine = {
    listFieldGuessCandidates: vi.fn()
      .mockImplementation(async () => pages.shift() ?? page([], null)),
    getNode: vi.fn(options.getNode ?? (async () => node(defaultCandidate))),
    findNodesByExactTitle: vi.fn(async (): Promise<EngineNodeSummary[]> => []),
    updateNodeFieldsCas: vi.fn(async (): Promise<unknown> => ({ updated: true })),
  };
  const llm = {
    structuredCall: vi.fn(options.structuredCall ?? (async () => call())),
  } satisfies LlmClient;
  const queue = new CurationQueue();
  const enqueue = vi.spyOn(queue, 'enqueue');
  return {
    database,
    engine,
    llm,
    queue,
    enqueue,
    deps: {
      engine: engine as unknown as Engine,
      llm,
      config: { ...BASE_CONFIG, ...options.config },
      queue,
      ...(database === undefined ? {} : { db: database }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    },
  };
}

type AttemptRow = {
  run_ref: string;
  call_ref: string;
  node_id: string;
  field_name: string;
  content_hash: string;
  definition_hash: string;
  model: string;
  classifier_version: number;
  outcome: string;
  proposed_value_json: string | null;
  reason: string | null;
  error: string | null;
  action: string | null;
  attempted_at: string;
};

function attempts(database: Database.Database): AttemptRow[] {
  return database.prepare(`
    SELECT run_ref, call_ref, node_id, field_name, content_hash, definition_hash,
      model, classifier_version, outcome, proposed_value_json, reason, error,
      action, attempted_at
    FROM field_guess_attempts ORDER BY id
  `).all() as AttemptRow[];
}

describe('budget refusal (#359)', () => {
  const inputs = [candidate({ node_id: 'node-1' }), candidate({ node_id: 'node-2' }), candidate({ node_id: 'node-3' })];
  const run = async (refusal: Error, recorder?: FieldGuessSweepDeps['recorder']) => {
    const h = harness({
      candidatePages: [page(inputs, null)],
      getNode: async id => node(inputs.find(input => input.node_id === id)!),
      structuredCall: async () => { throw refusal; },
      ...(recorder === undefined ? {} : { recorder }),
    });
    return { h, result: await runFieldGuessSweep(h.deps, { dryRun: false, runRef: 'run-budget', trigger: 'scheduled' }) };
  };

  it('stops at the first refusal, defers the rest and counts no error', async () => {
    const { h, result } = await run(new BudgetExhaustedError('Daily budget of $3.00 is spent'));

    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.getNode).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ modelCalls: 1, providerErrors: 0, errors: 0, deferredNodes: 3 });
    expect(result.stopped).toBe('field guess sweep stopped: Daily budget of $3.00 is spent; the rest is retried next run');
  });

  it('records no attempt, so the notes are retried next run', async () => {
    const { h } = await run(new BudgetExhaustedError('spent'));
    expect(attempts(h.database!)).toEqual([]);
  });

  it('finds a refusal carried as the cause of a provider failure', async () => {
    const refusal = new StructuredCallFailure('key limit', undefined, 'provider_call_failed', undefined,
      { cause: new BudgetExhaustedError('spent') });
    const { h, result } = await run(refusal);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result.stopped).toContain('stopped: spent');
    expect(attempts(h.database!)).toEqual([]);
  });

  it('says so in the summary line', async () => {
    const summary = vi.fn();
    const recorder = { setContext: () => {}, summary, record: () => {} } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    await run(new BudgetExhaustedError('spent'), recorder);
    expect(summary.mock.calls[0]?.[1]).toContain('field guess sweep stopped: spent');
    expect(summary.mock.calls[0]?.[2]).toMatchObject({ deferredNodes: 3 });
  });

  it('still records an ordinary provider failure and carries on', async () => {
    const { h, result } = await run(new Error('upstream 500'));
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ providerErrors: 3, errors: 3, deferredNodes: 0 });
    expect(result.stopped).toBeUndefined();
    expect(attempts(h.database!).map(row => row.outcome)).toEqual(['provider_error', 'provider_error', 'provider_error']);
  });
});

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  vi.restoreAllMocks();
});

describe('runFieldGuessSweep admission, paging, and cap', () => {
  it('keeps one stable evidence fingerprint while terminal fields shrink the offered set', async () => {
    const input = candidate({ fields: [field(), field({ field: 'context', field_type: 'string', enum_values: null, definition_hash: 'context-v1' })] });
    const h = harness({
      getNode: async () => node(input),
      structuredCall: async () => call({ decisions: [
        { field: 'status', action: 'abstain', reason: 'No evidence' },
        { field: 'context', action: 'set', value: 'A project', reason: 'Body evidence' },
      ] }),
    });
    h.engine.updateNodeFieldsCas.mockRejectedValue(new Error('Temporary write failure'));
    const run = () => {
      h.engine.listFieldGuessCandidates.mockResolvedValue(page([input], null));
      return runFieldGuessSweep(h.deps, { dryRun: false, runRef: 'partial-evidence', trigger: 'scheduled' });
    };
    expect(await run()).toMatchObject({ modelCalls: 1, mutationErrors: 1 });
    h.llm.structuredCall.mockImplementation(async request => {
      const offered = request.user.split('BEGIN OFFERED FIELDS')[1]!.split('END OFFERED FIELDS')[0]!;
      expect(offered).toContain('"field":"context"');
      expect(offered).not.toContain('"field":"status"');
      return call({ decisions: [{ field: 'context', action: 'abstain', reason: 'No evidence' }] });
    });
    expect(await run()).toMatchObject({ modelCalls: 1, ledgerSkips: 1 });
    expect(await run()).toMatchObject({ modelCalls: 0, ledgerSkips: 2 });
    const hashes = h.database!.prepare('SELECT DISTINCT evidence_hash, evidence_version FROM field_guess_attempts').all();
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatchObject({ evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/), evidence_version: 1 });
  });

  it('reconsiders a legacy terminal attempt without deleting its history', async () => {
    const h = harness({ structuredCall: async () => call({ decisions: [{ field: 'status', action: 'abstain', reason: 'Still insufficient' }] }) });
    insertFieldGuessAttempts(h.database!, [{
      run_ref: 'legacy', call_ref: 'legacy', node_id: 'node-1', field_name: 'status',
      content_hash: 'hash-1', definition_hash: 'definition-status-v1', model: MODEL,
      classifier_version: 1, outcome: 'abstained', attempted_at: '2026-08-25T12:00:00.000Z',
    }]);
    h.engine.listFieldGuessCandidates.mockResolvedValue(page([candidate()], null));
    const opts = { dryRun: false, runRef: 'new-evidence', trigger: 'scheduled' as const };
    expect(await runFieldGuessSweep(h.deps, opts)).toMatchObject({ modelCalls: 1, ledgerSkips: 0 });
    expect(await runFieldGuessSweep(h.deps, opts)).toMatchObject({ modelCalls: 0, ledgerSkips: 1 });
    expect(h.database!.prepare('SELECT COUNT(*) AS n FROM field_guess_attempts').get()).toEqual({ n: 2 });
    expect(h.database!.prepare('SELECT evidence_hash FROM field_guess_attempts WHERE run_ref = ?').get('legacy'))
      .toEqual({ evidence_hash: null });
  });

  it.each([
    { title: 'Customer escalation' },
    { file_path: 'Urgent/Project One.md' },
    { relationships: { outgoing: {}, incoming: { mentions: [{ source_id: 'new-note', source_title: 'Project is blocked' }] } } },
  ])('retries changed prompt evidence with unchanged Markdown hash: %j', async evidence => {
    const h = harness({ structuredCall: async () => call({ decisions: [{ field: 'status', action: 'abstain', reason: 'Insufficient evidence' }] }) });
    const run = async () => {
      h.engine.listFieldGuessCandidates.mockResolvedValue(page([candidate()], null));
      return runFieldGuessSweep(h.deps, { dryRun: false, runRef: 'evidence-retry', trigger: 'scheduled' });
    };
    expect((await run()).modelCalls).toBe(1);
    expect(await run()).toMatchObject({ modelCalls: 0, ledgerSkips: 1 });
    h.engine.getNode.mockResolvedValue(node(candidate(), evidence));
    expect((await run()).modelCalls).toBe(1);
    expect(await run()).toMatchObject({ modelCalls: 0, ledgerSkips: 1 });
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['disabled', { config: { fieldGuessCap: 0 } }, 'disabled'],
    ['unresolved model', { config: { fieldGuessModel: null, fieldGuessModelError: 'SECRET-MODEL-ID' } }, 'model_unresolved'],
    ['database unavailable', { db: false }, 'database_unavailable'],
  ] as const)('persists exactly one bounded summary for a zero-success %s outcome', async (
    _label,
    options,
    skipReason,
  ) => {
    const h = harness(options);
    const database = h.database ?? (() => {
      const value = new Database(':memory:');
      runMigrations(value);
      return value;
    })();
    h.deps.recorder = new ActionRecorder(database);

    await runFieldGuessSweep(h.deps, {
      dryRun: false, runRef: `run-summary-${skipReason}`, trigger: 'scheduled',
    });

    const summaries = database.prepare(`
      SELECT run_ref, trigger, function, kind, detail
      FROM journal_events WHERE function = 'field-guess-sweep' AND kind = 'summary'
    `).all() as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      run_ref: `run-summary-${skipReason}`,
      trigger: 'scheduled',
      function: 'field-guess-sweep',
      kind: 'summary',
    });
    expect(JSON.parse(String(summaries[0]?.detail))).toMatchObject({
      stats: { ran: false, skipReason, fieldsSet: 0, errors: 0 },
    });
    expect(String(summaries[0]?.detail)).not.toContain('SECRET-MODEL-ID');
    if (h.database === undefined) database.close();
  });

  it('always enqueues exactly one dedicated job, including a disabled phase', async () => {
    const h = harness({ config: { fieldGuessCap: 0 } });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-disabled',
      trigger: 'scheduled',
    });

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[0]).toBe('field-guess-sweep');
    expect(h.engine.listFieldGuessCandidates).not.toHaveBeenCalled();
    expect(h.engine.getNode).not.toHaveBeenCalled();
    expect(h.llm.structuredCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ran: false, skipReason: 'disabled', modelCalls: 0, errors: 0 });
  });

  it.each([
    ['throws synchronously', false, (enqueue: ReturnType<typeof vi.fn>) => enqueue.mockImplementation(() => {
      throw new Error('SECRET queue threw synchronously');
    }), 'field guess queue failed'],
    ['rejects asynchronously', true, (enqueue: ReturnType<typeof vi.fn>) => enqueue.mockRejectedValue(
      new Error('SECRET queue rejected asynchronously'),
    ), 'field guess queue failed'],
  ] as const)('contains a queue that %s without a second enqueue', async (
    _label,
    dryRun,
    configure,
    warning,
  ) => {
    const h = harness();
    const enqueue = vi.fn();
    configure(enqueue);
    h.deps.queue = { enqueue } as unknown as CurationQueue;

    const resultPromise = runFieldGuessSweep(h.deps, {
      dryRun,
      runRef: `run-${_label}`,
      trigger: 'scheduled',
    });

    await expect(resultPromise).resolves.toEqual({
      ran: true,
      dryRun,
      skipReason: null,
      scannedNodes: 0,
      modelCalls: 0,
      fieldsSet: 0,
      abstentions: 0,
      ledgerSkips: 0,
      missingHashSkips: 0,
      staleNodes: 0,
      deferredNodes: 0,
      referenceErrors: 0,
      providerErrors: 0,
      mutationErrors: 0,
      errors: 1,
      warnings: [warning],
      actions: [],
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(h.engine.listFieldGuessCandidates).not.toHaveBeenCalled();
    expect(JSON.stringify(await resultPromise)).not.toContain('SECRET');
  });

  it.each([
    [{ fieldGuessModel: null, fieldGuessModelError: 'deleted model ref' }, 'model_unresolved'],
    [{}, 'database_unavailable'],
  ] as const)('skips before candidate, body, or model access for unavailable prerequisites', async (config, reason) => {
    const h = harness({ config, db: reason === 'database_unavailable' ? false : undefined });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-${reason}`,
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).not.toHaveBeenCalled();
    expect(h.engine.getNode).not.toHaveBeenCalled();
    expect(h.llm.structuredCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ran: false, skipReason: reason, modelCalls: 0 });
  });

  it('returns the pending-presence skip without reading a body or spending', async () => {
    const h = harness({ candidatePages: [{
      page: { candidates: [candidate()], next_cursor: 'must-not-follow' },
      warnings: [{ code: 'FIELD_PRESENCE_BACKFILL_PENDING', message: 'SECRET backfill running', severity: 'warning' }],
    }] });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-pending',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(1);
    expect(h.engine.getNode).not.toHaveBeenCalled();
    expect(h.llm.structuredCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ran: false,
      skipReason: 'presence_backfill_pending',
      scannedNodes: 0,
      modelCalls: 0,
    });
    expect(result.warnings).toEqual(['Field presence backfill is pending.']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('pages past an exact terminal-ledger-only node before spending on the next node', async () => {
    const ledgered = candidate({ node_id: 'ledgered', content_hash: 'ledger-hash' });
    const fresh = candidate({ node_id: 'fresh', title: 'Fresh', content_hash: 'fresh-hash' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([ledgered], 'cursor-p2'), page([fresh], null)],
      getNode: async nodeId => node(nodeId === ledgered.node_id ? ledgered : fresh),
    });
    insertFieldGuessAttempts(h.database!, [{
      run_ref: 'older-run',
      call_ref: 'older-call',
      ...evidenceFor(ledgered),
      node_id: ledgered.node_id,
      field_name: 'status',
      content_hash: ledgered.content_hash!,
      definition_hash: ledgered.fields[0]!.definition_hash,
      model: MODEL,
      classifier_version: 1,
      outcome: 'abstained',
      attempted_at: '2026-08-25T12:00:00.000Z',
    }]);

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-page',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates.mock.calls.map(callArgs => callArgs[0])).toEqual([
      { limit: 100 },
      { limit: 100, cursor: 'cursor-p2' },
    ]);
    expect(h.engine.getNode.mock.calls.map(args => args[0])).toEqual(['ledgered', 'fresh']);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scannedNodes: 2, modelCalls: 1, ledgerSkips: 1 });
  });

  it('checks the cap before reading fresh evidence and consulting the terminal ledger', async () => {
    const order: string[] = [];
    let recordLedgerQueries = false;
    const database = new Database(':memory:', {
      verbose: sql => {
        if (typeof sql !== 'string'
          || !recordLedgerQueries
          || !sql.includes('SELECT 1 FROM field_guess_attempts')) return;
        for (const nodeId of [
          'admission-ledgered',
          'admission-paid',
          'admission-beyond',
          'admission-missing',
        ]) {
          if (sql.includes(nodeId)) order.push(`ledger:${nodeId}`);
        }
      },
    });
    runMigrations(database);
    const ledgered = candidate({ node_id: 'admission-ledgered', content_hash: 'hash-ledgered' });
    const admitted = candidate({ node_id: 'admission-paid', content_hash: 'hash-paid' });
    const beyond = candidate({ node_id: 'admission-beyond', content_hash: 'hash-beyond' });
    const missing = candidate({ node_id: 'admission-missing', content_hash: null });
    insertFieldGuessAttempts(database, [{
      run_ref: 'older-admission-run',
      call_ref: 'older-admission-call',
      ...evidenceFor(ledgered),
      node_id: ledgered.node_id,
      field_name: 'status',
      content_hash: ledgered.content_hash!,
      definition_hash: ledgered.fields[0]!.definition_hash,
      model: MODEL,
      classifier_version: 1,
      outcome: 'abstained',
      attempted_at: '2026-08-25T12:00:00.000Z',
    }]);
    const h = harness({
      db: database,
      config: { fieldGuessCap: 1 },
      getNode: async nodeId => {
        order.push(`body:${nodeId}`);
        return node(nodeId === ledgered.node_id ? ledgered : admitted);
      },
      structuredCall: async () => {
        order.push('provider');
        throw new Error('provider unavailable after admission');
      },
    });
    h.engine.listFieldGuessCandidates.mockReset().mockImplementationOnce(async () => {
      order.push('page');
      return page([ledgered, admitted, beyond, missing], null);
    });
    let capReads = 0;
    Object.defineProperty(h.deps.config, 'fieldGuessCap', {
      configurable: true,
      get: () => {
        capReads += 1;
        order.push(`cap:${capReads}`);
        return 1;
      },
    });
    recordLedgerQueries = true;

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-exact-admission-order',
      trigger: 'scheduled',
    });

    expect(order).toEqual([
      'cap:1',
      'page',
      'cap:2',
      'body:admission-ledgered',
      'ledger:admission-ledgered',
      'cap:3',
      'body:admission-paid',
      'ledger:admission-paid',
      'provider',
      'cap:4',
      'cap:5',
    ]);
    expect(h.engine.getNode).toHaveBeenCalledTimes(2);
    expect(h.engine.getNode).toHaveBeenCalledWith('admission-paid', { includeEmbeds: false });
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scannedNodes: 4,
      modelCalls: 1,
      ledgerSkips: 1,
      missingHashSkips: 0,
      deferredNodes: 2,
      errors: 1,
    });
  });

  it('pages through a missing-hash node without body/model access and spends on a later page', async () => {
    const missing = candidate({ node_id: 'missing-hash', content_hash: null });
    const fresh = candidate({ node_id: 'fresh', content_hash: 'fresh-hash' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([missing], 'cursor-after-missing'), page([fresh], null)],
      getNode: async () => node(fresh),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-missing-hash',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(2);
    expect(h.engine.getNode).toHaveBeenCalledTimes(1);
    expect(h.engine.getNode).toHaveBeenCalledWith('fresh', { includeEmbeds: false });
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scannedNodes: 2, missingHashSkips: 1, modelCalls: 1 });
  });

  it.each([
    ['version', { version: 4, metadata: { content_hash: 'stale-hash' } }],
    ['content hash', { version: 3, metadata: { content_hash: 'changed-hash' } }],
  ] as const)('pages after a stale full-read %s without spending on it', async (_label, staleOverride) => {
    const stale = candidate({ node_id: 'stale', content_hash: 'stale-hash' });
    const fresh = candidate({ node_id: 'fresh', content_hash: 'fresh-hash' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([stale], 'cursor-after-stale'), page([fresh], null)],
      getNode: async nodeId => node(nodeId === 'stale' ? stale : fresh, nodeId === 'stale' ? staleOverride : {}),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-stale-${_label}`,
      trigger: 'scheduled',
    });

    expect(h.engine.getNode.mock.calls.map(callArgs => callArgs[0])).toEqual(['stale', 'fresh']);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ staleNodes: 1, modelCalls: 1 });
  });

  it('uses one structured call and one combined patch for multiple eligible fields on a node', async () => {
    const multi = candidate({ fields: [
      field(),
      field({
        field: 'context',
        description: 'Project context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      candidatePages: [page([multi], null)],
      getNode: async () => node(multi),
      structuredCall: async () => call({ decisions: [
        { field: 'status', action: 'set', value: 'active', reason: 'Active work.' },
        { field: 'context', action: 'set', value: 'work', reason: 'Work project.' },
      ] }),
    });

    await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-multi',
      trigger: 'scheduled',
    });

    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.llm.structuredCall).toHaveBeenCalledWith(expect.objectContaining({
      model: MODEL,
      maxTokens: 2000,
      toolName: 'classify_field_guesses',
      schema: expect.objectContaining({ type: 'object' }),
    }));
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith({
      nodeId: 'node-1',
      setFields: { status: 'active', context: 'work' },
      expectedVersion: 3,
      expectedContentHash: 'hash-1',
      guard: {
        offered_fields: [
          { field: 'status', definition_hash: 'definition-status-v1' },
          { field: 'context', definition_hash: 'definition-context-v1' },
        ],
      },
      dryRun: false,
    });
  });

  it('never pays twice for a repeated node in one full sweep', async () => {
    const repeated = candidate({ node_id: 'repeated', content_hash: 'hash-repeated' });
    const h = harness({
      config: { fieldGuessCap: 2 },
      candidatePages: [page([repeated], 'cursor-repeat'), page([repeated], null)],
      getNode: async () => node(repeated),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-repeated-node',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(2);
    expect(h.engine.getNode).toHaveBeenCalledTimes(1);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scannedNodes: 2, modelCalls: 1 });
  });

  it('charges provider failures before the call and defers later nodes without reading their bodies', async () => {
    const first = candidate({ node_id: 'first', content_hash: 'hash-first' });
    const deferred = candidate({ node_id: 'deferred', content_hash: 'hash-deferred' });
    const order: string[] = [];
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([first, deferred], null)],
      getNode: async nodeId => {
        order.push(`body:${nodeId}`);
        return node(first);
      },
      structuredCall: async () => {
        order.push('model');
        throw new Error('provider unavailable');
      },
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-provider-error',
      trigger: 'scheduled',
    });

    expect(order).toEqual(['body:first', 'model']);
    expect(h.engine.getNode).toHaveBeenCalledTimes(1);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ modelCalls: 1, deferredNodes: 1, errors: 1 });
  });

  it('continues body-free pages after the cap and defers candidates whose terminal evidence cannot be checked', async () => {
    const admitted = candidate({ node_id: 'cap-page-one', content_hash: 'hash-page-one' });
    const ledgered = candidate({ node_id: 'cap-ledgered', content_hash: 'hash-ledgered' });
    const deferredA = candidate({ node_id: 'cap-deferred-a', content_hash: 'hash-deferred-a' });
    const deferredB = candidate({ node_id: 'cap-deferred-b', content_hash: 'hash-deferred-b' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [
        page([admitted], 'cursor-after-cap'),
        page([ledgered], 'cursor-final-count'),
        page([deferredA, deferredB], null),
      ],
      getNode: async () => node(admitted),
    });
    insertFieldGuessAttempts(h.database!, [{
      run_ref: 'older-deferred-run',
      call_ref: 'older-deferred-call',
      ...evidenceFor(ledgered),
      node_id: ledgered.node_id,
      field_name: 'status',
      content_hash: ledgered.content_hash!,
      definition_hash: ledgered.fields[0]!.definition_hash,
      model: MODEL,
      classifier_version: 1,
      outcome: 'abstained',
      attempted_at: '2026-08-25T12:00:00.000Z',
    }]);

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-exact-deferred-pages',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates.mock.calls.map(args => args[0])).toEqual([
      { limit: 100 },
      { limit: 100, cursor: 'cursor-after-cap' },
      { limit: 100, cursor: 'cursor-final-count' },
    ]);
    expect(h.engine.getNode.mock.calls.map(args => args[0])).toEqual(['cap-page-one']);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scannedNodes: 4,
      modelCalls: 1,
      ledgerSkips: 0,
      deferredNodes: 3,
      errors: 0,
    });
  });

  it('retains the cursor-cycle guard while counting body-free pages after the cap', async () => {
    const admitted = candidate({ node_id: 'cycle-admitted', content_hash: 'hash-cycle-admitted' });
    const deferredA = candidate({ node_id: 'cycle-deferred-a', content_hash: 'hash-cycle-a' });
    const deferredB = candidate({ node_id: 'cycle-deferred-b', content_hash: 'hash-cycle-b' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [
        page([admitted], 'cursor-cycle-a'),
        page([deferredA], 'cursor-cycle-b'),
        page([deferredB], 'cursor-cycle-a'),
      ],
      getNode: async () => node(admitted),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-post-cap-cycle',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(3);
    expect(h.engine.getNode.mock.calls.map(args => args[0])).toEqual(['cycle-admitted']);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scannedNodes: 3,
      modelCalls: 1,
      deferredNodes: 2,
      errors: 1,
    });
    expect(result.warnings).toContain(
      'Field guess candidate cursor cycle detected (repeated cursor); stopping paging.',
    );
  });

  it('preserves charged work and adds a bounded warning when post-cap counting fails', async () => {
    const admitted = candidate({ node_id: 'failure-admitted', content_hash: 'hash-failure-admitted' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      getNode: async () => node(admitted),
    });
    h.engine.listFieldGuessCandidates
      .mockReset()
      .mockResolvedValueOnce(page([admitted], 'cursor-counting-fails'))
      .mockRejectedValueOnce(new Error(`SECRET post-cap page failed ${'x'.repeat(2_000)}`));

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-post-cap-page-failure',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(2);
    expect(h.engine.getNode.mock.calls.map(args => args[0])).toEqual(['failure-admitted']);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scannedNodes: 1,
      modelCalls: 1,
      fieldsSet: 1,
      deferredNodes: 0,
      errors: 1,
    });
    expect(result.warnings).toEqual(['field guess sweep failed']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('has charged the shared modelCalls counter when provider code is entered', async () => {
    const sharedResult: FieldGuessSweepResult = {
      ran: true,
      dryRun: false,
      skipReason: null,
      scannedNodes: 0,
      modelCalls: 0,
      fieldsSet: 0,
      abstentions: 0,
      ledgerSkips: 0,
      missingHashSkips: 0,
      staleNodes: 0,
      deferredNodes: 0,
      referenceErrors: 0,
      providerErrors: 0,
      mutationErrors: 0,
      errors: 0,
      warnings: [],
      actions: [],
    };
    let providerEntryModelCalls: number | undefined;
    const h = harness({
      structuredCall: async () => {
        providerEntryModelCalls = sharedResult.modelCalls;
        return call();
      },
    });

    const result = await runFieldGuessSweepWorker(h.deps, {
      dryRun: false,
      runRef: 'run-provider-entry-charge',
      trigger: 'scheduled',
    }, sharedResult);

    expect(providerEntryModelCalls).toBe(1);
    expect(result).toBe(sharedResult);
    expect(result).toEqual({
      ran: true,
      dryRun: false,
      skipReason: null,
      scannedNodes: 1,
      modelCalls: 1,
      fieldsSet: 1,
      abstentions: 0,
      ledgerSkips: 0,
      missingHashSkips: 0,
      staleNodes: 0,
      deferredNodes: 0,
      referenceErrors: 0,
      providerErrors: 0,
      mutationErrors: 0,
      errors: 0,
      warnings: [],
      actions: ['guessed status=active on "Project One" — The project is active.'],
    });
  });

  it('bounds a malformed multi-field node to one provider request and one call_ref', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{malformed-provider-output' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const adapter = new OpenAiCompatLlmClient({
      chat: { completions: { create } },
    } as unknown as OpenAI);
    const input = candidate({ fields: [
      field(),
      field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
      structuredCall: request => adapter.structuredCall(request),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-malformed-provider-cap',
      trigger: 'scheduled',
    });

    const rows = attempts(h.database!);
    expect(create).toHaveBeenCalledTimes(1);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
    expect(rows.map(row => row.outcome)).toEqual(['provider_error', 'provider_error']);
    expect(new Set(rows.map(row => row.call_ref)).size).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records billed malformed-envelope usage exactly once without marker persistence or a patch', async () => {
    const rawMarker = 'MALFORMED-ENVELOPE-MARKER-60d8';
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: null,
        finish_reason: 'stop',
        marker: rawMarker,
      }],
      usage: {
        prompt_tokens: 17,
        completion_tokens: 9,
      },
    });
    const adapter = new OpenAiCompatLlmClient({
      chat: { completions: { create } },
    } as unknown as OpenAI);
    const input = candidate({ fields: [
      field(),
      field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
    });
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reportingEngine = Object.assign(h.engine, { recordUsage }) as unknown as Engine;
    const reporter = new UsageReporter(reportingEngine, {
      provider: 'fireworks',
      experiment: null,
      variant: null,
    });
    const deps: FieldGuessSweepDeps = {
      ...h.deps,
      llm: reporter.wrap(adapter),
      usage: reporter,
    };

    const result = await runFieldGuessSweep(deps, {
      dryRun: false,
      runRef: 'run-malformed-envelope-usage',
      trigger: 'scheduled',
    });

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    const rows = attempts(h.database!);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      provider: 'fireworks',
      service: 'curator',
      purpose: 'field-guess',
      model: MODEL,
      input_tokens: 17,
      output_tokens: 9,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      run_ref: 'run-malformed-envelope-usage',
      source_ref: 'field-guess-sweep',
    });
    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
    expect(rows.map(row => row.outcome)).toEqual(['provider_error', 'provider_error']);
    expect(new Set(rows.map(row => row.call_ref)).size).toBe(1);
    expect(rows.every(row => row.error?.includes('reason=invalid_content_type'))).toBe(true);
    expect(rows.every(row => !row.error?.includes(rawMarker))).toBe(true);
    expect(result.warnings.join('\n')).not.toContain(rawMarker);
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
  });

  it('records billed Anthropic malformed-envelope usage exactly once without exposing provider content', async () => {
    const rawMarker = 'ANTHROPIC_BILLED_MARKER';
    const create = vi.fn().mockResolvedValue({
      content: { marker: rawMarker },
      usage: { input_tokens: 17, output_tokens: 9 },
    });
    const adapter = new AnthropicLlmClient({ messages: { create } } as unknown as Anthropic);
    const input = candidate();
    const h = harness({
      config: { fieldGuessModel: 'claude-sonnet-4-6', fieldGuessCap: 1 },
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
    });
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(Object.assign(h.engine, { recordUsage }) as unknown as Engine, {
      provider: 'anthropic', experiment: null, variant: null,
    });

    const result = await runFieldGuessSweep({ ...h.deps, llm: reporter.wrap(adapter), usage: reporter }, {
      dryRun: false, runRef: 'run-anthropic-billed-failure', trigger: 'scheduled',
    });

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      provider: 'anthropic', purpose: 'field-guess', model: 'claude-sonnet-4-6',
      input_tokens: 17, output_tokens: 9, cache_write_tokens: 0, cache_read_tokens: 0,
      run_ref: 'run-anthropic-billed-failure', source_ref: 'field-guess-sweep',
    });
    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
    const rows = attempts(h.database!);
    expect(rows.map(row => row.outcome)).toEqual(['provider_error']);
    expect(rows[0]?.error).toContain('reason=invalid_content_type');
    expect(result.warnings.join('\n')).not.toContain(rawMarker);
    expect(rows.every(row => !row.error?.includes(rawMarker))).toBe(true);
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'truncated',
      reason: 'truncated',
      response: {
        stop_reason: 'max_tokens',
        content: [{
          type: 'tool_use', name: 'classify_field_guesses',
          input: { decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'ANTHROPIC_TRUNCATED_MARKER' }] },
        }],
        usage: { input_tokens: 17, output_tokens: 9 },
      },
      marker: 'ANTHROPIC_TRUNCATED_MARKER',
    },
    {
      label: 'duplicate-tool',
      reason: 'invalid_tool_use_count',
      response: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use', name: 'classify_field_guesses',
            input: { decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'first' }] },
          },
          {
            type: 'tool_use', name: 'classify_field_guesses',
            input: { decisions: [{ field: 'status', action: 'abstain', reason: 'ANTHROPIC_DUPLICATE_MARKER' }] },
          },
        ],
        usage: { input_tokens: 17, output_tokens: 9 },
      },
      marker: 'ANTHROPIC_DUPLICATE_MARKER',
    },
  ])('keeps a billed Anthropic $label response retryable and mutation-free', async ({ response, reason, marker }) => {
    const create = vi.fn().mockResolvedValue(response);
    const adapter = new AnthropicLlmClient({ messages: { create } } as unknown as Anthropic);
    const input = candidate();
    const h = harness({
      config: { fieldGuessModel: 'claude-sonnet-4-6', fieldGuessCap: 1 },
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
    });
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(Object.assign(h.engine, { recordUsage }) as unknown as Engine, {
      provider: 'anthropic', experiment: null, variant: null,
    });

    const result = await runFieldGuessSweep({ ...h.deps, llm: reporter.wrap(adapter), usage: reporter }, {
      dryRun: false, runRef: `run-anthropic-${reason}`, trigger: 'scheduled',
    });

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      provider: 'anthropic', purpose: 'field-guess', model: 'claude-sonnet-4-6',
      input_tokens: 17, output_tokens: 9,
    });
    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
    const rows = attempts(h.database!);
    expect(rows.map(row => row.outcome)).toEqual(['provider_error']);
    expect(rows[0]?.error).toContain(`reason=${reason}`);
    expect(rows.every(row => !row.error?.includes(marker))).toBe(true);
    expect(result.warnings.join('\n')).not.toContain(marker);
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
  });

  it('consumes one admitted slot but makes no provider request when credentials are missing', async () => {
    const input = candidate({ fields: [
      field(),
      field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const dispatcher = createDispatchingLlmClient({ keys: {}, baseURLs: { fireworks: 'https://field-guess.invalid/v1' } }, () => 'fireworks');
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
      structuredCall: request => dispatcher.structuredCall(request),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-missing-key-admission',
      trigger: 'scheduled',
    });

    const rows = attempts(h.database!);
    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
    expect(rows.map(row => row.outcome)).toEqual(['provider_error', 'provider_error']);
    expect(new Set(rows.map(row => row.call_ref)).size).toBe(1);
    expect(rows.every(row => row.error === 'structured call failed (reason=provider_dispatch_failed)')).toBe(true);
  });

  it('projects raw provider failures before warning and attempt persistence', async () => {
    const marker = 'RAW-SWEEP-PROVIDER-MARKER-a91f';
    const failure = new Error(`${marker} leaked provider text`);
    failure.stack = `Error: ${marker}\n    at provider (${marker}.ts:1:1)`;
    const h = harness({
      structuredCall: async () => { throw failure; },
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-redacted-provider-failure',
      trigger: 'scheduled',
    });
    const rows = attempts(h.database!);

    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
    expect(result.warnings).toEqual(['field guess provider call failed']);
    expect(rows.map(row => row.error)).toEqual([
      'structured call failed (reason=provider_call_failed)',
    ]);
    expect(JSON.stringify({ warnings: result.warnings, rows })).not.toContain(marker);
  });

  it('contains a page-level failure inside the one queued worker result', async () => {
    const h = harness();
    h.engine.listFieldGuessCandidates.mockRejectedValueOnce(new Error('engine unavailable'));

    await expect(runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-page-error',
      trigger: 'scheduled',
    })).resolves.toMatchObject({ ran: true, modelCalls: 0, errors: 1 });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('terminates an immediately repeated non-null cursor without fetching an escape page', async () => {
    const h = harness({ candidatePages: [page([], 'cursor-repeat'), page([], 'cursor-repeat')] });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-repeated-cursor',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(2);
    expect(h.engine.getNode).not.toHaveBeenCalled();
    expect(h.llm.structuredCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scannedNodes: 0, modelCalls: 0, errors: 1 });
    expect(result.warnings.join('\n')).toMatch(/cursor.*repeat/i);
  });

  it('contains a multi-cursor cycle after empty, ledger-only, missing-hash, and duplicate-paid pages', async () => {
    const ledgered = candidate({ node_id: 'cycle-ledgered', content_hash: 'hash-ledgered' });
    const missing = candidate({ node_id: 'cycle-missing', content_hash: null });
    const paid = candidate({ node_id: 'cycle-paid', content_hash: 'hash-paid' });
    const h = harness({
      config: { fieldGuessCap: 5 },
      candidatePages: [
        page([], 'cursor-a'),
        page([ledgered], 'cursor-b'),
        page([missing], 'cursor-c'),
        page([paid], 'cursor-d'),
        page([paid], 'cursor-a'),
      ],
      getNode: async nodeId => node(nodeId === ledgered.node_id ? ledgered : paid),
    });
    insertFieldGuessAttempts(h.database!, [{
      run_ref: 'older-cycle-run',
      call_ref: 'older-cycle-call',
      ...evidenceFor(ledgered),
      node_id: ledgered.node_id,
      field_name: 'status',
      content_hash: ledgered.content_hash!,
      definition_hash: ledgered.fields[0]!.definition_hash,
      model: MODEL,
      classifier_version: 1,
      outcome: 'abstained',
      attempted_at: '2026-08-25T12:00:00.000Z',
    }]);

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-cursor-cycle',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(5);
    expect(h.engine.getNode).toHaveBeenCalledTimes(2);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scannedNodes: 4,
      modelCalls: 1,
      fieldsSet: 1,
      ledgerSkips: 1,
      missingHashSkips: 1,
      errors: 1,
    });
    expect(result.actions).toHaveLength(1);
    expect(result.warnings.join('\n')).toMatch(/cursor.*cycle/i);
  });

  it('preserves accumulated page-one results when listing a later page fails', async () => {
    const first = candidate({
      node_id: 'page-one',
      title: 'Page One',
      content_hash: 'hash-page-one',
      fields: [
        field(),
        field({
          field: 'context',
          description: 'Project context',
          field_type: 'string',
          enum_values: null,
          definition_hash: 'definition-context-v1',
        }),
      ],
    });
    const h = harness({
      getNode: async () => node(first),
      structuredCall: async () => call({ decisions: [
        { field: 'status', action: 'set', value: 'active', reason: 'The project is active.' },
        { field: 'context', action: 'abstain', reason: 'No durable context evidence.' },
      ] }),
    });
    h.engine.listFieldGuessCandidates
      .mockReset()
      .mockResolvedValueOnce({
        page: { candidates: [first], next_cursor: 'cursor-page-two' },
        warnings: [{ code: 'EARLY_WARNING', message: 'page one warning', severity: 'warning' }],
      })
      .mockRejectedValueOnce(new Error('SECRET page two unavailable'));

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-later-page-failure',
      trigger: 'scheduled',
    });

    expect(h.engine.listFieldGuessCandidates).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ran: true,
      scannedNodes: 1,
      modelCalls: 1,
      fieldsSet: 1,
      abstentions: 1,
      errors: 1,
    });
    expect(result.actions).toEqual([
      'guessed status=active on "Page One" — The project is active.',
    ]);
    expect(result.warnings).toEqual([
      'Field guess candidate discovery warning.',
      'field guess sweep failed',
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('isolates a body-read failure and admits the next node without charging the cap', async () => {
    const unreadable = candidate({ node_id: 'unreadable', content_hash: 'hash-unreadable' });
    const readable = candidate({ node_id: 'readable', content_hash: 'hash-readable' });
    const h = harness({
      config: { fieldGuessCap: 1 },
      candidatePages: [page([unreadable, readable], null)],
      getNode: async nodeId => {
        if (nodeId === 'unreadable') throw new Error('read unavailable');
        return node(readable);
      },
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-read-isolation',
      trigger: 'scheduled',
    });

    expect(h.engine.getNode.mock.calls.map(args => args[0])).toEqual(['unreadable', 'readable']);
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ modelCalls: 1, errors: 1, deferredNodes: 0 });
  });
});

describe('runFieldGuessSweep attempts and governed mutation', () => {
  it('finalizes one exact attempt per offered field only after the combined Engine write succeeds', async () => {
    const order: string[] = [];
    const multi = candidate({ fields: [
      field(),
      field({
        field: 'context',
        description: 'Project context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      candidatePages: [page([multi], null)],
      getNode: async () => node(multi),
      structuredCall: async () => call({ decisions: [
        { field: 'status', action: 'set', value: 'active', reason: 'Active work.' },
        { field: 'context', action: 'abstain', reason: 'Context is ambiguous.' },
      ] }),
    });
    h.database!.function('observe_field_guess_attempt', () => { order.push('attempt'); return null; });
    h.database!.exec(`
      CREATE TRIGGER observe_field_guess_attempt BEFORE INSERT ON field_guess_attempts
      BEGIN SELECT observe_field_guess_attempt(); END;
    `);
    h.engine.updateNodeFieldsCas.mockImplementation(async () => {
      order.push('mutation');
      return { updated: true };
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-mixed',
      trigger: 'scheduled',
    });

    expect(order).toEqual(['mutation', 'attempt', 'attempt']);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith({
      nodeId: 'node-1',
      setFields: { status: 'active' },
      expectedVersion: 3,
      expectedContentHash: 'hash-1',
      guard: {
        offered_fields: [
          { field: 'status', definition_hash: 'definition-status-v1' },
          { field: 'context', definition_hash: 'definition-context-v1' },
        ],
      },
      dryRun: false,
    });
    const rows = attempts(h.database!);
    expect(rows.map(row => ({
      run_ref: row.run_ref,
      node_id: row.node_id,
      field_name: row.field_name,
      content_hash: row.content_hash,
      definition_hash: row.definition_hash,
      model: row.model,
      classifier_version: row.classifier_version,
      outcome: row.outcome,
      proposed_value_json: row.proposed_value_json,
      reason: row.reason,
      error: row.error,
    }))).toEqual([
      {
        run_ref: 'run-mixed',
        node_id: 'node-1',
        field_name: 'status',
        content_hash: 'hash-1',
        definition_hash: 'definition-status-v1',
        model: MODEL,
        classifier_version: 1,
        outcome: 'set',
        proposed_value_json: '"active"',
        reason: 'Active work.',
        error: null,
      },
      {
        run_ref: 'run-mixed',
        node_id: 'node-1',
        field_name: 'context',
        content_hash: 'hash-1',
        definition_hash: 'definition-context-v1',
        model: MODEL,
        classifier_version: 1,
        outcome: 'abstained',
        proposed_value_json: null,
        reason: 'Context is ambiguous.',
        error: null,
      },
    ]);
    expect(new Set(rows.map(row => row.call_ref)).size).toBe(1);
    expect(rows[0]?.call_ref).toMatch(/\S/);
    expect(rows.every(row => new Date(row.attempted_at).toISOString() === row.attempted_at)).toBe(true);
    expect(result).toMatchObject({ fieldsSet: 1, abstentions: 1, errors: 0 });
  });

  it('persists live abstentions and value rejections without making an Engine mutation', async () => {
    const allTerminal = candidate({ fields: [
      field(),
      field({
        field: 'priority',
        enum_values: ['high', 'low'],
        definition_hash: 'definition-priority-v1',
      }),
    ] });
    const h = harness({
      candidatePages: [page([allTerminal], null)],
      getNode: async () => node(allTerminal),
      structuredCall: async () => call({ decisions: [
        { field: 'status', action: 'abstain', reason: 'No status evidence.' },
        { field: 'priority', action: 'set', value: 'urgent', reason: 'Weak priority evidence.' },
      ] }),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-no-patch',
      trigger: 'cli',
    });

    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
    expect(attempts(h.database!).map(row => row.outcome)).toEqual(['abstained', 'rejected_value']);
    expect(result).toMatchObject({ fieldsSet: 0, abstentions: 2, modelCalls: 1 });
  });

  it('commits a JSON-shaped string when it is an allowed scalar enum value', async () => {
    const jsonEnum = candidate({ fields: [field({
      enum_values: ['{"kind":"manual"}'],
    })] });
    const h = harness({
      candidatePages: [page([jsonEnum], null)],
      getNode: async () => node(jsonEnum),
      structuredCall: async () => call({ decisions: [{
        field: 'status',
        action: 'set',
        value: '{"kind":"manual"}',
        reason: 'Matches the configured workflow state.',
      }] }),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-json-shaped-scalar-enum',
      trigger: 'scheduled',
    });

    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith(expect.objectContaining({
      setFields: { status: '{"kind":"manual"}' },
    }));
    expect(attempts(h.database!)).toEqual([expect.objectContaining({
      outcome: 'set',
      proposed_value_json: '"{\\"kind\\":\\"manual\\"}"',
    })]);
    expect(result).toMatchObject({ fieldsSet: 1, abstentions: 0, errors: 0 });
  });

  it('commits JSON-shaped raw text for an unrestricted scalar string and records the set attempt', async () => {
    const rawText = '{"kind":"manual"}';
    const input = candidate({ fields: [field({
      field: 'notes',
      field_type: 'string',
      enum_values: null,
      definition_hash: 'definition-notes-v1',
    })] });
    const h = harness({
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
      structuredCall: async () => call({ decisions: [{
        field: 'notes',
        action: 'set',
        value: rawText,
        reason: 'The body contains this exact note text.',
      }] }),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-json-shaped-scalar-string',
      trigger: 'scheduled',
    });

    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith(expect.objectContaining({
      setFields: { notes: rawText },
    }));
    expect(attempts(h.database!)).toEqual([expect.objectContaining({
      field_name: 'notes',
      outcome: 'set',
      proposed_value_json: '"{\\"kind\\":\\"manual\\"}"',
      error: null,
    })]);
    expect(result).toMatchObject({ fieldsSet: 1, abstentions: 0, errors: 0 });
  });

  it('rebuilds the one patch from exact-reference-resolved accepted decisions', async () => {
    const referenceField = field({
      field: 'context',
      field_type: 'reference',
      enum_values: null,
      reference_target: 'Context',
      definition_hash: 'definition-context-ref-v1',
    });
    const input = candidate({ fields: [referenceField, field()] });
    const h = harness({
      candidatePages: [page([input], null)],
      getNode: async nodeId => nodeId === input.node_id
        ? node(input)
        : {
            id: 'context-id', title: 'Acme, Inc.', file_path: 'Contexts/Acme.md',
            types: ['Context'], version: 7, fields: {}, body: '', metadata: { content_hash: 'context-hash' },
          },
      structuredCall: async () => call({ decisions: [
        { field: 'context', action: 'set', value: 'Acme', reason: 'Named as the context.' },
        { field: 'status', action: 'abstain', reason: 'No status evidence.' },
      ] }),
    });
    h.engine.findNodesByExactTitle.mockResolvedValueOnce([{
      id: 'context-id', title: 'Acme, Inc.', file_path: 'Contexts/Acme.md',
      types: ['Context'], version: 7, field_count: 0,
    }]);

    await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-reference',
      trigger: 'scheduled',
    });

    expect(h.engine.findNodesByExactTitle).toHaveBeenCalledWith('Acme', 2);
    expect(h.engine.getNode).toHaveBeenNthCalledWith(2, 'context-id', { includeEmbeds: false });
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith(expect.objectContaining({
      setFields: { context: 'Acme, Inc.' },
    }));
    expect(attempts(h.database!).map(row => ({ field: row.field_name, outcome: row.outcome, value: row.proposed_value_json })))
      .toEqual([
        { field: 'context', outcome: 'set', value: '"Acme, Inc."' },
        { field: 'status', outcome: 'abstained', value: null },
      ]);
  });

  it('rejects only an unresolved reference and keeps another accepted field in the combined patch', async () => {
    const input = candidate({ fields: [
      field({
        field: 'context',
        field_type: 'reference',
        enum_values: null,
        reference_target: 'Context',
        definition_hash: 'definition-context-ref-v1',
      }),
      field(),
    ] });
    const h = harness({
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
      structuredCall: async () => call({ decisions: [
        { field: 'context', action: 'set', value: 'Missing Context', reason: 'Mentioned.' },
        { field: 'status', action: 'set', value: 'active', reason: 'Active work.' },
      ] }),
    });

    await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-rejected-reference',
      trigger: 'scheduled',
    });

    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith(expect.objectContaining({
      setFields: { status: 'active' },
    }));
    expect(attempts(h.database!).map(row => row.outcome)).toEqual(['rejected_reference', 'set']);
  });

  it('records an unsafe canonical reference title as a redacted terminal rejection', async () => {
    const referenceField = field({
      field: 'context',
      field_type: 'reference',
      enum_values: null,
      reference_target: 'Context',
      definition_hash: 'definition-context-ref-v1',
    });
    const input = candidate({ fields: [referenceField] });
    const unsafeCanonicalTitle = 'A]SECRET-CANONICAL';
    const h = harness({
      candidatePages: [],
      getNode: async nodeId => nodeId === input.node_id
        ? node(input)
        : {
            id: 'context-id', title: unsafeCanonicalTitle, file_path: 'Contexts/Unsafe.md',
            types: ['Context'], version: 7, fields: {}, body: '', metadata: { content_hash: 'context-hash' },
          },
      structuredCall: async () => call({ decisions: [{
        field: 'context', action: 'set', value: 'Target Guess', reason: 'Named as the context.',
      }] }),
    });
    h.engine.listFieldGuessCandidates.mockResolvedValue(page([input], null));
    h.engine.findNodesByExactTitle.mockResolvedValue([{
      id: 'context-id', title: 'Target Guess', file_path: 'Contexts/Unsafe.md',
      types: ['Context'], version: 7, field_count: 0,
    }]);

    const first = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-unsafe-reference-first',
      trigger: 'scheduled',
    });
    const second = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-unsafe-reference-second',
      trigger: 'scheduled',
    });

    const rows = attempts(h.database!);
    expect(first).toMatchObject({ modelCalls: 1, fieldsSet: 0, abstentions: 1, errors: 0 });
    expect(second).toMatchObject({ modelCalls: 0, fieldsSet: 0, ledgerSkips: 1, errors: 0 });
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({
      outcome: 'rejected_reference',
      proposed_value_json: null,
      error: 'Canonical reference title cannot round-trip through Engine wiki-link storage.',
    })]);
    expect(JSON.stringify({ first, second, rows })).not.toContain('SECRET-CANONICAL');
  });

  it('commits an unrelated field, records reference_error, and retries the same fingerprint after lookup failure', async () => {
    const marker = 'SECRET-REFERENCE-TRANSPORT';
    const input = candidate({ fields: [
      field({
        field: 'context',
        field_type: 'reference',
        enum_values: null,
        reference_target: 'Context',
        definition_hash: 'definition-context-ref-v1',
      }),
      field(),
    ] });
    const h = harness({ candidatePages: [] });
    h.engine.listFieldGuessCandidates
      .mockResolvedValueOnce(page([input], null))
      .mockResolvedValueOnce(page([input], null));
    h.engine.getNode.mockImplementation(async nodeId => node(input, { id: nodeId }));
    h.engine.findNodesByExactTitle.mockRejectedValue(new Error(marker));
    h.llm.structuredCall.mockResolvedValue(call({ decisions: [
      { field: 'context', action: 'set', value: 'Acme', reason: 'Named context.' },
      { field: 'status', action: 'set', value: 'active', reason: 'Active work.' },
    ] }));

    const first = await runFieldGuessSweep(h.deps, {
      dryRun: false, runRef: 'run-reference-error-1', trigger: 'scheduled',
    });
    const second = await runFieldGuessSweep(h.deps, {
      dryRun: false, runRef: 'run-reference-error-2', trigger: 'scheduled',
    });

    expect(h.llm.structuredCall).toHaveBeenCalledTimes(2);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(2);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenNthCalledWith(1, expect.objectContaining({
      setFields: { status: 'active' },
    }));
    expect(attempts(h.database!).map(row => row.outcome)).toEqual([
      'reference_error', 'set', 'reference_error', 'set',
    ]);
    expect(first).toMatchObject({ fieldsSet: 1, referenceErrors: 1, errors: 1 });
    expect(second).toMatchObject({ fieldsSet: 1, referenceErrors: 1, errors: 1 });
    expect(JSON.stringify({ first, second, rows: attempts(h.database!) })).not.toContain(marker);
  });

  it.each([
    ['STALE_NODE', 'stale_node'],
    ['CONTENT_HASH_MISMATCH', 'stale_node'],
    ['VALIDATION_FAILED', 'mutation_error'],
  ] as const)('classifies a combined %s mutation failure without per-field fallback', async (code, acceptedOutcome) => {
    const input = candidate({ fields: [
      field(),
      field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
      structuredCall: async () => call({ decisions: [
        { field: 'status', action: 'set', value: 'active', reason: 'Active work.' },
        { field: 'context', action: 'abstain', reason: 'No context evidence.' },
      ] }),
    });
    h.engine.updateNodeFieldsCas.mockRejectedValue(new EngineError(code, 'SECRET mutation rejected'));

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-${code}`,
      trigger: 'scheduled',
    });

    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    const rows = attempts(h.database!);
    expect(rows.map(row => row.outcome)).toEqual([acceptedOutcome, 'abstained']);
    expect(rows[0]?.error).toBe('Field guess mutation failed.');
    expect(rows[1]).toMatchObject({
      outcome: 'abstained',
      reason: 'No context evidence.',
      error: null,
      proposed_value_json: null,
    });
    expect(result).toMatchObject(code === 'VALIDATION_FAILED'
      ? { fieldsSet: 0, modelCalls: 1, staleNodes: 0, mutationErrors: 1, errors: 1 }
      : { fieldsSet: 0, modelCalls: 1, staleNodes: 1, mutationErrors: 0, errors: 0 });
    if (code === 'VALIDATION_FAILED') {
      expect(result.warnings).toContain('field guess mutation failed');
    } else {
      expect(result.warnings).not.toContain('field guess mutation failed');
    }
    expect(JSON.stringify({ result, rows })).not.toContain('SECRET');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'SECRET non-Error CAS rejection'],
    ['ordinary EngineError', new EngineError('VALIDATION_FAILED', 'SECRET ordinary rejection')],
  ] as const)('treats a CAS rejection carrying %s as mutation_error, never success', async (_label, thrown) => {
    const recorder = {
      setContext: vi.fn(),
      record: vi.fn(),
      summary: vi.fn(),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({ recorder });
    h.engine.updateNodeFieldsCas.mockRejectedValue(thrown);

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-cas-${_label}`,
      trigger: 'scheduled',
    });

    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fieldsSet: 0, modelCalls: 1, errors: 1, actions: [] });
    expect(recorder.record).not.toHaveBeenCalled();
    const rows = attempts(h.database!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'mutation_error', action: null });
    expect(rows[0]?.error).toBe('Field guess mutation failed.');
    expect(JSON.stringify({ result, rows })).not.toContain('SECRET');
  });

  it('treats a CAS fulfillment carrying undefined as a successful set', async () => {
    const recorder = {
      setContext: vi.fn(),
      record: vi.fn(),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({ recorder });
    h.engine.updateNodeFieldsCas.mockResolvedValue(undefined);

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-cas-fulfilled-undefined',
      trigger: 'scheduled',
    });

    expect(result).toMatchObject({
      modelCalls: 1,
      fieldsSet: 1,
      errors: 0,
      actions: ['guessed status=active on "Project One" — The project is active.'],
    });
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(attempts(h.database!)).toEqual([
      expect.objectContaining({ outcome: 'set', action: result.actions[0] }),
    ]);
  });

  it.each([
    ['provider rejection', async () => { throw new Error('provider unavailable'); }],
    ['malformed call result', async () => null as unknown as StructuredCallResult],
  ] as const)('persists retryable provider_error rows per offered field for %s', async (_label, structuredCall) => {
    const input = candidate({ fields: [
      field(),
      field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      candidatePages: [page([input], null)],
      getNode: async () => node(input),
      structuredCall,
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-provider-${_label}`,
      trigger: 'scheduled',
    });

    const rows = attempts(h.database!);
    expect(rows.map(row => row.outcome)).toEqual(['provider_error', 'provider_error']);
    expect(new Set(rows.map(row => row.call_ref)).size).toBe(1);
    expect(rows.every(row => row.error !== null && Array.from(row.error).length <= 1_000)).toBe(true);
    expect(result).toMatchObject({ modelCalls: 1, fieldsSet: 0, errors: 1 });
  });

  it.each([
    ['non-object root', (): unknown => null],
    ['extra-own-key root', (): unknown => ({
      decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'clear evidence' }],
      extra: 'SECRET extra root value',
    })],
    ['accessor root', (): unknown => {
      const root: Record<string, unknown> = {};
      Object.defineProperty(root, 'decisions', {
        configurable: true,
        enumerable: true,
        get: () => [{ field: 'status', action: 'set', value: 'active', reason: 'SECRET accessor root' }],
      });
      return root;
    }],
    ['inherited root', (): unknown => Object.create({
      decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'SECRET inherited root' }],
    }) as Record<string, unknown>],
    ['class root', (): unknown => new class {
      decisions = [{ field: 'status', action: 'set', value: 'active', reason: 'SECRET class root' }];
    }()],
    ['non-array decisions', (): unknown => ({ decisions: 'SECRET non-array decisions' })],
  ] as const)(
    'keeps a malformed %s retryable across an identical second sweep',
    async (_label, output) => {
      const input = candidate({ fields: [
        field(),
        field({
          field: 'context',
          field_type: 'string',
          enum_values: null,
          definition_hash: 'definition-context-v1',
        }),
      ] });
      const h = harness({
        candidatePages: [],
        getNode: async () => node(input),
        structuredCall: async () => call(output()),
      });
      h.engine.listFieldGuessCandidates.mockResolvedValue(page([input], null));

      const first = await runFieldGuessSweep(h.deps, {
        dryRun: false,
        runRef: `run-malformed-root-first-${_label}`,
        trigger: 'scheduled',
      });
      const second = await runFieldGuessSweep(h.deps, {
        dryRun: false,
        runRef: `run-malformed-root-second-${_label}`,
        trigger: 'scheduled',
      });

      const rows = attempts(h.database!);
      expect(first).toMatchObject({
        modelCalls: 1,
        abstentions: 0,
        ledgerSkips: 0,
        providerErrors: 1,
        errors: 1,
      });
      expect(second).toMatchObject({
        modelCalls: 1,
        abstentions: 0,
        ledgerSkips: 0,
        providerErrors: 1,
        errors: 1,
      });
      expect(h.llm.structuredCall).toHaveBeenCalledTimes(2);
      expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
      expect(rows.map(row => row.outcome)).toEqual([
        'provider_error',
        'provider_error',
        'provider_error',
        'provider_error',
      ]);
      expect(new Set(rows.slice(0, 2).map(row => row.call_ref)).size).toBe(1);
      expect(new Set(rows.slice(2).map(row => row.call_ref)).size).toBe(1);
      expect(JSON.stringify({ first, second, rows })).not.toContain('SECRET');
    },
  );

  it.each([
    ['valid empty decisions', { decisions: [] }, ['abstained', 'abstained']],
    ['per-field malformed decision and omission', {
      decisions: [{ field: 'status', action: 'invented', reason: 'invalid action' }],
    }, ['rejected_value', 'abstained']],
  ] as const)('keeps %s terminal for an unchanged fingerprint', async (
    _label,
    output,
    expectedOutcomes,
  ) => {
    const input = candidate({ fields: [
      field(),
      field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      }),
    ] });
    const h = harness({
      candidatePages: [],
      getNode: async () => node(input),
      structuredCall: async () => call(output),
    });
    h.engine.listFieldGuessCandidates.mockResolvedValue(page([input], null));

    const first = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-terminal-first-${_label}`,
      trigger: 'scheduled',
    });
    const second = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: `run-terminal-second-${_label}`,
      trigger: 'scheduled',
    });

    expect(attempts(h.database!).map(row => row.outcome)).toEqual(expectedOutcomes);
    expect(first).toMatchObject({ modelCalls: 1, abstentions: 2, ledgerSkips: 0, errors: 0 });
    expect(second).toMatchObject({ modelCalls: 0, ledgerSkips: 2, errors: 0 });
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).not.toHaveBeenCalled();
  });

  it('does not reverse a successful Engine write when attempt insertion fails', async () => {
    const recorder = {
      setContext: vi.fn(),
      record: vi.fn(),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({ recorder });
    h.database!.exec(`
      CREATE TRIGGER reject_all_field_guess_attempts BEFORE INSERT ON field_guess_attempts
      BEGIN SELECT RAISE(ABORT, 'SECRET attempt observer unavailable'); END;
    `);

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-attempt-failure',
      trigger: 'scheduled',
    });

    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fieldsSet: 1, errors: 1 });
    expect(result.warnings).toContain('field guess attempts were not recorded');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.actions).toHaveLength(1);
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(attempts(h.database!)).toEqual([]);
  });

  it('uses a distinct paid call_ref per node while grouping all fields from one call', async () => {
    const first = candidate({ node_id: 'first', content_hash: 'hash-first' });
    const second = candidate({ node_id: 'second', content_hash: 'hash-second' });
    const h = harness({
      config: { fieldGuessCap: 2 },
      candidatePages: [page([first, second], null)],
      getNode: async nodeId => node(nodeId === 'first' ? first : second),
    });

    await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-two-calls',
      trigger: 'scheduled',
    });

    const rows = attempts(h.database!);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.call_ref).not.toBe(rows[1]?.call_ref);
  });

  it('reconsiders a same-call abstention after a set changes the hash, then suppresses it on the stable hash', async () => {
    const context = field({
      field: 'context',
      field_type: 'string',
      enum_values: null,
      definition_hash: 'definition-context-v1',
    });
    const beforeWrite = candidate({
      content_hash: 'hash-before-write',
      fields: [field(), context],
    });
    const stable = candidate({
      content_hash: 'hash-after-write',
      version: 4,
      fields: [context],
    });
    const h = harness({ candidatePages: [] });
    h.engine.listFieldGuessCandidates
      .mockResolvedValueOnce(page([beforeWrite], null))
      .mockResolvedValueOnce(page([stable], null))
      .mockResolvedValueOnce(page([stable], null));
    h.engine.getNode.mockImplementation(async nodeId =>
      node(h.engine.getNode.mock.calls.length === 1 ? beforeWrite : stable, { id: nodeId }));
    h.llm.structuredCall
      .mockResolvedValueOnce(call({ decisions: [
        { field: 'status', action: 'set', value: 'active', reason: 'Active work.' },
        { field: 'context', action: 'abstain', reason: 'No context yet.' },
      ] }))
      .mockResolvedValueOnce(call({ decisions: [
        { field: 'context', action: 'abstain', reason: 'Still no context.' },
      ] }));

    const first = await runFieldGuessSweep(h.deps, { dryRun: false, runRef: 'run-hash-1', trigger: 'scheduled' });
    const second = await runFieldGuessSweep(h.deps, { dryRun: false, runRef: 'run-hash-2', trigger: 'scheduled' });
    const third = await runFieldGuessSweep(h.deps, { dryRun: false, runRef: 'run-hash-3', trigger: 'scheduled' });

    expect(first.modelCalls).toBe(1);
    expect(second.modelCalls).toBe(1);
    expect(third).toMatchObject({ modelCalls: 0, ledgerSkips: 1 });
    expect(h.llm.structuredCall).toHaveBeenCalledTimes(2);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(attempts(h.database!).map(row => ({ hash: row.content_hash, field: row.field_name, outcome: row.outcome })))
      .toEqual([
        { hash: 'hash-before-write', field: 'status', outcome: 'set' },
        { hash: 'hash-before-write', field: 'context', outcome: 'abstained' },
        { hash: 'hash-after-write', field: 'context', outcome: 'abstained' },
      ]);
  });
});

describe('runFieldGuessSweep dry-run and observers', () => {
  it('persists a disabled summary while an unrelated journal-write branch is suspended', async () => {
    const h = harness({ config: { fieldGuessCap: 0 } });
    const recorder = new ActionRecorder(h.database!);
    h.deps.recorder = recorder;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const suspended = recorder.suspend(async () => {
      recorder.record({ action: 'journal-self-write', detail: 'must stay suppressed' });
      entered();
      await releasePromise;
      recorder.record({ action: 'journal-self-write', detail: 'must remain suppressed' });
    });
    await enteredPromise;

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-concurrent-disabled-summary',
      trigger: 'scheduled',
    });
    release();
    await suspended;

    expect(result).toMatchObject({ ran: false, skipReason: 'disabled', errors: 0 });
    const events = h.database!.prepare(`
      SELECT kind, function, run_ref FROM journal_events ORDER BY id
    `).all();
    expect(events).toEqual([{
      kind: 'summary',
      function: 'field-guess-sweep',
      run_ref: 'run-concurrent-disabled-summary',
    }]);
  });

  it('contains a summary observer failure with a closed warning', async () => {
    const marker = 'SECRET-JOURNAL-FAILURE';
    const recorder = {
      setContext: vi.fn(),
      record: vi.fn(),
      summary: vi.fn(() => { throw new Error(marker); }),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({ recorder, config: { fieldGuessCap: 0 } });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false, runRef: 'run-summary-observer-failure', trigger: 'scheduled',
    });

    expect(recorder.summary).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain('field guess journal summary failed');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('spends and previews a nonempty patch without attempt or journal persistence', async () => {
    const recorder = {
      setContext: vi.fn(),
      record: vi.fn(),
      summary: vi.fn(),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({ recorder });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: true,
      runRef: 'run-dry',
      trigger: 'cli',
    });

    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(attempts(h.database!)).toEqual([]);
    expect(recorder.setContext).toHaveBeenNthCalledWith(1, {
      runRef: 'run-dry', trigger: 'cli', fn: 'field-guess-sweep',
    });
    expect(recorder.setContext).toHaveBeenLastCalledWith(null);
    expect(recorder.record).not.toHaveBeenCalled();
    expect(recorder.summary).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ dryRun: true, fieldsSet: 1, errors: 0 });
    expect(result.actions).toEqual([
      'would guess status=active on "Project One" — The project is active.',
    ]);
  });

  it('sets the paid usage context and live action context exactly, then clears both', async () => {
    let usageContext: unknown = null;
    let recorderContext: unknown = null;
    const usage = {
      setContext: vi.fn((next: unknown) => { usageContext = next; }),
    } as unknown as NonNullable<FieldGuessSweepDeps['usage']>;
    const recorder = {
      setContext: vi.fn((next: unknown) => { recorderContext = next; }),
      record: vi.fn(() => {
        expect(recorderContext).toEqual({
          runRef: 'run-observers', trigger: 'on-demand', fn: 'field-guess-sweep', project: 'Project One',
        });
      }),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({
      usage,
      recorder,
      structuredCall: async () => {
        expect(usageContext).toEqual({
          project: 'field-guess-sweep', runRef: 'run-observers', purpose: 'field-guess',
        });
        return call();
      },
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-observers',
      trigger: 'on-demand',
    });

    expect(usage.setContext).toHaveBeenNthCalledWith(1, {
      project: 'field-guess-sweep', runRef: 'run-observers', purpose: 'field-guess',
    });
    expect(usage.setContext).toHaveBeenLastCalledWith(null);
    expect(recorder.setContext).toHaveBeenNthCalledWith(1, {
      runRef: 'run-observers', trigger: 'on-demand', fn: 'field-guess-sweep', project: 'Project One',
    });
    expect(recorder.setContext).toHaveBeenLastCalledWith(null);
    expect(usageContext).toBeNull();
    expect(recorderContext).toBeNull();
    expect(recorder.record).toHaveBeenCalledWith({
      action: 'field-guessed',
      nodeId: 'node-1',
      target: 'Project One',
      detail: 'guessed status=active on "Project One" — The project is active.',
    });
    expect(result.actions).toEqual([
      'guessed status=active on "Project One" — The project is active.',
    ]);
  });

  it('clears usage context after a provider failure', async () => {
    const usage = { setContext: vi.fn() } as unknown as NonNullable<FieldGuessSweepDeps['usage']>;
    const h = harness({
      usage,
      structuredCall: async () => { throw new Error('provider down'); },
    });

    await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-provider-context',
      trigger: 'scheduled',
    });

    expect(usage.setContext).toHaveBeenNthCalledWith(1, {
      project: 'field-guess-sweep', runRef: 'run-provider-context', purpose: 'field-guess',
    });
    expect(usage.setContext).toHaveBeenLastCalledWith(null);
  });

  it('warns on usage and journal observer throws without changing a committed Engine outcome', async () => {
    const usage = {
      setContext: vi.fn(() => { throw new Error('usage observer failed'); }),
    } as unknown as NonNullable<FieldGuessSweepDeps['usage']>;
    const recorder = {
      setContext: vi.fn(() => { throw new Error('recorder context failed'); }),
      record: vi.fn(() => { throw new Error('recorder write failed'); }),
      summary: vi.fn(),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({ usage, recorder });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-observer-failure',
      trigger: 'scheduled',
    });

    expect(h.llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(h.engine.updateNodeFieldsCas).toHaveBeenCalledTimes(1);
    expect(usage.setContext).toHaveBeenCalledTimes(2);
    expect(recorder.setContext).toHaveBeenCalledTimes(4);
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.summary).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fieldsSet: 1, errors: 0 });
    expect(result.warnings).toEqual([
      'field guess usage context setup failed',
      'field guess usage context cleanup failed',
      'field guess journal context setup failed',
      'field guess journal action failed',
      'field guess journal context cleanup failed',
      'field guess journal summary context setup failed',
      'field guess journal summary context cleanup failed',
    ]);
    expect(result.warnings.join('\n')).not.toMatch(/usage observer failed|recorder context failed|recorder write failed/);
  });

  it('bounds returned, journal, and attempt action lines independently of large values and rationales', async () => {
    const longValue = 'v'.repeat(2_000);
    const longTitle = 'T'.repeat(1_000);
    const input = candidate({
      title: longTitle,
      fields: [field({
        field: 'context',
        field_type: 'string',
        enum_values: null,
        definition_hash: 'definition-context-v1',
      })],
    });
    const recorder = {
      setContext: vi.fn(),
      record: vi.fn(),
    } as unknown as NonNullable<FieldGuessSweepDeps['recorder']>;
    const h = harness({
      recorder,
      candidatePages: [page([input], null)],
      getNode: async () => node(input, { body: 'SECRET BODY MUST NOT ENTER ACTIONS' }),
      structuredCall: async () => call({ decisions: [{
        field: 'context', action: 'set', value: longValue, reason: 'r'.repeat(2_000),
      }] }),
    });

    const result = await runFieldGuessSweep(h.deps, {
      dryRun: false,
      runRef: 'run-bounded-action',
      trigger: 'scheduled',
    });

    const [action] = result.actions;
    expect(Array.from(action ?? '')).toHaveLength(500);
    expect(action).not.toContain('SECRET BODY');
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({ detail: action }));
    expect(attempts(h.database!)[0]?.action).toBe(action);
    expect(Array.from(attempts(h.database!)[0]?.reason ?? '')).toHaveLength(500);
  });
});
