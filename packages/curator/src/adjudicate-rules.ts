import type { AdjudicationMatrixVerdict, AdjudicationPair } from './adjudicate-matrix.js';
import type { WikiScopeV1 } from './types.js';

export function ambiguousPlanKeys(
  pairs: readonly AdjudicationPair[],
  verdicts: readonly AdjudicationMatrixVerdict[],
): readonly string[] {
  const pairById = new Map(pairs.map(pair => [pair.pair_id, pair]));
  const implicated = new Set<string>();
  for (const verdict of verdicts) {
    const pair = pairById.get(verdict.pair_id);
    if (pair === undefined || verdictAccepted(pair, verdict)) continue;
    implicated.add(pair.candidate_plan_key);
    if ('plan_key' in pair.compared_to) implicated.add(pair.compared_to.plan_key);
  }
  return [...implicated].sort(compareCodePoints);
}

export function pairTouchesPlanKeys(
  pair: AdjudicationPair,
  planKeys: readonly string[],
): boolean {
  const keys = new Set(planKeys);
  return keys.has(pair.candidate_plan_key) || ('plan_key' in pair.compared_to && keys.has(pair.compared_to.plan_key));
}

function verdictAccepted(pair: AdjudicationPair, verdict: AdjudicationMatrixVerdict): boolean {
  switch (verdict.relation) {
    case 'same-scope':
    case 'distinct':
      return true;
    case 'substantial-overlap':
      return false;
    case 'containment': {
      const broaderScope = broaderScopeForContainment(pair, verdict.narrower);
      return verdict.evidence_ids.length > 0 && (broaderScope?.exclusions?.length ?? 0) > 0;
    }
    default:
      return assertNever(verdict.relation);
  }
}

function broaderScopeForContainment(
  pair: AdjudicationPair,
  narrower: AdjudicationMatrixVerdict['narrower'],
): WikiScopeV1 | undefined {
  switch (narrower) {
    case 'candidate':
      return pair.compared_scope;
    case 'compared-to':
      return pair.candidate_scope;
    case 'none':
      return undefined;
    default:
      return assertNever(narrower);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected adjudication value: ${String(value)}`);
}
