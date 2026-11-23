import { describe, expect, it } from 'vitest';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';
import { planReconciliation, PlanningPhaseError } from '../src/reconciliation-planning.js';
import type { ExistingWiki, TokenUsage, TopologyPlan, WikiScopeV1 } from '../src/types.js';

const PROJECT = 'Project Atlas';
const PAGE_ID = 'existing';

const scope = (facet: string): WikiScopeV1 => ({ v: 1, subject: PROJECT, facet });
const usage = (value: number): TokenUsage => ({
  input: value,
  output: value,
  cacheWrite: value,
  cacheRead: value,
});

const existingWiki: ExistingWiki = {
  home_id: 'home',
  home: { id: 'home', version: 1 },
  topology_hash: 'topology-before',
  catalog_valid: true,
  subpages: [{
    id: PAGE_ID,
    title: `${PROJECT} — Existing`,
    file_path: `Wikis/${PROJECT}/Existing.md`,
    version: 1,
    content_hash: 'hash-existing',
    wiki_state: 'active',
    wiki_origin: 'automatic',
    wiki_scope: scope('existing'),
    wiki_pinned: false,
  }],
};

const invalidUnknownPlan: TopologyPlan = {
  reviewed_page_ids: ['unknown'],
  actions: [],
};

const invalidMissingRolePlan: TopologyPlan = {
  reviewed_page_ids: [PAGE_ID],
  actions: [],
};

// Invalid for a reason the run cannot settle itself: an action for a page that isn't in the catalog.
const invalidActionPlan: TopologyPlan = {
  reviewed_page_ids: [PAGE_ID],
  actions: [
    { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
    { op: 'keep', node_id: 'unknown', scope: scope('unknown') },
  ],
};

const invalidRootCollisionPlan: TopologyPlan = {
  reviewed_page_ids: [PAGE_ID],
  actions: [
    { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
    {
      op: 'create',
      plan_key: 'root-duplicate',
      title: 'PROJECT ATLAS',
      kind: 'workstream',
      scope: scope('duplicate root'),
      synthesis_brief: 'Duplicate the project root.',
    },
  ],
};

const validKeepPlan: TopologyPlan = {
  reviewed_page_ids: [PAGE_ID],
  actions: [{ op: 'keep', node_id: PAGE_ID, scope: scope('existing') }],
};

function createPlan(brief: string): TopologyPlan {
  return {
    reviewed_page_ids: [PAGE_ID],
    actions: [
      { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
      {
        op: 'create',
        plan_key: 'new-scope',
        title: `${PROJECT} — New Scope`,
        kind: 'workstream',
        scope: scope('new scope'),
        synthesis_brief: brief,
      },
    ],
  };
}

const refreshPlan = (brief: string): TopologyPlan => ({
  reviewed_page_ids: [PAGE_ID],
  actions: [{ op: 'refresh', node_id: PAGE_ID, scope: scope('existing'), synthesis_brief: brief }],
});

type SequenceEntry =
  | { readonly tool: 'emit_topology_plan'; readonly output: TopologyPlan; readonly usage: TokenUsage }
  | { readonly tool: 'emit_topology_plan'; readonly failure: Error; readonly usage: TokenUsage }
  | {
      readonly tool: 'emit_scope_adjudication';
      readonly relation: 'distinct' | 'substantial-overlap';
      readonly usage: TokenUsage;
    }
  | { readonly tool: 'emit_scope_adjudication'; readonly failure: Error; readonly usage: TokenUsage };

class SequenceLlm implements LlmClient {
  readonly calls: StructuredCallRequest[] = [];
  private cursor = 0;

  constructor(private readonly entries: readonly SequenceEntry[]) {}

  async structuredCall(request: StructuredCallRequest) {
    this.calls.push(request);
    const entry = this.entries[this.cursor];
    this.cursor += 1;
    if (entry === undefined) throw new Error(`Unexpected call ${request.toolName}`);
    if (entry.tool !== request.toolName) {
      throw new Error(`Expected ${entry.tool}, received ${request.toolName}`);
    }
    if ('failure' in entry) {
      if (entry.tool === 'emit_topology_plan') throw entry.failure;
      const failure = entry.failure;
      return {
        get output(): unknown { throw failure; },
        usage: entry.usage,
      };
    }
    if (entry.tool === 'emit_topology_plan') {
      return { output: entry.output, usage: entry.usage };
    }

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
          relation: entry.relation,
          confidence: 0.95,
          evidence_ids: ['evidence-1'],
          reason: entry.relation === 'distinct'
            ? 'The scopes have independent evidence.'
            : 'The scopes still overlap substantially.',
          narrower: 'none',
        })),
      },
      usage: entry.usage,
    };
  }
}

class RootCollisionRepairLlm implements LlmClient {
  readonly calls: StructuredCallRequest[] = [];
  private plannerCalls = 0;

  async structuredCall(request: StructuredCallRequest) {
    this.calls.push(request);
    if (request.toolName === 'emit_topology_plan') {
      this.plannerCalls += 1;
      return {
        output: this.plannerCalls === 1 ? invalidRootCollisionPlan : validKeepPlan,
        usage: usage(this.plannerCalls),
      };
    }
    if (request.toolName !== 'emit_scope_adjudication') {
      throw new Error(`Unexpected call ${request.toolName}`);
    }
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
          ...pair,
          relation: 'distinct' as const,
          confidence: 0.95,
          evidence_ids: ['evidence-1'],
          reason: 'The scopes have independent evidence.',
          narrower: 'none' as const,
        })),
      },
      usage: usage(9),
    };
  }
}

function planningInput(llm: LlmClient) {
  return {
    llm,
    model: 'model',
    maxTokens: 4_096,
    evidence: 'Grounded evidence.',
    existingWiki,
    rootTitle: PROJECT,
  };
}

describe('bounded topology validation repairs', () => {
  it('keeps a page the planner gave no action, without a repair call (#323)', async () => {
    const llm = new SequenceLlm([{ tool: 'emit_topology_plan', output: invalidMissingRolePlan, usage: usage(1) }]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.plan).toEqual(validKeepPlan);
    expect(result.keptByDefault).toEqual([PAGE_ID]);
    expect(result.plannerUsage).toEqual(usage(1));
    expect(result.attempts).toEqual([
      { phase: 'validation', attempt: 0, plan: invalidMissingRolePlan, issues: [expect.objectContaining({ code: 'MISSING_NODE_ROLE', node_id: PAGE_ID })] },
    ]);
    expect(llm.calls).toHaveLength(1);
  });

  it('keeps the pages a merge-only plan left out, as on 11-03, and still applies the merge (#323)', async () => {
    const page = (id: string) => ({ ...existingWiki.subpages[0]!, id, title: `${PROJECT} — ${id}`, wiki_scope: scope(id) });
    const wiki: ExistingWiki = { ...existingWiki, subpages: ['a', 'b', 'c', 'd'].map(page) };
    const merge = { op: 'merge' as const, target: { node_id: 'b' }, sources: ['a'], scope: scope('placeholder'), reason: 'overlap', synthesis_brief: 'Combine.' };
    // Lists every page but acts on two; the other two are also left out of reviewed_page_ids.
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'b'], actions: [merge] };
    const llm = new SequenceLlm([{ tool: 'emit_topology_plan', output: plan, usage: usage(1) }]);

    const result = await planReconciliation({ ...planningInput(llm), existingWiki: wiki });

    expect(result.plan).toEqual({
      reviewed_page_ids: ['a', 'b', 'c', 'd'],
      actions: [merge, { op: 'keep', node_id: 'c', scope: scope('c') }, { op: 'keep', node_id: 'd', scope: scope('d') }],
    });
    expect(result.keptByDefault).toEqual(['c', 'd']);
    expect(llm.calls).toHaveLength(1);
  });

  it('still repairs a plan that also has other faults, or a page with no scope to keep (#323)', async () => {
    const unscoped: ExistingWiki = { ...existingWiki, subpages: [{ ...existingWiki.subpages[0]!, wiki_scope: undefined }] };
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: invalidMissingRolePlan, usage: usage(1) },
      { tool: 'emit_topology_plan', output: validKeepPlan, usage: usage(2) },
    ]);
    const result = await planReconciliation({ ...planningInput(llm), existingWiki: unscoped });
    expect(result.plan).toEqual(validKeepPlan);
    expect(result.keptByDefault).toEqual([]);
    expect(llm.calls).toHaveLength(2);
    const repair = JSON.parse((JSON.parse(llm.calls[1]!.user) as { evidence: string }).evidence) as Record<string, unknown>;
    expect(repair).toMatchObject({ repair_attempt: 1, pages_without_action: [PAGE_ID] });

    // Mixed faults go to repair too; the default applies once only the missing actions remain.
    const mixed = new SequenceLlm([
      { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(1) },
      { tool: 'emit_topology_plan', output: invalidMissingRolePlan, usage: usage(2) },
    ]);
    const mixedResult = await planReconciliation(planningInput(mixed));
    expect(mixedResult.plan).toEqual(validKeepPlan);
    expect(mixedResult.keptByDefault).toEqual([PAGE_ID]);
    expect(mixed.calls).toHaveLength(2);
  });

  it('sends a brief over 2,000 characters back to be shortened, and takes the shorter one (#633)', async () => {
    const shortened = refreshPlan('b'.repeat(1_900));
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: refreshPlan('b'.repeat(2_600)), usage: usage(1) },
      { tool: 'emit_topology_plan', output: shortened, usage: usage(2) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.plan).toEqual(shortened);
    expect(result.longBriefs).toEqual([]);
    const repair = JSON.parse((JSON.parse(llm.calls[1]!.user) as { evidence: string }).evidence) as Record<string, unknown>;
    expect(repair).toMatchObject({ repair_attempt: 1, issues: [{ code: 'SYNTHESIS_BRIEF_TOO_LONG', action_index: 0, node_id: PAGE_ID,
      message: expect.stringContaining('Shorten it to 2000 characters or fewer') }] });
  });

  it('keeps a brief still over the target after one repair, and reports it, rather than failing the build (#633)', async () => {
    const stillLong = refreshPlan('b'.repeat(2_400));
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: refreshPlan('b'.repeat(3_000)), usage: usage(1) },
      { tool: 'emit_topology_plan', output: stillLong, usage: usage(2) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.plan).toEqual(stillLong);
    expect(result.longBriefs).toEqual([{ target: { node_id: PAGE_ID }, chars: 2_400 }]);
    expect(result.plannerUsage).toEqual(usage(3));
    // One repair only: the second plan is kept, not sent back again.
    expect(llm.calls).toHaveLength(2);
    expect(result.attempts.map(attempt => attempt.issues.map(issue => issue.code))).toEqual([['SYNTHESIS_BRIEF_TOO_LONG'], ['SYNTHESIS_BRIEF_TOO_LONG']]);
  });

  it('keeps a too-long brief and a page with no action together once they are all that is left (#633, #323)', async () => {
    const wiki: ExistingWiki = { ...existingWiki, subpages: [existingWiki.subpages[0]!,
      { ...existingWiki.subpages[0]!, id: 'other', title: `${PROJECT} — Other`, wiki_scope: scope('other') }] };
    const partial: TopologyPlan = { reviewed_page_ids: [PAGE_ID, 'other'], actions: refreshPlan('b'.repeat(2_200)).actions };
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: partial, usage: usage(1) },
      { tool: 'emit_topology_plan', output: partial, usage: usage(2) },
    ]);

    const result = await planReconciliation({ ...planningInput(llm), existingWiki: wiki });

    expect(result.plan.actions).toEqual([...partial.actions, { op: 'keep', node_id: 'other', scope: scope('other') }]);
    expect(result.keptByDefault).toEqual(['other']);
    expect(result.longBriefs).toEqual([{ target: { node_id: PAGE_ID }, chars: 2_200 }]);
    expect(llm.calls).toHaveLength(2);
  });

  it('keeps a brief first too long on the last repair rather than failing the build (#633)', async () => {
    const lastPlan = refreshPlan('b'.repeat(2_100));
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(1) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(1) },
      { tool: 'emit_topology_plan', output: lastPlan, usage: usage(1) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.plan).toEqual(lastPlan);
    expect(result.longBriefs).toEqual([{ target: { node_id: PAGE_ID }, chars: 2_100 }]);
    expect(llm.calls).toHaveLength(3);
  });

  it('fails a plan whose brief is still past the 8,000-character hard limit after the repairs (#633)', async () => {
    const tooLong = refreshPlan('b'.repeat(8_001));
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: tooLong, usage: usage(1) },
      { tool: 'emit_topology_plan', output: tooLong, usage: usage(1) },
      { tool: 'emit_topology_plan', output: tooLong, usage: usage(1) },
    ]);

    const error = await planReconciliation(planningInput(llm)).catch(cause => cause);

    expect(error).toBeInstanceOf(PlanningPhaseError);
    expect(error).toMatchObject({ phase: 'validation', issueCodes: ['SYNTHESIS_BRIEF_TOO_LONG'] });
    expect(llm.calls).toHaveLength(3);
  });

  it('repairs a normalized root-title collision before adjudication', async () => {
    const llm = new RootCollisionRepairLlm();

    const result = await planReconciliation(planningInput(llm));

    expect(result.proposedPlan).toEqual(invalidRootCollisionPlan);
    expect(result.plan).toEqual(validKeepPlan);
    expect(result.attempts).toEqual([
      expect.objectContaining({
        phase: 'validation',
        attempt: 0,
        issues: [{
          code: 'ROOT_TITLE_COLLISION',
          message: 'Create title collides with wiki root "Project Atlas".',
          action_index: 1,
          plan_key: 'root-duplicate',
        }],
      }),
      { phase: 'validation', attempt: 1, plan: validKeepPlan, issues: [] },
    ]);
    expect(llm.calls.map(call => call.toolName)).toEqual([
      'emit_topology_plan',
      'emit_topology_plan',
    ]);
  });

  it('repairs titles the Engine would refuse before any page is written (#557)', async () => {
    // A project note titled with parentheses, and a facet with a colon: the Engine refuses both
    // titles, and two new pages may not share one.
    const root = 'Acme (Pilot)';
    const create = (plan_key: string, title: string) => ({
      op: 'create' as const, plan_key, title, kind: 'workstream' as const, scope: scope(plan_key), synthesis_brief: 'Grounded.',
    });
    const badTitles: TopologyPlan = {
      reviewed_page_ids: [PAGE_ID],
      actions: [
        { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
        create('launch', 'Acme (Pilot) — Q3: Launch'),
        create('risks', 'Acme Pilot — Risks'),
        create('risks-again', 'ACME PILOT — RISKS'),
        create('existing-again', `${PROJECT} — Existing`),
      ],
    };
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: badTitles, usage: usage(1) },
      { tool: 'emit_topology_plan', output: validKeepPlan, usage: usage(2) },
    ]);

    const result = await planReconciliation({ ...planningInput(llm), rootTitle: root });

    expect(result.plan).toEqual(validKeepPlan);
    expect(result.attempts[0]!.issues.map(issue => [issue.code, issue.plan_key])).toEqual(expect.arrayContaining([
      ['INVALID_TITLE', 'launch'],
      ['TITLE_COLLISION', 'risks-again'],
      ['TITLE_COLLISION', 'existing-again'],
    ]));
    // Only planner calls: the repair came before any page synthesis.
    expect(llm.calls.map(call => call.toolName)).toEqual(['emit_topology_plan', 'emit_topology_plan']);
    const repair = JSON.parse((JSON.parse(llm.calls[1]!.user) as { evidence: string }).evidence) as Record<string, unknown>;
    expect(repair).toMatchObject({ wiki_root_title: root, page_title_prefix: 'Acme Pilot — ' });
  });

  it('accepts a valid second repair while retaining every plan, issue context, and usage', async () => {
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(1) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(2) },
      { tool: 'emit_topology_plan', output: validKeepPlan, usage: usage(3) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.proposedPlan).toEqual(invalidUnknownPlan);
    expect(result.plan).toEqual(validKeepPlan);
    expect(result.plannerUsage).toEqual(usage(6));
    expect(result.attempts).toEqual([
      expect.objectContaining({
        phase: 'validation',
        attempt: 0,
        plan: invalidUnknownPlan,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'UNKNOWN_REVIEWED_PAGE_ID', node_id: 'unknown' }),
          expect.objectContaining({ code: 'MISSING_REVIEWED_PAGE_ID', node_id: PAGE_ID }),
          expect.objectContaining({ code: 'MISSING_NODE_ROLE', node_id: PAGE_ID }),
        ]),
      }),
      expect.objectContaining({
        phase: 'validation',
        attempt: 1,
        plan: invalidActionPlan,
        issues: [expect.objectContaining({ code: 'UNKNOWN_NODE_ID', node_id: 'unknown' })],
      }),
      { phase: 'validation', attempt: 2, plan: validKeepPlan, issues: [] },
    ]);
  });

  it('fails closed only after the second invalid repair and retains all attempts', async () => {
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(1) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(2) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(3) },
    ]);

    const error = await planReconciliation(planningInput(llm)).catch(cause => cause);

    expect(error).toBeInstanceOf(PlanningPhaseError);
    expect(error).toMatchObject({
      phase: 'validation',
      issueCodes: ['UNKNOWN_NODE_ID'],
      plannerUsage: usage(6),
      adjudicatorUsage: usage(0),
      attempts: [
        expect.objectContaining({ phase: 'validation', attempt: 0, plan: invalidUnknownPlan }),
        expect.objectContaining({ phase: 'validation', attempt: 1, plan: invalidActionPlan }),
        expect.objectContaining({ phase: 'validation', attempt: 2, plan: invalidActionPlan }),
      ],
    });
    expect(llm.calls).toHaveLength(3);
  });

  it('routes an adjudication-requested replacement through the same repair loop before re-adjudicating', async () => {
    const proposedPlan = createPlan('Initial candidate.');
    const repairedPlan = createPlan('Repaired candidate.');
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: proposedPlan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'substantial-overlap', usage: usage(2) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(3) },
      { tool: 'emit_topology_plan', output: repairedPlan, usage: usage(4) },
      { tool: 'emit_scope_adjudication', relation: 'distinct', usage: usage(5) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.proposedPlan).toEqual(proposedPlan);
    expect(result.plan).toEqual(repairedPlan);
    expect(result.plannerUsage).toEqual(usage(8));
    expect(result.adjudicatorUsage).toEqual(usage(7));
    expect(result.attempts).toEqual([
      { phase: 'validation', attempt: 0, plan: proposedPlan, issues: [] },
      expect.objectContaining({
        phase: 'adjudication repair validation',
        attempt: 0,
        plan: invalidActionPlan,
        issues: [expect.objectContaining({ code: 'UNKNOWN_NODE_ID', node_id: 'unknown' })],
      }),
      { phase: 'adjudication repair validation', attempt: 1, plan: repairedPlan, issues: [] },
    ]);
    expect(llm.calls.map(call => call.toolName)).toEqual([
      'emit_topology_plan',
      'emit_scope_adjudication',
      'emit_topology_plan',
      'emit_topology_plan',
      'emit_scope_adjudication',
    ]);
  });

  it('falls back to the reviewed plan without its ambiguous creates when the adjudication repair stays invalid', async () => {
    const proposedPlan = createPlan('Initial candidate.');
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: proposedPlan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'substantial-overlap', usage: usage(2) },
      { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(3) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(4) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(5) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.plan).toEqual(validKeepPlan);
    expect(result.plannerUsage).toEqual(usage(13));
    expect(result.adjudicatorUsage).toEqual(usage(2));
    expect(result.adjudication.results).toEqual([
      expect.objectContaining({ action: 'ambiguous-create-skipped', plan_key: 'new-scope' }),
    ]);
    expect(result.adjudication.warnings).toEqual([
      'Skipped ambiguous create candidates after a failed repair: new-scope.',
    ]);
    expect(result.attempts).toEqual([
      { phase: 'validation', attempt: 0, plan: proposedPlan, issues: [] },
      expect.objectContaining({ phase: 'adjudication repair validation', attempt: 0, plan: invalidUnknownPlan }),
      expect.objectContaining({ phase: 'adjudication repair validation', attempt: 1, plan: invalidActionPlan }),
      expect.objectContaining({ phase: 'adjudication repair validation', attempt: 2, plan: invalidActionPlan }),
    ]);
    expect(llm.calls.map(call => call.toolName)).toEqual([
      'emit_topology_plan',
      'emit_scope_adjudication',
      'emit_topology_plan',
      'emit_topology_plan',
      'emit_topology_plan',
    ]);
  });

  it('shows each repair call the plan it rejected', async () => {
    const proposedPlan = createPlan('Initial candidate.');
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: proposedPlan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'substantial-overlap', usage: usage(2) },
      { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(3) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(4) },
      { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(5) },
    ]);

    await planReconciliation(planningInput(llm));

    const repairInput = (index: number): unknown => {
      const call = llm.calls[index];
      if (call === undefined) throw new Error(`missing call ${index}`);
      return JSON.parse((JSON.parse(call.user) as { evidence: string }).evidence);
    };
    expect(repairInput(2)).toMatchObject({ rejected_plan: proposedPlan });
    expect(repairInput(3)).toMatchObject({ rejected_plan: invalidUnknownPlan });
    expect(repairInput(4)).toMatchObject({ rejected_plan: invalidActionPlan });
  });

  it('retains initial validation attempts when the first adjudicator errors', async () => {
    const proposedPlan = createPlan('Initial candidate.');
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: proposedPlan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', failure: new Error('adjudicator processing failed'), usage: usage(2) },
    ]);

    const error = await planReconciliation(planningInput(llm)).catch(cause => cause);

    expect(error).toBeInstanceOf(PlanningPhaseError);
    expect(error).toMatchObject({
      phase: 'adjudication',
      plannerUsage: usage(1),
      adjudicatorUsage: usage(2),
      attempts: [{ phase: 'validation', attempt: 0, plan: proposedPlan, issues: [] }],
    });
  });

  it('retains initial validation attempts when the adjudication-requested planner call errors', async () => {
    const proposedPlan = createPlan('Initial candidate.');
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: proposedPlan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'substantial-overlap', usage: usage(2) },
      { tool: 'emit_topology_plan', failure: new Error('replacement planner unavailable'), usage: usage(3) },
    ]);

    const error = await planReconciliation(planningInput(llm)).catch(cause => cause);

    expect(error).toBeInstanceOf(PlanningPhaseError);
    expect(error).toMatchObject({
      phase: 'adjudication repair',
      plannerUsage: usage(1),
      adjudicatorUsage: usage(2),
      attempts: [{ phase: 'validation', attempt: 0, plan: proposedPlan, issues: [] }],
    });
  });

  it('falls back to the reviewed plan when the second adjudicator returns unusable output', async () => {
    const proposedPlan = createPlan('Initial candidate.');
    const replacementPlan = createPlan('Replacement candidate.');
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: proposedPlan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'substantial-overlap', usage: usage(2) },
      { tool: 'emit_topology_plan', output: replacementPlan, usage: usage(3) },
      { tool: 'emit_scope_adjudication', failure: new Error('second adjudicator processing failed'), usage: usage(4) },
    ]);

    const result = await planReconciliation(planningInput(llm));

    expect(result.plan).toEqual(validKeepPlan);
    expect(result.plannerUsage).toEqual(usage(4));
    expect(result.adjudicatorUsage).toEqual(usage(6));
    expect(result.attempts).toEqual([
      { phase: 'validation', attempt: 0, plan: proposedPlan, issues: [] },
      { phase: 'adjudication repair validation', attempt: 0, plan: replacementPlan, issues: [] },
    ]);
  });

  it('keeps the reviewed plan\'s safe creates when the re-adjudication degrades', async () => {
    const twoCreates: TopologyPlan = {
      reviewed_page_ids: [PAGE_ID],
      actions: [
        { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
        { op: 'create', plan_key: 'ambiguous', title: `${PROJECT} — Ambiguous`, kind: 'workstream', scope: scope('ambiguous'), synthesis_brief: 'Overlaps the existing page.' },
        { op: 'create', plan_key: 'safe', title: `${PROJECT} — Safe`, kind: 'workstream', scope: scope('safe'), synthesis_brief: 'Independent evidence.' },
      ],
    };
    const repairedPlan = createPlan('Repaired candidate.');
    const calls: string[] = [];
    const llm: LlmClient = {
      async structuredCall(request: StructuredCallRequest) {
        calls.push(request.toolName);
        if (request.toolName === 'emit_topology_plan') {
          return { output: calls.length === 1 ? twoCreates : repairedPlan, usage: usage(1) };
        }
        if (calls.length > 2) throw new Error('re-adjudication unavailable');
        const payload = JSON.parse(request.user) as {
          comparisons: Array<{ pair_id: string; candidate_plan_key: string; compared_to: { node_id: string } | { plan_key: string } }>;
        };
        return {
          output: {
            verdicts: payload.comparisons.map(pair => {
              const overlaps = pair.candidate_plan_key === 'ambiguous' && 'node_id' in pair.compared_to;
              return {
                pair_id: pair.pair_id,
                candidate_plan_key: pair.candidate_plan_key,
                compared_to: pair.compared_to,
                relation: overlaps ? 'substantial-overlap' : 'distinct',
                confidence: 0.95,
                evidence_ids: ['evidence-1'],
                reason: overlaps ? 'The scopes overlap.' : 'The scopes have independent evidence.',
                narrower: 'none',
              };
            }),
          },
          usage: usage(2),
        };
      },
    };

    const result = await planReconciliation(planningInput(llm));

    expect(calls).toEqual(['emit_topology_plan', 'emit_scope_adjudication', 'emit_topology_plan', 'emit_scope_adjudication']);
    expect(result.plan.actions).toEqual([
      { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
      expect.objectContaining({ op: 'create', plan_key: 'safe' }),
    ]);
    expect(result.adjudication.results).toEqual([
      expect.objectContaining({ action: 'ambiguous-create-skipped', plan_key: 'ambiguous' }),
    ]);
    expect(result.attempts).toEqual([
      { phase: 'validation', attempt: 0, plan: twoCreates, issues: [] },
      { phase: 'adjudication repair validation', attempt: 0, plan: repairedPlan, issues: [] },
    ]);
  });

  it('keeps zero usage when the initial planner transport fails before returning a result', async () => {
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', failure: new Error('planner unavailable'), usage: usage(9) },
    ]);

    const error = await planReconciliation(planningInput(llm)).catch(cause => cause);

    expect(error).toMatchObject({
      phase: 'planner',
      plannerUsage: usage(0),
      adjudicatorUsage: usage(0),
    });
  });

  it('keeps the usage a billed planner failure reports', async () => {
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', failure: new StructuredCallFailure('output truncated', usage(7), 'truncated'), usage: usage(0) },
    ]);

    const error = await planReconciliation(planningInput(llm)).catch(cause => cause);

    expect(error).toMatchObject({ phase: 'planner', plannerUsage: usage(7), adjudicatorUsage: usage(0) });
  });
});

import { active } from './requested-page-fixtures.js';
import { requestedExecutionContext, recoverRequestedPage, type RequestExecutionStore } from '../src/requested-page-recovery.js';
import type { PageRequestExecution } from '../src/db/request-execution.js';
import type { Engine } from '../src/engine.js';

const repairKeys = ['planner:0', 'planner:validation:1', 'planner:validation:2', 'adjudicator:0',
  'planner:adjudication:1', 'planner:adjudication:validation:1', 'planner:adjudication:validation:2', 'adjudicator:1'];
it.each(repairKeys)('never redispatches abandoned paid planning stage %s', async crashKey => {
  let state: PageRequestExecution = active();
  const store: RequestExecutionStore = { read: () => structuredClone(state),
    write: (_generation, next) => { state = structuredClone(next); }, clear: () => { throw new Error('unexpected clear'); } };
  const sequence = new SequenceLlm([
    { tool: 'emit_topology_plan', output: invalidUnknownPlan, usage: usage(1) },
    { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(1) },
    { tool: 'emit_topology_plan', output: createPlan('First'), usage: usage(1) },
    { tool: 'emit_scope_adjudication', relation: 'substantial-overlap', usage: usage(1) },
    { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(1) },
    { tool: 'emit_topology_plan', output: invalidActionPlan, usage: usage(1) },
    { tool: 'emit_topology_plan', output: createPlan('Repaired'), usage: usage(1) },
    { tool: 'emit_scope_adjudication', relation: 'distinct', usage: usage(1) },
  ]);
  let dispatches = 0;
  const llm: LlmClient = { structuredCall: async request => {
    const key = repairKeys[dispatches++];
    if (key === crashKey) throw new Error('lost result');
    return sequence.structuredCall(request);
  } };
  const input = { ...planningInput(llm), execution: requestedExecutionContext(store) };
  await expect(planReconciliation(input)).rejects.toThrow();
  const count = dispatches;
  expect('calls' in state && state.calls.map(c => c.key)).toEqual(repairKeys.slice(0, repairKeys.indexOf(crashKey) + 1));
  await expect(planReconciliation(input)).rejects.toThrow('REQUEST_CALL_UNCERTAIN');
  expect(dispatches).toBe(count);
  expect(await recoverRequestedPage({} as Engine, store)).toBe('blocked');
});

describe('automatic page limits', () => {
  it('drops creates beyond the limits before adjudication and reports them', async () => {
    const extra = (key: string, kind: 'workstream' | 'timeline') => ({
      op: 'create' as const, plan_key: key, title: `${PROJECT} — ${key}`, kind, scope: scope(key), synthesis_brief: `Cover ${key}.`,
    });
    const plan: TopologyPlan = { ...createPlan('First.'), actions: [...createPlan('First.').actions, extra('second', 'workstream'), extra('third', 'timeline')] };
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: plan, usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'distinct', usage: usage(2) },
    ]);

    const result = await planReconciliation({ ...planningInput(llm), pageLimits: { maxActivePages: 10, maxActivePerKind: 10, maxCreatesPerRun: 1 } });

    expect(result.plan.actions.filter(action => action.op === 'create').map(action => action.plan_key)).toEqual(['new-scope']);
    expect(result.droppedCreates).toEqual([
      { title: `${PROJECT} — second`, kind: 'workstream', reason: 'creates-per-run' },
      { title: `${PROJECT} — third`, kind: 'timeline', reason: 'creates-per-run' },
    ]);
    const adjudicated = JSON.parse(llm.calls[1]!.user) as { comparisons: Array<{ candidate_plan_key: string }> };
    expect(new Set(adjudicated.comparisons.map(pair => pair.candidate_plan_key))).toEqual(new Set(['new-scope']));
    expect(JSON.parse(llm.calls[0]!.user).page_limits).toEqual({ max_active_pages: 10, max_active_per_kind: 10,
      max_creates_this_run: 1, active_pages_by_kind: { freeform: 1 } });
  });

  it('keeps a create matching an existing page at the cap, so adjudication can refresh that page', async () => {
    const plan: TopologyPlan = { reviewed_page_ids: [PAGE_ID], actions: [
      { op: 'keep', node_id: PAGE_ID, scope: scope('existing') },
      { op: 'create', plan_key: 'same', title: `${PROJECT} — Existing again`, kind: 'freeform', scope: scope('existing'),
        synthesis_brief: 'Refresh the existing page.' },
    ] };
    const llm = new SequenceLlm([{ tool: 'emit_topology_plan', output: plan, usage: usage(1) }]);

    const result = await planReconciliation({ ...planningInput(llm), pageLimits: { maxActivePages: 1, maxActivePerKind: 1, maxCreatesPerRun: 0 } });

    expect(result.droppedCreates).toEqual([]);
    expect(result.plan.actions).toEqual([expect.objectContaining({ op: 'refresh', node_id: PAGE_ID })]);
    expect(llm.calls).toHaveLength(1);
  });

  it('applies no limits and sends none to the planner when none are given', async () => {
    const llm = new SequenceLlm([
      { tool: 'emit_topology_plan', output: createPlan('First.'), usage: usage(1) },
      { tool: 'emit_scope_adjudication', relation: 'distinct', usage: usage(2) },
    ]);
    const result = await planReconciliation(planningInput(llm));
    expect(result.droppedCreates).toEqual([]);
    expect(JSON.parse(llm.calls[0]!.user)).not.toHaveProperty('page_limits');
  });
});
