import { describe, it, expect, vi } from 'vitest';
import { Notice } from 'obsidian';
import { DiscoverModelsModal } from '../../src/models/discover-modal.js';
import type { ModelService, DiscoverResult, AddResult, ToggleResult } from '../../src/models/discover-service.js';
import type { CatalogEntry, DiscoverItem, DiscoveredModelRow } from '../../src/models/discover-format.js';
import type { PriceChoice } from '../../src/models/price-modal.js';

const APP = {} as never;

const row = (over: Partial<DiscoveredModelRow> = {}): DiscoveredModelRow => ({
  provider: 'openrouter',
  model: 'vendor/slug',
  displayName: 'Slug',
  description: '',
  vision: false,
  tools: false,
  contextLength: null,
  pricing: null,
  serverless: true,
  deprecated: false,
  inCatalog: false,
  ...over,
});

function stubService(over: Partial<ModelService> = {}): ModelService {
  return {
    discover: vi.fn(async (): Promise<DiscoverResult> => ({ ok: true, rows: [] })),
    add: vi.fn(async () => ({ ok: true as const, title: 'X' })),
    toggle: vi.fn(async () => ({ ok: true as const })),
    catalog: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...over,
  };
}

/** A discover mock whose result keeps its literal discriminant (`ok: true|false`). */
const discoverFn = (result: DiscoverResult): ModelService['discover'] => vi.fn(async () => result);

const emptyState = (m: DiscoverModelsModal) => (m as unknown as { emptyStateText: string }).emptyStateText;

// Obsidian HTMLElement augmentations so renderSuggestion runs under jsdom.
function augment<T extends HTMLElement>(el: T): T {
  const e = el as unknown as Record<string, unknown>;
  e.addClass = (c: string) => el.classList.add(c);
  e.setText = (t: string) => { el.textContent = t; };
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

const catalog: CatalogEntry[] = [
  { title: 'Claude', provider: 'openrouter', enabled: true },
  { title: 'Qwen', provider: 'fireworks', enabled: false },
];

describe('DiscoverModelsModal — provider-choice mode', () => {
  it('returns one item per catalog provider regardless of query, no service call', async () => {
    const service = stubService();
    const m = new DiscoverModelsModal(APP, 'provider-choice', service, [], 0);
    const items = await m.getSuggestions('anything');
    expect(items).toEqual([
      { kind: 'provider', provider: 'fireworks' },
      { kind: 'provider', provider: 'anthropic' },
      { kind: 'provider', provider: 'openrouter' },
      { kind: 'provider', provider: 'openai' },
    ]);
    expect(service.discover).not.toHaveBeenCalled();
  });

  it('transitions to remote mode on selecting a provider (stays open, no add)', async () => {
    const service = stubService({ discover: discoverFn({ ok: true, rows: [row()] }) });
    const m = new DiscoverModelsModal(APP, 'provider-choice', service, [], 0);
    m.selectSuggestion({ kind: 'provider', provider: 'openrouter' }, {} as MouseEvent);
    // now in remote mode: a keystroke drives discover with the chosen provider
    const items = await m.getSuggestions('slug');
    expect((service.discover as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('openrouter', 'slug');
    expect(items.map((i) => (i as Extract<DiscoverItem, { kind: 'remote' }>).m.model)).toEqual(['vendor/slug']);
  });
});

describe('DiscoverModelsModal — remote mode', () => {
  function remoteModal(discover: ModelService['discover']) {
    const service = stubService({ discover });
    const m = new DiscoverModelsModal(APP, 'provider-choice', service, [], 0);
    m.selectSuggestion({ kind: 'provider', provider: 'fireworks' }, {} as MouseEvent);
    return { m, service };
  }

  it('returns [] for a blank query without calling discover', async () => {
    const { m, service } = remoteModal(discoverFn({ ok: true, rows: [] }));
    expect(await m.getSuggestions('   ')).toEqual([]);
    expect(service.discover).not.toHaveBeenCalled();
  });

  it('sets a warning empty-state and returns [] on error', async () => {
    const { m } = remoteModal(discoverFn({ ok: false, message: 'boom' }));
    expect(await m.getSuggestions('x')).toEqual([]);
    expect(emptyState(m)).toContain('boom');
  });

  it('sets "No results" on an empty successful discovery', async () => {
    const { m } = remoteModal(discoverFn({ ok: true, rows: [] }));
    await m.getSuggestions('x');
    expect(emptyState(m)).toBe('No results');
  });

  it('drops a superseded query (stale-guard)', async () => {
    const { m } = remoteModal(discoverFn({ ok: true, rows: [row()] }));
    const first = m.getSuggestions('a'); // seq 1
    const second = m.getSuggestions('ab'); // seq 2 supersedes
    expect(await first).toEqual([]);
    expect((await second).length).toBe(1);
  });
});

describe('DiscoverModelsModal — catalog mode', () => {
  it('lists all entries for a blank query and substring-filters', async () => {
    const m = new DiscoverModelsModal(APP, 'catalog', stubService(), catalog, 0);
    expect((await m.getSuggestions('')).length).toBe(2);
    const filtered = await m.getSuggestions('qw');
    expect(filtered).toEqual([{ kind: 'catalog', title: 'Qwen', enabled: false, provider: 'fireworks' }]);
  });

  it('sets an empty-state when nothing matches', async () => {
    const m = new DiscoverModelsModal(APP, 'catalog', stubService(), catalog, 0);
    expect(await m.getSuggestions('zzz')).toEqual([]);
    expect(emptyState(m)).toBe('No matching models');
  });

  it('toggles via the service and flips the held entry so the list re-renders updated', async () => {
    const toggle = vi.fn(async () => ({ ok: true as const }));
    const entries: CatalogEntry[] = [{ title: 'Qwen', provider: 'fireworks', enabled: false }];
    const m = new DiscoverModelsModal(APP, 'catalog', stubService({ toggle }), entries, 0);
    m.selectSuggestion({ kind: 'catalog', title: 'Qwen', enabled: false, provider: 'fireworks' }, {} as MouseEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(toggle).toHaveBeenCalledWith('Qwen', false);
    const after = await m.getSuggestions('');
    expect((after[0] as Extract<DiscoverItem, { kind: 'catalog' }>).enabled).toBe(true);
  });

  it('ignores a re-select of the same row while its toggle is in flight (no double-flip)', async () => {
    let resolveToggle!: (r: ToggleResult) => void;
    const toggle = vi.fn(() => new Promise<ToggleResult>((res) => { resolveToggle = res; }));
    const entries: CatalogEntry[] = [{ title: 'Qwen', provider: 'fireworks', enabled: false }];
    const m = new DiscoverModelsModal(APP, 'catalog', stubService({ toggle }), entries, 0);
    const sel = { kind: 'catalog', title: 'Qwen', enabled: false, provider: 'fireworks' } as const;

    m.selectSuggestion(sel, {} as MouseEvent); // first — in flight
    m.selectSuggestion(sel, {} as MouseEvent); // second — same row still in flight → ignored
    expect(toggle).toHaveBeenCalledTimes(1);

    resolveToggle({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    const after = await m.getSuggestions('');
    // A single net toggle: enabled once (target from the snapshot), not flipped back off.
    expect((after[0] as Extract<DiscoverItem, { kind: 'catalog' }>).enabled).toBe(true);
  });
});

describe('DiscoverModelsModal — remote add (selectSuggestion)', () => {
  const REMOTE = { kind: 'remote', m: row({ inCatalog: false }) } as const;

  it('adds a not-in-catalog row via the service', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add }), [], 0, async () => ({ kind: 'unpriced' }));
    m.selectSuggestion(REMOTE, {} as MouseEvent);
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith('openrouter', 'vendor/slug', undefined));
  });

  it('says how to price a model added without a list price', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const notices = (Notice as unknown as { messages: string[] }).messages;
    for (const pricing of [{ input: 1, output: 2 }, null]) {
      notices.length = 0;
      const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add }), [], 0, async () => ({ kind: 'unpriced' }));
      m.selectSuggestion({ kind: 'remote', m: row({ inCatalog: false, pricing }) }, {} as MouseEvent);
      await vi.waitFor(() => expect(notices).toHaveLength(1));
      if (pricing) expect(notices[0]).toBe('Added "Slug" to the model catalog');
      else expect(notices[0]).toContain('no list price: add price_input and price_output');
    }
  });

  it('asks for a price before adding an unpriced model, and adds it with that price (#273)', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const askPrice = vi.fn(async (): Promise<PriceChoice> => ({ kind: 'priced', pricing: { input: 3, output: 15 } }));
    const close = vi.fn(async () => {});
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add, close }), [], 0, askPrice);
    m.selectSuggestion({ kind: 'remote', m: row({ pricing: null }) }, {} as MouseEvent);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(askPrice).toHaveBeenCalledWith(expect.objectContaining({ model: 'vendor/slug' }));
    expect(add).toHaveBeenCalledWith('openrouter', 'vendor/slug', { input: 3, output: 15 });
    expect(notices[0]).toBe('Added "Slug" to the model catalog');
    expect(close).toHaveBeenCalled();
  });

  it('adds without a price when asked to, and still says how to price it later', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add }), [], 0, async () => ({ kind: 'unpriced' }));
    m.selectSuggestion({ kind: 'remote', m: row({ pricing: null }) }, {} as MouseEvent);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(add).toHaveBeenCalledWith('openrouter', 'vendor/slug', undefined);
    expect(notices[0]).toContain('no list price: add price_input and price_output');
  });

  it('cancelling the price form adds nothing and keeps the window open', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const close = vi.fn(async () => {});
    let answered = false;
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add, close }), [], 0,
      async () => { answered = true; return { kind: 'cancel' }; });
    m.selectSuggestion({ kind: 'remote', m: row({ pricing: null }) }, {} as MouseEvent);
    await vi.waitFor(() => expect(answered).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(add).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not ask for a price when the model has one', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const askPrice = vi.fn(async (): Promise<PriceChoice> => ({ kind: 'cancel' }));
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add }), [], 0, askPrice);
    m.selectSuggestion({ kind: 'remote', m: row({ pricing: { input: 1, output: 2 } }) }, {} as MouseEvent);
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith('openrouter', 'vendor/slug', undefined));
    expect(askPrice).not.toHaveBeenCalled();
  });

  it('does not add a row already in the catalog', async () => {
    const add = vi.fn(async () => ({ ok: true as const, title: 'Slug' }));
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add }), [], 0);
    m.selectSuggestion({ kind: 'remote', m: row({ inCatalog: true }) }, {} as MouseEvent);
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
  });

  it('awaits the add before tearing the connection down (close does not race the POST)', async () => {
    const order: string[] = [];
    let resolveAdd!: (r: AddResult) => void;
    const add = vi.fn(() => new Promise<AddResult>((res) => { resolveAdd = res; }));
    const close = vi.fn(async () => { order.push('close'); });
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService({ add, close }), [], 0, async () => ({ kind: 'unpriced' }));

    m.selectSuggestion(REMOTE, {} as MouseEvent);
    await Promise.resolve();
    expect(add).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled(); // still open while the add POST is in flight

    resolveAdd({ ok: true, title: 'Slug' });
    order.push('add-resolved');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);        // connection torn down only after the add settled
    expect(order).toEqual(['add-resolved', 'close']);
  });
});

describe('DiscoverModelsModal.renderSuggestion', () => {
  it('renders a two-line remote row (display name + detail) as inert text', () => {
    const m = new DiscoverModelsModal(APP, 'provider-choice', stubService(), [], 0);
    const el = augment(document.createElement('div'));
    m.renderSuggestion({ kind: 'remote', m: row({ displayName: 'Slug', vision: true }) }, el);
    expect(el.querySelector('.ve-model-title')?.textContent).toBe('Slug');
    expect(el.querySelector('.ve-model-detail')?.textContent).toBe('vendor/slug · 👁 vision · no list price');
  });

  it('renders a catalog row as a single labelled line', () => {
    const m = new DiscoverModelsModal(APP, 'catalog', stubService(), catalog, 0);
    const el = augment(document.createElement('div'));
    m.renderSuggestion({ kind: 'catalog', title: 'Qwen', enabled: false, provider: 'fireworks' }, el);
    expect(el.textContent).toBe('Qwen — fireworks · disabled');
  });
});
