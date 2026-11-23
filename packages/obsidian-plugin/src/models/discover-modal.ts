import { Notice, SuggestModal } from 'obsidian';
import type { App } from 'obsidian';
import { MODEL_PROVIDERS, PROVIDERS, type ModelProvider } from '@vault/settings-registry';
import type { ModelService } from './discover-service.js';
import { askModelPrice, type ModelPricingInput, type PriceChoice } from './price-modal.js';
import {
  remoteDetailLine,
  catalogDetailLine,
  type CatalogEntry,
  type DiscoverItem,
  type DiscoveredModelRow,
} from './discover-format.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One SuggestModal serving both models commands:
 *  - "Discover models" opens in `provider-choice` (one item per catalog provider) → choosing a
 *    provider transitions to `remote` (debounced `discover-models`), then choosing
 *    a row adds it via `add-model`.
 *  - "Manage models" opens in `catalog` — the current Settings/Models entries,
 *    substring-filtered; choosing one toggles its `enabled`.
 *
 * Async fetching mirrors VaultSearchModal exactly: 250ms debounce + a sequence
 * counter that drops superseded responses (both after the sleep and after the
 * request), with `emptyStateText` carrying errors / "No results".
 *
 * `selectSuggestion` is overridden so provider-choice and catalog-toggle actions
 * keep the modal open (the default closes on any choose); only a remote add closes.
 */
export class DiscoverModelsModal extends SuggestModal<DiscoverItem> {
  private seq = 0;
  private mode: 'provider-choice' | 'remote' | 'catalog';
  private provider: ModelProvider | null = null;
  private readonly togglingTitles = new Set<string>();

  constructor(
    hostApp: App,
    initialMode: 'provider-choice' | 'catalog',
    private readonly service: ModelService,
    private catalogEntries: CatalogEntry[],
    private readonly debounceMs = 250,
    /** Asks for a price before adding a model with no list price; injectable for tests. */
    private readonly askPrice: (m: DiscoveredModelRow) => Promise<PriceChoice> = (m) => askModelPrice(hostApp, m.displayName),
  ) {
    super(hostApp);
    this.mode = initialMode;
    this.setPlaceholder(
      initialMode === 'catalog' ? 'Filter catalog models to enable/disable…' : 'Choose a provider to discover models…',
    );
  }

  async getSuggestions(query: string): Promise<DiscoverItem[]> {
    if (this.mode === 'provider-choice') {
      return MODEL_PROVIDERS.map((provider) => ({ kind: 'provider', provider }));
    }

    if (this.mode === 'catalog') {
      this.emptyStateText = '';
      const q = query.trim().toLowerCase();
      const items: DiscoverItem[] = this.catalogEntries
        .filter((e) => !q || e.title.toLowerCase().includes(q))
        .map((e) => ({ kind: 'catalog', title: e.title, enabled: e.enabled, provider: e.provider }));
      if (items.length === 0) this.emptyStateText = q ? 'No matching models' : 'No models in catalog';
      return items;
    }

    // remote — debounced discover-models, superseding stale responses
    this.emptyStateText = '';
    const q = query.trim();
    if (!q) return [];
    const mySeq = ++this.seq;
    await sleep(this.debounceMs);
    if (mySeq !== this.seq) return []; // superseded by a newer keystroke
    const result = await this.service.discover(this.provider!, q);
    if (mySeq !== this.seq) return []; // superseded while the request was in flight
    if (!result.ok) {
      this.emptyStateText = `⚠ ${result.message}`;
      return [];
    }
    if (result.rows.length === 0) this.emptyStateText = 'No results';
    return result.rows.map((m) => ({ kind: 'remote', m }));
  }

  renderSuggestion(item: DiscoverItem, el: HTMLElement): void {
    if (item.kind === 'provider') {
      el.setText(`Discover ${PROVIDERS[item.provider].label} models`);
      return;
    }
    if (item.kind === 'catalog') {
      el.setText(catalogDetailLine(item));
      return;
    }
    el.addClass('ve-model-item');
    const titleEl = el.createDiv({ cls: 've-model-title' });
    titleEl.createSpan({ text: item.m.displayName });
    const detail = el.createDiv({ cls: 've-model-detail' });
    detail.createSpan({ text: remoteDetailLine(item.m) });
  }

  /** All three item kinds are handled here; `super.selectSuggestion` (which
   *  would close the modal synchronously) is never called. Provider-choice and
   *  catalog-toggle keep the modal open; a remote add closes only AFTER its
   *  POST settles (see `chooseRemote`). */
  selectSuggestion(item: DiscoverItem, _evt: MouseEvent | KeyboardEvent): void {
    if (item.kind === 'provider') {
      this.provider = item.provider;
      this.mode = 'remote';
      this.setPlaceholder(`Search ${PROVIDERS[item.provider].label} models…`);
      this.inputEl.value = '';
      this.inputEl.dispatchEvent(new Event('input')); // re-run getSuggestions for the empty query
      return; // stay open
    }
    if (item.kind === 'catalog') {
      void this.handleToggle(item);
      return; // stay open; handleToggle re-renders the list
    }
    void this.chooseRemote(item.m); // remote add → await, then close
  }

  /** Retained because SuggestModal requires it; the live flow runs through
   *  `selectSuggestion` (so a remote add can settle before `close()`), so this
   *  is only reachable if Obsidian ever invokes it directly. */
  onChooseSuggestion(item: DiscoverItem): void {
    if (item.kind === 'remote') void this.chooseRemote(item.m);
  }

  /**
   * Await the add BEFORE closing. Closing runs `onClose → service.close()`,
   * which DELETEs the MCP session; if the modal closed synchronously while the
   * add-model POST was still in flight, the session teardown could beat it —
   * yielding a spurious "add failed" Notice and an ambiguous mint state.
   */
  private async chooseRemote(m: DiscoveredModelRow): Promise<void> {
    // Cancelling the price form keeps this window open, so another model can be picked.
    if (await this.handleAdd(m) === 'cancelled') return;
    this.close();
  }

  private async handleAdd(m: DiscoveredModelRow): Promise<'done' | 'cancelled'> {
    if (m.inCatalog) {
      new Notice('Already in catalog');
      return 'done';
    }
    // A model with no list price: ask for one first (#273).
    let pricing: ModelPricingInput | undefined;
    if (!m.pricing) {
      const choice = await this.askPrice(m);
      if (choice.kind === 'cancel') return 'cancelled';
      if (choice.kind === 'priced') pricing = choice.pricing;
    }
    const res = await this.service.add(m.provider, m.model, pricing);
    if (!res.ok) {
      new Notice(res.message);
      return 'done';
    }
    new Notice(m.pricing || pricing
      ? `Added "${res.title}" to the model catalog`
      : `Added "${res.title}" to the model catalog. It has no list price: add price_input and price_output (USD per million tokens) to its note in Settings/Models, or Curator's daily budget refuses it.`);
    return 'done';
  }

  private async handleToggle(item: Extract<DiscoverItem, { kind: 'catalog' }>): Promise<void> {
    // Ignore a re-select of the same row while its toggle is in flight — a
    // second flip would race the first write and desync the live-mutated local
    // `enabled`. `target` is snapshotted from the item at invocation so the
    // local update never reads back the value we ourselves just mutated.
    if (this.togglingTitles.has(item.title)) return;
    this.togglingTitles.add(item.title);
    const target = !item.enabled;
    try {
      const res = await this.service.toggle(item.title, item.enabled);
      if (!res.ok) {
        new Notice(res.message);
        return;
      }
      // Mirror the state we just wrote (the engine catalog invalidates live on
      // this tool-path write) so the re-render reflects it.
      const entry = this.catalogEntries.find((e) => e.title === item.title);
      if (entry) entry.enabled = target;
      new Notice(`${item.title} ${target ? 'enabled' : 'disabled'}`);
      this.inputEl.dispatchEvent(new Event('input')); // re-render the filtered list
    } finally {
      this.togglingTitles.delete(item.title);
    }
  }

  onClose(): void {
    super.onClose();
    void this.service.close();
  }
}
