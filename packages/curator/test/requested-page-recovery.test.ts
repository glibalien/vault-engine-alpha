import { pageOutputFrame } from './page-output-fixtures.js';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchingLlmClient } from '../src/llm/index.js';
import { providerForModel } from '../src/llm/provider-for-model.js';
const { sdkCreate, sdkOptions } = vi.hoisted(() => ({ sdkCreate: vi.fn(), sdkOptions: vi.fn() }));
vi.mock('openai', () => ({ default: class {
  chat = { completions: { create: sdkCreate } };
  constructor(options: unknown) { sdkOptions(options); }
} }));
import { curateRequestedPage } from '../src/requested-page.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertPageRequest } from '../src/db/requests.js';
import { readRequestExecution, writeRequestExecution, clearRequestExecution, type ActivePageRequestExecution } from '../src/db/request-execution.js';
import { activeExecution, checkpointRequestedCall, recoverRequestedPage, requestedExecutionContext, savedRequestedCalls, type RequestExecutionStore } from '../src/requested-page-recovery.js';
import { BudgetExhaustedError } from '../src/budget.js';
import { EngineError, type Engine } from '../src/engine.js';
import { active } from './requested-page-fixtures.js';
import { currentDateLine, localDate } from '../src/date-line.js';
import { SPEC_A_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_WEB_SYSTEM_PROMPT } from '../src/synthesize.js';
let db: Database.Database;
let store: RequestExecutionStore;
beforeEach(() => {
  db = new Database(':memory:'); runMigrations(db); enrolProjects(db, 'Project');
  const id = insertPageRequest(db, { project_node_id: 'project-1', project_title: 'Project', title: 'Decisions',
    page_title: 'Project — Decisions', brief: null, requested_by: null, created_at: new Date().toISOString() });
  store = { read: () => readRequestExecution(db, id), write: (generation, next) => writeRequestExecution(db, id, generation, next),
    clear: generation => clearRequestExecution(db, id, generation) };
  store.write(null, active());
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); if (db.open) db.close(); });
const result = { output: { body: 'Saved result' }, usage: { input: 12, output: 3, cacheWrite: 0, cacheRead: 2 } };
it.each(['planner:0', 'planner:validation:1', 'planner:validation:2', 'adjudicator:0', 'planner:adjudication:1',
  'planner:adjudication:validation:1', 'planner:adjudication:validation:2', 'adjudicator:1', 'page:target', 'home:0'])(
  'never redispatches uncertain %s', async key => {
    let dispatched = 0;
    const invoke = async () => { dispatched++; throw new Error('crash'); };
    await expect(checkpointRequestedCall({ store, key, requestDigest: 'original', invoke })).rejects.toThrow();
    await expect(checkpointRequestedCall({ store, key, requestDigest: 'original', invoke })).rejects.toThrow('REQUEST_CALL_UNCERTAIN');
    expect(dispatched).toBe(1);
  });
it('keeps a call retryable when the daily budget refuses it before dispatch', async () => {
  const refuse = async () => { throw new BudgetExhaustedError('daily budget: spent'); };
  await expect(checkpointRequestedCall({ store, key: 'page:0', requestDigest: 'original', invoke: refuse }))
    .rejects.toBeInstanceOf(BudgetExhaustedError);
  expect(activeExecution(store)).toMatchObject({ phase: 'prepared', calls: [] });
  const invoke = vi.fn(async () => result);
  expect(await checkpointRequestedCall({ store, key: 'page:0', requestDigest: 'original', invoke })).toEqual(result);
  expect(invoke).toHaveBeenCalledOnce();
});
it('attributes saved calls to the frozen stage models that made them', () => {
  const stage = (model: string) => ({ model, maxTokens: 100, configuration: { provider: 'openrouter' as const, reasoningEffort: null } });
  const base = active();
  const saved = (key: string) => ({ key, requestDigest: key, state: 'result' as const, result });
  const calls = [saved('planner:0'), saved('adjudicator:0'), saved('page:target'), saved('home:0'),
    { key: 'page:other', requestDigest: 'x', state: 'sent' as const }];
  const staged = { ...base, calls, snapshot: { ...base.snapshot, config: { ...base.snapshot.config,
    wikiOutputPolicy: { version: 1 as const, model: 'test-model', planning: stage('plan-model'), page: stage('page-model'), home: stage('home-model') } } } };
  expect(savedRequestedCalls(staged).map(([model]) => model)).toEqual(['plan-model', 'plan-model', 'page-model', 'home-model']);
  expect(savedRequestedCalls({ ...base, calls }).map(([model]) => model)).toEqual(Array(4).fill('test-model'));
});
it('returns saved output and usage without dispatching or reporting another spend', async () => {
  let spend = 0;
  const input = { store, key: 'planner:0', requestDigest: 'original', invoke: async () => { spend++; return result; } };
  expect(await checkpointRequestedCall(input)).toEqual(result);
  expect(await checkpointRequestedCall(input)).toEqual(result);
  expect(spend).toBe(1);
  await expect(checkpointRequestedCall({ ...input, requestDigest: 'changed' })).rejects.toThrow('REQUEST_CALL_MISMATCH');
  expect(spend).toBe(1);
});
it('replays saved diagnostics without a second provider or reporting call', async () => {
  const saved = { ...result, diagnostics: { version: 1 as const, adapterAttempts: 1, sdkAttempts: 1,
    responses: [{ attempt: 0, contentKind: 'string' as const, usageKnown: true }] } };
  const invoke = vi.fn(async () => saved);
  const input = { store, key: 'page:0', requestDigest: 'original', invoke };
  expect(await checkpointRequestedCall(input)).toEqual(saved);
  expect(await checkpointRequestedCall(input)).toEqual(saved);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('does not dispatch when storing intent fails', async () => {
  db.exec("CREATE TRIGGER reject_execution BEFORE UPDATE OF execution_json ON page_requests BEGIN SELECT RAISE(ABORT, 'storage failure'); END;");
  let dispatched = false;
  await expect(checkpointRequestedCall({ store, key: 'planner:0', requestDigest: 'original',
    invoke: async () => { dispatched = true; return result; } })).rejects.toThrow();
  expect(dispatched).toBe(false);
});
it('terminalizes an abandoned sent call and erases its sensitive material', async () => {
  const execution = store.read() as ActivePageRequestExecution;
  store.write(execution.generation, { ...execution, calls: [{ key: 'planner:0', requestDigest: 'original', state: 'sent' }] });
  expect(await recoverRequestedPage({} as Engine, store)).toBe('blocked');
  expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_CALL_UNCERTAIN' });
  expect(store.read()).not.toHaveProperty('snapshot');
});
it('fails closed when the DB is unavailable', async () => {
  db.close();
  await expect(recoverRequestedPage({} as Engine, store)).rejects.toThrow();
});

import type OpenAI from 'openai';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { runRequestedPagePipeline } from '../src/requested-page-pipeline.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import type { Config } from '../src/config.js';
import type { PrepareRequest, PreparedReceipt, StageRequest, TransitionRequest } from '../src/provenance-types.js';
import type { WikiReconcileInput } from '../src/engine.js';

function pipelineFixture(crash?: string, merge = false, limits: Partial<ActivePageRequestExecution['snapshot']['config']['provenanceLimits']> = {}) {
  let armed = true;
  let transformOutput: ((point: string, output: any) => unknown) | undefined;
  // What each rule check answers, in order (#631); an empty queue finds no break.
  const rulings: unknown[] = [];
  // How often each point has been reached: `page#2` crashes at the second page call.
  const reached = new Map<string, number>();
  const flows = new Map<string, string>();
  const events: string[] = [];
  const calls: unknown[] = [];
  const writes: WikiReconcileInput[] = [];
  const attempts = new Map<string, PreparedReceipt>();
  const stages = new Map<string, StageRequest>();
  const base = active();
  Object.assign(base.snapshot.config.provenanceLimits, limits);
  base.snapshot.existingWiki = { home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'topology', catalog_valid: true, subpages: [] };
  if (merge) base.snapshot.existingWiki.subpages = [{ id: 'source', title: 'Project — Legacy', file_path: 'Legacy.md', version: 1,
    content_hash: 'source-hash', wiki_state: 'active', wiki_origin: 'requested', wiki_pinned: true,
    wiki_scope: { v: 1, subject: 'Project', facet: 'Legacy' } }];
  store.write((store.read() as ActivePageRequestExecution).generation, base);
  const maybeCrash = (point: string) => {
    const count = (reached.get(point) ?? 0) + 1;
    reached.set(point, count);
    if (armed && (crash === point || crash === `${point}#${count}`)) { armed = false; throw new Error('injected crash'); }
  };
  let committed: any;
  const engine = {
    projectEvidence: async () => ({ project: { id: base.projectId, title: 'Project', status: 'active' }, evidence_hash: 'hash-1', existing_wiki: base.snapshot.existingWiki,
      tasks: {}, notes: [], meetings: { recent: [], upcoming: [] }, contacts: { people: [] }, generated_at: base.generatedAt,
      provenance_observations: { nodes: { [base.projectId]: { source: { kind: 'node', namespace: 'vault', native_id: base.projectId },
        authority: 'engine', observed_at: base.generatedAt, native_version: 1, content_hash: 'hash', hash_semantics: 'engine_content_hash',
        observation_projection: 'node-token-v2', observation_digest: `sha256:json-v1:${'a'.repeat(64)}`, label: 'Project', path: 'Project.md' } } } }),
    semanticRelated: async () => [],
    inspectProvenance: async (req: any) => req.select === 'status'
      ? { select: 'status', capability_version: 1, capture_features: ['project-subpage-v1', 'multi-output-reconcile-v1'], limits: { ...base.snapshot.config.provenanceLimits, leaseHours: 24 } }
      : { select: 'attempt', attempt: attempts.get(req.attempt_key) ?? null },
    prepareProvenance: async (req: PrepareRequest) => {
      if (req.dry_run) return { dry_run: true, bundle_digest: 'digest', payload_bytes: 1, reserved_bytes: 1, item_count: 1 };
      const receipt = attempts.get(req.attempt_key) ?? { derivation_id: `d${attempts.size}`, bundle_digest: 'digest', state: 'prepared' as const,
        availability: 'retained' as const, lease_expires_at: base.expiresAt };
      attempts.set(req.attempt_key, receipt);
      flows.set(receipt.derivation_id, req.flow ?? 'home');
      events.push(`prepare:${req.flow ?? 'home'}`);
      return receipt;
    },
    transitionProvenance: async (req: TransitionRequest) => {
      const attempt = [...attempts.values()].find(a => a.derivation_id === req.derivation_id);
      if (!attempt || attempt.state !== req.expected_state) throw new Error('PROVENANCE_KEY_CONFLICT');
      if (req.action === 'fail' || req.action === 'abandon') attempt.state = req.action === 'fail' ? 'failed' : 'abandoned';
      if (req.action === 'fail' || req.action === 'abandon') events.push(`${req.action}:${req.derivation_id}`);
      return attempt;
    },
    stageProvenanceResult: async (req: StageRequest) => {
      const prior = stages.get(req.derivation_id);
      if (prior) expect(req).toEqual(prior);
      stages.set(req.derivation_id, structuredClone(req));
      const attempt = [...attempts.values()].find(a => a.derivation_id === req.derivation_id)!;
      attempt.state = 'result_staged';
      maybeCrash(`stage:${req.derivation_id}`);
      return { derivation_id: req.derivation_id, bundle_digest: req.bundle_digest, contribution_digest: `c${req.derivation_id}` };
    },
    getNode: async (id: string) => {
      if (id !== 'source' || !merge) throw new Error('unexpected node read');
      return { id, title: 'Project — Legacy', file_path: 'Legacy.md', version: 1, types: ['wiki'], fields: {}, body: 'Legacy facts',
        metadata: { content_hash: 'source-hash' }, provenance_observation: { source: { kind: 'node', namespace: 'vault', native_id: id },
          authority: 'engine', observed_at: base.generatedAt, native_version: 1, content_hash: 'source-hash', hash_semantics: 'engine_content_hash',
          observation_projection: 'node-token-v2', observation_digest: `sha256:json-v1:${'b'.repeat(64)}`, label: 'Project — Legacy', path: 'Legacy.md' } };
    },
    wikiReconcile: async (req: WikiReconcileInput) => {
      writes.push(structuredClone(req));
      if (committed) { expect(req).toEqual(writes.find(r => !r.dry_run)); return { data: committed, warnings: [] }; }
      const data = { operation_id: req.dry_run ? null : 'op', reconcile_key: req.reconcile_key, dry_run: !!req.dry_run,
        created: [{ node_id: req.dry_run ? 'plan:page' : 'page', title: 'Project — Decisions', file_path: 'Page.md', version: 2 }],
        updated: [], mappings: merge ? [{ source_node_id: 'source', target_node_id: 'page', target_title: 'Project — Decisions' }] : [], topology_hash: 'new', warnings: [], preview: { total: 0, items: [], truncated: false },
        home: { node_id: 'home', title: 'Project Wiki', file_path: 'Home.md', version: 2, created: false },
        // Engine commits only the attempts the write carries: a failed first draft is not among them.
        provenance_receipts: req.dry_run ? [] : [...attempts.values()].filter(a => a.state !== 'failed' && a.state !== 'abandoned').map(a => ({ derivation_id: a.derivation_id,
          output_revision_id: `o${a.derivation_id}`, output_node_id: flows.get(a.derivation_id) === 'project-subpage-v1' ? 'page' : 'home', committed_node_version: 2,
          committed_at: base.generatedAt, operation_id: 'op', reconcile_key: req.reconcile_key, request_digest: 'digest' })) };
      data.provenance_receipts.reverse();
      Object.assign(data, { provenance_receipt: data.provenance_receipts[0] });
      maybeCrash('submission');
      if (!req.dry_run) {
        committed = data;
        for (const a of attempts.values()) if (a.state !== 'failed' && a.state !== 'abandoned') a.state = 'committed';
        maybeCrash('commit-response');
      }
      return { data, warnings: [] };
    },
  } as unknown as Engine;
  const providerCreate = async (payload: any) => {
    calls.push(structuredClone(payload));
    const name = payload.response_format?.json_schema.name;
    const point = name === 'emit_topology_plan' ? 'planner' : name === 'emit_wiki_sections' ? 'home' : name === 'emit_scope_adjudication' ? 'adjudicator'
      : name === 'emit_rule_check' ? 'rules' : 'page';
    events.push(point);
    if (point === 'page' || point === 'home') {
      const durable = activeExecutionForTest();
      expect(durable.captures.at(-1)?.receipt?.state).toBe('prepared');
      expect(durable.calls.at(-1)?.state).toBe('sent');
    }
    maybeCrash(point);
    if (point === 'rules') {
      const ruling = rulings.length > 0 ? rulings.shift() : { broken: [] };
      return { choices: [{ message: { content: JSON.stringify(ruling) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    }
    const output = point === 'adjudicator' ? { verdicts: JSON.parse(payload.messages.at(-1).content).comparisons.map((p: any) => ({ pair_id: p.pair_id, candidate_plan_key: p.candidate_plan_key, compared_to: p.compared_to, relation: 'distinct', confidence: 0.95, evidence_ids: [], reason: 'Distinct.', narrower: 'none' })) } : point === 'planner' ? { reviewed_page_ids: merge ? ['source'] : [], actions: [{ op: 'create', plan_key: 'page', title: 'Project — Decisions', kind: 'workstream',
      scope: { v: 1, subject: 'Project', facet: 'Decisions' }, synthesis_brief: 'Write decisions.' }, ...(merge ? [{ op: 'merge', target: { plan_key: 'page' }, sources: ['source'], scope: { v: 1, subject: 'Project', facet: 'Decisions' }, reason: 'Canonical target', synthesis_brief: 'Consolidate decisions' }] : [])] }
      : point === 'page' ? { body: '## Decisions\n\nWe decided.', log_note: 'Decision update.' }
      : { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Updated' };
    return { choices: [{ message: { content: crash === 'billed-page' && point === 'page' ? 'invalid JSON' : (point === 'page' ? pageOutputFrame : JSON.stringify)(transformOutput ? transformOutput(point, output) : output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  };
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: providerCreate } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  function activeExecutionForTest() { return store.read() as ActivePageRequestExecution; }
  const run = () => runRequestedPagePipeline({ engine, llm: adapter, config: base.snapshot.config as unknown as Config,
    project: 'Project', rootTitle: 'Project', wikiRootId: base.projectId, requestId: '1', evidenceHash: 'hash-1',
    evidenceText: base.snapshot.evidenceText, evidenceNodes: [], existingWiki: base.snapshot.existingWiki, dryRun: false,
    execution: requestedExecutionContext(store), provenance: new EvidenceCollector({}) });
  const config = { ...base.snapshot.config, projectHomeProvenanceEnabled: true,
    wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
    wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit' } as unknown as Config;
  const request = (over: Partial<Config> = {}, options: Omit<NonNullable<Parameters<typeof curateRequestedPage>[7]>, 'store'> = {}) =>
    curateRequestedPage(engine, adapter, { ...config, ...over },
      { id: base.projectId, title: 'Project', file_path: 'Project.md', status: 'active' }, { id: 1, title: 'Decisions' }, false, 'vault', { store, ...options });
  return { run, request, engine, adapter, providerCreate, config, events, calls, writes, attempts, stages, rulings,
    setOutput: (transform: (point: string, output: any) => unknown) => { transformOutput = transform; } };
}
it.each(['planner', 'page', 'home'])('blocks restart after a dispatched %s loses its result', async point => {
  const f = pipelineFixture(point);
  await expect(f.run()).rejects.toThrow();
  const count = f.calls.length;
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect(f.calls).toHaveLength(count);
});
it.each(['stage:d0', 'stage:d1', 'submission', 'commit-response'])('recovers %s without another paid call and keeps original receipts', async point => {
  const f = pipelineFixture(point);
  await expect(f.run()).rejects.toThrow();
  const recovery = await recoverRequestedPage(f.engine, store);
  if (recovery === 'resume') await f.run();
  else expect(recovery).toBe('committed');
  expect(f.calls).toHaveLength(4);
  expect((store.read() as ActivePageRequestExecution).result?.provenance_receipts?.map(r => r.derivation_id)).toEqual(['d1', 'd0']);
  expect(f.attempts.size).toBe(2);
});

it('restores all cached usage in the resumed result without reporting provider spend twice', async () => {
  const f = pipelineFixture('stage:d1');
  await expect(f.run()).rejects.toThrow();
  expect(await recoverRequestedPage(f.engine, store)).toBe('resume');
  const resumed = await f.run();
  expect(resumed.usage).toEqual({ input: 40, output: 8, cacheWrite: 0, cacheRead: 0 });
  expect(resumed.invocationUsage).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  expect(f.calls).toHaveLength(4);
});
it('replays identical frozen requests across midnight', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T23:59:59Z'));
  const f = pipelineFixture('stage:d0');
  await expect(f.run()).rejects.toThrow();
  vi.setSystemTime(new Date('2026-09-26T00:00:01Z'));
  expect(await recoverRequestedPage(f.engine, store)).toBe('resume');
  await f.run();
  expect(f.calls).toHaveLength(4);
  for (const request of f.stages.values()) expect(request.generated_at).toBe('2026-09-25T23:59:59.000Z');
});
it.each(['purged', 'expired'] as const)('erases cached material after capture %s and never publishes', async availability => {
  const f = pipelineFixture('stage:d0');
  await expect(f.run()).rejects.toThrow();
  for (const attempt of f.attempts.values()) attempt.availability = availability;
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect(store.read()).not.toHaveProperty('snapshot');
  expect(f.writes).toHaveLength(0);
});
it('blocks changed project evidence before using cached paid results', async () => {
  const f = pipelineFixture('stage:d0');
  await expect(f.run()).rejects.toThrow();
  const original = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => ({ ...await original(...args), evidence_hash: 'changed' });
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_PROJECT_CHANGED' });
  expect(f.writes).toHaveLength(0);
});
it('does not replace an execution generation after a delayed provider completes', async () => {
  let complete!: (value: typeof result) => void;
  const pending = checkpointRequestedCall({ store, key: 'planner:0', requestDigest: 'original',
    invoke: () => new Promise(resolve => { complete = resolve; }) });
  const previous = store.read()!;
  store.write(previous.generation, active());
  complete(result);
  await expect(pending).rejects.toThrow('REQUEST_EXECUTION_CONFLICT');
  expect((store.read() as ActivePageRequestExecution).calls).toHaveLength(0);
});

it('freezes actual evidence and settings for entrypoint recovery, including disabled live provenance', async () => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  const firstOutcome = await f.request();
  expect(firstOutcome.outcome).toBe('error');
  expect(store.read(), firstOutcome.detail).not.toBeNull();
  const frozen = store.read() as ActivePageRequestExecution;
  expect(frozen.snapshot.homeAttribution?.items.map(item => item.origin)).toEqual(['identified', 'opaque']);
  const resumed = await f.request({ model: 'substituted', curatorRequestedPagePrompt: 'changed', homeMaxTokens: 1, projectHomeProvenanceEnabled: false });
  expect(resumed.outcome).toBe('written');
  expect(resumed.usage).toEqual({ input: 40, output: 8, cacheWrite: 0, cacheRead: 0 });
  expect(f.calls).toHaveLength(4);
  expect(f.calls.every((call: any) => call.model === 'test-model')).toBe(true);
});
it('freezes the selected memories so a resumed request shows its page the same ones (#313)', async () => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  const observation = (id: number) => ({ source: { kind: 'memory', namespace: 'vault', native_id: String(id) },
    authority: 'engine', observed_at: new Date().toISOString(), native_version: null, content_hash: `memory-${id}`,
    hash_semantics: 'engine_content_hash', observation_projection: 'memory-content-v1',
    observation_digest: `sha256:json-v1:${String(id).repeat(64).slice(0, 64)}`, label: null, path: null });
  let live = [{ id: 7, source: 'curator', scope: 'vault', node_id: null, content: 'The client runs its own gateway.',
    category: 'fact', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', evidence_kind: 'note',
    expired_at: null, provenance_observation: observation(7) }];
  const lists: Array<Record<string, unknown>> = [];
  Object.assign(f.engine, { listMemoriesWithTotal: async (filters: Record<string, unknown>) => {
    lists.push(filters);
    return filters.scope === 'node' && filters.node_id === 'project-1' ? { memories: live, total: live.length } : { memories: [], total: 0 };
  } });

  expect((await f.request()).outcome).toBe('error');
  const frozen = store.read() as ActivePageRequestExecution;
  expect(lists.length).toBeGreaterThan(0);
  expect(lists.every(filters => filters.includeProvenance === true)).toBe(true);
  expect(frozen.snapshot.memories).toEqual([expect.objectContaining({ id: 7, content: 'The client runs its own gateway.' })]);
  expect(frozen.snapshot.memories![0]).not.toHaveProperty('expired_at');
  // Dated and sourced, as a full build shows them (#631).
  // A midnight-UTC date is that day in any zone (#706).
  const line = '- [fact] 2026-11-01, from a note: The client runs its own gateway.';
  expect(frozen.snapshot.memories![0]!.source_label).toBe('2026-11-01, from a note');
  expect(frozen.snapshot.evidenceText).toContain(line);
  expect(frozen.snapshot.homeAttribution?.items.filter(item => item.selection === 'memory:v2')
    .map(item => item.observation?.source.native_id)).toEqual(['7']);
  const page = f.calls.find((call: any) => call.response_format?.json_schema.name !== 'emit_topology_plan'
    && JSON.parse(call.messages.at(-1).content).synthesis_brief !== undefined) as any;
  expect(JSON.parse(page.messages.at(-1).content).evidence).toContain(line);

  live = [{ ...live[0]!, id: 8, content: 'A memory written after the request started.', provenance_observation: observation(8) }];
  const resumed = await f.request();
  expect(resumed.outcome).toBe('written');
  expect(f.calls).toHaveLength(4);
});
it('freezes the meeting window so a request stamps the same evidence hash a full curation computes', async () => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  const windows: unknown[] = [];
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args: Parameters<typeof evidence>) => { windows.push(args[1]); return evidence(...args); };
  expect((await f.request({ meetingReads: 7 })).outcome).toBe('error');
  expect((store.read() as ActivePageRequestExecution).snapshot.config.meetingReads).toBe(7);
  expect((await f.request({ meetingReads: 7 })).outcome).toBe('written');
  expect(windows.length).toBeGreaterThan(0);
  expect(windows.every(window => window === 7)).toBe(true);
});
it('freezes the time zone so a resumed request sends the same date lines and stamps the same Log (#459)', async () => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  expect((await f.request({ curatorTz: 'Asia/Tokyo' })).outcome).toBe('error');
  const frozen = store.read() as ActivePageRequestExecution;
  expect(frozen.snapshot.config.curatorTz).toBe('Asia/Tokyo');
  // The live setting changed since: the checkpointed calls must still match, so the zone is the frozen one.
  expect((await f.request({ curatorTz: 'UTC' })).outcome).toBe('written');
  // The planner, page and home calls carry the date line; the adjudicator has none.
  const lines = f.calls.flatMap((call: any) => String(call.messages[0].content).match(/Today is [A-Za-z]+, \S+ \([^)]+\)\./g) ?? []);
  expect(lines).toHaveLength(3);
  expect(new Set(lines)).toEqual(new Set([currentDateLine(new Date(frozen.generatedAt), 'Asia/Tokyo')]));
  const log = f.writes.find(write => !write.dry_run)!.home.sections.find(section => section.name === 'Log')!;
  expect(log.content).toBe(`**${localDate(new Date(frozen.generatedAt), 'Asia/Tokyo')}** — Updated`);
});
it('requires durable storage before captured paid project work', async () => {
  const f = pipelineFixture();
  const result = await curateRequestedPage(f.engine, f.adapter, f.config,
    { id: 'project-1', title: 'Project', file_path: '', status: null }, { title: 'Decisions' }, false);
  expect(result).toMatchObject({ outcome: 'error', detail: 'REQUEST_EXECUTION_REQUIRED' });
  expect(f.calls).toHaveLength(0);
});
it('recovers committed identity and both original receipts at the requested-page entrypoint', async () => {
  const f = pipelineFixture('commit-response');
  store.clear(store.read()!.generation);
  const firstOutcome = await f.request();
  expect(firstOutcome.outcome).toBe('error');
  expect(store.read(), firstOutcome.detail).not.toBeNull();
  const recovered = await f.request();
  expect(recovered).toMatchObject({ outcome: 'written', nodeId: 'page', qualifiedTitle: 'Project — Decisions',
    resolvedTo: { action: 'created', nodeId: 'page' },
    usage: { input: 40, output: 8, cacheWrite: 0, cacheRead: 0 },
    invocationUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } });
  expect((store.read() as ActivePageRequestExecution).result?.provenance_receipts?.map(r => r.output_revision_id)).toEqual(['od1', 'od0']);
  expect(f.calls).toHaveLength(4);
});

import { requestWikiPage, curateOne, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import { makeCuratorStatusHandler } from '../src/tools/curator-status.js';
import { UsageReporter } from '../src/usage-reporter.js';
import { getPageRequest, pinnedPageNodeIds, markRequestFulfilled } from '../src/db/requests.js';
import { enrolProjects } from './project-wiki-fixtures.js';
import { upsertVerdict } from '../src/db/reconcile.js';
import { peopleBlockContacts, peopleBlocks } from '../src/evidence.js';

function coreFixture(crash?: string, merge = false) {
  const f = pipelineFixture(crash, merge);
  const project = { id: 'project-1', title: 'Project', file_path: 'Project.md', status: 'active' };
  f.engine.listActiveProjects = async () => [project];
  const latestId = () => (db.prepare('SELECT MAX(id) AS id FROM page_requests').get() as { id: number }).id;
  store = { read: () => readRequestExecution(db, latestId()), write: (generation, next) => writeRequestExecution(db, latestId(), generation, next),
    clear: generation => clearRequestExecution(db, latestId(), generation) };
  const deps: CoreDeps = { engine: f.engine, llm: f.adapter, config: f.config, db, queue: new CurationQueue() };
  return { ...f, deps, latestId };
}
it.each(['fulfillment', 'terminal-checkpoint'])('queue recovery repairs %s failure after commit with no further provider call', async boundary => {
  const f = coreFixture();
  db.exec(boundary === 'fulfillment'
    ? "CREATE TRIGGER crash_bookkeeping BEFORE UPDATE OF status ON page_requests WHEN NEW.status='fulfilled' BEGIN SELECT RAISE(ABORT, 'crash'); END;"
    : "CREATE TRIGGER crash_bookkeeping BEFORE UPDATE OF execution_json ON page_requests WHEN json_extract(NEW.execution_json, '$.phase')='committed' BEGIN SELECT RAISE(ABORT, 'crash'); END;");
  const first = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  expect(first).toMatchObject({ ok: false, status: 'pending', error: { message: 'REQUEST_BOOKKEEPING_PENDING' } });
  expect(getPageRequest(db, f.latestId())?.status).toBe('pending');
  expect((store.read() as ActivePageRequestExecution).result?.provenance_receipts).toHaveLength(2);
  db.exec('DROP TRIGGER crash_bookkeeping');
  // The subsequent full curation is independent of requested recovery. End it
  // at evidence gathering so this assertion counts requested provider work only.
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => {
    if (getPageRequest(db, f.latestId())?.status === 'fulfilled') throw new Error('end independent full curation');
    return evidence(...args);
  };
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(getPageRequest(db, f.latestId())).toMatchObject({ status: 'fulfilled', page_node_id: 'page' });
  expect(pinnedPageNodeIds(db, 'Project')).toEqual(new Set(['page']));
  expect(store.read()).toMatchObject({ phase: 'committed' });
  expect(store.read()).not.toHaveProperty('snapshot');
  expect(f.calls).toHaveLength(4);
});
it('keeps identical-title new tool requests as distinct pending rows', async () => {
  const f = coreFixture();
  const a = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'next-run' });
  const b = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'next-run' });
  expect(a.request_id).not.toBe(b.request_id);
  expect(getPageRequest(db, a.request_id!)?.status).toBe('pending');
  expect(getPageRequest(db, b.request_id!)?.status).toBe('pending');
  expect(f.calls).toHaveLength(0);
});

it('retries preparation after a proven pre-dispatch rejection without repeating earlier paid stages', async () => {
  const f = pipelineFixture();
  const prepare = f.engine.prepareProvenance.bind(f.engine);
  let reject = true;
  f.engine.prepareProvenance = async request => {
    if (reject) { reject = false; throw new Error('setup unavailable'); }
    return prepare(request);
  };
  await expect(f.run()).rejects.toThrow();
  expect((store.read() as ActivePageRequestExecution).calls.map(c => c.state)).toEqual(['result', 'result']);
  expect(await recoverRequestedPage(f.engine, store)).toBe('resume');
  await f.run();
  expect(f.calls).toHaveLength(4);
});
it('blocks expired durable reads and queue cleanup cannot turn them into fresh paid work', async () => {
  vi.useFakeTimers();
  const f = coreFixture('page');
  const initial = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  expect(initial.ok).toBe(false);
  vi.setSystemTime(new Date(Date.now() + 86400001));
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  f.engine.projectEvidence = async () => { throw new Error('end independent full curation'); };
  const paid = f.calls.length;
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(getPageRequest(db, f.latestId())?.status).toBe('failed');
  expect(store.read()).toBeNull();
  expect(f.calls).toHaveLength(paid);
});
it('does not reuse saved results while Engine is unavailable', async () => {
  const f = pipelineFixture('stage:d0');
  await expect(f.run()).rejects.toThrow();
  const calls = f.calls.length;
  f.engine.inspectProvenance = async () => { throw new Error('offline'); };
  await expect(recoverRequestedPage(f.engine, store)).rejects.toThrow('offline');
  expect(f.calls).toHaveLength(calls);
  expect((store.read() as ActivePageRequestExecution).calls.some(c => c.state === 'result')).toBe(true);
});

it('rolls back fulfillment when pin retargeting fails, then repairs old pins from authoritative mappings', async () => {
  const f = coreFixture(undefined, true);
  const old = f.latestId();
  markRequestFulfilled(db, old, 'Project — Legacy', 'source', new Date().toISOString());
  db.exec("CREATE TRIGGER crash_pins BEFORE UPDATE OF page_node_id ON page_requests WHEN OLD.page_node_id='source' BEGIN SELECT RAISE(ABORT, 'pin crash'); END;");
  const first = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  expect(first, JSON.stringify(first)).toMatchObject({ ok: false, status: 'pending', error: { message: 'REQUEST_BOOKKEEPING_PENDING' } });
  expect(getPageRequest(db, old)?.page_node_id).toBe('source');
  expect(getPageRequest(db, f.latestId())?.status).toBe('pending');
  db.exec('DROP TRIGGER crash_pins');
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => {
    if (getPageRequest(db, f.latestId())?.status === 'fulfilled') throw new Error('end independent full curation');
    return evidence(...args);
  };
  const paid = f.calls.length;
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(getPageRequest(db, old)).toMatchObject({ status: 'fulfilled', page_node_id: 'page', page_title: 'Project — Decisions' });
  expect(getPageRequest(db, f.latestId())?.page_node_id).toBe('page');
  expect(pinnedPageNodeIds(db, 'Project')).toEqual(new Set(['page']));
  expect(f.calls).toHaveLength(paid);
});

it('refuses dispatch when the execution generation changes during captured preparation', async () => {
  const execution = requestedExecutionContext(store);
  let dispatched = false;
  const llm = execution.llmFor({ supportsPreparedCapture: true,
    previewStructuredCall: async () => ({ provider: 'openrouter', model: 'model', adapter_version: 'v1', payload: {} }),
    structuredCall: async () => { dispatched = true; return result; },
  }, 'page:target');
  await expect(llm.structuredCall({ model: 'model', maxTokens: 1, system: 'sys', user: 'user', toolName: 'tool', toolDescription: 'desc', schema: {},
    onPrepared: async () => { store.write(store.read()!.generation, active()); },
  })).rejects.toThrow('REQUEST_EXECUTION_CONFLICT');
  expect(dispatched).toBe(false);
  expect((store.read() as ActivePageRequestExecution).calls).toHaveLength(0);
});

it('keeps sent uncertainty when a paid result cannot be persisted', async () => {
  db.exec("CREATE TRIGGER crash_result BEFORE UPDATE OF execution_json ON page_requests WHEN json_extract(NEW.execution_json, '$.calls[0].state')='result' BEGIN SELECT RAISE(ABORT, 'result crash'); END;");
  let paid = 0;
  const invoke = async () => { paid++; return result; };
  await expect(checkpointRequestedCall({ store, key: 'planner:0', requestDigest: 'digest', invoke })).rejects.toThrow();
  db.exec('DROP TRIGGER crash_result');
  expect(await recoverRequestedPage({} as Engine, store)).toBe('blocked');
  expect(paid).toBe(1);
});
it.each(['stage-request', 'reconcile-request', 'commit-result'])('recovers %s persistence failure with original paid results', async boundary => {
  const f = pipelineFixture();
  const condition = boundary === 'stage-request' ? "json_type(NEW.execution_json, '$.captures[0].stageRequest')='object'"
    : boundary === 'reconcile-request' ? "json_extract(NEW.execution_json, '$.phase')='staged'"
    : "json_type(NEW.execution_json, '$.result')='object'";
  db.exec(`CREATE TRIGGER crash_checkpoint BEFORE UPDATE OF execution_json ON page_requests WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'checkpoint crash'); END;`);
  await expect(f.run()).rejects.toThrow();
  db.exec('DROP TRIGGER crash_checkpoint');
  const recovered = await recoverRequestedPage(f.engine, store);
  if (recovered === 'resume') await f.run(); else expect(recovered).toBe('committed');
  expect(f.calls).toHaveLength(4);
  expect((store.read() as ActivePageRequestExecution).result?.provenance_receipts?.map(r => r.output_revision_id)).toEqual(['od1', 'od0']);
});

it.each([{ kind: 'topic' as const, enabled: true }, { kind: 'project' as const, enabled: false }])(
  'preserves uncaptured behavior for $kind with capture setting $enabled', async ({ kind, enabled }) => {
    const f = pipelineFixture();
    const llm = { configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }), withConfiguration() { return this; }, structuredCall: async (request: import('../src/llm/types.js').StructuredCallRequest) => ({
      output: request.toolName === 'emit_topology_plan' ? { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'page',
        title: 'Project — Decisions', kind: 'workstream', scope: { v: 1, subject: 'Project', facet: 'Decisions' }, synthesis_brief: 'Write decisions.' }] }
        : request.toolName === 'emit_scope_adjudication' ? { verdicts: JSON.parse(request.user).comparisons.map((p: any) => ({
          pair_id: p.pair_id, candidate_plan_key: p.candidate_plan_key, compared_to: p.compared_to, relation: 'distinct', confidence: 0.95,
          evidence_ids: [], reason: 'Distinct', narrower: 'none' })) }
        : request.toolName === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
        : { body: 'Page body' }, usage: result.usage,
    }) };
    const outcome = await curateRequestedPage(f.engine, llm, { ...f.config, projectHomeProvenanceEnabled: enabled },
      { id: 'project-1', title: 'Project', file_path: '', status: null }, { title: 'Decisions' }, false, 'vault', { kind });
    expect(outcome.outcome, outcome.detail).toBe('written');
    expect(f.attempts.size).toBe(0);
    expect(f.writes.every(write => write.provenance_mode === undefined && write.home.provenance === undefined)).toBe(true);
    // A topic has no tasks, so its Focus items are plain bullets.
    const focus = kind === 'topic' ? '- **Focus**' : '- [ ] **Focus**';
    expect(f.writes.every(write => JSON.stringify(write.home).includes(`"name":"Focus","mode":"replace","content":${JSON.stringify(focus)}`)))
      .toBe(true);
  });
it.each([
  { kind: 'project' as const, source: 'vault' as const, expected: 'project' },
  { kind: 'topic' as const, source: 'vault' as const, expected: 'topic' },
  { kind: 'topic' as const, source: 'vault+web' as const, expected: 'topicWeb' },
  { kind: 'project' as const, source: 'vault' as const, override: 'OWNER HOME PROMPT', expected: 'override' },
])('rewrites the home with the $kind wiki\'s own home prompt ($expected)', async ({ kind, source, override, expected }) => {
  const f = pipelineFixture();
  const homeSystems: string[] = [];
  const llm = { configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }), withConfiguration() { return this; }, structuredCall: async (request: import('../src/llm/types.js').StructuredCallRequest) => {
    if (request.toolName === 'emit_wiki_sections') homeSystems.push(request.system);
    return {
      output: request.toolName === 'emit_topology_plan' ? { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'page',
        title: 'Project — Decisions', kind: 'workstream', scope: { v: 1, subject: 'Project', facet: 'Decisions' }, synthesis_brief: 'Write decisions.' }] }
        : request.toolName === 'emit_scope_adjudication' ? { verdicts: JSON.parse(request.user).comparisons.map((p: any) => ({
          pair_id: p.pair_id, candidate_plan_key: p.candidate_plan_key, compared_to: p.compared_to, relation: 'distinct', confidence: 0.95,
          evidence_ids: [], reason: 'Distinct', narrower: 'none' })) }
        : request.toolName === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
        : { body: 'Page body' }, usage: result.usage,
    };
  } };
  const config = { ...f.config, projectHomeProvenanceEnabled: false, curatorProjectHomePrompt: override ?? '', curatorTopicPrompt: '', curatorTopicWebPrompt: '' };
  if (source === 'vault+web') f.engine.webSearch = async () => ({ results: [] }) as never;
  const outcome = await curateRequestedPage(f.engine, llm, config,
    { id: 'project-1', title: 'Project', file_path: '', status: null }, { title: 'Decisions' }, false, source, { kind });
  expect(outcome.outcome, outcome.detail).toBe('written');
  const prompts = { project: SPEC_A_SYSTEM_PROMPT, topic: TOPIC_SYSTEM_PROMPT, topicWeb: TOPIC_WEB_SYSTEM_PROMPT, override: 'OWNER HOME PROMPT' };
  expect(homeSystems).toHaveLength(1);
  expect(homeSystems[0]!.startsWith(prompts[expected as keyof typeof prompts])).toBe(true);
});
it.each([true, false])('a captured request (dry run %s) rewrites the home with the home prompt override', async dryRun => {
  const f = pipelineFixture();
  store.clear(store.read()!.generation);
  const payloads: any[] = [];
  // A preview has no saved execution, which the fixture's provider expects for page and home calls.
  const previewAdapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    payloads.push(payload);
    const name = payload.response_format?.json_schema.name;
    const output = name === 'emit_topology_plan' ? { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'page', title: 'Project — Decisions',
      kind: 'workstream', scope: { v: 1, subject: 'Project', facet: 'Decisions' }, synthesis_brief: 'Write decisions.' }] }
      : name === 'emit_scope_adjudication' ? { verdicts: JSON.parse(payload.messages.at(-1).content).comparisons.map((p: any) => ({ pair_id: p.pair_id,
        candidate_plan_key: p.candidate_plan_key, compared_to: p.compared_to, relation: 'distinct', confidence: 0.95, evidence_ids: [], reason: 'Distinct.', narrower: 'none' })) }
      : name === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Updated' }
      : { body: '## Decisions\n\nWe decided.', log_note: 'Decision update.' };
    return { choices: [{ message: { content: name === 'emit_wiki_sections' || name === 'emit_topology_plan' || name === 'emit_scope_adjudication'
      ? JSON.stringify(output) : pageOutputFrame(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const outcome = await curateRequestedPage(f.engine, dryRun ? previewAdapter : f.adapter, { ...f.config, curatorProjectHomePrompt: 'OWNER HOME PROMPT' },
    { id: 'project-1', title: 'Project', file_path: 'Project.md', status: 'active' }, { id: 1, title: 'Decisions' }, dryRun, 'vault', { store });
  expect(outcome.outcome, outcome.detail).toBe('written');
  const homeCalls = (dryRun ? payloads : f.calls).filter((call: any) => call.response_format?.json_schema.name === 'emit_wiki_sections');
  expect(homeCalls).toHaveLength(1);
  expect((homeCalls[0] as any).messages[0].content.startsWith('OWNER HOME PROMPT')).toBe(true);
});
it('keeps initial-home curation separate from requested execution and fulfillment', async () => {
  const f = pipelineFixture();
  store.clear(store.read()!.generation);
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => ({ ...await evidence(...args), existing_wiki: {
    home_id: null, home: null, topology_hash: 'empty', catalog_valid: true, subpages: [],
  } });
  expect(await f.request()).toMatchObject({ outcome: 'no-wiki' });
  expect(store.read()).toBeNull();
  expect(f.calls).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
});


it.each(['stage:d0', 'commit-response'])('refuses dry-run recovery after %s without mutating or dispatching', async point => {
  const f = pipelineFixture(point);
  store.clear(store.read()!.generation);
  expect((await f.request()).outcome).toBe('error');
  const before = store.read();
  const calls = f.calls.length;
  const mutations = [vi.spyOn(f.engine, 'prepareProvenance'), vi.spyOn(f.engine, 'transitionProvenance'),
    vi.spyOn(f.engine, 'stageProvenanceResult'), vi.spyOn(f.engine, 'wikiReconcile')];
  const preview = await curateRequestedPage(f.engine, f.adapter, f.config,
    { id: 'project-1', title: 'Project', file_path: 'Project.md', status: 'active' },
    { id: 1, title: 'Decisions' }, true, 'vault', { store });
  expect(preview).toMatchObject({ outcome: 'error', dryRun: true, detail: 'REQUEST_RECOVERY_DRY_RUN' });
  expect(store.read()).toEqual(before);
  expect(f.calls).toHaveLength(calls);
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
});

it.each([
  { reason: 'PROVENANCE_OBSERVATION_CHANGED' },
  { issues: [{ code: 'EXPECTED_VERSION_MISMATCH', message: 'Page changed' }] },
  { issues: [{ code: 'HOME_EXPECTED_VERSION_MISMATCH', message: 'Home changed' }] },
])('Core terminalizes authoritative prepublication stale rejection %j and never resubmits', async details => {
  const f = coreFixture();
  markRequestFulfilled(db, f.latestId(), 'Initial', 'initial-page', new Date().toISOString());
  const reconcile = f.engine.wikiReconcile.bind(f.engine);
  f.engine.wikiReconcile = async request => {
    if (!request.dry_run) throw new Error('offline before submission');
    return reconcile(request);
  };
  const first = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  expect(first).toMatchObject({ ok: false, status: 'pending' });
  const saved = store.read() as ActivePageRequestExecution;
  expect(saved.reconcile?.dry_run).toBe(false);
  expect(saved.result).toBeUndefined();
  const submit = vi.fn(async () => { throw new EngineError('STALE_NODE', 'Stale publication', details); });
  f.engine.wikiReconcile = submit;
  f.engine.projectEvidence = async () => { throw new Error('end independent full curation'); };
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(getPageRequest(db, f.latestId())?.status).toBe('failed');
  expect(store.read()).toEqual({ version: 1, generation: saved.generation, projectId: saved.projectId,
    runRef: saved.runRef, generatedAt: saved.generatedAt, phase: 'failed', errorCode: 'REQUEST_PROJECT_CHANGED' });
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect(submit).toHaveBeenCalledTimes(1);
  expect(f.calls).toHaveLength(4);
});

it.each(['offline', 'internal', 'malformed-stale', 'malformed-result', 'known-commit'])(
  'preserves the exact saved reconcile on ambiguous %s recovery', async reason => {
    const f = pipelineFixture(reason === 'known-commit' ? 'commit-response' : undefined);
    store.clear(store.read()!.generation);
    const reconcile = f.engine.wikiReconcile.bind(f.engine);
    if (reason !== 'known-commit') f.engine.wikiReconcile = async request => {
      if (!request.dry_run) throw new Error('offline before submission');
      return reconcile(request);
    };
    expect((await f.request()).outcome).toBe('error');
    const saved = store.read();
    expect(saved).toHaveProperty('reconcile');
    f.engine.wikiReconcile = async request => {
      if (reason === 'malformed-result') return { data: { reconcile_key: request.reconcile_key, dry_run: false } as any, warnings: [] };
      if (reason === 'internal') throw new EngineError('INTERNAL_ERROR', 'Unavailable');
      if (reason === 'malformed-stale') throw new EngineError('STALE_NODE', 'Unverifiable response', { reason: 'unknown' });
      if (reason === 'known-commit') throw new EngineError('STALE_NODE', 'Contradicts committed capture', { reason: 'PROVENANCE_OBSERVATION_CHANGED' });
      throw new Error('offline');
    };
    expect((await f.request()).outcome).toBe('error');
    expect(store.read()).toEqual(saved);
    expect(f.calls).toHaveLength(4);
  });


function requestedSpendRows() {
  return db.prepare("SELECT outcome,input_tokens,output_tokens,cost_usd FROM runs WHERE outcome LIKE 'requested_page%' ORDER BY id").all();
}
async function expectStatusSpend(deps: CoreDeps, input: number, output: number, cost: number) {
  const response = await makeCuratorStatusHandler(deps, new Date())({ limit: 20, window_hours: 168 }, { authInfo: { scopes: ['curate:read'] } });
  const status = JSON.parse(response.content[0]!.text);
  expect(status.aggregate).toMatchObject({ input_tokens: input, output_tokens: output });
  expect(status.aggregate.cost_usd).toBeCloseTo(cost, 10);
}
it.each(['committed', 'cached-continuation', 'repeated-bookkeeping'])(
  'records only newly dispatched run/status spend on %s recovery', async boundary => {
    const f = coreFixture(boundary === 'cached-continuation' ? 'stage:d0' : undefined);
    f.config.model = 'claude-haiku-4-5';
    const ledger: Record<string, unknown>[] = [];
    const reporter = new UsageReporter({ recordUsage: async args => { ledger.push(args); } } as Engine,
      { provider: 'openrouter', experiment: null, variant: null });
    f.deps.llm = reporter.wrap(f.adapter);
    markRequestFulfilled(db, f.latestId(), 'Initial', 'initial-page', new Date().toISOString());
    if (boundary !== 'cached-continuation') db.exec("CREATE TRIGGER crash_bookkeeping BEFORE UPDATE OF status ON page_requests WHEN NEW.status='fulfilled' BEGIN SELECT RAISE(ABORT, 'crash'); END;");
    expect(await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' })).toMatchObject({ ok: false, status: 'pending' });
    const firstInput = boundary === 'cached-continuation' ? 30 : 40;
    expect(requestedSpendRows()).toEqual([{ outcome: 'requested_page_error', input_tokens: firstInput, output_tokens: firstInput / 5, cost_usd: firstInput * 2 / 1_000_000 }]);
    const evidence = f.engine.projectEvidence.bind(f.engine);
    f.engine.projectEvidence = async (...args) => {
      // Recovery needs evidence only before a saved reconcile exists. Stop the independent full run.
      const state = store.read();
      if (!state || !('snapshot' in state) || state.reconcile) throw new Error('end independent full curation');
      return evidence(...args);
    };
    const resume = () => curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    if (boundary === 'repeated-bookkeeping') {
      await resume(); await resume();
      expect(getPageRequest(db, f.latestId())?.status).toBe('pending');
      expect(requestedSpendRows()).toHaveLength(3);
      await expectStatusSpend(f.deps, 40, 8, 0.00008);
    }
    if (boundary !== 'cached-continuation') db.exec('DROP TRIGGER crash_bookkeeping');
    await resume();
    expect(getPageRequest(db, f.latestId())?.status).toBe('fulfilled');
    expect(f.calls).toHaveLength(4);
    const newInput = boundary === 'cached-continuation' ? 10 : 0;
    expect(requestedSpendRows().at(-1)).toEqual({ outcome: 'requested_page', input_tokens: newInput, output_tokens: newInput / 5, cost_usd: newInput * 2 / 1_000_000 });
    await expectStatusSpend(f.deps, 40, 8, 0.00008);
    expect(ledger).toHaveLength(4);
    expect(ledger.map(call => [call.input_tokens, call.output_tokens])).toEqual([[10, 2], [10, 2], [10, 2], [10, 2]]);
  });

it('retains known billed failing-call spend once when uncertainty blocks recovery', async () => {
  const f = coreFixture('billed-page');
  f.config.model = 'claude-haiku-4-5';
  markRequestFulfilled(db, f.latestId(), 'Initial', 'initial-page', new Date().toISOString());
  expect(await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' })).toMatchObject({ ok: false, status: 'pending' });
  expect(requestedSpendRows()).toEqual([{ outcome: 'requested_page_error', input_tokens: 30, output_tokens: 6, cost_usd: 0.00006 }]);
  f.engine.projectEvidence = async () => { throw new Error('end independent full curation'); };
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(getPageRequest(db, f.latestId())?.status).toBe('failed');
  expect(f.calls).toHaveLength(3);
  await expectStatusSpend(f.deps, 30, 6, 0.00006);
});

for (const phase of ['preview', 'commit'] as const) {
it.each([
  { reason: 'PROVENANCE_OBSERVATION_CHANGED' },
  { issues: [{ code: 'EXPECTED_VERSION_MISMATCH', message: 'Page changed' }] },
  { issues: [{ code: 'HOME_EXPECTED_VERSION_MISMATCH', message: 'Home changed' }] },
])(`Core terminalizes definitive stale ${phase} rejection %j immediately`, async details => {
  const f = coreFixture();
  markRequestFulfilled(db, f.latestId(), 'Initial', 'initial-page', new Date().toISOString());
  const reconcile = f.engine.wikiReconcile.bind(f.engine);
  const preview = vi.fn(async (request: WikiReconcileInput) => {
    if (phase === 'commit' && request.dry_run) return reconcile(request);
    expect(request.dry_run).toBe(phase === 'preview');
    if (phase === 'preview') expect((store.read() as ActivePageRequestExecution).reconcile).toBeUndefined();
    else expect((store.read() as ActivePageRequestExecution).reconcile?.dry_run).toBe(false);
    throw new EngineError('STALE_NODE', 'Stale publication', details);
  });
  f.engine.wikiReconcile = preview;
  expect(await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' })).toMatchObject({ ok: false, status: 'failed' });
  expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_PROJECT_CHANGED' });
  expect(store.read()).not.toHaveProperty('snapshot');
  expect(store.read()).not.toHaveProperty('calls');
  expect(store.read()).not.toHaveProperty('captures');
  f.engine.projectEvidence = async () => { throw new Error('end independent full curation'); };
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect(preview).toHaveBeenCalledTimes(phase === 'preview' ? 1 : 2);
  expect(f.calls).toHaveLength(4);
});

it.each(['offline', 'internal', 'malformed-stale', 'malformed-result', 'known-commit'])(
  `preserves recoverable checkpoints after %s ${phase}`, async reason => {
    const f = pipelineFixture('stage:d1');
    await expect(f.run()).rejects.toThrow();
    const before = store.read() as ActivePageRequestExecution;
    if (reason === 'known-commit') {
      before.captures[0]!.receipt!.state = 'committed';
      store.write(before.generation, before);
    }
    const reconcile = f.engine.wikiReconcile.bind(f.engine);
    const preview = vi.fn(async (request: WikiReconcileInput) => {
      if (phase === 'commit' && request.dry_run) return reconcile(request);
      if (reason === 'malformed-result') return { data: {} as any, warnings: [] };
      if (reason === 'internal') throw new EngineError('INTERNAL_ERROR', 'Unavailable');
      if (reason === 'malformed-stale') throw new EngineError('STALE_NODE', 'Unknown', { reason: 'unknown' });
      if (reason === 'known-commit') throw new EngineError('STALE_NODE', 'Contradictory', { reason: 'PROVENANCE_OBSERVATION_CHANGED' });
      throw new Error('offline');
    });
    f.engine.wikiReconcile = preview;
    await expect(f.run()).rejects.toThrow();
    expect(preview).toHaveBeenCalledTimes(phase === 'preview' ? 1 : 2);
    const after = store.read() as ActivePageRequestExecution;
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.calls).toEqual(before.calls);
    expect(after.result).toEqual(before.result);
    expect(after.phase).not.toBe('failed');
    expect(f.calls).toHaveLength(4);
  });

}


it('does not abandon a replacement generation after a delayed stale replay rejection', async () => {
  const f = pipelineFixture();
  const reconcile = f.engine.wikiReconcile.bind(f.engine);
  f.engine.wikiReconcile = async request => {
    if (!request.dry_run) throw new Error('offline before submission');
    return reconcile(request);
  };
  await expect(f.run()).rejects.toThrow();
  expect(store.read()).toHaveProperty('reconcile');
  const original = store.read()!;
  const replacement = active();
  f.engine.wikiReconcile = async () => {
    store.write(original.generation, replacement);
    throw new EngineError('STALE_NODE', 'Delayed rejection', { reason: 'PROVENANCE_OBSERVATION_CHANGED' });
  };
  await expect(recoverRequestedPage(f.engine, store)).rejects.toThrow('REQUEST_EXECUTION_CONFLICT');
  expect(store.read()).toEqual(replacement);
  expect(f.calls).toHaveLength(4);
});


it.each(['preview', 'commit'] as const)('preserves a replacement generation after delayed stale %s rejection', async phase => {
  const f = pipelineFixture();
  const reconcile = f.engine.wikiReconcile.bind(f.engine);
  const replacement = active();
  f.engine.wikiReconcile = async request => {
    if (phase === 'commit' && request.dry_run) return reconcile(request);
    store.write(store.read()!.generation, replacement);
    throw new EngineError('STALE_NODE', 'Delayed rejection', { reason: 'PROVENANCE_OBSERVATION_CHANGED' });
  };
  await expect(f.run()).rejects.toThrow();
  expect(store.read()).toEqual(replacement);
  expect(f.calls).toHaveLength(4);
});


it.each([null, 0, 5])('preserves requested semantic ordering and five-body cap with missing candidate %s', async missingIndex => {
  const f = pipelineFixture();
  store.clear(store.read()!.generation);
  const candidates = Array.from({ length: 7 }, (_, i) => ({
    id: `semantic-${i}`, title: `Candidate ${i}`, types: ['note'], score: 1, status: null,
  }));
  f.engine.semanticRelated = async () => candidates;
  f.engine.getNode = async id => {
    if (id === `semantic-${missingIndex}`) throw new EngineError('NOT_FOUND', 'Node was deleted after search');
    return {
      id, title: candidates.find(c => c.id === id)!.title, types: ['note'], fields: {},
      body: `PRIVATE-BODY-${id}`, version: 1, metadata: { content_hash: 'hash' },
      provenance_observation: {
        source: { kind: 'node', namespace: 'vault', native_id: id }, authority: 'engine',
        observed_at: new Date().toISOString(), native_version: 1, content_hash: 'hash',
        hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2',
        observation_digest: `sha256:json-v1:${'a'.repeat(64)}`, label: id, path: `${id}.md`,
      },
    };
  };
  expect(await f.request({ semanticGapFillLimit: 15 })).toMatchObject({ outcome: 'written' });
  const nodes = (store.read() as ActivePageRequestExecution).snapshot.evidenceNodes;
  const retainedIds = missingIndex === null
    ? ['semantic-0', 'semantic-1', 'semantic-2', 'semantic-3', 'semantic-4', 'semantic-5', 'semantic-6']
    : missingIndex === 0
      ? ['semantic-1', 'semantic-2', 'semantic-3', 'semantic-4', 'semantic-5', 'semantic-6']
      : ['semantic-0', 'semantic-1', 'semantic-2', 'semantic-3', 'semantic-4', 'semantic-6'];
  expect(nodes.map(node => node.id)).toEqual(retainedIds);
  for (const [index, id] of retainedIds.entries()) {
    expect(nodes[index]?.provenance_observation?.source.native_id).toBe(id);
    expect(nodes[index]?.body).toBe(index < 5 ? `PRIVATE-BODY-${id}` : '');
    if (index < 5) expect(JSON.stringify(f.calls)).toContain(`PRIVATE-BODY-${id}`);
    else expect(JSON.stringify(f.calls)).not.toContain(`PRIVATE-BODY-${id}`);
  }
  if (missingIndex !== null) {
    expect(JSON.stringify(store.read())).not.toContain(`semantic-${missingIndex}`);
    expect(JSON.stringify(f.calls)).not.toContain(`Candidate ${missingIndex}`);
  }
});

it('continues with structured evidence when all optional requested candidates disappeared', async () => {
  const f = pipelineFixture();
  store.clear(store.read()!.generation);
  f.engine.semanticRelated = async () => [{ id: 'deleted', title: 'Deleted candidate', types: ['note'], score: 1, status: null }];
  f.engine.getNode = async () => { throw new EngineError('NOT_FOUND', 'Deleted'); };
  expect(await f.request()).toMatchObject({ outcome: 'written' });
  expect((store.read() as ActivePageRequestExecution).snapshot.evidenceNodes).toEqual([]);
  expect(JSON.stringify(f.calls)).not.toContain('Deleted candidate');
});

it.each([
  new Error('NOT_FOUND: transport failure'),
  new EngineError('UNAUTHORIZED', 'Authentication failed'),
  new EngineError('BAD_JSON', 'Malformed response'),
  new EngineError('INTERNAL_ERROR', 'Read failed'),
  new EngineError('OTHER_NOT_FOUND', 'Not the node-missing contract'),
])('fails closed on optional requested candidate read error $message', async error => {
  const f = pipelineFixture();
  store.clear(store.read()!.generation);
  f.engine.semanticRelated = async () => [{ id: 'candidate', title: 'Candidate', types: ['note'], score: 1, status: null }];
  f.engine.getNode = async () => { throw error; };
  expect(await f.request()).toMatchObject({ outcome: 'error', detail: error.message });
  expect(store.read()).toBeNull();
  expect(f.calls).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
});

it('fails closed when an existing optional requested candidate lacks a provenance observation', async () => {
  const f = pipelineFixture();
  store.clear(store.read()!.generation);
  f.engine.semanticRelated = async () => [{ id: 'candidate', title: 'Candidate', types: ['note'], score: 1, status: null }];
  f.engine.getNode = async id => ({ id, title: 'Candidate', types: ['note'], fields: {}, body: 'Existing evidence' });
  expect(await f.request()).toMatchObject({ outcome: 'error', detail: 'PROVENANCE_OBSERVATION_MISSING' });
  expect(store.read()).toBeNull();
  expect(f.calls).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
});

it.each([undefined, 'commit-response'])('fulfills Engine-sized results above the model-output budget (%s)', async crash => {
  const f = coreFixture(crash);
  const inspect = f.engine.inspectProvenance.bind(f.engine);
  f.engine.inspectProvenance = async input => {
    const response = await inspect(input);
    return response.select === 'status' ? { ...response, limits: { ...response.limits, outputBytes: 1024 } } : response;
  };
  const first = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  if (crash) {
    expect(first).toMatchObject({ ok: false, status: 'pending' });
    const evidence = f.engine.projectEvidence.bind(f.engine);
    f.engine.projectEvidence = async (...args) => {
      if (getPageRequest(db, f.latestId())?.status === 'fulfilled') throw new Error('end independent full curation');
      return evidence(...args);
    };
    await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  } else expect(first).toMatchObject({ ok: true, status: 'fulfilled' });
  expect(getPageRequest(db, f.latestId())).toMatchObject({ status: 'fulfilled', page_node_id: 'page' });
  expect(store.read()).toMatchObject({ phase: 'committed' });
  expect(store.read()).not.toHaveProperty('snapshot');
  expect(f.calls).toHaveLength(4);
});


it('rejects insufficient total checkpoint headroom before live publication', async () => {
  const limits = { requestBytes: 16_384, componentBytes: 8_192, outputBytes: 1024 };
  const baseline = pipelineFixture(undefined, false, limits);
  await baseline.run();
  const completed = store.read() as ActivePageRequestExecution;
  const { result: _result, ...beforeCommit } = completed;
  const tightTotal = Buffer.byteLength(JSON.stringify(beforeCommit)) + 128;
  expect(Buffer.byteLength(JSON.stringify(completed))).toBeGreaterThan(tightTotal);
  // The minimal fixture can be smaller than requestBytes: lower that independent
  // cap too while preserving enough room for the actual reconciliation request.
  const f = pipelineFixture(undefined, false, { ...limits,
    requestBytes: Math.min(limits.requestBytes, tightTotal),
    componentBytes: Math.min(limits.componentBytes, tightTotal), totalBytes: tightTotal });
  await expect(f.run()).rejects.toThrow('REQUEST_EXECUTION_BUDGET');
  expect(f.writes.filter(request => !request.dry_run)).toHaveLength(0);
  expect([...f.attempts.values()].every(attempt => attempt.state !== 'committed')).toBe(true);
});


it('checks total headroom before recovering a saved uncommitted reconciliation', async () => {
  const f = pipelineFixture(undefined, false, { requestBytes: 4096, componentBytes: 2048, outputBytes: 1024 });
  const reconcile = f.engine.wikiReconcile.bind(f.engine);
  f.engine.wikiReconcile = async request => {
    if (!request.dry_run) throw new Error('offline before commit');
    return reconcile(request);
  };
  await expect(f.run()).rejects.toThrow('offline before commit');
  f.engine.wikiReconcile = reconcile;
  const state = store.read() as ActivePageRequestExecution;
  state.snapshot.config.provenanceLimits.totalBytes = Math.max(4096, Buffer.byteLength(JSON.stringify(state)) + 128);
  store.write(state.generation, state);
  const writesBefore = f.writes.length;
  await expect(recoverRequestedPage(f.engine, store)).rejects.toThrow('REQUEST_EXECUTION_BUDGET');
  expect(f.writes).toHaveLength(writesBefore);
  expect([...f.attempts.values()].every(attempt => attempt.state !== 'committed')).toBe(true);
});


const invalidOutputs = [
  { name: 'planner schema', stage: 'planner', output: {}, calls: 1 },
  { name: 'planner exhausted repairs', stage: 'planner', output: { reviewed_page_ids: [], actions: [{ op: 'refresh', node_id: 'missing', scope: { v: 1, subject: 'Project', facet: 'Decisions' }, synthesis_brief: 'Write.' }] }, calls: 3 },
  { name: 'adjudicator schema', stage: 'adjudicator', output: { verdicts: 'invalid' }, calls: 2 },
  { name: 'page schema', stage: 'page', output: { body: '' }, calls: 3 },
  { name: 'page Markdown', stage: 'page', output: { body: '# Heading only' }, calls: 3 },
  { name: 'home schema', stage: 'home', output: {}, calls: 4 },
  { name: 'home Markdown', stage: 'home', output: { now: '<!-- ve:managed:Now -->bad', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Updated' }, calls: 4 },
];
it.each(invalidOutputs)('terminalizes cached $name without replaying provider calls', async scenario => {
  const f = coreFixture();
  if (scenario.name === 'page schema') {
    // Exercise downstream validation of a cached logical result. The new wire
    // parser rejects an empty body before it can become a successful cache entry.
    const call = OpenAiCompatLlmClient.prototype.structuredCall;
    vi.spyOn(OpenAiCompatLlmClient.prototype, 'structuredCall').mockImplementation(async function (this: OpenAiCompatLlmClient, request) {
      const result = await call.call(this, request);
      return request.openAiResponseFormat === 'page-markdown' ? { ...result, output: scenario.output } : result;
    });
  } else f.setOutput((point, output) => point === scenario.stage ? scenario.output : output);
  const response = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  expect(response).toMatchObject({ ok: false, status: 'failed' });
  expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_RESULT_INVALID' });
  expect(store.read()).not.toHaveProperty('snapshot');
  expect(store.read()).not.toHaveProperty('calls');
  expect(store.read()).not.toHaveProperty('captures');
  expect(f.calls).toHaveLength(scenario.calls);
  expect(f.writes).toHaveLength(0);
  expect(requestedSpendRows()).toMatchObject([{ input_tokens: scenario.calls * 10, output_tokens: scenario.calls * 2 }]);
  f.engine.projectEvidence = async () => { throw new Error('end independent full curation'); };
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect(f.calls).toHaveLength(scenario.calls);
  expect(f.writes).toHaveLength(0);
});

it('allows a successful planner repair before terminalizing invalid results', async () => {
  const f = coreFixture();
  let plans = 0;
  f.setOutput((point, output) => point === 'planner' && plans++ === 0 ? invalidOutputs[1]!.output : output);
  expect(await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' })).toMatchObject({ ok: true, status: 'fulfilled' });
  expect(f.calls).toHaveLength(5);
});

it('retries terminal checkpoint storage failure using cached invalid output without paid redispatch', async () => {
  const f = coreFixture();
  f.setOutput((point, output) => point === 'home' ? {} : output);
  db.exec("CREATE TRIGGER reject_terminal BEFORE UPDATE OF execution_json ON page_requests WHEN json_extract(NEW.execution_json, '$.phase')='failed' BEGIN SELECT RAISE(ABORT, 'storage failure'); END;");
  expect(await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' })).toMatchObject({ ok: false, status: 'pending' });
  expect(store.read()).toHaveProperty('snapshot');
  expect(f.calls).toHaveLength(4);
  db.exec('DROP TRIGGER reject_terminal');
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => {
    if (getPageRequest(db, f.latestId())?.status === 'failed') throw new Error('end independent full curation');
    return evidence(...args);
  };
  await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
  expect(getPageRequest(db, f.latestId())?.status).toBe('failed');
  expect(store.read()).not.toHaveProperty('snapshot');
  expect(f.calls).toHaveLength(4);
});


it.each(['reconcile', 'committed-capture', 'stored-result'] as const)('preserves possibly committed material despite invalid cached home output (%s)', async guard => {
  const f = pipelineFixture(guard === 'stored-result' ? undefined : 'commit-response');
  if (guard === 'stored-result') await f.run();
  else await expect(f.run()).rejects.toThrow();
  const saved = store.read() as ActivePageRequestExecution;
  expect(saved.reconcile).toBeDefined();
  const home = saved.calls.find(call => call.key === 'home:0')!;
  home.result!.output = {};
  if (guard !== 'reconcile') delete saved.reconcile;
  if (guard === 'committed-capture') saved.captures[0]!.receipt!.state = 'committed';
  store.write(saved.generation, saved);
  await expect(f.run()).rejects.toThrow();
  expect(store.read()).toHaveProperty('snapshot');
  expect(store.read()?.phase).not.toBe('failed');
  expect(f.calls).toHaveLength(4);
});

it('preserves a replacement request when an invalid cached result finishes validation', async () => {
  const f = pipelineFixture();
  const replacement = active();
  const execution = requestedExecutionContext(store);
  const llmFor = execution.llmFor;
  execution.llmFor = (client, key) => {
    const wrapped = llmFor(client, key);
    return { ...wrapped, structuredCall: async request => {
      const response = await wrapped.structuredCall(request);
      if (key === 'home:0') {
        store.write(store.read()!.generation, replacement);
        return { ...response, output: {} };
      }
      return response;
    } };
  };
  await expect(runRequestedPagePipeline({ engine: f.engine, llm: f.adapter, config: f.config,
    project: 'Project', rootTitle: 'Project', wikiRootId: 'project-1', requestId: '1', evidenceHash: 'hash-1',
    evidenceText: 'Evidence text', evidenceNodes: [], existingWiki: (store.read() as ActivePageRequestExecution).snapshot.existingWiki,
    dryRun: false, execution, provenance: new EvidenceCollector({}) })).rejects.toThrow('REQUEST_EXECUTION_CONFLICT');
  expect(store.read()).toEqual(replacement);
  expect(f.calls).toHaveLength(4);
});

it('keeps a pre-dispatch adjudicator storage failure recoverable instead of treating it as invalid output', async () => {
  const f = coreFixture();
  db.exec("CREATE TRIGGER reject_adjudicator BEFORE UPDATE OF execution_json ON page_requests WHEN json_array_length(NEW.execution_json, '$.calls')=2 BEGIN SELECT RAISE(ABORT, 'storage failure'); END;");
  expect(await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' })).toMatchObject({ ok: false, status: 'pending' });
  expect(store.read()).toHaveProperty('snapshot');
  expect(f.calls).toHaveLength(1);
});

it.each([false, true])('finishes the allowed adjudication repair before terminalizing ambiguity (repair succeeds: %s)', async succeeds => {
  const f = coreFixture(undefined, true);
  let adjudications = 0;
  f.setOutput((point, output) => {
    if (point !== 'adjudicator') return output;
    adjudications++;
    if (succeeds && adjudications === 2) return output;
    expect(output.verdicts.length).toBeGreaterThan(0);
    return { verdicts: output.verdicts.map((verdict: any) => ({ ...verdict, relation: 'substantial-overlap' })) };
  });
  const response = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
  expect(adjudications).toBe(2);
  expect(response).toMatchObject({ ok: succeeds, status: succeeds ? 'fulfilled' : 'failed' });
  expect(f.calls).toHaveLength(succeeds ? 6 : 4);
  if (!succeeds) {
    expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_RESULT_INVALID' });
    expect(store.read()).not.toHaveProperty('snapshot');
    expect(f.writes).toHaveLength(0);
  }
});


it.each(['preview', 'commit', 'recovery', 'changed-evidence', 'invalid-page', 'invalid-home'])(
  'releases uncommitted captures before erasing a %s request', async boundary => {
    const f = pipelineFixture(boundary === 'changed-evidence' ? 'stage:d0' : undefined);
    if (boundary.startsWith('invalid-')) f.setOutput((point, output) => point === boundary.slice(8)
      ? (point === 'page' ? { body: '# Heading only' } : {}) : output);
    else if (boundary !== 'changed-evidence') {
      const reconcile = f.engine.wikiReconcile.bind(f.engine);
      f.engine.wikiReconcile = async request => {
        if ((boundary === 'commit' || boundary === 'recovery') && request.dry_run) return reconcile(request);
        if (boundary === 'recovery') throw new Error('lost submission');
        throw new EngineError('STALE_NODE', 'Changed', { reason: 'PROVENANCE_OBSERVATION_CHANGED' });
      };
    }
    await expect(f.run()).rejects.toThrow();
    if (boundary === 'changed-evidence') {
      const evidence = f.engine.projectEvidence.bind(f.engine);
      f.engine.projectEvidence = async (...args) => ({ ...await evidence(...args), evidence_hash: 'changed' });
    }
    if (boundary === 'recovery') f.engine.wikiReconcile = async () => { throw new EngineError('STALE_NODE', 'Changed', { reason: 'PROVENANCE_OBSERVATION_CHANGED' }); };
    if (boundary === 'recovery' || boundary === 'changed-evidence') expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
    expect(f.attempts.size).toBe(boundary === 'invalid-page' || boundary === 'changed-evidence' ? 1 : 2);
    expect([...f.attempts.values()].map(a => a.state)).toEqual(Array(f.attempts.size).fill('abandoned'));
    expect(store.read()).toMatchObject({ phase: 'failed' });
    expect(store.read()).not.toHaveProperty('captures');
    const count = f.calls.length;
    expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
    expect(f.calls).toHaveLength(count);
  });

it.each(['inspect', 'transition'])('terminal redaction survives %s cleanup failure and releases other captures', async boundary => {
  const f = pipelineFixture('stage:d1');
  await expect(f.run()).rejects.toThrow();
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => ({ ...await evidence(...args), evidence_hash: 'changed' });
  // Inspection during recovery succeeds; fail only the cleanup read.
  let firstReads = 0;
  const inspect = f.engine.inspectProvenance.bind(f.engine);
  f.engine.inspectProvenance = async req => {
    if (req.select === 'attempt' && req.attempt_key === [...f.attempts.keys()][0] && ++firstReads > 1 && boundary === 'inspect') throw new Error('offline');
    return inspect(req);
  };
  const transition = f.engine.transitionProvenance.bind(f.engine);
  f.engine.transitionProvenance = async req => {
    if (boundary === 'transition' && req.derivation_id === 'd0') throw new Error('offline');
    return transition(req);
  };
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect([...f.attempts.values()].map(a => a.state)).toEqual(['result_staged', 'abandoned']);
  expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_PROJECT_CHANGED' });
  expect(store.read()).not.toHaveProperty('snapshot');
});

it('does not release or erase a replacement generation while cleanup inspection is delayed', async () => {
  const f = pipelineFixture('stage:d0');
  await expect(f.run()).rejects.toThrow();
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => ({ ...await evidence(...args), evidence_hash: 'changed' });
  const inspect = f.engine.inspectProvenance.bind(f.engine);
  let reads = 0;
  let replacement: ActivePageRequestExecution | undefined;
  f.engine.inspectProvenance = async req => {
    const response = await inspect(req);
    if (++reads === 2) {
      const prior = store.read() as ActivePageRequestExecution;
      store.clear(prior.generation);
      replacement = { ...active(), generation: randomUUID() };
      store.write(null, replacement);
    }
    return response;
  };
  await expect(recoverRequestedPage(f.engine, store)).rejects.toThrow('REQUEST_EXECUTION_CONFLICT');
  expect(store.read()).toEqual(replacement);
  expect([...f.attempts.values()].map(a => a.state)).toEqual(['result_staged']);
});

it.each(['committed', 'identity-mismatch', 'commit-race'])(
  'cleanup preserves a capture after authoritative %s', async condition => {
    const f = pipelineFixture('stage:d0');
    await expect(f.run()).rejects.toThrow();
    const evidence = f.engine.projectEvidence.bind(f.engine);
    f.engine.projectEvidence = async (...args) => ({ ...await evidence(...args), evidence_hash: 'changed' });
    const inspect = f.engine.inspectProvenance.bind(f.engine);
    let reads = 0;
    f.engine.inspectProvenance = async req => {
      const response = await inspect(req);
      if (++reads === 2 && response.select === 'attempt' && response.attempt) {
        if (condition === 'identity-mismatch') return { ...response, attempt: { ...response.attempt, derivation_id: 'unrelated' } };
        if (condition === 'committed') response.attempt.state = 'committed';
      }
      return response;
    };
    const transition = f.engine.transitionProvenance.bind(f.engine);
    f.engine.transitionProvenance = async req => {
      if (condition === 'commit-race') [...f.attempts.values()][0]!.state = 'committed';
      return transition(req);
    };
    expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
    expect([...f.attempts.values()].map(a => a.state)).toEqual([condition === 'identity-mismatch' ? 'result_staged' : 'committed']);
    expect(store.read()).not.toHaveProperty('snapshot');
  });

it('leaves possibly submitted captures intact when abandonment erases an unavailable request', async () => {
  const f = pipelineFixture();
  const reconcile = f.engine.wikiReconcile.bind(f.engine);
  f.engine.wikiReconcile = async req => {
    if (!req.dry_run) throw new Error('lost submission response');
    return reconcile(req);
  };
  await expect(f.run()).rejects.toThrow();
  expect(store.read()).toHaveProperty('reconcile');
  [...f.attempts.values()][0]!.availability = 'purged';
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect([...f.attempts.values()].map(a => a.state)).toEqual(['result_staged', 'result_staged']);
  expect(store.read()).not.toHaveProperty('snapshot');
});

it('releases a prepared reservation by attempt identity when its prepare response was lost', async () => {
  const f = pipelineFixture();
  const prepare = f.engine.prepareProvenance.bind(f.engine);
  f.engine.prepareProvenance = async req => {
    const response = await prepare(req);
    if (!req.dry_run) throw new Error('lost prepare response');
    return response;
  };
  await expect(f.run()).rejects.toThrow();
  expect((store.read() as ActivePageRequestExecution).captures[0]?.receipt).toBeUndefined();
  expect([...f.attempts.values()].map(a => a.state)).toEqual(['prepared']);
  const evidence = f.engine.projectEvidence.bind(f.engine);
  f.engine.projectEvidence = async (...args) => ({ ...await evidence(...args), evidence_hash: 'changed' });
  expect(await recoverRequestedPage(f.engine, store)).toBe('blocked');
  expect([...f.attempts.values()].map(a => a.state)).toEqual(['abandoned']);
  expect(store.read()).not.toHaveProperty('captures');
  expect(f.calls).toHaveLength(2);
});


it('freezes non-secret client configuration when a tracked request starts', async () => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  expect((await f.request()).outcome).toBe('error');
  expect((store.read() as ActivePageRequestExecution).snapshot.config).toHaveProperty('llmConfiguration', {
    provider: 'openrouter', reasoningEffort: null,
  });
});


it.each([
  { change: 'reasoning', initialReasoning: 'low', route: 'openrouter' as const, uncertain: false },
  { change: 'unset reasoning', initialReasoning: undefined, route: 'openrouter' as const, uncertain: false },
  { change: 'reassigned route', initialReasoning: 'low', route: 'fireworks' as const, uncertain: false },
  { change: 'removed route', initialReasoning: 'low', route: undefined, uncertain: false },
  { change: 'uncertain call with removed route', initialReasoning: 'low', route: undefined, uncertain: true },
])('keeps frozen dispatch across SQLite restart and $change', async ({ initialReasoning, route, uncertain }) => {
  const f = pipelineFixture(uncertain ? 'page' : 'stage:d0');
  store.clear(store.read()!.generation);
  sdkCreate.mockReset().mockImplementation(f.providerCreate); sdkOptions.mockClear();
  const model = f.config.model;
  const ledger: Record<string, unknown>[] = [];
  const keys = { keys: { openrouter: 'original-key', fireworks: 'fireworks-key' }, baseURLs: { fireworks: 'https://fireworks.invalid' } };
  const reporter = new UsageReporter({ recordUsage: async args => { ledger.push(args); } } as Engine,
    { provider: 'openrouter', experiment: null, variant: null });
  const original = reporter.wrap(createDispatchingLlmClient(keys, providerForModel({ [model]: 'openrouter' }), { reasoningEffort: initialReasoning }));
  const run = (llm: import('../src/llm/types.js').LlmClient, config: Config) => curateRequestedPage(f.engine, llm, config,
    { id: 'project-1', title: 'Project', file_path: 'Project.md', status: 'active' }, { id: 1, title: 'Decisions' }, false, 'vault', { store });
  expect((await run(original, f.config)).outcome).toBe('error');
  expect(f.calls).toHaveLength(3);
  const saved = store.read() as ActivePageRequestExecution;
  expect(saved.snapshot.config.llmConfiguration).toEqual({ provider: 'openrouter', reasoningEffort: initialReasoning ?? null });
  expect(JSON.stringify(saved)).not.toMatch(/original-key|fireworks-key|fireworks.invalid/);
  const dir = mkdtempSync(join(tmpdir(), 'frozen-provider-'));
  try {
    const path = join(dir, 'curator.db');
    await db.backup(path); db.close(); db = new Database(path);
    const routes = route ? { [model]: route } : {};
    const resolver = providerForModel(routes);
    const reloaded = reporter.wrap(createDispatchingLlmClient({ ...keys, keys: { ...keys.keys, openrouter: 'rotated-key' } }, resolver,
      { reasoningEffort: 'high' }), resolver);
    const outcome = await run(reloaded, { ...f.config, modelProviders: routes, reasoningEffort: 'high' });
    if (uncertain) {
      expect(outcome.outcome).toBe('error');
      expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_CALL_UNCERTAIN' });
      expect(f.calls).toHaveLength(3);
      expect(ledger).toHaveLength(2);
    } else {
      expect(outcome.outcome, outcome.detail).toBe('written');
      expect(f.calls).toHaveLength(4);
      expect(f.calls.at(-1)).toMatchObject({ model });
      if (initialReasoning) expect(f.calls.at(-1)).toHaveProperty('reasoning_effort', initialReasoning);
      else expect(f.calls.at(-1)).not.toHaveProperty('reasoning_effort');
      expect(sdkOptions).toHaveBeenLastCalledWith({ apiKey: 'rotated-key', baseURL: 'https://openrouter.ai/api/v1', fetch: expect.any(Function) });
      expect(ledger).toHaveLength(4);
      expect(ledger.every(row => row.provider === 'openrouter')).toBe(true);
      expect(outcome.usage).toEqual({ input: 40, output: 8, cacheWrite: 0, cacheRead: 0 });
      expect(outcome.invocationUsage).toEqual({ input: 10, output: 2, cacheWrite: 0, cacheRead: 0 });
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});


it.each([false, true])('legacy checkpoints preserve existing replay validation (settings changed: %s)', async changed => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  expect((await f.request()).outcome).toBe('error');
  const state = store.read() as ActivePageRequestExecution;
  delete state.snapshot.config.llmConfiguration;
  delete state.snapshot.config.wikiOutputPolicy;
  store.write(state.generation, state);
  const current = changed
    ? new OpenAiCompatLlmClient({ chat: { completions: { create: f.providerCreate } } } as unknown as OpenAI,
      { provider: 'openrouter', fireworksExtensions: false, reasoningEffort: 'high' })
    : f.adapter;
  const outcome = await curateRequestedPage(f.engine, current, f.config,
    { id: 'project-1', title: 'Project', file_path: 'Project.md', status: 'active' }, { id: 1, title: 'Decisions' }, false, 'vault', { store });
  expect(outcome.outcome).toBe(changed ? 'error' : 'written');
  expect(f.calls).toHaveLength(changed ? 3 : 4);
  expect((store.read() as ActivePageRequestExecution).snapshot.config.llmConfiguration).toBeUndefined();
});

it('freezes stage caps and reasoning through a resumed page-to-home execution', async () => {
  const f = pipelineFixture('stage:d0');
  store.clear(store.read()!.generation);
  const trial = { wikiPlanningMaxTokens: 24000, wikiPageMaxTokens: 32000, wikiHomeMaxTokens: 16000,
    wikiPlanningReasoningEffort: 'medium' as const, wikiPageReasoningEffort: 'low' as const, wikiHomeReasoningEffort: 'low' as const };
  expect((await f.request(trial)).outcome).toBe('error');
  expect((store.read() as ActivePageRequestExecution).snapshot.config).toHaveProperty('wikiOutputPolicy.page.maxTokens', 32000);
  expect(f.calls.map(p => (p as { max_tokens: number }).max_tokens)).toEqual([24000, 24000, 32000]);
  const result = await f.request({ ...trial, wikiHomeMaxTokens: 100000, wikiHomeReasoningEffort: 'high' });
  expect(result.outcome, result.detail).toBe('written');
  expect(f.calls).toHaveLength(4);
  expect(f.calls.at(-1)).toMatchObject({ max_tokens: 16000, reasoning_effort: 'low' });
});

it('legacy provider-frozen checkpoints ignore new stage overrides', async () => {
  const f = pipelineFixture('stage:d0'); store.clear(store.read()!.generation);
  expect((await f.request()).outcome).toBe('error');
  const saved = store.read() as ActivePageRequestExecution;
  delete saved.snapshot.config.wikiOutputPolicy; store.write(saved.generation, saved);
  const resumed = await f.request({wikiPlanningMaxTokens:24000,wikiPageMaxTokens:32000,wikiHomeMaxTokens:16000,
    wikiPlanningReasoningEffort:'medium',wikiPageReasoningEffort:'low',wikiHomeReasoningEffort:'low'});
  expect(resumed.outcome, resumed.detail).toBe('written');
  expect(f.calls).toHaveLength(4);
  expect(f.calls.at(-1)).toMatchObject({max_tokens:saved.snapshot.config.homeMaxTokens});
  expect(f.calls.at(-1)).not.toHaveProperty('reasoning_effort');
});

describe('requested pages get unsettled conflicts, dated memories and the rule check (#631)', () => {
  const observation = (id: number) => ({ source: { kind: 'memory', namespace: 'vault', native_id: String(id) },
    authority: 'engine', observed_at: new Date().toISOString(), native_version: null, content_hash: `memory-${id}`,
    hash_semantics: 'engine_content_hash', observation_projection: 'memory-content-v1',
    observation_digest: `sha256:json-v1:${String(id).repeat(64).slice(0, 64)}`, label: null, path: null });
  const memory = (id: number, content: string, at: string) => ({ id, source: 'curator', scope: 'vault', node_id: null, content,
    category: 'fact', created_at: at, updated_at: at, valid_at: at, evidence_kind: 'note', expired_at: null, provenance_observation: observation(id) });
  const older = memory(7, 'Headcount is 40.', '2026-10-01T12:00:00Z');
  const newer = memory(8, 'Headcount is 55.', '2026-10-20T12:00:00Z');
  const rule = memory(9, 'Never name the pilot customer.', '2026-09-01T12:00:00Z');
  const label = (m: { valid_at: string }) => `${localDate(Date.parse(m.valid_at))}, from a note`;
  // The merged page already carries memory 9 as a rule on what to say.
  const ruleLine = '- Never name the pilot customer. <!-- memory:9 -->';
  const ruledBody = `## Legacy\n\nLegacy facts.\n\n## Rules on what to say\n\n${ruleLine}`;
  const pageCall = (f: ReturnType<typeof pipelineFixture>, index = 0) => f.calls.filter((call: any) => call.response_format === undefined
    || !['emit_topology_plan', 'emit_scope_adjudication', 'emit_wiki_sections', 'emit_rule_check'].includes(call.response_format.json_schema?.name))[index] as any;
  const points = (f: ReturnType<typeof pipelineFixture>) => f.events.filter(event => !event.includes(':'));
  const published = (f: ReturnType<typeof pipelineFixture>) => JSON.stringify(f.writes.find(write => !write.dry_run)?.pages ?? null);
  const broke = (words: string) => ({ broken: [{ rule: 1, words }] });
  // A project's people: one with a note, a company, and one named without a note (#634).
  const team = { people: [{ id: 'person-1', title: 'Dana Reyes', companies: ['Acme'], direct: true, meeting_count: 2, last_seen: null }],
    companies: [{ id: 'company-1', title: 'Acme' }], unlinked: [{ name: 'Lee Park', direct: false, meeting_count: 1 }] };
  const knownLine = '- Dana Reyes (Acme; project contact; 2 project meetings)';
  const unlinkedLine = '- Lee Park (1 project meeting)';

  /** A captured request merging the ruled page. `selected` are the memories the request picks;
   *  a lookup by id finds memory 9 unless it fails. */
  function ruledFixture(opts: { crash?: string; selected?: unknown[]; lookup?: 'found' | 'fails' | 'gone'; contacts?: unknown } = {}) {
    const f = pipelineFixture(opts.crash, true);
    store.clear(store.read()!.generation);
    if (opts.contacts) {
      // The project's people, with the observations a captured request reads for each one.
      const evidence = f.engine.projectEvidence.bind(f.engine);
      const nodeObservation = (id: string) => ({ source: { kind: 'node', namespace: 'vault', native_id: id }, authority: 'engine',
        observed_at: new Date().toISOString(), native_version: 1, content_hash: `hash-${id}`, hash_semantics: 'engine_content_hash',
        observation_projection: 'node-token-v2', observation_digest: `sha256:json-v1:${'c'.repeat(64)}`, label: id, path: `${id}.md` });
      f.engine.projectEvidence = (async (...args: Parameters<typeof evidence>) => {
        const current = await evidence(...args) as any;
        const contacts = state.contacts as any;
        const ids = [...(contacts?.people ?? []), ...(contacts?.companies ?? [])].map((c: { id: string }) => c.id);
        return { ...current, contacts: contacts ?? current.contacts, provenance_observations: { nodes: {
          ...current.provenance_observations.nodes, ...Object.fromEntries(ids.map(id => [id, nodeObservation(id)])) } } };
      }) as never;
    }
    const getNode = f.engine.getNode.bind(f.engine);
    f.engine.getNode = (async (id: string, options?: never) => ({ ...await getNode(id, options), body: ruledBody })) as never;
    const lookups: number[][] = [];
    const state = { lookup: opts.lookup ?? 'found', selected: opts.selected ?? [older], contacts: opts.contacts };
    Object.assign(f.engine, { listMemoriesWithTotal: async (filters: { ids?: number[]; scope?: string; node_id?: string }) => {
      if (filters.ids) {
        lookups.push([...filters.ids]);
        if (state.lookup === 'fails') throw new Error('memories offline');
        const found = state.lookup === 'gone' ? [] : [rule].filter(m => filters.ids!.includes(m.id));
        return { memories: found, total: found.length };
      }
      return filters.scope === 'node' && filters.node_id === 'project-1' ? { memories: state.selected, total: state.selected.length } : { memories: [], total: 0 };
    } });
    f.setOutput((point, output) => {
      if (point !== 'page') return output;
      const drafts = points(f).filter(p => p === 'page').length;
      return { ...output, body: drafts > 1 ? '## Decisions\n\nDraft two keeps the customer unnamed.' : '## Decisions\n\nDraft one names Acme Pilot.' };
    });
    return { ...f, lookups, state };
  }

  it('shows the pairs nothing has settled to the page, planner and home, and the same pairs after recovery', async () => {
    const f = ruledFixture({ selected: [older, newer] });
    // The page's capture is refused once before dispatch, so the request resumes and its page call is made then.
    const prepare = f.engine.prepareProvenance.bind(f.engine);
    let refuse = true;
    f.engine.prepareProvenance = async request => {
      if (refuse && request.flow === 'project-subpage-v1') { refuse = false; throw new Error('setup unavailable'); }
      return prepare(request);
    };
    let pairs: Array<[number, number]> = [[7, 8]];
    const readConflicts = (ids: readonly number[]) => pairs.filter(([a, b]) => ids.includes(a) && ids.includes(b));
    expect((await f.request({}, { readConflicts })).outcome).toBe('error');
    const frozen = store.read() as ActivePageRequestExecution;
    expect(frozen.snapshot.conflicts).toEqual([[7, 8]]);
    const block = `- "Headcount is 40." (${label(older)}) vs "Headcount is 55." (${label(newer)})`;
    expect(frozen.snapshot.evidenceText).toContain('## UNSETTLED CONFLICTS');
    expect(frozen.snapshot.evidenceText).toContain(block);

    // The ledger has moved on; the resumed page still shows the frozen pairs.
    pairs = [];
    const resumed = await f.request({}, { readConflicts });
    expect(resumed.outcome, resumed.detail).toBe('written');
    const evidence = JSON.parse(pageCall(f).messages.at(-1).content).evidence as string;
    expect(evidence).toContain('## UNSETTLED CONFLICTS');
    expect(evidence).toContain(block);
    for (const name of ['emit_topology_plan', 'emit_wiki_sections']) {
      const call = f.calls.find((c: any) => c.response_format?.json_schema?.name === name) as any;
      expect(call.messages.at(-1).content, name).toContain(block.replace(/"/g, '\\"'));
    }
  });

  it('shows the people blocks to the page, planner and home, and the same ones after recovery', async () => {
    const f = ruledFixture({ contacts: team });
    // The page's capture is refused once before dispatch, so the request resumes and its page call is made then.
    const prepare = f.engine.prepareProvenance.bind(f.engine);
    let refuse = true;
    f.engine.prepareProvenance = async request => {
      if (refuse && request.flow === 'project-subpage-v1') { refuse = false; throw new Error('setup unavailable'); }
      return prepare(request);
    };
    expect((await f.request()).outcome).toBe('error');
    const frozen = store.read() as ActivePageRequestExecution;
    // Only what the blocks read is saved.
    expect(frozen.snapshot.contacts).toEqual({ people: [{ id: 'person-1', title: 'Dana Reyes', companies: ['Acme'], direct: true, meeting_count: 2 }],
      companies: [{ id: 'company-1', title: 'Acme' }], unlinked: [{ name: 'Lee Park', direct: false, meeting_count: 1 }] });
    expect(frozen.snapshot.evidenceText).toContain(`## PEOPLE AND COMPANIES ON THIS PROJECT`);
    expect(frozen.snapshot.evidenceText).toContain(`${knownLine}\n- Acme (company)`);
    expect(frozen.snapshot.evidenceText).toContain(`## PEOPLE NAMED WITHOUT A NOTE`);
    expect(frozen.snapshot.evidenceText).toContain(unlinkedLine);
    // The home's evidence attributes each person and company as a full build's does.
    const items = frozen.snapshot.homeAttribution!.items;
    expect(items.filter(item => item.selection === 'people-projection:v1').map(item => item.observation?.source.native_id))
      .toEqual(['person-1', 'company-1']);
    expect(items.map(item => item.selection)).toEqual(expect.arrayContaining(['opaque-people-projection:v1', 'unlinked-people-projection:v1']));

    // The project's people changed since; the resumed page still shows the saved ones.
    f.state.contacts = { people: [], companies: [], unlinked: [] };
    const resumed = await f.request();
    expect(resumed.outcome, resumed.detail).toBe('written');
    const evidence = JSON.parse(pageCall(f).messages.at(-1).content).evidence as string;
    expect(evidence).toContain(knownLine);
    expect(evidence).toContain(unlinkedLine);
    for (const name of ['emit_topology_plan', 'emit_wiki_sections']) {
      const call = f.calls.find((c: any) => c.response_format?.json_schema?.name === name) as any;
      expect(call.messages.at(-1).content, name).toContain(knownLine);
    }
  });

  it('saves only what the people blocks read, which they render exactly as the full contacts', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `person-${index}`, title: `Person ${index}`, companies: index % 2 ? ['Acme'] : [],
      direct: index % 3 === 0, meeting_count: index % 4, last_seen: index }));
    // An Engine before #634 sent neither `direct` nor `meeting_count`, nor any people without a note.
    const older = { people: [{ id: 'person-x', title: 'Pat Lin', companies: ['Acme'], last_seen: null }], companies: [{ id: 'company-1', title: 'Acme' }] };
    for (const contacts of [{ ...team, people: many }, older]) {
      const saved = peopleBlockContacts(contacts as never)!;
      expect(peopleBlocks(saved)).toEqual(peopleBlocks(contacts as never));
      expect(saved.people.length).toBeLessThanOrEqual(25);
    }
  });

  it('resumes a request saved before people blocks with its saved page call unchanged', async () => {
    const f = ruledFixture({ crash: 'stage:d0', contacts: team, selected: [older, rule] });
    // An older binary saved no people, so its page call had no people blocks.
    const plain = store;
    store = { ...plain, write: (generation, next) => {
      if ('snapshot' in next) { const { contacts: _older, ...snapshot } = next.snapshot; next = { ...next, snapshot }; }
      plain.write(generation, next);
    } };
    expect((await f.request()).outcome).toBe('error');
    expect((store.read() as ActivePageRequestExecution).snapshot).not.toHaveProperty('contacts');
    store = plain;
    const resumed = await f.request();
    expect(resumed.outcome, resumed.detail).toBe('written');
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'rules', 'home']);
    expect(JSON.parse(pageCall(f).messages.at(-1).content).evidence).not.toContain('PEOPLE AND COMPANIES');
  });

  it('dates and sources the page\'s memory lines, newest first', async () => {
    const f = ruledFixture({ selected: [older, newer] });
    expect((await f.request()).outcome).toBe('written');
    const evidence = JSON.parse(pageCall(f).messages.at(-1).content).evidence as string;
    const first = evidence.indexOf(`- [fact] ${label(newer)}: Headcount is 55.`);
    const second = evidence.indexOf(`- [fact] ${label(older)}: Headcount is 40.`);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect((store.read() as ActivePageRequestExecution).snapshot.memories?.map(m => m.source_label)).toEqual([label(older), label(newer)]);
  });

  it('looks up a rule whose memory the request didn\'t select, keeps it, checks the page, and reuses the lookup on recovery', async () => {
    const f = ruledFixture({ crash: 'stage:d0' });
    expect((await f.request()).outcome).toBe('error');
    expect(f.lookups).toEqual([[9]]);
    expect((store.read() as ActivePageRequestExecution).snapshot.ruleLookups)
      .toEqual([{ ids: [9], memories: [expect.objectContaining({ id: 9, content: 'Never name the pilot customer.' })] }]);
    const evidence = JSON.parse(pageCall(f).messages.at(-1).content).evidence as string;
    expect(evidence).toContain('## RULES FOR THIS PAGE');
    expect(evidence).toContain('- Never name the pilot customer.');
    // Memory 9 is gone now: a live lookup would drop the rule, but the saved one keeps the calls matching.
    f.state.lookup = 'gone';
    const resumed = await f.request();
    expect(resumed.outcome, resumed.detail).toBe('written');
    expect(f.lookups).toEqual([[9]]);
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'rules', 'home']);
    expect(published(f)).toContain(ruleLine);
  });

  it('carries the rules section over unchanged when the lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = ruledFixture({ lookup: 'fails' });
    const outcome = await f.request();
    expect(outcome.outcome, outcome.detail).toBe('written');
    expect((store.read() as ActivePageRequestExecution).snapshot.ruleLookups).toEqual([{ ids: [9], memories: null }]);
    expect(JSON.parse(pageCall(f).messages.at(-1).content).evidence).not.toContain('RULES FOR THIS PAGE');
    // No rules reached the writer, so there is nothing to check; the section is written back as it was.
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'home']);
    expect(published(f)).toContain(`## Rules on what to say\\n\\n${ruleLine}`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memories offline'));
  });

  it('sends a draft that breaks a rule back once, with the rule and its words, under its own call keys and capture', async () => {
    const f = ruledFixture({ selected: [older, rule] });
    f.rulings.push(broke('Acme Pilot'), { broken: [] });
    const outcome = await f.request();
    expect(outcome.outcome, outcome.detail).toBe('written');
    expect(f.lookups).toEqual([]);
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'rules', 'page', 'rules', 'home']);
    const retry = pageCall(f, 1).messages[0].content as string;
    expect(retry).toContain('broke these rules');
    expect(retry).toContain('Rule: Never name the pilot customer. Your words: "Acme Pilot"');
    const state = store.read() as ActivePageRequestExecution;
    expect(state.calls.map(call => call.key).filter(key => key.startsWith('page:')))
      .toEqual(['page:page', 'page:page:rules', 'page:page:draft-2', 'page:page:draft-2:rules']);
    const pages = state.captures.filter(c => c.flow === 'project-subpage-v1');
    expect(pages.map(c => c.draft)).toEqual([undefined, 2]);
    expect(pages[0]!.attemptKey).not.toBe(pages[1]!.attemptKey);
    // The first draft's attempt is failed before the second is prepared, and is never staged or published.
    expect(f.events.indexOf('fail:d0')).toBeLessThan(f.events.lastIndexOf('prepare:project-subpage-v1'));
    expect([...f.stages.keys()]).toEqual(['d1', 'd2']);
    expect(state.result?.provenance_receipts?.map(r => r.derivation_id).sort()).toEqual(['d1', 'd2']);
    expect(published(f)).toContain('Draft two keeps the customer unnamed.');
    expect(published(f)).not.toContain('Acme Pilot');
    expect(published(f)).toContain(ruleLine);
    expect(outcome.usage).toEqual({ input: 70, output: 14, cacheWrite: 0, cacheRead: 0 });
  });

  it('fails the request with a plain reason, writing nothing, when both drafts break a rule', async () => {
    const f = coreFixture(undefined, true);
    const getNode = f.engine.getNode.bind(f.engine);
    f.engine.getNode = (async (id: string, options?: never) => ({ ...await getNode(id, options), body: ruledBody })) as never;
    Object.assign(f.engine, { listMemoriesWithTotal: async (filters: { scope?: string; node_id?: string }) =>
      filters.scope === 'node' && filters.node_id === 'project-1' ? { memories: [rule], total: 1 } : { memories: [], total: 0 } });
    f.rulings.push(broke('Acme Pilot'), broke('the pilot customer, Acme'));
    const response = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
    const reason = /^The page "Project — Decisions" wasn't published and the wiki is unchanged: both drafts broke a rule on what to say \(memory 9 \("the pilot customer, Acme"\)\)\.$/;
    expect(response).toMatchObject({ ok: false, status: 'failed', error: { message: expect.stringMatching(reason) } });
    expect(getPageRequest(db, f.latestId())).toMatchObject({ status: 'failed', error: expect.stringMatching(reason) });
    expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_RESULT_INVALID' });
    expect(f.events.filter(event => !event.includes(':'))).toEqual(['planner', 'adjudicator', 'page', 'rules', 'page', 'rules']);
    expect(f.writes).toEqual([]);
    expect(f.stages.size).toBe(0);
    expect([...f.attempts.values()].map(a => a.state)).toEqual(['failed', 'abandoned']);
  });

  it('reads the pairs from the reconcile ledger for a page requested through the tool', async () => {
    const f = coreFixture(undefined, true);
    Object.assign(f.engine, { listMemoriesWithTotal: async (filters: { scope?: string; node_id?: string }) =>
      filters.scope === 'node' && filters.node_id === 'project-1' ? { memories: [older, newer], total: 2 } : { memories: [], total: 0 } });
    upsertVerdict(db, { idA: 8, idB: 7, updatedAtA: newer.updated_at, updatedAtB: older.updated_at, verdict: 'kept_both',
      adjudicatedAt: '2026-11-01T00:00:00Z' });
    const response = await requestWikiPage(f.deps, { project: 'Project', title: 'Decisions', mode: 'immediate' });
    expect(response).toMatchObject({ ok: true, status: 'fulfilled' });
    const evidence = JSON.parse(pageCall(f).messages.at(-1).content).evidence as string;
    expect(evidence).toContain(`- "Headcount is 40." (${label(older)}) vs "Headcount is 55." (${label(newer)})`);
  });

  it('lets the page stand when the check gives no ruling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = ruledFixture({ selected: [older, rule] });
    f.rulings.push({ broken: 'none' });
    const outcome = await f.request();
    expect(outcome.outcome, outcome.detail).toBe('written');
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'rules', 'home']);
    expect(published(f)).toContain('Draft one names Acme Pilot.');
    expect(warn).toHaveBeenCalledWith('[curator] rule check gave no ruling; the page stands');
  });

  it.each(['record-write', 'before-prepare', 'commit-response'])(
    'recovers a crash at %s of a rule retry without sending a saved call again or publishing the first draft', async boundary => {
      const f = ruledFixture({ selected: [older, rule], ...(boundary === 'commit-response' ? { crash: 'commit-response' } : {}) });
      f.rulings.push(broke('Acme Pilot'), { broken: [] });
      if (boundary === 'record-write') {
        db.exec(`CREATE TRIGGER crash_retry BEFORE UPDATE OF execution_json ON page_requests
          WHEN json_extract(NEW.execution_json, '$.captures[1].draft') = 2 BEGIN SELECT RAISE(ABORT, 'crash'); END;`);
      }
      if (boundary === 'before-prepare') {
        const prepare = f.engine.prepareProvenance.bind(f.engine);
        let pages = 0;
        f.engine.prepareProvenance = async request => {
          if (request.flow === 'project-subpage-v1' && ++pages === 2) throw new Error('injected crash');
          return prepare(request);
        };
      }
      expect((await f.request()).outcome).toBe('error');
      if (boundary === 'record-write') {
        db.exec('DROP TRIGGER crash_retry');
        expect((store.read() as ActivePageRequestExecution).captures.map(c => c.draft)).toEqual([undefined]);
      }
      if (boundary === 'before-prepare') {
        expect((store.read() as ActivePageRequestExecution).captures.map(c => c.draft)).toEqual([undefined, 2]);
        expect(f.attempts.get((store.read() as ActivePageRequestExecution).captures[0]!.attemptKey)?.state).toBe('failed');
      }
      const resumed = await f.request();
      expect(resumed, resumed.detail).toMatchObject({ outcome: 'written', nodeId: 'page', resolvedTo: { action: 'merged' } });
      // Every call ran once: the saved draft and check were reused, and the second draft followed them.
      expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'rules', 'page', 'rules', 'home']);
      expect(f.stages.has('d0')).toBe(false);
      expect(f.attempts.size).toBe(3);
      expect(published(f)).toContain('Draft two keeps the customer unnamed.');
      expect(published(f)).not.toContain('Acme Pilot');
    });

  it('never sends a second draft again when its result was lost', async () => {
    const f = ruledFixture({ selected: [older, rule], crash: 'page#2' });
    f.rulings.push(broke('Acme Pilot'));
    expect((await f.request()).outcome).toBe('error');
    expect(await f.request()).toMatchObject({ outcome: 'error', detail: 'REQUEST_RECOVERY_BLOCKED' });
    expect(store.read()).toMatchObject({ phase: 'failed', errorCode: 'REQUEST_CALL_UNCERTAIN' });
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'rules', 'page']);
    expect(f.writes).toEqual([]);
  });

  it('resumes a request saved before rule lookups with its saved draft unchanged', async () => {
    const f = ruledFixture({ crash: 'stage:d0' });
    // An older binary saved no rule lookups: the rule outside the request's memories was dropped then.
    const plain = store;
    store = { ...plain, write: (generation, next) => {
      if ('snapshot' in next) { const { ruleLookups: _older, ...snapshot } = next.snapshot; next = { ...next, snapshot }; }
      plain.write(generation, next);
    } };
    expect((await f.request()).outcome).toBe('error');
    expect((store.read() as ActivePageRequestExecution).snapshot).not.toHaveProperty('ruleLookups');
    store = plain;
    const resumed = await f.request();
    expect(resumed.outcome, resumed.detail).toBe('written');
    expect(f.lookups).toEqual([]);
    expect(points(f)).toEqual(['planner', 'adjudicator', 'page', 'home']);
    expect(published(f)).not.toContain('memory:9');
  });

  it('gives an uncaptured project page the conflicts, dated memories, people blocks, the rule lookup and the check', async () => {
    const f = ruledFixture({ selected: [older, newer], contacts: team });
    const requests: import('../src/llm/types.js').StructuredCallRequest[] = [];
    const llm = { configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }), withConfiguration() { return this; },
      structuredCall: async (request: import('../src/llm/types.js').StructuredCallRequest) => {
        requests.push(request);
        const scope = { v: 1, subject: 'Project', facet: 'Decisions' };
        return { usage: result.usage, output: request.toolName === 'emit_topology_plan' ? { reviewed_page_ids: ['source'], actions: [
          { op: 'create', plan_key: 'page', title: 'Project — Decisions', kind: 'workstream', scope, synthesis_brief: 'Write decisions.' },
          { op: 'merge', target: { plan_key: 'page' }, sources: ['source'], scope, reason: 'Canonical target', synthesis_brief: 'Consolidate.' }] }
          : request.toolName === 'emit_scope_adjudication' ? { verdicts: JSON.parse(request.user).comparisons.map((p: any) => ({
            pair_id: p.pair_id, candidate_plan_key: p.candidate_plan_key, compared_to: p.compared_to, relation: 'distinct', confidence: 0.95,
            evidence_ids: [], reason: 'Distinct', narrower: 'none' })) }
          : request.toolName === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
          : request.toolName === 'emit_rule_check' ? { broken: [] } : { body: 'Page body' } };
      } };
    const outcome = await curateRequestedPage(f.engine, llm, { ...f.config, projectHomeProvenanceEnabled: false },
      { id: 'project-1', title: 'Project', file_path: '', status: null }, { title: 'Decisions' }, false, 'vault',
      { kind: 'project', readConflicts: () => [[7, 8]] });
    expect(outcome.outcome, outcome.detail).toBe('written');
    expect(requests.map(request => request.toolName)).toContain('emit_rule_check');
    expect(f.lookups).toEqual([[9]]);
    const page = JSON.parse(requests.find(request => request.toolName === 'emit_scoped_page')!.user).evidence as string;
    expect(page).toContain('## UNSETTLED CONFLICTS');
    expect(page).toContain(`- [fact] ${label(newer)}: Headcount is 55.`);
    expect(page).toContain('## RULES FOR THIS PAGE');
    expect(page).toContain(knownLine);
    expect(page).toContain(unlinkedLine);
    expect(requests.find(request => request.toolName === 'emit_wiki_sections')!.user).toContain(knownLine);
    expect(JSON.stringify(f.writes.at(-1)?.pages)).toContain(ruleLine);
  });

  it('dates a topic page\'s memory lines as a topic build does, with no conflicts, people blocks or rule check', async () => {
    // The older memory was drawn from a note the request's search finds, so its line names it.
    const f = ruledFixture({ selected: [{ ...older, evidence_node_id: 'note-1' }, newer], contacts: team });
    f.engine.semanticRelated = (async () => [{ id: 'note-1', title: 'Kickoff call', types: ['note'] }]) as never;
    const tools: string[] = [];
    const users: string[] = [];
    const llm = { configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }), withConfiguration() { return this; },
      structuredCall: async (request: import('../src/llm/types.js').StructuredCallRequest) => {
        tools.push(request.toolName); users.push(request.user);
        return { usage: result.usage, output: request.toolName === 'emit_topology_plan' ? { reviewed_page_ids: ['source'], actions: [{ op: 'create',
          plan_key: 'page', title: 'Project — Decisions', kind: 'workstream', scope: { v: 1, subject: 'Project', facet: 'Decisions' }, synthesis_brief: 'Write.' }] }
          : request.toolName === 'emit_scope_adjudication' ? { verdicts: JSON.parse(request.user).comparisons.map((p: any) => ({
            pair_id: p.pair_id, candidate_plan_key: p.candidate_plan_key, compared_to: p.compared_to, relation: 'distinct', confidence: 0.95,
            evidence_ids: [], reason: 'Distinct', narrower: 'none' })) }
          : request.toolName === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
          : { body: 'Page body' } };
      } };
    const outcome = await curateRequestedPage(f.engine, llm, f.config, { id: 'project-1', title: 'Project', file_path: '', status: null },
      { title: 'Decisions' }, false, 'vault', { kind: 'topic', readConflicts: () => [[7, 8]] });
    expect(outcome.outcome, outcome.detail).toBe('written');
    expect(tools).not.toContain('emit_rule_check');
    expect(users.join('\n')).not.toContain('UNSETTLED CONFLICTS');
    expect(users.join('\n')).not.toContain('Dana Reyes');
    // Dated and sourced, newest first, under the topic's heading (#634).
    const page = users[tools.indexOf('emit_scoped_page')]!;
    const evidence = JSON.parse(page).evidence as string;
    expect(evidence).toContain('## MEMORIES (durable facts about this topic from earlier notes, conversations and wiki builds; newest first');
    const first = evidence.indexOf(`- [fact] ${label(newer)}: Headcount is 55.`);
    expect(first).toBeGreaterThan(-1);
    expect(evidence.indexOf(`- [fact] ${localDate(Date.parse(older.valid_at))}, from "Kickoff call": Headcount is 40.`)).toBeGreaterThan(first);
    for (const user of users) expect(user).not.toContain('- [fact] Headcount is 55.');
  });
});
