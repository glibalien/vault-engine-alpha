import { describe, expect, it } from 'vitest';
import {
  buildTopologyRepairPrompt,
  validateTopologyPlan as validateTopologyPlanImpl,
} from '../src/topology-validate.js';
import { MERGE_VS_REFRESH_RULE, TOPOLOGY_SYSTEM_PROMPT } from '../src/prompts/topology.js';
import type {
  ExistingWiki,
  TopologyAction,
  TopologyPlan,
  WikiCatalogPage,
  WikiScopeV1,
} from '../src/types.js';

const SCOPE: WikiScopeV1 = { v: 1, subject: 'Project Atlas', facet: 'delivery' };
const OTHER_SCOPE: WikiScopeV1 = { v: 1, subject: 'Project Atlas', facet: 'risk' };

function catalogPage(
  id: string,
  overrides: Partial<WikiCatalogPage> = {},
): WikiCatalogPage {
  return {
    id,
    title: `Page ${id}`,
    file_path: `Wikis/Page ${id}.md`,
    version: 1,
    content_hash: `hash-${id}`,
    wiki_state: 'active',
    wiki_origin: 'automatic',
    wiki_scope: SCOPE,
    wiki_pinned: false,
    ...overrides,
  };
}

function wiki(subpages: WikiCatalogPage[], catalogValid = true): ExistingWiki {
  return {
    home_id: 'home',
    home: { id: 'home', version: 1 },
    topology_hash: 'topology-hash',
    catalog_valid: catalogValid,
    subpages,
  };
}

function plan(reviewedPageIds: string[], actions: TopologyAction[]): TopologyPlan {
  return { reviewed_page_ids: reviewedPageIds, actions };
}

function validateTopologyPlan(
  topologyPlan: TopologyPlan,
  existingWiki: ExistingWiki,
  rootTitle = 'Project Root',
) {
  return validateTopologyPlanImpl(topologyPlan, existingWiki, rootTitle);
}

function issueCodes(result: ReturnType<typeof validateTopologyPlan>): string[] {
  return result.ok ? [] : result.issues.map(issue => issue.code);
}

describe('topology plan validation', () => {
  it('collects duplicate, unknown, and omitted reviewed page IDs', () => {
    // Given: actions cover the catalog, but the review ledger is not its exact set.
    const existingWiki = wiki([catalogPage('a'), catalogPage('b')]);
    const topologyPlan = plan(
      ['a', 'a', 'unknown'],
      [
        { op: 'keep', node_id: 'a', scope: SCOPE },
        { op: 'keep', node_id: 'b', scope: SCOPE },
      ],
    );

    // When: the parsed plan is checked against the complete catalog.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: every review-set defect is reported in one pass.
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'DUPLICATE_REVIEWED_PAGE_ID',
      'UNKNOWN_REVIEWED_PAGE_ID',
      'MISSING_REVIEWED_PAGE_ID',
    ]));
  });

  it('rejects incompatible terminal roles and missing roles', () => {
    // Given: one page is kept and refreshed while another has no terminal role.
    const existingWiki = wiki([catalogPage('a'), catalogPage('b')]);
    const topologyPlan = plan(
      ['a', 'b'],
      [
        { op: 'keep', node_id: 'a', scope: SCOPE },
        { op: 'refresh', node_id: 'a', scope: SCOPE, synthesis_brief: 'Refresh A.' },
      ],
    );

    // When: role coherence is validated.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: both the conflict and the uncovered page are named.
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'NODE_ROLE_CONFLICT',
      'MISSING_NODE_ROLE',
    ]));
  });

  it.each([
    {
      name: 'merge source reused by keep',
      actions: [
        { op: 'keep', node_id: 'source', scope: SCOPE },
        { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: SCOPE, reason: 'Combine.', synthesis_brief: 'Combine histories.' },
      ] satisfies TopologyAction[],
    },
    {
      name: 'merge target refreshed separately',
      actions: [
        { op: 'refresh', node_id: 'target', scope: SCOPE, synthesis_brief: 'Refresh target.' },
        { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: SCOPE, reason: 'Combine.', synthesis_brief: 'Combine histories.' },
      ] satisfies TopologyAction[],
    },
  ])('rejects $name', ({ actions }) => {
    // Given: both catalog pages otherwise have terminal roles.
    const existingWiki = wiki([catalogPage('source'), catalogPage('target')]);

    // When: merge participation is checked.
    const result = validateTopologyPlan(plan(['source', 'target'], actions), existingWiki);

    // Then: the incompatible reuse is explicit.
    expect(issueCodes(result)).toContain('NODE_ROLE_CONFLICT');
  });

  it('enforces reactivation and pinned-retirement transitions', () => {
    // Given: an active page is reactivated and a pinned page is retired.
    const existingWiki = wiki([
      catalogPage('active'),
      catalogPage('pinned', { wiki_pinned: true }),
    ]);
    const topologyPlan = plan(
      ['active', 'pinned'],
      [
        { op: 'reactivate', node_id: 'active', scope: SCOPE, synthesis_brief: 'Reactivate.' },
        { op: 'retire', node_id: 'pinned', scope: SCOPE, state: 'retired', reason: 'Done.' },
      ],
    );

    // When: state transitions are checked.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: both forbidden transitions are collected.
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'INVALID_REACTIVATION_STATE',
      'PINNED_RETIRE',
    ]));
  });

  it.each(['keep', 'refresh'] as const)('rejects %s for an inactive page', (op) => {
    // Given: a dormant catalog page is assigned an action that would silently upsert it active.
    const existingWiki = wiki([catalogPage('dormant', { wiki_state: 'dormant', wiki_scope: undefined })]);
    const action: TopologyAction = op === 'keep'
      ? { op, node_id: 'dormant', scope: SCOPE }
      : { op, node_id: 'dormant', scope: SCOPE, synthesis_brief: 'Refresh.' };

    // When: the proposed state transition is validated.
    const result = validateTopologyPlan(plan(['dormant'], [action]), existingWiki);

    // Then: the planner must use an explicit reactivate action instead.
    expect(issueCodes(result)).toContain('INVALID_INACTIVE_ACTION_STATE');
  });

  it('allows a pinned merge source because pin intent transfers to its target', () => {
    // Given: a pinned source is consolidated into an existing target.
    const existingWiki = wiki([
      catalogPage('source', { wiki_pinned: true }),
      catalogPage('target'),
    ]);
    const topologyPlan = plan(['source', 'target'], [{
      op: 'merge',
      target: { node_id: 'target' },
      sources: ['source'],
      scope: SCOPE,
      reason: 'Consolidate.',
      synthesis_brief: 'Preserve both histories.',
    }]);

    // When: the merge is validated.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: pinned-source transfer is valid.
    expect(result).toEqual({ ok: true, plan: topologyPlan });
  });

  it('collects invalid scopes, keys, titles, and references', () => {
    // Given: malformed identifiers coexist with unknown source and target references.
    const existingWiki = wiki([catalogPage('a')]);
    const topologyPlan = plan(['a'], [
      { op: 'keep', node_id: 'a', scope: { ...SCOPE, subject: '' } },
      { op: 'create', plan_key: ' ', title: 'Notes', kind: 'workstream', scope: SCOPE, synthesis_brief: 'Reserved.' },
      { op: 'create', plan_key: 'duplicate', title: '', kind: 'timeline', scope: SCOPE, synthesis_brief: 'Blank title.' },
      { op: 'create', plan_key: 'duplicate', title: 'Duplicate', kind: 'timeline', scope: SCOPE, synthesis_brief: 'Duplicate key.' },
      { op: 'merge', target: { plan_key: 'missing' }, sources: ['unknown'], scope: SCOPE, reason: 'Bad refs.', synthesis_brief: 'Bad refs.' },
      { op: 'merge', target: { node_id: 'a' }, sources: [], scope: SCOPE, reason: 'No sources.', synthesis_brief: 'No sources.' },
    ]);

    // When: structural validation runs without failing fast.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: each independently repairable defect is named.
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'INVALID_SCOPE',
      'INVALID_PLAN_KEY',
      'DUPLICATE_PLAN_KEY',
      'INVALID_TITLE',
      'RESERVED_TITLE',
      'UNKNOWN_MERGE_SOURCE',
      'UNKNOWN_MERGE_TARGET',
      'EMPTY_MERGE_SOURCES',
    ]));
  });

  it('rejects a create whose normalized title collides with the wiki root', () => {
    // Given: the planner proposes the project root itself as a themed subpage.
    const existingWiki = wiki([]);
    const topologyPlan = plan([], [{
      op: 'create',
      plan_key: 'root-duplicate',
      title: 'PROJECT CAFE\u0301',
      kind: 'workstream',
      scope: SCOPE,
      synthesis_brief: 'Duplicate the project root.',
    }]);

    // When: curator validates with the canonical root title Engine will use.
    const result = validateTopologyPlan(topologyPlan, existingWiki, 'Project Caf\u00e9');

    // Then: the defect is repairable before page synthesis or Engine preview.
    expect(result).toEqual({
      ok: false,
      issues: [{
        code: 'ROOT_TITLE_COLLISION',
        message: 'Create title collides with wiki root "Project Caf\u00e9".',
        action_index: 0,
        plan_key: 'root-duplicate',
      }],
    });
  });

  it('does not classify a whitespace-invalid title as an Engine root collision', () => {
    // Given: Engine would reject the raw title for whitespace before treating it as the root title.
    const topologyPlan = plan([], [{
      op: 'create',
      plan_key: 'invalid-title',
      title: ' Project Atlas ',
      kind: 'workstream',
      scope: SCOPE,
      synthesis_brief: 'Invalid whitespace.',
    }]);

    const result = validateTopologyPlan(topologyPlan, wiki([]), 'Project Atlas');

    expect(issueCodes(result)).toEqual(['INVALID_TITLE']);
  });

  it('rejects a create title the Engine refuses: a forbidden character, or . or .. (#557)', () => {
    const titles = ['Project Root — Q3: Launch', 'Acme (Pilot) — Risks', 'Project Root — A/B tests', 'Project Root — [draft]', '..'];
    const topologyPlan = plan([], titles.map((title, index) => ({
      op: 'create' as const, plan_key: `p${index}`, title, kind: 'workstream' as const, scope: { ...SCOPE, facet: `f${index}` }, synthesis_brief: 'Grounded.',
    })));

    const result = validateTopologyPlan(topologyPlan, wiki([]));

    expect(issueCodes(result)).toEqual(titles.map(() => 'INVALID_TITLE'));
    expect(result.ok ? '' : result.issues[0]!.message).toContain('( ) [ ] | # ^ / \\ : * ? " < >');
  });

  it('rejects two creates with the same title, compared ignoring case (#557)', () => {
    const topologyPlan = plan([], [
      { op: 'create', plan_key: 'one', title: 'Project Root — Risks', kind: 'workstream', scope: SCOPE, synthesis_brief: 'Grounded.' },
      { op: 'create', plan_key: 'two', title: 'PROJECT ROOT — risks', kind: 'workstream', scope: OTHER_SCOPE, synthesis_brief: 'Grounded.' },
    ]);

    const result = validateTopologyPlan(topologyPlan, wiki([]));

    expect(result).toEqual({
      ok: false,
      issues: [{
        code: 'TITLE_COLLISION',
        message: 'Create title "PROJECT ROOT — risks" is used by another new page in this plan; give each new page its own title.',
        action_index: 1,
        plan_key: 'two',
      }],
    });
  });

  it('rejects a create that takes an existing page\'s title, as the Engine does (#557)', () => {
    const existingWiki = wiki([catalogPage('a', { title: 'Project Root — Delivery', wiki_state: 'retired' })]);
    const topologyPlan = plan(['a'], [
      { op: 'keep', node_id: 'a', scope: SCOPE },
      { op: 'create', plan_key: 'again', title: 'project root — delivery', kind: 'workstream', scope: OTHER_SCOPE, synthesis_brief: 'Grounded.' },
    ]);

    const result = validateTopologyPlan(topologyPlan, existingWiki);

    expect(result.ok ? [] : result.issues).toEqual([{
      code: 'TITLE_COLLISION',
      message: 'Create title "project root — delivery" is the title of existing page "a"; refresh, reactivate or merge that page, or choose another title.',
      action_index: 1,
      plan_key: 'again',
      node_id: 'a',
    }]);
  });

  it('rejects a replacement cycle introduced by the proposed overlay', () => {
    // Given: A already points to B and the plan would point B back to A.
    const existingWiki = wiki([
      catalogPage('a', { wiki_replaced_by: { id: 'b', title: 'Page b' } }),
      catalogPage('b'),
    ]);
    const topologyPlan = plan(['a', 'b'], [{
      op: 'merge',
      target: { node_id: 'a' },
      sources: ['b'],
      scope: SCOPE,
      reason: 'Combine.',
      synthesis_brief: 'Combine.',
    }]);

    // When: current and overlaid replacement cycles are compared.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: the newly introduced cycle is rejected.
    expect(issueCodes(result)).toContain('NEW_REPLACEMENT_CYCLE');
  });

  it('does not report a replacement cycle that already existed before the plan', () => {
    // Given: the current catalog already contains A → B → A and the plan keeps both pages.
    const existingWiki = wiki([
      catalogPage('a', { wiki_replaced_by: { id: 'b', title: 'Page b' } }),
      catalogPage('b', { wiki_replaced_by: { id: 'a', title: 'Page a' } }),
    ]);
    const topologyPlan = plan(['a', 'b'], [
      { op: 'keep', node_id: 'a', scope: SCOPE },
      { op: 'keep', node_id: 'b', scope: SCOPE },
    ]);

    // When: the proposed overlay leaves the current graph unchanged.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: only newly introduced cycles are validator errors.
    expect(issueCodes(result)).not.toContain('NEW_REPLACEMENT_CYCLE');
  });

  it('accepts path-compression acknowledgments whose keep scope matches the final target', () => {
    // Given: ancestor → middle → source, and source will merge into target.
    const existingWiki = compressionCatalog();
    const topologyPlan = compressionPlan(SCOPE);

    // When: the keep actions acknowledge path compression to the merge target.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: implicit compression is not treated as a second mutation.
    expect(result).toEqual({ ok: true, plan: topologyPlan });
  });

  it('keeps inactive path-compression ancestors historical', () => {
    // Given: a retired ancestor acknowledges the final scope without requiring an upsert.
    const existingWiki = wiki([
      catalogPage('ancestor', { wiki_state: 'retired', wiki_replaced_by: { id: 'source', title: 'Source' } }),
      catalogPage('source'),
      catalogPage('target'),
    ]);
    const topologyPlan = plan(['ancestor', 'source', 'target'], [
      { op: 'keep', node_id: 'ancestor', scope: SCOPE },
      { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: SCOPE, reason: 'Consolidate.', synthesis_brief: 'Consolidate.' },
    ]);

    // When: the historical acknowledgment is validated.
    const result = validateTopologyPlan(topologyPlan, existingWiki);

    // Then: it remains valid because the writer leaves the ancestor untouched.
    expect(result).toEqual({ ok: true, plan: topologyPlan });
  });

  it('reports a distinct plan conflict for a mismatched path-compression acknowledgment', () => {
    // Given: the ancestor keep claims a scope different from the final merge target.
    const existingWiki = compressionCatalog();

    // When: the acknowledgment scope is validated.
    const result = validateTopologyPlan(compressionPlan(OTHER_SCOPE), existingWiki);

    // Then: the conflict is distinguishable from ordinary role reuse.
    expect(issueCodes(result)).toContain('PATH_COMPRESSION_PLAN_CONFLICT');
  });

  it('flags every writing action whose brief is over 2,000 characters, and sends the planner back to shorten it (#633)', () => {
    const existingWiki = wiki([catalogPage('a'), catalogPage('b', { wiki_state: 'dormant' }), catalogPage('c'), catalogPage('d')]);
    const long = 'b'.repeat(2_001);
    const rejected = plan(['a', 'b', 'c', 'd'], [
      { op: 'refresh', node_id: 'a', scope: SCOPE, synthesis_brief: long },
      { op: 'reactivate', node_id: 'b', scope: SCOPE, synthesis_brief: long },
      { op: 'create', plan_key: 'new', title: 'Project Root — Risks', kind: 'risk-register', scope: OTHER_SCOPE, synthesis_brief: long },
      { op: 'merge', target: { node_id: 'c' }, sources: ['d'], scope: SCOPE, reason: 'Same coverage.', synthesis_brief: long },
    ]);

    const result = validateTopologyPlan(rejected, existingWiki);
    if (result.ok) throw new Error('Expected too-long briefs');

    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'SYNTHESIS_BRIEF_TOO_LONG', action_index: 0, node_id: 'a' }),
      expect.objectContaining({ code: 'SYNTHESIS_BRIEF_TOO_LONG', action_index: 1, node_id: 'b' }),
      expect.objectContaining({ code: 'SYNTHESIS_BRIEF_TOO_LONG', action_index: 2, plan_key: 'new' }),
      expect.objectContaining({ code: 'SYNTHESIS_BRIEF_TOO_LONG', action_index: 3, node_id: 'c' }),
    ]);
    expect(result.issues[0]!.message).toBe('synthesis_brief is 2001 characters, over the 2000-character limit. '
      + 'Shorten it to 2000 characters or fewer, keeping the coverage it names.');
    const payload = JSON.parse(buildTopologyRepairPrompt(result.issues, rejected, existingWiki, 'evidence', 'Project Atlas')) as Record<string, unknown>;
    expect(payload['issues']).toEqual(result.issues);

    // A brief of exactly the target passes.
    const atTarget = plan(['a'], [{ op: 'refresh', node_id: 'a', scope: SCOPE, synthesis_brief: 'b'.repeat(2_000) }]);
    expect(validateTopologyPlan(atTarget, wiki([catalogPage('a')]))).toEqual({ ok: true, plan: atTarget });
  });

  it('names the pages without an action in the repair payload and numbers the attempt (#323)', () => {
    const existingWiki = wiki([catalogPage('a'), catalogPage('b')]);
    const rejected = plan(['a', 'b'], []);
    const result = validateTopologyPlan(rejected, existingWiki);
    if (result.ok) throw new Error('Expected missing roles');

    const payload = JSON.parse(buildTopologyRepairPrompt(result.issues, rejected, existingWiki, 'evidence', 'Project Atlas', 2)) as Record<string, unknown>;

    expect(payload).toMatchObject({ repair_attempt: 2, pages_without_action: ['a', 'b'] });
    expect(payload['repair_instruction']).toMatch(/Every catalog page needs exactly one action/);
  });

  it('says plainly that updating a page in place is refresh when a plan merged a page into itself (#257)', () => {
    const existingWiki = wiki([catalogPage('a'), catalogPage('b')]);
    // The 10-27 and 11-08 planners merged a page into itself, and into a plan key they never defined.
    const rejected = plan(['a', 'b'], [
      { op: 'merge', target: { node_id: 'a' }, sources: ['a'], scope: SCOPE, reason: 'Update it.', synthesis_brief: 'Update it.' },
      { op: 'merge', target: { plan_key: 'refresh-b' }, sources: ['b'], scope: OTHER_SCOPE, reason: 'Update it.', synthesis_brief: 'Update it.' },
    ]);
    const result = validateTopologyPlan(rejected, existingWiki);
    if (result.ok) throw new Error('Expected merge misuse');
    expect(issueCodes(result)).toEqual(expect.arrayContaining(['SOURCE_TARGET_CONFLICT', 'UNKNOWN_MERGE_TARGET']));

    const payload = JSON.parse(buildTopologyRepairPrompt(result.issues, rejected, existingWiki, 'evidence', 'Project Atlas')) as Record<string, unknown>;

    expect(payload['merge_instruction']).toBe(MERGE_VS_REFRESH_RULE);
    expect(MERGE_VS_REFRESH_RULE).toMatch(/refresh it by its node_id; never merge a page into itself/);
    expect(TOPOLOGY_SYSTEM_PROMPT).toContain(MERGE_VS_REFRESH_RULE);
  });

  it('adds no merge instruction when no merge went wrong', () => {
    const existingWiki = wiki([catalogPage('a')]);
    const rejected = plan(['a'], []);
    const result = validateTopologyPlan(rejected, existingWiki);
    if (result.ok) throw new Error('Expected a missing role');
    const payload = JSON.parse(buildTopologyRepairPrompt(result.issues, rejected, existingWiki, 'evidence', 'Project Atlas')) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('merge_instruction');
  });

  it('fails fast on an invalid catalog and builds a structured one-attempt repair payload', () => {
    // Given: the engine marks the catalog invalid and the planner output is also incomplete.
    const existingWiki = wiki([catalogPage('a')], false);
    const result = validateTopologyPlan(plan([], []), existingWiki);
    if (result.ok) throw new Error('Expected invalid catalog validation failure');

    // When: orchestration prepares the only permitted planner repair call.
    const rejected = plan([], []);
    const payload: unknown = JSON.parse(buildTopologyRepairPrompt(result.issues, rejected, existingWiki, 'evidence', 'Project Atlas'));

    // Then: catalog failure is the sole issue, and the rejected plan and original inputs accompany attempt one.
    expect(result.issues.map(issue => issue.code)).toEqual(['INVALID_CATALOG']);
    expect(payload).toEqual({
      repair_attempt: 1,
      issues: result.issues,
      rejected_plan: rejected,
      wiki_root_title: 'Project Atlas',
      page_title_prefix: 'Project Atlas — ',
      evidence: 'evidence',
      existing_wiki: existingWiki,
    });
  });
});

function compressionCatalog(): ExistingWiki {
  return wiki([
    catalogPage('ancestor', { wiki_replaced_by: { id: 'middle', title: 'Middle' } }),
    catalogPage('middle', { wiki_replaced_by: { id: 'source', title: 'Source' } }),
    catalogPage('source'),
    catalogPage('target'),
  ]);
}

function compressionPlan(ancestorScope: WikiScopeV1): TopologyPlan {
  return plan(['ancestor', 'middle', 'source', 'target'], [
    { op: 'keep', node_id: 'ancestor', scope: ancestorScope },
    { op: 'keep', node_id: 'middle', scope: SCOPE },
    {
      op: 'merge',
      target: { node_id: 'target' },
      sources: ['source'],
      scope: SCOPE,
      reason: 'Consolidate.',
      synthesis_brief: 'Consolidate histories.',
    },
  ]);
}
