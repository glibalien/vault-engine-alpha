import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UIMessage } from 'ai';
import { SYSTEM_PROMPT, TIERING_SYSTEM_NOTE, createToolTiering, CORE_TOOL_NAMES, usageEventArgs, runTitleFlow, providerAvailability } from '@vault/chat-core';
import { makeClient } from '@vault/query-core';
import type { PreviewRef } from '@vault/viz-ui';
import { VaultVizProvider } from '../view/vault-viz-provider.js';
import { connectEngine, type EngineConnection } from '../engine/transport.js';
import { buildToolSet, engineCallFor } from './tools.js';
import { makeRelayModel } from '../llm/relay-model.js';
import { PluginSettingsClient } from '../engine/settings-client.js';
import { connectionVaultMap } from '../engine/vault-map.js';
import { InProcessChatTransport } from './in-process-transport.js';
import { makeTurnResolver } from './turn-resolution.js';
import { ChatPane } from './ChatPane.js';
import { makeConversationClient } from './conversation-client.js';
import { makeDocScope } from '../engine/doc-scope.js';
import { makeBoardClient } from '@vault/board-core';
import { makeBuildContext } from './build-context.js';
import type { ChatContextHolder } from './context-state.js';
import { hasProviderKey, providerKeys } from '../settings.js';
import type VaultEnginePlugin from '../main.js';

export const VIEW_TYPE_CHAT = 'vault-chat-view';

export class ChatView extends ItemView {
  private root: Root | null = null;
  private conn: EngineConnection | null = null;
  private curatorConn: EngineConnection | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: VaultEnginePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText(): string {
    return 'Vault Chat';
  }
  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    if (!hasProviderKey(this.plugin.settings)) {
      this.root.render(
        createElement('div', { className: 'vc-error', role: 'alert' }, 'Set a model provider API key (Fireworks, Anthropic, OpenRouter or OpenAI) in Vault Engine settings to use chat.'),
      );
      return;
    }
    try {
      const conn = await connectEngine(this.plugin.settings.engineUrl, this.plugin.settings.token);
      if (this.root === null) {
        await conn.close().catch(() => {});
        return;
      }
      this.conn = conn;
      let curatorConn: EngineConnection | null = null;
      if (this.plugin.settings.curatorToken) {
        try {
          const c = await connectEngine(this.plugin.settings.curatorUrl, this.plugin.settings.curatorToken);
          await c.listTools(); // validate reachability + scope now, inside the guard
          if (this.root === null) {
            await c.close().catch(() => {});
            return;
          }
          curatorConn = c;
          this.curatorConn = c;
        } catch (e) {
          new Notice(`Curator unreachable; continuing without curator tools: ${e instanceof Error ? e.message : String(e)}`);
          curatorConn = null;
        }
      }
      // present-viz's examples and default grouping field come from the vault map.
      // Names from this view's own Engine, which it keeps until it is reopened.
      const vaultMap = connectionVaultMap(conn.call, this.plugin.vaultMap.current());
      const { vault } = await vaultMap.load();
      const tools = await buildToolSet(conn, curatorConn ?? undefined, vault);
      const tiering = createToolTiering(tools, { core: CORE_TOOL_NAMES });
      const queryClient = makeClient(conn.call);
      // '@' menu + add-picker source (empty query → recent notes, like the web's searchNotes).
      const searchNodes = async (q: string): Promise<Array<{ id: string; title: string; type?: string }>> => {
        const env = await queryClient.queryNodes(q.trim()
          ? { title_contains: q, select: ['id', 'title', 'types'], limit: 8 }
          : { select: ['id', 'title', 'types'], limit: 8, sort_by: 'file_mtime', sort_order: 'desc' });
        if (!env.ok) return [];
        return (env.data?.nodes ?? []).map((n) => ({ id: n.id, title: n.title ?? n.id, type: n.types?.[0] }));
      };
      // Chip-title resolution for hydrated ContextState.nodes ids (id-labeled fallback on failure).
      const resolveNodes = async (ids: string[]): Promise<Array<{ id: string; title: string; type: string }>> => {
        if (!ids.length) return []; // guard: query-nodes' limit param requires >= 1
        try {
          const env = await queryClient.queryNodes({ node_ids: ids, select: ['id', 'title', 'types'], limit: ids.length });
          const byId = new Map((((env.ok ? env.data?.nodes : []) ?? []) as Array<{ id: string; title?: string; types?: string[] }>).map((n) => [n.id, n]));
          return ids.map((id) => { const n = byId.get(id); return { id, title: n?.title ?? id, type: n?.types?.[0] ?? '' }; });
        } catch {
          return ids.map((id) => ({ id, title: id, type: '' }));
        }
      };
      const settingsClient = new PluginSettingsClient(conn.call);
      await settingsClient.registerPromptDefaults();
      const keys = providerKeys(this.plugin.settings);
      const relayOpts = { engineUrl: this.plugin.settings.engineUrl, token: this.plugin.settings.token };
      // Task 8 (extracted to turn-resolution.ts, Obsidian-free): per-conversation picker
      // selection + strict-resolve-with-default-degrade + warn-once dedup. ChatPane keeps
      // the selection in lockstep via onModelRefChange — same cross-boundary discipline as
      // ChatContextHolder (buildContext). The Obsidian-coupled relay stays here as a factory.
      const resolver = makeTurnResolver({
        settingsClient, keys,
        makeModel: (entry) => makeRelayModel(entry, keys, relayOpts),
      });
      const turn = resolver.turn;
      const onModelRefChange = resolver.onModelRefChange;
      // LLM conversation titles (spec 2026-07-20): the pane calls this after the first
      // exchange; chat-core's runTitleFlow resolves Settings/Chat.md's titleModel strictly,
      // generates via the engine LLM relay, saves title-only, records spend. Returns
      // whether a title landed so the pane can reset its `titled` guard on total failure.
      const availability = providerAvailability(keys);
      const generateTitle = async (opts: { conversationId: string; messages: UIMessage[]; fallbackTitle: string | null; saveTitle: (title: string) => Promise<void> }): Promise<boolean> => {
        const { settings, catalog } = await settingsClient.effective();
        return runTitleFlow({
          ...opts,
          titleModelRef: settings.titleModel,
          catalog,
          availability,
          makeModel: (entry) => makeRelayModel(entry, keys, relayOpts),
          service: 'chat-plugin',
          recordUsage: (args) => {
            void conn.call({ name: 'record-usage', arguments: args }).catch((err: unknown) => {
              console.warn(`[vault-obsidian] title usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
            });
          },
          log: (msg) => console.warn(`[vault-obsidian] ${msg}`),
        });
      };
      const boardClient = makeBoardClient(conn.call);
      const contextHolder: ChatContextHolder = { activeBoardId: undefined, docEnabled: true };
      const buildContext = makeBuildContext(contextHolder, engineCallFor(conn));
      const promptOrDefault = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim() !== '' ? value : fallback;
      const transport = new InProcessChatTransport({
        system: SYSTEM_PROMPT, tiering, turn, buildContext,
        prompts: async () => {
          const { settings } = await settingsClient.effective();
          return {
            system: promptOrDefault(settings.chatSystemPrompt, SYSTEM_PROMPT),
            tieringNote: promptOrDefault(settings.chatTieringNote, TIERING_SYSTEM_NOTE),
          };
        },
        onUsage: (info) => {
          const usageArgs = usageEventArgs({
            model: info.entry.model,
            provider: info.entry.provider,
            service: 'chat-plugin',
            totalUsage: info.totalUsage,
            conversationId: info.conversationId,
            latencyMs: info.latencyMs,
            billing: info.billing,
          });
          if (usageArgs) {
            void conn.call({ name: 'record-usage', arguments: usageArgs }).catch((err: unknown) => {
              console.warn(`[vault-obsidian] usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        },
      });

      const newBoardName = (): string => this.plugin.app.workspace.getActiveFile()?.basename ?? 'Chat board';

      const onOpenPreview = async (ref: PreviewRef): Promise<void> => {
        if ('title' in ref) {
          void this.plugin.app.workspace.openLinkText(ref.title, '', false);
          return;
        }
        // nodeId → resolve file_path via get-node, then open it.
        // Wrapped in try/catch so a transport error (engine unreachable, token
        // expired, etc.) never becomes an unhandled rejection that crashes the leaf.
        try {
          const client = makeClient(conn.call);
          const env = await client.getNode({ node_id: ref.nodeId });
          const path = env.ok ? env.data?.file_path : undefined;
          if (path) void this.plugin.app.workspace.openLinkText(path, '', false);
        } catch {
          // a node-preview click must never crash the leaf
        }
      };

      const conversationClient = makeConversationClient(conn.call);
      const docScope = makeDocScope(this.plugin.app, conn.call);
      this.root.render(
        createElement(VaultVizProvider, { call: conn.call, vaultMap,
          children: createElement(ChatPane, { client: conversationClient, transport, docScope, boardClient, boardSync: this.plugin.boardSync, contextHolder, newBoardName, onOpenPreview, searchNodes, resolveNodes, settingsClient, keys, onModelRefChange, generateTitle }) }),
      );
    } catch (e) {
      this.root?.render(
        createElement('div', { className: 'vc-error', role: 'alert' }, `⚠ ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    await this.conn?.close().catch(() => {});
    this.conn = null;
    await this.curatorConn?.close().catch(() => {});
    this.curatorConn = null;
  }
}
