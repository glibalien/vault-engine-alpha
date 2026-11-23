// packages/engine/tests/search/bench/runner.test.ts
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import type { Embedder } from '../../../src/search/embedder.js';
import { createTestDb } from '../../helpers/db.js';
import {
  assertConceptualGates,
  runSuite,
} from '../../../src/search/bench/runner.js';
import type { CaseResult } from '../../../src/search/bench/runner.js';
import type { GoldenCase } from '../../../src/search/bench/golden.js';

function insert(db: Database.Database, id: string, title: string, body = ''): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, body);
}

const fakeEmbedder: Embedder = {
  async embedDocument() { return [new Float32Array(256)]; },
  async embedQuery() { return new Float32Array(256); },
  isReady: () => true,
};

function conceptualResult(
  query: string,
  group: NonNullable<GoldenCase['group']>,
  hybridRank: number | null,
): CaseResult {
  return {
    query,
    kind: 'conceptual',
    flags: [],
    expectedIds: ['expected'],
    ranks: { hybrid: hybridRank, fts: null, semantic: null },
    recall: {
      hybrid: { at5: 0, at10: 0 },
      fts: { at5: 0, at10: 0 },
      semantic: { at5: 0, at10: 0 },
    },
    group,
  };
}

describe('runSuite', () => {
  it('collects every conceptual hybrid rank-gate failure', () => {
    const results = [
      conceptualResult('precision miss', 'precision', 2),
      conceptualResult('attachment pass', 'attachment_noise', 1),
      conceptualResult('topical miss', 'topical', null),
      conceptualResult('field recall miss', 'field_recall', 6),
      conceptualResult('canonical pass', 'canonical', 1),
    ];

    expect(() => assertConceptualGates(results)).toThrowError(
      expect.objectContaining({
        name: 'ConceptualBenchmarkGateError',
        failures: [
          { query: 'precision miss', group: 'precision', rank: 2, maximumRank: 1 },
          { query: 'topical miss', group: 'topical', rank: null, maximumRank: 5 },
          { query: 'field recall miss', group: 'field_recall', rank: 6, maximumRank: 5 },
        ],
      }),
    );
  });

  it('computes fts rank and known-item MRR (fts-only, no semantic)', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Zora Wren', 'person');
    insert(db, 'n2', 'Other Note', 'unrelated content');
    const cases: GoldenCase[] = [
      { query: 'Zora Wren', expectedIds: ['n1'], kind: 'known-item', topK: 1, flags: [] },
    ];
    const suite = await runSuite(db, fakeEmbedder, cases, { includeSemantic: false });
    expect(suite.results[0].ranks.fts).toBe(1);
    expect(suite.metrics.knownItem.fts.hitAt1).toBe(1);
    expect(suite.metrics.knownItem.fts.mrr).toBe(1);
  });

  it('marks a missing target as null rank and surfaces it as a worst offender', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Findable', 'body');
    const cases: GoldenCase[] = [
      { query: 'nonexistent zzz', expectedIds: ['n1'], kind: 'known-item', topK: 1, flags: [] },
    ];
    const suite = await runSuite(db, fakeEmbedder, cases, { includeSemantic: false });
    expect(suite.results[0].ranks.fts).toBeNull();
    expect(suite.worstOffenders[0].query).toBe('nonexistent zzz');
  });

  it('accepts any colliding id within topK', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Meeting Notes', 'a');
    insert(db, 'n2', 'Meeting Notes', 'b');
    const cases: GoldenCase[] = [
      { query: 'Meeting Notes', expectedIds: ['n1', 'n2'], kind: 'known-item', topK: 2, flags: ['collision'] },
    ];
    const suite = await runSuite(db, fakeEmbedder, cases, { includeSemantic: false });
    expect(suite.results[0].ranks.fts).not.toBeNull();
    expect(suite.results[0].ranks.fts).toBeLessThanOrEqual(2);
  });

  it('splits conceptual metrics into precision, topical, attachment_noise, and field_recall groups', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Mina Quorra', 'bio');
    insert(db, 'n2', 'Northstar Coast Trip', 'travel notes');
    insert(db, 'n3', 'Lina Sable', 'bio');
    insert(db, 'n4', 'Orin Pax', 'bio');
    insert(db, 'n5', 'Weekly Sync', 'Rowan Vale');
    const cases: GoldenCase[] = [
      { query: 'Mina Quorra', expectedIds: ['n1'], kind: 'conceptual', topK: 10, flags: [], group: 'precision' },
      { query: 'Northstar Coast Trip', expectedIds: ['n2'], kind: 'conceptual', topK: 10, flags: [], group: 'topical' },
      { query: 'Lina Sable', expectedIds: ['n3'], kind: 'conceptual', topK: 10, flags: [], group: 'attachment_noise' },
      { query: 'Orin Pax', expectedIds: ['n4'], kind: 'conceptual', topK: 10, flags: [], group: 'attachment_noise' },
      { query: 'Rowan Vale', expectedIds: ['n5'], kind: 'conceptual', topK: 10, flags: [], group: 'field_recall' },
    ];
    const suite = await runSuite(db, fakeEmbedder, cases, { includeSemantic: false });
    expect(suite.metrics.counts.precision).toBe(1);
    expect(suite.metrics.counts.topical).toBe(1);
    expect(suite.metrics.counts.attachment_noise).toBe(2);
    expect(suite.metrics.counts.field_recall).toBe(1);
    // The precision case is an exact title -> rank 1 in fts -> MRR 1, hit@1 1.
    expect(suite.metrics.conceptualGroups.precision.fts.mrr).toBe(1);
    expect(suite.metrics.conceptualGroups.precision.fts.hitAt1).toBe(1);
    // Attachment-noise cases are also single-target precision-style metrics.
    expect(suite.metrics.conceptualGroups.attachment_noise.fts.mrr).toBe(1);
    expect(suite.metrics.conceptualGroups.attachment_noise.fts.hitAt1).toBe(1);
    // The topical case is found within top-5 -> recall@5 1.
    expect(suite.metrics.conceptualGroups.topical.fts.recallAt5).toBe(1);
    // Field-recall is recall-oriented like topical.
    expect(suite.metrics.conceptualGroups.field_recall.fts.recallAt5).toBe(1);
  });

  it('tracks the canonical group (finding #7) as a hit@1-style metric', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Northstar Coast Trip', 'trip planning');
    const cases: GoldenCase[] = [
      { query: 'Northstar Coast Trip', expectedIds: ['n1'], kind: 'conceptual', topK: 10, flags: [], group: 'canonical' },
    ];
    const suite = await runSuite(db, fakeEmbedder, cases, { includeSemantic: false });
    expect(suite.metrics.counts.canonical).toBe(1);
    expect(suite.metrics.conceptualGroups.canonical.fts.hitAt1).toBe(1);
    expect(suite.metrics.conceptualGroups.canonical.fts.mrr).toBe(1);
  });

  it('opts.modes restricts evaluation to the named modes', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Zora Wren', 'person');
    const cases: GoldenCase[] = [
      { query: 'Zora Wren', expectedIds: ['n1'], kind: 'known-item', topK: 1, flags: [] },
    ];
    const suite = await runSuite(db, fakeEmbedder, cases, { limit: 10, modes: ['fts'] });
    const r = suite.results[0];
    expect(r.ranks.fts).not.toBeNull();
    expect(r.ranks.hybrid).toBeNull();   // skipped
    expect(r.ranks.semantic).toBeNull(); // skipped
  });
});
