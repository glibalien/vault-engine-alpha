import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { buildFtsMatchQuery, hybridSearch } from '../../src/search/search.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

function insertNode(db: Database.Database, id: string, title: string, body: string | null = null): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `/${id}.md`, title, body);
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)').run(id, title, body);
}

// FTS-mode search needs no real vectors; this embedder is never asked to embed in mode:'fts'.
const noEmbedder = null as unknown as Embedder;

describe('buildFtsMatchQuery (b02)', () => {
  it('quotes each loose token (operator/punctuation-neutral)', () => {
    expect(buildFtsMatchQuery('machine learning')).toBe('"machine" "learning"');
    expect(buildFtsMatchQuery('cost/benefit')).toBe('"cost" "benefit"');
    expect(buildFtsMatchQuery('AND OR')).toBe('"AND" "OR"');
  });

  it('preserves a double-quoted phrase as an FTS5 phrase', () => {
    expect(buildFtsMatchQuery('"machine learning"')).toBe('"machine learning"');
    expect(buildFtsMatchQuery('"machine learning" cars')).toBe('"machine learning" "cars"');
    expect(buildFtsMatchQuery('fast "machine learning" now')).toBe('"fast" "machine learning" "now"');
  });

  it('returns empty string when there are no searchable tokens', () => {
    expect(buildFtsMatchQuery('')).toBe('');
    expect(buildFtsMatchQuery('   ')).toBe('');
    expect(buildFtsMatchQuery('!!! ??? ---')).toBe('');
    expect(buildFtsMatchQuery('""')).toBe('');
  });

  it('tolerates an unbalanced quote without throwing', () => {
    // The dangling quote opens a phrase that runs to end-of-string.
    expect(buildFtsMatchQuery('foo "bar baz')).toBe('"foo" "bar" "baz"');
  });
});

describe('FTS ranked lane robustness + phrase (b02)', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it('matches a punctuation query that would have raised an FTS5 syntax error', async () => {
    insertNode(db, 'n1', 'Cost benefit analysis', 'weighing cost against benefit');
    const onFtsError = vi.fn();
    const results = await hybridSearch(db, noEmbedder, 'cost/benefit', { mode: 'fts', limit: 10, onFtsError });
    expect(onFtsError).not.toHaveBeenCalled();
    expect(results.map((r) => r.node_id)).toContain('n1');
  });

  it('a quoted phrase matches adjacent terms only', async () => {
    insertNode(db, 'adj', 'Machine learning intro', 'machine learning is great');
    insertNode(db, 'apart', 'Learning notes', 'learning about a machine');
    const results = await hybridSearch(db, noEmbedder, '"machine learning"', { mode: 'fts', limit: 10 });
    const ids = results.map((r) => r.node_id);
    expect(ids).toContain('adj');
    expect(ids).not.toContain('apart');
  });

  it('a query of only punctuation yields no FTS hits and no error', async () => {
    insertNode(db, 'n1', 'Something', 'content');
    const onFtsError = vi.fn();
    const results = await hybridSearch(db, noEmbedder, '!!!', { mode: 'fts', limit: 10, onFtsError });
    expect(onFtsError).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
