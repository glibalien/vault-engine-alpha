import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { setStoredSettings } from '../../src/settings/store.js';
import {
  RERANK_WEIGHTS,
  blendRerankScore,
  setRerankWeights,
  getActiveRerankWeights,
  buildNodeMeta,
  extractRerankFeatures,
  hybridSearch,
  type RerankFeatures,
  type NodeMeta,
} from '../../src/search/search.js';

const ZERO: RerankFeatures = {
  base: 0, titleQueryCoverage: 0, titlePrecision: 0,
  wikiUnnamed: 0, duplicateLoser: 0, inboundLinks: 0, chatterType: 0,
};

describe('blendRerankScore (Cycle 4)', () => {
  afterEach(() => setRerankWeights(null));

  // Weight-agnostic on purpose: these pin the blend's ARITHMETIC (additivity,
  // penalty signs), not the frozen values — sweeps re-freeze weights without
  // touching these tests. The frozen values themselves are documented and
  // sweep-cited at RERANK_WEIGHTS.
  it('is additive over the weighted features', () => {
    expect(blendRerankScore({ ...ZERO, base: 1 })).toBeCloseTo(RERANK_WEIGHTS.base, 10);
    expect(blendRerankScore({ ...ZERO, base: 1, titleQueryCoverage: 0.5, titlePrecision: 1 }))
      .toBeCloseTo(RERANK_WEIGHTS.base + RERANK_WEIGHTS.titleQueryCoverage * 0.5 + RERANK_WEIGHTS.titlePrecision * 1, 10);
  });

  it('applies penalties with negative weights', () => {
    expect(RERANK_WEIGHTS.wikiUnnamed).toBeLessThan(0);
    expect(RERANK_WEIGHTS.duplicateLoser).toBeLessThan(0);
    expect(blendRerankScore({ ...ZERO, base: 1, wikiUnnamed: 1 }))
      .toBeCloseTo(RERANK_WEIGHTS.base + RERANK_WEIGHTS.wikiUnnamed, 10);
    expect(blendRerankScore({ ...ZERO, base: 1, duplicateLoser: 1, chatterType: 1 }))
      .toBeCloseTo(RERANK_WEIGHTS.base + RERANK_WEIGHTS.duplicateLoser + RERANK_WEIGHTS.chatterType, 10);
  });

  it('modelScore is inert by default (hook weight 0) and absent means 0', () => {
    expect(blendRerankScore({ ...ZERO, base: 0.5, modelScore: 0.9 })).toBeCloseTo(0.5, 10);
    expect(blendRerankScore({ ...ZERO, base: 0.5 })).toBeCloseTo(0.5, 10);
  });

  it('setRerankWeights swaps the active weights; null restores defaults', () => {
    setRerankWeights({ ...RERANK_WEIGHTS, wikiUnnamed: -1 });
    expect(getActiveRerankWeights().wikiUnnamed).toBe(-1);
    expect(blendRerankScore({ ...ZERO, base: 1, wikiUnnamed: 1 })).toBeCloseTo(0, 10);
    setRerankWeights(null);
    expect(getActiveRerankWeights()).toBe(RERANK_WEIGHTS);
  });
});

function insertTyped(db: Database.Database, id: string, title: string, types: string[] = []): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, '');
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, '');
  types.forEach((t, i) => {
    db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)').run(id, t, i);
  });
}

// relationships schema (src/db/schema.ts): id INTEGER PK, source_id TEXT NOT NULL,
// target TEXT NOT NULL, rel_type TEXT NOT NULL, context TEXT (nullable),
// resolved_target_id TEXT (nullable) — only resolved_target_id matters to the
// inbound-link count buildNodeMeta computes; target/rel_type get minimal valid values.
function insertRelationship(db: Database.Database, sourceId: string, targetId: string): void {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)',
  ).run(sourceId, targetId, 'wikilink', targetId);
}

describe('buildNodeMeta feature fields (Cycle 4)', () => {
  it('reports inbound link counts and chatter typing', () => {
    const db = createTestDb();
    insertTyped(db, 'hub', 'Project Hub', ['note']);
    insertTyped(db, 'meet', 'Standup Notes', ['meeting']);
    insertTyped(db, 'daily', 'Some Day', ['daily-note']);
    insertTyped(db, 'plain', 'Plain Note', ['note']);
    // Two inbound links to hub. Inspect the relationships schema in
    // src/db/schema (or the migrations) for its NOT NULL columns and insert
    // minimal valid rows — only resolved_target_id matters to the count.
    // (Adjust the INSERT below to the actual column list.)
    insertRelationship(db, 'meet', 'hub');
    insertRelationship(db, 'daily', 'hub');

    const meta = buildNodeMeta(db, ['hub', 'meet', 'daily', 'plain']);
    expect(meta.get('hub')).toMatchObject({ inboundLinks: 2, isChatter: false, isWiki: false });
    expect(meta.get('meet')).toMatchObject({ inboundLinks: 0, isChatter: true });
    expect(meta.get('daily')).toMatchObject({ isChatter: true });
    expect(meta.get('plain')).toMatchObject({ inboundLinks: 0, isChatter: false });
  });
});

describe('buildNodeMeta and the vault map', () => {
  it('flags wiki pages and chatter by the configured kinds; none flags nothing', () => {
    const db = createTestDb();
    insertTyped(db, 'wiki', 'Some Wiki', ['wiki']);
    insertTyped(db, 'page', 'Some Page', ['page']);
    insertTyped(db, 'meet', 'Standup', ['meeting']);
    insertTyped(db, 'call', 'Call', ['call']);
    insertTyped(db, 'rec', 'Recording', ['transcript']);
    insertTyped(db, 'daily', 'Some Day', ['daily-note']);
    const flags = () => Object.fromEntries([...buildNodeMeta(db, ['wiki', 'page', 'meet', 'call', 'rec', 'daily'])]
      .map(([id, m]) => [id, `${m.isWiki ? 'W' : '-'}${m.isChatter ? 'C' : '-'}`]));

    // Default map: today's literals.
    expect(flags()).toEqual({ wiki: 'W-', page: '--', meet: '-C', call: '--', rec: '-C', daily: '-C' });
    setStoredSettings(db, 'vault', { wikiType: 'page', meetingType: 'call', transcriptType: 'recording' });
    expect(flags()).toEqual({ wiki: '--', page: 'W-', meet: '--', call: '-C', rec: '--', daily: '-C' });
    setStoredSettings(db, 'vault', { wikiType: null, meetingType: null, transcriptType: null });
    expect(flags()).toEqual({ wiki: '--', page: '--', meet: '--', call: '--', rec: '--', daily: '-C' });
    // The daily-note kind is designated too (#572), and none flags nothing.
    setStoredSettings(db, 'vault', { dailyNoteType: 'page' });
    expect(flags()).toEqual({ wiki: 'W-', page: '-C', meet: '-C', call: '--', rec: '-C', daily: '--' });
    setStoredSettings(db, 'vault', { wikiType: null, meetingType: null, transcriptType: null, dailyNoteType: null });
    expect(flags()).toEqual({ wiki: '--', page: '--', meet: '--', call: '--', rec: '--', daily: '--' });
  });
});

describe('extractRerankFeatures (Cycle 4)', () => {
  const meta = (m: Partial<NodeMeta>): NodeMeta =>
    ({ isWiki: false, normTitle: '', inboundLinks: 0, isChatter: false, ...m });

  it('computes base as score/windowMax and title coverage/precision', () => {
    const nm = new Map([
      ['a', meta({ normTitle: 'northstar coast trip' })],
      ['b', meta({ normTitle: 'northstar coast trip lodging' })],
    ]);
    const f = extractRerankFeatures(
      [{ nodeId: 'a', score: 0.8 }, { nodeId: 'b', score: 1.0 }],
      nm, new Set(['northstar', 'coast', 'trip']), new Set(), true,
    );
    expect(f.get('a')!.base).toBeCloseTo(0.8, 10);
    expect(f.get('b')!.base).toBeCloseTo(1.0, 10);
    expect(f.get('a')!.titleQueryCoverage).toBeCloseTo(1, 10);   // 3/3
    expect(f.get('a')!.titlePrecision).toBeCloseTo(1, 10);       // 3/3 — the Lodging discriminator
    expect(f.get('b')!.titleQueryCoverage).toBeCloseTo(1, 10);   // 3/3
    expect(f.get('b')!.titlePrecision).toBeCloseTo(0.75, 10);    // 3/4
  });

  it('degenerate denominators: empty Q → coverage 0; empty T → precision 0; missing meta → zeros', () => {
    const nm = new Map([['a', meta({ normTitle: '' })]]);
    const f = extractRerankFeatures([{ nodeId: 'a', score: 1 }, { nodeId: 'x', score: 0.5 }], nm, new Set(), new Set(), false);
    expect(f.get('a')!.titleQueryCoverage).toBe(0);
    expect(f.get('a')!.titlePrecision).toBe(0);
    expect(f.get('x')!.titleQueryCoverage).toBe(0);
    expect(f.get('x')!.wikiUnnamed).toBe(0);
  });

  it('wikiUnnamed: set for unnamed wikis, cleared when the query names the full title or on exact-title', () => {
    const nm = new Map([
      ['named', meta({ isWiki: true, normTitle: 'durable memories wiki' })],
      ['unnamed', meta({ isWiki: true, normTitle: 'northstar coast trip wiki risks' })],
      ['exact', meta({ isWiki: true, normTitle: 'zzz wiki' })],
    ]);
    const q = new Set(['durable', 'memories', 'wiki']);
    const w = [{ nodeId: 'named', score: 1 }, { nodeId: 'unnamed', score: 0.9 }, { nodeId: 'exact', score: 0.8 }];
    const f = extractRerankFeatures(w, nm, q, new Set(['exact']), true);
    expect(f.get('named')!.wikiUnnamed).toBe(0);
    expect(f.get('unnamed')!.wikiUnnamed).toBe(1);
    expect(f.get('exact')!.wikiUnnamed).toBe(0); // exact-title exclusion
  });

  it('duplicateLoser: top member (by score, node_id tiebreak) keeps 0; exact-title members excluded from grouping', () => {
    const nm = new Map([
      ['d1', meta({ normTitle: 'meeting notes' })],
      ['d2', meta({ normTitle: 'meeting notes' })],
      ['d3', meta({ normTitle: 'meeting notes' })],
      ['solo', meta({ normTitle: 'weekly sync' })],
    ]);
    const w = [
      { nodeId: 'd1', score: 1.0 }, { nodeId: 'd2', score: 1.0 },
      { nodeId: 'd3', score: 0.5 }, { nodeId: 'solo', score: 0.4 },
    ];
    const f = extractRerankFeatures(w, nm, new Set(['x']), new Set(['d2']), false);
    // d2 is exact-title → excluded from the group entirely; among {d1, d3}, d1 wins.
    expect(f.get('d1')!.duplicateLoser).toBe(0);
    expect(f.get('d2')!.duplicateLoser).toBe(0);
    expect(f.get('d3')!.duplicateLoser).toBe(1);
    expect(f.get('solo')!.duplicateLoser).toBe(0);
  });

  it('inboundLinks: log-ratio normalized in-window; all-zero window gives 0', () => {
    const nm = new Map([
      ['hub', meta({ inboundLinks: 9 })],
      ['leaf', meta({ inboundLinks: 1 })],
      ['none', meta({ inboundLinks: 0 })],
    ]);
    const w = [{ nodeId: 'hub', score: 1 }, { nodeId: 'leaf', score: 0.9 }, { nodeId: 'none', score: 0.8 }];
    const f = extractRerankFeatures(w, nm, new Set(['x']), new Set(), false);
    expect(f.get('hub')!.inboundLinks).toBeCloseTo(1, 10);
    expect(f.get('leaf')!.inboundLinks).toBeCloseTo(Math.log1p(1) / Math.log1p(9), 10);
    expect(f.get('none')!.inboundLinks).toBe(0);
    const z = extractRerankFeatures([{ nodeId: 'none', score: 1 }], new Map([['none', meta({})]]), new Set(), new Set(), false);
    expect(z.get('none')!.inboundLinks).toBe(0);
  });

  it('chatterType only fires on non-navigational queries', () => {
    const nm = new Map([['m', meta({ isChatter: true })]]);
    const w = [{ nodeId: 'm', score: 1 }];
    expect(extractRerankFeatures(w, nm, new Set(), new Set(), false).get('m')!.chatterType).toBe(1);
    expect(extractRerankFeatures(w, nm, new Set(), new Set(), true).get('m')!.chatterType).toBe(0);
  });

  it('an empty-titled wiki is always demotable (cannot be named by any query)', () => {
    // Deliberate: T = ∅ means NO query can name this wiki, so wikiUnnamed stays 1.
    // The vacuous-subset reading (∅ ⊆ Q → exempt) would invert the intent.
    const nm = new Map([['w', meta({ isWiki: true, normTitle: '' })]]);
    const f = extractRerankFeatures([{ nodeId: 'w', score: 1 }], nm, new Set(['anything']), new Set(), true);
    expect(f.get('w')!.wikiUnnamed).toBe(1);
  });
});

function insertNode(db: Database.Database, id: string, title: string, body: string): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, body);
}

function queryEmbedder() {
  return {
    async embedDocument() { return [new Float32Array(256)]; },
    async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
    isReady: () => true,
  };
}

function insertNodeVector(db: Database.Database, nodeId: string, firstComponent: number): void {
  const sourceHash = `${nodeId}-node-0`;
  db.prepare(`
    INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
    VALUES (?, 'node', ?, 0, NULL, 't')
  `).run(nodeId, sourceHash);
  const v = new Float32Array(256);
  v[0] = firstComponent;
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES ((SELECT id FROM embedding_meta WHERE source_hash = ?), ?)')
    .run(sourceHash, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

describe('rerank blend end-to-end (Cycle 4)', () => {
  it('zero-title-overlap chatty note loses to a covered, linked canonical (the Weekly Summary shape)', async () => {
    const db = createTestDb();
    // weekly: fts rank 1 (body match) + recall + semantic rank 1 → strongest base, but
    // its title shares no token with the query → title features 0, links 0.
    insertNode(db, 'weekly', 'Weekly Summary W23', 'planning a trip to northstar coast and other things');
    insertTyped(db, 'canon', 'Northstar Coast Trip', ['note']);
    insertTyped(db, 'linker', 'Linker Note', ['note']); // unrelated 2nd source, only used for the inbound-link count below
    insertNodeVector(db, 'weekly', 1.0);
    insertNodeVector(db, 'canon', 0.95);
    insertRelationship(db, 'weekly', 'canon');
    insertRelationship(db, 'linker', 'canon'); // 2 inbound links to canon (distinct source_id — relationships has a UNIQUE(source_id, target, rel_type) constraint, so a 2nd link needs a 2nd source)
    // Non-navigational (no title-AND hit): weekly ≈ fts 1/61 + recall 0.5/61 + sem 1/61
    // ≈ 0.0410; canon ≈ recall 0.5/62 + sem 1/62 ≈ 0.0242 → base canon ≈ 0.59.
    // canon features: coverage 3/4 (+0.225), precision 3/3 (+0.2), links max (+0.1)
    // → ≈ 1.115 vs weekly 1.0 → canon flips to #1. Derived, not guessed.
    const hits = await hybridSearch(db, queryEmbedder(), 'planning a trip to northstar coast', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('canon');
    expect(hits.map((h) => h.node_id)).toHaveLength(2);
  });

  it('window edge: a penalized wiki sinks within the window envelope; below-window candidates keep raw order', async () => {
    const db = createTestDb();
    insertTyped(db, 'wiki', 'Topic Guide', ['wiki']); // unnamed for this query
    insertNodeVector(db, 'wiki', 0.999); // semantic rank 2 → near the top of the window
    for (let i = 0; i < 54; i++) {
      const id = `filler${String(i).padStart(2, '0')}`;
      insertTyped(db, id, `Filler Note ${i}`, ['note']);
      insertNodeVector(db, id, 1.0 - i * 0.002); // filler00 rank 1, then descending
    }
    // 55 candidates; window = top 50. Wiki base ≈ (1/62)/(1/61) ≈ 0.984, penalized
    // −0.3 → 0.684, which lands mid-window (fillers' bases run 1 → ~0.55), and the
    // affine remap keeps every window member above the 5 below-window fillers.
    const hits = await hybridSearch(db, queryEmbedder(), 'unrelated topical prose', { mode: 'hybrid', limit: 60 });
    const ids = hits.map((h) => h.node_id);
    const wikiIdx = ids.indexOf('wiki');
    expect(wikiIdx).toBeGreaterThan(10);              // penalized well out of the head
    expect(wikiIdx).toBeLessThan(50);                 // but stays inside the window envelope
    // 55 candidates, window = top 50 by raw score = filler00..48 + wiki (vector 0.999
    // sits between filler00 and filler01). Below-window = the 5 weakest, in raw
    // (descending-vector = name) order, untouched by the blend:
    expect(ids.slice(50)).toEqual(['filler49', 'filler50', 'filler51', 'filler52', 'filler53']);
  });
});
