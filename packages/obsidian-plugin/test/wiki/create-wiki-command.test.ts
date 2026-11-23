import { expect, it, vi } from 'vitest';
import { Notice, TFile } from 'obsidian';
import VaultEnginePlugin from '../../src/main.js';
import { VaultMapIndex } from '../../src/engine/vault-map.js';
import { LastMarkdownTarget } from '../../src/provenance/note-target.js';
import { engineNoteByPath } from '../../src/wiki/create-topic-wiki-modal.js';

const modals: Array<{ input: Record<string, unknown>; open: ReturnType<typeof vi.fn> }> = [];
vi.mock('../../src/wiki/create-wiki-modal.js', () => ({
  CreateWikiModal: class {
    open = vi.fn();
    constructor(_app: unknown, public input: Record<string, unknown>) { modals.push(this as never); }
  },
}));
const topicModals: Array<{ input: Record<string, unknown>; open: ReturnType<typeof vi.fn> }> = [];
vi.mock('../../src/wiki/create-topic-wiki-modal.js', () => ({
  CreateTopicWikiModal: class {
    open = vi.fn();
    constructor(_app: unknown, public input: Record<string, unknown>) { topicModals.push(this as never); }
  },
  engineNoteByPath: vi.fn(() => async () => ({ id: 'n1', title: 'T' })),
}));
vi.mock('../../src/view/engine-view.js', () => ({ EngineView: class {}, VIEW_TYPE_ENGINE: 'engine' }));
vi.mock('../../src/chat/chat-view.js', () => ({ ChatView: class {}, VIEW_TYPE_CHAT: 'chat' }));
vi.mock('../../src/boards/board-view.js', () => ({ BoardView: class {}, VIEW_TYPE_BOARD: 'board' }));
vi.mock('../../src/settings-tab.js', () => ({ VaultSettingTab: class {} }));
vi.mock('../../src/models/discover-modal.js', () => ({ DiscoverModelsModal: class {} }));
vi.mock('obsidian', async importOriginal => ({ ...(await importOriginal<object>()), Plugin: class {} }));

const note = (basename: string, extension = 'md') => Object.assign(new TFile(), { basename, extension, path: `${basename}.${extension}` });

async function loaded(over: { offers?: boolean; curatorToken?: string; active?: TFile | null; home?: TFile | null; typeKey?: string } = {}) {
  modals.length = 0; topicModals.length = 0;
  const addCommand = vi.fn();
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const openFile = vi.fn(async () => {});
  const projectWikis = { offers: vi.fn(() => over.offers ?? true), markHasWiki: vi.fn(), reset: vi.fn() };
  const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    app: {
      workspace: {
        activeLeaf: null,
        on: vi.fn((name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); return {}; }),
        getActiveFile: () => over.active === undefined ? note('Project') : over.active,
        getLeaf: () => ({ openFile }),
        getLeavesOfType: () => [],
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter: { types: ['project'], kind: ['engagement'] } }),
        getFirstLinkpathDest: vi.fn(() => over.home ?? null),
      },
    },
    settings: { engineUrl: 'http://fixture/mcp', token: '', curatorUrl: 'https://curator/mcp', curatorToken: over.curatorToken ?? 'curator-token' },
    inspectionConnection: { url: '', token: '' }, inspectionTarget: new LastMarkdownTarget(),
    loadSettings: vi.fn(async () => {}),
    registerEvent: vi.fn(), register: vi.fn(), registerView: vi.fn(), registerMarkdownPostProcessor: vi.fn(),
    addCommand, addRibbonIcon: vi.fn(), addSettingTab: vi.fn(),
    projectWikis,
    vaultMap: new VaultMapIndex(async () => { throw new Error('offline'); }),
    typeKey: { current: () => over.typeKey ?? 'types', reset: vi.fn() },
  });
  await plugin.onload();
  const command = addCommand.mock.calls.map(([c]) => c).find(c => c.id === 'create-project-wiki');
  const topicCommand = addCommand.mock.calls.map(([c]) => c).find(c => c.id === 'create-topic-wiki');
  return { plugin, command, topicCommand, handlers, projectWikis, openFile };
}

it('offers "Create project wiki" on a project note and opens the panel for its project', async () => {
  const { command, projectWikis } = await loaded();
  expect(command).toMatchObject({ name: 'Create project wiki', checkCallback: expect.any(Function) });
  expect(command.checkCallback(true)).toBe(true);
  expect(projectWikis.offers).toHaveBeenCalledWith(['project'], 'Project');
  expect(modals).toHaveLength(0);
  expect(command.checkCallback(false)).toBe(true);
  expect(modals).toHaveLength(1);
  expect(modals[0]!.input).toMatchObject({ project: 'Project', projectRef: 'Project.md', endpoint: 'https://curator/mcp', token: 'curator-token' });
  expect(modals[0]!.open).toHaveBeenCalled();
  (modals[0]!.input.onRegistered as () => void)();
  expect(projectWikis.markHasWiki).toHaveBeenCalledWith('Project');
});

it('reads the note\'s types from the key Engine reports (#445)', async () => {
  const { command, projectWikis } = await loaded({ typeKey: 'kind' });
  command.checkCallback(true);
  expect(projectWikis.offers).toHaveBeenCalledWith(['engagement'], 'Project');
});

it('hides it where the project has a wiki, without a Curator token, and off Markdown notes', async () => {
  expect((await loaded({ offers: false })).command.checkCallback(true)).toBe(false);
  expect((await loaded({ curatorToken: ' ' })).command.checkCallback(true)).toBe(false);
  expect((await loaded({ active: note('Canvas', 'canvas') })).command.checkCallback(true)).toBe(false);
  expect((await loaded({ active: null })).command.checkCallback(true)).toBe(false);
  expect(modals).toHaveLength(0);
});

it('adds it to a project note\'s context menu only when offered', async () => {
  const items: Array<{ title?: string; click?: () => void }> = [];
  const menu = { addItem: (build: (item: unknown) => void) => {
    const entry: { title?: string; click?: () => void } = {};
    const item = { setTitle: (t: string) => { entry.title = t; return item; }, setIcon: () => item,
      onClick: (f: () => void) => { entry.click = f; return item; } };
    build(item); items.push(entry);
  } };
  const offered = await loaded();
  offered.handlers.get('file-menu')!(menu, note('Project'));
  expect(items.map(i => i.title)).toEqual(['Create project wiki', 'Create topic wiki from this note']);
  items[0]!.click!();
  expect(modals[0]!.input).toMatchObject({ project: 'Project' });
  const hidden = await loaded({ offers: false });
  hidden.handlers.get('file-menu')!(menu, note('Project'));
  expect(items.map(i => i.title)).toEqual(['Create project wiki', 'Create topic wiki from this note', 'Create topic wiki from this note']);
});

it('warms what it knows when a note opens', async () => {
  const { handlers, projectWikis } = await loaded();
  handlers.get('file-open')!(note('Project'));
  expect(projectWikis.offers).toHaveBeenCalledWith(['project'], 'Project');
});

it('opens the wiki home only when it is already in the vault', async () => {
  const home = note('Project Wiki');
  const found = await loaded({ home });
  found.command.checkCallback(false);
  (modals[0]!.input.onOpenWiki as () => void)();
  expect(found.openFile).toHaveBeenCalledWith(home);
  const missing = await loaded({ home: null });
  missing.command.checkCallback(false);
  (modals[0]!.input.onOpenWiki as () => void)();
  expect(missing.openFile).not.toHaveBeenCalled();
  expect((Notice as unknown as { messages: string[] }).messages.at(-1)).toBe('"Project Wiki" isn\'t in this vault yet.');
});

it('offers "Create topic wiki from this note" on any Markdown note when a Curator token is set', async () => {
  const clip = Object.assign(new TFile(), { basename: 'Field notes', extension: 'md', path: 'Clips/Field notes.md' });
  const { topicCommand } = await loaded({ offers: false, active: clip });
  expect(topicCommand).toMatchObject({ name: 'Create topic wiki from this note', checkCallback: expect.any(Function) });
  expect(topicCommand.checkCallback(true)).toBe(true);
  expect(topicModals).toHaveLength(0);
  expect(topicCommand.checkCallback(false)).toBe(true);
  expect(topicModals).toHaveLength(1);
  expect(topicModals[0]!.input).toMatchObject({ noteTitle: 'Field notes', notePath: 'Clips/Field notes.md',
    endpoint: 'https://curator/mcp', token: 'curator-token' });
  // The note is found on Engine, by its path.
  expect(engineNoteByPath).toHaveBeenCalledWith('http://fixture/mcp', '');
  expect(topicModals[0]!.input.note).toBe(vi.mocked(engineNoteByPath).mock.results.at(-1)!.value);
  expect(topicModals[0]!.open).toHaveBeenCalled();
  expect((await loaded({ curatorToken: ' ' })).topicCommand.checkCallback(true)).toBe(false);
  expect((await loaded({ active: note('Board', 'canvas') })).topicCommand.checkCallback(true)).toBe(false);
  expect((await loaded({ active: null })).topicCommand.checkCallback(true)).toBe(false);
  expect(topicModals).toHaveLength(0);
});

it('opens a topic wiki\'s home by the title the panel names', async () => {
  const home = note('Metro Owls Wiki');
  const found = await loaded({ home });
  found.topicCommand.checkCallback(false);
  (topicModals[0]!.input.onOpenWiki as (title: string) => void)('Metro Owls');
  expect(found.openFile).toHaveBeenCalledWith(home);
  expect(found.plugin.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('Metro Owls Wiki', 'Project.md');
});

it('gives the wiki panel the create commands the note would offer (#545)', async () => {
  const project = note('Project');
  const { plugin } = await loaded();
  plugin.app.vault = { getAbstractFileByPath: (path: string) => (path === 'Project.md' ? project : null) };
  const offered = plugin.wikiCreation('Project.md');
  expect(Object.keys(offered).sort()).toEqual(['project', 'topic']);
  offered.project();
  expect(modals[0]!.input).toMatchObject({ project: 'Project', projectRef: 'Project.md' });
  offered.topic();
  expect(topicModals[0]!.input).toMatchObject({ noteTitle: 'Project', notePath: 'Project.md' });
  expect(plugin.wikiCreation('Missing.md')).toEqual({});
  expect(plugin.wikiCreation(null)).toEqual({});

  const hasWiki = await loaded({ offers: false });
  hasWiki.plugin.app.vault = { getAbstractFileByPath: () => project };
  expect(Object.keys(hasWiki.plugin.wikiCreation('Project.md'))).toEqual(['topic']);
  const noCurator = await loaded({ curatorToken: ' ' });
  noCurator.plugin.app.vault = { getAbstractFileByPath: () => project };
  expect(noCurator.plugin.wikiCreation('Project.md')).toEqual({});
});
