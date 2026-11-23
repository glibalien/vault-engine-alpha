// packages/engine/src/search/bench/report.ts
import { writeFileSync, readFileSync } from 'node:fs';
import type { SuiteResult, SuiteMetrics } from './runner.js';

export interface Baseline {
  generatedAt: string;
  db: string;
  metrics: SuiteMetrics;
  worst: { query: string; flags: string[]; hybrid: number | null; fts: number | null; semantic: number | null }[];
}

export function buildBaseline(suite: SuiteResult, dbLabel: string, generatedAt: string): Baseline {
  return {
    generatedAt,
    db: dbLabel,
    metrics: suite.metrics,
    worst: suite.worstOffenders.map((r) => ({
      query: r.query,
      flags: r.flags,
      hybrid: r.ranks.hybrid,
      fts: r.ranks.fts,
      semantic: r.ranks.semantic,
    })),
  };
}

export function writeBaseline(path: string, b: Baseline): void {
  writeFileSync(path, JSON.stringify(b, null, 2));
}

export function loadBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

export function formatSummary(b: Baseline): string {
  const ki = b.metrics.knownItem;
  const lines = [
    `Search benchmark — ${b.db} (${b.generatedAt})`,
    `Known-item: ${b.metrics.counts.knownItem} cases (${b.metrics.counts.collisions} collisions)`,
    `  hybrid   MRR ${ki.hybrid.mrr.toFixed(3)}  hit@1 ${pct(ki.hybrid.hitAt1)}  hit@3 ${pct(ki.hybrid.hitAt3)}  hit@10 ${pct(ki.hybrid.hitAt10)}`,
    `  fts      MRR ${ki.fts.mrr.toFixed(3)}  hit@1 ${pct(ki.fts.hitAt1)}  hit@3 ${pct(ki.fts.hitAt3)}  hit@10 ${pct(ki.fts.hitAt10)}`,
    `  semantic MRR ${ki.semantic.mrr.toFixed(3)}  hit@1 ${pct(ki.semantic.hitAt1)}  hit@3 ${pct(ki.semantic.hitAt3)}  hit@10 ${pct(ki.semantic.hitAt10)}`,
    `Conceptual: ${b.metrics.counts.conceptual} cases  hybrid recall@5 ${pct(b.metrics.conceptual.hybrid.recallAt5)}  recall@10 ${pct(b.metrics.conceptual.hybrid.recallAt10)}`,
    `Precision (${b.metrics.counts.precision} cases)  hybrid MRR ${b.metrics.conceptualGroups.precision.hybrid.mrr.toFixed(3)}  hit@1 ${pct(b.metrics.conceptualGroups.precision.hybrid.hitAt1)}  hit@3 ${pct(b.metrics.conceptualGroups.precision.hybrid.hitAt3)}`,
    `Attachment noise (${b.metrics.counts.attachment_noise} cases)  hybrid MRR ${b.metrics.conceptualGroups.attachment_noise.hybrid.mrr.toFixed(3)}  hit@1 ${pct(b.metrics.conceptualGroups.attachment_noise.hybrid.hitAt1)}  hit@3 ${pct(b.metrics.conceptualGroups.attachment_noise.hybrid.hitAt3)}`,
    `Topical (${b.metrics.counts.topical} cases)  hybrid recall@5 ${pct(b.metrics.conceptualGroups.topical.hybrid.recallAt5)}  recall@10 ${pct(b.metrics.conceptualGroups.topical.hybrid.recallAt10)}`,
    `Field recall (${b.metrics.counts.field_recall} cases)  hybrid recall@5 ${pct(b.metrics.conceptualGroups.field_recall.hybrid.recallAt5)}  recall@10 ${pct(b.metrics.conceptualGroups.field_recall.hybrid.recallAt10)}`,
    `Canonical (${b.metrics.counts.canonical} cases)  hybrid MRR ${b.metrics.conceptualGroups.canonical.hybrid.mrr.toFixed(3)}  hit@1 ${pct(b.metrics.conceptualGroups.canonical.hybrid.hitAt1)}  hit@3 ${pct(b.metrics.conceptualGroups.canonical.hybrid.hitAt3)}`,
    `Worst offenders (hybrid rank):`,
    ...b.worst.slice(0, 25).map((w) => `  [h:${w.hybrid ?? 'MISS'} f:${w.fts ?? 'MISS'} s:${w.semantic ?? 'MISS'}] ${w.query}${w.flags.length ? ' (' + w.flags.join(',') + ')' : ''}`),
  ];
  return lines.join('\n');
}

export function formatDiff(before: Baseline, after: Baseline): string {
  const delta = (a: number, b: number): string => {
    const d = b - a;
    return (d >= 0 ? '+' : '') + d.toFixed(3);
  };
  const bk = before.metrics.knownItem;
  const ak = after.metrics.knownItem;
  const beforeWorst = new Map(before.worst.map((w) => [w.query, w.hybrid]));
  const afterWorst = new Map(after.worst.map((w) => [w.query, w.hybrid]));
  // A query absent from a worst-offenders list ranked #1 there (the list only holds rank > 1).
  const GOOD = 1;
  const rankNum = (r: number | null | undefined): number =>
    r === undefined ? GOOD : r === null ? Number.MAX_SAFE_INTEGER : r;
  const label = (r: number | null | undefined): string =>
    r === undefined ? '1' : r === null ? 'MISS' : String(r);
  const improved: string[] = [];
  const regressed: string[] = [];
  for (const q of new Set([...beforeWorst.keys(), ...afterWorst.keys()])) {
    const prev = beforeWorst.get(q);
    const now = afterWorst.get(q);
    const prevR = rankNum(prev);
    const nowR = rankNum(now);
    if (nowR < prevR) improved.push(`  ${q}: ${label(prev)} -> ${label(now)}`);
    else if (nowR > prevR) regressed.push(`  ${q}: ${label(prev)} -> ${label(now)}`);
  }

  return [
    `Benchmark diff (known-item MRR):`,
    `  hybrid   ${bk.hybrid.mrr.toFixed(3)} -> ${ak.hybrid.mrr.toFixed(3)}  (${delta(bk.hybrid.mrr, ak.hybrid.mrr)})`,
    `  fts      ${bk.fts.mrr.toFixed(3)} -> ${ak.fts.mrr.toFixed(3)}  (${delta(bk.fts.mrr, ak.fts.mrr)})`,
    `  semantic ${bk.semantic.mrr.toFixed(3)} -> ${ak.semantic.mrr.toFixed(3)}  (${delta(bk.semantic.mrr, ak.semantic.mrr)})`,
    `  hit@1 hybrid ${pct(bk.hybrid.hitAt1)} -> ${pct(ak.hybrid.hitAt1)}`,
    `Precision MRR (hybrid)  ${before.metrics.conceptualGroups.precision.hybrid.mrr.toFixed(3)} -> ${after.metrics.conceptualGroups.precision.hybrid.mrr.toFixed(3)}  (${delta(before.metrics.conceptualGroups.precision.hybrid.mrr, after.metrics.conceptualGroups.precision.hybrid.mrr)})`,
    `Attachment noise MRR (hybrid)  ${before.metrics.conceptualGroups.attachment_noise.hybrid.mrr.toFixed(3)} -> ${after.metrics.conceptualGroups.attachment_noise.hybrid.mrr.toFixed(3)}  (${delta(before.metrics.conceptualGroups.attachment_noise.hybrid.mrr, after.metrics.conceptualGroups.attachment_noise.hybrid.mrr)})`,
    `Topical recall@5 (hybrid)  ${pct(before.metrics.conceptualGroups.topical.hybrid.recallAt5)} -> ${pct(after.metrics.conceptualGroups.topical.hybrid.recallAt5)}`,
    `Topical recall@10 (hybrid)  ${pct(before.metrics.conceptualGroups.topical.hybrid.recallAt10)} -> ${pct(after.metrics.conceptualGroups.topical.hybrid.recallAt10)}`,
    `Field recall recall@5 (hybrid)  ${pct(before.metrics.conceptualGroups.field_recall.hybrid.recallAt5)} -> ${pct(after.metrics.conceptualGroups.field_recall.hybrid.recallAt5)}`,
    `Field recall recall@10 (hybrid)  ${pct(before.metrics.conceptualGroups.field_recall.hybrid.recallAt10)} -> ${pct(after.metrics.conceptualGroups.field_recall.hybrid.recallAt10)}`,
    `Canonical MRR (hybrid)  ${before.metrics.conceptualGroups.canonical.hybrid.mrr.toFixed(3)} -> ${after.metrics.conceptualGroups.canonical.hybrid.mrr.toFixed(3)}  (${delta(before.metrics.conceptualGroups.canonical.hybrid.mrr, after.metrics.conceptualGroups.canonical.hybrid.mrr)})`,
    `Canonical hit@1 (hybrid)  ${pct(before.metrics.conceptualGroups.canonical.hybrid.hitAt1)} -> ${pct(after.metrics.conceptualGroups.canonical.hybrid.hitAt1)}`,
    `Improved (${improved.length}):`,
    ...improved.slice(0, 25),
    `Regressed (${regressed.length}):`,
    ...regressed.slice(0, 25),
  ].join('\n');
}
