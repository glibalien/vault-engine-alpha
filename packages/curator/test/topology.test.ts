import { describe, expect, it } from 'vitest';
import { pageKindDescriptions } from '../src/page-templates.js';
import {
  parseTopologyPlan,
  parseWikiScope,
  sameWikiScope,
  serializeWikiScope,
  wikiScopeComparisonKey,
} from '../src/topology.js';
import {
  buildTopologyPromptPayload,
  buildTopologyPlanTool,
  TOPOLOGY_PLAN_TOOL,
  TOPOLOGY_SYSTEM_PROMPT,
} from '../src/prompts/topology.js';
import type {
  ExistingWiki,
  TopologyPlanUsage,
  WikiCatalogPage,
  WikiScopeV1,
} from '../src/types.js';

const SCOPE: WikiScopeV1 = {
  v: 1,
  subject: 'Orbital Builder Redux',
  facet: 'ceasefire negotiations',
};

function plannerSchemaForAction(schema: Record<string, unknown>, op: string): Record<string, unknown> {
  const actions = schema['properties'] as Record<string, unknown>;
  const actionItems = actions['actions'] as Record<string, unknown>;
  const variants = actionItems['items'] as Record<string, unknown>;
  const action = (variants['oneOf'] as unknown[]).find((candidate) => {
    const properties = (candidate as Record<string, unknown>)['properties'] as Record<string, unknown>;
    return ((properties['op'] as Record<string, unknown>)['const'] === op);
  });
  if (!action) throw new Error(`Expected ${op} action schema`);
  return action as Record<string, unknown>;
}

function catalog(ids: readonly string[]): ExistingWiki {
  return {
    home_id: 'home-1',
    home: { id: 'home-1', version: 1 },
    topology_hash: 'topology-hash',
    catalog_valid: true,
    subpages: ids.map((id, index) => ({
      id,
      title: `Page ${index + 1}`,
      file_path: `Wikis/Page ${index + 1}.md`,
      version: 1,
      content_hash: `hash-${index + 1}`,
      wiki_state: 'active',
      wiki_origin: 'automatic',
      wiki_pinned: false,
    })),
  };
}

describe('topology plan parsing', () => {
  it('parses all six topology action variants', () => {
    // Given: one structurally valid action for every planner operation.
    const input = {
      reviewed_page_ids: ['keep-1', 'refresh-1', 'reactivate-1', 'merge-source', 'retire-1'],
      actions: [
        { op: 'keep', node_id: 'keep-1', scope: SCOPE },
        { op: 'refresh', node_id: 'refresh-1', scope: SCOPE, synthesis_brief: 'Update current negotiations.' },
        { op: 'reactivate', node_id: 'reactivate-1', scope: SCOPE, synthesis_brief: 'Resume this thread.' },
        { op: 'create', plan_key: 'energy', title: 'Energy effects', kind: 'timeline', scope: SCOPE, synthesis_brief: 'Track market effects.' },
        { op: 'merge', target: { plan_key: 'energy' }, sources: ['merge-source'], scope: SCOPE, reason: 'The scopes overlap.', synthesis_brief: 'Consolidate both histories.' },
        { op: 'retire', node_id: 'retire-1', scope: SCOPE, state: 'dormant', reason: 'No current evidence.' },
      ],
    };

    // When: the model output crosses the topology parser boundary.
    const result = parseTopologyPlan(input);

    // Then: no valid action is dropped or rewritten.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected a valid topology plan');
    expect(result.plan.actions.map(action => action.op)).toEqual([
      'keep', 'refresh', 'reactivate', 'create', 'merge', 'retire',
    ]);
  });

  it('fails the whole plan when one action is malformed', () => {
    // Given: a valid keep followed by a refresh missing its synthesis brief.
    const input = {
      reviewed_page_ids: ['keep-1', 'refresh-1'],
      actions: [
        { op: 'keep', node_id: 'keep-1', scope: SCOPE },
        { op: 'refresh', node_id: 'refresh-1', scope: SCOPE },
      ],
    };

    // When: the complete plan is parsed.
    const result = parseTopologyPlan(input);

    // Then: the malformed action invalidates the plan instead of disappearing.
    expect(result).toEqual({ ok: false, code: 'INVALID_PLAN_SHAPE' });
  });

  it.each(['delete', 'archive'])('rejects the unrecognized "%s" operation', (op) => {
    // Given: a model-emitted operation outside the locked union.
    const input = {
      reviewed_page_ids: ['page-1'],
      actions: [{ op, node_id: 'page-1', scope: SCOPE, reason: 'Remove it.' }],
    };

    // When: the plan is parsed.
    const result = parseTopologyPlan(input);

    // Then: delete-like and unknown operations are hard failures.
    expect(result).toEqual({ ok: false, code: 'INVALID_PLAN_SHAPE' });
  });

  it('bounds diagnostics and exposes them only in debug mode', () => {
    // Given: malformed model output with an oversized value.
    const input = { reviewed_page_ids: [], actions: [{ op: 'delete', reason: 'x'.repeat(10_000) }] };

    // When: normal and explicit-debug parses are requested.
    const normal = parseTopologyPlan(input);
    const debug = parseTopologyPlan(input, { debug: true });

    // Then: production output is clean while debug diagnostics remain bounded.
    expect(normal).toEqual({ ok: false, code: 'INVALID_PLAN_SHAPE' });
    expect(debug).toMatchObject({ ok: false, code: 'INVALID_PLAN_SHAPE' });
    expect(debug.ok ? undefined : debug.debug?.diagnostic.length).toBeLessThanOrEqual(1_000);
  });
});

describe('topology planner schema and payload', () => {
  it('closes every existing-node reference over the supplied catalog IDs', () => {
    // Given: a catalog with precisely two stable page IDs.
    const ids = ['page-a', 'page-b'];
    const schema = buildTopologyPlanTool(catalog(ids)).schema;
    const reviewed = ((schema['properties'] as Record<string, unknown>)['reviewed_page_ids'] as Record<string, unknown>);
    const merge = plannerSchemaForAction(schema, 'merge');

    // When: all provider-visible existing-node references are inspected.
    const keep = plannerSchemaForAction(schema, 'keep');
    const refresh = plannerSchemaForAction(schema, 'refresh');
    const reactivate = plannerSchemaForAction(schema, 'reactivate');
    const retire = plannerSchemaForAction(schema, 'retire');
    const mergeProperties = merge['properties'] as Record<string, unknown>;
    const target = mergeProperties['target'] as Record<string, unknown>;
    const existingTarget = (target['anyOf'] as Record<string, unknown>[]).find((candidate) =>
      'node_id' in (candidate['properties'] as Record<string, unknown>),
    );

    // Then: constrained decoding can name only catalog nodes in every such field.
    expect((reviewed['items'] as Record<string, unknown>)['enum']).toEqual(ids);
    for (const action of [keep, refresh, reactivate, retire]) {
      const properties = action['properties'] as Record<string, unknown>;
      expect((properties['node_id'] as Record<string, unknown>)['enum']).toEqual(ids);
    }
    expect(((mergeProperties['sources'] as Record<string, unknown>)['items'] as Record<string, unknown>)['enum']).toEqual(ids);
    expect((((existingTarget?.['properties'] as Record<string, unknown>)['node_id'] as Record<string, unknown>)['enum'])).toEqual(ids);
  });

  it('allows only creates and zero reviewed IDs for an empty catalog', () => {
    // Given: an initial wiki with no existing catalog rows.
    const schema = buildTopologyPlanTool(catalog([])).schema;
    const properties = schema['properties'] as Record<string, unknown>;
    const reviewed = properties['reviewed_page_ids'] as Record<string, unknown>;
    const actions = properties['actions'] as Record<string, unknown>;
    const variants = ((actions['items'] as Record<string, unknown>)['oneOf'] as Record<string, unknown>[]);

    // When: provider-visible topology alternatives are examined.
    const operations = variants.map((action) => {
      const actionProperties = action['properties'] as Record<string, unknown>;
      return (actionProperties['op'] as Record<string, unknown>)['const'];
    });

    // Then: there is no existing node to review or mutate.
    expect(reviewed).toEqual({ type: 'array', maxItems: 0 });
    expect(operations).toEqual(['create']);
  });

  it('renders every row of a 101-page catalog in structured JSON', () => {
    // Given: a complete engine-shaped catalog larger than the old boundary cases.
    const subpages: WikiCatalogPage[] = Array.from({ length: 101 }, (_, index) => ({
      id: `page-${index}`,
      title: `Page ${index}`,
      file_path: `Wikis/Page ${index}.md`,
      version: index + 1,
      content_hash: `hash-${index}`,
      wiki_state: 'active',
      wiki_origin: 'automatic',
      wiki_pinned: false,
    }));
    const existingWiki: ExistingWiki = {
      home_id: 'home-1',
      home: { id: 'home-1', version: 7 },
      topology_hash: 'topology-hash',
      catalog_valid: true,
      subpages,
    };

    // When: planner input is serialized.
    const payload: unknown = JSON.parse(buildTopologyPromptPayload('grounded evidence', existingWiki, 'Project Atlas'));

    // Then: the machine payload names the protected root and contains the full catalog without selection or truncation.
    expect(payload).toEqual({
      wiki_root_title: 'Project Atlas',
      page_title_prefix: 'Project Atlas — ',
      evidence: 'grounded evidence',
      existing_wiki: existingWiki,
      page_kinds: pageKindDescriptions(),
    });
  });

  it('has strict objects and no array-count cap', () => {
    // Given: the provider-facing JSON Schema generated from the Zod contract.
    const schemaText = JSON.stringify(TOPOLOGY_PLAN_TOOL.schema);

    // When: its structural constraints are inspected.
    const strictObjectCount = schemaText.match(/"additionalProperties":false/g)?.length ?? 0;

    // Then: objects are closed and no catalog/action/same-kind count is capped.
    expect(strictObjectCount).toBeGreaterThanOrEqual(10);
    expect(schemaText).not.toContain('"maxItems"');
  });

  it('parses 101 distinct same-kind create actions without a count cap', () => {
    // Given: many semantically distinct workstream candidates.
    const actions = Array.from({ length: 101 }, (_, index) => ({
      op: 'create',
      plan_key: `candidate-${index}`,
      title: `Candidate ${index}`,
      kind: 'workstream',
      scope: { ...SCOPE, facet: `facet ${index}` },
      synthesis_brief: `Synthesize facet ${index}.`,
    }));

    // When: the complete plan is parsed.
    const result = parseTopologyPlan({ reviewed_page_ids: [], actions });

    // Then: multiplicity of one presentation kind is not a correctness limit.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected an uncapped topology plan');
    expect(result.plan.actions).toHaveLength(101);
  });
});

describe('curator-local scope canonicalization', () => {
  it('matches the engine whitespace and array-order golden bytes', () => {
    // Given: the exact logical input from the engine Task 1 golden fixture.
    const result = parseWikiScope({
      v: 1,
      subject: '  Orbital Builder\t\nRedux  ',
      facet: '  energy   market\n effects ',
      timeframe: '  2026   Q1 ',
      entities: [' Iran ', '', 'United   States', 'iran', ' Gulf\tStates '],
      exclusions: ['  Europe ', 'Asia', ' europe ', ''],
    });

    // When: the curator serializes its canonical scope.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected a valid scope');

    // Then: its bytes match the literal engine fixture exactly.
    expect(serializeWikiScope(result.scope)).toBe(
      '{"v":1,"subject":"Orbital Builder Redux","facet":"energy market effects","timeframe":"2026 Q1","entities":["Gulf States","Iran","United States"],"exclusions":["Asia","Europe"]}',
    );
  });

  it('matches the engine optional-empty golden bytes', () => {
    // Given: optional values that normalize away in the engine fixture.
    const result = parseWikiScope({
      v: 1,
      subject: 'Orbital Builder Redux',
      facet: 'energy market effects',
      timeframe: '  ',
      geography: '',
      entities: ['\t'],
      exclusions: ['  '],
    });

    // When: the curator serializes its canonical scope.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected a valid scope');

    // Then: no empty optional property appears in the exact stored bytes.
    expect(serializeWikiScope(result.scope)).toBe('{"v":1,"subject":"Orbital Builder Redux","facet":"energy market effects"}');
  });

  it('preserves display bytes while comparison and equality ignore casing', () => {
    // Given: display-cased and lowercase forms of the same scope.
    const display: WikiScopeV1 = { ...SCOPE, entities: ['Iran', 'UNITED STATES'] };
    const lowercase: WikiScopeV1 = {
      v: 1,
      subject: 'orbital builder redux',
      facet: 'ceasefire negotiations',
      entities: ['united states', 'iran'],
    };

    // When: storage and comparison representations are produced.
    const stored = serializeWikiScope(display);
    const displayKey = wikiScopeComparisonKey(display);

    // Then: storage preserves display spelling but semantic equality does not depend on it.
    expect(stored).toContain('"UNITED STATES"');
    expect(displayKey).toBe(wikiScopeComparisonKey(lowercase));
    expect(sameWikiScope(display, lowercase)).toBe(true);
  });
});

describe('topology usage attribution', () => {
  it('keeps planner, adjudicator, page, and home usage separate', () => {
    // Given: independently identifiable usage from each call stage.
    const usage: TopologyPlanUsage = {
      planner: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
      adjudicator: { input: 5, output: 6, cacheWrite: 7, cacheRead: 8 },
      page: { input: 9, output: 10, cacheWrite: 11, cacheRead: 12 },
      home: { input: 13, output: 14, cacheWrite: 15, cacheRead: 16 },
    };

    // When: stage usage is reported.
    const stageInputs = Object.values(usage).map(stage => stage.input);

    // Then: no stage is folded into another stage's token bucket.
    expect(Object.keys(usage)).toEqual(['planner', 'adjudicator', 'page', 'home']);
    expect(stageInputs).toEqual([1, 5, 9, 13]);
  });
});

describe('topology planner prompt', () => {
  it('asks for new page titles prefixed with the wiki root title', () => {
    expect(TOPOLOGY_SYSTEM_PROMPT).toContain('Title each new page "<page_title_prefix><facet>"');
    expect(TOPOLOGY_SYSTEM_PROMPT).toContain('page_title_prefix is the root title and an em dash between spaces');
  });

  it('lists the characters a page title can\'t contain, and asks for titles no catalog page has (#557)', () => {
    expect(TOPOLOGY_SYSTEM_PROMPT).toContain('A page title can\'t contain any of ( ) [ ] | # ^ / \\ : * ? " < >, and can\'t be "." or "..".');
    expect(TOPOLOGY_SYSTEM_PROMPT).toContain('different from every catalog page\'s title, ignoring case');
  });

  it('states the brief length the plan validator holds briefs to (#633)', () => {
    expect(TOPOLOGY_SYSTEM_PROMPT).toContain('Keep each synthesis_brief to 2,000 characters or fewer; a longer brief is sent back to be shortened.');
  });

  it('gives a root title with forbidden characters a safe page title prefix (#557)', () => {
    const existingWiki: ExistingWiki = { home_id: 'home-1', home: { id: 'home-1', version: 1 }, topology_hash: 'h', catalog_valid: true, subpages: [] };
    const payload = JSON.parse(buildTopologyPromptPayload('evidence', existingWiki, 'Acme (Pilot)')) as { wiki_root_title: string; page_title_prefix: string };
    expect(payload.wiki_root_title).toBe('Acme (Pilot)');
    expect(payload.page_title_prefix).toBe('Acme Pilot — ');
  });
});
