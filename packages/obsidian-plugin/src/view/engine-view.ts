import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { connectEngine, type EngineConnection } from '../engine/transport.js';
import { connectionVaultMap } from '../engine/vault-map.js';
import { makeClient } from '@vault/query-core';
import { App } from './App.js';
import type { PreviewRef } from '@vault/viz-ui';
import type VaultEnginePlugin from '../main.js';

export const VIEW_TYPE_ENGINE = 'vault-engine-view';

export class EngineView extends ItemView {
  private root: Root | null = null;
  private conn: EngineConnection | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: VaultEnginePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ENGINE;
  }

  getDisplayText(): string {
    return 'Vault Engine';
  }

  getIcon(): string {
    return 'database';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    try {
      const conn = await connectEngine(this.plugin.settings.engineUrl, this.plugin.settings.token);
      // The leaf may have been closed while connecting (onClose nulls this.root):
      // discard the orphaned transport instead of leaking it.
      if (this.root === null) {
        await conn.close().catch(() => {});
        return;
      }
      this.conn = conn;

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

      // Names from this view's own Engine, which it keeps until it is reopened.
      const vaultMap = connectionVaultMap(conn.call, this.plugin.vaultMap.current());
      this.root.render(createElement(App, { call: conn.call, onOpenPreview, vaultMap }));
    } catch (e) {
      this.root?.render(
        createElement('div', { className: 've-error', role: 'alert' }, `⚠ ${e instanceof Error ? e.message : String(e)}`),
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
