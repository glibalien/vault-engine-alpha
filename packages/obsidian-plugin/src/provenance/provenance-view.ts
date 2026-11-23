import { ItemView, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HomeRefreshNotSentError, makeClient, type HomeRefreshApi } from '@vault/query-core';
import {
  ProvenanceInspector,
  VizClientProvider,
  HomeRefresh, WikiRebuild, DossierBuild,
  type HomeRefreshResume,
  type ImpactCandidate,
  type InspectorTarget,
  type ProvenanceInspectorProps,
} from '@vault/viz-ui';
import {
  connectEngine,
  EngineTransportError,
  type EngineConnection,
} from '../engine/transport.js';
import { openExistingNode } from './note-target.js';
import type VaultEnginePlugin from '../main.js';
import { makeHomeRefreshClient, normalizedCuratorEndpoint } from './home-refresh-client.js';
import { makeWikiRebuildClient } from './wiki-rebuild-client.js';
import { RebuildModal } from './rebuild-modal.js';

/** The wiki panel's view type (#545). It keeps the provenance inspector's id, which saved layouts hold. */
export const VIEW_TYPE_PROVENANCE = 'vault-provenance-view';
/** `source-impact` opens the note with "Pages built from this note" in view. */
export type ProvenanceMode = 'output' | 'source-impact';
export class ProvenanceView extends ItemView {
  private root: Root | null = null;
  private conn: EngineConnection | null = null;
  private connecting: Promise<EngineConnection> | null = null;
  private closed = true;
  private generation = 0;
  private selection = 0;
  private target: InspectorTarget | null = null;
  private targetError: string | null = null;
  /** The panel follows the active Markdown note (#545) unless it is pinned. */
  private pinned = false;
  /** The path of the note the panel shows, or is on its way to showing. */
  private shownPath: string | null = null;
  /** The editor's note the panel last accounted for: followed, opened itself, or left alone while
   *  pinned. Kept apart from `shownPath`, so opening a source from a pinned panel never retargets it. */
  private editorPath: string | null = null;
  /** The note a lost or replaced connection cleared, to show again once reconnected. */
  private reloadPath: string | null = null;
  /** Notes the panel itself is opening; the editor's file change they cause isn't followed. */
  private navigating = 0;
  /** The note to go back to after following a page from "Pages built from this note". */
  private back: { target: InspectorTarget; path: string | null } | null = null;
  private highlightInputIds: readonly string[] | undefined;
  private expectedNamespace: string | undefined;
  /** Changed to open "Pages built from this note" and bring it into view. */
  private focusImpact = 0;
  /** Changed to read the wiki's Curator status again, as after a rebuild dialog closes. */
  private statusKey = 0;
  /** The open rebuild dialog, if any. */
  private modal: RebuildModal | null = null;
  private hasInspectionTool = false;
  private hasImpactTool = false;
  private refreshResume: (HomeRefreshResume & { curator_endpoint: string }) | null = null;
  private refreshPersistence: Promise<void> = Promise.resolve();
  private refreshPanel: { outputId?: string; namespace: string } | null = null;
  private refreshClient: ReturnType<typeof makeHomeRefreshClient> | null = null;
  private refreshApi: HomeRefreshApi | null = null;
  private refreshApiPanel: ProvenanceView['refreshPanel'] = null;
  private wikiRebuildPanel: { project: string } | null = null;
  private wikiRebuildClient: ReturnType<typeof makeWikiRebuildClient> | null = null;
  private wikiRebuildClientPanel: ProvenanceView['wikiRebuildPanel'] = null;
  /** A person's or company's dossier being built or rebuilt from the panel (#554): build-dossier's
   *  free check, then the paid build, in the same dialog as the rebuilds. */
  private dossierPanel: { nodeId: string; title: string; note: () => Promise<{ id: string; title: string }> } | null = null;
  private dossierClient: ReturnType<typeof makeWikiRebuildClient> | null = null;
  private dossierClientPanel: ProvenanceView['dossierPanel'] = null;
  /** Asks Curator which wiki a note belongs to and how it stands, and pauses or resumes it (#545). */
  private wikiLookupClient: ReturnType<typeof makeWikiRebuildClient> | null = null;
  /** Remounts the inspector, so it reads the latest build after a rebuild. */
  private inspectorEpoch = 0;
  private preferredOutputId: string | undefined;
  private returnFocus: HTMLElement | null = null;
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultEnginePlugin,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE_PROVENANCE;
  }
  getDisplayText(): string {
    return 'Wiki';
  }
  getIcon(): string {
    return 'book-open';
  }
  getState(): Record<string, unknown> {
    return this.refreshResume ? { home_refresh: this.refreshResume } : {};
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const saved = state && typeof state === 'object' && 'home_refresh' in state ? state.home_refresh : null;
    if (saved && typeof saved === 'object' && 'request_id' in saved && 'vault_namespace' in saved && 'curator_endpoint' in saved
      && typeof saved.request_id === 'string' && /^[0-9a-f-]{36}$/i.test(saved.request_id)
      && typeof saved.vault_namespace === 'string' && saved.vault_namespace.length > 0 && typeof saved.curator_endpoint === 'string') {
      try {
        this.refreshResume = { request_id: saved.request_id, vault_namespace: saved.vault_namespace,
          curator_endpoint: normalizedCuratorEndpoint(saved.curator_endpoint) };
      } catch { /* Reject invalid persisted connection identity. */ }
    }
    this.draw();
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.root = createRoot(this.contentEl);
    this.draw();
    void this.ensureConnection().catch(() => {});
    this.follow(this.plugin.activeNotePath?.() ?? null);
  }
  /** Follow the active Markdown note, unless pinned or the panel is opening a note itself. */
  follow(path: string | null): void {
    if (this.closed || !path || path === this.editorPath) return;
    this.editorPath = path;
    if (this.pinned || this.navigating > 0) return;
    void this.inspectPath(path, 'output');
  }
  private togglePin(): void {
    this.pinned = !this.pinned;
    if (!this.pinned) {
      // Catch up with the note that is active now.
      const path = this.plugin.activeNotePath?.() ?? null;
      if (path && path !== this.shownPath) { this.draw(); void this.inspectPath(path, 'output'); return; }
    }
    this.draw();
  }
  /** From "Pages built from this note": show the build a page was built from, with this note's inputs
   *  highlighted and a way back. */
  private reviewBuild(candidate: ImpactCandidate, namespace: string | null): void {
    if (this.closed || !this.target) return;
    this.selection++;
    this.back = { target: this.target, path: this.shownPath };
    this.shownPath = candidate.target.path;
    this.target = candidate.target;
    this.targetError = null;
    this.preferredOutputId = candidate.impact.receipt.output_revision_id;
    this.highlightInputIds = candidate.impact.inputs.map(input => input.input_id);
    this.expectedNamespace = namespace ?? undefined;
    this.refreshPanel = null;
    this.inspectorEpoch += 1;
    this.draw();
  }
  private goBack(): void {
    const back = this.back;
    if (this.closed || !back) return;
    this.selection++;
    this.back = null;
    this.target = back.target;
    this.shownPath = back.path;
    this.preferredOutputId = undefined;
    this.highlightInputIds = undefined;
    this.expectedNamespace = undefined;
    this.focusImpact += 1;
    this.inspectorEpoch += 1;
    this.draw();
  }
  private ensureConnection(): Promise<EngineConnection> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.connecting = (async () => {
      let conn: EngineConnection | null = null;
      try {
        conn = await connectEngine(
          this.plugin.settings.engineUrl,
          this.plugin.settings.token,
        );
        if (this.closed || generation !== this.generation) {
          await conn.close().catch(() => {});
          conn = null;
          throw Error('Inspection connection replaced');
        }
        const tools = await conn.listTools();
        if (this.closed || generation !== this.generation) {
          await conn.close().catch(() => {});
          conn = null;
          throw Error('Inspection connection replaced');
        }
        const raw = conn;
        const guarded: EngineConnection = {
          ...raw,
          call: async (request) => {
            try {
              return await raw.call(request);
            } catch (error) {
              if (error instanceof EngineTransportError)
                this.connectionFailed(guarded);
              throw error;
            }
          },
        };
        this.conn = guarded;
        this.hasInspectionTool = tools.some(
          (t) => t.name === 'inspect-provenance',
        );
        this.hasImpactTool = tools.some(
          (t) => t.name === 'find-affected-outputs',
        );
        this.targetError = null;
        this.draw();
        this.reloadAfterReconnect();
        return guarded;
      } catch (error) {
        if (conn && conn !== this.conn) await conn.close().catch(() => {});
        if (!this.closed && generation === this.generation) {
          this.targetError =
            'Can’t reach Vault Engine. Check the Engine URL and token in settings, then try again.';
          this.draw();
        }
        throw error;
      } finally {
        if (generation === this.generation) this.connecting = null;
      }
    })();
    return this.connecting;
  }
  /** After a lost or replaced connection cleared the note: show the note it showed (pinned or not),
   *  else the active note when unpinned. Not while an inspection is already on its way, which set
   *  `shownPath` before connecting. */
  private reloadAfterReconnect(): void {
    if (this.closed || this.target || this.shownPath !== null) return;
    const path = this.reloadPath ?? (this.pinned ? null : this.plugin.activeNotePath?.() ?? null);
    this.reloadPath = null;
    if (path) void this.inspectPath(path, 'output');
  }
  /** Forget the note the panel shows, so the next connection shows it again. */
  private forgetNote(): void {
    this.reloadPath = this.shownPath ?? this.reloadPath;
    this.shownPath = null;
    this.editorPath = null;
    this.back = null;
  }
  /** The Curator client the wiki card and the wiki lookup share, while a Curator is configured. */
  private curatorClient(): ReturnType<typeof makeWikiRebuildClient> | null {
    const { curatorUrl, curatorToken } = this.plugin.settings;
    if (!curatorUrl?.trim() || !curatorToken?.trim()) return null;
    this.wikiLookupClient ??= makeWikiRebuildClient({ endpoint: curatorUrl, token: curatorToken });
    return this.wikiLookupClient;
  }
  private connectionFailed(conn: EngineConnection): void {
    // A late failure from a replaced session must not invalidate its successor.
    if (this.closed || this.conn !== conn) return;
    this.generation++;
    void this.refreshClient?.close();
    this.refreshClient = null;
    this.refreshApi = null;
    this.refreshPanel = null;
    this.selection++;
    this.conn = null;
    this.connecting = null;
    this.target = null;
    this.hasInspectionTool = false;
    this.hasImpactTool = false;
    this.targetError =
      'Lost the connection to Vault Engine. Try again.';
    this.forgetNote();
    this.closeModal();
    // Unmount the inspector to release retained text and pending read state.
    this.draw();
    void conn.close().catch(() => {});
  }
  async inspectPath(
    path: string | null,
    mode: ProvenanceMode = 'output',
  ): Promise<void> {
    const selection = ++this.selection,
      generation = this.generation;
    if (mode === 'source-impact') this.focusImpact += 1;
    this.shownPath = path;
    // The commands inspect the editor's note, so it is accounted for.
    if (path === (this.plugin.activeNotePath?.() ?? null)) this.editorPath = path;
    this.back = null;
    this.highlightInputIds = undefined;
    this.expectedNamespace = undefined;
    this.refreshPanel = null;
    this.preferredOutputId = undefined;
    this.target = null;
    this.targetError = path ? null : 'Open a Markdown note to see its wiki.';
    this.draw();
    if (!path) return;
    try {
      const conn = await this.ensureConnection();
      if (
        this.closed ||
        selection !== this.selection ||
        generation !== this.generation
      )
        return;
      const result = await makeClient(conn.call).getNode({
        file_path: path,
        include_embeds: false,
      });
      if (
        this.closed ||
        selection !== this.selection ||
        generation !== this.generation
      )
        return;
      if (!result.ok || !result.data.id)
        throw Error('This note could not be resolved in Engine.');
      this.target = {
        nodeId: result.data.id,
        title: result.data.title ?? null,
        path: result.data.file_path ?? null,
      };
    } catch (error) {
      if (
        this.closed ||
        selection !== this.selection ||
        generation !== this.generation
      )
        return;
      this.targetError =
        error instanceof Error ? error.message : 'Cannot inspect this note';
      // Not shown, so focusing the note again, or reconnecting, tries again.
      this.reloadPath = path;
      this.shownPath = null;
      this.editorPath = null;
    }
    this.draw();
  }
  connectionSettingsChanged(): void {
    this.generation++;
    this.selection++;
    this.target = null;
    this.targetError = null;
    this.hasInspectionTool = false;
    this.hasImpactTool = false;
    void this.refreshClient?.close();
    this.refreshClient = null;
    this.refreshApi = null;
    this.refreshPanel = null;
    // The rebuild client holds the old endpoint and token, so it must not outlive them.
    void this.wikiRebuildClient?.close();
    this.wikiRebuildClient = null;
    this.wikiRebuildPanel = null;
    this.wikiRebuildClientPanel = null;
    void this.dossierClient?.close();
    this.dossierClient = null;
    this.dossierPanel = null;
    this.dossierClientPanel = null;
    void this.wikiLookupClient?.close();
    this.wikiLookupClient = null;
    this.forgetNote();
    this.closeModal();
    const old = this.conn;
    this.conn = null;
    this.connecting = null;
    this.draw();
    void (async () => {
      await old?.close().catch(() => {});
      if (!this.closed) await this.ensureConnection().catch(() => {});
    })();
  }
  private draw(): void {
    if (!this.root || this.closed) return;
    const conn = this.conn;
    const generation = this.generation;
    const selection = this.selection;
    if (!conn) {
      this.closeModal();
      this.root.render(
        createElement(
          'section',
          { className: 'vp-inspector', 'aria-label': 'Wiki panel' },
          createElement(
            'div',
            { className: 'vp-empty' },
            createElement('h3', null, this.targetError ? 'Can’t reach Vault Engine' : 'Connecting to Vault Engine…'),
            this.targetError
              ? createElement('p', { role: 'alert' }, this.targetError)
              : createElement('p', { role: 'status' }, 'The wiki panel reads build records from Vault Engine.'),
            createElement(
              'div',
              { className: 'vp-actions' },
              createElement(
                'button',
                { onClick: () => void this.ensureConnection().catch(() => {}) },
                'Try again',
              ),
            ),
          ),
        ),
      );
      return;
    }
    const onOpenNode = async (
      id: string,
      isCurrent: () => boolean = () => true,
    ) => {
      if (this.closed || this.conn !== conn)
        throw Error('Inspection connection changed');
      this.navigating++;
      try {
        await openExistingNode(
          this.plugin.app,
          makeClient(conn.call),
          id,
          () =>
            !this.closed &&
            this.conn === conn &&
            this.generation === generation &&
            this.selection === selection &&
            isCurrent(),
        );
        // The panel stays on its note; the next note the user opens is followed as usual.
        this.editorPath = this.plugin.activeNotePath?.() ?? this.editorPath;
      } finally {
        this.navigating--;
      }
    };
    // One rebuild dialog at a time: opening one replaces the other.
    const onRefreshHome = (outputId: string, namespace: string) => {
      this.returnFocus = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.wikiRebuildPanel = null;
      this.dossierPanel = null;
      this.refreshPanel = { outputId, namespace };
      this.draw();
    };
    const onRebuildWiki = (project: string) => {
      this.returnFocus = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.refreshPanel = null;
      this.dossierPanel = null;
      this.wikiRebuildPanel = { project };
      this.draw();
    };
    const onBuildDossier = (subject: { nodeId: string; title: string }) => {
      this.returnFocus = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
      this.refreshPanel = null;
      this.wikiRebuildPanel = null;
      // One resolver per dialog: the build's check runs again only when it changes.
      this.dossierPanel = { ...subject, note: async () => ({ id: subject.nodeId, title: subject.title }) };
      this.draw();
    };
    // The wiki a note belongs to is found through Curator by its root note's title, the same curator-status
    // call an AI caller makes, whether or not the page has build records (a topic wiki's pages keep none,
    // and a project wiki's home has none until its first build). The root id must match its registration.
    const curator = this.curatorClient();
    const findWiki: ProvenanceInspectorProps['findWiki'] = async root => {
      if (this.closed || this.generation !== generation || !curator) return null;
      const status = await curator.api.status(root.title);
      return (status.kind === 'topic' || status.kind === 'project') && status.root_node_id === root.nodeId
        ? { name: status.project, kind: status.kind } : null;
    };
    const create = this.plugin.wikiCreation(this.target?.path ?? null);
    const content = createElement(ProvenanceInspector, {
      key: this.inspectorEpoch,
      target: this.target,
      targetError: this.targetError,
      connectionKey: this.generation,
      hasInspectionTool: this.hasInspectionTool,
      hasImpactTool: this.hasImpactTool,
      focusImpact: this.focusImpact,
      onReviewBuild: (candidate, namespace) => this.reviewBuild(candidate, namespace),
      backTo: this.back ? (this.back.target.title ?? this.back.target.path ?? 'the note') : null,
      onBack: () => this.goBack(),
      pinned: this.pinned,
      onTogglePin: () => this.togglePin(),
      onOpenNode,
      onRefreshHome,
      onRebuildWiki,
      findWiki,
      wikiApi: curator?.control,
      statusKey: this.statusKey,
      onCreateProjectWiki: create.project,
      onCreateTopicWiki: create.topic,
      dossierKind: types => this.plugin.dossierKind?.(types) ?? null,
      ...(curator ? { dossierApi: curator.dossier, onBuildDossier } : {}),
      preferredOutputId: this.preferredOutputId,
      highlightInputIds: this.highlightInputIds,
      expectedNamespace: this.expectedNamespace,
    });
    const panel = this.refreshPanel;
    if (panel !== this.refreshApiPanel) {
      void this.refreshClient?.close();
      this.refreshClient = null;
      this.refreshApi = null;
      this.refreshApiPanel = panel;
    }
    let refresh = null;
    if (panel) {
      const endpoint = !panel.outputId && this.refreshResume ? this.refreshResume.curator_endpoint : this.plugin.settings.curatorUrl;
      if (!this.refreshApi) {
        this.refreshClient = makeHomeRefreshClient({ endpoint, token: this.plugin.settings.curatorToken });
        const raw = this.refreshClient.api;
        const check = async () => {
          if (this.closed || this.generation !== generation || this.conn !== conn || this.refreshPanel !== panel
            || normalizedCuratorEndpoint(this.plugin.settings.curatorUrl) !== normalizedCuratorEndpoint(endpoint))
            throw Error('Restore the original refresh connection.');
          const status = await makeClient(conn.call).inspectProvenance({ select: 'status' });
          if (this.refreshPanel !== panel) throw Error('Refresh panel changed.');
          if (!status.ok || status.data.select !== 'status' || status.data.vault_namespace !== panel.namespace)
            throw Error('Refresh vault identity changed.');
        };
        this.refreshApi = {
          preview: async id => { await check(); return raw.preview(id); },
          execute: async request => {
            try { await check(); } catch { throw new HomeRefreshNotSentError(); }
            return raw.execute(request);
          },
          status: async id => { await check(); return raw.status(id); },
        };
      }
      refresh = createElement(HomeRefresh, { key: `${generation}:${selection}:${panel.outputId ?? 'resume'}`,
        api: this.refreshApi, outputRevisionId: panel.outputId, expectedNamespace: panel.namespace,
        resume: panel.outputId ? undefined : this.refreshResume ?? undefined,
        onPersist: (resume, expectedRequestId) => {
          const saving = this.refreshPersistence.then(async () => {
            if (!resume) {
              // Old panels may finish saving after closure/replacement. Clear only
              // their own unsent/rejected identity, never a newer panel's request.
              if (!expectedRequestId || this.refreshResume?.request_id !== expectedRequestId) return;
              this.refreshResume = null;
            } else {
              if (this.closed || this.generation !== generation || this.refreshPanel !== panel)
                throw Error('Refresh view changed.');
              this.refreshResume = { ...resume, curator_endpoint: normalizedCuratorEndpoint(endpoint) };
            }
            // Do not restore a leaf that has already been closed/replaced.
            if (!this.closed && this.generation === generation)
              await this.leaf.setViewState({ type: VIEW_TYPE_PROVENANCE, state: this.getState() });
            await this.app.workspace.requestSaveLayout().run();
          });
          this.refreshPersistence = saving.catch(() => {});
          return saving;
        },
        onClose: () => { this.refreshPanel = null; this.statusKey += 1; this.draw(); this.returnFocus?.focus(); },
        onInspect: (outputId, nodeId) => {
          this.refreshPanel = null; this.back = null; this.preferredOutputId = outputId;
          this.highlightInputIds = undefined; this.expectedNamespace = undefined;
          this.target = { nodeId, title: null, path: null }; this.statusKey += 1; this.draw();
        },
      });
    }
    const wikiPanel = this.wikiRebuildPanel;
    if (wikiPanel !== this.wikiRebuildClientPanel) {
      void this.wikiRebuildClient?.close();
      this.wikiRebuildClient = null;
      this.wikiRebuildClientPanel = wikiPanel;
    }
    let wikiRebuild = null;
    if (wikiPanel) {
      this.wikiRebuildClient ??= makeWikiRebuildClient({ endpoint: this.plugin.settings.curatorUrl, token: this.plugin.settings.curatorToken });
      wikiRebuild = createElement(WikiRebuild, { key: `${generation}:${wikiPanel.project}`, api: this.wikiRebuildClient.api, project: wikiPanel.project,
        onClose: () => { this.wikiRebuildPanel = null; this.statusKey += 1; this.draw(); this.returnFocus?.focus(); },
        onShowLatest: () => {
          this.wikiRebuildPanel = null; this.preferredOutputId = undefined; this.inspectorEpoch += 1;
          this.draw();
        },
      });
    }
    const dossierPanel = this.dossierPanel;
    if (dossierPanel !== this.dossierClientPanel) {
      void this.dossierClient?.close();
      this.dossierClient = null;
      this.dossierClientPanel = dossierPanel;
    }
    let dossierBuild = null;
    if (dossierPanel) {
      this.dossierClient ??= makeWikiRebuildClient({ endpoint: this.plugin.settings.curatorUrl, token: this.plugin.settings.curatorToken });
      const closeDossier = () => { this.dossierPanel = null; this.statusKey += 1; this.draw(); };
      dossierBuild = createElement(DossierBuild, { key: `${generation}:dossier:${dossierPanel.nodeId}`, api: this.dossierClient.dossier,
        note: dossierPanel.note, noteTitle: dossierPanel.title, noteRef: dossierPanel.nodeId,
        onClose: () => { closeDossier(); this.returnFocus?.focus(); },
        onOpenPage: title => { closeDossier(); this.plugin.openNoteTitled?.(title, this.shownPath ?? ''); },
      });
    }
    // A page rebuild saved in the view's state, from before a reload or a closed dialog: offer its status.
    const resume = !panel && this.refreshResume
      ? createElement('div', { className: 'vp-banner', role: 'status' },
        createElement('span', null, 'A page rebuild was started from this panel. It runs in Curator.'),
        createElement('button', { onClick: () => {
          this.returnFocus = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
          this.wikiRebuildPanel = null;
          this.dossierPanel = null;
          this.refreshPanel = { namespace: this.refreshResume!.vault_namespace }; this.draw();
        } }, 'Show status'))
      : null;
    this.root.render(
      createElement(VizClientProvider, { call: conn.call, children: createElement('div', null, resume, content) }),
    );
    this.syncModal(refresh ?? wikiRebuild ?? dossierBuild);
  }
  /** Show the rebuild flow in its dialog, or close the dialog when there is none. */
  private syncModal(flow: ReturnType<typeof createElement> | null): void {
    if (!flow || this.closed) { this.closeModal(); return; }
    if (!this.modal) {
      const modal = new RebuildModal(this.app, closed => this.modalDismissed(closed));
      this.modal = modal;
      modal.render(flow);
      modal.open();
      return;
    }
    this.modal.render(flow);
  }
  private closeModal(): void {
    const modal = this.modal;
    if (!modal) return;
    // Cleared first, so its own onClose isn't taken for the user dismissing it.
    this.modal = null;
    modal.close();
  }
  /** A build may have started outside the panel (the Build dossier command): read its status again. */
  readStatusAgain(): void {
    if (this.closed) return;
    this.statusKey += 1;
    this.draw();
  }
  /** The user closed the dialog (Esc, × or outside it): the same as its Close button. */
  private modalDismissed(modal: RebuildModal): void {
    if (this.modal !== modal) return;
    this.modal = null;
    this.refreshPanel = null;
    this.wikiRebuildPanel = null;
    this.dossierPanel = null;
    // A build may be running now: read the wiki's status again.
    this.statusKey += 1;
    this.draw();
    this.returnFocus?.focus();
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.closeModal();
    this.generation++;
    this.selection++;
    this.target = null;
    this.targetError = null;
    this.hasInspectionTool = false;
    this.hasImpactTool = false;
    this.root?.unmount();
    this.root = null;
    this.refreshPanel = null;
    await this.refreshClient?.close();
    this.refreshClient = null;
    this.wikiRebuildPanel = null;
    await this.wikiRebuildClient?.close();
    this.wikiRebuildClient = null;
    await this.dossierClient?.close();
    this.dossierClient = null;
    await this.wikiLookupClient?.close();
    this.wikiLookupClient = null;
    this.refreshApi = null;
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    await conn?.close().catch(() => {});
  }
}
