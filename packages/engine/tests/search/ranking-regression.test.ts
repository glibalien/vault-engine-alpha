import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { hybridSearch } from '../../src/search/search.js';

function insert(db: Database.Database, id: string, title: string, body = ''): void {
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

function vectorWithFirst(value: number): Uint8Array {
  const v = new Float32Array(256);
  v[0] = value;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function insertEmbedding(
  db: Database.Database,
  nodeId: string,
  sourceType: 'node' | 'extraction',
  chunkIndex: number,
  firstComponent: number,
  extractionRef: string | null = null,
): void {
  const sourceHash = `${nodeId}-${sourceType}-${chunkIndex}`;
  db.prepare(`
    INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
    VALUES (?, ?, ?, ?, ?, 't')
  `).run(nodeId, sourceType, sourceHash, chunkIndex, extractionRef);
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES ((SELECT id FROM embedding_meta WHERE source_hash = ?), ?)')
    .run(sourceHash, vectorWithFirst(firstComponent));
}

describe('ranking regression guard', () => {
  it('a unique exact title with no competing body matches ranks #1 (fts)', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Zebra Protocol Handbook', 'contents about the handbook');
    insert(db, 'n2', 'Unrelated Note', 'nothing relevant here');
    const hits = await hybridSearch(db, null, 'Zebra Protocol Handbook', { mode: 'fts', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('fts mode never emits semantic sources and needs no embedder', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Alpha', 'beta gamma');
    const hits = await hybridSearch(db, null, 'alpha', { mode: 'fts', limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.match_sources.length === 1 && h.match_sources[0] === 'fts')).toBe(true);
  });

  it('candidate filter restricts results', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Shared Term One', 'x');
    insert(db, 'n2', 'Shared Term Two', 'y');
    const hits = await hybridSearch(db, null, 'Shared Term', { mode: 'fts', candidateIds: ['n2'], limit: 10 });
    expect(hits.map((h) => h.node_id)).not.toContain('n1');
  });

  it('a title match outranks body-only mentions of the same term (fts)', async () => {
    const db = createTestDb();
    // n1 has the term ONLY in its title; n2/n3 repeat it in the body.
    insert(db, 'n1', 'Zora Wren', 'profile of a colleague');
    insert(db, 'n2', 'Project Retro', 'thanks to Zora Wren Zora Wren for the help');
    insert(db, 'n3', 'Standup Log', 'Zora Wren Zora Wren Zora Wren attended');
    const hits = await hybridSearch(db, null, 'Zora Wren', { mode: 'fts', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('an exact title match ranks #1 in hybrid even when another node dominates semantics', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Zora Wren', 'short');
    insert(db, 'n2', 'Team Directory', 'Zora Wren and many other colleagues are listed here in detail');
    // Fake embedder: make n2 the strongest semantic hit, n1 weak — the precision lane must still win.
    const emb = {
      async embedDocument() { return [new Float32Array(256)]; },
      async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
      isReady: () => true,
    };
    // Seed one vector for n2 close to the query, none for n1.
    db.prepare("INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n2','node','h',0,NULL,'t')").run();
    const close = new Float32Array(256); close[0] = 1;
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES ((SELECT id FROM embedding_meta WHERE node_id = ?), ?)')
      .run('n2', new Uint8Array(close.buffer, close.byteOffset, close.byteLength));

    const hits = await hybridSearch(db, emb, 'Zora Wren', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('exact-title lane matches non-ASCII uppercase titles (Unicode casefold bug)', async () => {
    const db = createTestDb();
    // n1 has a non-ASCII uppercase title; n2 repeats the query term in the body.
    // JS toLowerCase() is Unicode-aware (Ü→ü) but SQLite lower() is ASCII-only (Ü stays Ü).
    // Without the fix, the exact-title lane misses n1 and n2 wins via body+semantic hits.
    insert(db, 'n1', 'ÜBER MARTIN', 'short bio');
    insert(db, 'n2', 'Team Notes', 'über martin über martin über martin über martin über martin');
    // Fake embedder: make n2 the strongest semantic hit so the precision lane must rescue n1.
    const emb = {
      async embedDocument() { return [new Float32Array(256)]; },
      async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
      isReady: () => true,
    };
    // Seed one vector for n2 close to the query, none for n1.
    db.prepare("INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n2','node','h2',0,NULL,'t')").run();
    const close = new Float32Array(256); close[0] = 1;
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES ((SELECT id FROM embedding_meta WHERE node_id = ?), ?)')
      .run('n2', new Uint8Array(close.buffer, close.byteOffset, close.byteLength));

    const hits = await hybridSearch(db, emb, 'ÜBER MARTIN', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('fts mode: exact-title lane rescues a punctuation-heavy title that FTS5 cannot match', async () => {
    const db = createTestDb();
    // The title contains FTS5-special characters (double-quotes, ampersand, plus sign) that
    // cause the MATCH query to either throw or return zero rows — the exact-title SQL lane
    // must still surface the node because it uses a plain equality predicate, not MATCH.
    const punct = 'C++ & "Notes"';
    insert(db, 'n1', punct, 'short intro');
    insert(db, 'n2', 'Unrelated Entry', 'body text with nothing special');
    // Query the exact title in fts mode (no embedder needed).
    // ftsSearch() will throw on the MATCH syntax and return []; the exact-title lane must
    // still award n1 the bonus so it appears as hits[0].
    const hits = await hybridSearch(db, null, punct, { mode: 'fts', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('semantic mode: exact-title bonus beats a stronger semantic competitor', async () => {
    const db = createTestDb();
    // n1 has the exact title being queried; n2 has no title match but gets the closest vector.
    insert(db, 'n1', 'Solstice Report', 'brief note');
    insert(db, 'n2', 'Other', 'detailed analysis of the solstice and seasonal observations');
    // Fake embedder: n2 gets a vector very close to the query; n1 gets none.
    const emb = {
      async embedDocument() { return [new Float32Array(256)]; },
      async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
      isReady: () => true,
    };
    db.prepare("INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n2','node','hS',0,NULL,'t')").run();
    const close = new Float32Array(256); close[0] = 1;
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES ((SELECT id FROM embedding_meta WHERE node_id = ?), ?)')
      .run('n2', new Uint8Array(close.buffer, close.byteOffset, close.byteLength));

    const hits = await hybridSearch(db, emb, 'Solstice Report', { mode: 'semantic', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('semantic ranking is invariant to extra chunks from the same node', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Precise Concept', 'the single closest semantic chunk');
    insert(db, 'n2', 'Chunky Attachment Note', 'many slightly weaker chunks from one node');

    insertEmbedding(db, 'n1', 'node', 0, 1.0);
    for (let chunk = 0; chunk < 8; chunk++) {
      insertEmbedding(db, 'n2', 'node', chunk, 0.9);
    }

    const hits = await hybridSearch(db, queryEmbedder(), 'semantic chunk collapse', { mode: 'semantic', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });

  it('node text evidence beats a closer extraction after source weighting', async () => {
    const db = createTestDb();
    insert(db, 'n1', 'Canonical Person Note', 'owned note text should be preferred');
    insert(db, 'n2', 'Attachment-Backed Interview', 'metadata for an extracted attachment');

    insertEmbedding(db, 'n1', 'node', 0, 0.99);
    insertEmbedding(db, 'n2', 'extraction', 3, 1.0, 'attachments/noisy-interview.pdf');

    const hits = await hybridSearch(db, queryEmbedder(), 'person from attachment noise', { mode: 'semantic', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');

    const canonicalHit = hits.find((hit) => hit.node_id === 'n1');
    const extractionHit = hits.find((hit) => hit.node_id === 'n2');
    expect(canonicalHit?.score).toBeGreaterThan(extractionHit?.score ?? 0);
    expect(extractionHit?.match_sources).toEqual(['semantic']);
    expect(extractionHit?.matched_embed).toBe('attachments/noisy-interview.pdf');
    expect(extractionHit?.matched_chunk_index).toBe(3);
  });

  it('partial title-token query beats a stronger semantic competitor in hybrid (query-adaptive)', async () => {
    const db = createTestDb();
    // n1: the true target. The query token "quorra" is in its title but is NOT the whole title,
    // so the exact-title lane does NOT fire — only the title-AND confidence signal can save it.
    insert(db, 'n1', 'Mina Quorra', 'short bio');
    // n2: a topical competitor with NO FTS match for "quorra" but several close chunk vectors.
    insert(db, 'n2', 'Team Directory', 'a listing of many colleagues across the org');

    const emb = {
      async embedDocument() { return [new Float32Array(256)]; },
      async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
      isReady: () => true,
    };
    // Seed several close chunk vectors for n2, none for n1. Chunk collapse turns them into
    // one semantic contribution; this still verifies that query-adaptive semantic
    // down-weighting preserves the partial-title precision signal.
    for (let chunk = 0; chunk < 3; chunk++) {
      db.prepare("INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n2','node',?,?,NULL,'t')")
        .run(`h${chunk}`, chunk);
      const close = new Float32Array(256); close[0] = 1;
      db.prepare('INSERT INTO embedding_vec (id, vector) VALUES ((SELECT id FROM embedding_meta WHERE node_id = ? AND chunk_index = ?), ?)')
        .run('n2', chunk, new Uint8Array(close.buffer, close.byteOffset, close.byteLength));
    }

    const hits = await hybridSearch(db, emb, 'quorra', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });
});
