import { describe, expect, it } from 'vitest';
import {
  adjudicateCreates,
  buildAdjudicationMatrix,
  rewriteExactCreateMatches,
} from '../src/adjudicate.js';
import { ADJUDICATION_TOOL } from '../src/prompts/adjudicate.js';
import { BudgetExhaustedError } from '../src/budget.js';
import { StructuredCallFailure } from '../src/llm/types.js';
import type {
  TopologyAction,
  TopologyPlan,
} from '../src/types.js';
import {
  create,
  FakeLlm,
  matrixVerdicts,
  page,
  plan,
  request,
  scope,
  wiki,
} from './helpers/topology-fixtures.js';

describe('deterministic exact-match adjudication', () => {
  it('makes no LLM call when the plan contains no creates', async () => {
    // Given: a complete plan with only a keep action.
    const existingWiki = wiki([page('a')]);
    const llm = new FakeLlm({ verdicts: [] });

    // When: create adjudication runs.
    const result = await adjudicateCreates(llm, request(plan(existingWiki, []), existingWiki));

    // Then: adjudication is a pure no-op.
    expect(llm.calls).toHaveLength(0);
    expect(result.status).toBe('approved');
  });

  it.each([
    { state: 'active' as const, expectedOp: 'refresh' as const },
    { state: 'dormant' as const, expectedOp: 'reactivate' as const },
    { state: 'retired' as const, expectedOp: 'reactivate' as const },
  ])('rewrites an exact $state existing match to $expectedOp without a semantic call', async ({ state, expectedOp }) => {
    // Given: comparison-key equality differs only by display casing.
    const existingScope = scope('Delivery');
    const existingWiki = wiki([page('a', { wiki_state: state, wiki_scope: existingScope })]);
    const topologyPlan = plan(existingWiki, [create('new', scope('delivery'))]);
    const llm = new FakeLlm({ verdicts: [] });

    // When: exact comparison runs before semantic adjudication.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: the existing terminal action is explicitly rewritten and recorded.
    expect(llm.calls).toHaveLength(0);
    expect(result.plan.actions.some(action => action.op === expectedOp && action.node_id === 'a')).toBe(true);
    expect(result.verdicts).toContainEqual(expect.objectContaining({ candidate_plan_key: 'new', compared_to: { node_id: 'a' }, relation: 'same-scope' }));
  });

  it('folds exact-matched creates into the stable first plan key', () => {
    // Given: two creates share one comparison key.
    const topologyPlan = plan(wiki(), [create('zeta', scope('same')), create('alpha', scope('SAME'))]);

    // When: deterministic exact rewriting runs.
    const result = rewriteExactCreateMatches(topologyPlan, wiki());

    // Then: alpha survives with both briefs and the fold is recorded.
    const surviving = result.plan.actions.find(action => action.op === 'create');
    expect(surviving).toMatchObject({ op: 'create', plan_key: 'alpha' });
    expect(surviving?.op === 'create' ? surviving.synthesis_brief : '').toContain('Brief zeta.');
    expect(result.verdicts).toContainEqual(expect.objectContaining({ candidate_plan_key: 'zeta', compared_to: { plan_key: 'alpha' } }));
  });

  it('absorbs an exact create into a planned merge target without a semantic call', async () => {
    // Given: a create matches the final scope of an existing-node merge target.
    const existingWiki = wiki([page('source'), page('target')]);
    const candidate = create('new', scope('merged'));
    const merge: TopologyAction = {
      op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: scope('merged'), reason: 'Merge.', synthesis_brief: 'Merge histories.',
    };
    const topologyPlan: TopologyPlan = { reviewed_page_ids: ['source', 'target'], actions: [candidate, merge] };
    const llm = new FakeLlm({ verdicts: [] });

    // When: exact comparison includes same-run merge targets.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: the create is folded into merge synthesis and the rewrite is recorded.
    expect(llm.calls).toHaveLength(0);
    expect(result.plan.actions.some(action => action.op === 'create')).toBe(false);
    expect(result.plan.actions).toContainEqual(expect.objectContaining({ op: 'merge', target: { node_id: 'target' }, synthesis_brief: expect.stringContaining('Brief new.') }));
    expect(result.verdicts).toContainEqual(expect.objectContaining({ candidate_plan_key: 'new', compared_to: { node_id: 'target' }, relation: 'same-scope' }));
  });
});

describe('complete semantic comparison matrix', () => {
  it('compares every non-exact create with all existing states and kinds', () => {
    // Given: active, dormant, and retired pages of unrelated kinds.
    const existingWiki = wiki([
      page('active', { wiki_kind: 'timeline' }),
      page('dormant', { wiki_state: 'dormant', wiki_kind: 'risk-register' }),
      page('retired', { wiki_state: 'retired', wiki_kind: 'stakeholder-map' }),
    ]);

    // When: the pure matrix builder enumerates comparisons.
    const pairs = buildAdjudicationMatrix(plan(existingWiki, [create('new')]), existingWiki);

    // Then: no state or presentation kind was filtered.
    expect(pairs.filter(pair => pair.comparison_kind === 'existing').map(pair => pair.compared_to)).toEqual([
      { node_id: 'active' }, { node_id: 'dormant' }, { node_id: 'retired' },
    ]);
  });

  it('includes each create pair exactly once and every merge target', () => {
    // Given: three creates plus a planned existing merge target.
    const existingWiki = wiki([page('target')]);
    const topologyPlan = plan(existingWiki, [create('a'), create('b'), create('c')], [{
      op: 'merge', target: { node_id: 'target' }, sources: [], scope: scope('merged'), reason: 'Merge.', synthesis_brief: 'Merge.',
    }]);

    // When: all required pair categories are constructed.
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki);

    // Then: C(3,2) create pairs and three merge-target comparisons are unique.
    expect(pairs.filter(pair => pair.comparison_kind === 'create')).toHaveLength(3);
    expect(pairs.filter(pair => pair.comparison_kind === 'merge-target')).toHaveLength(3);
    expect(new Set(pairs.map(pair => pair.pair_id)).size).toBe(pairs.length);
  });

  it('does not cap 100 distinct same-kind candidates', () => {
    // Given: one hundred semantically distinct workstream candidates.
    const creates = Array.from({ length: 100 }, (_, index) => create(`candidate-${index}`));

    // When: the pure matrix is built.
    const pairs = buildAdjudicationMatrix(plan(wiki(), creates), wiki());

    // Then: all C(100,2) comparisons exist and the schema carries no maxItems cap.
    expect(pairs).toHaveLength(4_950);
    expect(JSON.stringify(ADJUDICATION_TOOL.schema)).not.toContain('maxItems');
  });
});

describe('semantic adjudication outcomes', () => {
  it('rejects the whole adjudication matrix when one required verdict is missing', async () => {
    // Given: two required existing comparisons but only one verdict.
    const existingWiki = wiki([page('a'), page('b')]);
    const topologyPlan = plan(existingWiki, [create('new')]);
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki);
    const llm = new FakeLlm({ verdicts: matrixVerdicts(pairs.slice(0, 1), 'distinct') });

    // When: the one batch response is validated.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: all creates are removed and duplicate safety is explicitly degraded.
    expect(result.status).toBe('degraded');
    expect(result.duplicate_safe).toBe(false);
    expect(result.plan.actions.some(action => action.op === 'create')).toBe(false);
  });

  it('keeps the rules marked on the existing page\'s action when a create folds into it (#474 idea 4)', async () => {
    const existingWiki = wiki([page('existing')]);
    const topologyPlan: TopologyPlan = { reviewed_page_ids: ['existing'], actions: [
      { op: 'refresh', node_id: 'existing', scope: scope('existing'), synthesis_brief: 'Refresh.', rule_ids: [5] },
      { ...create('new'), rule_ids: [9] } as TopologyAction,
    ] };
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki);
    const llm = new FakeLlm({ verdicts: matrixVerdicts(pairs, 'same-scope') });
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));
    expect(result.plan.actions).toEqual([expect.objectContaining({ op: 'refresh', node_id: 'existing', rule_ids: [9, 5] })]);
  });

  it('rewrites a non-exact semantic same-scope match to refresh the existing page', async () => {
    // Given: comparison keys differ but the adjudicator finds one semantic scope.
    const existingWiki = wiki([page('existing')]);
    const topologyPlan = plan(existingWiki, [create('new')]);
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki);
    const llm = new FakeLlm({ verdicts: matrixVerdicts(pairs, 'same-scope') });

    // When: the complete semantic batch is applied.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: the create disappears and the prior keep becomes a refresh.
    expect(llm.calls).toHaveLength(1);
    expect(result.plan.actions).toEqual([expect.objectContaining({ op: 'refresh', node_id: 'existing' })]);
  });

  it('applies same-scope candidate folding and distinct survival in one batch', async () => {
    // Given: A and B are semantically the same while C is distinct from both.
    const topologyPlan = plan(wiki(), [create('a'), create('b'), create('c')]);
    const pairs = buildAdjudicationMatrix(topologyPlan, wiki());
    const llm = new FakeLlm({ verdicts: matrixVerdicts(pairs, pair =>
      pair.candidate_plan_key === 'a' && 'plan_key' in pair.compared_to && pair.compared_to.plan_key === 'b'
        ? 'same-scope'
        : 'distinct') });

    // When: the semantic rules are applied.
    const result = await adjudicateCreates(llm, request(topologyPlan, wiki()));

    // Then: stable A absorbs B while independent C remains.
    expect(result.status).toBe('approved');
    expect(result.plan.actions.filter(action => action.op === 'create').map(action => action.plan_key)).toEqual(['a', 'c']);
  });

  it.each([
    { relation: 'substantial-overlap' as const, narrower: 'none' as const, evidenceIds: ['e1'], exclusions: undefined },
    { relation: 'containment' as const, narrower: 'candidate' as const, evidenceIds: [], exclusions: ['narrow facet'] },
    { relation: 'containment' as const, narrower: 'candidate' as const, evidenceIds: ['e1'], exclusions: undefined },
  ])('requests one topology repair for unresolved $relation', async ({ relation, narrower, evidenceIds, exclusions }) => {
    // Given: an overlap or containment that fails an independent safety condition.
    const existingWiki = wiki([page('broad', { wiki_scope: scope('broad', exclusions) })]);
    const topologyPlan = plan(existingWiki, [create('narrow')]);
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki);
    const llm = new FakeLlm({ verdicts: matrixVerdicts(pairs, relation, { evidenceIds, narrower }) });

    // When: first-pass adjudication applies conservative rules.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: the affected candidate and comparisons are exposed for one repair.
    expect(result.status).toBe('repair-required');
    expect(result.affected_plan_keys).toEqual(['narrow']);
    expect(result.affected_comparisons).toEqual(pairs);
  });

  it('allows containment with independent evidence and an explicit complementary exclusion', async () => {
    // Given: the broader existing page excludes the independently evidenced narrow facet.
    const existingWiki = wiki([page('broad', { wiki_scope: scope('broad', ['narrow']) })]);
    const topologyPlan = plan(existingWiki, [create('narrow')]);
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki);
    const llm = new FakeLlm({ verdicts: matrixVerdicts(pairs, 'containment', { evidenceIds: ['narrow-evidence'], narrower: 'candidate' }) });

    // When: containment safeguards are evaluated.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: both complementary pages remain.
    expect(result.status).toBe('approved');
    expect(result.plan.actions.some(action => action.op === 'create' && action.plan_key === 'narrow')).toBe(true);
  });

  it('lets one repair succeed and skips only a still-ambiguous candidate after repair', async () => {
    // Given: a repaired fixture and the affected comparison subset from attempt one.
    const existingWiki = wiki([page('existing')]);
    const topologyPlan = plan(existingWiki, [create('affected'), create('independent')]);
    const affected = ['affected'];
    const pairs = buildAdjudicationMatrix(topologyPlan, existingWiki, affected);
    const distinctLlm = new FakeLlm({ verdicts: matrixVerdicts(pairs, 'distinct') });

    // When: the one allowed post-repair recheck resolves the ambiguity.
    const repaired = await adjudicateCreates(distinctLlm, request(topologyPlan, existingWiki, { repairAttempt: 1, affectedPlanKeys: affected }));

    // Then: the repaired candidate survives without rechecking unrelated pairs.
    expect(repaired.status).toBe('approved');
    expect(distinctLlm.calls).toHaveLength(1);
    expect(repaired.plan.actions.filter(action => action.op === 'create')).toHaveLength(2);

    // Given: the same affected pair remains overlapping on the final recheck.
    const overlapLlm = new FakeLlm({ verdicts: matrixVerdicts(
      pairs,
      pair => pair.comparison_kind === 'existing' ? 'substantial-overlap' : 'distinct',
    ) });

    // When: a second ambiguity is adjudicated.
    const skipped = await adjudicateCreates(overlapLlm, request(topologyPlan, existingWiki, { repairAttempt: 1, affectedPlanKeys: affected }));

    // Then: only the implicated create is skipped with an observable warning.
    expect(skipped.plan.actions.filter(action => action.op === 'create').map(action => action.plan_key)).toEqual(['independent']);
    expect(skipped.results).toContainEqual(expect.objectContaining({ action: 'ambiguous-create-skipped', plan_key: 'affected' }));
    expect(skipped.warnings).toHaveLength(1);
  });

  it('reports pinned merge-source intent transfer without changing the merge', async () => {
    // Given: a valid merge consumes a pinned source and has no create candidates.
    const existingWiki = wiki([page('source', { wiki_pinned: true }), page('target')]);
    const merge: TopologyAction = { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: scope('merged'), reason: 'Merge.', synthesis_brief: 'Merge.' };
    const topologyPlan: TopologyPlan = { reviewed_page_ids: ['source', 'target'], actions: [merge] };
    const llm = new FakeLlm({ verdicts: [] });

    // When: adjudication returns the non-create plan.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: pin transfer is explicit and the merge remains byte-for-byte unchanged.
    expect(result.plan.actions).toEqual([merge]);
    expect(result.pin_transfers).toEqual([{ source_node_id: 'source', target: { node_id: 'target' } }]);
  });

  it('aborts every create when the single LLM call fails', async () => {
    // Given: one create plus an independent keep and a failing adjudication provider.
    const existingWiki = wiki([page('existing')]);
    const topologyPlan = plan(existingWiki, [create('new')]);
    const llm = new FakeLlm(undefined, new Error('provider unavailable'));

    // When: the one structured call rejects.
    const result = await adjudicateCreates(llm, request(topologyPlan, existingWiki));

    // Then: no create can reach page synthesis, while the coherent keep remains.
    expect(llm.calls).toHaveLength(1);
    expect(result.status).toBe('degraded');
    expect(result.plan.actions).toEqual([expect.objectContaining({ op: 'keep', node_id: 'existing' })]);
    expect(result.results).toContainEqual(expect.objectContaining({ action: 'ambiguous-create-skipped', plan_key: 'new' }));
  });

  it('keeps the billed usage of a failed call in the degraded outcome', async () => {
    const existingWiki = wiki([page('existing')]);
    const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 };
    const llm = new FakeLlm(undefined, new StructuredCallFailure('structured call failed (reason=truncated)', usage, 'truncated'));
    const result = await adjudicateCreates(llm, request(plan(existingWiki, [create('new')]), existingWiki));
    expect(result.status).toBe('degraded');
    expect(result.usage).toEqual(usage);
    const unbilled = await adjudicateCreates(new FakeLlm(undefined, new Error('provider unavailable')),
      request(plan(existingWiki, [create('new')]), existingWiki));
    expect(unbilled.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('propagates a daily budget refusal instead of degrading the plan', async () => {
    const existingWiki = wiki([page('existing')]);
    const refusal = new BudgetExhaustedError('daily budget: spent');
    const llm = new FakeLlm(undefined, refusal);
    await expect(adjudicateCreates(llm, request(plan(existingWiki, [create('new')]), existingWiki))).rejects.toBe(refusal);
  });
});
