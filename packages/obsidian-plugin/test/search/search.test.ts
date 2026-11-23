import { describe, it, expect, vi } from 'vitest';
import type { NodeRow } from '@vault/query-core';
import {
  buildSearchArgs,
  toSearchHit,
  parseSnippet,
  searchVault,
  SEARCH_MODES,
  SEARCH_RESULT_LIMIT,
} from '../../src/search/search.js';

function node(over: Partial<NodeRow>): NodeRow {
  return { id: 'n', file_path: 'a.md', title: 'A', types: ['note'], version: 1, field_count: 0, ...over };
}

describe('SEARCH_MODES / limit', () => {
  it('lists the three modes with hybrid first', () => {
    expect(SEARCH_MODES.map((m) => m.value)).toEqual(['hybrid', 'fts', 'semantic']);
  });
  it('requests a deep relevance window', () => {
    expect(SEARCH_RESULT_LIMIT).toBe(100);
  });
});

describe('buildSearchArgs', () => {
  it('produces the query-nodes search shape', () => {
    expect(buildSearchArgs('foo', 'fts', 20)).toEqual({ query: 'foo', search_mode: 'fts', limit: 20 });
  });
});

describe('toSearchHit', () => {
  it('maps fields and keeps a present title', () => {
    const hit = toSearchHit(node({ file_path: 'd/Note.md', title: 'Real', types: ['task'], snippet: 's', score: 1.5 }));
    expect(hit).toEqual({ file_path: 'd/Note.md', title: 'Real', type: 'task', snippet: 's', score: 1.5 });
  });
  it('falls back title to the basename without .md when title is null/blank', () => {
    expect(toSearchHit(node({ file_path: 'dir/My File.md', title: null })).title).toBe('My File');
    expect(toSearchHit(node({ file_path: 'X.md', title: '  ' })).title).toBe('X');
  });
  it('falls back type to "node" and defaults snippet/score', () => {
    const hit = toSearchHit(node({ types: [], snippet: undefined, score: undefined }));
    expect(hit.type).toBe('node');
    expect(hit.snippet).toBe('');
    expect(hit.score).toBe(0);
  });
});

describe('parseSnippet', () => {
  it('returns one plain segment when there is no mark', () => {
    expect(parseSnippet('hello world')).toEqual([{ text: 'hello world', mark: false }]);
  });
  it('splits a single mark with surrounding text', () => {
    expect(parseSnippet('a <mark>b</mark> c')).toEqual([
      { text: 'a ', mark: false },
      { text: 'b', mark: true },
      { text: ' c', mark: false },
    ]);
  });
  it('handles adjacent and leading/trailing marks', () => {
    expect(parseSnippet('<mark>x</mark><mark>y</mark>')).toEqual([
      { text: 'x', mark: true },
      { text: 'y', mark: true },
    ]);
  });
  it('degrades an unclosed mark to plain text', () => {
    expect(parseSnippet('a <mark>b c')).toEqual([{ text: 'a <mark>b c', mark: false }]);
  });
  it('returns [] for an empty snippet', () => {
    expect(parseSnippet('')).toEqual([]);
  });
});

describe('searchVault', () => {
  it('calls query-nodes with the search args and maps hits', async () => {
    const queryNodes = vi.fn(async () => ({
      ok: true as const,
      data: { nodes: [node({ title: 'Hit', score: 2 })], total: 1 },
      warnings: [],
    }));
    const res = await searchVault({ queryNodes }, 'q', 'hybrid', 20);
    expect(queryNodes).toHaveBeenCalledWith({ query: 'q', search_mode: 'hybrid', limit: 20 });
    expect(res).toEqual({ ok: true, hits: [{ file_path: 'a.md', title: 'Hit', type: 'note', snippet: '', score: 2 }] });
  });
  it('surfaces an engine error envelope as ok:false', async () => {
    const queryNodes = vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'nope' }, warnings: [] }));
    expect(await searchVault({ queryNodes }, 'q', 'hybrid', 20)).toEqual({ ok: false, message: 'nope' });
  });
  it('returns an empty hit list when the engine returns no nodes', async () => {
    const queryNodes = vi.fn(async () => ({ ok: true as const, data: { nodes: [], total: 0 }, warnings: [] }));
    expect(await searchVault({ queryNodes }, 'q', 'semantic', 20)).toEqual({ ok: true, hits: [] });
  });

  it('returns the complete engine-ranked window without reordering or truncating it', async () => {
    const nodes = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, index) =>
      node({
        id: `n-${index}`,
        file_path: `${index}.md`,
        title: `Hit ${index}`,
        score: SEARCH_RESULT_LIMIT - index,
      }),
    );
    const queryNodes = vi.fn(async () => ({
      ok: true as const,
      data: { nodes, total: nodes.length },
      warnings: [],
    }));

    const result = await searchVault({ queryNodes }, 'q', 'hybrid', SEARCH_RESULT_LIMIT);

    expect(queryNodes).toHaveBeenCalledWith({ query: 'q', search_mode: 'hybrid', limit: 100 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hits).toHaveLength(100);
      expect(result.hits[20]?.title).toBe('Hit 20');
      expect(result.hits.map((hit) => hit.title)).toEqual(nodes.map((item) => item.title));
    }
  });
});
