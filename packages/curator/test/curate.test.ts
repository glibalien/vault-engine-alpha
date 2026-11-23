import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { recordRun, requestedPageRunRow } from '../src/db/runs.js';
import { addUsage, estimateCostUsd, ZERO_USAGE } from '../src/pricing.js';
import { StructuredCallFailure } from '../src/llm/types.js';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import type Anthropic from '@anthropic-ai/sdk';
import { curateProject, curateRequestedPage, gatherGapFillCandidates } from '../src/curate.js';
import { BudgetExhaustedError } from '../src/budget.js';
import type { Config } from '../src/config.js';
import type { WikiReconcileInput, WikiReconcileResult } from '../src/engine.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';
import type { ExistingWiki, ProjectEvidence, ProjectRef, TopologyPlan } from '../src/types.js';

const project: ProjectRef = { id: 'p1', title: 'Demo', file_path: 'Projects/Demo.md', status: 'in-progress' };
const usage = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };
const scope = { v: 1 as const, subject: 'Demo', facet: 'architecture' };

const config = {
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'model', homeMaxTokens: 4096, meetingReads: 10, noteReads: 6, bodyCharCap: 4000,
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
  semanticGapFill: false, semanticGapFillLimit: 15, semanticGapFillBodyReads: 0,
  memoryWriteEnabled: false, memoryWriteCap: 3,
} as Config;

function wiki(over: Partial<ExistingWiki> = {}): ExistingWiki {
  return {
    home_id: 'home',
    home: { id: 'home', version: 3, wiki_evidence_hash: 'old', wiki_topology_hash: 'stored' },
    topology_hash: 'current', catalog_valid: true, subpages: [], ...over,
  };
}

function evidence(existingWiki: ExistingWiki): ProjectEvidence {
  return {
    project: { ...project, id: project.id!, status: project.status },
    tasks: { open: [], overdue: [], blocked: [], upcoming: [], backlog: [], done_recent: [] },
    notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    meetings: { recent: [], upcoming: [] }, contacts: { people: [], companies: [] },
    existing_wiki: existingWiki,
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    evidence_hash: 'evidence', generated_at: '2026-08-14T00:00:00.000Z',
  };
}

function reconcileResult(input: WikiReconcileInput): WikiReconcileResult {
  const created = input.pages.flatMap(operation => operation.op !== 'retire' && operation.target.mode === 'new'
    ? [{ node_id: input.dry_run === true ? `plan:${operation.target.plan_key}` : `node:${operation.target.plan_key}`, title: operation.target.title, file_path: `Wikis/${operation.target.title}.md`, version: 1 }]
    : []);
  return {
    operation_id: input.dry_run === true ? null : 'operation', reconcile_key: input.reconcile_key,
    plan_digest: 'digest', reused: false, dry_run: input.dry_run === true,
    created, updated: [], mappings: [],
    home: { node_id: 'home', title: 'Demo Wiki', file_path: 'Wikis/Demo Wiki.md', version: 4, created: false },
    topology_hash: 'post-topology', warnings: [], preview: { total: input.pages.length, items: [], truncated: false },
  };
}

function engineFor(existingWiki: ExistingWiki) {
  const reconcileCalls: WikiReconcileInput[] = [];
  const engine = {
    projectEvidence: vi.fn(async () => evidence(existingWiki)),
    semanticRelated: vi.fn(async () => []),
    getNode: vi.fn(async (id: string) => ({ id, title: id, types: ['note'], fields: {}, body: `body:${id}` })),
    listMemories: vi.fn(async () => []),
    wikiReconcile: vi.fn(async (input: WikiReconcileInput) => {
      if (input.project_id !== project.id) {
        throw new Error(`invalid authoritative project_id: ${String(input.project_id)}`);
      }
      reconcileCalls.push(input);
      return { data: reconcileResult(input), warnings: [] };
    }),
  };
  return { engine: engine as never, reconcileCalls, raw: engine };
}

function llmFor(plan: TopologyPlan, relation: 'same-scope' | 'substantial-overlap' | 'distinct' = 'distinct') {
  const tools: string[] = [];
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; },
    structuredCall: async request => {
      requests.push(request);
      tools.push(request.toolName);
      switch (request.toolName) {
        case 'emit_topology_plan': return { output: plan, usage };
        case 'emit_scope_adjudication': {
          const payload = JSON.parse(request.user) as { comparisons: Array<{ pair_id: string; candidate_plan_key: string; compared_to: { node_id: string } }> };
          return { output: { verdicts: payload.comparisons.map(pair => ({
            pair_id: pair.pair_id, candidate_plan_key: pair.candidate_plan_key,
            compared_to: pair.compared_to, relation, confidence: 0.9,
            evidence_ids: [], reason: relation, narrower: 'none',
          })) }, usage };
        }
        case 'emit_scoped_page': return { output: { body: 'Scoped body', log_note: 'Updated.' }, usage };
        case 'emit_wiki_sections': return { output: { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Threads' }], log_entry: 'Log' }, usage };
        default: throw new TypeError(`unexpected tool ${request.toolName}`);
      }
    },
  };
  return { llm, tools, requests };
}

describe('gatherGapFillCandidates', () => {
  it('does not call the engine when enrichment is disabled', async () => {
    const semanticRelated = vi.fn(async () => []);
    const out = await gatherGapFillCandidates({ semanticRelated } as never, config, project, evidence(wiki()));
    expect(out).toEqual([]);
    expect(semanticRelated).not.toHaveBeenCalled();
  });
});

describe('curateProject reconciliation', () => {
  it('retains paid home usage and makes no writes when home Markdown validation fails', async () => {
    const { engine, raw } = engineFor(wiki());
    const base = llmFor({ reviewed_page_ids: [], actions: [] });
    const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; }, structuredCall: async request => {
      const result = await base.llm.structuredCall(request);
      return request.toolName === 'emit_wiki_sections'
        ? { ...result, output: { ...result.output as Record<string, unknown>, now: 'Name | Role |--- | --- |Alex | Owner |' } }
        : result;
    } };
    const result = await curateProject(engine, llm, config, project, false, true);
    expect(result).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/collapsed Markdown table/),
      usage: { input: 2, output: 2, cacheWrite: 0, cacheRead: 0 } });
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('resolves an inactive title to evidence identity before reconciliation', async () => {
    const inactive = { id: null, title: 'Demo', file_path: '', status: null } as unknown as ProjectRef;
    const { engine, reconcileCalls, raw } = engineFor(wiki());
    const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });

    const result = await curateProject(engine, llm, config, inactive, false, true);

    expect(result.outcome).toBe('written');
    expect(raw.projectEvidence).toHaveBeenNthCalledWith(1, inactive.title, config.meetingReads);
    expect(reconcileCalls[0]).toMatchObject({ project: inactive.title, project_id: project.id });
    expect(reconcileCalls[0]?.project_id).not.toBe(inactive.title);
  });

  it('uses the stable root ID for evidence and sends display title plus ID for reconciliation', async () => {
    const existing = wiki({
      home: {
        id: 'home',
        version: 3,
        wiki_evidence_hash: 'old',
        wiki_topology_hash: 'stored',
        wiki_curated_at: '2026-08-01T00:00:00.000Z',
      },
    });
    const { engine, reconcileCalls, raw } = engineFor(existing);
    const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });

    const result = await curateProject(engine, llm, config, project, false, true);

    expect(result.outcome).toBe('written');
    expect(raw.projectEvidence).toHaveBeenNthCalledWith(1, project.id, config.meetingReads);
    expect(raw.projectEvidence).toHaveBeenNthCalledWith(
      2,
      project.id,
      config.meetingReads,
      '2026-08-01T00:00:00.000Z',
    );
    expect(reconcileCalls[0]).toMatchObject({ project: project.title, project_id: project.id });
  });

  it('plans against Engine resolved root title when the caller title is stale', async () => {
    const staleProject = { ...project, title: 'Demo Before Rename' };
    const { engine } = engineFor(wiki());
    const { llm, requests } = llmFor({ reviewed_page_ids: [], actions: [] });

    const result = await curateProject(engine, llm, config, staleProject, false, true);

    expect(result.outcome).toBe('written');
    const topologyRequest = requests.find(request => request.toolName === 'emit_topology_plan');
    expect(JSON.parse(topologyRequest?.user ?? '')).toMatchObject({ wiki_root_title: project.title });
  });

  it.each([1, 10, 100])('keeps all %i distinct same-kind planner candidates', async count => {
    const existing = wiki({ home_id: null, home: null, topology_hash: 'empty' });
    const { engine, reconcileCalls } = engineFor(existing);
    const actions: TopologyPlan['actions'] = Array.from({ length: count }, (_, index) => ({
      op: 'create', plan_key: `candidate-${index}`, title: `Demo — Candidate ${index}`,
      kind: 'workstream', scope: { v: 1, subject: 'Demo', facet: `candidate ${index}` },
      synthesis_brief: `Distinct candidate ${index}.`,
    }));
    const { llm } = llmFor({ reviewed_page_ids: [], actions });

    const result = await curateProject(engine, llm, config, project, false, true);

    expect(result.outcome).toBe('written');
    expect(reconcileCalls[1]?.pages).toHaveLength(count);
  });

  it('retires every legacy spine page through reconciliation without a delete call', async () => {
    const labels = ['Task Board', 'Meetings', 'Contacts', 'Notes'];
    const pages = labels.map((label, index) => ({
      id: `legacy-${index}`, title: `Demo — ${label}`, file_path: `Wikis/Demo — ${label}.md`, version: 2,
      content_hash: `body-${index}`, wiki_state: 'active' as const, wiki_origin: 'automatic' as const,
      wiki_scope: { v: 1 as const, subject: 'Demo', facet: label }, wiki_pinned: false,
    }));
    const existing = wiki({ subpages: pages });
    const { engine, reconcileCalls } = engineFor(existing);
    const plan: TopologyPlan = {
      reviewed_page_ids: pages.map(page => page.id),
      actions: pages.map(page => ({
        op: 'retire', node_id: page.id, scope: page.wiki_scope, state: 'retired', reason: 'Legacy spine page.',
      })),
    };
    const { llm } = llmFor(plan);

    const result = await curateProject(engine, llm, config, project, false, true);

    expect(result.outcome).toBe('written');
    expect(reconcileCalls[1]?.pages).toEqual(pages.map(page => expect.objectContaining({ op: 'retire', node_id: page.id })));
    expect(reconcileCalls.flatMap(call => call.pages).every(operation => operation.op === 'retire')).toBe(true);
  });

  it('skips equal evidence and topology before LLM calls or mutations', async () => {
    const existing = wiki({
      home: { id: 'home', version: 3, wiki_evidence_hash: 'evidence', wiki_topology_hash: 'current', wiki_curated_at: '2026-08-14T00:00:00.000Z' },
    });
    const { engine, raw } = engineFor(existing);
    const { llm, tools } = llmFor({ reviewed_page_ids: [], actions: [] });

    const result = await curateProject(engine, llm, config, project, false);

    expect(result.outcome).toBe('skipped');
    expect(result.topologyHash).toBe('current');
    expect(result.wikiCuratedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(tools).toEqual([]);
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
    expect(raw.getNode).not.toHaveBeenCalled();
  });

  it('runs when topology changed and commits only through wiki-reconcile', async () => {
    const page = {
      id: 'page', title: 'Demo — Architecture', file_path: 'Wikis/Demo/Architecture.md', version: 2,
      content_hash: 'body', wiki_state: 'active' as const, wiki_origin: 'automatic' as const,
      wiki_scope: scope, wiki_pinned: false,
    };
    const existing = wiki({
      home: { id: 'home', version: 3, wiki_evidence_hash: 'evidence', wiki_topology_hash: 'stored' },
      topology_hash: 'externally-edited', subpages: [page],
    });
    const { engine, reconcileCalls } = engineFor(existing);
    const { llm, tools } = llmFor({ reviewed_page_ids: ['page'], actions: [{ op: 'keep', node_id: 'page', scope }] });

    const result = await curateProject(engine, llm, config, project, false);

    expect(result.outcome).toBe('written');
    expect(tools).toEqual(['emit_topology_plan', 'emit_wiki_sections']);
    expect(reconcileCalls.map(call => call.dry_run)).toEqual([true, false]);
    expect(result.topologyHash).toBe('post-topology');
    expect(result.topology?.[0]?.action).toBe('kept');
    expect(result.themed?.[0]?.action).toBe('skipped');
    expect(result.topologyAudit?.planningAttempts).toEqual([{
      phase: 'validation', attempt: 0,
      plan: { reviewed_page_ids: ['page'], actions: [{ op: 'keep', node_id: 'page', scope }] },
      issues: [],
    }]);
  });

  it('creates a first-home page through one preview and one commit batch', async () => {
    const existing = wiki({ home_id: null, home: null, topology_hash: 'empty' });
    const { engine, reconcileCalls } = engineFor(existing);
    const plan: TopologyPlan = {
      reviewed_page_ids: [],
      actions: [{ op: 'create', plan_key: 'architecture', title: 'Demo — Architecture', kind: 'workstream', scope, synthesis_brief: 'Explain the architecture.' }],
    };
    const { llm, tools } = llmFor(plan);

    const result = await curateProject(engine, llm, config, project, false, true);

    expect(result.outcome).toBe('written');
    expect(tools).toEqual(['emit_topology_plan', 'emit_scope_adjudication', 'emit_scoped_page', 'emit_wiki_sections']);
    expect(reconcileCalls).toHaveLength(2);
    expect(reconcileCalls[1]?.pages).toHaveLength(1);
    expect(result.topology?.some(item => item.action === 'created')).toBe(true);
  });

  it('returns phase-specific planner errors without throwing or mutating', async () => {
    const { engine, raw } = engineFor(wiki());
    const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; }, structuredCall: async () => { throw new Error('provider down'); } };

    const result = await curateProject(engine, llm, config, project, false, true);

    expect(result.outcome).toBe('error');
    expect(result.detail).toContain('planner:');
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('retains reviewed IDs, actions, and issue contexts after validation repairs are exhausted', async () => {
    const synthesizedProseMarker = 'TEST_SYNTHESIZED_PROSE_MARKER';
    const existing = wiki({
      subpages: [{
        id: 'known', title: 'Demo — Known', file_path: 'Wikis/Demo/Known.md', version: 2,
        content_hash: 'TEST_PAGE_BODY_MARKER', wiki_state: 'active', wiki_origin: 'automatic',
        wiki_scope: scope, wiki_pinned: false,
      }],
    });
    const invalidPlan: TopologyPlan = {
      reviewed_page_ids: ['unknown-reviewed'],
      actions: [
        { op: 'keep', node_id: 'unknown-action', scope },
        {
          op: 'create', plan_key: 'candidate', title: 'Candidate', kind: 'workstream', scope,
          synthesis_brief: synthesizedProseMarker,
        },
      ],
    };
    const { engine, raw } = engineFor(existing);
    const { llm, tools } = llmFor(invalidPlan);

    const result = await curateProject(engine, llm, config, project, false, true);

    expect(result.outcome).toBe('error');
    expect(result.topologyAudit).toMatchObject({
      proposedReviewedPageIds: invalidPlan.reviewed_page_ids,
      finalReviewedPageIds: invalidPlan.reviewed_page_ids,
      proposedActions: [
        invalidPlan.actions[0],
        { ...invalidPlan.actions[1], synthesis_brief: '' },
      ],
      finalActions: [
        invalidPlan.actions[0],
        { ...invalidPlan.actions[1], synthesis_brief: '' },
      ],
      planningAttempts: [
        {
          phase: 'validation', attempt: 0,
          plan: {
            reviewed_page_ids: invalidPlan.reviewed_page_ids,
            actions: [
              invalidPlan.actions[0],
              { op: 'create', plan_key: 'candidate', title: 'Candidate', kind: 'workstream', scope },
            ],
          },
          issues: expect.arrayContaining([
            { code: 'UNKNOWN_REVIEWED_PAGE_ID', node_id: 'unknown-reviewed' },
            { code: 'UNKNOWN_NODE_ID', action_index: 0, node_id: 'unknown-action' },
          ]),
        },
        { phase: 'validation', attempt: 1 },
        { phase: 'validation', attempt: 2 },
      ],
    });
    expect(JSON.stringify(result.topologyAudit)).not.toContain(synthesizedProseMarker);
    expect(tools).toEqual(['emit_topology_plan', 'emit_topology_plan', 'emit_topology_plan']);
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });
});

describe('curateRequestedPage reconciliation', () => {
  const catalogPage = (over: Partial<ExistingWiki['subpages'][number]> = {}): ExistingWiki['subpages'][number] => ({
    id: 'existing', title: 'Demo — Existing Architecture', file_path: 'Wikis/Demo/Existing Architecture.md',
    version: 2, content_hash: 'body', wiki_state: 'active', wiki_kind: 'workstream',
    wiki_origin: 'automatic', wiki_scope: scope, wiki_pinned: false, ...over,
  });
  const candidate = (candidateScope = scope): TopologyPlan => ({
    reviewed_page_ids: ['existing'],
    actions: [
      { op: 'keep', node_id: 'existing', scope },
      { op: 'create', plan_key: 'request', title: 'Architecture Deep Dive', kind: 'workstream', scope: candidateScope, synthesis_brief: 'Requested architecture coverage.' },
    ],
  });

  const stages = ['emit_topology_plan', 'emit_scope_adjudication', 'emit_scoped_page', 'emit_wiki_sections'];
  const stageUsage = stages.map((_, index) => ({ input: 10 * (index + 1), output: index + 1, cacheWrite: 2 * (index + 1), cacheRead: 3 * (index + 1) }));
  const pricedConfig = { ...config, model: 'claude-sonnet-4-6' };

  it.each(['log_note', 'now', 'focus', 'open_threads', 'log_entry', 'at_a_glance', 'sources'])(
    'rejects malformed %s before reconciliation and retains all known usage', async field => {
      const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
      const base = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));
      const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; }, structuredCall: async request => {
        const result = await base.llm.structuredCall(request);
        if (request.toolName === (field === 'log_note' ? 'emit_scoped_page' : 'emit_wiki_sections')) {
          const malformed = '- Name | Role |--- | --- |Alex | Owner |';
          return { ...result, output: { ...result.output as Record<string, unknown>,
            [field]: field === 'focus' || field === 'open_threads' ? [{ title: 'Roles', detail: malformed }] : malformed } };
        }
        return result;
      } };
      const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, false);
      const count = field === 'log_note' ? 3 : 4;
      expect(result).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/collapsed Markdown table/),
        usage: { input: count, output: count, cacheWrite: 0, cacheRead: 0 } });
      expect(raw.wikiReconcile).not.toHaveBeenCalled();
    },
  );

  it("shows the project's memories to the planner, the requested page and the home (#313)", async () => {
    const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
    const memory = (id: number, source: string, content: string) => ({ id, source, scope: 'vault', node_id: null, content,
      category: 'fact', created_at: '', updated_at: '' });
    const lists: Array<Record<string, unknown>> = [];
    Object.assign(raw, {
      getNode: vi.fn(async (id: string) => ({ id, title: id, types: ['note'], body: `body:${id}`,
        fields: id === project.id ? { aliases: { value: ['Demo Gateway'], type: 'list', source: 'frontmatter' } } : {} })),
      listMemoriesWithTotal: vi.fn(async (filters: Record<string, unknown>) => {
        lists.push(filters);
        if (filters.source === 'owner') return { memories: [memory(1, 'owner', 'Keep pages short.')], total: 1 };
        if (filters.query === '"Demo Gateway"') return { memories: [memory(2, 'curator', 'The gateway ships in March.')], total: 1 };
        return { memories: [], total: 0 };
      }),
    });
    const { llm, requests } = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));

    const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, false);

    expect(result.outcome).toBe('written');
    for (const tool of ['emit_topology_plan', 'emit_scoped_page', 'emit_wiki_sections']) {
      const user = requests.find(request => request.toolName === tool)?.user ?? '';
      expect(user, tool).toContain('OWNER MEMORIES');
      expect(user, tool).toContain('Keep pages short.');
      expect(user, tool).toContain('The gateway ships in March.');
    }
    expect(lists).toContainEqual(expect.objectContaining({ scope: 'node', node_id: project.id }));
    expect(lists.some(filters => 'includeProvenance' in filters)).toBe(false);
  });

  it('still writes a requested page when its memories cannot be read', async () => {
    const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(raw, { listMemoriesWithTotal: vi.fn(async () => { throw new Error('memories offline'); }) });
    const { llm, requests } = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));

    const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, false);

    expect(result.outcome).toBe('written');
    expect(requests.every(request => !request.user.includes('MEMORIES'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memories offline'));
    warn.mockRestore();
  });

  it('persists billed Anthropic missing-tool usage along with completed requested-page stages', async () => {
    const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
    const base = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'No tool response' }],
      usage: { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 },
    }));
    const anthropic = new AnthropicLlmClient({ messages: { create } } as unknown as Anthropic);
    const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; }, structuredCall: request => request.toolName === 'emit_scoped_page'
      ? anthropic.structuredCall(request) : base.llm.structuredCall(request) };

    const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, false);
    const expectedUsage = { input: 19, output: 11, cacheWrite: 4, cacheRead: 6 };
    expect(result).toMatchObject({ outcome: 'error', usage: expectedUsage, costUsd: estimateCostUsd(pricedConfig.model, expectedUsage) });
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      recordRun(db, requestedPageRunRow(result, { trigger: 'on-demand', durationMs: 100, ts: '2026-09-13T00:00:00Z' }));
      expect(db.prepare('SELECT * FROM runs').get()).toMatchObject({
        outcome: 'requested_page_error', input_tokens: 19, output_tokens: 11, cache_write: 4, cache_read: 6,
        cost_usd: estimateCostUsd(pricedConfig.model, expectedUsage), home_written: 0, themed_created: 0, wiki_curated_at: null,
      });
    } finally { db.close(); }
  });

  it.each(stages.flatMap((stage, index) => ['invalid output', 'known provider usage', 'unknown transport usage'].map(failure => ({ stage, index, failure }))))(
    'preserves and persists known usage when $stage fails with $failure', async ({ stage, index, failure }) => {
      const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
      const base = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));
      const calls: string[] = [];
      const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; }, structuredCall: async request => {
        calls.push(request.toolName);
        const usage = stageUsage[stages.indexOf(request.toolName)]!;
        if (request.toolName === stage) {
          if (failure === 'known provider usage') throw new StructuredCallFailure('provider failed', usage);
          if (failure === 'unknown transport usage') throw new StructuredCallFailure('transport failed');
          // The page case exercises the actual Markdown rejection boundary.
          return { output: stage === 'emit_scoped_page' ? { body: 'Name | Role |--- | --- |Alex | Owner |' } : {}, usage };
        }
        return { ...(await base.llm.structuredCall(request)), usage };
      } };

      const result = await curateRequestedPage(engine, llm, pricedConfig, project, { id: 20, title: 'Architecture Deep Dive' }, false);

      const known = stageUsage.slice(0, index + (failure === 'unknown transport usage' ? 0 : 1));
      const expectedUsage = known.reduce(addUsage, ZERO_USAGE);
      const expectedCost = known.length === 0 ? null : estimateCostUsd(pricedConfig.model, expectedUsage);
      expect(result).toMatchObject({ outcome: 'error', usage: expectedUsage, costUsd: expectedCost });
      expect(result).not.toHaveProperty('resolvedTo');
      expect(calls).toEqual(stages.slice(0, index + 1));
      expect(raw.wikiReconcile).not.toHaveBeenCalled();

      const db = new Database(':memory:');
      try {
        runMigrations(db);
        recordRun(db, requestedPageRunRow(result, { trigger: 'on-demand', durationMs: 100, ts: '2026-09-13T00:00:00Z' }));
        expect(db.prepare('SELECT * FROM runs').get()).toMatchObject({
          outcome: 'requested_page_error', input_tokens: expectedUsage.input, output_tokens: expectedUsage.output,
          cache_write: expectedUsage.cacheWrite, cache_read: expectedUsage.cacheRead, cost_usd: expectedCost,
          themed_created: 0, home_written: 0, wiki_curated_at: null,
        });
      } finally { db.close(); }
    },
  );

  it.each([false, true])('counts successful calls exactly once (dry-run=%s)', async dryRun => {
    const { engine } = engineFor(wiki({ subpages: [catalogPage()] }));
    const { llm, tools } = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));
    const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, dryRun);
    const expectedUsage = { input: 4, output: 4, cacheWrite: 0, cacheRead: 0 };
    expect(tools).toEqual(stages);
    expect(result).toMatchObject({ outcome: 'written', usage: expectedUsage, costUsd: estimateCostUsd(pricedConfig.model, expectedUsage) });
  });

  it('retains completed planner/adjudicator usage when a repair call fails without usage', async () => {
    const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
    const base = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }), 'substantial-overlap');
    let plannerCalls = 0;
    const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; }, structuredCall: async request => {
      if (request.toolName === 'emit_topology_plan' && ++plannerCalls === 2) throw new Error('transport failed');
      return base.llm.structuredCall(request);
    } };
    const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, false);
    expect(plannerCalls).toBe(2);
    expect(result).toMatchObject({ outcome: 'error', usage: { input: 2, output: 2, cacheWrite: 0, cacheRead: 0 } });
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('retains all completed calls when reconciliation fails after synthesis', async () => {
    const { engine, raw } = engineFor(wiki({ subpages: [catalogPage()] }));
    raw.wikiReconcile.mockRejectedValueOnce(new Error('version conflict'));
    const { llm } = llmFor(candidate({ v: 1, subject: 'Demo', facet: 'architecture decisions' }));
    const result = await curateRequestedPage(engine, llm, pricedConfig, project, { title: 'Architecture' }, false);
    expect(result).toMatchObject({ outcome: 'error', usage: { input: 4, output: 4, cacheWrite: 0, cacheRead: 0 } });
    expect(raw.wikiReconcile).toHaveBeenCalledTimes(1);
    expect(raw.wikiReconcile.mock.calls[0]?.[0].dry_run).toBe(true);
  });

  it('uses the evidence root ID for an immediate request whose caller knows only the title', async () => {
    const titleOnly = { id: null, title: project.title, file_path: '', status: null } as unknown as ProjectRef;
    const { engine, reconcileCalls, raw } = engineFor(wiki({ subpages: [] }));
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: [{
      op: 'create', plan_key: 'request', title: 'Deployment', kind: 'workstream',
      scope: { v: 1, subject: 'Demo', facet: 'deployment' }, synthesis_brief: 'Deployment.',
    }] };
    const { llm } = llmFor(plan);

    const result = await curateRequestedPage(engine, llm, config, titleOnly, { id: 13, title: 'Deployment' }, false);

    expect(result.outcome).toBe('written');
    expect(raw.projectEvidence).toHaveBeenCalledWith(titleOnly.title, config.meetingReads);
    expect(reconcileCalls[0]).toMatchObject({ project: titleOnly.title, project_id: project.id });
    expect(reconcileCalls[0]?.project_id).not.toBe('');
  });

  it('plans a requested page against Engine resolved root title when the caller title is stale', async () => {
    const staleProject = { ...project, title: 'Demo Before Rename' };
    const { engine } = engineFor(wiki({ subpages: [] }));
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: [{
      op: 'create', plan_key: 'request', title: 'Deployment', kind: 'workstream',
      scope: { v: 1, subject: 'Demo', facet: 'deployment' }, synthesis_brief: 'Deployment.',
    }] };
    const { llm, requests } = llmFor(plan);

    const result = await curateRequestedPage(engine, llm, config, staleProject, { id: 14, title: 'Deployment' }, false);

    expect(result.outcome).toBe('written');
    const topologyRequest = requests.find(request => request.toolName === 'emit_topology_plan');
    expect(JSON.parse(topologyRequest?.user ?? '')).toMatchObject({ wiki_root_title: project.title });
  });

  it('refreshes and pins a differently titled page with the same semantic scope', async () => {
    // Given
    const existing = wiki({ subpages: [catalogPage()] });
    const { engine, reconcileCalls } = engineFor(existing);
    const { llm } = llmFor(candidate());

    // When
    const result = await curateRequestedPage(engine, llm, config, project, { id: 7, title: 'Architecture Deep Dive' }, false);

    // Then
    expect(result.resolvedTo).toEqual({ nodeId: 'existing', title: 'Demo — Existing Architecture', action: 'refreshed' });
    expect(reconcileCalls[1]?.pages).toContainEqual(expect.objectContaining({
      op: 'upsert', target: expect.objectContaining({ node_id: 'existing' }), origin: 'requested', pinned: true,
    }));
  });

  it('reactivates a retired same-scope page', async () => {
    // Given
    const existing = wiki({ subpages: [catalogPage({ wiki_state: 'retired' })] });
    const { engine } = engineFor(existing);
    const { llm } = llmFor(candidate());

    // When
    const result = await curateRequestedPage(engine, llm, config, project, { id: 8, title: 'Architecture Deep Dive' }, false);

    // Then
    expect(result.resolvedTo?.action).toBe('reactivated');
    expect(result.resolvedTo?.nodeId).toBe('existing');
  });

  it('follows a replaced same-scope source to the final canonical target', async () => {
    // Given
    const source = catalogPage({ wiki_state: 'retired', wiki_replaced_by: { id: 'middle', title: 'Demo — Middle' } });
    const middleScope = { v: 1 as const, subject: 'Demo', facet: 'middle' };
    const targetScope = { v: 1 as const, subject: 'Demo', facet: 'canonical' };
    const middle = catalogPage({ id: 'middle', title: 'Demo — Middle', wiki_scope: middleScope, wiki_state: 'retired', wiki_replaced_by: { id: 'target', title: 'Demo — Canonical' } });
    const target = catalogPage({ id: 'target', title: 'Demo — Canonical', wiki_scope: targetScope });
    const plan = candidate();
    plan.reviewed_page_ids = ['existing', 'middle', 'target'];
    plan.actions.splice(1, 0,
      { op: 'keep', node_id: 'middle', scope: middleScope },
      { op: 'keep', node_id: 'target', scope: targetScope },
    );
    const { engine } = engineFor(wiki({ subpages: [source, middle, target] }));
    const { llm } = llmFor(plan);

    // When
    const result = await curateRequestedPage(engine, llm, config, project, { id: 9, title: 'Architecture Deep Dive' }, false);

    // Then
    expect(result.resolvedTo).toEqual({ nodeId: 'target', title: 'Demo — Canonical', action: 'refreshed' });
  });

  it('creates and pins a semantically distinct request in the reconciliation batch', async () => {
    // Given
    const existing = wiki({ subpages: [] });
    const distinctScope = { v: 1 as const, subject: 'Demo', facet: 'deployment' };
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: [{
      op: 'create', plan_key: 'request', title: 'Deployment', kind: 'workstream', scope: distinctScope,
      synthesis_brief: 'Requested deployment coverage.',
    }] };
    const { engine, reconcileCalls } = engineFor(existing);
    const { llm } = llmFor(plan);

    // When
    const result = await curateRequestedPage(engine, llm, config, project, { id: 10, title: 'Deployment' }, false);

    // Then
    expect(result.resolvedTo).toEqual({ nodeId: 'node:request', title: 'Deployment', action: 'created' });
    expect(reconcileCalls[1]?.pages[0]).toMatchObject({ origin: 'requested', pinned: true });
  });

  it('returns an ambiguity error without creating after overlap survives one repair', async () => {
    // Given
    const existing = wiki({ subpages: [catalogPage()] });
    const overlapScope = { v: 1 as const, subject: 'Demo', facet: 'architecture decisions' };
    const { engine, raw } = engineFor(existing);
    const { llm } = llmFor(candidate(overlapScope), 'substantial-overlap');

    // When
    const result = await curateRequestedPage(engine, llm, config, project, { id: 11, title: 'Architecture Decisions' }, false);

    // Then
    expect(result.outcome).toBe('error');
    expect(result.detail).toMatch(/ambiguous/i);
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('marks a budget refusal as retryable', async () => {
    const { engine } = engineFor(wiki({ subpages: [] }));
    const llm = { configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }), withConfiguration() { return this; },
      structuredCall: async () => { throw new BudgetExhaustedError('daily budget: $1.0000 spent of $1.00'); } } as unknown as LlmClient;
    const result = await curateRequestedPage(engine, llm, config, project, { id: 13, title: 'Deployment' }, false);
    expect(result).toMatchObject({ outcome: 'error', budgetRefused: true, detail: expect.stringMatching(/^daily budget: /) });
  });

  it('dry-run previews one batch without a commit', async () => {
    // Given
    const { engine, reconcileCalls } = engineFor(wiki({ subpages: [] }));
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: [{
      op: 'create', plan_key: 'request', title: 'Deployment', kind: 'workstream',
      scope: { v: 1, subject: 'Demo', facet: 'deployment' }, synthesis_brief: 'Deployment.',
    }] };
    const { llm } = llmFor(plan);

    // When
    const result = await curateRequestedPage(engine, llm, config, project, { id: 12, title: 'Deployment' }, true);

    // Then
    expect(result.resolvedTo?.action).toBe('preview');
    expect(reconcileCalls.map(call => call.dry_run)).toEqual([true]);
  });
});

describe('curateProject evidence components', () => {
  const components = { status: 's', tasks: 't1', notes: 'n', meetings: 'm', contacts: 'c' };
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const manifest = (over: Partial<{ evidenceHash: string; curatedAt: string }> = {}) =>
    ({ evidenceHash: 'old', components, curatedAt: daysAgo(1), ...over });
  // Topology matches the stamp; only the evidence hash differs from it.
  const stable = (over: Partial<ExistingWiki> = {}) => wiki({ topology_hash: 'stored', ...over });
  function fixture(existingWiki: ExistingWiki, current: typeof components = { ...components, tasks: 't2' }) {
    const f = engineFor(existingWiki);
    f.raw.projectEvidence.mockImplementation(async () => ({ ...evidence(existingWiki), evidence_components: current }));
    const wikiRefreshLive = vi.fn(async () => undefined);
    Object.assign(f.raw, { wikiRefreshLive });
    const structuredCall = vi.fn(async () => { throw new Error('no model call expected'); });
    const llm = { configurationFor: () => ({ provider: 'openrouter' as const, reasoningEffort: null }),
      withConfiguration() { return this; }, structuredCall } as unknown as LlmClient;
    return { ...f, wikiRefreshLive, structuredCall, llm };
  }
  const run = (f: ReturnType<typeof fixture>, opts: { dryRun?: boolean; force?: boolean; manifest?: ReturnType<typeof manifest> | null;
    cfg?: Partial<Config>; budgetSpent?: string; deferred?: { evidenceHash: string; count: number } } = {}) =>
    curateProject(f.engine, f.llm, { ...config, ...opts.cfg }, project, opts.dryRun ?? false, opts.force ?? false,
      undefined, undefined, undefined, undefined, { priorManifest: opts.manifest === undefined ? manifest() : opts.manifest,
        ...(opts.budgetSpent === undefined ? {} : { budgetSpent: opts.budgetSpent }),
        ...(opts.deferred === undefined ? {} : { deferred: opts.deferred }) });

  it('re-renders live sections without a model call when only tasks changed', async () => {
    const f = fixture(stable());
    const result = await run(f);
    expect(result).toMatchObject({ outcome: 'refreshed_live', changedComponents: ['tasks'], wikiCuratedAt: null });
    expect(f.wikiRefreshLive).toHaveBeenCalledWith('p1', false);
    expect(f.structuredCall).not.toHaveBeenCalled();
    expect(f.raw.wikiReconcile).not.toHaveBeenCalled();

    const dry = fixture(stable());
    expect(await run(dry, { dryRun: true })).toMatchObject({ outcome: 'refreshed_live', dryRun: true });
    expect(dry.wikiRefreshLive).toHaveBeenCalledWith('p1', true);
  });

  it('refreshes the narrative when tasks have waited long enough, other evidence changed, or the manifest is stale', async () => {
    const cases: Array<[string, ReturnType<typeof fixture>, Parameters<typeof run>[1], RegExp]> = [
      ['aged narrative', fixture(stable()), { manifest: manifest({ curatedAt: daysAgo(8) }) }, /tasks changed/],
      ['task-only refresh disabled', fixture(stable()), { cfg: { wikiTaskOnlyRefreshDays: 0 } }, /tasks changed/],
      ['notes changed too', fixture(stable(), { ...components, tasks: 't2', notes: 'n2' }), {}, /tasks, notes changed/],
      ['manifest from another stamp', fixture(stable()), { manifest: manifest({ evidenceHash: 'older' }) }, /evidence or topology changed/],
      ['no manifest', fixture(stable()), { manifest: null }, /evidence or topology changed/],
      ['topology changed', fixture(wiki()), {}, /tasks changed/],
      ['forced', fixture(stable()), { force: true }, /forced/],
    ];
    for (const [label, f, opts, reason] of cases) {
      const result = await run(f, { ...opts, dryRun: true });
      expect(result.outcome, label).toBe('would_curate');
      expect(result.detail, label).toMatch(reason);
      expect(f.wikiRefreshLive, label).not.toHaveBeenCalled();
    }
  });

  it('says on a forced dry run whether anything has changed (#372)', async () => {
    const stamped = stable({ home: { id: 'home', version: 3, wiki_evidence_hash: 'evidence', wiki_topology_hash: 'stored' } });
    expect(await run(fixture(stamped), { dryRun: true, force: true })).toMatchObject({ outcome: 'would_curate', evidenceUnchanged: true });
    expect(await run(fixture(stable()), { dryRun: true, force: true })).toMatchObject({ outcome: 'would_curate', evidenceUnchanged: false });
    const unforced = await run(fixture(stable(), { ...components, tasks: 't2', notes: 'n2' }), { dryRun: true });
    expect(unforced.outcome).toBe('would_curate');
    expect(unforced.evidenceUnchanged).toBeUndefined();
  });

  it('keeps unchanged wikis\' live sections current, except on dry runs', async () => {
    const unchanged = stable({ home: { id: 'home', version: 3, wiki_evidence_hash: 'evidence', wiki_topology_hash: 'stored' } });
    const live = fixture(unchanged, components);
    expect((await run(live)).outcome).toBe('skipped');
    expect(live.wikiRefreshLive).toHaveBeenCalledWith('p1', false);
    live.wikiRefreshLive.mockRejectedValueOnce(new Error('engine busy'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await run(live)).outcome).toBe('skipped');
    warn.mockRestore();
    const dry = fixture(unchanged, components);
    expect((await run(dry, { dryRun: true })).outcome).toBe('skipped');
    expect(dry.wikiRefreshLive).not.toHaveBeenCalled();
  });

  it('plans again on unchanged evidence while page creates are deferred', async () => {
    const unchanged = stable({ home: { id: 'home', version: 3, wiki_evidence_hash: 'evidence', wiki_topology_hash: 'stored' } });
    const pending = fixture(unchanged, components);
    const result = await run(pending, { dryRun: true, deferred: { evidenceHash: 'evidence', count: 1 } });
    expect(result).toMatchObject({ outcome: 'would_curate', detail: expect.stringMatching(/deferred page creates pending/) });
    for (const [label, deferred] of [['none deferred', undefined], ['from another stamp', { evidenceHash: 'old', count: 1 }]] as const) {
      expect((await run(fixture(unchanged, components), { dryRun: true, ...(deferred ? { deferred } : {}) })).outcome, label).toBe('skipped');
    }
  });

  it('reports page creates the per-run cap deferred, unless creates are disabled', async () => {
    const create = (key: string) => ({ op: 'create' as const, plan_key: key, title: `Project — ${key}`, kind: 'workstream' as const,
      scope: { v: 1 as const, subject: 'Project', facet: key }, synthesis_brief: `${key}.` });
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: [create('alpha'), create('beta'), create('gamma')] };
    const written = async (cap: number) => {
      const f = engineFor(wiki());
      return curateProject(f.engine, llmFor(plan).llm, { ...config, wikiPageCreatesPerRun: cap }, project, false, false);
    };
    const capped = await written(1);
    expect(capped).toMatchObject({ outcome: 'written', deferredCreates: 2 });
    expect((await written(5)).deferredCreates).toBeUndefined();
    const disabled = await written(0);
    expect(disabled.outcome).toBe('written');
    expect(disabled.deferredCreates).toBeUndefined();
  });

  it('with the budget spent, still refreshes live sections but starts no paid stage', async () => {
    const budgetSpent = 'daily budget spent; the next sweep retries';
    const taskOnly = fixture(stable());
    expect((await run(taskOnly, { budgetSpent })).outcome).toBe('refreshed_live');
    expect(taskOnly.wikiRefreshLive).toHaveBeenCalledWith('p1', false);
    const unchanged = fixture(stable({ home: { id: 'home', version: 3, wiki_evidence_hash: 'evidence', wiki_topology_hash: 'stored' } }), components);
    expect((await run(unchanged, { budgetSpent })).outcome).toBe('skipped');
    expect(unchanged.wikiRefreshLive).toHaveBeenCalledOnce();
    const paid = fixture(stable(), { ...components, tasks: 't2', notes: 'n2' });
    expect(await run(paid, { budgetSpent })).toMatchObject({ outcome: 'skipped_budget', detail: budgetSpent });
    for (const f of [taskOnly, unchanged, paid]) expect(f.structuredCall).not.toHaveBeenCalled();
    expect(paid.raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('records the evidence a written narrative came from and which parts changed', async () => {
    const f = engineFor(stable());
    f.raw.projectEvidence.mockImplementation(async () => ({ ...evidence(stable()), evidence_components: { ...components, notes: 'n2' } }));
    const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });
    const result = await curateProject(f.engine, llm, config, project, false, false,
      undefined, undefined, undefined, undefined, { priorManifest: manifest() });
    expect(result).toMatchObject({ outcome: 'written', changedComponents: ['notes'],
      evidenceComponents: { ...components, notes: 'n2' } });
    expect(result.detail).toMatch(/changed: notes$/);
  });
});
