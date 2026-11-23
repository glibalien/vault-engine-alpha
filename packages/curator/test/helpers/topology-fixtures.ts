import type {
  AdjudicationInput,
  AdjudicationMatrixVerdict,
  AdjudicationPair,
} from '../../src/adjudicate.js';
import type {
  LlmClient,
  StructuredCallRequest,
  StructuredCallResult,
} from '../../src/llm/types.js';
import type {
  ExistingWiki,
  ScopeRelation,
  TopologyAction,
  TopologyPlan,
  WikiCatalogPage,
  WikiScopeV1,
} from '../../src/types.js';

const USAGE = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };

export class FakeLlm implements LlmClient {
  readonly calls: StructuredCallRequest[] = [];

  constructor(private readonly output: unknown, private readonly failure?: Error) {}

  async structuredCall(request: StructuredCallRequest): Promise<StructuredCallResult> {
    this.calls.push(request);
    if (this.failure !== undefined) throw this.failure;
    return { output: this.output, usage: USAGE };
  }
}

export const scope = (facet: string, exclusions?: string[]): WikiScopeV1 => ({
  v: 1,
  subject: 'Project Atlas',
  facet,
  ...(exclusions === undefined ? {} : { exclusions }),
});

export function page(id: string, overrides: Partial<WikiCatalogPage> = {}): WikiCatalogPage {
  return {
    id,
    title: `Page ${id}`,
    file_path: `Wikis/Page ${id}.md`,
    version: 1,
    content_hash: `hash-${id}`,
    wiki_state: 'active',
    wiki_kind: 'workstream',
    wiki_origin: 'automatic',
    wiki_scope: scope(`existing-${id}`),
    wiki_pinned: false,
    ...overrides,
  };
}

export function wiki(subpages: WikiCatalogPage[] = []): ExistingWiki {
  return {
    home_id: 'home',
    home: { id: 'home', version: 1 },
    topology_hash: 'hash',
    catalog_valid: true,
    subpages,
  };
}

export function create(planKey: string, candidateScope = scope(planKey)): TopologyAction {
  return {
    op: 'create',
    plan_key: planKey,
    title: `Candidate ${planKey}`,
    kind: 'workstream',
    scope: candidateScope,
    synthesis_brief: `Brief ${planKey}.`,
  };
}

export function plan(existing: ExistingWiki, creates: TopologyAction[], extra: TopologyAction[] = []): TopologyPlan {
  return {
    reviewed_page_ids: existing.subpages.map(item => item.id),
    actions: [
      ...existing.subpages.map(item => ({ op: 'keep', node_id: item.id, scope: item.wiki_scope ?? scope(item.id) } satisfies TopologyAction)),
      ...creates,
      ...extra,
    ],
  };
}

export function matrixVerdicts(
  pairs: readonly AdjudicationPair[],
  relation: ScopeRelation | ((pair: AdjudicationPair) => ScopeRelation),
  options: { readonly evidenceIds?: readonly string[]; readonly narrower?: 'candidate' | 'compared-to' | 'none' } = {},
): AdjudicationMatrixVerdict[] {
  return pairs.map(pair => ({
    pair_id: pair.pair_id,
    candidate_plan_key: pair.candidate_plan_key,
    compared_to: pair.compared_to,
    relation: typeof relation === 'function' ? relation(pair) : relation,
    confidence: 0.9,
    evidence_ids: [...(options.evidenceIds ?? ['evidence-1'])],
    reason: 'Fixture verdict.',
    narrower: options.narrower ?? 'none',
  }));
}

export function request(
  topologyPlan: TopologyPlan,
  existingWiki: ExistingWiki,
  extra: Pick<AdjudicationInput, 'repairAttempt' | 'affectedPlanKeys'> = {},
): AdjudicationInput {
  return {
    model: 'model',
    plan: topologyPlan,
    existingWiki,
    evidence: 'evidence',
    ...extra,
  };
}
