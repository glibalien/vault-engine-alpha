import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { hybridSearch } from '../../src/search/search.js';

function insert(db: Database.Database, id: string, title: string, body = ''): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, body);
}
const emb = {
  async embedDocument() { return [new Float32Array(256)]; },
  async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
  isReady: () => true,
};

describe('recall lane (finding #3)', () => {
  it('surfaces a target that strict-AND misses on a filler-heavy query', async () => {
    const db = createTestDb();
    // Query "proposal for the big northwind deal": strict-AND needs ALL tokens in one node.
    // n1 has only the content words -> strict-AND misses it, recall (OR) finds it.
    insert(db, 'n1', 'Northwind Big Deal Proposal', 'the proposal document');
    insert(db, 'n2', 'Weekly Big Meeting', 'notes for the big weekly meeting for the team');
    const hits = await hybridSearch(db, emb, 'proposal for the big northwind deal', { mode: 'hybrid', limit: 10 });
    expect(hits.map((h) => h.node_id)).toContain('n1');
    // Recall hits are still marked 'fts' - no new match_sources value.
    const n1 = hits.find((h) => h.node_id === 'n1');
    expect(n1?.match_sources).toContain('fts');
    expect(n1?.match_sources.every((s) => s === 'fts' || s === 'semantic')).toBe(true);
  });

  it('is gated OFF for a navigational (title-AND) query - behavior unchanged', async () => {
    const db = createTestDb();
    // "Zora Wren" is a confident title-AND hit -> recall lane must not run.
    insert(db, 'n1', 'Zora Wren', 'bio');
    insert(db, 'n2', 'Team Notes', 'Zora attended; Wren also');
    const hits = await hybridSearch(db, emb, 'Zora Wren', { mode: 'hybrid', limit: 10 });
    expect(hits[0]?.node_id).toBe('n1');
  });
});
