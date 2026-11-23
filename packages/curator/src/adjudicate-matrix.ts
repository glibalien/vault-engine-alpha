import { ADJUDICATION_RESPONSE_SCHEMA } from './prompts/adjudicate.js';
import type {
  AdjudicationVerdict,
  ExistingWiki,
  NodeRef,
  ThemedPageKind,
  TopologyPlan,
  WikiCatalogPage,
  WikiScopeV1,
} from './types.js';

export type AdjudicationPair = {
  readonly pair_id: string;
  readonly candidate_plan_key: string;
  readonly candidate_title: string;
  readonly candidate_kind: ThemedPageKind;
  readonly candidate_scope: WikiScopeV1;
  readonly candidate_synthesis_brief: string;
  readonly compared_to: NodeRef;
  readonly comparison_kind: 'existing' | 'create' | 'merge-target';
  readonly compared_title: string;
  readonly compared_scope?: WikiScopeV1;
  readonly compared_state?: WikiCatalogPage['wiki_state'];
  readonly compared_kind?: ThemedPageKind;
  readonly compared_summary?: string;
  readonly compared_synthesis_brief?: string;
};

export type AdjudicationMatrixVerdict = AdjudicationVerdict & {
  readonly pair_id: string;
  readonly narrower: 'candidate' | 'compared-to' | 'none';
};

export type AdjudicationMatrixParseResult =
  | { readonly ok: true; readonly verdicts: readonly AdjudicationMatrixVerdict[] }
  | { readonly ok: false; readonly code: 'INVALID_ADJUDICATION_SHAPE' | 'INCOMPLETE_ADJUDICATION_MATRIX' };

type CreateAction = Extract<TopologyPlan['actions'][number], { op: 'create' }>;

export function buildAdjudicationMatrix(
  plan: TopologyPlan,
  existingWiki: ExistingWiki,
  affectedPlanKeys?: readonly string[],
): readonly AdjudicationPair[] {
  const affected = affectedPlanKeys === undefined ? undefined : new Set(affectedPlanKeys);
  const creates = plan.actions
    .filter((action): action is CreateAction => action.op === 'create')
    .sort((left, right) => compareCodePoints(left.plan_key, right.plan_key));
  const createByKey = new Map(creates.map(action => [action.plan_key, action]));
  const pageById = new Map(existingWiki.subpages.map(item => [item.id, item]));
  const pairs: AdjudicationPair[] = [];

  for (const candidate of creates) {
    for (const existing of existingWiki.subpages) {
      if (affected !== undefined && !affected.has(candidate.plan_key)) continue;
      pairs.push(existingPair(candidate, existing));
    }
  }

  for (let leftIndex = 0; leftIndex < creates.length; leftIndex += 1) {
    const left = creates[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < creates.length; rightIndex += 1) {
      const right = creates[rightIndex];
      if (right === undefined) continue;
      if (affected !== undefined && !affected.has(left.plan_key) && !affected.has(right.plan_key)) continue;
      pairs.push(createPair(left, right));
    }
  }

  plan.actions.forEach((action, actionIndex) => {
    if (action.op !== 'merge') return;
    for (const candidate of creates) {
      const targetPlanKey = 'plan_key' in action.target ? action.target.plan_key : undefined;
      if (targetPlanKey === candidate.plan_key) continue;
      if (affected !== undefined && !affected.has(candidate.plan_key) && (targetPlanKey === undefined || !affected.has(targetPlanKey))) continue;
      const targetPage = 'node_id' in action.target ? pageById.get(action.target.node_id) : undefined;
      const targetCreate = targetPlanKey === undefined ? undefined : createByKey.get(targetPlanKey);
      pairs.push({
        ...candidateFields(candidate),
        pair_id: pairId(candidate.plan_key, 'merge-target', `${actionIndex}:${refKey(action.target)}`),
        compared_to: action.target,
        comparison_kind: 'merge-target',
        compared_title: targetPage?.title ?? targetCreate?.title ?? refKey(action.target),
        compared_scope: action.scope,
        ...(targetPage?.wiki_state === undefined ? {} : { compared_state: targetPage.wiki_state }),
        ...(targetPage?.wiki_kind === undefined && targetCreate?.kind === undefined ? {} : { compared_kind: targetPage?.wiki_kind ?? targetCreate?.kind }),
        compared_synthesis_brief: action.synthesis_brief,
      });
    }
  });
  return pairs;
}

export function parseAdjudicationMatrix(
  input: unknown,
  expectedPairs: readonly AdjudicationPair[],
): AdjudicationMatrixParseResult {
  const parsed = ADJUDICATION_RESPONSE_SCHEMA.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_ADJUDICATION_SHAPE' };
  const expected = new Map(expectedPairs.map(pair => [pair.pair_id, pair]));
  const seen = new Set<string>();
  for (const verdict of parsed.data.verdicts) {
    const pair = expected.get(verdict.pair_id);
    if (pair === undefined || seen.has(verdict.pair_id)) return { ok: false, code: 'INCOMPLETE_ADJUDICATION_MATRIX' };
    if (verdict.candidate_plan_key !== pair.candidate_plan_key || refKey(verdict.compared_to) !== refKey(pair.compared_to)) {
      return { ok: false, code: 'INCOMPLETE_ADJUDICATION_MATRIX' };
    }
    seen.add(verdict.pair_id);
  }
  if (seen.size !== expected.size) return { ok: false, code: 'INCOMPLETE_ADJUDICATION_MATRIX' };
  return { ok: true, verdicts: parsed.data.verdicts };
}

function existingPair(candidate: CreateAction, existing: WikiCatalogPage): AdjudicationPair {
  return {
    ...candidateFields(candidate),
    pair_id: pairId(candidate.plan_key, 'existing', existing.id),
    compared_to: { node_id: existing.id },
    comparison_kind: 'existing',
    compared_title: existing.title,
    ...(existing.wiki_scope === undefined ? {} : { compared_scope: existing.wiki_scope }),
    compared_state: existing.wiki_state,
    ...(existing.wiki_kind === undefined ? {} : { compared_kind: existing.wiki_kind }),
    ...(existing.summary === undefined ? {} : { compared_summary: existing.summary }),
  };
}

function createPair(candidate: CreateAction, compared: CreateAction): AdjudicationPair {
  return {
    ...candidateFields(candidate),
    pair_id: pairId(candidate.plan_key, 'create', compared.plan_key),
    compared_to: { plan_key: compared.plan_key },
    comparison_kind: 'create',
    compared_title: compared.title,
    compared_scope: compared.scope,
    compared_kind: compared.kind,
    compared_synthesis_brief: compared.synthesis_brief,
  };
}

function candidateFields(candidate: CreateAction) {
  return {
    candidate_plan_key: candidate.plan_key,
    candidate_title: candidate.title,
    candidate_kind: candidate.kind,
    candidate_scope: candidate.scope,
    candidate_synthesis_brief: candidate.synthesis_brief,
  };
}

function pairId(candidatePlanKey: string, kind: AdjudicationPair['comparison_kind'], target: string): string {
  return `${encodeURIComponent(candidatePlanKey)}|${kind}|${encodeURIComponent(target)}`;
}

function refKey(ref: NodeRef): string {
  return 'node_id' in ref ? `node:${ref.node_id}` : `plan:${ref.plan_key}`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
