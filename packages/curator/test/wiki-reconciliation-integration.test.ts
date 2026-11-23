// allow: SIZE_OK — executable cross-package acceptance spec for semantic reconciliation.
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { EngineError, type WikiReconcileInput, type WikiReconcileResult } from '../src/engine.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';
import { runReconciliationPipeline } from '../src/reconciliation-pipeline.js';
import { curateResultToRunRow } from '../src/db/runs.js';
import type {
  ExistingWiki,
  TopologyPlan,
  WikiCatalogPage,
  WikiScopeV1,
} from '../src/types.js';

const USAGE = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };
const EVIDENCE_HASH = 'evidence-accepted';
const POST_TOPOLOGY_HASH = 'topology-after-reconciliation';
const PROJECT = 'Project Atlas';

const config = {
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
  wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
  model: 'model', homeMaxTokens: 4096, bodyCharCap: 4000,
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
} as Config;

const scope = (facet: string): WikiScopeV1 => ({ v: 1, subject: PROJECT, facet });

function page(
  id: string,
  facet: string,
  overrides: Partial<WikiCatalogPage> = {},
): WikiCatalogPage {
  return {
    id,
    title: `${PROJECT} — ${facet}`,
    file_path: `Wikis/${PROJECT}/${facet}.md`,
    version: 1,
    content_hash: `hash-${id}`,
    wiki_state: 'active',
    wiki_kind: 'timeline',
    wiki_origin: 'automatic',
    wiki_scope: scope(facet),
    wiki_pinned: false,
    summary: `${facet} summary.`,
    ...overrides,
  };
}

function acceptanceFixture(): {
  readonly before: ExistingWiki;
  readonly after: ExistingWiki;
  readonly plan: TopologyPlan;
} {
  const timeline = page('timeline', 'Operations Timeline');
  const duplicate = page('duplicate', 'Campaign Chronology', { wiki_scope: scope('Operations Timeline') });
  const middle = page('middle', 'Prior Timeline', {
    wiki_state: 'retired',
    wiki_scope: scope('Operations Timeline'),
    wiki_replaced_by: { id: duplicate.id, title: duplicate.title },
  });
  const ancestor = page('ancestor', 'Original Chronology', {
    wiki_state: 'retired',
    wiki_scope: scope('Operations Timeline'),
    wiki_replaced_by: { id: middle.id, title: middle.title },
  });
  const requested = page('requested', 'Requested Decision Record', {
    wiki_state: 'dormant', wiki_kind: 'decision-log', wiki_origin: 'requested', wiki_pinned: true,
  });
  const legacy = page('legacy', 'Legacy Human Notes', {
    wiki_kind: undefined, wiki_scope: undefined, summary: 'Human-authored legacy material.',
  });
  const regional = page('regional', 'Regional Timeline', { wiki_scope: scope('Regional operations') });
  const diplomatic = page('diplomatic', 'Diplomatic Timeline', { wiki_scope: scope('Diplomatic developments') });
  const stale = page('stale', 'Concluded Thread', { wiki_kind: 'workstream' });
  const subpages = [timeline, duplicate, middle, ancestor, requested, legacy, regional, diplomatic, stale];

  const plan: TopologyPlan = {
    reviewed_page_ids: subpages.map(item => item.id),
    actions: [
      {
        op: 'merge', target: { node_id: timeline.id }, sources: [duplicate.id],
        scope: scope('Operations Timeline'), reason: 'The two pages cover the same chronology.',
        synthesis_brief: 'Consolidate the complete operations chronology.',
      },
      { op: 'keep', node_id: middle.id, scope: scope('Operations Timeline') },
      { op: 'keep', node_id: ancestor.id, scope: scope('Operations Timeline') },
      {
        op: 'reactivate', node_id: requested.id, scope: requested.wiki_scope ?? scope('Requested Decision Record'),
        synthesis_brief: 'Refresh the requested decision record.',
      },
      { op: 'keep', node_id: legacy.id, scope: scope('Legacy institutional context') },
      { op: 'keep', node_id: regional.id, scope: regional.wiki_scope ?? scope('Regional operations') },
      { op: 'keep', node_id: diplomatic.id, scope: diplomatic.wiki_scope ?? scope('Diplomatic developments') },
      {
        op: 'retire', node_id: stale.id, scope: stale.wiki_scope ?? scope('Concluded Thread'),
        state: 'retired', reason: 'The workstream concluded.',
      },
      ...['Air operations', 'Maritime operations', 'Cyber operations'].map((facet, index) => ({
        op: 'create' as const,
        plan_key: `new-${index}`,
        title: `${PROJECT} — ${facet}`,
        kind: 'timeline' as const,
        scope: scope(facet),
        synthesis_brief: `Create distinct coverage for ${facet}.`,
      })),
    ],
  };

  const finalTarget = { ...timeline, version: 2, content_hash: 'post-timeline' };
  const finalPages: WikiCatalogPage[] = [
    finalTarget,
    { ...duplicate, version: 2, wiki_state: 'retired', wiki_replaced_by: { id: timeline.id, title: timeline.title } },
    { ...middle, version: 2, wiki_replaced_by: { id: timeline.id, title: timeline.title } },
    { ...ancestor, version: 2, wiki_replaced_by: { id: timeline.id, title: timeline.title } },
    { ...requested, version: 2, wiki_state: 'active' },
    { ...legacy, version: 2, wiki_scope: scope('Legacy institutional context'), wiki_kind: 'freeform' },
    regional,
    diplomatic,
    { ...stale, version: 2, wiki_state: 'retired' },
    ...['Air operations', 'Maritime operations', 'Cyber operations'].map((facet, index) => page(
      `created-new-${index}`,
      facet,
      { title: `${PROJECT} — ${facet}` },
    )),
  ];

  return {
    before: {
      home_id: 'home',
      home: { id: 'home', version: 4, wiki_evidence_hash: 'old-evidence', wiki_topology_hash: 'old-topology' },
      topology_hash: 'topology-before', catalog_valid: true, subpages,
    },
    after: {
      home_id: 'home',
      home: {
        id: 'home', version: 5, wiki_evidence_hash: EVIDENCE_HASH,
        wiki_topology_hash: POST_TOPOLOGY_HASH, wiki_curated_at: '2026-08-15T00:00:00.000Z',
      },
      topology_hash: POST_TOPOLOGY_HASH, catalog_valid: true, subpages: finalPages,
    },
    plan,
  };
}

class AcceptanceLlm implements LlmClient {
  configurationFor() { return { provider: 'openrouter' as const, reasoningEffort: null }; }
  withConfiguration() { return this; }
  readonly calls: StructuredCallRequest[] = [];

  constructor(
    private readonly plan: TopologyPlan,
    private readonly relation: 'distinct' | 'substantial-overlap' = 'distinct',
    private readonly failTool?: string,
  ) {}

  async structuredCall(request: StructuredCallRequest) {
    this.calls.push(request);
    if (request.toolName === this.failTool) throw new Error(`forced ${request.toolName} failure`);
    switch (request.toolName) {
      case 'emit_topology_plan':
        return { output: this.plan, usage: USAGE };
      case 'emit_scope_adjudication': {
        const payload = JSON.parse(request.user) as {
          comparisons: Array<{
            pair_id: string;
            candidate_plan_key: string;
            compared_to: { node_id: string } | { plan_key: string };
          }>;
        };
        return {
          output: {
            verdicts: payload.comparisons.map(pair => ({
              pair_id: pair.pair_id,
              candidate_plan_key: pair.candidate_plan_key,
              compared_to: pair.compared_to,
              relation: this.relation,
              confidence: 0.95,
              evidence_ids: ['evidence-1'],
              reason: this.relation === 'distinct' ? 'Independent supported scope.' : 'Coverage remains ambiguous.',
              narrower: 'none',
            })),
          },
          usage: USAGE,
        };
      }
      case 'emit_scoped_page':
        return { output: { body: 'Grounded managed Summary.', log_note: 'Reconciled scope.' }, usage: USAGE };
      case 'emit_wiki_sections':
        return {
          output: { now: 'Current state.', focus: [{ title: 'Current focus.' }], open_threads: [{ title: 'Open questions.' }], log_entry: 'Reconciled topology.' },
          usage: USAGE,
        };
      default:
        throw new Error(`Unexpected tool ${request.toolName}`);
    }
  }
}

class StatefulEngine {
  readonly reconcileCalls: WikiReconcileInput[] = [];
  private operationCount = 0;

  constructor(
    private readonly pages: readonly WikiCatalogPage[],
    private failNextCommit = false,
  ) {}

  async getNode(nodeId: string) {
    const found = this.pages.find(item => item.id === nodeId);
    if (found === undefined) throw new Error(`Missing fixture node ${nodeId}`);
    return { id: found.id, title: found.title, types: ['wiki'], fields: {}, body: `Human prose for ${found.title}.` };
  }

  async wikiReconcile(input: WikiReconcileInput) {
    this.reconcileCalls.push(input);
    const dryRun = input.dry_run === true;
    if (!dryRun && this.failNextCommit) {
      this.failNextCommit = false;
      throw new EngineError('STALE_NODE', 'catalog changed after preview');
    }
    if (!dryRun) this.operationCount += 1;
    const created = input.pages.flatMap(operation => operation.op !== 'retire' && operation.target.mode === 'new'
      ? [{
          node_id: dryRun ? `plan:${operation.target.plan_key}` : `created-${operation.target.plan_key}`,
          title: operation.target.title,
          file_path: `Wikis/${operation.target.title}.md`,
          version: 1,
        }]
      : []);
    const mappings = input.pages.flatMap(operation => operation.op === 'merge'
      ? operation.sources.map(source => {
          const target = operation.target;
          return {
            source_node_id: source.node_id,
            target_node_id: target.mode === 'existing' ? target.node_id : `created-${target.plan_key}`,
            target_title: target.mode === 'existing'
              ? this.pages.find(item => item.id === target.node_id)?.title ?? target.node_id
              : target.title,
          };
        })
      : []);
    const data: WikiReconcileResult = {
      operation_id: dryRun ? null : `operation-${this.operationCount}`,
      reconcile_key: input.reconcile_key,
      plan_digest: 'accepted-plan-digest',
      reused: false,
      dry_run: dryRun,
      created,
      updated: [],
      mappings,
      home: { node_id: 'home', title: `${PROJECT} Wiki`, file_path: `Wikis/${PROJECT} Wiki.md`, version: 5, created: false },
      topology_hash: POST_TOPOLOGY_HASH,
      warnings: [],
      preview: {
        total: input.pages.length,
        items: input.pages.map(operation => {
          if (operation.op === 'retire') {
            return {
              op: operation.op,
              target: operation.node_id,
              title: this.pages.find(item => item.id === operation.node_id)?.title ?? operation.node_id,
              state: operation.state,
            };
          }
          const target = operation.target;
          return {
            op: operation.op,
            target: target.mode === 'existing' ? target.node_id : target.plan_key,
            title: target.mode === 'existing'
              ? this.pages.find(item => item.id === target.node_id)?.title ?? target.node_id
              : target.title,
            ...(operation.op === 'merge' ? { source_count: operation.sources.length } : {}),
          };
        }),
        truncated: false,
      },
    };
    return { data, warnings: [] };
  }
}

describe('semantic wiki reconciliation assembled acceptance', () => {
  it('prices a run on a catalog model the static table lacks (#356)', async () => {
    const llm = new AcceptanceLlm({ reviewed_page_ids: ['unknown'], actions: [] });
    const run = (modelPricing: Config['modelPricing']) => runReconciliationPipeline({
      engine: { getNode: vi.fn(), wikiReconcile: vi.fn() } as never,
      llm,
      config: { ...config, model: 'catalog/only-model', modelPricing },
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: acceptanceFixture().before,
      dryRun: false,
      force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect((await run({})).result.costUsd).toBeNull();
    const rates = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect((await run({ 'catalog/only-model': rates })).result.costUsd).toBe(3);
  });

  it('does not synthesize pages or call Engine after exhausting topology validation repairs', async () => {
    const invalidPlan: TopologyPlan = { reviewed_page_ids: ['unknown'], actions: [] };
    const llm = new AcceptanceLlm(invalidPlan);
    const engine = {
      getNode: vi.fn(async () => { throw new Error('page synthesis must not run'); }),
      wikiReconcile: vi.fn(async () => { throw new Error('Engine must not run'); }),
    };

    const output = await runReconciliationPipeline({
      engine: engine as never,
      llm,
      config: { ...config, model: 'claude-sonnet-4-6' },
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: acceptanceFixture().before,
      dryRun: false,
      force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect(output.result).toMatchObject({
      outcome: 'error',
      detail: expect.stringMatching(/^validation:/),
      usage: { input: 3, output: 3, cacheWrite: 0, cacheRead: 0 },
      costUsd: expect.any(Number),
    });
    const row = curateResultToRunRow(output.result, {
      trigger: 'scheduled', durationMs: 10, ts: '2026-08-18T00:00:00.000Z',
    });
    expect(row).toMatchObject({ input_tokens: 3, output_tokens: 3, cost_usd: output.result.costUsd });
    // The failure hold compares this with the policy of a later sweep (#358).
    expect(row.output_policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(llm.calls.map(call => call.toolName)).toEqual([
      'emit_topology_plan',
      'emit_topology_plan',
      'emit_topology_plan',
    ]);
    expect(llm.calls.some(call => call.toolName === 'emit_scoped_page')).toBe(false);
    expect(llm.calls.some(call => call.toolName === 'emit_wiki_sections')).toBe(false);
    expect(engine.getNode).not.toHaveBeenCalled();
    expect(engine.wikiReconcile).not.toHaveBeenCalled();
  });

  it('reconciles a complete mixed catalog, then converges with zero LLM or engine calls', async () => {
    const fixture = acceptanceFixture();
    const llm = new AcceptanceLlm(fixture.plan);
    const engine = new StatefulEngine(fixture.before.subpages);
    const prepareEvidence = vi.fn(async () => ({
      text: 'Grounded project evidence.',
      nodes: [{ id: 'evidence-1', title: 'Evidence', types: ['note'], fields: {}, body: 'Evidence body.' }],
    }));

    const first = await runReconciliationPipeline({
      engine: engine as never,
      llm,
      config,
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: fixture.before,
      dryRun: false,
      force: false,
      prepareEvidence,
    });

    expect(first.result.outcome).toBe('written');
    expect(engine.reconcileCalls.map(call => call.dry_run)).toEqual([true, false]);
    expect(engine.reconcileCalls[1]?.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'merge' }),
      expect.objectContaining({ op: 'retire', node_id: 'stale' }),
      expect.objectContaining({ op: 'upsert', target: expect.objectContaining({ node_id: 'legacy' }) }),
    ]));
    expect(engine.reconcileCalls[1]?.pages.filter(operation => operation.op !== 'retire' && operation.target.mode === 'new')).toHaveLength(3);
    expect(first.result.topology?.filter(item => item.action === 'created')).toHaveLength(3);
    expect(first.result.topology).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'merged-source', node_id: 'duplicate', target_node_id: 'timeline' }),
      expect.objectContaining({ action: 'reactivated', node_id: 'requested' }),
      expect.objectContaining({ action: 'adopted', node_id: 'legacy' }),
      expect.objectContaining({ action: 'retired', node_id: 'stale' }),
    ]));
    expect(first.result.topologyAudit?.operationId).toBe('operation-1');
    expect(first.result.topologyAudit?.finalReviewedPageIds).toEqual(fixture.plan.reviewed_page_ids);

    const llmCallsAfterFirst = llm.calls.length;
    const engineCallsAfterFirst = engine.reconcileCalls.length;
    const second = await runReconciliationPipeline({
      engine: engine as never,
      llm,
      config,
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: fixture.after,
      dryRun: false,
      force: false,
      prepareEvidence,
    });

    expect(second.result).toMatchObject({ outcome: 'skipped', detail: 'evidence and topology unchanged' });
    expect(llm.calls).toHaveLength(llmCallsAfterFirst);
    expect(engine.reconcileCalls).toHaveLength(engineCallsAfterFirst);
    expect(prepareEvidence).toHaveBeenCalledTimes(1);
  });

  it('drops a twice-ambiguous create while committing an independent retirement with a warning', async () => {
    const existing = page('existing', 'Architecture');
    const stale = page('stale', 'Old deployment');
    const wiki: ExistingWiki = {
      home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'before', catalog_valid: true,
      subpages: [existing, stale],
    };
    const ambiguousPlan: TopologyPlan = {
      reviewed_page_ids: ['existing', 'stale'],
      actions: [
        { op: 'keep', node_id: existing.id, scope: existing.wiki_scope ?? scope('Architecture') },
        { op: 'retire', node_id: stale.id, scope: stale.wiki_scope ?? scope('Old deployment'), state: 'retired', reason: 'Concluded.' },
        {
          op: 'create', plan_key: 'architecture-decisions', title: `${PROJECT} — Architecture Decisions`,
          kind: 'decision-log', scope: scope('Architecture decisions'), synthesis_brief: 'Potentially overlapping coverage.',
        },
      ],
    };
    const llm = new AcceptanceLlm(ambiguousPlan, 'substantial-overlap');
    const engine = new StatefulEngine(wiki.subpages);

    const output = await runReconciliationPipeline({
      engine: engine as never,
      llm,
      config,
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: wiki,
      dryRun: false,
      force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect(output.result.outcome).toBe('written');
    expect(output.result.topology).toContainEqual(expect.objectContaining({ action: 'ambiguous-create-skipped' }));
    expect(output.result.detail).toMatch(/Skipped ambiguous create candidates/);
    expect(engine.reconcileCalls[1]?.pages).toEqual([
      expect.objectContaining({ op: 'retire', node_id: stale.id }),
    ]);
    expect(engine.reconcileCalls.flatMap(call => call.pages).some(operation => operation.op !== 'retire' && operation.target.mode === 'new')).toBe(false);
  });

  it('keeps a page the planner gave no action and names it in the run warnings (#323)', async () => {
    const existing = page('existing', 'Architecture');
    const stale = page('stale', 'Old deployment');
    const wiki: ExistingWiki = {
      home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'before', catalog_valid: true,
      subpages: [existing, stale],
    };
    // Retires one page and says nothing about the other.
    const partialPlan: TopologyPlan = {
      reviewed_page_ids: ['stale'],
      actions: [{ op: 'retire', node_id: stale.id, scope: stale.wiki_scope ?? scope('Old deployment'), state: 'retired', reason: 'Concluded.' }],
    };
    const llm = new AcceptanceLlm(partialPlan);
    const engine = new StatefulEngine(wiki.subpages);

    const output = await runReconciliationPipeline({
      engine: engine as never, llm, config, project: PROJECT, rootTitle: PROJECT, wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH, existingWiki: wiki, dryRun: false, force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect(output.result.outcome).toBe('written');
    const warning = `planner gave no action for 1 page(s), kept unchanged: ${existing.title}`;
    expect(output.result.detail).toContain(warning);
    expect(output.result.topologyAudit?.warnings).toContain(warning);
    expect(llm.calls.filter(call => call.toolName === 'emit_topology_plan')).toHaveLength(1);
    // The kept page is not written: the preview and the commit each carry only the retirement.
    expect(engine.reconcileCalls.map(call => call.pages.map(operation => operation.op))).toEqual([['retire'], ['retire']]);
  });

  it('keeps a brief still over 2,000 characters after a repair, names its page in the run warnings, and saves its length (#633)', async () => {
    const existing = page('existing', 'Architecture');
    const wiki: ExistingWiki = {
      home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'before', catalog_valid: true, subpages: [existing],
    };
    const brief = 'Cover the architecture decisions, the open questions and the rollout. '.repeat(40);
    // The planner returns the same long brief to the repair that asks it to shorten.
    const longPlan: TopologyPlan = {
      reviewed_page_ids: ['existing'],
      actions: [{ op: 'refresh', node_id: existing.id, scope: existing.wiki_scope ?? scope('Architecture'), synthesis_brief: brief }],
    };
    const llm = new AcceptanceLlm(longPlan);

    const output = await runReconciliationPipeline({
      engine: new StatefulEngine(wiki.subpages) as never, llm, config, project: PROJECT, rootTitle: PROJECT, wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH, existingWiki: wiki, dryRun: false, force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect(output.result.outcome).toBe('written');
    const warning = `planner brief over the 2000-character target, kept for 1 page(s): ${existing.title} (${brief.length} chars)`;
    expect(output.result.detail).toContain(warning);
    expect(output.result.topologyAudit?.warnings).toContain(warning);
    expect(llm.calls.filter(call => call.toolName === 'emit_topology_plan')).toHaveLength(2);
    // The saved run keeps each brief's length, not its text, so long briefs can be counted later.
    const row = curateResultToRunRow(output.result, { trigger: 'scheduled', durationMs: 10, ts: '2026-08-18T00:00:00.000Z' });
    const saved = JSON.parse(row.topology_json ?? '{}') as { warnings: string[]; planning_attempts: { plan: { actions: Record<string, unknown>[] } }[] };
    expect(saved.warnings).toContain(warning);
    expect(saved.planning_attempts.map(attempt => attempt.plan.actions[0]?.['synthesis_brief_chars'])).toEqual([brief.length, brief.length]);
    expect(row.topology_json).not.toContain('Cover the architecture');
  });

  it('retains completed planning usage when page synthesis fails', async () => {
    const fixture = acceptanceFixture();
    const llm = new AcceptanceLlm(fixture.plan, 'distinct', 'emit_scoped_page');

    const output = await runReconciliationPipeline({
      engine: new StatefulEngine(fixture.before.subpages) as never,
      llm,
      config: { ...config, model: 'claude-sonnet-4-6' },
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: fixture.before,
      dryRun: false,
      force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect(output.result).toMatchObject({
      outcome: 'error',
      detail: expect.stringMatching(/^page synthesis:/),
      usage: { input: 2, output: 2, cacheWrite: 0, cacheRead: 0 },
      costUsd: expect.any(Number),
    });
  });

  it('records all completed page usage when a later page fails validation without writes', async () => {
    const fixture = acceptanceFixture();
    const base = new AcceptanceLlm(fixture.plan);
    let pageCalls = 0;
    const llm: LlmClient = {
      configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
      withConfiguration() { return this; }, structuredCall: async request => {
      const result = await base.structuredCall(request);
      return request.toolName === 'emit_scoped_page' && ++pageCalls >= 2
        ? { ...result, output: { body: '# Empty narrative' } } : result;
    } };
    const engine = new StatefulEngine(fixture.before.subpages);
    const output = await runReconciliationPipeline({
      engine: engine as never, llm, config: { ...config, model: 'claude-sonnet-4-6' },
      project: PROJECT, rootTitle: PROJECT, wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH, existingWiki: fixture.before, dryRun: false, force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });
    // The invalid page is retried once and fails again; both attempts stay billed.
    expect(pageCalls).toBe(3);
    expect(output.result).toMatchObject({
      outcome: 'error', usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: expect.any(Number),
    });
    const row = curateResultToRunRow(output.result, { ts: '2026-09-13T00:00:00Z', trigger: 'scheduled', durationMs: 1 });
    expect(row).toMatchObject({ input_tokens: 5, output_tokens: 5, cost_usd: output.result.costUsd });
    expect(engine.reconcileCalls).toEqual([]);
  });

  it('retains planning and page usage when home synthesis fails', async () => {
    const fixture = acceptanceFixture();
    const llm = new AcceptanceLlm(fixture.plan, 'distinct', 'emit_wiki_sections');

    const output = await runReconciliationPipeline({
      engine: new StatefulEngine(fixture.before.subpages) as never,
      llm,
      config: { ...config, model: 'claude-sonnet-4-6' },
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: fixture.before,
      dryRun: false,
      force: true,
      prepareEvidence: async () => ({ text: 'Evidence.', nodes: [] }),
    });

    expect(output.result).toMatchObject({
      outcome: 'error',
      detail: expect.stringMatching(/^home synthesis:/),
      usage: { input: 7, output: 7, cacheWrite: 0, cacheRead: 0 },
      costUsd: expect.any(Number),
    });
  });

  it('writes nothing after a stale commit and re-plans against the fresh catalog on retry', async () => {
    const fixture = acceptanceFixture();
    const llm = new AcceptanceLlm(fixture.plan);
    const engine = new StatefulEngine(fixture.before.subpages, true);
    const prepareEvidence = vi.fn(async () => ({ text: 'Fresh evidence.', nodes: [] }));

    const stale = await runReconciliationPipeline({
      engine: engine as never,
      llm,
      config: { ...config, model: 'claude-sonnet-4-6' },
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: fixture.before,
      dryRun: false,
      force: false,
      prepareEvidence,
    });

    expect(stale.result).toMatchObject({
      outcome: 'error',
      detail: expect.stringMatching(/commit.*STALE_NODE/),
      topologyHash: fixture.before.topology_hash,
      usage: { input: 8, output: 8, cacheWrite: 0, cacheRead: 0 },
      costUsd: expect.any(Number),
    });
    const staleRow = curateResultToRunRow(stale.result, {
      trigger: 'scheduled', durationMs: 10, ts: '2026-08-18T00:00:00.000Z',
    });
    expect(staleRow).toMatchObject({ input_tokens: 8, output_tokens: 8, cost_usd: stale.result.costUsd });
    expect(stale.result.topologyAudit?.operationId).toBeUndefined();
    expect(engine.reconcileCalls.map(call => call.dry_run)).toEqual([true, false]);

    const freshCatalog: ExistingWiki = {
      ...fixture.before,
      home: {
        ...fixture.before.home!,
        version: fixture.before.home!.version + 1,
        wiki_evidence_hash: EVIDENCE_HASH,
        wiki_topology_hash: 'topology-before-external-edit',
      },
      topology_hash: 'topology-after-external-edit',
      subpages: fixture.before.subpages.map(item => ({
        ...item,
        version: item.version + 1,
        content_hash: `fresh-${item.content_hash}`,
      })),
    };
    const retry = await runReconciliationPipeline({
      engine: engine as never,
      llm,
      config,
      project: PROJECT,
      rootTitle: PROJECT,
      wikiRootId: 'project-root',
      evidenceHash: EVIDENCE_HASH,
      existingWiki: freshCatalog,
      dryRun: false,
      force: false,
      prepareEvidence,
    });

    expect(retry.result.outcome).toBe('written');
    expect(retry.result.topologyAudit?.operationId).toBe('operation-1');
    expect(engine.reconcileCalls.map(call => call.dry_run)).toEqual([true, false, true, false]);
    expect(llm.calls.filter(call => call.toolName === 'emit_topology_plan')).toHaveLength(2);
    expect(prepareEvidence).toHaveBeenCalledTimes(2);
  });
});
