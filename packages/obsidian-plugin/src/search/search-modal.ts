import { SuggestModal, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { Searcher } from './searcher.js';
import { parseSnippet, type SearchHit } from './search.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Center-of-screen vault search. Debounces keystrokes and drops superseded
 *  responses via a sequence counter; the heavy lifting (the engine call and
 *  snippet parsing) lives in `Searcher` and `parseSnippet`. */
export class VaultSearchModal extends SuggestModal<SearchHit> {
  private seq = 0;

  constructor(
    app: App,
    private readonly searcher: Searcher,
    private readonly debounceMs = 200,
  ) {
    super(app);
    this.setPlaceholder('Search the vault…');
  }

  async getSuggestions(query: string): Promise<SearchHit[]> {
    const q = query.trim();
    this.emptyStateText = ''; // clear any stale warning / "No results" from a prior query
    if (!q) return [];
    const mySeq = ++this.seq;
    await sleep(this.debounceMs);
    if (mySeq !== this.seq) return []; // superseded by a newer keystroke
    const result = await this.searcher.search(q);
    if (mySeq !== this.seq) return []; // superseded while the request was in flight
    if (!result.ok) {
      this.emptyStateText = `⚠ ${result.message}`;
      return [];
    }
    if (result.hits.length === 0) this.emptyStateText = 'No results';
    return result.hits;
  }

  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    el.addClass('ve-search-item');

    const titleEl = el.createDiv({ cls: 've-search-title' });
    const icon = titleEl.createSpan({ cls: 've-search-icon' });
    setIcon(icon, 'file-text');
    titleEl.createSpan({ text: hit.title });

    if (hit.snippet) {
      const snip = el.createDiv({ cls: 've-search-snip' });
      for (const seg of parseSnippet(hit.snippet)) {
        if (seg.mark) snip.createEl('mark', { text: seg.text });
        else snip.createSpan({ text: seg.text });
      }
    }

    const meta = el.createDiv({ cls: 've-search-meta' });
    meta.createSpan({ text: hit.type });
    meta.createSpan({ cls: 've-search-score', text: `Relevance ${hit.score.toFixed(2)}` });
  }

  onChooseSuggestion(hit: SearchHit): void {
    void this.app.workspace.openLinkText(hit.file_path, '', false);
  }

  onClose(): void {
    super.onClose();
    void this.searcher.close();
  }
}
