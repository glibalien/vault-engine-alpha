import { describe, it, expect, vi } from 'vitest';
import { VaultSearchModal } from '../../src/search/search-modal.js';
import type { Searcher } from '../../src/search/searcher.js';
import type { SearchHit, SearchResult } from '../../src/search/search.js';

const APP = {} as never;
const hit = (title: string): SearchHit => ({ file_path: `${title}.md`, title, type: 'note', snippet: '', score: 1 });

function modal(search: (q: string) => Promise<SearchResult>) {
  const searcher: Searcher = { search: vi.fn(search), close: vi.fn(async () => {}) };
  // debounceMs = 0 → deterministic, no fake timers needed
  const m = new VaultSearchModal(APP, searcher, 0);
  return { m, searcher };
}
const emptyState = (m: VaultSearchModal) => (m as unknown as { emptyStateText: string }).emptyStateText;

// Minimal Obsidian HTMLElement augmentations so renderSuggestion can run under jsdom.
function augment<T extends HTMLElement>(el: T): T {
  const e = el as unknown as Record<string, unknown>;
  e.addClass = (c: string) => el.classList.add(c);
  e.createEl = (tag: string, o?: { text?: string; cls?: string }) => {
    const child = document.createElement(tag);
    if (o?.text != null) child.textContent = o.text;
    if (o?.cls) child.className = o.cls;
    el.appendChild(child);
    return augment(child);
  };
  e.createDiv = (o?: { cls?: string }) => (e.createEl as (t: string, o?: unknown) => HTMLElement)('div', o);
  e.createSpan = (o?: { text?: string; cls?: string }) => (e.createEl as (t: string, o?: unknown) => HTMLElement)('span', o);
  return el;
}

describe('VaultSearchModal.getSuggestions', () => {
  it('returns [] for a blank query without calling the searcher', async () => {
    const { m, searcher } = modal(async () => ({ ok: true, hits: [] }));
    expect(await m.getSuggestions('   ')).toEqual([]);
    expect(searcher.search).not.toHaveBeenCalled();
  });

  it('returns mapped hits on success', async () => {
    const { m } = modal(async () => ({ ok: true, hits: [hit('A'), hit('B')] }));
    expect((await m.getSuggestions('a')).map((h) => h.title)).toEqual(['A', 'B']);
  });

  it('exposes every fetched hit in engine order, including hits below position 20', async () => {
    const hits = Array.from({ length: 100 }, (_, index) => hit(`Hit ${index}`));
    const { m } = modal(async () => ({ ok: true, hits }));

    const suggestions = await m.getSuggestions('a');

    expect(suggestions).toHaveLength(100);
    expect(suggestions[20]?.title).toBe('Hit 20');
    expect(suggestions.map((suggestion) => suggestion.title)).toEqual(hits.map((item) => item.title));
  });

  it('sets a warning empty-state and returns [] on error', async () => {
    const { m } = modal(async () => ({ ok: false, message: 'boom' }));
    expect(await m.getSuggestions('a')).toEqual([]);
    expect(emptyState(m)).toContain('boom');
  });

  it('sets "No results" when the search succeeds with zero hits', async () => {
    const { m } = modal(async () => ({ ok: true, hits: [] }));
    await m.getSuggestions('a');
    expect(emptyState(m)).toBe('No results');
  });

  it('drops a superseded query (stale-guard)', async () => {
    const { m } = modal(async () => ({ ok: true, hits: [hit('A')] }));
    const first = m.getSuggestions('a'); // seq = 1
    const second = m.getSuggestions('ab'); // seq = 2 — supersedes #1
    expect(await first).toEqual([]);
    expect((await second).map((h) => h.title)).toEqual(['A']);
  });

  it('clears a stale warning when the query becomes blank', async () => {
    const { m } = modal(async () => ({ ok: false, message: 'boom' }));
    await m.getSuggestions('a');
    expect(emptyState(m)).toContain('boom');
    expect(await m.getSuggestions('')).toEqual([]); // clearing the box must not keep the warning
    expect(emptyState(m)).toBe('');
  });

  it('drops a query superseded while its request is in flight (post-await guard)', async () => {
    let resolveFirst!: (r: SearchResult) => void;
    const searcher: Searcher = {
      search: vi.fn((q: string) =>
        q === 'a'
          ? new Promise<SearchResult>((res) => { resolveFirst = res; }) // first call hangs
          : Promise.resolve({ ok: true, hits: [hit('B')] } as SearchResult)),
      close: vi.fn(async () => {}),
    };
    const m = new VaultSearchModal(APP, searcher, 0);
    const first = m.getSuggestions('a');                 // seq=1; will hang inside searcher.search
    await new Promise((r) => setTimeout(r, 0));           // let #1 pass its debounce and enter search()
    const second = m.getSuggestions('ab');               // seq=2 supersedes #1
    resolveFirst({ ok: true, hits: [hit('A')] });        // #1 resolves AFTER being superseded
    expect(await first).toEqual([]);                     // dropped by the post-await guard
    expect((await second).map((h) => h.title)).toEqual(['B']);
  });
});

describe('VaultSearchModal.renderSuggestion', () => {
  it('labels ranking as relevance instead of exposing the RRF algorithm name', () => {
    const { m } = modal(async () => ({ ok: true, hits: [] }));
    const el = augment(document.createElement('div'));
    m.renderSuggestion(hit('A'), el);
    expect(el.querySelector('.ve-search-score')?.textContent).toBe('Relevance 1.00');
    expect(el.textContent).not.toContain('rrf');
  });

  it('renders snippet <mark> as inert text, not injected HTML (XSS-safe)', () => {
    const { m } = modal(async () => ({ ok: true, hits: [] }));
    const el = augment(document.createElement('div'));
    const malicious: SearchHit = {
      file_path: 'x.md', title: 'X', type: 'note', score: 1,
      snippet: 'a <mark><img src=x onerror=alert(1)></mark> b',
    };
    m.renderSuggestion(malicious, el);
    expect(el.querySelector('img')).toBeNull(); // no element was injected
    expect(el.querySelector('mark')?.textContent).toBe('<img src=x onerror=alert(1)>'); // literal text
  });
});
