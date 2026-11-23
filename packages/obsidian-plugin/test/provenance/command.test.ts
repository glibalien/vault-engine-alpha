import { expect, it, vi } from 'vitest';
import { MarkdownView } from 'obsidian';
import { LastMarkdownTarget } from '../../src/provenance/note-target.js';
import { ProvenanceView } from '../../src/provenance/provenance-view.js';
import VaultEnginePlugin from '../../src/main.js';
import { VaultMapIndex } from '../../src/engine/vault-map.js';
vi.mock('../../src/view/engine-view.js', () => ({
  EngineView: class {},
  VIEW_TYPE_ENGINE: 'engine',
}));
vi.mock('../../src/chat/chat-view.js', () => ({
  ChatView: class {},
  VIEW_TYPE_CHAT: 'chat',
}));
vi.mock('../../src/boards/board-view.js', () => ({
  BoardView: class {},
  VIEW_TYPE_BOARD: 'board',
}));
vi.mock('../../src/settings-tab.js', () => ({ VaultSettingTab: class {} }));
vi.mock('../../src/models/discover-modal.js', () => ({
  DiscoverModelsModal: class {},
}));
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Plugin: class {},
}));
it('registers the explicit source-impact review command', async () => {
  const addCommand = vi.fn();
  const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    app: {
      workspace: {
        activeLeaf: null,
        on: vi.fn(() => ({})),
      },
    },
    settings: { engineUrl: 'http://fixture/mcp', token: '' },
    inspectionConnection: { url: '', token: '' },
    inspectionTarget: new LastMarkdownTarget(),
    loadSettings: vi.fn(async () => {}),
    registerEvent: vi.fn(),
    register: vi.fn(),
    registerView: vi.fn(),
    registerMarkdownPostProcessor: vi.fn(),
    addCommand,
    addRibbonIcon: vi.fn(),
    addSettingTab: vi.fn(),
    vaultMap: new VaultMapIndex(async () => { throw new Error('offline'); }),
  });
  await plugin.onload();
  // The wiki panel's command keeps its id, which saved hotkeys use (#545).
  expect(addCommand.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({ id: 'inspect-current-note', name: 'Open wiki panel' }),
  );
  expect(addCommand.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      id: 'review-current-note-impact',
      name: 'Show pages built from current note',
      callback: expect.any(Function),
    }),
  );
});
it.each(['curatorUrl', 'curatorToken'])('invalidates provenance clients when %s changes without discarding saved request state', async field => {
  const changed = vi.fn();
  const view = Object.assign(Object.create(ProvenanceView.prototype), { connectionSettingsChanged: changed });
  const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    app: { workspace: { getLeavesOfType: () => [{ view }] } }, inspectionSequence: 0,
    inspectionConnection: { url: 'engine', token: 'engine-token', curatorUrl: 'curator', curatorToken: 'old' },
    settings: { engineUrl: 'engine', token: 'engine-token', curatorUrl: 'curator', curatorToken: 'old', [field]: 'new' },
    saveData: vi.fn(async () => {}),
    projectWikis: { reset: vi.fn() },
    typeKey: { reset: vi.fn() },
  });
  await plugin.saveSettings();
  expect(changed).toHaveBeenCalledTimes(1);
  // What "Create project wiki" knows came from the old connection, and so did the type key.
  expect(plugin.projectWikis.reset).toHaveBeenCalledTimes(1);
  expect(plugin.typeKey.reset).toHaveBeenCalledTimes(1);
});
it('captures the Markdown note before sidebar focus and ignores superseded leaf creation', async () => {
  const tracker = new LastMarkdownTarget();
  const markdown = Object.assign(Object.create(MarkdownView.prototype), {
    file: { path: 'A.md', extension: 'md' },
  });
  const a = { view: markdown };
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));
  const inspectPath = vi.fn(async () => {});
  const view = Object.assign(Object.create(ProvenanceView.prototype), {
    inspectPath,
  });
  const leaf = {
    view: {},
    setViewState: vi.fn(async () => {
      await pending;
      leaf.view = view;
    }),
  };
  const workspace = {
    activeLeaf: a as unknown,
    getLeavesOfType: () => [],
    getRightLeaf: () => leaf,
    revealLeaf: vi.fn(async () => {
      workspace.activeLeaf = leaf;
    }),
  };
  const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    app: { workspace },
    inspectionTarget: tracker,
    inspectionSequence: 0,
  });
  const first = VaultEnginePlugin.prototype.inspectCurrentNote.call(
    plugin as never,
  );
  markdown.file = { path: 'B.md', extension: 'md' };
  const second = VaultEnginePlugin.prototype.inspectCurrentNote.call(
    plugin as never,
  );
  resolve();
  await Promise.all([first, second]);
  expect(inspectPath.mock.calls).toEqual([['B.md', 'output']]);
  await VaultEnginePlugin.prototype.inspectCurrentNote.call(plugin as never);
  await VaultEnginePlugin.prototype.reviewCurrentNoteImpact.call(
    plugin as never,
  );
  expect(inspectPath.mock.calls).toEqual([
    ['B.md', 'output'],
    ['B.md', 'output'],
    ['B.md', 'source-impact'],
  ]);
});
it('moves an unpinned wiki panel to the note being edited, not to a focused sidebar (#545)', async () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const follow = vi.fn();
  const panel = Object.assign(Object.create(ProvenanceView.prototype), { follow });
  const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    app: {
      workspace: {
        activeLeaf: null,
        on: vi.fn((name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); return {}; }),
        getLeavesOfType: () => [{ view: panel }],
      },
      metadataCache: { getFileCache: () => null },
    },
    settings: { engineUrl: 'http://fixture/mcp', token: '', curatorUrl: '', curatorToken: '' },
    inspectionConnection: { url: '', token: '' },
    inspectionTarget: new LastMarkdownTarget(),
    loadSettings: vi.fn(async () => {}),
    registerEvent: vi.fn(),
    register: vi.fn(),
    registerView: vi.fn(),
    registerMarkdownPostProcessor: vi.fn(),
    addCommand: vi.fn(),
    addRibbonIcon: vi.fn(),
    addSettingTab: vi.fn(),
    vaultMap: new VaultMapIndex(async () => { throw new Error('offline'); }),
  });
  await plugin.onload();
  const editor = { view: Object.assign(Object.create(MarkdownView.prototype), { file: { path: 'A.md', extension: 'md' } }) };
  handlers.get('active-leaf-change')!(editor);
  expect(follow).toHaveBeenLastCalledWith('A.md');
  follow.mockClear();
  // Focusing the panel itself, or any sidebar, isn't a note change.
  handlers.get('active-leaf-change')!({ view: panel });
  expect(follow).not.toHaveBeenCalled();
  expect(plugin.activeNotePath()).toBe('A.md');
  // Opening another note in the same tab arrives as file-open.
  editor.view.file = { path: 'B.md', extension: 'md' };
  handlers.get('file-open')!({ path: 'B.md', extension: 'md' });
  expect(follow).toHaveBeenLastCalledWith('B.md');
});
