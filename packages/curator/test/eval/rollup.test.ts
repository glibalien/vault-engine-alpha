import { describe, it, expect } from 'vitest';
import { computeRollups } from '../../src/eval/rollup.js';
import type { RunOutput } from '../../src/eval/runner.js';
import type { JudgeVerdict } from '../../src/eval/judge.js';

function makeRun(overrides: Partial<RunOutput> & Pick<RunOutput, 'variantId' | 'project'>): RunOutput {
  return {
    profileId: 'baseline',
    model: 'anchor-model',
    label: 'anchor',
    sections: { now: 'N', focus: 'F', open_threads: 'O', log_entry: 'L' },
    themedPages: [],
    usage: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 },
    costUsd: 0.1,
    evidenceChars: 1000,
    ...overrides,
  };
}

function verdict(overall: 'A' | 'B' | 'tie'): JudgeVerdict {
  const c = { winner: 'tie' as const, note: '' };
  return {
    overall,
    criteria: { succinct: c, scannable: c, standup_ready: c, grounded: c, not_stale: c },
  };
}

const ANCHOR = 'baseline @ anchor';
const CAND = 'baseline @ cand';

describe('computeRollups', () => {
  it('sums usage and cost per variant across projects, preserving matrix order', () => {
    const runs = [
      makeRun({ variantId: ANCHOR, project: 'P1', costUsd: 0.1 }),
      makeRun({ variantId: CAND, project: 'P1', model: 'cand-model', label: 'cand', costUsd: 0.02 }),
      makeRun({ variantId: ANCHOR, project: 'P2', costUsd: 0.3 }),
      makeRun({ variantId: CAND, project: 'P2', model: 'cand-model', label: 'cand', costUsd: 0.06 }),
    ];

    const rollups = computeRollups(runs, [], ANCHOR);

    expect(rollups.map((r) => r.variantId)).toEqual([ANCHOR, CAND]);
    expect(rollups[0]?.runs).toBe(2);
    expect(rollups[0]?.usage).toEqual({ input: 200, output: 100, cacheWrite: 0, cacheRead: 0 });
    expect(rollups[0]?.totalCostUsd).toBeCloseTo(0.4, 10);
    expect(rollups[1]?.totalCostUsd).toBeCloseTo(0.08, 10);
  });

  it('computes costVsAnchor as a ratio (anchor = 1)', () => {
    const runs = [
      makeRun({ variantId: ANCHOR, project: 'P1', costUsd: 0.4 }),
      makeRun({ variantId: CAND, project: 'P1', model: 'cand-model', label: 'cand', costUsd: 0.1 }),
    ];

    const rollups = computeRollups(runs, [], ANCHOR);

    expect(rollups[0]?.costVsAnchor).toBeCloseTo(1, 10);
    expect(rollups[1]?.costVsAnchor).toBeCloseTo(0.25, 10);
  });

  it('leaves costVsAnchor null when the anchor has no priced cost', () => {
    const runs = [
      makeRun({ variantId: ANCHOR, project: 'P1', costUsd: null }),
      makeRun({ variantId: CAND, project: 'P1', costUsd: 0.1 }),
    ];

    const rollups = computeRollups(runs, [], ANCHOR);

    expect(rollups[0]?.totalCostUsd).toBeNull();
    expect(rollups[1]?.costVsAnchor).toBeNull();
  });

  it('tallies judge wins/losses/ties and order-splits for the candidate; anchor judge is null', () => {
    const runs = [
      makeRun({ variantId: ANCHOR, project: 'P1' }),
      makeRun({ variantId: CAND, project: 'P1' }),
      makeRun({ variantId: ANCHOR, project: 'P2' }),
      makeRun({ variantId: CAND, project: 'P2' }),
    ];
    // P1: candidate wins both passes (no split). P2: split pair (one win each).
    const judgements = [
      { aId: ANCHOR, bId: CAND, verdict: verdict('B'), orderSplit: false },
      { aId: CAND, bId: ANCHOR, verdict: verdict('A'), orderSplit: false },
      { aId: ANCHOR, bId: CAND, verdict: verdict('A'), orderSplit: true },
      { aId: CAND, bId: ANCHOR, verdict: verdict('A'), orderSplit: true },
    ];

    const rollups = computeRollups(runs, judgements, ANCHOR);

    expect(rollups[0]?.judge).toBeNull();
    expect(rollups[1]?.judge).toEqual({ wins: 3, losses: 1, ties: 0, orderSplits: 1 });
  });

  it('returns judge: null everywhere when anchorVariantId is null', () => {
    const runs = [makeRun({ variantId: 'baseline', project: 'P1' })];

    const rollups = computeRollups(runs, [], null);

    expect(rollups[0]?.judge).toBeNull();
    expect(rollups[0]?.costVsAnchor).toBeNull();
  });
});
