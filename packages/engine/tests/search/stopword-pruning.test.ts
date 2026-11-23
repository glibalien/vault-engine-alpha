import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { contentTokens, buildFtsMatchQuery, ftsHasTitleHit, hybridSearch } from '../../src/search/search.js';
import type { Embedder } from '../../src/search/embedder.js';

function insertNode(db: Database.Database, id: string, title: string, body: string | null = null): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, body);
}

const noEmbedder = null as unknown as Embedder;

function queryEmbedder(): Embedder {
  return {
    async embedDocument() { return [new Float32Array(256)]; },
    async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
    isReady: () => true,
  } as unknown as Embedder;
}

function insertTyped(db: Database.Database, id: string, title: string, types: string[]): void {
  insertNode(db, id, title, '');
  types.forEach((t, i) => {
    db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)').run(id, t, i);
  });
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

describe('contentTokens (Cycle 3.5)', () => {
  it('filters stopwords case-insensitively', () => {
    expect(contentTokens(['planning', 'a', 'trip', 'to', 'northstar', 'coast'])).toEqual(['planning', 'trip', 'northstar', 'coast']);
    expect(contentTokens(['The', 'Northstar', 'Coast', 'Trip'])).toEqual(['Northstar', 'Coast', 'Trip']);
  });

  it('returns the input unchanged when pruning would leave nothing', () => {
    expect(contentTokens(['to', 'do'])).toEqual(['to', 'do']);
    expect(contentTokens([])).toEqual([]);
  });
});

describe('buildFtsMatchQuery stopword pruning (Cycle 3.5)', () => {
  it('prunes loose stopwords from the AND lane', () => {
    expect(buildFtsMatchQuery('planning a trip to northstar coast')).toBe('"planning" "trip" "northstar" "coast"');
    expect(buildFtsMatchQuery('the northwind big deal proposal')).toBe('"northwind" "big" "deal" "proposal"');
  });

  it('keeps stopwords inside quoted phrases verbatim', () => {
    expect(buildFtsMatchQuery('"trip to northstar coast"')).toBe('"trip to northstar coast"');
    expect(buildFtsMatchQuery('the "trip to northstar coast" itinerary')).toBe('"trip to northstar coast" "itinerary"');
  });

  it('falls back to unpruned tokens for a pure-stopword query', () => {
    expect(buildFtsMatchQuery('to do')).toBe('"to" "do"');
    expect(buildFtsMatchQuery('AND OR')).toBe('"AND" "OR"'); // existing b02 expectation, now via fallback
  });

  it('keeps the empty-query contract', () => {
    expect(buildFtsMatchQuery('')).toBe('');
    expect(buildFtsMatchQuery('!!! ??? ---')).toBe('');
    expect(buildFtsMatchQuery('""')).toBe('');
  });
});

describe('ftsHasTitleHit stopword pruning (Cycle 3.5)', () => {
  it('a stopword-padded title query registers as navigational', () => {
    expect(ftsHasTitleHit([{ title: 'Northstar Coast Trip' }], 'the northstar coast trip', 5)).toBe(true);
    expect(ftsHasTitleHit([{ title: 'Northwind Big Deal Proposal' }], 'the northwind big deal proposal', 5)).toBe(true);
  });

  it('a topical query with extra content tokens still reads as non-navigational', () => {
    // "planning" is a content word absent from the title — unchanged from today.
    expect(ftsHasTitleHit([{ title: 'Northstar Coast Trip' }], 'planning a trip to northstar coast', 5)).toBe(false);
  });

  it('a pure-stopword query keeps its full token set (fallback)', () => {
    expect(ftsHasTitleHit([{ title: 'To Do' }], 'to do', 5)).toBe(true);
    expect(ftsHasTitleHit([{ title: 'Groceries' }], 'to do', 5)).toBe(false);
  });
});

describe('snippet stopword + word-boundary highlighting (Cycle 3.5)', () => {
  it('does not mark stopwords or substrings — the "a"/"to" regression', async () => {
    const db = createTestDb();
    insertNode(db, 'n1', 'Trip notes', 'planning a trip to northstar coast was a great idea');
    const [hit] = await hybridSearch(db, noEmbedder, 'planning a trip to northstar coast', { mode: 'fts', limit: 5 });
    expect(hit.snippet).toContain('<mark>planning</mark>');
    expect(hit.snippet).toContain('<mark>trip</mark>');
    expect(hit.snippet).not.toContain('<mark>a</mark>');
    expect(hit.snippet).not.toContain('<mark>to</mark>');
    // No boundless-substring marks inside words ("pl<mark>a</mark>nning").
    expect(hit.snippet).not.toMatch(/\w<mark>/u);
  });

  it('word boundaries: a content term does not mark inside longer words', async () => {
    const db = createTestDb();
    insertNode(db, 'n1', 'Wires', 'the tripwire trips over the trip');
    const [hit] = await hybridSearch(db, noEmbedder, 'trip', { mode: 'fts', limit: 5 });
    expect(hit.snippet).toContain('<mark>trip</mark>');
    expect(hit.snippet).not.toContain('<mark>trip</mark>wire');
    expect(hit.snippet).not.toContain('<mark>trips</mark>');
  });

  it('a pure-stopword query still highlights its own tokens (fallback)', async () => {
    const db = createTestDb();
    insertNode(db, 'n1', 'Todo', 'things to do today');
    const [hit] = await hybridSearch(db, noEmbedder, 'to do', { mode: 'fts', limit: 5 });
    expect(hit.snippet).toContain('<mark>to</mark>');
    expect(hit.snippet).toContain('<mark>do</mark>');
  });

  it('Unicode terms still highlight at word boundaries', async () => {
    const db = createTestDb();
    insertNode(db, 'n1', 'Places', 'the café review notes');
    const [hit] = await hybridSearch(db, noEmbedder, 'café review', { mode: 'fts', limit: 5 });
    expect(hit.snippet).toContain('<mark>café</mark>');
  });
});

describe('stopword-padded navigational treatment e2e (Cycle 3.5)', () => {
  it('an unnamed wiki stays demoted even when the stopword-padded query is navigational', async () => {
    const db = createTestDb();
    // canon fires the navigational gate (title ⊆ query content tokens). The wiki and
    // the distractor are semantic-only hits; the wiki's title is NOT named by the
    // query, so per-node demotion applies despite the navigational classification —
    // the demoted wiki falls below the weaker distractor. (Blanket navigational
    // suppression — the pre-amendment behavior — would keep the wiki above it; the
    // 2026-07-09 bench showed that lets generated subpages flood canonical queries.)
    insertTyped(db, 'canon', 'Northstar Coast Trip', ['note']);
    insertTyped(db, 'wikiGuide', 'Coastal Provinces Guide', ['wiki']);
    insertTyped(db, 'distractor', 'Seaside Region Notes', ['note']);
    insertNodeVector(db, 'wikiGuide', 1.0);   // semantic rank 1
    insertNodeVector(db, 'distractor', 0.95); // semantic rank 2

    const hits = await hybridSearch(db, queryEmbedder(), 'the northstar coast trip', { mode: 'hybrid', limit: 10 });
    const ids = hits.map((h) => h.node_id);
    expect(ids[0]).toBe('canon');
    expect(ids).toHaveLength(3);
    expect(ids.indexOf('distractor')).toBeLessThan(ids.indexOf('wikiGuide'));
  });
});
