import { expect, it, vi } from 'vitest';
import { MarkdownView } from 'obsidian';
import VaultEnginePlugin from '../../src/main.js';
import { LastMarkdownTarget } from '../../src/provenance/note-target.js';
import { DEFAULT_VAULT_MAP, VaultMapIndex, vaultMapFrom, type VaultMap } from '../../src/engine/vault-map.js';

vi.mock('../../src/view/engine-view.js', () => ({ EngineView: class {}, VIEW_TYPE_ENGINE: 'engine' }));
vi.mock('../../src/chat/chat-view.js', () => ({ ChatView: class {}, VIEW_TYPE_CHAT: 'chat' }));
vi.mock('../../src/boards/board-view.js', () => ({ BoardView: class {}, VIEW_TYPE_BOARD: 'board' }));
vi.mock('../../src/settings-tab.js', () => ({ VaultSettingTab: class {} }));
vi.mock('../../src/models/discover-modal.js', () => ({ DiscoverModelsModal: class {} }));
vi.mock('obsidian', async importOriginal => ({ ...(await importOriginal<object>()), Plugin: class {} }));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** The plugin loaded with a vault map whose reads the test answers, and one open reading view. */
async function loaded() {
  const reads: Array<(map: VaultMap) => void> = [];
  const vaultMap = new VaultMapIndex(() => new Promise<VaultMap>(resolve => { reads.push(resolve); }));
  const rerender = vi.fn();
  const reading = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { previewMode: { rerender } });
  const plugin = Object.assign(Object.create(VaultEnginePlugin.prototype), {
    vaultMap,
    app: { workspace: { activeLeaf: null, on: vi.fn(() => ({})), getLeavesOfType: vi.fn(() => [{ view: reading }]) } },
    settings: { engineUrl: 'http://synthetic.invalid/mcp', token: '' },
    inspectionTarget: new LastMarkdownTarget(),
    loadSettings: vi.fn(async () => {}),
    registerEvent: vi.fn(), register: vi.fn(), registerView: vi.fn(), registerMarkdownPostProcessor: vi.fn(),
    addCommand: vi.fn(), addRibbonIcon: vi.fn(), addSettingTab: vi.fn(),
  });
  await plugin.onload();
  return { reads, rerender, vaultMap };
}

it('reads the vault map when it loads', async () => {
  const { reads } = await loaded();
  expect(reads).toHaveLength(1);
});

it('re-renders open reading views when a read changes the wiki kind (#449)', async () => {
  const { reads, rerender } = await loaded();
  reads[0]!(vaultMapFrom({ domains: { vault: { effective: { wikiType: 'handbook' } } } }));
  await flush();
  expect(rerender).toHaveBeenCalledWith(true);
});

it('leaves reading views alone when the read keeps the wiki kind, as on today\'s installation', async () => {
  const { reads, rerender, vaultMap } = await loaded();
  // An Engine older than the map: the wiki kind is still "wiki", other names may differ.
  reads[0]!(vaultMapFrom({ domains: { wiki: { effective: { wikiType: 'wiki' } }, curator: { effective: { activeStatuses: ['open', 'in-progress', 'next'] } } } }));
  await flush();
  expect(vaultMap.current()).not.toBe(DEFAULT_VAULT_MAP);
  expect(rerender).not.toHaveBeenCalled();
});
