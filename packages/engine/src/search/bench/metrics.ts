/** 1-based rank of targetId in an ordered result list, or null if absent. */
export function rankOf(resultIds: string[], targetId: string): number | null {
  const idx = resultIds.indexOf(targetId);
  return idx === -1 ? null : idx + 1;
}

export function reciprocalRank(rank: number | null): number {
  return rank !== null && rank > 0 ? 1 / rank : 0;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function mrr(ranks: (number | null)[]): number {
  return mean(ranks.map(reciprocalRank));
}

/** Fraction of cases whose target rank is within k (1..k). */
export function hitAtK(ranks: (number | null)[], k: number): number {
  if (!ranks.length) return 0;
  const hits = ranks.filter((r) => r !== null && r <= k).length;
  return hits / ranks.length;
}

/** Fraction of expectedIds present in the top k results. */
export function recallAtK(resultIds: string[], expectedIds: string[], k: number): number {
  if (!expectedIds.length) return 0;
  const topK = new Set(resultIds.slice(0, k));
  const found = expectedIds.filter((id) => topK.has(id)).length;
  return found / expectedIds.length;
}
