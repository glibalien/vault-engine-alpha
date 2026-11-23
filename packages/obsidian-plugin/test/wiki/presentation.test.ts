import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MarkdownView, type MarkdownPostProcessor, type MarkdownPostProcessorContext } from 'obsidian';
import VaultEnginePlugin from '../../src/main.js';
import { LastMarkdownTarget } from '../../src/provenance/note-target.js';
import { VaultMapIndex, vaultMapFrom, type VaultMap } from '../../src/engine/vault-map.js';

vi.mock('../../src/view/engine-view.js', () => ({ EngineView: class {}, VIEW_TYPE_ENGINE: 'engine' }));
vi.mock('../../src/chat/chat-view.js', () => ({ ChatView: class {}, VIEW_TYPE_CHAT: 'chat' }));
vi.mock('../../src/boards/board-view.js', () => ({ BoardView: class {}, VIEW_TYPE_BOARD: 'board' }));
vi.mock('../../src/settings-tab.js', () => ({ VaultSettingTab: class {} }));
vi.mock('../../src/models/discover-modal.js', () => ({ DiscoverModelsModal: class {} }));
vi.mock('obsidian', async importOriginal => ({ ...(await importOriginal<object>()), Plugin: class {} }));

const processors: MarkdownPostProcessor[] = [];
/** Until Engine answers, the plugin knows the vault map's defaults. */
const offline = () => new VaultMapIndex(async () => { throw new Error('offline'); });
let plugin: { vaultMap: VaultMapIndex; onload(): Promise<void> };
/** The type key Engine reports (#445). */
let engineTypeKey = 'types';
beforeAll(async () => {
  plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    vaultMap: offline(),
    app: { workspace: { activeLeaf: null, on: vi.fn(() => ({})) } },
    settings: { engineUrl: 'http://synthetic.invalid/mcp', token: '' },
    typeKey: { current: () => engineTypeKey },
    inspectionTarget: new LastMarkdownTarget(),
    loadSettings: vi.fn(async () => {}),
    registerEvent: vi.fn(), register: vi.fn(), registerView: vi.fn(),
    addCommand: vi.fn(), addRibbonIcon: vi.fn(), addSettingTab: vi.fn(),
    registerMarkdownPostProcessor: (processor: MarkdownPostProcessor) => { processors.push(processor); },
  });
  await plugin.onload();
});

function fixture(source: string, html: string, options: {
  frontmatter?: unknown; lineStart?: number; lineEnd?: number; missingSection?: boolean; tagName?: string;
} = {}) {
  const el = document.createElement(options.tagName ?? 'div');
  el.innerHTML = html;
  const ctx: MarkdownPostProcessorContext = {
    docId: 'synthetic-document', sourcePath: 'Synthetic wiki.md',
    frontmatter: 'frontmatter' in options ? options.frontmatter : { types: ['wiki'] },
    addChild: vi.fn(),
    getSectionInfo: () => options.missingSection ? null : ({
      text: source, lineStart: options.lineStart ?? 0,
      lineEnd: options.lineEnd ?? source.split('\n').length - 1,
    }),
  };
  const run = () => { for (const processor of processors) processor(el, ctx); };
  return { el, ctx, run };
}

const pair = (key: string, text = 'Original prose.') => `<!-- ve:${key} -->\n${text}\n<!-- /ve:${key} -->`;
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll('h2.ve-wiki-section-heading'), heading => heading.textContent);

describe('registered wiki preview presentation', () => {
  it('shows known headings at marker positions without changing existing content nodes', () => {
    const source = `${pair('managed:Now')}\n\n${pair('managed:Focus', 'Keep [reference](https://example.invalid).')}`;
    const view = fixture(source, '<!-- ve:managed:Now --><p>Original prose.</p><!-- /ve:managed:Now --><!-- ve:managed:Focus --><p>Keep <a href="https://example.invalid">reference</a>.</p><!-- /ve:managed:Focus -->');
    const originals = Array.from(view.el.childNodes);
    const link = view.el.querySelector('a');
    view.run(); view.run();
    expect(headings(view.el)).toEqual(['Now', 'Focus']);
    expect(Array.from(view.el.childNodes).filter(node => originals.includes(node))).toEqual(originals);
    expect(view.el.querySelector('a')).toBe(link);
    expect(view.el.querySelector('a')?.getAttribute('href')).toBe('https://example.invalid');
    expect(Array.from(view.el.children, child => child.tagName)).toEqual(['H2', 'P', 'H2', 'P']);
    expect(view.ctx.getSectionInfo(view.el)?.text).toBe(source);
  });

  it.each([
    ['managed:At a glance', 'At a glance'], ['managed:Open threads', 'Open threads'],
    ['managed:Summary', 'Summary'], ['managed:Sources', 'Sources'], ['managed:Status', 'Status'], ['managed:Log', 'Log'],
    ['live:tasks', 'Tasks'], ['live:upcoming', 'Upcoming'], ['live:contacts', 'Contacts'],
    ['live:meetings', 'Meetings'], ['live:notes', 'Notes'], ['live:related', 'Related'], ['live:sub-pages', 'Sub-pages'],
  ])('presents the recognized %s section', (key, label) => {
    const view = fixture(pair(key), '<p>Original prose.</p>');
    view.run();
    expect(headings(view.el)).toEqual([label]);
  });

  it('adds an inset class only to exact retained-action paragraphs and preserves their children', () => {
    const action = 'Existing wiki action (retained verbatim): Keep [the task](Task.md) and `exact()`.';
    const view = fixture(pair('managed:Focus', action), [
      '<p>Existing wiki action (retained verbatim): Keep <a href="Task.md">the task</a> and <code>exact()</code>.</p>',
      '<p>Context: Existing wiki action (retained verbatim): ordinary prose.</p>',
      '<p>existing wiki action (retained verbatim): wrong case.</p>',
      '<pre><code>Existing wiki action (retained verbatim): code example.</code></pre>',
    ].join(''));
    const paragraphs = Array.from(view.el.querySelectorAll('p'));
    const actionNodes = Array.from(paragraphs[0]!.childNodes);
    view.run();
    expect(paragraphs.map(paragraph => paragraph.classList.contains('ve-wiki-retained-action'))).toEqual([true, false, false]);
    expect(Array.from(paragraphs[0]!.childNodes)).toEqual(actionNodes);
    expect(paragraphs[0]!.textContent).toBe('Existing wiki action (retained verbatim): Keep the task and exact().');
    expect(view.el.querySelector('pre')?.className).toBe('');
  });

  it('recognizes a formatted retained-action prefix while leaving inline-code examples alone', () => {
    const source = pair('managed:Focus', '**Existing wiki action (retained verbatim):** Keep.');
    const view = fixture(source, '<p><strong>Existing wiki action (retained verbatim):</strong> Keep.</p><p><code>Existing wiki action (retained verbatim): Example.</code></p>');
    const paragraphs = Array.from(view.el.querySelectorAll('p'));
    const strong = view.el.querySelector('strong');
    view.run();
    expect(paragraphs.map(paragraph => paragraph.classList.contains('ve-wiki-retained-action'))).toEqual([true, false]);
    expect(view.el.querySelector('strong')).toBe(strong);
  });

  it.each([undefined, null, {}, { type: 'wiki' }, { types: ['note'] }, { types: ['wikilike'] }])('leaves non-wiki context unchanged: %j', frontmatter => {
    const view = fixture(pair('managed:Now'), '<!-- ve:managed:Now --><p>Existing wiki action (retained verbatim): Keep.</p>', { frontmatter });
    const before = view.el.innerHTML;
    view.run();
    expect(view.el.innerHTML).toBe(before);
  });

  // [['wiki']] is `types: [[wiki]]` unquoted, and [[['wiki']]] its list-item form (#482).
  it.each([{ types: 'wiki' }, { types: '[[wiki]]' }, { types: ['note', 'wiki'] }, { types: ['[[wiki]]'] }, { types: [['wiki']] }, { types: [[['wiki']]] }])('accepts Engine-supported wiki types: %j', ({ types }) => {
    const view = fixture(pair('managed:Now'), '<p>Original prose.</p>', { frontmatter: { types } });
    view.run();
    expect(headings(view.el)).toEqual(['Now']);
  });

  it('reads the types from the key Engine reports (#445)', () => {
    engineTypeKey = 'kind';
    try {
      const designated = fixture(pair('managed:Now'), '<p>Original prose.</p>', { frontmatter: { kind: ['wiki'] } });
      designated.run();
      expect(headings(designated.el)).toEqual(['Now']);
      const other = fixture(pair('managed:Now'), '<p>Original prose.</p>', { frontmatter: { types: ['wiki'] } });
      other.run();
      expect(headings(other.el)).toEqual([]);
      // kind: [[wiki]] unquoted, as Obsidian's frontmatter cache gives it: a nested list.
      const linked = fixture(pair('managed:Now'), '<p>Original prose.</p>', { frontmatter: { kind: [['wiki']] } });
      linked.run();
      expect(headings(linked.el)).toEqual(['Now']);
    } finally {
      engineTypeKey = 'types';
    }
  });

  it('renders open Reading views again once the type key is read (#445)', () => {
    const rerender = vi.fn();
    const view = Object.assign(Object.create(MarkdownView.prototype), { previewMode: { rerender } });
    const other = { view: {} };
    const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
      app: { workspace: { getLeavesOfType: (type: string) => type === 'markdown' ? [{ view }, other] : [] } },
    });
    (plugin as unknown as { rerenderReadingViews(): void }).rerenderReadingViews();
    expect(rerender).toHaveBeenCalledWith(true);
  });

  it('leaves rendering unchanged when section context is unavailable', () => {
    const view = fixture(pair('managed:Now'), '<p>Existing wiki action (retained verbatim): Keep.</p>', { missingSection: true });
    const before = view.el.innerHTML;
    view.run();
    expect(view.el.innerHTML).toBe(before);
  });

  it('anchors to first content without relying on comment-only callbacks or duplicating split chunks', () => {
    const source = pair('managed:Now');
    const opening = fixture(source, '', { lineStart: 0, lineEnd: 0 });
    const prose = fixture(source, '<p>Original prose.</p>', { lineStart: 1, lineEnd: 1 });
    const closing = fixture(source, '', { lineStart: 2, lineEnd: 2 });
    for (const view of [opening, prose, closing]) { view.run(); view.run(); }
    expect(headings(opening.el)).toEqual([]);
    expect(headings(prose.el)).toEqual(['Now']);
    expect(headings(closing.el)).toEqual([]);
    expect(prose.el.querySelector('p')?.outerHTML).toBe('<p>Original prose.</p>');
  });

  it('keeps independent rendered previews independent', () => {
    const first = fixture(pair('managed:Now'), '<p>Original prose.</p>');
    const second = fixture(pair('managed:Now'), '<p>Original prose.</p>');
    first.run(); second.run();
    expect(headings(first.el)).toEqual(['Now']);
    expect(headings(second.el)).toEqual(['Now']);
  });

  it.each(['markdown-embed', 'internal-embed', 'markdown-embed-content'])('keeps parent wiki presentation outside nested .%s content', boundary => {
    const source = pair('managed:Now', '![[Other note]]');
    const view = fixture(source, `<div class="${boundary}"><!-- ve:managed:Now --><p>Other note prose.</p><p>Existing wiki action (retained verbatim): Other note action.</p></div>`, { lineStart: 1, lineEnd: 1 });
    const embed = view.el.firstElementChild!;
    const before = embed.innerHTML;
    view.run(); view.run();
    expect(view.el.firstElementChild?.textContent).toBe('Now');
    expect(view.el.firstElementChild?.tagName).toBe('H2');
    expect(view.el.children[1]).toBe(embed);
    expect(embed.innerHTML).toBe(before);
  });

  it('does not let an embedded wiki heading suppress the parent heading', () => {
    const view = fixture(pair('managed:Now', '![[Another wiki]]'), '<div class="markdown-embed"><div class="markdown-embed-content"><h2 class="ve-wiki-section-heading" data-ve-wiki-section="managed:Now">Now</h2><p>Another wiki.</p></div></div>', { lineStart: 1, lineEnd: 1 });
    const embed = view.el.firstElementChild!;
    const before = embed.innerHTML;
    view.run(); view.run();
    expect(Array.from(view.el.children, child => child.tagName)).toEqual(['H2', 'DIV']);
    expect(embed.innerHTML).toBe(before);
  });

  it('does not mistake the first text of an inline embed for a parent retained action', () => {
    const view = fixture(pair('managed:Now', '![[Other note]]'), '<p><span class="internal-embed">Existing wiki action (retained verbatim): Other note action.</span></p>', { lineStart: 1, lineEnd: 1 });
    const paragraph = view.el.querySelector('p')!;
    const before = paragraph.outerHTML;
    view.run();
    expect(paragraph.outerHTML).toBe(before);
  });

  it.each(['markdown-embed', 'internal-embed', 'markdown-embed-content'])('presents a wiki embed when .%s is its own context root', boundary => {
    const view = fixture(pair('managed:Now', 'Existing wiki action (retained verbatim): Own action.'), '<p>Existing wiki action (retained verbatim): Own action.</p>', { lineStart: 1, lineEnd: 1 });
    view.el.className = boundary;
    view.run();
    expect(headings(view.el)).toEqual(['Now']);
    expect(view.el.querySelector('p')?.classList.contains('ve-wiki-retained-action')).toBe(true);
  });

  it.each(['pre', 'code'])('leaves a %s root and its content unchanged', tagName => {
    const view = fixture(pair('managed:Now'), '<!-- ve:managed:Now -->Original prose.', { tagName, lineStart: 1, lineEnd: 1 });
    const before = view.el.innerHTML;
    view.run();
    expect(view.el.innerHTML).toBe(before);
  });

  it('leaves a callback root nested inside raw code unchanged', () => {
    const view = fixture(pair('managed:Now'), '<p>Original prose.</p>', { lineStart: 1, lineEnd: 1 });
    const pre = document.createElement('pre');
    pre.append(view.el);
    const before = pre.innerHTML;
    view.run();
    expect(pre.innerHTML).toBe(before);
  });

  it.each([
    pair('managed:Unknown'), pair('live:unknown'), pair('managed:Now', ''),
    '<!-- ve:managed:Now -->\nUnclosed.',
    '<!-- ve:managed:Now -->\nWrong close.\n<!-- /ve:managed:Focus -->',
    `${pair('managed:Now')}\n${pair('managed:Now')}`,
    '<!-- ve:managed:Now -->\n<!-- ve:managed:Focus -->\nNested.\n<!-- /ve:managed:Focus -->\n<!-- /ve:managed:Now -->',
    '<!-- ve:managed: Now -->\nPadded.\n<!-- /ve:managed: Now -->',
    '<!-- ve:managed:Now ->\nMalformed.\n<!-- /ve:managed:Now -->',
  ])('does not decorate unknown, empty or ambiguous markers: %s', source => {
    const view = fixture(source, '<p>Original prose.</p>');
    view.run();
    expect(headings(view.el)).toEqual([]);
  });

  it.each(['```markdown', '~~~~markdown'])('ignores marker examples in %s fences', fence => {
    const source = `${fence}\n${pair('managed:Now')}\n${fence.startsWith('`') ? '```' : '~~~~'}`;
    const view = fixture(source, '<pre><code>&lt;!-- ve:managed:Now --&gt;\nOriginal prose.\n&lt;!-- /ve:managed:Now --&gt;</code></pre>');
    const before = view.el.innerHTML;
    view.run();
    expect(view.el.innerHTML).toBe(before);
  });

  it('ignores indented and inline marker examples', () => {
    const source = `    ${pair('managed:Now').replaceAll('\n', '\n    ')}\n\nExample: ${pair('managed:Focus')}`;
    const view = fixture(source, '<pre><code>example</code></pre><p>Example</p>');
    view.run();
    expect(headings(view.el)).toEqual([]);
  });

  it('does not guess an insertion point when a stripped marker follows existing content', () => {
    const source = `Owner introduction.\n\n${pair('managed:Now')}`;
    const view = fixture(source, '<p>Owner introduction.</p><p>Original prose.</p>');
    view.run();
    expect(headings(view.el)).toEqual([]);
    expect(view.el.innerHTML).toBe('<p>Owner introduction.</p><p>Original prose.</p>');
  });

  it('does not duplicate an equivalent visible heading or headings for empty sections', () => {
    const view = fixture(pair('managed:Now', '## Now\n\nOriginal prose.'), '<h2>Now</h2><p>Original prose.</p>');
    const before = view.el.innerHTML;
    view.run();
    expect(view.el.innerHTML).toBe(before);
  });
});

describe('the wiki kind comes from the vault map (#449)', () => {
  afterEach(() => { plugin.vaultMap = offline(); });

  /** Read the map once, as the plugin does in the background, then present. */
  async function withMap(map: VaultMap) {
    plugin.vaultMap = new VaultMapIndex(async () => map);
    await plugin.vaultMap.load();
  }
  const presents = (types: unknown) => {
    const view = fixture(pair('managed:Now'), '<p>Original prose.</p>', { frontmatter: { types } });
    view.run();
    return headings(view.el).length > 0;
  };

  it('presents wiki notes when Engine is older than the map (no vault domain), as today', async () => {
    await withMap(vaultMapFrom({ domains: { wiki: { effective: { wikiType: 'wiki', projectType: 'project' } } } }));
    expect(presents(['wiki'])).toBe(true);
    expect(presents('[[wiki]]')).toBe(true);
    expect(presents(['note'])).toBe(false);
  });

  it('presents notes of the vault\'s own wiki kind, and no longer plain "wiki" notes', async () => {
    await withMap(vaultMapFrom({ domains: { vault: { effective: { wikiType: 'handbook' } } } }));
    expect(presents(['handbook'])).toBe(true);
    expect(presents(['[[handbook]]'])).toBe(true);
    expect(presents(['wiki'])).toBe(false);
  });

  it('presents nothing when the vault map\'s wiki kind is none', async () => {
    await withMap(vaultMapFrom({ domains: { vault: { effective: { wikiType: null } } } }));
    expect(presents(['wiki'])).toBe(false);
  });
});
