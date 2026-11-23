// packages/engine/src/search/bench/runner.ts
import type Database from 'better-sqlite3';
import type { Embedder } from '../embedder.js';
import { hybridSearch } from '../search.js';
import type { ConceptualGroup, GoldenCase } from './golden.js';
import { rankOf, mrr, hitAtK, recallAtK, mean } from './metrics.js';

export interface ModeRanks {
  hybrid: number | null;
  fts: number | null;
  semantic: number | null;
}

export interface CaseResult {
  query: string;
  kind: GoldenCase['kind'];
  flags: string[];
  expectedIds: string[];
  ranks: ModeRanks;
  recall: {
    hybrid: { at5: number; at10: number };
    fts: { at5: number; at10: number };
    semantic: { at5: number; at10: number };
  };
  group?: GoldenCase['group'];
}

interface KnownItemMetrics {
  mrr: number;
  hitAt1: number;
  hitAt3: number;
  hitAt10: number;
}

interface ConceptualMetrics {
  recallAt5: number;
  recallAt10: number;
}

export interface SuiteMetrics {
  knownItem: { hybrid: KnownItemMetrics; fts: KnownItemMetrics; semantic: KnownItemMetrics };
  conceptual: { hybrid: ConceptualMetrics; fts: ConceptualMetrics; semantic: ConceptualMetrics };
  conceptualGroups: {
    precision: { hybrid: KnownItemMetrics; fts: KnownItemMetrics; semantic: KnownItemMetrics };
    topical: { hybrid: ConceptualMetrics; fts: ConceptualMetrics; semantic: ConceptualMetrics };
    attachment_noise: { hybrid: KnownItemMetrics; fts: KnownItemMetrics; semantic: KnownItemMetrics };
    field_recall: { hybrid: ConceptualMetrics; fts: ConceptualMetrics; semantic: ConceptualMetrics };
    // Canonical demotion (finding #7): does the canonical note outrank its generated
    // wiki / import duplicates? Measured hit@1-style, like attachment_noise.
    canonical: { hybrid: KnownItemMetrics; fts: KnownItemMetrics; semantic: KnownItemMetrics };
  };
  counts: { knownItem: number; conceptual: number; collisions: number; precision: number; topical: number; attachment_noise: number; field_recall: number; canonical: number };
}

export interface SuiteResult {
  results: CaseResult[];
  metrics: SuiteMetrics;
  worstOffenders: CaseResult[];
}

export type ConceptualGateFailure = {
  readonly query: string;
  readonly group: ConceptualGroup;
  readonly rank: number | null;
  readonly maximumRank: number;
};

export class ConceptualBenchmarkGateError extends Error {
  readonly name = 'ConceptualBenchmarkGateError';

  constructor(readonly failures: readonly ConceptualGateFailure[]) {
    super(`Conceptual benchmark has ${failures.length} rank-gate failure(s)`);
  }
}

const CONCEPTUAL_MAXIMUM_RANK = {
  precision: 1,
  attachment_noise: 1,
  canonical: 1,
  topical: 5,
  field_recall: 5,
} as const satisfies Readonly<Record<ConceptualGroup, number>>;

export function assertConceptualGates(results: readonly CaseResult[]): void {
  const failures: ConceptualGateFailure[] = [];
  for (const result of results) {
    if (result.kind !== 'conceptual' || result.group === undefined) continue;
    const maximumRank = CONCEPTUAL_MAXIMUM_RANK[result.group];
    const rank = result.ranks.hybrid;
    if (rank === null || rank > maximumRank) {
      failures.push({ query: result.query, group: result.group, rank, maximumRank });
    }
  }
  if (failures.length > 0) throw new ConceptualBenchmarkGateError(failures);
}

export type Mode = 'hybrid' | 'fts' | 'semantic';

/** Best (lowest) rank of any expected id within the result list, or null if none found. */
function bestRank(resultIds: string[], c: GoldenCase): number | null {
  let best: number | null = null;
  for (const id of c.expectedIds) {
    const r = rankOf(resultIds, id);
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

export async function runCase(
  db: Database.Database,
  embedder: Embedder | null,
  c: GoldenCase,
  limit: number,
  includeSemantic: boolean,
  allowedModes?: Mode[],
): Promise<CaseResult> {
  const ranks: ModeRanks = { hybrid: null, fts: null, semantic: null };
  const recall = {
    hybrid: { at5: 0, at10: 0 },
    fts: { at5: 0, at10: 0 },
    semantic: { at5: 0, at10: 0 },
  };

  const modes: Mode[] = ['fts'];
  if (embedder) {
    modes.push('hybrid');
    if (includeSemantic) modes.push('semantic');
  }
  const active = allowedModes ? modes.filter((m) => allowedModes.includes(m)) : modes;

  for (const mode of active) {
    const emb = mode === 'fts' ? null : embedder;
    const hits = await hybridSearch(db, emb, c.query, { mode, limit });
    const resultIds = hits.map((h) => h.node_id);
    ranks[mode] = bestRank(resultIds, c);
    recall[mode] = {
      at5: recallAtK(resultIds, c.expectedIds, 5),
      at10: recallAtK(resultIds, c.expectedIds, 10),
    };
  }

  return { query: c.query, kind: c.kind, flags: c.flags, expectedIds: c.expectedIds, ranks, recall, group: c.group };
}

export async function runSuite(
  db: Database.Database,
  embedder: Embedder | null,
  cases: GoldenCase[],
  opts: { limit?: number; includeSemantic?: boolean; worstLimit?: number; modes?: Mode[] } = {},
): Promise<SuiteResult> {
  const limit = opts.limit ?? 20;
  const includeSemantic = opts.includeSemantic ?? true;
  const worstLimit = opts.worstLimit ?? 50;

  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runCase(db, embedder, c, limit, includeSemantic, opts.modes));
  }

  const known = results.filter((r) => r.kind === 'known-item');
  const conceptual = results.filter((r) => r.kind === 'conceptual');
  const precision = conceptual.filter((r) => r.group === 'precision');
  const topical = conceptual.filter((r) => r.group === 'topical');
  const attachmentNoise = conceptual.filter((r) => r.group === 'attachment_noise');
  const fieldRecall = conceptual.filter((r) => r.group === 'field_recall');
  const canonical = conceptual.filter((r) => r.group === 'canonical');

  const kiOf = (rows: CaseResult[], mode: Mode): KnownItemMetrics => {
    const ranks = rows.map((r) => r.ranks[mode]);
    return { mrr: mrr(ranks), hitAt1: hitAtK(ranks, 1), hitAt3: hitAtK(ranks, 3), hitAt10: hitAtK(ranks, 10) };
  };
  const cmOf = (rows: CaseResult[], mode: Mode): ConceptualMetrics => ({
    recallAt5: mean(rows.map((r) => r.recall[mode].at5)),
    recallAt10: mean(rows.map((r) => r.recall[mode].at10)),
  });

  const metrics: SuiteMetrics = {
    knownItem: { hybrid: kiOf(known, 'hybrid'), fts: kiOf(known, 'fts'), semantic: kiOf(known, 'semantic') },
    conceptual: { hybrid: cmOf(conceptual, 'hybrid'), fts: cmOf(conceptual, 'fts'), semantic: cmOf(conceptual, 'semantic') },
    conceptualGroups: {
      precision: { hybrid: kiOf(precision, 'hybrid'), fts: kiOf(precision, 'fts'), semantic: kiOf(precision, 'semantic') },
      topical: { hybrid: cmOf(topical, 'hybrid'), fts: cmOf(topical, 'fts'), semantic: cmOf(topical, 'semantic') },
      attachment_noise: { hybrid: kiOf(attachmentNoise, 'hybrid'), fts: kiOf(attachmentNoise, 'fts'), semantic: kiOf(attachmentNoise, 'semantic') },
      field_recall: { hybrid: cmOf(fieldRecall, 'hybrid'), fts: cmOf(fieldRecall, 'fts'), semantic: cmOf(fieldRecall, 'semantic') },
      canonical: { hybrid: kiOf(canonical, 'hybrid'), fts: kiOf(canonical, 'fts'), semantic: kiOf(canonical, 'semantic') },
    },
    counts: {
      knownItem: known.length,
      conceptual: conceptual.length,
      collisions: known.filter((r) => r.flags.includes('collision')).length,
      precision: precision.length,
      topical: topical.length,
      attachment_noise: attachmentNoise.length,
      field_recall: fieldRecall.length,
      canonical: canonical.length,
    },
  };

  // Worst offenders: known-item cases ranked worst in hybrid (null worst), then fts.
  const rankSortKey = (r: CaseResult): number => {
    const h = r.ranks.hybrid ?? r.ranks.fts;
    return h === null ? Number.MAX_SAFE_INTEGER : h;
  };
  const worstOffenders = known
    .filter((r) => rankSortKey(r) > 1)
    .sort((a, b) => rankSortKey(b) - rankSortKey(a))
    .slice(0, worstLimit);

  return { results, metrics, worstOffenders };
}
