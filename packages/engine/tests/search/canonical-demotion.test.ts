import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { hybridSearch } from '../../src/search/search.js';

// Finding #7 (Cycle 3, amended Cycle 3.5): generated wiki pages and import-duplicate
// copies must not outrank the canonical note. Demotion is query-time and hybrid-only;
// a wiki is exempt only when the query names its full title (or matches it exactly) —
// see the Cycle 3.5 spec amendment. These tests use seeded L2 vectors (v[0] closer to
// 1 ranks better) + a fake embedder, so no prod DB or real model is involved.

function insert(
  db: Database.Database,
  id: string,
  title: string,
  body = '',
  opts: { types?: string[] } = {},
): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, body);
  (opts.types ?? []).forEach((t, i) => {
    db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)').run(id, t, i);
  });
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

describe('canonical / wiki-subpage demotion (finding #7)', () => {
  it('a generated wiki page does not outrank its canonical note for a topical query', async () => {
    const db = createTestDb();
    insert(db, 'canon', 'Northstar Coast Trip', '', { types: ['note'] });
    insert(db, 'wiki', 'Northstar Coast Trip Wiki', '', { types: ['wiki'] });
    // Pre-demotion the wiki is the STRONGER semantic hit (closer vector, rank 1).
    insertNodeVector(db, 'wiki', 1.0);
    insertNodeVector(db, 'canon', 0.9);

    // Topical query with no lexical overlap: FTS/recall lanes are empty, only the
    // seeded semantic lane drives — isolating the demotion. Non-navigational.
    const hits = await hybridSearch(db, queryEmbedder(), 'weekend maritime getaway ideas', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('canon');
    expect(hits.map((h) => h.node_id).sort()).toEqual(['canon', 'wiki']); // nothing dropped
  });

  it('control: with no wiki type, the stronger semantic hit stays #1 (demotion is what flips it)', async () => {
    const db = createTestDb();
    insert(db, 'canon', 'Northstar Coast Trip', '', { types: ['note'] });
    insert(db, 'twin', 'Northstar Coast Journey', '', { types: ['note'] }); // note, not wiki
    insertNodeVector(db, 'twin', 1.0);
    insertNodeVector(db, 'canon', 0.9);

    const hits = await hybridSearch(db, queryEmbedder(), 'weekend maritime getaway ideas', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('twin');
  });

  it('an exact-title search for a wiki page still returns it #1 (demotion never buries a navigated wiki)', async () => {
    const db = createTestDb();
    insert(db, 'wiki', 'Atlas Program Wiki', '', { types: ['wiki'] });
    insert(db, 'note', 'Atlas Program', '', { types: ['note'] });
    // Give the competing note the CLOSER vector; only the exact-title guard saves the wiki.
    insertNodeVector(db, 'note', 1.0);
    insertNodeVector(db, 'wiki', 0.5);

    const hits = await hybridSearch(db, queryEmbedder(), 'Atlas Program Wiki', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('wiki');
  });

  it('a stopword-padded query that NAMES a wiki leaves it undemoted (per-node exemption)', async () => {
    const db = createTestDb();
    insert(db, 'wiki', 'Atlas Program Wiki', '', { types: ['wiki'] });
    insert(db, 'note2', 'Atlas Program Wiki Notes', '', { types: ['note'] });
    insertNodeVector(db, 'wiki', 1.0); // semantic edge: undemoted wiki beats note2 regardless of bm25 tie order
    // Non-exact ("the " prefix) and navigational; the wiki's full title content
    // tokens ⊆ the query's content tokens → named → exempt. If demotion were
    // wrongly applied, ×0.5 would drop the wiki below note2.
    const hits = await hybridSearch(db, queryEmbedder(), 'the atlas program wiki', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('wiki');
  });

  it('a navigational query does NOT exempt a wiki it does not name (subpage stays demoted)', async () => {
    const db = createTestDb();
    insert(db, 'canon', 'Atlas Program', '', { types: ['note'] });
    insert(db, 'wiki', 'Atlas Program Wiki', '', { types: ['wiki'] }); // extra title token "wiki" — unnamed
    insertNodeVector(db, 'wiki', 1.0); // wiki is the stronger raw hit
    // "the atlas program": the gate fires on canon's title (navigational), but the
    // wiki carries a title token ("wiki") absent from the query → demoted anyway.
    // Undemoted, the wiki's fts+semantic sum beats canon's fts-only score; demoted
    // ×0.5 it falls below — canon #1 proves demotion applied under a navigational
    // query (the exact bug the 2026-07-09 bench caught).
    const hits = await hybridSearch(db, queryEmbedder(), 'the atlas program', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('canon');
  });

  it('duplicate import copies collapse: canonical keeps its slot, the twin drops below a distinct result', async () => {
    const db = createTestDb();
    insert(db, 'dupA', 'Meeting Notes', '', { types: ['note'] });
    insert(db, 'dupB', 'Meeting Notes', '', { types: ['note'] }); // import duplicate, same title
    insert(db, 'other', 'Weekly Sync', '', { types: ['note'] });   // distinct competitor
    // Pre-demotion order dupA > dupB > other.
    insertNodeVector(db, 'dupA', 1.0);
    insertNodeVector(db, 'dupB', 0.95);
    insertNodeVector(db, 'other', 0.9);

    const hits = await hybridSearch(db, queryEmbedder(), 'team standup recurring cadence', { mode: 'hybrid', limit: 10 });
    const order = hits.map((h) => h.node_id);
    expect(order[0]).toBe('dupA');                       // canonical (top of its group) is unmoved
    expect(order.indexOf('other')).toBeLessThan(order.indexOf('dupB')); // distinct result beats the demoted twin
    expect(order.sort()).toEqual(['dupA', 'dupB', 'other']); // nothing dropped
  });

  it('semantic mode is unaffected by demotion (hybrid-only regression guard)', async () => {
    const db = createTestDb();
    insert(db, 'canon', 'Northstar Coast Trip', '', { types: ['note'] });
    insert(db, 'wiki', 'Northstar Coast Trip Wiki', '', { types: ['wiki'] });
    insertNodeVector(db, 'wiki', 1.0);
    insertNodeVector(db, 'canon', 0.9);

    // Same setup as the first test, but semantic mode builds no nodeMeta → no demotion,
    // so the stronger-vector wiki stays #1. Proves demotion is scoped to hybrid.
    const hits = await hybridSearch(db, queryEmbedder(), 'weekend maritime getaway ideas', { mode: 'semantic', limit: 10 });
    expect(hits[0]?.node_id).toBe('wiki');
  });
});
