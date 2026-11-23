import type { RunOutput } from './runner.js';
import type { JudgeVerdict } from './judge.js';
import { normalizedWinner } from './judge.js';
import { addUsage, ZERO_USAGE } from '../pricing.js';
import type { TokenUsage } from '../types.js';

export interface VariantRollup {
  variantId: string;
  profileId: string;
  model: string;
  label: string;
  runs: number;
  usage: TokenUsage;
  /** Sum of priced runs; null when no run in the variant had a priced model. */
  totalCostUsd: number | null;
  /** totalCostUsd / anchor's totalCostUsd; null when either side is unpriced. */
  costVsAnchor: number | null;
  /** Judge record vs the anchor; null for the anchor itself or when nothing was judged. */
  judge: { wins: number; losses: number; ties: number; orderSplits: number } | null;
}

/** Aggregate runs + judgements per variant, in matrix (insertion) order. Pure. */
export function computeRollups(
  runs: RunOutput[],
  judgements: Array<{ aId: string; bId: string; verdict: JudgeVerdict; orderSplit?: boolean }>,
  anchorVariantId: string | null,
): VariantRollup[] {
  const byVariant = new Map<string, RunOutput[]>();
  for (const r of runs) {
    const list = byVariant.get(r.variantId) ?? [];
    list.push(r);
    byVariant.set(r.variantId, list);
  }

  const rollups: VariantRollup[] = [];
  for (const [variantId, vRuns] of byVariant) {
    const first = vRuns[0];
    if (first === undefined) continue;

    let usage = ZERO_USAGE;
    let cost = 0;
    let anyCost = false;
    for (const r of vRuns) {
      usage = addUsage(usage, r.usage);
      if (r.costUsd !== null) {
        anyCost = true;
        cost += r.costUsd;
      }
    }

    let judge: VariantRollup['judge'] = null;
    if (anchorVariantId !== null && variantId !== anchorVariantId) {
      let wins = 0;
      let losses = 0;
      let ties = 0;
      let splitEntries = 0;
      for (const j of judgements) {
        if (j.aId !== variantId && j.bId !== variantId) continue;
        const w = normalizedWinner(j.aId, j.bId, j.verdict);
        if (w === variantId) wins++;
        else if (w === 'tie') ties++;
        else losses++;
        if (j.orderSplit === true) splitEntries++;
      }
      // the split flag rides on both entries of a pair — halve to count pairs
      if (wins + losses + ties > 0) judge = { wins, losses, ties, orderSplits: splitEntries / 2 };
    }

    rollups.push({
      variantId,
      profileId: first.profileId,
      model: first.model,
      label: first.label,
      runs: vRuns.length,
      usage,
      totalCostUsd: anyCost ? cost : null,
      costVsAnchor: null,
      judge,
    });
  }

  const anchor = anchorVariantId !== null ? rollups.find((r) => r.variantId === anchorVariantId) : undefined;
  if (anchor !== undefined && anchor.totalCostUsd !== null && anchor.totalCostUsd > 0) {
    for (const r of rollups) {
      if (r.totalCostUsd !== null) r.costVsAnchor = r.totalCostUsd / anchor.totalCostUsd;
    }
  }
  return rollups;
}
