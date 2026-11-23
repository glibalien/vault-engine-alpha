import {
  ProvenanceView,
  VIEW_TYPE_PROVENANCE,
  type ProvenanceMode,
} from './provenance/provenance-view.js';
import { LastMarkdownTarget } from './provenance/note-target.js';
import { MarkdownView, Plugin, Notice, TFile, type TAbstractFile, type WorkspaceLeaf } from 'obsidian';
import { connectEngine } from './engine/transport.js';
import { makeEngineClient } from './engine/client.js';
import { runChatStream, SYSTEM_PROMPT, providerAvailability } from '@vault/chat-core';
import { buildToolSet } from './chat/tools.js';
import { makeRelayModel } from './llm/relay-model.js';
import { PluginSettingsClient } from './engine/settings-client.js';
import { DEFAULT_SETTINGS, hasProviderKey, mergeSettings, providerKeys, type VaultPluginSettings } from './settings.js';
import { VaultSettingTab } from './settings-tab.js';
import { EngineView, VIEW_TYPE_ENGINE } from './view/engine-view.js';
import { ChatView, VIEW_TYPE_CHAT } from './chat/chat-view.js';
import { BoardView, VIEW_TYPE_BOARD } from './boards/board-view.js';
import { VaultSearchModal } from './search/search-modal.js';
import { makeEngineSearcher } from './search/searcher.js';
import { DiscoverModelsModal } from './models/discover-modal.js';
import { makeModelService } from './models/discover-service.js';
import { presentWikiReadingView } from './wiki/presentation.js';
import { BoardSync } from './boards/board-sync.js';
import { ProjectWikiIndex, pluginProjectWikiSources } from './wiki/project-wikis.js';
import { VaultMapIndex, readVaultMapOver } from './engine/vault-map.js';
import { EngineTypeKey, readEngineTypeKey } from './engine/type-key.js';
import { CreateWikiModal } from './wiki/create-wiki-modal.js';
import { DossierModal, dossierKindOf, offersDossier } from './wiki/dossier-modal.js';
import type { NoteKind } from '@vault/viz-ui';
import { CreateTopicWikiModal, engineNoteByPath } from './wiki/create-topic-wiki-modal.js';

export default class VaultEnginePlugin extends Plugin {
  private readonly inspectionTarget = new LastMarkdownTarget();
  private inspectionSequence = 0;
  private inspectionConnection = { url: '', token: '', curatorUrl: '', curatorToken: '' };
  settings: VaultPluginSettings = { ...DEFAULT_SETTINGS };
  /** Shared by every chat and Boards pane: a pin and a pane edit can't drop each other (#287). */
  readonly boardSync = new BoardSync();
  /** Which notes can take a new project wiki, known without waiting (#384). */
  readonly projectWikis = new ProjectWikiIndex(() => pluginProjectWikiSources(this.settings));
  /** Engine's vault map, known without waiting: the names views, presets and prompts read (#449). */
  readonly vaultMap = new VaultMapIndex(() => readVaultMapOver(this.settings));
  /** The frontmatter key Engine keeps a note's types in (#445). Reading views shown before
   *  it was read used `types`, so they are rendered again when it turns out to be another. */
  readonly typeKey = new EngineTypeKey(() => readEngineTypeKey(this.settings), Date.now, () => this.rerenderReadingViews());

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.vaultMap.refresh();
      presentWikiReadingView(el, ctx, this.vaultMap.current().vault.wikiType, this.typeKey.current());
    });
    // A read of the vault map that changes the wiki kind re-renders open reading views, so a note
    // rendered before the read gains or loses its wiki presentation.
    let wikiType = this.vaultMap.current().vault.wikiType;
    this.register(this.vaultMap.subscribe(() => {
      const next = this.vaultMap.current().vault.wikiType;
      if (next === wikiType) return;
      wikiType = next;
      for (const leaf of this.app.workspace.getLeavesOfType('markdown'))
        if (leaf.view instanceof MarkdownView) leaf.view.previewMode?.rerender(true);
    }));
    this.vaultMap.refresh();
    this.inspectionConnection = { url: this.settings.engineUrl, token: this.settings.token,
      curatorUrl: this.settings.curatorUrl, curatorToken: this.settings.curatorToken };
    this.inspectionTarget.record(this.app.workspace.activeLeaf);
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      this.inspectionTarget.record(leaf);
      // The wiki panel follows the note being edited; focusing a sidebar changes nothing.
      if (leaf?.view instanceof MarkdownView) this.followActiveNote();
    }));
    this.register(() => this.inspectionTarget.clear());
    this.registerView(VIEW_TYPE_PROVENANCE, leaf => new ProvenanceView(leaf, this));
    // The wiki panel (#545). The commands keep their ids, which hotkeys are saved under.
    this.addCommand({ id: 'inspect-current-note', name: 'Open wiki panel', callback: () => void this.inspectCurrentNote() });
    this.addCommand({
      id: 'review-current-note-impact',
      name: 'Show pages built from current note',
      callback: () => void this.reviewCurrentNoteImpact(),
    });
    this.addCommand({
      id: 'create-project-wiki',
      name: 'Create project wiki',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!this.offersCreateWiki(file)) return false;
        if (!checking) this.openCreateWiki(file);
        return true;
      },
    });
    this.addCommand({
      id: 'build-dossier',
      name: 'Build dossier for this note',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!this.offersBuildDossier(file)) return false;
        if (!checking) this.openDossier(file);
        return true;
      },
    });
    this.addCommand({
      id: 'create-topic-wiki',
      name: 'Create topic wiki from this note',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!this.offersTopicWiki(file)) return false;
        if (!checking) this.openTopicWiki(file);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (this.offersCreateWiki(file))
        menu.addItem(item => item.setTitle('Create project wiki').setIcon('book-plus').onClick(() => this.openCreateWiki(file)));
      if (this.offersTopicWiki(file))
        menu.addItem(item => item.setTitle('Create topic wiki from this note').setIcon('library').onClick(() => this.openTopicWiki(file)));
      if (this.offersBuildDossier(file))
        menu.addItem(item => item.setTitle('Build dossier').setIcon('contact').onClick(() => this.openDossier(file)));
    }));
    // Warms what the command and the menu read, so they're current by the time they're opened.
    this.registerEvent(this.app.workspace.on('file-open', file => { this.offersCreateWiki(file); this.followActiveNote(); }));

    this.registerView(VIEW_TYPE_ENGINE, (leaf) => new EngineView(leaf, this));
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.addRibbonIcon('database', 'Open Vault Engine', () => void this.activateView(VIEW_TYPE_ENGINE));
    this.addRibbonIcon('message-square', 'Open Vault Chat', () => void this.activateView(VIEW_TYPE_CHAT));
    this.addRibbonIcon('layout-dashboard', 'Open Vault Boards', () => void this.activateView(VIEW_TYPE_BOARD));
    this.addRibbonIcon('search', 'Search vault', () => this.openSearch());
    this.addSettingTab(new VaultSettingTab(this.app, this));

    this.addCommand({ id: 'open-vault-engine-view', name: 'Open Vault Engine view', callback: () => void this.activateView(VIEW_TYPE_ENGINE) });
    this.addCommand({ id: 'open-vault-chat-view', name: 'Open Vault Chat view', callback: () => void this.activateView(VIEW_TYPE_CHAT) });
    this.addCommand({ id: 'open-vault-boards-view', name: 'Open Vault Boards view', callback: () => void this.activateView(VIEW_TYPE_BOARD) });
    this.addCommand({ id: 'open-vault-search', name: 'Search vault', callback: () => this.openSearch() });
    this.addCommand({ id: 'ping-engine', name: 'Ping engine (vault-stats)', callback: () => void this.pingEngine() });
    this.addCommand({ id: 'chat-ping', name: 'Chat ping (one Fireworks turn)', callback: () => void this.chatPing() });
    this.addCommand({ id: 'discover-models', name: 'Discover models', callback: () => this.openDiscoverModels() });
    this.addCommand({ id: 'manage-models', name: 'Manage models', callback: () => void this.openManageModels() });
  }

  async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    const engineChanged = this.inspectionConnection.url !== this.settings.engineUrl || this.inspectionConnection.token !== this.settings.token;
    if (engineChanged
      || this.inspectionConnection.curatorUrl !== this.settings.curatorUrl || this.inspectionConnection.curatorToken !== this.settings.curatorToken) {
      this.inspectionSequence++;
      this.inspectionConnection = { url: this.settings.engineUrl, token: this.settings.token,
        curatorUrl: this.settings.curatorUrl, curatorToken: this.settings.curatorToken };
      this.projectWikis.reset();
      // The vault map came from the old Engine.
      if (engineChanged) this.vaultMap.reset();
      this.typeKey.reset();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROVENANCE)) {
        if (leaf.view instanceof ProvenanceView) leaf.view.connectionSettingsChanged();
      }
    }
  }

  /** The vault path of the Markdown note last active in the editor, which the wiki panel follows. */
  activeNotePath(): string | null {
    return this.inspectionTarget.currentPath();
  }

  /** Move every unpinned wiki panel to the active note (#545). */
  private followActiveNote(): void {
    const path = this.inspectionTarget.currentPath();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROVENANCE))
      if (leaf.view instanceof ProvenanceView) leaf.view.follow(path);
  }

  async inspectCurrentNote(): Promise<void> {
    await this.openProvenanceForCurrentNote('output');
  }

  async reviewCurrentNoteImpact(): Promise<void> {
    await this.openProvenanceForCurrentNote('source-impact');
  }

  private async openProvenanceForCurrentNote(
    mode: ProvenanceMode,
  ): Promise<void> {
    this.inspectionTarget.record(this.app.workspace.activeLeaf);
    const path = this.inspectionTarget.currentPath();
    const sequence = ++this.inspectionSequence;
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PROVENANCE)[0] ?? workspace.getRightLeaf(false);
    if (!leaf) return;
    try {
      if (!(leaf.view instanceof ProvenanceView)) await leaf.setViewState({ type: VIEW_TYPE_PROVENANCE, active: false });
      if (sequence !== this.inspectionSequence) return;
      if (leaf.view instanceof ProvenanceView)
        await leaf.view.inspectPath(path, mode);
      if (sequence === this.inspectionSequence) await workspace.revealLeaf(leaf);
    } catch { new Notice('Could not open the wiki panel'); }
  }

  /** Run the post-processors again on every open Reading view. */
  private rerenderReadingViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
    }
  }

  /** The create commands the wiki panel offers on the note at this vault path: those its command palette
   *  and context menu would offer. */
  wikiCreation(path: string | null): { project?: () => void; topic?: () => void } {
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    return {
      ...(this.offersCreateWiki(file) ? { project: () => this.openCreateWiki(file) } : {}),
      ...(this.offersTopicWiki(file) ? { topic: () => this.openTopicWiki(file) } : {}),
    };
  }

  /** A Markdown project note without a wiki, with a Curator configured: where "Create project wiki" is offered. */
  private offersCreateWiki(file: TAbstractFile | null): file is TFile {
    if (!this.offersTopicWiki(file)) return false;
    return this.projectWikis.offers(this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.typeKey.current()], file.basename);
  }

  /** Any Markdown note, with a Curator configured: where "Create topic wiki from this note" is offered.
   *  The panel's free check says when a note can't start one. */
  private offersTopicWiki(file: TAbstractFile | null): file is TFile {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return false;
    return !!this.settings.curatorUrl.trim() && !!this.settings.curatorToken.trim();
  }

  /** A note of an entity kind (a person, a company; not a project), with a Curator configured: where
   *  "Build dossier" is offered (#715). The vault map is the last one read; the dry run decides. */
  private offersBuildDossier(file: TAbstractFile | null): file is TFile {
    if (!this.offersTopicWiki(file)) return false;
    this.vaultMap.refresh();
    return offersDossier(this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.typeKey.current()], this.vaultMap.current().vault);
  }

  private openDossier(file: TFile): void {
    new DossierModal(this.app, {
      noteTitle: file.basename, notePath: file.path, endpoint: this.settings.curatorUrl, token: this.settings.curatorToken,
      note: engineNoteByPath(this.settings.engineUrl, this.settings.token),
      onOpenPage: title => this.openNoteTitled(title, file.path),
      onClosed: () => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROVENANCE))
          if (leaf.view instanceof ProvenanceView) leaf.view.readStatusAgain();
      },
    }).open();
  }

  /** The wiki panel's read of a note's kind for its dossier (#554), from the vault map last read. */
  dossierKind(types: readonly string[]): NoteKind | null {
    this.vaultMap.refresh();
    return dossierKindOf(types, this.vaultMap.current().vault);
  }

  /** Opens a note by its title only if it is in the vault: an unresolved link isn't created. */
  openNoteTitled(title: string, sourcePath: string): void {
    const page = this.app.metadataCache.getFirstLinkpathDest(title, sourcePath);
    if (!(page instanceof TFile) || page.extension.toLowerCase() !== 'md') {
      new Notice(`"${title}" isn't in this vault yet.`);
      return;
    }
    void this.app.workspace.getLeaf(false).openFile(page);
  }

  private openTopicWiki(file: TFile): void {
    new CreateTopicWikiModal(this.app, {
      noteTitle: file.basename, notePath: file.path, endpoint: this.settings.curatorUrl, token: this.settings.curatorToken,
      note: engineNoteByPath(this.settings.engineUrl, this.settings.token),
      onOpenWiki: title => this.openWikiHome(title, file.path),
    }).open();
  }

  private openCreateWiki(file: TFile): void {
    // Engine titles a note by its file name. A title can be shared across folders, so the Curator is
    // given the note's path, which Engine resolves to the one note.
    const project = file.basename;
    new CreateWikiModal(this.app, {
      project, projectRef: file.path, endpoint: this.settings.curatorUrl, token: this.settings.curatorToken,
      onRegistered: () => this.projectWikis.markHasWiki(project),
      onOpenWiki: () => this.openWikiHome(project, file.path),
    }).open();
  }

  /** Opens a wiki's home, "<title> Wiki", only if it's already in the vault: an unresolved link isn't created. */
  private openWikiHome(title: string, sourcePath: string): void {
    const home = this.app.metadataCache.getFirstLinkpathDest(`${title} Wiki`, sourcePath);
    if (!(home instanceof TFile) || home.extension.toLowerCase() !== 'md') {
      new Notice(`"${title} Wiki" isn't in this vault yet.`);
      return;
    }
    void this.app.workspace.getLeaf(false).openFile(home);
  }

  private openSearch(): void {
    new VaultSearchModal(this.app, makeEngineSearcher(this.settings)).open();
  }

  /** "Discover models" — provider-choice → debounced provider discovery → add-model. */
  private openDiscoverModels(): void {
    const service = makeModelService(this.settings);
    new DiscoverModelsModal(this.app, 'provider-choice', service, []).open();
  }

  /** "Manage models" — preload the catalog, then a substring-filtered enable/disable list. */
  private async openManageModels(): Promise<void> {
    const service = makeModelService(this.settings);
    try {
      const catalog = await service.catalog();
      new DiscoverModelsModal(this.app, 'catalog', service, catalog).open();
    } catch (e) {
      await service.close().catch(() => {});
      new Notice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: viewType, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  private async pingEngine(): Promise<void> {
    let conn;
    try {
      conn = await connectEngine(this.settings.engineUrl, this.settings.token);
      const env = await makeEngineClient(conn.call).vaultStats();
      new Notice(env.ok ? `✓ ${env.data?.node_count ?? '?'} nodes` : `✗ ${env.error?.message ?? 'failed'}`);
    } catch (e) {
      new Notice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await conn?.close().catch(() => {});
    }
  }

  private async chatPing(): Promise<void> {
    if (!hasProviderKey(this.settings)) { new Notice('Set a model provider API key in settings first'); return; }
    let conn;
    try {
      conn = await connectEngine(this.settings.engineUrl, this.settings.token);
      const tools = await buildToolSet(conn);
      const keys = providerKeys(this.settings);
      const settingsClient = new PluginSettingsClient(conn.call); // throwaway — one-shot ping, no reuse across leaves
      const entry = await settingsClient.resolvedDefault(providerAvailability(keys));
      const model = makeRelayModel(entry, keys, {
        engineUrl: this.settings.engineUrl,
        token: this.settings.token,
      });
      const stream = runChatStream({
        model,
        system: SYSTEM_PROMPT,
        tools,
        maxSteps: 6,
        messages: [{ id: 'ping', role: 'user', parts: [{ type: 'text', text: 'Reply with exactly: pong' }] }] as never,
        onError: (e) => (e instanceof Error ? e.message : String(e)),
      });
      let text = '';
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value as { type?: string; delta?: string };
        if (chunk.type === 'text-delta') text += chunk.delta ?? '';
      }
      new Notice(text ? `✓ chat: ${text.slice(0, 80)}` : '✓ chat stream ok (no text parsed)');
    } catch (e) {
      new Notice(`✗ chat: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await conn?.close().catch(() => {});
    }
  }
}
