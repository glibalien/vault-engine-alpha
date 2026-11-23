// packages/engine/tests/search/bench/report.test.ts
import { describe, it, expect } from 'vitest';
import { buildBaseline, formatSummary, formatDiff } from '../../../src/search/bench/report.js';
import type { SuiteResult } from '../../../src/search/bench/runner.js';

function fakeSuite(mrr: number): SuiteResult {
  const ki = { mrr, hitAt1: mrr, hitAt3: 1, hitAt10: 1 };
  const cm = { recallAt5: 0, recallAt10: 0 };
  return {
    results: [],
    worstOffenders: [
      { query: 'Zora Wren', kind: 'known-item', flags: [], expectedIds: ['n1'],
        ranks: { hybrid: 3, fts: 1, semantic: null },
        recall: { hybrid: { at5: 0, at10: 0 }, fts: { at5: 0, at10: 0 }, semantic: { at5: 0, at10: 0 } } },
    ],
    metrics: {
      knownItem: { hybrid: ki, fts: ki, semantic: ki },
      conceptual: { hybrid: cm, fts: cm, semantic: cm },
      conceptualGroups: {
        precision: { hybrid: ki, fts: ki, semantic: ki },
        topical: { hybrid: cm, fts: cm, semantic: cm },
        attachment_noise: { hybrid: ki, fts: ki, semantic: ki },
        field_recall: { hybrid: cm, fts: cm, semantic: cm },
        canonical: { hybrid: ki, fts: ki, semantic: ki },
      },
      counts: { knownItem: 1, conceptual: 0, collisions: 0, precision: 0, topical: 0, attachment_noise: 0, field_recall: 0, canonical: 0 },
    },
  };
}

describe('report', () => {
  it('buildBaseline captures metrics and worst offenders', () => {
    const b = buildBaseline(fakeSuite(0.5), 'snap.db', '2026-06-18T00:00:00Z');
    expect(b.metrics.knownItem.hybrid.mrr).toBe(0.5);
    expect(b.worst[0]).toMatchObject({ query: 'Zora Wren', hybrid: 3, fts: 1 });
  });

  it('formatSummary mentions headline MRR', () => {
    const b = buildBaseline(fakeSuite(0.5), 'snap.db', '2026-06-18T00:00:00Z');
    expect(formatSummary(b)).toMatch(/MRR/);
  });

  it('formatDiff shows the MRR delta sign', () => {
    const before = buildBaseline(fakeSuite(0.5), 'snap.db', 't0');
    const after = buildBaseline(fakeSuite(0.8), 'snap.db', 't1');
    const diff = formatDiff(before, after);
    expect(diff).toMatch(/\+0\.3/);
  });

  it('formatDiff renders precision, topical, attachment-noise, and field-recall group metric lines', () => {
    const before = buildBaseline(fakeSuite(0.5), 'snap.db', 't0');
    const after = buildBaseline(fakeSuite(0.8), 'snap.db', 't1');
    const diff = formatDiff(before, after);
    expect(diff).toMatch(/Precision MRR \(hybrid\)/);
    expect(diff).toMatch(/Topical recall@5 \(hybrid\)/);
    expect(diff).toMatch(/Topical recall@10 \(hybrid\)/);
    expect(diff).toMatch(/Attachment noise MRR \(hybrid\)/);
    expect(diff).toMatch(/Field recall recall@5 \(hybrid\)/);
    expect(diff).toMatch(/Field recall recall@10 \(hybrid\)/);
    expect(diff).toMatch(/Canonical MRR \(hybrid\)/);
    expect(diff).toMatch(/Canonical hit@1 \(hybrid\)/);
  });

  it('formatDiff reports a query only in after.worst as regressed (1 -> 4)', () => {
    const base = buildBaseline(fakeSuite(0.5), 'snap.db', 't0');
    // "new offender" only appears in after's worst list (absent from before = ranked #1)
    const before: import('../../../src/search/bench/report.js').Baseline = {
      ...base,
      worst: [],
    };
    const after: import('../../../src/search/bench/report.js').Baseline = {
      ...base,
      worst: [{ query: 'new offender', flags: [], hybrid: 4, fts: null, semantic: null }],
    };
    const diff = formatDiff(before, after);
    expect(diff).toMatch(/Regressed \(1\)/);
    expect(diff).toMatch(/new offender: 1 -> 4/);
  });

  it('formatDiff reports a query only in before.worst as improved (6 -> 1)', () => {
    const base = buildBaseline(fakeSuite(0.5), 'snap.db', 't0');
    // "old offender" only appears in before's worst list (absent from after = ranked #1)
    const before: import('../../../src/search/bench/report.js').Baseline = {
      ...base,
      worst: [{ query: 'old offender', flags: [], hybrid: 6, fts: null, semantic: null }],
    };
    const after: import('../../../src/search/bench/report.js').Baseline = {
      ...base,
      worst: [],
    };
    const diff = formatDiff(before, after);
    expect(diff).toMatch(/Improved \(1\)/);
    expect(diff).toMatch(/old offender: 6 -> 1/);
  });

  it('formatSummary reports precision, topical, attachment-noise, and field-recall groups', () => {
    const b = buildBaseline(fakeSuite(0.5), 'snap.db', '2026-06-19T00:00:00Z');
    const out = formatSummary(b);
    expect(out).toMatch(/Precision/);
    expect(out).toMatch(/Topical/);
    expect(out).toMatch(/Attachment noise/);
    expect(out).toMatch(/Field recall/);
    expect(out).toMatch(/Canonical/);
  });
});
