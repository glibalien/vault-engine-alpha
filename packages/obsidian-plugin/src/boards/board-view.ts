import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { makeClient } from '@vault/query-core';
import type { PreviewRef } from '@vault/viz-ui';
import { VaultVizProvider } from '../view/vault-viz-provider.js';
import { connectEngine, type EngineConnection } from '../engine/transport.js';
import { makeBoardClient } from '@vault/board-core';
import { makeDocScope } from '../engine/doc-scope.js';
import { Boards } from './Boards.js';
import { makeChooseBoard } from './board-picker-modal.js';
import { makeBoardPipelines } from './pipelines.js';
import { PluginSettingsClient } from '../engine/settings-client.js';
import { connectionVaultMap } from '../engine/vault-map.js';
import { engineCallFor } from '../chat/tools.js';
import { makeRelayModel } from '../llm/relay-model.js';
import { providerKeys } from '../settings.js';
import type VaultEnginePlugin from '../main.js';

export const VIEW_TYPE_BOARD = 'vault-board-view';

export class BoardView extends ItemView {
  private root: Root | null = null;
  private conn: EngineConnection | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: VaultEnginePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BOARD;
  }

  getDisplayText(): string {
    return 'Vault Boards';
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    try {
      const conn = await connectEngine(this.plugin.settings.engineUrl, this.plugin.settings.token);
      // Guard: if leaf was closed while connecting, discard the transport.
      if (this.root === null) {
        await conn.close().catch(() => {});
        return;
      }
      this.conn = conn;
      // Names from this view's own Engine, which it keeps until it is reopened.
      const vaultMap = connectionVaultMap(conn.call, this.plugin.vaultMap.current());

      const onOpenPreview = async (ref: PreviewRef): Promise<void> => {
        if ('title' in ref) {
          void this.plugin.app.workspace.openLinkText(ref.title, '', false);
          return;
        }
        // nodeId → resolve file_path via get-node, then open it.
        try {
          const client = makeClient(conn.call);
          const env = await client.getNode({ node_id: ref.nodeId });
          const path = env.ok ? env.data?.file_path : undefined;
          if (path) void this.plugin.app.workspace.openLinkText(path, '', false);
        } catch {
          // a node-preview click must never crash the leaf
        }
      };

      const boardClient = makeBoardClient(conn.call);
      const docScope = makeDocScope(this.plugin.app, conn.call);

      const settingsClient = new PluginSettingsClient(conn.call);
      const keys = providerKeys(this.plugin.settings);
      const relayOpts = { engineUrl: this.plugin.settings.engineUrl, token: this.plugin.settings.token };
      const interpret = makeBoardPipelines({
        engineCall: engineCallFor(conn),
        effective: () => settingsClient.effective(),
        keys,
        makeModel: (entry) => makeRelayModel(entry, keys, relayOpts),
        recordUsage: (args) => {
          void conn.call({ name: 'record-usage', arguments: args }).catch((err: unknown) => {
            console.warn(`[vault-obsidian] viz-interpret usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        log: (msg) => console.warn(`[vault-obsidian] ${msg}`),
        vault: () => vaultMap.current().vault,
      });

      this.root.render(
        createElement(VaultVizProvider, {
          call: conn.call,
          vaultMap,
          children: createElement(Boards, {
            client: boardClient,
            onOpenPreview,
            docScope,
            chooseBoard: makeChooseBoard(this.plugin.app),
            interpret,
            boardSync: this.plugin.boardSync,
          }),
        }),
      );
    } catch (e) {
      this.root?.render(
        createElement('div', { className: 'vb-error', role: 'alert' }, `⚠ ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    await this.conn?.close().catch(() => {});
    this.conn = null;
  }
}
